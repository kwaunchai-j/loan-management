import type { Prisma } from "@prisma/client";

/**
 * lib:rates (DES-003). The interest and late-fee rates exist only in the single Setting row
 * (id = 1) and are null until an ADMIN sets them — no rate is ever hard-coded. Anything that
 * creates money (disbursement, import) must call `requireRates` first.
 */
export const SETTING_ID = 1;

export type RatesDb = Pick<Prisma.TransactionClient, "setting">;

export interface Rates {
  /** % per month, flat. */
  interestRatePctPerMonth: Prisma.Decimal;
  /** % per day, compounding. */
  lateFeeRatePctPerDay: Prisma.Decimal;
}

export class RatesNotSetError extends Error {
  readonly code = "RATES_NOT_SET";
  constructor() {
    super("interest and late-fee rates have not been set by an admin");
    this.name = "RatesNotSetError";
  }
}

/** The stored rates; either may be null. */
export async function getRates(db: RatesDb) {
  const row = await db.setting.findUnique({ where: { id: SETTING_ID } });
  return {
    interestRatePctPerMonth: row?.interestRatePctPerMonth ?? null,
    lateFeeRatePctPerDay: row?.lateFeeRatePctPerDay ?? null,
  };
}

/** Both rates, or throws RatesNotSetError (the error handler answers 409 RATES_NOT_SET). */
export async function requireRates(db: RatesDb): Promise<Rates> {
  const { interestRatePctPerMonth, lateFeeRatePctPerDay } = await getRates(db);
  if (interestRatePctPerMonth === null || lateFeeRatePctPerDay === null) {
    throw new RatesNotSetError();
  }
  return { interestRatePctPerMonth, lateFeeRatePctPerDay };
}
