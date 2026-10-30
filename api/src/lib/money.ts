import { Prisma } from "@prisma/client";

/**
 * Decimal arithmetic for money. Never use `number` for amounts (HANDOFF rule 4).
 * The working precision is high enough that intermediate products and quotients
 * stay exact for Decimal(14,2) amounts and Decimal(7,4) rates; rounding is always an
 * explicit round-up to a whole baht (`roundUpBaht`).
 */
const Dec = Prisma.Decimal.clone({ precision: 60, rounding: Prisma.Decimal.ROUND_UP });

export type MoneyInput = Prisma.Decimal | string;

export function toDecimal(value: MoneyInput): Prisma.Decimal {
  if (typeof value !== "string" && !Prisma.Decimal.isDecimal(value)) {
    throw new TypeError("money values must be Decimal or string, never number");
  }
  const d = new Dec(value.toString());
  if (!d.isFinite()) {
    throw new RangeError("money value must be finite");
  }
  return new Prisma.Decimal(d.toString());
}

/** Divide with high precision (rounding up at the 60th digit, which never changes a 2dp round-up). */
export function divide(numerator: Prisma.Decimal, denominator: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(new Dec(numerator.toString()).div(denominator.toString()).toString());
}

/**
 * Round UP to a whole baht (0 decimal places). Only ever up, never down: 258.01 -> 259, 0.01 -> 1,
 * and a value that is already a whole number stays as it is (259.00 -> 259). Used for the interest
 * and the daily late fee (DES-010, DES-012), so those amounts are always whole baht.
 */
export function roundUpBaht(value: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(new Dec(value.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_UP).toString());
}

/** Exact product: the default Decimal precision (20 digits) is not enough for amount × rate × days. */
export function multiply(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(new Dec(a.toString()).mul(b.toString()).toString());
}
