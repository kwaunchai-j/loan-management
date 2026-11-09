import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "./audit.js";

/**
 * The notice a borrower must acknowledge when the lender adjusts the interest rate or the late-fee rate (CR-9).
 *
 * Every adjustment is a `RateChange` row (written with the Setting update). A borrower owes an acknowledgement for the
 * changes after `Borrower.rateNoticeAckSeq` that were made while they already existed — a borrower who joined after a change
 * agreed to the rates in force when they joined. Until they acknowledge, they can read everything but cannot file a new
 * loan request (`assertRateNoticeAcknowledged`).
 *
 * Several adjustments in a row are shown as one: from the rate the borrower last knew to the rate now. If they cancel each
 * other out (3 % → 4 % → 3 %), or the rate was only set for the very first time, there is nothing to acknowledge.
 */

export interface RateMove {
  /** The rate before the adjustment(s), as an exact decimal string. */
  from: string;
  /** The rate now. */
  to: string;
}

export interface RateNotice {
  /** true: the borrower must acknowledge before filing a new request. */
  required: boolean;
  /** The newest adjustment this notice covers; the borrower sends it back to acknowledge exactly what they saw. */
  seq: number | null;
  /** null: that rate was not adjusted. */
  interestRatePctPerMonth: RateMove | null;
  lateFeeRatePctPerDay: RateMove | null;
  /** When the newest adjustment was made. */
  changedAt: Date | null;
}

type RateNoticeDb = Pick<Prisma.TransactionClient, "borrower" | "rateChange">;

const NO_NOTICE: RateNotice = { required: false, seq: null, interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, changedAt: null };

type Rates = { interestRatePctPerMonth: Prisma.Decimal | null; lateFeeRatePctPerDay: Prisma.Decimal | null };

const same = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) => (a === null || b === null ? a === b : a.equals(b));

/** Writes a RateChange when `before` and `after` differ. Call it inside the transaction that saved the rates. */
export async function recordRateChange(tx: Prisma.TransactionClient, before: Rates, after: Rates, changedById: string) {
  if (same(before.interestRatePctPerMonth, after.interestRatePctPerMonth) && same(before.lateFeeRatePctPerDay, after.lateFeeRatePctPerDay)) {
    return null;
  }
  return tx.rateChange.create({
    data: {
      prevInterestRatePctPerMonth: before.interestRatePctPerMonth,
      prevLateFeeRatePctPerDay: before.lateFeeRatePctPerDay,
      interestRatePctPerMonth: after.interestRatePctPerMonth,
      lateFeeRatePctPerDay: after.lateFeeRatePctPerDay,
      changedById,
    },
  });
}

/** What a borrower has yet to acknowledge (`upToSeq`: only the adjustments up to that one). */
export async function getRateNotice(db: RateNoticeDb, borrowerId: string, upToSeq?: number): Promise<RateNotice> {
  const borrower = await db.borrower.findUnique({ where: { id: borrowerId }, select: { createdAt: true, rateNoticeAckSeq: true } });
  if (!borrower) return NO_NOTICE;
  const changes = await db.rateChange.findMany({
    where: { seq: { gt: borrower.rateNoticeAckSeq, ...(upToSeq === undefined ? {} : { lte: upToSeq }) }, createdAt: { gt: borrower.createdAt } },
    orderBy: { seq: "asc" },
  });
  const last = changes.at(-1);
  if (!last) return NO_NOTICE;

  // the rate the borrower last knew: the "before" of the first adjustment that had a rate before it
  const move = (prev: (c: (typeof changes)[number]) => Prisma.Decimal | null, now: Prisma.Decimal | null): RateMove | null => {
    const from = changes.map(prev).find((v) => v !== null) ?? null;
    return from === null || now === null || from.equals(now) ? null : { from: from.toString(), to: now.toString() };
  };
  const interest = move((c) => c.prevInterestRatePctPerMonth, last.interestRatePctPerMonth);
  const lateFee = move((c) => c.prevLateFeeRatePctPerDay, last.lateFeeRatePctPerDay);
  if (!interest && !lateFee) return NO_NOTICE;
  return { required: true, seq: last.seq, interestRatePctPerMonth: interest, lateFeeRatePctPerDay: lateFee, changedAt: last.createdAt };
}

/**
 * The borrower acknowledges everything up to `seq` (what they were shown). A `seq` the system never issued is refused.
 * If the lender adjusted the rates again meanwhile, the answer is the new notice and `required` stays true.
 */
export async function acknowledgeRateNotice(prisma: Db, input: { borrowerId: string; actorId: string; seq: number }, now: Date = new Date()) {
  await prisma.$transaction(async (tx) => {
    const latest = await tx.rateChange.aggregate({ _max: { seq: true } });
    if (input.seq < 1 || input.seq > (latest._max.seq ?? 0)) {
      throw new DomainError(400, "VALIDATION_ERROR", "ไม่พบประกาศอัตราที่ต้องรับทราบ กรุณาโหลดหน้าใหม่");
    }
    const before = await tx.borrower.findUniqueOrThrow({ where: { id: input.borrowerId }, select: { rateNoticeAckSeq: true } });
    if (input.seq <= before.rateNoticeAckSeq) return; // already acknowledged: nothing to write, the time of the first stays
    const notice = await getRateNotice(tx, input.borrowerId, input.seq); // exactly what is being acknowledged
    await tx.borrower.update({ where: { id: input.borrowerId }, data: { rateNoticeAckSeq: input.seq, rateNoticeAckAt: now } });
    await writeAuditLog(tx, {
      actorId: input.actorId,
      action: "borrower.rateNoticeAck",
      entityType: "Borrower",
      entityId: input.borrowerId,
      before: { rateNoticeAckSeq: before.rateNoticeAckSeq },
      after: { rateNoticeAckSeq: input.seq },
      // what the borrower was shown, kept as evidence of what they agreed to
      extra: { interestRatePctPerMonth: notice.interestRatePctPerMonth, lateFeeRatePctPerDay: notice.lateFeeRatePctPerDay },
    });
  });
  return getRateNotice(prisma, input.borrowerId);
}

/** Throws 409 RATE_NOTICE_REQUIRED while the borrower has an adjustment they have not acknowledged. */
export async function assertRateNoticeAcknowledged(db: RateNoticeDb, borrowerId: string) {
  if ((await getRateNotice(db, borrowerId)).required) {
    throw new DomainError(409, "RATE_NOTICE_REQUIRED", "ผู้ให้กู้ปรับอัตราดอกเบี้ยหรือค่าปรับ กรุณากดรับทราบอัตราใหม่ก่อนส่งคำขอยืมเงิน");
  }
}
