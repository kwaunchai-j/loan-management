import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { lateFeeForDay, MAX_AMOUNT, simulateContract, type SimInput, type SimPayment } from "../src/lib/late-fee.js";

const D = (v: string) => new Prisma.Decimal(v);
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
let counter = 0;
const pay = (amount: string, paidOn: string, id?: string): SimPayment => {
  const n = ++counter; // creation order = createdAt order, whether or not an id is given
  return { id: id ?? `p${n}`, amount: D(amount), paidOn: date(paidOn), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)) };
};

// principal 1,000 + interest 100, due 1 Oct, late fee 1 % per day, paid out 1 Sep
const base = (over: Partial<SimInput> = {}): SimInput => ({
  principal: D("1000"),
  interestAmount: D("100"),
  dueDate: date("2026-10-01"),
  disbursedOn: date("2026-09-01"),
  lateFeeRatePctPerDay: D("1"),
  payments: [],
  today: date("2026-10-01"),
  ...over,
});

function run(input: SimInput) {
  const r = simulateContract(input);
  if (!r.ok) throw new Error(`unexpected violation ${JSON.stringify(r.violation)}`);
  return r;
}
const owedNow = (r: ReturnType<typeof run>) =>
  [r.outstandingPrincipal, r.outstandingInterest, r.accruedLateFee].map((v) => v.toFixed(2));

describe("lateFeeForDay", () => {
  it("is rate % of the base, rounded UP to a whole baht (never down, never to nearest)", () => {
    expect(lateFeeForDay(D("1100"), D("1")).toFixed(2)).toBe("11.00"); // exactly 11: not bumped
    expect(lateFeeForDay(D("100"), D("1")).toFixed(2)).toBe("1.00"); // exactly 1
    expect(lateFeeForDay(D("1122.11"), D("1")).toFixed(2)).toBe("12.00"); // 11.2211 -> 12 (nearest would be 11)
    expect(lateFeeForDay(D("822.11"), D("1")).toFixed(2)).toBe("9.00"); // 8.2211 -> 9
    expect(lateFeeForDay(D("50"), D("1")).toFixed(2)).toBe("1.00"); // 0.5 -> 1
    expect(lateFeeForDay(D("0.01"), D("1")).toFixed(2)).toBe("1.00"); // 0.0001 still costs a whole baht
    expect(lateFeeForDay(D("100"), D("0")).toFixed(2)).toBe("0.00");
    for (const base of ["1", "33.33", "999.99", "123456.78"]) expect(lateFeeForDay(D(base), D("1.5")).isInteger()).toBe(true);
  });
});

describe("simulateContract: fees (DES-012)", () => {
  it("charges nothing up to and including the due date", () => {
    for (const today of ["2026-09-15", "2026-10-01"]) {
      const r = run(base({ today: date(today) }));
      expect(r.accruals).toHaveLength(0);
      expect(owedNow(r)).toEqual(["1000.00", "100.00", "0.00"]);
      expect(r.status).toBe("ACTIVE");
    }
  });

  it("starts the day after the due date and compounds on principal + interest + earlier fees", () => {
    const r = run(base({ today: date("2026-10-04") }));
    expect(r.accruals.map((a) => [a.accrualDate.toISOString().slice(0, 10), a.baseAmount.toFixed(2), a.amount.toFixed(2)])).toEqual([
      ["2026-10-02", "1100.00", "11.00"],
      ["2026-10-03", "1111.00", "12.00"], // 11.11 -> 12
      ["2026-10-04", "1123.00", "12.00"], // 11.23 -> 12
    ]);
    expect(owedNow(r)).toEqual(["1000.00", "100.00", "35.00"]);
    expect(r.accruals.every((a) => a.ratePctPerDay.equals(1))).toBe(true);
  });

  it("charges a row for every day even when the rate is 0", () => {
    const r = run(base({ lateFeeRatePctPerDay: D("0"), today: date("2026-10-03") }));
    expect(r.accruals.map((a) => a.amount.toFixed(2))).toEqual(["0.00", "0.00"]);
    expect(owedNow(r)).toEqual(["1000.00", "100.00", "0.00"]);
  });
});

