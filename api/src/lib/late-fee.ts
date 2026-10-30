import { Prisma } from "@prisma/client";
import { allocatePayment, AllocationError, totalOwed, type Allocation } from "./allocation.js";
import { divide, multiply, roundUpBaht } from "./money.js";

/**
 * DES-012 / DES-016: the whole life of a contract as a pure function.
 *
 * Given the contract terms, every payment and "today", it works out day by day:
 *  - on each day D after the due date, if anything was still owed at the end of D-1, a late fee of
 *    round_up(owed_at_end_of_D-1 x rate/100) to a whole baht is added: compounding, no cap (DES-012);
 *  - payments are applied on their paidOn day AFTER that day's fee, fee -> interest -> principal;
 *  - the day the balance reaches 0 the contract is CLOSED; that day's fee was still charged, and
 *    no fee is charged on later days.
 * Back-dated, edited or deleted payments are just a different input: the same replay gives the
 * new state, so there is one definition of the truth (DES-016).
 */
export const MAX_AMOUNT = new Prisma.Decimal("999999999999.99"); // Decimal(14,2)
const HUNDRED = new Prisma.Decimal(100);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The late fee charged for one day on `base`, rounded UP to a whole baht (never down). */
export function lateFeeForDay(base: Prisma.Decimal, ratePctPerDay: Prisma.Decimal): Prisma.Decimal {
  return roundUpBaht(divide(multiply(base, ratePctPerDay), HUNDRED));
}

export interface SimPayment {
  id: string;
  amount: Prisma.Decimal;
  /** Date-only (UTC midnight of the Asia/Bangkok date). */
  paidOn: Date;
  createdAt: Date;
}

export interface SimInput {
  principal: Prisma.Decimal;
  /** The fixed interest of the contract (DES-010); never changes with payments. */
  interestAmount: Prisma.Decimal;
  dueDate: Date;
  /** null for imported contracts, which have no payout date. */
  disbursedOn: Date | null;
  lateFeeRatePctPerDay: Prisma.Decimal;
  payments: SimPayment[];
  /** Today's date in Asia/Bangkok (date-only). */
  today: Date;
}

export interface SimAccrual {
  accrualDate: Date;
  baseAmount: Prisma.Decimal;
  ratePctPerDay: Prisma.Decimal;
  amount: Prisma.Decimal;
}

export type SimViolation =
  | { code: "NON_POSITIVE_AMOUNT"; paymentId: string }
  | { code: "PAID_ON_FUTURE"; paymentId: string }
  | { code: "PAID_BEFORE_DISBURSEMENT"; paymentId: string }
  | { code: "AMOUNT_EXCEEDS_DUE"; paymentId: string; due: Prisma.Decimal }
  | { code: "LIMIT_EXCEEDED" };

export type SimResult =
  | {
      ok: true;
      outstandingPrincipal: Prisma.Decimal;
      outstandingInterest: Prisma.Decimal;
      accruedLateFee: Prisma.Decimal;
      status: "ACTIVE" | "CLOSED";
      closedOn: Date | null;
      accruals: SimAccrual[];
      allocations: Map<string, Allocation>;
    }
  | { ok: false; violation: SimViolation };

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_PER_DAY);

export function simulateContract(input: SimInput): SimResult {
  const payments = [...input.payments].sort(
    (a, b) =>
      a.paidOn.getTime() - b.paidOn.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  for (const p of payments) {
    if (!p.amount.gt(0)) return { ok: false, violation: { code: "NON_POSITIVE_AMOUNT", paymentId: p.id } };
    if (p.paidOn.getTime() > input.today.getTime()) {
      return { ok: false, violation: { code: "PAID_ON_FUTURE", paymentId: p.id } };
    }
    if (input.disbursedOn && p.paidOn.getTime() < input.disbursedOn.getTime()) {
      return { ok: false, violation: { code: "PAID_BEFORE_DISBURSEMENT", paymentId: p.id } };
    }
  }

  let principal = input.principal;
  let interest = input.interestAmount;
  let lateFee = new Prisma.Decimal(0);
  let closedOn: Date | null = null;
  const accruals: SimAccrual[] = [];
  const allocations = new Map<string, Allocation>();
  let next = 0;

  const applyPaymentsUpTo = (day: Date): SimViolation | null => {
    while (next < payments.length && payments[next]!.paidOn.getTime() <= day.getTime()) {
      const p = payments[next++]!;
      try {
        const a = allocatePayment({ lateFee, interest, principal }, p.amount);
        allocations.set(p.id, a);
        lateFee = lateFee.minus(a.lateFee);
        interest = interest.minus(a.interest);
        principal = principal.minus(a.principal);
      } catch (err) {
        if (err instanceof AllocationError) {
          return err.code === "AMOUNT_EXCEEDS_DUE"
            ? { code: "AMOUNT_EXCEEDS_DUE", paymentId: p.id, due: err.due! }
            : { code: "NON_POSITIVE_AMOUNT", paymentId: p.id };
        }
        throw err;
      }
      if (totalOwed({ lateFee, interest, principal }).isZero() && closedOn === null) {
        closedOn = p.paidOn;
      }
    }
    return null;
  };

  // Up to and including the due date no fee exists; payments just reduce what is owed.
  let violation = applyPaymentsUpTo(input.dueDate);
  if (violation) return { ok: false, violation };

  for (
    let day = addDays(input.dueDate, 1);
    closedOn === null && day.getTime() <= input.today.getTime();
    day = addDays(day, 1)
  ) {
    // Something is owed at the end of the previous day (otherwise the contract would be closed).
    const base = totalOwed({ lateFee, interest, principal });
    if (base.gt(MAX_AMOUNT)) return { ok: false, violation: { code: "LIMIT_EXCEEDED" } };
    const amount = lateFeeForDay(base, input.lateFeeRatePctPerDay);
    lateFee = lateFee.plus(amount);
    accruals.push({
      accrualDate: day,
      baseAmount: base,
      ratePctPerDay: input.lateFeeRatePctPerDay,
      amount,
    });
    violation = applyPaymentsUpTo(day);
    if (violation) return { ok: false, violation };
  }

  // Any payment left over is dated after the contract closed (nothing is owed any more): refused.
  violation = applyPaymentsUpTo(input.today);
  if (violation) return { ok: false, violation };

  if ([principal, interest, lateFee].some((v) => v.gt(MAX_AMOUNT))) {
    return { ok: false, violation: { code: "LIMIT_EXCEEDED" } };
  }
  return {
    ok: true,
    outstandingPrincipal: principal,
    outstandingInterest: interest,
    accruedLateFee: lateFee,
    status: closedOn === null ? "ACTIVE" : "CLOSED",
    closedOn,
    accruals,
    allocations,
  };
}
