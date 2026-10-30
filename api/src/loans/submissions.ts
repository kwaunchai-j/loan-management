import type { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { detectSlipType, newSlipKey, type SlipStorage } from "../lib/slip-storage.js";
import { lockContract, withLedgerErrors } from "./ledger.js";
import { recordPaymentInTx } from "./payments.js";

/**
 * Borrower-submitted payment slips (change request CR-1).
 *
 * A borrower can tell the lender "I paid X on day D" and attach the transfer slip. That is only a
 * CLAIM: it changes no balance. An ADMIN looks at the slip and either confirms it — which records a
 * real payment through the ordinary ledger code (same rules: never above what is owed, never before
 * the payout, never in the future, late fee → interest → principal) in the SAME transaction as the
 * confirmation — or rejects it with a reason the borrower can read. Nothing the borrower sends can
 * reach the ledger without an admin's decision.
 */
export const MAX_PENDING_PER_BORROWER = 5;

export const submissionSelect = {
  id: true,
  contractId: true,
  amount: true,
  paidOn: true,
  slipFileKey: true,
  note: true,
  status: true,
  rejectReason: true,
  decidedAt: true,
  paymentId: true,
  createdAt: true,
  contract: { select: { contractNo: true } },
  borrower: { select: { id: true, fullName: true } },
} satisfies Prisma.PaymentSubmissionSelect;

type Row = Prisma.PaymentSubmissionGetPayload<{ select: typeof submissionSelect }>;

/** What the admin sees: everything, including the slip key (the slip itself is ADMIN-only). */
export function adminSubmissionView(r: Row) {
  return {
    id: r.id,
    contract: { id: r.contractId, contractNo: r.contract.contractNo },
    borrower: r.borrower,
    amount: r.amount.toString(),
    paidOn: formatDateOnly(r.paidOn),
    note: r.note,
    status: r.status,
    rejectReason: r.rejectReason,
    slipFileKey: r.slipFileKey,
    decidedAt: r.decidedAt,
    paymentId: r.paymentId,
    createdAt: r.createdAt,
  };
}

/** What the borrower sees of their own claim: the status and, if refused, why. Never the slip key. */
export function borrowerSubmissionView(r: Row) {
  return {
    id: r.id,
    contract: { id: r.contractId, contractNo: r.contract.contractNo },
    amount: r.amount.toString(),
    paidOn: formatDateOnly(r.paidOn),
    note: r.note,
    status: r.status,
    rejectReason: r.rejectReason,
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
  };
}

const notFound = () => new DomainError(404, "NOT_FOUND", "ไม่พบรายการ");
const alreadyDecided = () => new DomainError(409, "INVALID_STATE", "รายการนี้ถูกดำเนินการไปแล้ว");

export interface CreateSubmissionInput {
  borrowerId: string;
  /** The borrower's login user (for the audit trail). */
  userId: string;
  contractId: string;
  amount: string;
  paidOn: Date;
  note?: string;
  bytes: Buffer;
}

export async function createSubmission(prisma: Db, storage: SlipStorage, input: CreateSubmissionInput, now: Date = new Date()) {
  const today = bangkokToday(now);
  if (input.paidOn.getTime() > today.getTime()) {
    throw new DomainError(400, "PAID_ON_FUTURE", "วันที่โอนต้องไม่เป็นวันในอนาคต");
  }
  if (input.bytes.length === 0) throw new DomainError(400, "NO_FILE", "กรุณาแนบสลิป (ส่งไฟล์รูปเป็น body ของคำขอ)");
  // the type is decided from the bytes, never from what the client says
  const type = detectSlipType(input.bytes);
  if (!type) throw new DomainError(415, "UNSUPPORTED_FILE_TYPE", "รองรับเฉพาะไฟล์รูป JPEG หรือ PNG");

  // The contract must be this borrower's own and still open; someone else's looks like "not found".
  const checkContract = async (db: Pick<Prisma.TransactionClient, "contract">) => {
    const contract = await db.contract.findFirst({
      where: { id: input.contractId, borrowerId: input.borrowerId },
      select: { id: true, status: true, disbursedOn: true },
    });
    if (!contract) throw new DomainError(404, "NOT_FOUND", "ไม่พบสัญญา");
    if (contract.status !== "ACTIVE") {
      throw new DomainError(409, "INVALID_STATE", "แจ้งชำระได้เฉพาะสัญญาที่ได้รับเงินแล้วและยังไม่ปิด");
    }
    if (contract.disbursedOn && input.paidOn.getTime() < contract.disbursedOn.getTime()) {
      throw new DomainError(400, "PAID_ON_BEFORE_PAYOUT", "วันที่โอนต้องไม่ก่อนวันที่ได้รับเงิน");
    }
  };
  const checkCap = async (db: Pick<Prisma.TransactionClient, "paymentSubmission">) => {
    const pending = await db.paymentSubmission.count({ where: { borrowerId: input.borrowerId, status: "PENDING" } });
    if (pending >= MAX_PENDING_PER_BORROWER) {
      throw new DomainError(409, "TOO_MANY_PENDING", `มีสลิปรอตรวจครบ ${MAX_PENDING_PER_BORROWER} รายการแล้ว กรุณารอผู้ให้กู้ตรวจก่อนส่งเพิ่ม`);
    }
  };

  // cheap checks first, so a refused request never writes a file
  await checkContract(prisma);
  await checkCap(prisma);

  const key = newSlipKey(type);
  await storage.put(key, input.bytes);
  try {
    const row = await prisma.$transaction(async (tx) => {
      // one upload at a time per borrower, so the pending limit cannot be beaten by parallel requests
      await tx.$queryRaw`select id from "Borrower" where id = ${input.borrowerId} for update`;
      await checkContract(tx);
      await checkCap(tx);
      const created = await tx.paymentSubmission.create({
        data: {
          contractId: input.contractId,
          borrowerId: input.borrowerId,
          amount: input.amount,
          paidOn: input.paidOn,
          slipFileKey: key,
          note: input.note ?? null,
        },
        select: submissionSelect,
      });
      await writeAuditLog(tx, {
        actorId: input.userId,
        action: "paymentSubmission.create",
        entityType: "PaymentSubmission",
        entityId: created.id,
        after: { contractId: input.contractId, amount: input.amount, paidOn: formatDateOnly(input.paidOn), note: input.note ?? null },
      });
      return created;
    });
    return row;
  } catch (err) {
    // nothing refers to the file: do not leave a slip nobody can ever see
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
}

export async function listBorrowerSubmissions(prisma: Db, borrowerId: string) {
  const rows = await prisma.paymentSubmission.findMany({
    where: { borrowerId },
    select: submissionSelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 200,
  });
  return rows.map(borrowerSubmissionView);
}

export async function listSubmissions(
  prisma: Db,
  f: { status?: "PENDING" | "CONFIRMED" | "REJECTED"; contractId?: string; limit: number; offset: number },
) {
  const where: Prisma.PaymentSubmissionWhereInput = {
    ...(f.status ? { status: f.status } : {}),
    ...(f.contractId ? { contractId: f.contractId } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.paymentSubmission.count({ where }),
    prisma.paymentSubmission.findMany({
      where,
      select: submissionSelect,
      // the oldest waiting claim first: the queue is worked from the top
      orderBy: f.status === "PENDING" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }],
      take: f.limit,
      skip: f.offset,
    }),
  ]);
  return { total, items: rows.map(adminSubmissionView) };
}

