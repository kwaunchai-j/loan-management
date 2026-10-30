import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { allocatePayment, AllocationError, totalOwed, type Owed } from "../src/lib/allocation.js";

const D = (v: string) => new Prisma.Decimal(v);
const owed = (lateFee: string, interest: string, principal: string): Owed => ({
  lateFee: D(lateFee),
  interest: D(interest),
  principal: D(principal),
});
const show = (a: Owed) => [a.lateFee, a.interest, a.principal].map((v) => v.toFixed(2));

describe("allocatePayment (DES-011: late fee -> interest -> principal)", () => {
  it("matches the worked example: owed 1,050, pays 300 -> 50 / 200 / 50", () => {
    expect(show(allocatePayment(owed("50", "200", "800"), D("300")))).toEqual(["50.00", "200.00", "50.00"]);
  });

  it("pays the late fee first, even when the payment is smaller than the fee", () => {
    expect(show(allocatePayment(owed("50", "200", "800"), D("30")))).toEqual(["30.00", "0.00", "0.00"]);
    expect(show(allocatePayment(owed("50", "200", "800"), D("50")))).toEqual(["50.00", "0.00", "0.00"]);
  });

  it("moves on to interest only after the fee is covered, and to principal after the interest", () => {
    expect(show(allocatePayment(owed("50", "200", "800"), D("120")))).toEqual(["50.00", "70.00", "0.00"]);
    expect(show(allocatePayment(owed("50", "200", "800"), D("250")))).toEqual(["50.00", "200.00", "0.00"]);
    expect(show(allocatePayment(owed("0", "200", "800"), D("200.01")))).toEqual(["0.00", "200.00", "0.01"]);
  });

  it("can settle everything exactly", () => {
    const o = owed("50", "200", "800");
    expect(show(allocatePayment(o, totalOwed(o)))).toEqual(["50.00", "200.00", "800.00"]);
    expect(totalOwed(o).toFixed(2)).toBe("1050.00");
  });

  it("refuses a payment above what is owed, and says how much is owed", () => {
    const o = owed("50", "200", "800");
    try {
      allocatePayment(o, D("1050.01"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AllocationError);
      expect((err as AllocationError).code).toBe("AMOUNT_EXCEEDS_DUE");
      expect((err as AllocationError).due!.toFixed(2)).toBe("1050.00");
    }
  });

  it("refuses zero and negative payments", () => {
    for (const amount of ["0", "-1", "-0.01"]) {
      expect(() => allocatePayment(owed("0", "0", "100"), D(amount))).toThrow(
        expect.objectContaining({ code: "NON_POSITIVE_AMOUNT" }),
      );
    }
  });

  it("refuses any payment when nothing is owed", () => {
    expect(() => allocatePayment(owed("0", "0", "0"), D("0.01"))).toThrow(
      expect.objectContaining({ code: "AMOUNT_EXCEEDS_DUE" }),
    );
  });

  it("always splits the amount exactly and respects the order (random cases)", () => {
    let seed = 99;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const money = (satang: number) => D((satang / 100).toFixed(2));
    for (let i = 0; i < 2000; i++) {
      const o: Owed = { lateFee: money(next(500_000)), interest: money(next(2_000_000)), principal: money(1 + next(10_000_000)) };
      const total = totalOwed(o);
      const amount = money(1 + next(Math.round(total.mul(100).toNumber())));
      const a = allocatePayment(o, amount);
      expect(a.lateFee.plus(a.interest).plus(a.principal).equals(amount)).toBe(true);
      expect(a.lateFee.lte(o.lateFee) && a.interest.lte(o.interest) && a.principal.lte(o.principal)).toBe(true);
      if (a.interest.gt(0)) expect(a.lateFee.equals(o.lateFee)).toBe(true);
      if (a.principal.gt(0)) expect(a.interest.equals(o.interest) && a.lateFee.equals(o.lateFee)).toBe(true);
    }
  });
});
