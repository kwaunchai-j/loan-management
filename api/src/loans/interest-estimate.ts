import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { calendarDaysBetween, computeInterestForDays } from "../lib/interest.js";
import { MAX_AMOUNT } from "../lib/late-fee.js";
import { getRates } from "../lib/rates.js";
import { toDecimal } from "../lib/money.js";

/**
 * A borrower's "how much interest would this be?" (nothing is saved, nobody is notified).
 *
 * It is the same formula as the real contract (DES-010, `computeInterestForDays`) with the rate from the
 * one Setting row, so the figure can never drift from what the contract will say — but it is an ESTIMATE:
 * the real interest counts the days from the day the lender actually transfers the money, which the
 * estimate can only assume to be today. Without a due date the estimate is for 30 days (one month).
 */
export const DEFAULT_ESTIMATE_DAYS = 30;

export interface InterestEstimate {
  amount: string;
  /** The day the money is assumed to be paid out (today, Asia/Bangkok). */
  payoutDate: string;
  dueDate: string | null;
  days: number;
  /** true when no due date was given and the standard 30 days was used. */
  daysAssumed: boolean;
  interestRatePctPerMonth: string;
  interestAmount: string;
  totalToRepay: string;
  isEstimate: true;
}

export async function estimateInterest(
  prisma: Db,
  input: { amount: string; dueDate?: Date },
  now: Date = new Date(),
): Promise<InterestEstimate> {
  const { interestRatePctPerMonth } = await getRates(prisma);
  if (interestRatePctPerMonth === null) {
    // not the admin's "go to settings" wording: a borrower cannot set rates
    throw new DomainError(409, "RATES_NOT_SET", "ยังคำนวณดอกเบี้ยให้ไม่ได้ในขณะนี้ กรุณาติดต่อผู้ให้กู้");
  }
  const today = bangkokToday(now);
  const daysAssumed = input.dueDate === undefined;
  const days = input.dueDate ? calendarDaysBetween(today, input.dueDate) : DEFAULT_ESTIMATE_DAYS;
  if (days < 1) {
    throw new DomainError(400, "DUE_DATE_NOT_FUTURE", "วันครบกำหนดต้องเป็นวันในอนาคต");
  }
  const principal = toDecimal(input.amount);
  const interest = computeInterestForDays(principal, interestRatePctPerMonth, days);
  const total = principal.plus(interest);
  if (interest.gt(MAX_AMOUNT) || total.gt(MAX_AMOUNT)) {
    throw new DomainError(400, "LIMIT_EXCEEDED", "ยอดเกินขีดจำกัดที่ระบบคำนวณได้ กรุณาลดจำนวนเงินหรือเลือกวันครบกำหนดให้ใกล้ขึ้น");
  }
  const text = (d: Prisma.Decimal) => d.toString();
  return {
    amount: text(principal),
    payoutDate: formatDateOnly(today),
    dueDate: input.dueDate ? formatDateOnly(input.dueDate) : null,
    days,
    daysAssumed,
    interestRatePctPerMonth: text(interestRatePctPerMonth),
    interestAmount: text(interest),
    totalToRepay: text(total),
    isEstimate: true,
  };
}