export interface ConfirmOverrides {
  amount?: string;
  paidOn?: Date;
  note?: string;
}

/**
 * Confirms a claim: records the payment through the ledger and marks the claim CONFIRMED in ONE
 * transaction. If the ledger refuses (more than is owed that day, a date before the payout, a
 * contract that closed meanwhile) nothing changes and the claim stays PENDING.
 */
export async function confirmSubmission(prisma: Db, id: string, actorId: string, overrides: ConfirmOverrides = {}, now: Date = new Date()) {
  const today = bangkokToday(now);
  const found = await prisma.paymentSubmission.findUnique({ where: { id }, select: { contractId: true } });
  if (!found) throw notFound();
  let paymentId: string | undefined;
  return withLedgerErrors(
    () => paymentId,
    () =>
      prisma.$transaction(async (tx) => {
        // contract first, then the claim: the same order everywhere, so two admins cannot deadlock
        await lockContract(tx, found.contractId);
        const sub = await tx.paymentSubmission.findUnique({ where: { id } });
        if (!sub) throw notFound();
        const claimed = await tx.paymentSubmission.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "CONFIRMED", decidedById: actorId, decidedAt: now },
        });
        if (claimed.count === 0) throw alreadyDecided();

        const amount = overrides.amount ?? sub.amount.toString();
        const paidOn = overrides.paidOn ?? sub.paidOn;
        const note = overrides.note ?? (sub.note ? `ผู้ยืมแจ้งชำระ: ${sub.note}` : "ผู้ยืมแจ้งชำระ (ตามสลิป)");
        const { payment, contract } = await recordPaymentInTx(
          tx,
          { contractId: sub.contractId, actorId, amount, paidOn, note },
          today,
          (pid) => {
            paymentId = pid;
          },
        );
        await tx.paymentSubmission.update({ where: { id }, data: { paymentId: payment.id } });
        await writeAuditLog(tx, {
          actorId,
          action: "paymentSubmission.confirm",
          entityType: "PaymentSubmission",
          entityId: id,
          before: { status: "PENDING", amount: sub.amount, paidOn: formatDateOnly(sub.paidOn) },
          after: { status: "CONFIRMED", amount, paidOn: formatDateOnly(paidOn), paymentId: payment.id },
          extra: { adjusted: amount !== sub.amount.toString() || paidOn.getTime() !== sub.paidOn.getTime() },
        });
        const updated = await tx.paymentSubmission.findUniqueOrThrow({ where: { id }, select: submissionSelect });
        return { submission: adminSubmissionView(updated), payment, contract };
      }),
  );
}

export async function rejectSubmission(prisma: Db, id: string, actorId: string, reason: string, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const sub = await tx.paymentSubmission.findUnique({ where: { id }, select: { id: true } });
    if (!sub) throw notFound();
    const claimed = await tx.paymentSubmission.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "REJECTED", rejectReason: reason, decidedById: actorId, decidedAt: now },
    });
    if (claimed.count === 0) throw alreadyDecided();
    await writeAuditLog(tx, {
      actorId,
      action: "paymentSubmission.reject",
      entityType: "PaymentSubmission",
      entityId: id,
      before: { status: "PENDING" },
      after: { status: "REJECTED" },
      extra: { reason },
    });
    return adminSubmissionView(await tx.paymentSubmission.findUniqueOrThrow({ where: { id }, select: submissionSelect }));
  });
}
