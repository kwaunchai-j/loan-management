import "dotenv/config";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { computeInterest } from "../src/lib/interest.js";
import { hashPassword } from "../src/lib/password.js";
import { estimateInterest } from "../src/loans/interest-estimate.js";
import { completeProfile, RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// the calculation, with no database: a stand-in that only knows how to read the Setting row, so any
// attempt to WRITE (or to read anything else) would throw
// ---------------------------------------------------------------------------------------------
function fakeDb(rate: string | null): Db {
  const row = { interestRatePctPerMonth: rate === null ? null : new Prisma.Decimal(rate), lateFeeRatePctPerDay: new Prisma.Decimal("1") };
  return new Proxy({ setting: { findUnique: async () => row } }, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      throw new Error(`the estimate must not touch db.${String(prop)}`);
    },
  }) as unknown as Db;
}

const NOW = new Date("2026-10-30T05:00:00Z"); // 12:00 on 2026-10-30 in Bangkok
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDaysTo = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

describe("estimateInterest: the figures", () => {
  it("without a due date it is for 30 days, and says the 30 days is an assumption", async () => {
    const r = await estimateInterest(fakeDb("3"), { amount: "1000" }, NOW);
    expect(r).toEqual({
      amount: "1000",
      payoutDate: "2026-10-30",
      dueDate: null,
      days: 30,
      daysAssumed: true,
      interestRatePctPerMonth: "3",
      interestAmount: "30",
      totalToRepay: "1030",
      isEstimate: true,
    });
  });

  it.each([
    // [amount, rate % per month, days, interest rounded UP to a whole baht]
    ["1000", "3", 7, "7"], // 7.00 exactly: stays 7
    ["1000.01", "3", 7, "8"], // 7.00023 -> 8, never down
    ["5000", "2.5", 45, "188"], // 187.5 -> 188
    ["1", "3", 1, "1"], // 0.001 -> 1 (a loan is never interest-free by rounding)
    ["100000", "0", 30, "0"], // a zero rate is a zero interest
  ])("%s at %s %% for %d days -> %s", async (amount, rate, days, expected) => {
    const due = formatDateOnly(addDaysTo(D("2026-10-30"), days));
    const r = await estimateInterest(fakeDb(rate), { amount, dueDate: D(due) }, NOW);
    expect(r.interestAmount).toBe(expected);
    expect(r.days).toBe(days);
    expect(r.daysAssumed).toBe(false);
    expect(r.dueDate).toBe(due);
    expect(new Prisma.Decimal(r.totalToRepay).equals(new Prisma.Decimal(amount).plus(r.interestAmount))).toBe(true);
  });

  it("an awkward rate and amount agree with an exact integer calculation", async () => {
    // ceil(25000050 cents × 33333 (3.3333 % in 1/10000) × 90 days / (100 × 10000 × 100 × 30))
    const n = 25000050n * 33333n * 90n;
    const d = 100n * 10000n * 100n * 30n;
    const r = await estimateInterest(fakeDb("3.3333"), { amount: "250000.50", dueDate: addDaysTo(D("2026-10-30"), 90) }, NOW);
    expect(r.interestAmount).toBe(String((n + d - 1n) / d));
  });

  it("is exactly what the real contract will compute for the same amount, rate and days (no drift)", async () => {
    for (let i = 0; i < 300; i++) {
      const cents = 100 + ((i * 7919) % 99_999_999);
      const amount = (cents / 100).toFixed(2);
      const rate = ["0.5", "1", "2.75", "3", "4.1234"][i % 5]!;
      const days = 1 + ((i * 37) % 400);
      const due = addDaysTo(D("2026-10-30"), days);
      const est = await estimateInterest(fakeDb(rate), { amount, dueDate: due }, NOW);
      const real = computeInterest({ principal: amount, ratePctPerMonth: rate, disbursedOn: D("2026-10-30"), dueDate: due });
      expect(est.interestAmount, `${amount} @ ${rate} x ${days}d`).toBe(real.interestAmount.toString());
      expect(est.days).toBe(real.days);
    }
  });

  it("the interest is always a whole number of baht, and never below the exact figure", async () => {
    for (let i = 0; i < 200; i++) {
      const amount = (((i + 1) * 12_347) / 100).toFixed(2);
      const days = 1 + (i % 120);
      const r = await estimateInterest(fakeDb("3"), { amount, dueDate: addDaysTo(D("2026-10-30"), days) }, NOW);
      const interest = new Prisma.Decimal(r.interestAmount);
      const exact = new Prisma.Decimal(amount).mul(3).mul(days).div(3000);
      expect(interest.mod(1).isZero()).toBe(true);
      expect(interest.gte(exact)).toBe(true);
      expect(interest.minus(exact).lt(1)).toBe(true);
    }
  });

  it("counts the days from today in Bangkok (just after midnight there it is already tomorrow)", async () => {
    const lateNightUtc = new Date("2026-10-30T17:30:00Z"); // 00:30 on the 31st in Bangkok
    const r = await estimateInterest(fakeDb("3"), { amount: "1000", dueDate: D("2026-11-30") }, lateNightUtc);
    expect(r.payoutDate).toBe("2026-10-31");
    expect(r.days).toBe(30);
  });
});

