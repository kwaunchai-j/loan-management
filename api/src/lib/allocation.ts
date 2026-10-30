import { Prisma } from "@prisma/client";

/**
 * DES-011: how a payment is applied. The order is fixed: accrued late fee first, then interest,
 * then principal. A payment above what is owed is refused (never absorbed).
 *   example: owed 1,050 = principal 800 + interest 200 + late fee 50, pays 300
 *            -> late fee 50, interest 200, principal 50
 */
export interface Owed {
  lateFee: Prisma.Decimal;
  interest: Prisma.Decimal;
  principal: Prisma.Decimal;
}

export type Allocation = Owed;

export class AllocationError extends Error {
  constructor(
    readonly code: "NON_POSITIVE_AMOUNT" | "AMOUNT_EXCEEDS_DUE",
    message: string,
    readonly due?: Prisma.Decimal,
  ) {
    super(message);
    this.name = "AllocationError";
  }
}

export function totalOwed(owed: Owed): Prisma.Decimal {
  return owed.lateFee.plus(owed.interest).plus(owed.principal);
}

export function allocatePayment(owed: Owed, amount: Prisma.Decimal): Allocation {
  if (!amount.gt(0)) {
    throw new AllocationError("NON_POSITIVE_AMOUNT", "payment amount must be greater than 0");
  }
  const due = totalOwed(owed);
  if (amount.gt(due)) {
    throw new AllocationError("AMOUNT_EXCEEDS_DUE", "payment exceeds the amount owed", due);
  }
  const lateFee = Prisma.Decimal.min(amount, owed.lateFee);
  const afterFee = amount.minus(lateFee);
  const interest = Prisma.Decimal.min(afterFee, owed.interest);
  // amount <= total owed, so what is left always fits in the principal
  const principal = afterFee.minus(interest);
  return { lateFee, interest, principal };
}
