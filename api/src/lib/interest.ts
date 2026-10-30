import { Prisma } from "@prisma/client";
import { divide, multiply, roundUpBaht, toDecimal, type MoneyInput } from "./money.js";

/** DES-010: flat interest, rate is % per month, days are calendar days / 30. */
const DAYS_PER_MONTH = new Prisma.Decimal(30);
const HUNDRED = new Prisma.Decimal(100);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class InterestError extends Error {
  constructor(
    readonly code: "INVALID_PRINCIPAL" | "INVALID_RATE" | "INVALID_DATE" | "INVALID_DAYS",
    message: string,
  ) {
    super(message);
    this.name = "InterestError";
  }
}

export interface InterestInput {
  principal: MoneyInput;
  /** Setting.interestRatePctPerMonth — the caller must have checked it is set (requireRates). */
  ratePctPerMonth: MoneyInput;
  /** Date-only values (`@db.Date`, UTC midnight of the Asia/Bangkok calendar date). */
  disbursedOn: Date;
  dueDate: Date;
}

export interface InterestResult {
  days: number;
  interestAmount: Prisma.Decimal;
}

function dateOnlyMs(date: Date, name: string): number {
  const ms = date.getTime();
  if (Number.isNaN(ms) || ms % MS_PER_DAY !== 0) {
    throw new InterestError("INVALID_DATE", `${name} must be a date-only value (UTC midnight)`);
  }
  return ms;
}

/** Calendar days from `from` to `to` (both date-only). Negative when `to` is before `from`. */
export function calendarDaysBetween(from: Date, to: Date): number {
  return (dateOnlyMs(to, "to") - dateOnlyMs(from, "from")) / MS_PER_DAY;
}

/** interestAmount = round_up(principal × rate / 100 × days / 30) to a WHOLE baht (always up, never down) */
export function computeInterestForDays(
  principalInput: MoneyInput,
  ratePctPerMonthInput: MoneyInput,
  days: number,
): Prisma.Decimal {
  if (!Number.isInteger(days) || days < 1) {
    throw new InterestError("INVALID_DAYS", "days must be an integer >= 1");
  }
  const principal = toDecimal(principalInput);
  const rate = toDecimal(ratePctPerMonthInput);
  if (!principal.gt(0)) {
    throw new InterestError("INVALID_PRINCIPAL", "principal must be greater than 0");
  }
  if (rate.isNegative()) {
    throw new InterestError("INVALID_RATE", "interest rate must not be negative");
  }
  // Multiply first (exact), divide once, then round up.
  const numerator = multiply(multiply(principal, rate), new Prisma.Decimal(days));
  const denominator = multiply(HUNDRED, DAYS_PER_MONTH);
  return roundUpBaht(divide(numerator, denominator));
}

/** DES-010: days = dueDate − disbursedOn (must be >= 1), then the flat interest above. */
export function computeInterest(input: InterestInput): InterestResult {
  const days = calendarDaysBetween(input.disbursedOn, input.dueDate);
  if (days < 1) {
    throw new InterestError("INVALID_DAYS", "dueDate must be at least 1 day after disbursedOn");
  }
  return {
    days,
    interestAmount: computeInterestForDays(input.principal, input.ratePctPerMonth, days),
  };
}
