import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { formatDateOnly } from "../lib/dates.js";
import { periodView, type Period } from "./period.js";

/**
 * Profit & loss (DES-015 §1): cash basis and accrual basis in ONE report. Income is only interest
 * and late fees — no bad debt or other expenses (a user decision).
 *
 *  cash:    interest + late fee actually ALLOCATED from payments received in the period
 *           (Payment.allocatedInterest / allocatedLateFee, paidOn in the period).
 *  accrual: interest = the full interestAmount of contracts whose DUE DATE falls in the period
 *           (recognised in full on the due date); late fee = recognised only when cash is received,
 *           so it equals the cash figure.
 * Imported contracts count like any other (their interest comes from the file).
 * Because everything is derived from the ledger, editing or deleting a payment changes the report
 * of past periods (DES-016 says so).
 */
const ZERO = new Prisma.Decimal(0);

export async function profitLoss(prisma: Db, period: Period, today: Date) {
  const cash = await prisma.payment.aggregate({
    where: { paidOn: { gte: period.from, lte: period.to } },
    _sum: { allocatedInterest: true, allocatedLateFee: true },
    _count: { _all: true },
  });
  const cashInterest = cash._sum.allocatedInterest ?? ZERO;
  const cashLateFee = cash._sum.allocatedLateFee ?? ZERO;

  // A due date that has not arrived yet is not income yet: recognise up to today at most.
  const recognisedThrough = period.to.getTime() < today.getTime() ? period.to : today;
  const accrual =
    recognisedThrough.getTime() >= period.from.getTime()
      ? await prisma.contract.aggregate({
          where: {
            status: { in: ["ACTIVE", "CLOSED"] },
            dueDate: { gte: period.from, lte: recognisedThrough },
          },
          _sum: { interestAmount: true },
          _count: { _all: true },
        })
      : null;
  const accrualInterest = accrual?._sum.interestAmount ?? ZERO;

  const s = (v: Prisma.Decimal) => v.toString();
  return {
    period: periodView(period),
    cash: {
      interest: s(cashInterest),
      lateFee: s(cashLateFee),
      total: s(cashInterest.plus(cashLateFee)),
      paymentCount: cash._count._all,
    },
    accrual: {
      interest: s(accrualInterest),
      // late fees are recognised when received (DES-015), so the same as the cash basis
      lateFee: s(cashLateFee),
      total: s(accrualInterest.plus(cashLateFee)),
      contractCount: accrual?._count._all ?? 0,
      interestRecognisedThrough: formatDateOnly(recognisedThrough),
    },
  };
}