describe("estimateInterest: what it refuses", () => {
  it("a due date today, in the past, is refused; tomorrow is one day", async () => {
    for (const d of ["2026-10-30", "2026-10-29", "2020-01-01"]) {
      await expect(estimateInterest(fakeDb("3"), { amount: "1000", dueDate: D(d) }, NOW)).rejects.toMatchObject({ status: 400, code: "DUE_DATE_NOT_FUTURE" });
    }
    const r = await estimateInterest(fakeDb("3"), { amount: "1000", dueDate: D("2026-10-31") }, NOW);
    expect(r.days).toBe(1);
    expect(r.interestAmount).toBe("1"); // 1000 × 3% × 1/30 = 1.0 exactly
  });

  it("with no rate set yet, says so in words a borrower can act on (not the admin's 'go to settings')", async () => {
    const err = await estimateInterest(fakeDb(null), { amount: "1000" }, NOW).then(
      () => null,
      (e: unknown) => e as { status: number; code: string; message: string },
    );
    expect(err).toMatchObject({ status: 409, code: "RATES_NOT_SET" });
    expect(err!.message).toContain("ติดต่อผู้ให้กู้");
    expect(err!.message).not.toContain("ตั้งค่า");
  });

  it("an amount whose result would not fit the system's limit is refused, not rounded or cut", async () => {
    await expect(estimateInterest(fakeDb("3"), { amount: "999999999999.99", dueDate: D("2027-10-30") }, NOW)).rejects.toMatchObject({ status: 400, code: "LIMIT_EXCEEDED" });
    // just under the limit with a zero rate still fits
    const ok = await estimateInterest(fakeDb("0"), { amount: "999999999999.99" }, NOW);
    expect(ok.totalToRepay).toBe("999999999999.99");
  });
});

// ---------------------------------------------------------------------------------------------
const prisma = new PrismaClient();
const dbUp = await prisma.$queryRaw`select 1`.then(() => true).catch(() => false);