describe("simulateContract: payments (DES-011, DES-012)", () => {
  it("a part payment lowers the base from the next day on, never the interest", () => {
    // pays 300 on 3 Oct: owed then = 1,100 + 11 + 12 = 1,123 -> fee 23, interest 100, principal 177
    const p = pay("300", "2026-10-03", "a");
    const r = run(base({ today: date("2026-10-04"), payments: [p] }));
    const a = r.allocations.get("a")!;
    expect([a.lateFee, a.interest, a.principal].map((v) => v.toFixed(2))).toEqual(["23.00", "100.00", "177.00"]);
    // 4 Oct fee is on 823 (not 1,123): 8.23 -> 9
    expect(r.accruals[2]!.baseAmount.toFixed(2)).toBe("823.00");
    expect(r.accruals[2]!.amount.toFixed(2)).toBe("9.00");
    expect(owedNow(r)).toEqual(["823.00", "0.00", "9.00"]);
    expect(r.status).toBe("ACTIVE");
  });

  it("a part payment before the due date lowers the base the first fee is charged on", () => {
    const p = pay("500", "2026-09-20", "a");
    const r = run(base({ today: date("2026-10-02"), payments: [p] }));
    const a = r.allocations.get("a")!;
    expect([a.lateFee, a.interest, a.principal].map((v) => v.toFixed(2))).toEqual(["0.00", "100.00", "400.00"]);
    expect(r.accruals[0]!.baseAmount.toFixed(2)).toBe("600.00");
    expect(r.accruals[0]!.amount.toFixed(2)).toBe("6.00");
  });

  it("paying everything on the due date closes the contract with no fee at all", () => {
    const r = run(base({ today: date("2026-10-10"), payments: [pay("1100", "2026-10-01")] }));
    expect(r.status).toBe("CLOSED");
    expect(r.closedOn!.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(r.accruals).toHaveLength(0);
    expect(owedNow(r)).toEqual(["0.00", "0.00", "0.00"]);
  });

  it("the fee of the day the contract is paid off is still charged, then fees stop", () => {
    // owed on 3 Oct = 1,100 + 11 + 12 = 1,123
    const r = run(base({ today: date("2026-10-10"), payments: [pay("1123", "2026-10-03")] }));
    expect(r.status).toBe("CLOSED");
    expect(r.closedOn!.toISOString().slice(0, 10)).toBe("2026-10-03");
    expect(r.accruals.map((a) => a.accrualDate.toISOString().slice(0, 10))).toEqual(["2026-10-02", "2026-10-03"]);
    expect(owedNow(r)).toEqual(["0.00", "0.00", "0.00"]);
  });

  it("refuses a payment above what is owed on its day", () => {
    for (const [amount, day, due] of [
      ["1100.01", "2026-10-01", "1100.00"],
      ["1123.01", "2026-10-03", "1123.00"],
    ] as const) {
      const r = simulateContract(base({ today: date("2026-10-05"), payments: [pay(amount, day, "x")] }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.violation).toMatchObject({ code: "AMOUNT_EXCEEDS_DUE", paymentId: "x" });
        expect((r.violation as { due: Prisma.Decimal }).due.toFixed(2)).toBe(due);
      }
    }
  });

  it("refuses anything paid after the contract is already settled, including later the same day", () => {
    const settled = pay("1123", "2026-10-03", "full");
    const sameDay = pay("0.01", "2026-10-03", "extra");
    const later = pay("5", "2026-10-05", "later");
    for (const extra of [sameDay, later]) {
      const r = simulateContract(base({ today: date("2026-10-06"), payments: [settled, extra] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.violation).toMatchObject({ code: "AMOUNT_EXCEEDS_DUE", paymentId: extra.id });
    }
  });

  it("applies payments in paidOn then createdAt order regardless of the order given", () => {
    const first = pay("30", "2026-10-03", "first"); // created first, same day
    const second = pay("100", "2026-10-03", "second");
    const early = pay("200", "2026-10-02", "early");
    const r = run(base({ today: date("2026-10-03"), payments: [second, early, first] }));
    // 2 Oct: fee 11.00, owed 1,111 -> pays 200: fee 11, interest 100, principal 89
    expect(r.allocations.get("early")!.principal.toFixed(2)).toBe("89.00");
    // 3 Oct: base 911, fee 9.11 -> 10 -> owed 921 (principal 911 + fee 10). "first" pays 30 -> fee 10, principal 20
    const a = r.allocations.get("first")!;
    expect([a.lateFee, a.interest, a.principal].map((v) => v.toFixed(2))).toEqual(["10.00", "0.00", "20.00"]);
    expect(r.allocations.get("second")!.principal.toFixed(2)).toBe("100.00");
  });

  it("rejects non-positive amounts, future dates and dates before the payout", () => {
    const cases: Array<[SimPayment, string]> = [
      [pay("0", "2026-10-01", "z"), "NON_POSITIVE_AMOUNT"],
      [pay("-5", "2026-10-01", "n"), "NON_POSITIVE_AMOUNT"],
      [pay("10", "2026-10-02", "f"), "PAID_ON_FUTURE"],
      [pay("10", "2026-08-31", "b"), "PAID_BEFORE_DISBURSEMENT"],
    ];
    for (const [p, code] of cases) {
      const r = simulateContract(base({ today: date("2026-10-01"), payments: [p] }));
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.violation).toMatchObject({ code, paymentId: p.id });
    }
  });

  it("has no lower date bound for imported contracts (no payout date)", () => {
    const r = run(base({ disbursedOn: null, payments: [pay("10", "2020-01-01")] }));
    // 10 goes to the interest first: interest 90, principal untouched
    expect(owedNow(r)).toEqual(["1000.00", "90.00", "0.00"]);
  });

  it("stops with LIMIT_EXCEEDED instead of overflowing the column", () => {
    const r = simulateContract(
      base({ principal: MAX_AMOUNT, interestAmount: D("100"), today: date("2026-10-05") }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violation.code).toBe("LIMIT_EXCEEDED");
  });
});

// An independent implementation in integer satang, to check the simulator on thousands of cases.
describe("simulateContract agrees with an independent integer oracle (random cases)", () => {
  const DAY = 86_400_000;
  let seed = 424242;
  const next = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const money = (s: bigint) => D(`${s / 100n}.${(s % 100n).toString().padStart(2, "0")}`);

  it("matches final balances, status, fees per day and every allocation", () => {
    const seen = { compared: 0, closed: 0, withFees: 0, withPayments: 0, refused: 0 };
    for (let n = 0; n < 1500; n++) {
      const principal = BigInt(10_000 + next(50_000_000));
      const interest = BigInt(next(Number(principal)));
      const rateUnits = BigInt(next(150_000)); // 0.0000 .. 14.9999 % per day
      const due = Date.UTC(2026, 5, 1) + next(60) * DAY;
      const today = due + next(90) * DAY - next(20) * DAY;
      const disbursed = due - (1 + next(60)) * DAY;
      const payments: SimPayment[] = [];
      const count = next(5);
      for (let k = 0; k < count; k++) {
        // now and then settle everything on or before the due date (no fee yet), so closed contracts are covered
        const settle = k === 0 && next(6) === 0;
        const day = settle
          ? disbursed + next(Math.floor((Math.min(due, today) - disbursed) / DAY) + 1) * DAY
          : disbursed + next(Math.max(1, Math.floor((today - disbursed) / DAY) + 1)) * DAY;
        payments.push({
          id: `p${k}`,
          amount: settle ? money(principal + interest) : money(BigInt(1 + next(Number(principal / 3n) + 1))),
          paidOn: new Date(day),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, k)),
        });
      }
      const input: SimInput = {
        principal: money(principal),
        interestAmount: money(interest),
        dueDate: new Date(due),
        disbursedOn: new Date(disbursed),
        lateFeeRatePctPerDay: D(`${rateUnits / 10_000n}.${(rateUnits % 10_000n).toString().padStart(4, "0")}`),
        payments,
        today: new Date(today),
      };

      // ---- oracle ----
      const sorted = [...payments].sort((a, b) => a.paidOn.getTime() - b.paidOn.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
      const cents = (d: Prisma.Decimal) => BigInt(d.mul(100).toFixed(0));
      let P = principal;
      let I = interest;
      let F = 0n;
      let closed: number | null = null;
      const fees: Array<[number, bigint]> = [];
      const alloc: Record<string, [bigint, bigint, bigint]> = {};
      let idx = 0;
      let bad: string | null = null;
      const applyUpTo = (day: number) => {
        while (!bad && idx < sorted.length && sorted[idx]!.paidOn.getTime() <= day) {
          const p = sorted[idx++]!;
          const amt = cents(p.amount);
          const total = P + I + F;
          if (p.paidOn.getTime() > today || p.paidOn.getTime() < disbursed) {
            bad = p.paidOn.getTime() > today ? "PAID_ON_FUTURE" : "PAID_BEFORE_DISBURSEMENT";
            return;
          }
          if (amt > total) {
            bad = `EXCEEDS:${p.id}`;
            return;
          }
          const f = amt < F ? amt : F;
          const i = amt - f < I ? amt - f : I;
          const pr = amt - f - i;
          alloc[p.id] = [f, i, pr];
          F -= f;
          I -= i;
          P -= pr;
          if (P + I + F === 0n && closed === null) closed = p.paidOn.getTime();
        }
      };
      // basic date checks run before any replay in the real function, so mirror that order
      const early = sorted.find((p) => p.paidOn.getTime() > today || p.paidOn.getTime() < disbursed);
      applyUpTo(due);
      for (let day = due + DAY; !bad && closed === null && day <= today; day += DAY) {
        const base = P + I + F;
        // base is in satang: base × rate% in satang is base × units / 1e6; the fee is that rounded UP to a whole baht
        const fee = ceilDiv(base * rateUnits, 1_000_000n * 100n) * 100n;
        F += fee;
        fees.push([day, fee]);
        applyUpTo(day);
      }
      if (!bad) applyUpTo(today);

      const actual = simulateContract(input);
      if (early) {
        expect(actual.ok, `case ${n}`).toBe(false);
        seen.refused++;
        continue;
      }
      if (bad) {
        seen.refused++;
        expect(actual.ok, `case ${n}`).toBe(false);
        if (!actual.ok && String(bad).startsWith("EXCEEDS:")) {
          expect(actual.violation, `case ${n}`).toMatchObject({ code: "AMOUNT_EXCEEDS_DUE", paymentId: String(bad).slice(8) });
        }
        continue;
      }
      expect(actual.ok, `case ${n}`).toBe(true);
      if (!actual.ok) continue;
      seen.compared++;
      if (closed !== null) seen.closed++;
      if (fees.length > 0) seen.withFees++;
      if (Object.keys(alloc).length > 0) seen.withPayments++;
      expect([cents(actual.outstandingPrincipal), cents(actual.outstandingInterest), cents(actual.accruedLateFee)], `case ${n}`).toEqual([P, I, F]);
      expect(actual.status, `case ${n}`).toBe(closed === null ? "ACTIVE" : "CLOSED");
      expect(actual.closedOn?.getTime() ?? null, `case ${n}`).toBe(closed);
      expect(actual.accruals.map((a) => [a.accrualDate.getTime(), cents(a.amount)]), `case ${n}`).toEqual(fees);
      for (const [id, [f, i, pr]] of Object.entries(alloc)) {
        const a = actual.allocations.get(id)!;
        expect([cents(a.lateFee), cents(a.interest), cents(a.principal)], `case ${n} ${id}`).toEqual([f, i, pr]);
      }
    }
    // the comparison must cover real situations, not only refused inputs
    expect(seen.compared).toBeGreaterThan(900);
    expect(seen.withFees).toBeGreaterThan(500);
    expect(seen.withPayments).toBeGreaterThan(500);
    expect(seen.closed).toBeGreaterThan(20);
    expect(seen.refused).toBeGreaterThan(20);
  });
});
