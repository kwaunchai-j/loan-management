import "dotenv/config";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { simulateContract } from "../src/lib/late-fee.js";
import { hashPassword } from "../src/lib/password.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t3l${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));

describe.skipIf(!dbUp)("payments, late fees, edits, deletes and queries (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  let borrowerId: string;
  let seq = 0;
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

  /** An ACTIVE contract written straight to the database, as if the nightly job had not run yet. */
  async function makeActive(o: { principal?: string; interest?: string; dueIn?: number; disbursedAgo?: number; rate?: string } = {}) {
    const { principal = "1000", interest = "100", dueIn = 10, disbursedAgo = 40, rate = "1" } = o;
    return prisma.contract.create({
      data: {
        contractNo: `T-${marker}-${++seq}`,
        borrowerId,
        principal,
        dueDate: addDays(today, dueIn),
        status: "ACTIVE",
        disbursedOn: addDays(today, -disbursedAgo),
        interestRatePctPerMonth: "3",
        lateFeeRatePctPerDay: rate,
        interestAmount: interest,
        outstandingPrincipal: principal,
        outstandingInterest: interest,
      },
    });
  }

  const pay = (contractId: string, amount: string | number, paidOn = day(0), extra: object = {}, as: string | null = "admin") =>
    call(as, "POST", `/admin/contracts/${contractId}/payments`, { amount, paidOn, ...extra });

  const ledger = async (contractId: string) => {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, include: { lateFeeAccruals: { orderBy: { accrualDate: "asc" } }, payments: true } });
    return {
      c,
      state: [c.outstandingPrincipal, c.outstandingInterest, c.accruedLateFee].map((v) => v.toFixed(2)),
      fees: c.lateFeeAccruals.map((a) => [formatDateOnly(a.accrualDate), a.baseAmount.toFixed(2), a.amount.toFixed(2)]),
    };
  };

  /** The stored numbers must equal a fresh replay of the contract's history. */
  async function expectConsistent(contractId: string) {
    const { c } = await ledger(contractId);
    const sim = simulateContract({
      principal: c.principal,
      interestAmount: c.interestAmount!,
      dueDate: c.dueDate,
      disbursedOn: c.disbursedOn,
      lateFeeRatePctPerDay: c.lateFeeRatePctPerDay!,
      payments: c.payments.map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paidOn, createdAt: p.createdAt })),
      today,
    });
    expect(sim.ok).toBe(true);
    if (!sim.ok) return;
    expect(c.outstandingPrincipal.equals(sim.outstandingPrincipal)).toBe(true);
    expect(c.outstandingInterest.equals(sim.outstandingInterest)).toBe(true);
    expect(c.accruedLateFee.equals(sim.accruedLateFee)).toBe(true);
    expect(c.status).toBe(sim.status);
    expect(c.closedOn?.getTime() ?? null).toBe(sim.closedOn?.getTime() ?? null);
    expect(c.lateFeeAccruals.map((a) => [a.accrualDate.getTime(), a.baseAmount.toFixed(2), a.amount.toFixed(2)])).toEqual(
      sim.accruals.map((a) => [a.accrualDate.getTime(), a.baseAmount.toFixed(2), a.amount.toFixed(2)]),
    );
    for (const p of c.payments) {
      const a = sim.allocations.get(p.id)!;
      expect([p.allocatedLateFee, p.allocatedInterest, p.allocatedPrincipal].map((v) => v.toFixed(2))).toEqual(
        [a.lateFee, a.interest, a.principal].map((v) => v.toFixed(2)),
      );
    }
  }

  const auditOf = (entityType: string, entityId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityType, entityId, action } });

  // ---- helpers for the real approve -> disburse flow (used by the payout edit/delete tests) ----
  async function slip(): Promise<string> {
    const res = await fetch(`${baseUrl}/admin/slips`, {
      method: "POST",
      headers: { cookie: cookies.admin!, "content-type": "image/jpeg" },
      body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(40)]),
    });
    return (await res.json()).slipFileKey;
  }
  async function disbursed(amount = "3000", dueIn = 30, paidAgo = 0) {
    const created = await call("admin", "POST", "/admin/loan-requests", { borrowerId, amount, requestedDueDate: day(dueIn) });
    const approved = await call("admin", "POST", `/admin/loan-requests/${(await created.json()).id}/approve`);
    const contractId = (await approved.json()).contract.id as string;
    const res = await call("admin", "POST", `/admin/contracts/${contractId}/disbursement`, { paidOn: day(-paidAgo), slipFileKey: await slip() });
    expect(res.status).toBe(201);
    const body = await res.json();
    return { contractId, disbursementId: body.disbursement.id as string };
  }

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" },
      update: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" },
    });
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"]] as const) {
      userIds.push((await prisma.user.create({ data: { username: name(u), role, ...base } })).id);
    }
    borrowerId = (await prisma.borrower.create({ data: { userId: userIds[1]!, fullName: `${marker} Somchai`, pdpaAcceptedAt: new Date() } })).id;

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
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.lateFeeAccrual.deleteMany({ where: { contractId: { in: contracts } } });
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

  // =====================================================================================
  describe("recording a payment (T-303)", () => {
    it("takes a part payment before the due date: interest first, the interest never shrinks", async () => {
      const c = await makeActive(); // owed 1,000 + 100, due in 10 days
      const res = await pay(c.id, "100");
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.payment).toMatchObject({ amount: "100", allocatedLateFee: "0", allocatedInterest: "100", allocatedPrincipal: "0" });
      expect(body.contract).toMatchObject({ status: "ACTIVE", outstandingPrincipal: "1000", outstandingInterest: "0", totalDue: "1000" });
      const next = await (await pay(c.id, "1000")).json();
      expect(next.contract).toMatchObject({ status: "CLOSED", totalDue: "0", closedOn: day(0) });
      await expectConsistent(c.id);
    });

    it("pays off a contract on its due date with no late fee at all", async () => {
      const c = await makeActive({ dueIn: 0 });
      const res = await pay(c.id, "1100");
      expect(res.status).toBe(201);
      expect((await res.json()).contract).toMatchObject({ status: "CLOSED", closedOn: day(0) });
      expect((await ledger(c.id)).fees).toEqual([]);
    });

    it("catches up the days the nightly job has not run: 1 % a day compounding, rounded up", async () => {
      const c = await makeActive({ dueIn: -3 }); // due 3 days ago, nothing accrued yet in the database
      expect((await ledger(c.id)).state).toEqual(["1000.00", "100.00", "0.00"]);
      const res = await pay(c.id, "300");
      expect(res.status).toBe(201);
      // fees: 1,100 -> 11 ; 1,111 -> 11.11 -> 12 ; 1,123 -> 11.23 -> 12 ; owed 1,135
      const l = await ledger(c.id);
      expect(l.fees).toEqual([
        [day(-2), "1100.00", "11.00"],
        [day(-1), "1111.00", "12.00"],
        [day(0), "1123.00", "12.00"],
      ]);
      // 300 -> late fee 35, interest 100, principal 165
      const p = (await res.json()).payment;
      expect([p.allocatedLateFee, p.allocatedInterest, p.allocatedPrincipal]).toEqual(["35", "100", "165"]);
      expect(l.state).toEqual(["835.00", "0.00", "0.00"]);
      await expectConsistent(c.id);
    });

    it("a payment dated earlier lowers the base of every later day (back-dated, 'owed now')", async () => {
      const c = await makeActive({ dueIn: -3 });
      const res = await pay(c.id, "300", day(-1)); // recorded today, dated yesterday
      expect(res.status).toBe(201);
      // day -2: 1,100 -> 11 ; day -1: 1,111 -> 12 (owed 1,123) pays 300 -> fee 23, int 100, princ 177
      // day 0: base 823 -> 8.23 -> 9
      const l = await ledger(c.id);
      expect(l.fees).toEqual([
        [day(-2), "1100.00", "11.00"],
        [day(-1), "1111.00", "12.00"],
        [day(0), "823.00", "9.00"],
      ]);
      expect(l.state).toEqual(["823.00", "0.00", "9.00"]);
      const p = (await res.json()).payment;
      expect([p.allocatedLateFee, p.allocatedInterest, p.allocatedPrincipal]).toEqual(["23", "100", "177"]);
      await expectConsistent(c.id);
    });

    it("removes the fee rows of days that no longer apply when a back-dated payment closes the contract earlier", async () => {
      const c = await makeActive({ dueIn: -4 });
      // 1 paid on the due date: recording it also writes the fee rows for the 4 late days
      expect((await pay(c.id, "1", day(-4))).status).toBe(201);
      expect((await ledger(c.id)).fees).toHaveLength(4);
      // owed on day -2: principal 1,000 + interest 99 + fees 11 (day -3) + 12 (day -2) = 1,122
      const res = await pay(c.id, "1122", day(-2));
      expect(res.status).toBe(201);
      expect((await res.json()).contract).toMatchObject({ status: "CLOSED", closedOn: day(-2), totalDue: "0" });
      // the fees of day -1 and today no longer exist, and the stored fee total matches
      const l = await ledger(c.id);
      expect(l.fees.map((f) => f[0])).toEqual([day(-3), day(-2)]);
      expect(l.c.accruedLateFee.toFixed(2)).toBe("0.00");
      await expectConsistent(c.id);
    });

    it("settling an overdue contract counts today's fee, then closes it", async () => {
      const c = await makeActive({ dueIn: -3 }); // owed today = 1,135
      const tooMuch = await pay(c.id, "1135.01");
      expect(tooMuch.status).toBe(400);
      expect((await tooMuch.json()).error.message).toContain("1135");
      const res = await pay(c.id, "1135");
      expect(res.status).toBe(201);
      expect((await res.json()).contract).toMatchObject({ status: "CLOSED", totalDue: "0", closedOn: day(0), accruedLateFee: "0" });
      expect((await ledger(c.id)).fees).toHaveLength(3);
      await expectConsistent(c.id);
    });

    it("refuses to pay more than is owed and saves nothing", async () => {
      const c = await makeActive();
      const res = await pay(c.id, "1100.01");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("AMOUNT_EXCEEDS_DUE");
      expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityType: "Payment", detail: { path: ["after", "contractId"], equals: c.id } } })).toBe(0);
      expect((await ledger(c.id)).state).toEqual(["1000.00", "100.00", "0.00"]);
    });

    it("rejects dates in the future and before the payout", async () => {
      const c = await makeActive();
      const future = await pay(c.id, "10", day(1));
      expect(future.status).toBe(400);
      expect((await future.json()).error.code).toBe("PAID_ON_FUTURE");
      const before = await pay(c.id, "10", day(-41)); // payout was 40 days ago
      expect(before.status).toBe(400);
      expect((await before.json()).error.code).toBe("PAID_BEFORE_DISBURSEMENT");
      expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(0);
    });

    it("validates the body", async () => {
      const c = await makeActive();
      for (const body of [{ paidOn: day(0) }, { amount: "10" }, { amount: "0", paidOn: day(0) }, { amount: "-5", paidOn: day(0) }, { amount: "1.234", paidOn: day(0) }, { amount: "10", paidOn: "soon" }, { amount: "10", paidOn: day(0), note: "" }]) {
        const res = await call("admin", "POST", `/admin/contracts/${c.id}/payments`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("only takes payments for contracts that are paid out and not yet closed", async () => {
      const closed = await makeActive({ dueIn: 5 });
      await pay(closed.id, "1100");
      expect((await pay(closed.id, "1")).status).toBe(409);

      const awaiting = await prisma.contract.create({
        data: { contractNo: `T-${marker}-a${++seq}`, borrowerId, principal: "500", dueDate: addDays(today, 5), outstandingPrincipal: "500" },
      });
      const res = await pay(awaiting.id, "1");
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("INVALID_STATE");
      expect((await pay("nope", "1")).status).toBe(404);
    });

    it("is ADMIN only", async () => {
      const c = await makeActive();
      expect((await pay(c.id, "10", day(0), {}, "borrower")).status).toBe(403);
      expect((await pay(c.id, "10", day(0), {}, null)).status).toBe(401);
      expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(0);
    });

    it("records who did it and the contract before/after in the audit log", async () => {
      const c = await makeActive({ dueIn: -3 });
      const id = (await (await pay(c.id, "300", day(0), { note: "โอนเข้าบัญชี" })).json()).payment.id as string;
      const [row] = await auditOf("Payment", id, "payment.create");
      expect(row!.actorId).toBe(userIds[0]);
      expect(row!.detail).toMatchObject({
        after: { amount: "300", note: "โอนเข้าบัญชี", allocatedLateFee: "35", allocatedInterest: "100", allocatedPrincipal: "165" },
        contractBefore: { status: "ACTIVE", totalDue: "1100" },
        contractAfter: { status: "ACTIVE", outstandingPrincipal: "835", totalDue: "835" },
      });
    });

    it("lets only one of several simultaneous full payments through", async () => {
      const c = await makeActive();
      await Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`select pg_sleep(0.2)::text`));
      const results = await Promise.all(Array.from({ length: 6 }, () => pay(c.id, "1100")));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(1);
      await expectConsistent(c.id);
    });

    it("refuses a back-dated payment that would make a later payment exceed what is owed", async () => {
      const c = await makeActive({ dueIn: -5 });
      const owedNow = Number((await (await call("admin", "GET", `/admin/contracts/${c.id}`)).json()).contract.totalDue);
      // a large payment today that leaves only 1.00 owed, so the contract stays open
      const big = (owedNow - 1).toFixed(2);
      expect((await pay(c.id, big)).status).toBe(201);
      const before = await ledger(c.id);
      expect(before.c.status).toBe("ACTIVE");
      // an earlier payment would lower what was owed on later days, so the big payment would now be too large
      const res = await pay(c.id, "100", day(-2));
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("CONFLICTS_WITH_OTHER_PAYMENT");
      const after = await ledger(c.id);
      expect(after.state).toEqual(before.state);
      expect(after.fees).toEqual(before.fees);
      expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(1);
      await expectConsistent(c.id);
    });
  });

  // =====================================================================================
  describe("editing and deleting a payment (T-305)", () => {
    const petch = (id: string, body: unknown) => call("admin", "PATCH", `/admin/payments/${id}`, body);
    async function overdueWithTwoPayments() {
      const c = await makeActive({ dueIn: -4 });
      const a = (await (await pay(c.id, "200", day(-2))).json()).payment.id as string;
      const b = (await (await pay(c.id, "300", day(0))).json()).payment.id as string;
      return { c, a, b };
    }

    it("edits the amount and the whole contract is replayed", async () => {
      const { c, a } = await overdueWithTwoPayments();
      const res = await call("admin", "PATCH", `/admin/payments/${a}`, { amount: "100" });
      expect(res.status).toBe(200);
      await expectConsistent(c.id);
      expect((await res.json()).payment.amount).toBe("100");
    });

    it("moves a payment to another day and fees follow", async () => {
      const { c, a } = await overdueWithTwoPayments();
      const before = await ledger(c.id);
      const res = await call("admin", "PATCH", `/admin/payments/${a}`, { paidOn: day(-3) });
      expect(res.status).toBe(200);
      const after = await ledger(c.id);
      expect(after.fees).not.toEqual(before.fees); // an earlier payment lowers later bases
      await expectConsistent(c.id);
    });

    it("changing only the note leaves every number alone", async () => {
      const { c, a } = await overdueWithTwoPayments();
      const before = await ledger(c.id);
      const res = await call("admin", "PATCH", `/admin/payments/${a}`, { note: "แก้หมายเหตุ" });
      expect(res.status).toBe(200);
      expect((await ledger(c.id)).state).toEqual(before.state);
      expect((await call("admin", "PATCH", `/admin/payments/${a}`, { note: null })).status).toBe(200);
    });

    it("refuses an edit that overpays, and an edit that breaks another payment, saving nothing", async () => {
      const { c, a, b } = await overdueWithTwoPayments();
      const before = await ledger(c.id);
      const over = await petch(b, { amount: "99999" });
      expect(over.status).toBe(400);
      expect((await over.json()).error.code).toBe("AMOUNT_EXCEEDS_DUE");
      // on day -2 1,123 is owed: paying 1,122 there is allowed by itself, but then the 300
      // paid today would exceed what is left, so the whole edit is refused
      const breaks = await petch(a, { amount: "1122" });
      expect(breaks.status).toBe(409);
      expect((await breaks.json()).error.code).toBe("CONFLICTS_WITH_OTHER_PAYMENT");
      const after = await ledger(c.id);
      expect(after.state).toEqual(before.state);
      expect(after.fees).toEqual(before.fees);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: a } })).amount.toFixed(2)).toBe("200.00");
      await expectConsistent(c.id);
    });

    it("refuses a date in the future or before the payout", async () => {
      const { a } = await overdueWithTwoPayments();
      expect((await call("admin", "PATCH", `/admin/payments/${a}`, { paidOn: day(1) })).status).toBe(400);
      expect((await call("admin", "PATCH", `/admin/payments/${a}`, { paidOn: day(-45) })).status).toBe(400);
    });

    it("deletes a payment, restoring the balances a fresh replay gives", async () => {
      const { c, a } = await overdueWithTwoPayments();
      const res = await call("admin", "DELETE", `/admin/payments/${a}`);
      expect(res.status).toBe(200);
      expect(await prisma.payment.findUnique({ where: { id: a } })).toBeNull();
      await expectConsistent(c.id);
      const [row] = await auditOf("Payment", a, "payment.delete");
      expect(row!.actorId).toBe(userIds[0]);
      expect(row!.detail).toMatchObject({ before: { amount: "200", contractId: c.id }, contractAfter: { status: "ACTIVE" } });
    });

    it("reopens a closed contract when the closing payment is deleted, and fees run again", async () => {
      const c = await makeActive({ dueIn: -3 });
      const id = (await (await pay(c.id, "1135")).json()).payment.id as string;
      expect((await ledger(c.id)).c.status).toBe("CLOSED");
      const res = await call("admin", "DELETE", `/admin/payments/${id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contract).toMatchObject({ status: "ACTIVE", closedOn: null, totalDue: "1135" });
      expect((await ledger(c.id)).fees).toHaveLength(3);
      await expectConsistent(c.id);
    });

    it("deleting an earlier payment can reopen a contract that a later payment had closed", async () => {
      // pay 500 on day -2, then pay the full remainder today; without the first payment more is owed
      const c = await makeActive({ dueIn: -3 });
      const first = (await (await pay(c.id, "500", day(-2))).json()).payment.id as string;
      const owed = (await (await call("admin", "GET", `/admin/contracts/${c.id}`)).json()).contract.totalDue as string;
      expect((await pay(c.id, owed)).status).toBe(201);
      const res = await call("admin", "DELETE", `/admin/payments/${first}`);
      expect(res.status).toBe(200); // fewer payments => more owed, so the later payment no longer settles it
      const l = await ledger(c.id);
      expect(l.c.status).toBe("ACTIVE");
      await expectConsistent(c.id);
    });

    it("404s for unknown payments and is ADMIN only", async () => {
      const { a } = await overdueWithTwoPayments();
      expect((await call("admin", "PATCH", "/admin/payments/nope", { note: "x" })).status).toBe(404);
      expect((await call("admin", "DELETE", "/admin/payments/nope")).status).toBe(404);
      expect((await call("borrower", "PATCH", `/admin/payments/${a}`, { note: "x" })).status).toBe(403);
      expect((await call("borrower", "DELETE", `/admin/payments/${a}`)).status).toBe(403);
      expect((await call(null, "DELETE", `/admin/payments/${a}`)).status).toBe(401);
      expect(await prisma.payment.findUnique({ where: { id: a } })).not.toBeNull();
    });

    it("rejects an empty or invalid patch", async () => {
      const { a } = await overdueWithTwoPayments();
      for (const body of [{}, { amount: "0" }, { amount: "1.234" }, { paidOn: "nope" }]) {
        expect((await call("admin", "PATCH", `/admin/payments/${a}`, body)).status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  // =====================================================================================
  describe("editing a contract (ADMIN only)", () => {
    const waiting = async (amount = "3000", dueIn = 30) => {
      const created = await call("admin", "POST", "/admin/loan-requests", { borrowerId, amount, requestedDueDate: day(dueIn) });
      const approved = await call("admin", "POST", `/admin/loan-requests/${(await created.json()).id}/approve`);
      return (await approved.json()).contract.id as string;
    };

    it("changes principal and due date while the contract waits for the payout", async () => {
      const contractId = await waiting();
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "4500.50", dueDate: day(45) });
      expect(res.status).toBe(200);
      expect((await res.json()).contract).toMatchObject({ principal: "4500.5", outstandingPrincipal: "4500.5", dueDate: day(45), status: "AWAITING_DISBURSEMENT" });
      const [row] = await auditOf("Contract", contractId, "contract.update");
      expect(row!.detail).toMatchObject({ before: { principal: "3000", dueDate: day(30) }, after: { principal: "4500.5", dueDate: day(45) } });
    });

    it("the payout then uses the edited terms", async () => {
      const contractId = await waiting("3000", 30);
      await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "6000" });
      const res = await call("admin", "POST", `/admin/contracts/${contractId}/disbursement`, { paidOn: day(0), slipFileKey: await slip() });
      expect(res.status).toBe(201);
      expect((await res.json()).disbursement.amount).toBe("6000");
      expect((await ledger(contractId)).state).toEqual(["6000.00", "180.00", "0.00"]); // 30 days at 3 %
    });

    it("moving the due date of an open contract recomputes its interest with the locked rate", async () => {
      const { contractId } = await disbursed("3000", 30, 0); // 30 days at 3 % -> 90
      await prisma.setting.update({ where: { id: 1 }, data: { interestRatePctPerMonth: "9" } });
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { dueDate: day(45) }); // 45 days -> 135
      await prisma.setting.update({ where: { id: 1 }, data: { interestRatePctPerMonth: "3" } });
      expect(res.status).toBe(200);
      expect((await res.json()).contract).toMatchObject({ dueDate: day(45), interestAmount: "135", interestRatePctPerMonth: "3" });
      expect((await ledger(contractId)).state).toEqual(["3000.00", "135.00", "0.00"]);
      const [row] = await auditOf("Contract", contractId, "contract.update");
      expect(row!.detail).toMatchObject({ before: { dueDate: day(30), interestAmount: "90" }, after: { dueDate: day(45), interestAmount: "135" } });
    });

    it("changing the principal of an open contract moves the payout and recomputes the interest", async () => {
      const { contractId } = await disbursed("3000", 30, 0); // 30 days at 3 % -> 90
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "5000" }); // -> 150
      expect(res.status).toBe(200);
      expect((await res.json()).contract).toMatchObject({ principal: "5000", interestAmount: "150", totalDue: "5150" });
      expect((await ledger(contractId)).state).toEqual(["5000.00", "150.00", "0.00"]);
      const d = await prisma.disbursement.findFirstOrThrow({ where: { contractId } });
      expect(d.amount.toString()).toBe("5000");
    });

    it("the interest can be typed in directly and is kept as typed", async () => {
      const { contractId } = await disbursed("3000", 30, 0);
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { interestAmount: "75.50" });
      expect(res.status).toBe(200);
      expect((await res.json()).contract).toMatchObject({ principal: "3000", interestAmount: "75.5", totalDue: "3075.5" });
      const zero = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { interestAmount: "0" });
      expect(zero.status).toBe(200);
      expect((await ledger(contractId)).state).toEqual(["3000.00", "0.00", "0.00"]);
      const [row] = await auditOf("Contract", contractId, "contract.update");
      expect(row!.detail).toMatchObject({ before: { interestAmount: "90" } });
    });

    it("a typed interest wins over the recomputed one when the principal changes too", async () => {
      const { contractId } = await disbursed("3000", 30, 0);
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "4000", interestAmount: "100" });
      expect((await res.json()).contract).toMatchObject({ principal: "4000", interestAmount: "100", totalDue: "4100" });
    });

    it("a principal that no longer covers the payments already made is refused", async () => {
      const { contractId } = await disbursed("3000", 30, 5);
      expect((await call("admin", "POST", `/admin/contracts/${contractId}/payments`, { amount: "1000", paidOn: day(0) })).status).toBe(201);
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "100", interestAmount: "0" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).principal.toString()).toBe("3000");
    });

    it("refuses what is not allowed and changes nothing", async () => {
      const { contractId } = await disbursed("3000", 30, 5);
      expect((await call("admin", "PATCH", `/admin/contracts/${contractId}`, { dueDate: day(-5) })).status).toBe(400); // not in the future
      expect((await call("admin", "PATCH", `/admin/contracts/${contractId}`, {})).status).toBe(400);
      expect((await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "-5" })).status).toBe(400);
      expect((await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "0" })).status).toBe(400);
      expect((await call("admin", "PATCH", `/admin/contracts/${contractId}`, { interestAmount: "-1" })).status).toBe(400);
      const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(c.dueDate).toEqual(new Date(`${day(30)}T00:00:00Z`));
      expect(c.principal.toString()).toBe("3000");
      expect(await auditOf("Contract", contractId, "contract.update")).toHaveLength(0);
    });

    it("a contract waiting for the payout has no interest to edit", async () => {
      const contractId = await waiting();
      const res = await call("admin", "PATCH", `/admin/contracts/${contractId}`, { interestAmount: "10" });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("NO_INTEREST_YET");
    });

    it("refuses a cancelled contract, and is for ADMIN only", async () => {
      const contractId = await waiting();
      expect((await call(null, "PATCH", `/admin/contracts/${contractId}`, { principal: "100" })).status).toBe(401);
      expect((await call("borrower", "PATCH", `/admin/contracts/${contractId}`, { principal: "100" })).status).toBe(403);
      expect((await call("admin", "PATCH", "/admin/contracts/nope", { principal: "100" })).status).toBe(404);
      await call("admin", "POST", `/admin/contracts/${contractId}/cancel`);
      expect((await call("admin", "PATCH", `/admin/contracts/${contractId}`, { principal: "100" })).status).toBe(409);
      const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(c.principal.toString()).toBe("3000");
    });
  });

  // =====================================================================================
  describe("editing and deleting a payout (T-305)", () => {
    it("moving the payout date recomputes the interest with the contract's own rate, not today's", async () => {
      const { contractId, disbursementId } = await disbursed("3000", 30, 0); // 30 days at 3 % -> 90
      expect((await ledger(contractId)).state).toEqual(["3000.00", "90.00", "0.00"]);
      await prisma.setting.update({ where: { id: 1 }, data: { interestRatePctPerMonth: "9" } }); // later rate change
      const res = await call("admin", "PATCH", `/admin/disbursements/${disbursementId}`, { paidOn: day(-15) }); // 45 days
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contract).toMatchObject({ disbursedOn: day(-15), interestAmount: "135", interestRatePctPerMonth: "3" });
      expect((await ledger(contractId)).state).toEqual(["3000.00", "135.00", "0.00"]);
      await prisma.setting.update({ where: { id: 1 }, data: { interestRatePctPerMonth: "3" } });
      const [row] = await auditOf("Disbursement", disbursementId, "disbursement.update");
      expect(row!.detail).toMatchObject({
        before: { paidOn: day(0) },
        after: { paidOn: day(-15) },
        interestBefore: "90",
        interestAfter: "135",
      });
    });

    it("refuses a payout date after an existing payment, a date too close to the due date or in the future", async () => {
      const { contractId, disbursementId } = await disbursed("3000", 30, 5);
      expect((await pay(contractId, "100", day(-3))).status).toBe(201);
      const tooLate = await call("admin", "PATCH", `/admin/disbursements/${disbursementId}`, { paidOn: day(-1) });
      expect(tooLate.status).toBe(400);
      expect((await tooLate.json()).error.code).toBe("PAID_BEFORE_DISBURSEMENT");
      expect((await ledger(contractId)).c.interestAmount!.toFixed(2)).toBe("105.00"); // unchanged: 35 days at 3 %

      const closeToDue = await call("admin", "PATCH", `/admin/disbursements/${disbursementId}`, { paidOn: day(30) });
      expect(closeToDue.status).toBe(400);
      const future = await call("admin", "PATCH", `/admin/disbursements/${disbursementId}`, { paidOn: day(1) });
      expect((await future.json()).error.code).toBe("PAID_ON_FUTURE");
    });

    it("refuses to move the payout date onto or after the due date, and keeps the interest as it was", async () => {
      const { contractId, disbursementId } = await disbursed("3000", 30, 5);
      const before = (await ledger(contractId)).c.interestAmount!.toFixed(2);
      // the due date has passed since: it was 30 days ahead, now it is yesterday
      await prisma.contract.update({ where: { id: contractId }, data: { dueDate: addDays(today, -1) } });
      const res = await call("admin", "PATCH", `/admin/disbursements/${disbursementId}`, { paidOn: day(0) });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("DUE_DATE_TOO_SOON");
      expect((await ledger(contractId)).c.interestAmount!.toFixed(2)).toBe(before);
    });

    it("replaces the slip with another stored, unused slip, and refuses others", async () => {
      const a = await disbursed("1000", 20, 0);
      const b = await disbursed("1000", 20, 0);
      const bSlip = (await prisma.disbursement.findUniqueOrThrow({ where: { id: b.disbursementId } })).slipFileKey;
      const reused = await call("admin", "PATCH", `/admin/disbursements/${a.disbursementId}`, { slipFileKey: bSlip });
      expect(reused.status).toBe(409);
      expect((await reused.json()).error.code).toBe("SLIP_ALREADY_USED");
      expect((await call("admin", "PATCH", `/admin/disbursements/${a.disbursementId}`, { slipFileKey: "made-up" })).status).toBe(400);
      const fresh = await slip();
      const ok = await call("admin", "PATCH", `/admin/disbursements/${a.disbursementId}`, { slipFileKey: fresh, note: "เปลี่ยนสลิป" });
      expect(ok.status).toBe(200);
      expect((await ok.json()).disbursement).toMatchObject({ slipFileKey: fresh, note: "เปลี่ยนสลิป" });
    });

    it("deletes a payout only when there are no payments, and the contract goes back to waiting", async () => {
      const { contractId, disbursementId } = await disbursed("2000", 10, 0);
      const paymentId = (await (await pay(contractId, "50")).json()).payment.id as string;
      const blocked = await call("admin", "DELETE", `/admin/disbursements/${disbursementId}`);
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error.code).toBe("HAS_PAYMENTS");
      expect(await prisma.disbursement.findUnique({ where: { id: disbursementId } })).not.toBeNull();

      await call("admin", "DELETE", `/admin/payments/${paymentId}`);
      const res = await call("admin", "DELETE", `/admin/disbursements/${disbursementId}`);
      expect(res.status).toBe(200);
      const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(c).toMatchObject({ status: "AWAITING_DISBURSEMENT", disbursedOn: null, interestAmount: null, interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, closedOn: null });
      expect(c.outstandingPrincipal.toFixed(2)).toBe("2000.00");
      expect(c.outstandingInterest.toFixed(2)).toBe("0.00");
      expect(c.accruedLateFee.toFixed(2)).toBe("0.00");
      expect(await prisma.lateFeeAccrual.count({ where: { contractId } })).toBe(0);
      const [row] = await auditOf("Disbursement", disbursementId, "disbursement.delete");
      expect(row!.detail).toMatchObject({ before: { amount: "2000", contractId }, contractAfter: { status: "AWAITING_DISBURSEMENT" } });

      // it can be paid out again
      const again = await call("admin", "POST", `/admin/contracts/${contractId}/disbursement`, { paidOn: day(0), slipFileKey: await slip() });
      expect(again.status).toBe(201);
    });

    it("404s for unknown payouts and is ADMIN only", async () => {
      const { disbursementId } = await disbursed("1000", 10, 0);
      expect((await call("admin", "PATCH", "/admin/disbursements/nope", { note: "x" })).status).toBe(404);
      expect((await call("admin", "DELETE", "/admin/disbursements/nope")).status).toBe(404);
      expect((await call("borrower", "PATCH", `/admin/disbursements/${disbursementId}`, { note: "x" })).status).toBe(403);
      expect((await call("borrower", "DELETE", `/admin/disbursements/${disbursementId}`)).status).toBe(403);
      expect((await call("admin", "PATCH", `/admin/disbursements/${disbursementId}`, {})).status).toBe(400);
    });
  });

  // =====================================================================================
  describe("admin contract queries (T-306)", () => {
    it("shows what is owed TODAY even when the nightly job has not run", async () => {
      const c = await makeActive({ dueIn: -3 });
      expect((await ledger(c.id)).state).toEqual(["1000.00", "100.00", "0.00"]); // stored: stale
      const res = await call("admin", "GET", `/admin/contracts/${c.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contract).toMatchObject({
        status: "ACTIVE",
        outstandingPrincipal: "1000",
        outstandingInterest: "100",
        accruedLateFee: "35",
        totalDue: "1135",
        isOverdue: true,
        daysOverdue: 3,
        isLate: true,
        borrower: { id: borrowerId },
      });
      expect(body.lateFeeAccruals.map((a: { date: string; amount: string }) => [a.date, a.amount])).toEqual([
        [day(-2), "11"],
        [day(-1), "12"],
        [day(0), "12"],
      ]);
      // reading changed nothing in the database
      expect((await ledger(c.id)).state).toEqual(["1000.00", "100.00", "0.00"]);
      expect(await prisma.lateFeeAccrual.count({ where: { contractId: c.id } })).toBe(0);
    });

    it("lists the payout and every payment of a contract", async () => {
      const { contractId } = await disbursed("1000", 20, 0);
      await pay(contractId, "50", day(0), { note: "งวดแรก" });
      const body = await (await call("admin", "GET", `/admin/contracts/${contractId}`)).json();
      expect(body.disbursement).toMatchObject({ amount: "1000", paidOn: day(0) });
      expect(body.payments).toHaveLength(1);
      expect(body.payments[0]).toMatchObject({ amount: "50", note: "งวดแรก" });
    });

    it("computes overdue and late flags and never stores them", async () => {
      const onTime = await makeActive({ dueIn: 5 });
      expect((await (await call("admin", "GET", `/admin/contracts/${onTime.id}`)).json()).contract).toMatchObject({ isOverdue: false, isLate: false, daysOverdue: 0 });
      const closedLate = await makeActive({ dueIn: -2 });
      await pay(closedLate.id, "1123"); // 1,100 + 11 + 12
      const detail = (await (await call("admin", "GET", `/admin/contracts/${closedLate.id}`)).json()).contract;
      expect(detail).toMatchObject({ status: "CLOSED", isOverdue: false, isLate: true, closedOn: day(0) });
      const closedOnTime = await makeActive({ dueIn: 2 });
      await pay(closedOnTime.id, "1100");
      expect((await (await call("admin", "GET", `/admin/contracts/${closedOnTime.id}`)).json()).contract).toMatchObject({ status: "CLOSED", isLate: false });
    });

    it("lists with filters, search, sorting and paging", async () => {
      const late = await makeActive({ dueIn: -7 });
      const soon = await makeActive({ dueIn: 3 });
      const mine = (qs: string) => call("admin", "GET", `/admin/contracts?borrowerId=${borrowerId}&${qs}`).then((r) => r.json());

      const overdue = await mine("overdue=true&limit=200");
      expect(overdue.items.every((i: { isOverdue: boolean; status: string }) => i.isOverdue && i.status === "ACTIVE")).toBe(true);
      expect(overdue.items.map((i: { id: string }) => i.id)).toContain(late.id);
      expect(overdue.items.map((i: { id: string }) => i.id)).not.toContain(soon.id);

      const lateItem = overdue.items.find((i: { id: string }) => i.id === late.id);
      expect(lateItem).toMatchObject({ contractNo: late.contractNo, daysOverdue: 7, isLate: true });
      expect(Number(lateItem.totalDue)).toBeGreaterThan(1100); // fees are included

      const byNo = await mine(`q=${encodeURIComponent(soon.contractNo)}`);
      expect(byNo.items.map((i: { id: string }) => i.id)).toEqual([soon.id]);
      const byName = await mine(`q=${encodeURIComponent("somchai")}&limit=1`);
      expect(byName.total).toBeGreaterThan(1);
      expect(byName.items).toHaveLength(1);

      const sorted = await mine("status=ACTIVE&sort=dueDate&limit=200");
      const dues = sorted.items.map((i: { dueDate: string }) => i.dueDate);
      expect(dues).toEqual([...dues].sort());

      const page1 = await mine("limit=2&offset=0");
      const page2 = await mine("limit=2&offset=2");
      expect(page1.items).toHaveLength(2);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
      expect((await call("admin", "GET", "/admin/contracts?status=NOPE")).status).toBe(400);
    });

    it("shows no amount owed for a contract still waiting for its payout", async () => {
      const awaiting = await prisma.contract.create({
        data: { contractNo: `T-${marker}-w${++seq}`, borrowerId, principal: "500", dueDate: addDays(today, 9), outstandingPrincipal: "500" },
      });
      const detail = await (await call("admin", "GET", `/admin/contracts/${awaiting.id}`)).json();
      expect(detail.contract).toMatchObject({ status: "AWAITING_DISBURSEMENT", totalDue: null, isOverdue: false });
      const list = await call("admin", "GET", `/admin/contracts?borrowerId=${borrowerId}&status=AWAITING_DISBURSEMENT&limit=200`).then((r) => r.json());
      expect(list.items.find((i: { id: string }) => i.id === awaiting.id).totalDue).toBeNull();
    });

    it("404s for unknown contracts and is ADMIN only", async () => {
      expect((await call("admin", "GET", "/admin/contracts/nope")).status).toBe(404);
      expect((await call("borrower", "GET", "/admin/contracts")).status).toBe(403);
      expect((await call("borrower", "GET", "/admin/contracts/nope")).status).toBe(403);
      expect((await call(null, "GET", "/admin/contracts")).status).toBe(401);
    });
  });
});
