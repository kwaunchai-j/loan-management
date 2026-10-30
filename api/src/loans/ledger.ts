import { Prisma } from "@prisma/client";
import { DomainError } from "../http.js";
import { formatDateOnly } from "../lib/dates.js";
import { simulateContract, type SimViolation } from "../lib/late-fee.js";

/**
 * The contract ledger (DES-011, DES-012, DES-016).
 *
 * Every change to money after the payout — a new payment, an edited or deleted payment or payout,
 * the nightly late-fee job — ends the same way: lock the contract, replay its whole life with
 * `simulateContract`, and write the result back (payment allocations, one LateFeeAccrual per late
 * day, the denormalised balances, status and closedOn). One replay, one truth; a result that breaks
 * a rule (overpayment, a date before the payout, ...) aborts the transaction and nothing is saved.
 */
export type Tx = Prisma.TransactionClient;

/** Serialises everything that changes one contract. Returns false when the contract does not exist. */
export async function lockContract(tx: Tx, contractId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    select id from "Contract" where id = ${contractId} for update`;
  return rows.length > 0;
}

export class LedgerViolationError extends Error {
  constructor(readonly violation: SimViolation) {
    super(`ledger violation: ${violation.code}`);
    this.name = "LedgerViolationError";
  }
}

const dayKey = (d: Date) => formatDateOnly(d);

export async function reconcileContract(tx: Tx, contractId: string, today: Date) {
  const contract = await tx.contract.findUnique({
    where: { id: contractId },
    include: { payments: true, lateFeeAccruals: true },
  });
  if (!contract) throw new DomainError(404, "NOT_FOUND", "ไม่พบสัญญา");
  if (contract.status !== "ACTIVE" && contract.status !== "CLOSED") {
    throw new DomainError(409, "INVALID_STATE", "สัญญานี้ยังไม่ได้จ่ายเงินหรือถูกยกเลิกแล้ว");
  }
  if (contract.interestAmount === null || contract.lateFeeRatePctPerDay === null) {
    throw new Error(`contract ${contract.id} is ${contract.status} but has no interest/late-fee terms`);
  }

  const sim = simulateContract({
    principal: contract.principal,
    interestAmount: contract.interestAmount,
    dueDate: contract.dueDate,
    disbursedOn: contract.disbursedOn,
    lateFeeRatePctPerDay: contract.lateFeeRatePctPerDay,
    payments: contract.payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      paidOn: p.paidOn,
      createdAt: p.createdAt,
    })),
    today,
  });
  if (!sim.ok) throw new LedgerViolationError(sim.violation);

  // payment allocations
  for (const p of contract.payments) {
    const a = sim.allocations.get(p.id)!;
    if (
      !p.allocatedLateFee.equals(a.lateFee) ||
      !p.allocatedInterest.equals(a.interest) ||
      !p.allocatedPrincipal.equals(a.principal)
    ) {
      await tx.payment.update({
        where: { id: p.id },
        data: {
          allocatedLateFee: a.lateFee,
          allocatedInterest: a.interest,
          allocatedPrincipal: a.principal,
        },
      });
    }
  }

  // late-fee accruals: create the missing days, fix changed ones, drop days that no longer apply
  const existing = new Map(contract.lateFeeAccruals.map((r) => [dayKey(r.accrualDate), r]));
  const wanted = new Set(sim.accruals.map((a) => dayKey(a.accrualDate)));
  const missing = sim.accruals.filter((a) => !existing.has(dayKey(a.accrualDate)));
  if (missing.length > 0) {
    await tx.lateFeeAccrual.createMany({
      data: missing.map((a) => ({
        contractId,
        accrualDate: a.accrualDate,
        baseAmount: a.baseAmount,
        ratePctPerDay: a.ratePctPerDay,
        amount: a.amount,
      })),
    });
  }
  for (const a of sim.accruals) {
    const row = existing.get(dayKey(a.accrualDate));
    if (
      row &&
      (!row.baseAmount.equals(a.baseAmount) ||
        !row.amount.equals(a.amount) ||
        !row.ratePctPerDay.equals(a.ratePctPerDay))
    ) {
      await tx.lateFeeAccrual.update({
        where: { id: row.id },
        data: { baseAmount: a.baseAmount, amount: a.amount, ratePctPerDay: a.ratePctPerDay },
      });
    }
  }
  const stale = contract.lateFeeAccruals.filter((r) => !wanted.has(dayKey(r.accrualDate))).map((r) => r.id);
  if (stale.length > 0) await tx.lateFeeAccrual.deleteMany({ where: { id: { in: stale } } });

  const updated = await tx.contract.update({
    where: { id: contractId },
    data: {
      outstandingPrincipal: sim.outstandingPrincipal,
      outstandingInterest: sim.outstandingInterest,
      accruedLateFee: sim.accruedLateFee,
      status: sim.status,
      closedOn: sim.closedOn,
    },
  });
  return { contract: updated, sim };
}

/** Balances and status of a contract, for audit entries and responses. */
export function ledgerSnapshot(c: {
  status: string;
  outstandingPrincipal: Prisma.Decimal;
  outstandingInterest: Prisma.Decimal;
  accruedLateFee: Prisma.Decimal;
  closedOn: Date | null;
}) {
  return {
    status: c.status,
    outstandingPrincipal: c.outstandingPrincipal,
    outstandingInterest: c.outstandingInterest,
    accruedLateFee: c.accruedLateFee,
    totalDue: c.outstandingPrincipal.plus(c.outstandingInterest).plus(c.accruedLateFee),
    closedOn: c.closedOn ? formatDateOnly(c.closedOn) : null,
  };
}

/** Turns a rule violation found by the replay into the answer the admin sees. */
export function violationToError(v: SimViolation, targetPaymentId?: string): DomainError {
  switch (v.code) {
    case "NON_POSITIVE_AMOUNT":
      return new DomainError(400, "AMOUNT_INVALID", "จำนวนเงินที่ชำระต้องมากกว่า 0");
    case "PAID_ON_FUTURE":
      return new DomainError(400, "PAID_ON_FUTURE", "วันที่รับชำระต้องไม่เป็นวันในอนาคต");
    case "PAID_BEFORE_DISBURSEMENT":
      return new DomainError(400, "PAID_BEFORE_DISBURSEMENT", "วันที่รับชำระต้องไม่ก่อนวันที่จ่ายเงินให้ผู้ยืม");
    case "AMOUNT_EXCEEDS_DUE":
      return v.paymentId === targetPaymentId || targetPaymentId === undefined
        ? new DomainError(
            400,
            "AMOUNT_EXCEEDS_DUE",
            `ชำระเกินยอดที่ติดไม่ได้ ยอดที่ต้องชำระ ณ วันนั้นคือ ${v.due.toFixed(2)} บาท`,
          )
        : new DomainError(
            409,
            "CONFLICTS_WITH_OTHER_PAYMENT",
            "การเปลี่ยนแปลงนี้ทำให้รายการรับชำระอื่นของสัญญานี้เกินยอดที่ติด จึงทำรายการไม่ได้",
          );
    case "LIMIT_EXCEEDED":
      return new DomainError(409, "LIMIT_EXCEEDED", "ยอดของสัญญานี้เกินขีดจำกัดที่ระบบเก็บได้");
  }
}

/** Runs a ledger step, translating a replay violation into a clean error. */
export async function withLedgerErrors<T>(
  getTargetPaymentId: () => string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LedgerViolationError) throw violationToError(err.violation, getTargetPaymentId());
    throw err;
  }
}