describe.skipIf(!dbUp)("GET /loan-requests/interest-estimate (PostgreSQL)", () => {
  const marker = `est${Date.now()}`;
  const PASSWORD = "first-password-1";
  let server: Server;
  let base: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const borrowerIds: string[] = [];
  let originalSetting: Awaited<ReturnType<typeof prisma.setting.findUnique>>;

  const setRates = (interest: string | null) =>
    prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, interestRatePctPerMonth: interest, lateFeeRatePctPerDay: "0.5" },
      update: { interestRatePctPerMonth: interest, lateFeeRatePctPerDay: "0.5" },
    });
  const get = (as: string | null, query: string) =>
    fetch(`${base}/loan-requests/interest-estimate${query}`, { headers: as ? { cookie: cookies[as]! } : {} });
  const day = (n: number) => formatDateOnly(addDaysTo(bangkokToday(), n));

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await setRates("3");
    const passwordHash = await hashPassword(PASSWORD);
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"], ["nopdpa", "BORROWER"]] as const) {
      const user = await prisma.user.create({ data: { username: `${marker}-${u}`, role, passwordHash, mustChangePassword: false } });
      userIds.push(user.id);
      if (role === "BORROWER") {
        const b = await prisma.borrower.create({ data: { userId: user.id, fullName: `${marker} ${u}`, ...completeProfile(), pdpaAcceptedAt: u === "nopdpa" ? null : new Date() } });
        borrowerIds.push(b.id);
      }
    }
    server = buildApp({
      prisma,
      sessionSecret: "test-secret-".padEnd(48, "s"),
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
    }).app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const u of ["admin", "borrower", "nopdpa"]) {
      const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: `${marker}-${u}`, password: PASSWORD }) });
      cookies[u] = res.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
    }
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowerIds } } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (originalSetting) {
      await prisma.setting.create({
        data: { id: 1, interestRatePctPerMonth: originalSetting.interestRatePctPerMonth, lateFeeRatePctPerDay: originalSetting.lateFeeRatePctPerDay, updatedById: originalSetting.updatedById },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("a borrower enters only an amount and gets the 30-day interest at the current rate", async () => {
    const res = await get("borrower", "?amount=10000");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      amount: "10000",
      days: 30,
      daysAssumed: true,
      dueDate: null,
      interestRatePctPerMonth: "3",
      interestAmount: "300",
      totalToRepay: "10300",
      isEstimate: true,
    });
  });

  it("with a due date it uses the days until then", async () => {
    const res = await get("borrower", `?amount=10000&dueDate=${day(15)}`);
    expect(await res.json()).toMatchObject({ days: 15, daysAssumed: false, dueDate: day(15), interestAmount: "150", totalToRepay: "10150" });
  });

  it("an empty due-date box counts as no due date (that is how the form sends it)", async () => {
    const res = await get("borrower", "?amount=10000&dueDate=");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ days: 30, daysAssumed: true });
  });

  it("follows the rate the lender sets: change it and the next answer changes (nothing is cached or hard-coded)", async () => {
    await setRates("5");
    try {
      expect((await (await get("borrower", "?amount=10000")).json()).interestAmount).toBe("500");
    } finally {
      await setRates("3");
    }
    expect((await (await get("borrower", "?amount=10000")).json()).interestAmount).toBe("300");
  });

  it("matches the interest the lender's real payout then records for the same amount and days", async () => {
    // a real request -> approval -> payout, and the estimate asked beforehand for the same amount and due date
    const est = await (await get("borrower", `?amount=7777.77&dueDate=${day(20)}`)).json();
    const createdReq = await fetch(`${base}/loan-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies.borrower! },
      body: JSON.stringify({ amount: "7777.77", requestedDueDate: day(20) }),
    });
    expect(createdReq.status).toBe(201);
    const reqId = (await createdReq.json()).id as string;
    const approved = await fetch(`${base}/admin/loan-requests/${reqId}/approve`, { method: "POST", headers: { cookie: cookies.admin! } });
    const contractId = (await approved.json()).contract.id as string;
    const slip = await fetch(`${base}/admin/slips`, { method: "POST", headers: { cookie: cookies.admin!, "content-type": "image/jpeg" }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]) });
    const slipFileKey = (await slip.json()).slipFileKey as string;
    const paid = await fetch(`${base}/admin/contracts/${contractId}/disbursement`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies.admin! },
      body: JSON.stringify({ paidOn: day(0), slipFileKey }),
    });
    expect(paid.status).toBe(201);
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(est.interestAmount).toBe(contract.interestAmount!.toString());
    // clean up this request's rows
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    await prisma.disbursement.deleteMany({ where: { contractId } });
    await prisma.contract.delete({ where: { id: c.id } });
    await prisma.loanRequest.deleteMany({ where: { id: reqId } });
  });

  it.each([
    ["no amount", ""],
    ["an empty amount", "?amount="],
    ["text", "?amount=abc"],
    ["zero", "?amount=0"],
    ["a negative amount", "?amount=-5"],
    ["three decimals", "?amount=10.123"],
    ["too many digits", "?amount=1234567890123"],
    ["a bad date", "?amount=1000&dueDate=2026-13-45"],
    ["a date in words", "?amount=1000&dueDate=tomorrow"],
  ])("refuses %s (400) and says what is wrong", async (_name, query) => {
    const res = await get("borrower", query);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a due date that is today or earlier", async () => {
    for (const d of [day(0), day(-3)]) {
      const res = await get("borrower", `?amount=1000&dueDate=${d}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("DUE_DATE_NOT_FUTURE");
    }
  });

  it("answers 409 in borrower words while the lender has not set the rate", async () => {
    await setRates(null);
    try {
      const res = await get("borrower", "?amount=1000");
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("RATES_NOT_SET");
      expect(body.error.message).toContain("ติดต่อผู้ให้กู้");
    } finally {
      await setRates("3");
    }
  });

  it("is for borrowers only: a visitor gets 401, an admin 403, a borrower who has not accepted the PDPA terms 403", async () => {
    expect((await get(null, "?amount=1000")).status).toBe(401);
    expect((await get("admin", "?amount=1000")).status).toBe(403);
    const noPdpa = await get("nopdpa", "?amount=1000");
    expect(noPdpa.status).toBe(403);
    expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
  });

  it("saves nothing and logs nothing: no request, no contract, no audit row", async () => {
    const counts = async () => [await prisma.loanRequest.count(), await prisma.contract.count(), await prisma.auditLog.count({ where: { actorId: { in: userIds } } })];
    const before = await counts();
    for (let i = 0; i < 5; i++) await get("borrower", `?amount=${1000 + i}&dueDate=${day(10 + i)}`);
    expect(await counts()).toEqual(before);
  });

  it("does not let a borrower pass another borrower's id to learn anything: it ignores extra parameters", async () => {
    const res = await get("borrower", `?amount=1000&borrowerId=${borrowerIds[1]}`);
    expect(res.status).toBe(200);
  });
});
