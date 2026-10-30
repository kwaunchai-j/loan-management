import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { divide, multiply, roundUpBaht, toDecimal } from "../src/lib/money.js";

const D = (v: string) => new Prisma.Decimal(v);

describe("toDecimal", () => {
  it("accepts a Decimal and a string, and keeps every digit", () => {
    expect(toDecimal("1234.56").toString()).toBe("1234.56");
    expect(toDecimal(D("0.1")).toString()).toBe("0.1");
    expect(toDecimal("999999999999.99").toString()).toBe("999999999999.99");
  });

  it("refuses a JavaScript number, so a float can never become money", () => {
    expect(() => toDecimal(0.1 as unknown as string)).toThrow(TypeError);
    expect(() => toDecimal(5 as unknown as string)).toThrow(/never number/);
  });

  it("refuses values that are not finite", () => {
    expect(() => toDecimal("Infinity")).toThrow(RangeError);
    expect(() => toDecimal("NaN")).toThrow(RangeError);
  });
});

describe("multiply and divide are exact at high precision", () => {
  it("multiplies without losing digits (a float would)", () => {
    expect(multiply(D("0.1"), D("3")).toString()).toBe("0.3");
    expect(multiply(D("999999999999.99"), D("3.1234")).toString()).toBe("3123399999999.968766");
  });

  it("divides to far more digits than 2, so the later round-up decides", () => {
    expect(divide(D("1"), D("3")).toString().startsWith("0.3333333333333333333333333333")).toBe(true);
    expect(divide(D("10"), D("4")).toString()).toBe("2.5");
  });

  it("rounds the 60th digit up, never down", () => {
    const third = divide(D("1"), D("3")).toString();
    expect(third.endsWith("4")).toBe(true); // 0.333...3 rounded UP at the last kept digit
  });
});

describe("roundUpBaht: always UP to a whole baht, never down", () => {
  it.each([
    ["0", "0"],
    ["1", "1"],
    ["258", "258"],
    ["258.00", "258"],
    ["258.01", "259"],
    ["258.1", "259"],
    ["258.49", "259"], // nearest would give 258
    ["258.50", "259"],
    ["258.99", "259"],
    ["0.01", "1"],
    ["0.0000001", "1"],
    ["1000.000000000000000000000000000001", "1001"], // a tiny remainder still counts
    ["999999999999.01", "1000000000000"],
  ])("%s -> %s", (input, expected) => {
    expect(roundUpBaht(D(input)).toString()).toBe(expected);
  });

  it("is never below the input and less than 1 above it (a property check over many values)", () => {
    for (let i = 0; i < 2000; i++) {
      const cents = (i * 7919) % 10_000_000; // 0 .. 99,999.99
      const value = D((cents / 100).toFixed(2));
      const r = roundUpBaht(value);
      expect(r.gte(value), `${value} -> ${r}`).toBe(true);
      expect(r.minus(value).lt(1), `${value} -> ${r}`).toBe(true);
      expect(r.mod(1).isZero()).toBe(true);
    }
  });

  it("leaves a result that is already whole exactly as it was (idempotent)", () => {
    for (const v of ["0.01", "12.34", "100", "5.5"]) {
      const once = roundUpBaht(D(v));
      expect(roundUpBaht(once).toString()).toBe(once.toString());
    }
  });
});
