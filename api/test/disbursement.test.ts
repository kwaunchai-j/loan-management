import "dotenv/config";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t204${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

const day = (n: number) => {
  const d = bangkokToday();
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateOnly(d);
};

describe.skipIf(!dbUp)("disbursement (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  let borrowerId: string;
  // The Setting row is global; keep what a developer had and put it back.
  let originalSetting: Awaited<ReturnType<typeof prisma.setting.findUnique>>;

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { cookie: cookies[as]! } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const setRates = (interest: string | null, lateFee: string | null) =>
    prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, interestRatePctPerMonth: interest, lateFeeRatePctPerDay: lateFee },
      update: { interestRatePctPerMonth: interest, lateFeeRatePctPerDay: lateFee },
    });

  async function slip(): Promise<string> {
    const res = await fetch(`${baseUrl}/admin/slips`, {
      method: "POST",
      headers: { cookie: cookies.admin!, "content-type": "image/jpeg" },
      body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(50)]),
    });
    expect(res.status).toBe(201);
    return (await res.json()).slipFileKey;
  }

  /** An approved contract waiting for its money; returns its id. */
  async function awaitingContract(amount: string, dueInDays: number): Promise<string> {
    const created = await call("admin", "POST", "/admin/loan-requests", {
      borrowerId,
      amount,
      requestedDueDate: day(dueInDays),
    });
    const approved = await call("admin", "POST", `/admin/loan-requests/${(await created.json()).id}/approve`);
    return (await approved.json()).contract.id as string;
  }

  const disburse = async (contractId: string, over: Record<string, unknown> = {}, as: string | null = "admin") =>
    call(as, "POST", `/admin/contracts/${contractId}/disbursement`, {
      paidOn: day(0),
      slipFileKey: await slip(),
      ...over,
    });

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await setRates("3", "0.5");

    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"]] as const) {
      userIds.push((await prisma.user.create({ data: { username: name(u), role, ...base } })).id);
    }
    borrowerId = (
      await prisma.borrower.create({ data: { userId: userIds[1]!, fullName: `${marker} b`, pdpaAcceptedAt: new Date() } })
    ).id;

    server = buildApp({
      prisma,
      sessionSecret: SECRET,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
    }).app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const u of ["admin", "borrower"]) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name(u), password: PASSWORD }),
      });
      cookies[u] = cookieOf(res);
    }
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const contracts = (await prisma.contract.findMany({ where: { borrowerId }, select: { id: true } })).map((c) => c.id);
    await prisma.disbursement.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.loanRequest.deleteMany({ where: { borrowerId } });
    await prisma.borrower.deleteMany({ where: { id: borrowerId } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (originalSetting) {
      await prisma.setting.create({
        data: {
          id: 1,
          interestRatePctPerMonth: originalSetting.interestRatePctPerMonth,
          lateFeeRatePctPerDay: originalSetting.lateFeeRatePctPerDay,
          updatedById: originalSetting.updatedById,
        },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("pays out in full, computes the interest and makes the contract ACTIVE", async () => {
    // 10,000 at 3 %/month from today to day +30 = 30 days -> 10,000 × 3/100 × 30/30 = 300.00
    const id = await awaitingContract("10000", 30);
    const key = await slip();
    const res = await call("admin", "POST", `/admin/contracts/${id}/disbursement`, {
      paidOn: day(0),
      slipFileKey: key,
      note: "โอนผ่านแอป",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contract).toMatchObject({
      status: "ACTIVE",
      principal: "10000",
      disbursedOn: day(0),
      interestRatePctPerMonth: "3",
      lateFeeRatePctPerDay: "0.5",
      interestAmount: "300",
      outstandingPrincipal: "10000",
      outstandingInterest: "300",
      accruedLateFee: "0",
      totalDue: "10300",
    });
    expect(body.disbursement).toMatchObject({ amount: "10000", paidOn: day(0), note: "โอนผ่านแอป", slipFileKey: key });

    const c = await prisma.contract.findUniqueOrThrow({ where: { id }, include: { disbursement: true } });
    expect(c.status).toBe("ACTIVE");
    expect(c.disbursement!.recordedById).toBe(userIds[0]);
    expect(c.disbursement!.amount.toString()).toBe("10000");
  });

  it("rounds interest UP to a whole baht, never down or to nearest", async () => {
    // 1,000.01 × 3/100 × 7/30 = 7.00007 -> 8: a whole baht, and UP (nearest would give 7)
    const id = await awaitingContract("1000.01", 7);
    const res = await disburse(id);
    expect((await res.json()).contract.interestAmount).toBe("8");
    // 1,000 × 3/100 × 7/30 = 7 exactly: already a whole baht, so nothing is added
    const exact = await awaitingContract("1000", 7);
    expect((await (await disburse(exact)).json()).contract.interestAmount).toBe("7");
  });

  it("counts days from the payout date, so a backdated payout earns more interest", async () => {
    // paid 5 days ago, due in 25 days: 30 days
    const id = await awaitingContract("3000", 25);
    const res = await disburse(id, { paidOn: day(-5) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contract.disbursedOn).toBe(day(-5));
    expect(body.contract.interestAmount).toBe("90"); // 3,000 × 3% × 30/30
  });

  it("snapshots the rates: changing them later never touches an existing contract", async () => {
    const id = await awaitingContract("2000", 30);
    expect((await disburse(id)).status).toBe(201);
    await setRates("9", "2");
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    expect(c.interestRatePctPerMonth!.toString()).toBe("3");
    expect(c.lateFeeRatePctPerDay!.toString()).toBe("0.5");
    expect(c.interestAmount!.toString()).toBe("60");
    // a contract paid out after the change uses the new rates
    const id2 = await awaitingContract("2000", 30);
    expect((await (await disburse(id2)).json()).contract).toMatchObject({ interestRatePctPerMonth: "9", interestAmount: "180" });
    await setRates("3", "0.5");
  });

  it("refuses to pay out while either rate is not set", async () => {
    const id = await awaitingContract("1000", 10);
    for (const [i, l] of [[null, null], ["3", null], [null, "0.5"]] as const) {
      await setRates(i, l);
      const res = await disburse(id);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("RATES_NOT_SET");
    }
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe("AWAITING_DISBURSEMENT");
    expect(await prisma.disbursement.count({ where: { contractId: id } })).toBe(0);
    await setRates("3", "0.5");
    expect((await disburse(id)).status).toBe(201);
  });

  it("requires a slip that we stored", async () => {
    const id = await awaitingContract("1000", 10);
    const noSlip = await call("admin", "POST", `/admin/contracts/${id}/disbursement`, { paidOn: day(0) });
    expect(noSlip.status).toBe(400);
    for (const bad of ["made-up-key", "../../etc/passwd", `${"a".repeat(32)}.jpg`, ""]) {
      const res = await call("admin", "POST", `/admin/contracts/${id}/disbursement`, { paidOn: day(0), slipFileKey: bad });
      expect(res.status, bad).toBe(400);
    }
    const missingFile = await call("admin", "POST", `/admin/contracts/${id}/disbursement`, {
      paidOn: day(0),
      slipFileKey: `${"a".repeat(32)}.jpg`,
    });
    expect((await missingFile.json()).error.code).toBe("SLIP_NOT_FOUND");
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe("AWAITING_DISBURSEMENT");
  });

  it("does not let one slip justify two payouts", async () => {
    const a = await awaitingContract("1000", 10);
    const b = await awaitingContract("1000", 10);
    const key = await slip();
    expect((await call("admin", "POST", `/admin/contracts/${a}/disbursement`, { paidOn: day(0), slipFileKey: key })).status).toBe(201);
    const reused = await call("admin", "POST", `/admin/contracts/${b}/disbursement`, { paidOn: day(0), slipFileKey: key });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe("SLIP_ALREADY_USED");
  });

  it("pays out exactly what was asked: an amount that differs is refused, a matching one is fine", async () => {
    const id = await awaitingContract("5000", 10);
    const bad = await disburse(id, { amount: "4999.99" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("AMOUNT_MISMATCH");
    expect((await disburse(id, { amount: "5000.00" })).status).toBe(201);
  });

  it("rejects a payout date in the future and a due date that is not after the payout date", async () => {
    const id = await awaitingContract("1000", 10);
    const future = await disburse(id, { paidOn: day(1) });
    expect(future.status).toBe(400);
    expect((await future.json()).error.code).toBe("PAID_ON_FUTURE");

    // due in 10 days but paid out ON the due date or after it: days < 1
    for (const paidOn of [day(10), day(10 + 1)]) {
      const res = await disburse(id, { paidOn });
      expect(res.status, paidOn).toBe(400);
    }
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe("AWAITING_DISBURSEMENT");
  });

  it("allows only one payout per contract, even when two arrive at the same moment", async () => {
    const id = await awaitingContract("1000", 10);
    // Open the database connections up front: creating 8 at once through Docker Desktop can exceed
    // Prisma's 2 s transaction start limit, which would test the machine rather than the rule.
    await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`select pg_sleep(0.2)::text`));
    const keys = await Promise.all(Array.from({ length: 8 }, () => slip()));
    const results = await Promise.all(
      keys.map((slipFileKey) =>
        call("admin", "POST", `/admin/contracts/${id}/disbursement`, { paidOn: day(0), slipFileKey }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    // exactly one wins; every other attempt is a clean 409 conflict, never a 500
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(await prisma.disbursement.count({ where: { contractId: id } })).toBe(1);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    expect(c.interestAmount!.toString()).toBe("10"); // 1,000 × 3% × 10/30, computed once
  });

  it("only works on contracts waiting for disbursement", async () => {
    const paid = await awaitingContract("1000", 10);
    await disburse(paid);
    expect((await disburse(paid)).status).toBe(409);

    const cancelled = await awaitingContract("1000", 10);
    await call("admin", "POST", `/admin/contracts/${cancelled}/cancel`);
    const res = await disburse(cancelled);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INVALID_STATE");

    expect((await disburse("nope")).status).toBe(404);
  });

  it("cannot cancel a contract once it has been paid out", async () => {
    const id = await awaitingContract("1000", 10);
    await disburse(id);
    expect((await call("admin", "POST", `/admin/contracts/${id}/cancel`)).status).toBe(409);
  });

  it("refuses a payout on or after the due date (the interest would have no days) and changes nothing", async () => {
    const contractId = await awaitingContract("1000", 5);
    // time has passed while the contract waited for its money: it is now due today
    await prisma.contract.update({ where: { id: contractId }, data: { dueDate: new Date(`${day(0)}T00:00:00.000Z`) } });
    const res = await disburse(contractId, { paidOn: day(0) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("DUE_DATE_TOO_SOON");
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, include: { disbursement: true } });
    expect(c.status).toBe("AWAITING_DISBURSEMENT");
    expect(c.disbursement).toBeNull();
    expect(c.interestAmount).toBeNull();
  });

  it("is ADMIN only", async () => {
    const id = await awaitingContract("1000", 10);
    expect((await disburse(id, {}, "borrower")).status).toBe(403);
    expect((await disburse(id, {}, null)).status).toBe(401);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe("AWAITING_DISBURSEMENT");
  });

  it("validates the body", async () => {
    const id = await awaitingContract("1000", 10);
    const key = await slip();
    for (const body of [
      { slipFileKey: key },
      { paidOn: "not-a-date", slipFileKey: key },
      { paidOn: day(0), slipFileKey: key, amount: "abc" },
      { paidOn: day(0), slipFileKey: key, note: "" },
    ]) {
      const res = await call("admin", "POST", `/admin/contracts/${id}/disbursement`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("writes an audit row with the interest, days and rates used", async () => {
    const id = await awaitingContract("10000", 30);
    await disburse(id);
    const [row] = await prisma.auditLog.findMany({ where: { entityType: "Contract", entityId: id, action: "disbursement.create" } });
    expect(row!.actorId).toBe(userIds[0]);
    expect(row!.detail).toMatchObject({
      before: { status: "AWAITING_DISBURSEMENT" },
      after: { status: "ACTIVE" },
      days: 30,
      interestAmount: "300",
      interestRatePctPerMonth: "3",
      lateFeeRatePctPerDay: "0.5",
    });
  });
});
