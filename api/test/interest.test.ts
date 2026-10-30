import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  calendarDaysBetween,
  computeInterest,
  computeInterestForDays,
  InterestError,
} from "../src/lib/interest.js";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** the interest as text; every interest is a WHOLE number of baht (rounded up, never down) */
const interest = (principal: string, rate: string, days: number) => {
  const out = computeInterestForDays(principal, rate, days);
  expect(out.isInteger(), `${principal} @ ${rate}% x ${days}d = ${out.toString()}`).toBe(true);
  return out.toFixed(0);
};

describe("calendarDaysBetween", () => {
  it("counts calendar days", () => {
    expect(calendarDaysBetween(d("2026-10-01"), d("2026-10-31"))).toBe(30);
    expect(calendarDaysBetween(d("2026-10-29"), d("2026-10-29"))).toBe(0);
    expect(calendarDaysBetween(d("2026-10-30"), d("2026-10-29"))).toBe(-1);
  });

  it("handles month, year and leap-year boundaries", () => {
    expect(calendarDaysBetween(d("2026-12-31"), d("2027-01-01"))).toBe(1);
    expect(calendarDaysBetween(d("2028-02-28"), d("2028-03-01"))).toBe(2);
    expect(calendarDaysBetween(d("2027-02-28"), d("2027-03-01"))).toBe(1);
  });

  it("rejects values that are not date-only", () => {
    expect(() => calendarDaysBetween(new Date("2026-10-01T05:30:00Z"), d("2026-10-31"))).toThrow(
      InterestError,
    );
    expect(() => calendarDaysBetween(new Date("invalid"), d("2026-10-31"))).toThrow(InterestError);
  });
});

describe("computeInterestForDays (DES-010)", () => {
  it("matches hand-computed exact amounts (already whole baht, so nothing is added)", () => {
    expect(interest("10000", "3", 30)).toBe("300");
    expect(interest("10000", "3", 15)).toBe("150");
    expect(interest("100", "1.5", 20)).toBe("1");
    expect(interest("3000", "1", 30)).toBe("30");
  });

  it("rounds UP to a whole baht whenever there is any remainder, never down and never to nearest", () => {
    // 8.3333... -> 9 (nearest would give 8)
    expect(interest("1000", "2.5", 10)).toBe("9");
    // 0.3333... -> 1
    expect(interest("1000", "1", 1)).toBe("1");
    // 24.6912 -> 25
    expect(interest("1234.56", "2", 30)).toBe("25");
    // 24.69 -> 25 (a remainder of 0.69 still goes up)
    expect(interest("1234.50", "2", 30)).toBe("25");
    // a remainder of just over zero still costs a whole baht
    expect(interest("1", "0.0001", 1)).toBe("1");
    expect(interest("0.01", "100", 30)).toBe("1");
    // 773.33... -> 774
    expect(interest("2000", "40", 29)).toBe("774");
  });

  it("does not bump an amount that is already a whole number of baht", () => {
    expect(interest("1500", "2", 30)).toBe("30");
    expect(interest("100", "100", 30)).toBe("100");
    expect(interest("3000", "5", 6)).toBe("30");
  });

  it("allows a 0% rate and returns 0", () => {
    expect(interest("5000", "0", 10)).toBe("0");
  });

  it("returns a Prisma Decimal", () => {
    expect(Prisma.Decimal.isDecimal(computeInterestForDays("1000", "1", 30))).toBe(true);
  });

  it("accepts Decimal inputs", () => {
    const out = computeInterestForDays(
      new Prisma.Decimal("1000"),
      new Prisma.Decimal("2.5"),
      10,
    );
    expect(out.toFixed(0)).toBe("9");
  });

  it("rejects number inputs (floats are not allowed for money)", () => {
    expect(() => computeInterestForDays(1000 as unknown as string, "1", 30)).toThrow(TypeError);
    expect(() => computeInterestForDays("1000", 1 as unknown as string, 30)).toThrow(TypeError);
  });

  it("rejects invalid days", () => {
    for (const days of [0, -1, 1.5, Number.NaN]) {
      expect(() => computeInterestForDays("1000", "1", days)).toThrow(
        expect.objectContaining({ code: "INVALID_DAYS" }),
      );
    }
  });

  it("rejects non-positive principal and negative rate", () => {
    expect(() => computeInterestForDays("0", "1", 30)).toThrow(
      expect.objectContaining({ code: "INVALID_PRINCIPAL" }),
    );
    expect(() => computeInterestForDays("-5", "1", 30)).toThrow(
      expect.objectContaining({ code: "INVALID_PRINCIPAL" }),
    );
    expect(() => computeInterestForDays("1000", "-0.5", 30)).toThrow(
      expect.objectContaining({ code: "INVALID_RATE" }),
    );
  });

  it("agrees with an independent BigInt oracle across many random cases", () => {
    // interest in baht = ceil(Pc × rate(1e-4 units) × days / (1e4 × 100 × 30 × 100)); Pc is in satang
    let seed = 20261029;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    for (let i = 0; i < 2000; i++) {
      const principalSatang = BigInt(1 + next(2_000_000_000)) * BigInt(1 + next(400));
      const rateUnits = BigInt(next(1_000_000)); // 0.0000 .. 99.9999 %
      const days = 1 + next(3650);
      const expectedBaht = ceilDiv(
        principalSatang * rateUnits * BigInt(days),
        10_000n * 100n * 30n * 100n,
      );
      const principal = `${principalSatang / 100n}.${(principalSatang % 100n).toString().padStart(2, "0")}`;
      const rate = `${rateUnits / 10_000n}.${(rateUnits % 10_000n).toString().padStart(4, "0")}`;
      const actual = computeInterestForDays(principal, rate, days);
      expect(actual.toFixed(0), `${principal} @ ${rate}% x ${days}d`).toBe(expectedBaht.toString());
    }
  });

  it("stays exact when principal, rate and days are all large (products over 20 digits)", () => {
    // 999,999,999,999.99 × 999.9999 % × 3650 days has a 25-digit exact product; a 20-digit
    // intermediate would round it and could move the result by a satang.
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    for (let i = 0; i < 3000; i++) {
      const principalSatang = 90_000_000_000_000n + BigInt(next(2_000_000_000)) * 4n + BigInt(next(4)); // ~9e13 satang
      const rateUnits = 9_900_000n + BigInt(next(99_999)); // 990.0000 .. 999.9999 %
      const days = 3000 + next(651);
      const expectedBaht = ceilDiv(principalSatang * rateUnits * BigInt(days), 10_000n * 100n * 30n * 100n);
      const principal = `${principalSatang / 100n}.${(principalSatang % 100n).toString().padStart(2, "0")}`;
      const rate = `${rateUnits / 10_000n}.${(rateUnits % 10_000n).toString().padStart(4, "0")}`;
      expect(computeInterestForDays(principal, rate, days).toFixed(0), `${principal} @ ${rate}% x ${days}d`).toBe(expectedBaht.toString());
    }
  });

  it("stays exact at the Decimal(14,2) maximum", () => {
    // 999,999,999,999.99 × 5% × 365/30 = 608,333,333,333.327... -> round UP to the next whole baht
    expect(interest("999999999999.99", "5", 365)).toBe("608333333334");
  });
});

describe("computeInterest (DES-010 with dates)", () => {
  it("uses days from disbursedOn to dueDate", () => {
    const out = computeInterest({
      principal: "10000",
      ratePctPerMonth: "3",
      disbursedOn: d("2026-10-01"),
      dueDate: d("2026-10-31"),
    });
    expect(out.days).toBe(30);
    expect(out.interestAmount.toFixed(0)).toBe("300");
  });

  it("charges the full amount for a 1-day loan", () => {
    const out = computeInterest({
      principal: "1000",
      ratePctPerMonth: "1",
      disbursedOn: d("2026-10-29"),
      dueDate: d("2026-10-30"),
    });
    expect(out.days).toBe(1);
    expect(out.interestAmount.toFixed(0)).toBe("1");
  });

  it("rejects dueDate on or before disbursedOn", () => {
    for (const dueDate of [d("2026-10-29"), d("2026-10-01")]) {
      expect(() =>
        computeInterest({
          principal: "1000",
          ratePctPerMonth: "1",
          disbursedOn: d("2026-10-29"),
          dueDate,
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_DAYS" }));
    }
  });
});
