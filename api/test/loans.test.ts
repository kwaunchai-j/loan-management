import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { completeProfile, RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t201${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

const inDays = (n: number) => {
  const d = bangkokToday();
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateOnly(d);
};

describe.skipIf(!dbUp)("loan requests and contracts (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const userIds: string[] = [];

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

  /** ADMIN files a request for borrower A and returns its id. */
  async function pendingRequest(amount: string | number = "5000", due = inDays(30)) {
    const res = await call("admin", "POST", "/admin/loan-requests", {
      borrowerId: ids.borrowerA,
      amount,
      requestedDueDate: due,
    });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  }

  const auditFor = (entityType: string, entityId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityType, entityId, action } });

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    const mkUser = async (u: string, role: "ADMIN" | "BORROWER") => {
      const user = await prisma.user.create({ data: { username: name(u), role, ...base } });
      userIds.push(user.id);
      return user;
    };
    await mkUser("admin", "ADMIN");
    for (const [key, pdpa] of [["A", true], ["B", true], ["C", false]] as const) {
      const user = await mkUser(`borrower${key}`, "BORROWER");
      const b = await prisma.borrower.create({
        data: { userId: user.id, fullName: `${marker} ${key}`, ...completeProfile(), ...(pdpa ? { pdpaAcceptedAt: new Date() } : {}) },
      });
      ids[`borrower${key}`] = b.id;
    }
    ids.noAccount = (await prisma.borrower.create({ data: { fullName: `${marker} no-account` } })).id;

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

    for (const u of ["admin", "borrowerA", "borrowerB", "borrowerC"]) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name(u), password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      cookies[u] = cookieOf(res);
    }
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const borrowers = (await prisma.borrower.findMany({ where: { fullName: { startsWith: marker } }, select: { id: true } })).map((b) => b.id);
    const contracts = (await prisma.contract.findMany({ where: { borrowerId: { in: borrowers } }, select: { id: true } })).map((c) => c.id);
    await prisma.disbursement.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.loanRequest.deleteMany({ where: { borrowerId: { in: borrowers } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowers } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("borrower files a request", () => {
    it("creates a PENDING request for the session's own borrower", async () => {
      const res = await call("borrowerA", "POST", "/loan-requests", { amount: "5000.50", requestedDueDate: inDays(30) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        borrower: { id: ids.borrowerA },
        amount: "5000.5",
        requestedDueDate: inDays(30),
        status: "PENDING",
        decidedById: null,
        contract: null,
      });
      const row = await prisma.loanRequest.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.createdById).toBe(userIds[1]);
      expect(row.amount.toString()).toBe("5000.5");
      const [audit] = await auditFor("LoanRequest", body.id, "loanRequest.create");
      expect(audit!.actorId).toBe(userIds[1]);
    });

    it("never takes the borrower from the client", async () => {
      const res = await call("borrowerA", "POST", "/loan-requests", {
        amount: "100",
        requestedDueDate: inDays(5),
        borrowerId: ids.borrowerB,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("BORROWER_ID_NOT_ALLOWED");
    });

    it("requires a due date after today (Asia/Bangkok)", async () => {
      for (const due of [inDays(0), inDays(-1)]) {
        const res = await call("borrowerA", "POST", "/loan-requests", { amount: "100", requestedDueDate: due });
        expect(res.status, due).toBe(400);
        expect((await res.json()).error.code).toBe("DUE_DATE_NOT_FUTURE");
      }
      expect((await call("borrowerA", "POST", "/loan-requests", { amount: "100", requestedDueDate: inDays(1) })).status).toBe(201);
    });

    it("rejects bad amounts and dates", async () => {
      const bad: Array<Record<string, unknown>> = [
        { amount: "0", requestedDueDate: inDays(5) },
        { amount: "-5", requestedDueDate: inDays(5) },
        { amount: "abc", requestedDueDate: inDays(5) },
        { amount: "1.234", requestedDueDate: inDays(5) },
        { amount: 1e21, requestedDueDate: inDays(5) },
        { amount: "1000000000000", requestedDueDate: inDays(5) },
        { amount: "100", requestedDueDate: "not-a-date" },
        { amount: "100", requestedDueDate: "2027-02-30" },
        { amount: "100" },
        { requestedDueDate: inDays(5) },
      ];
      for (const body of bad) {
        const res = await call("borrowerA", "POST", "/loan-requests", body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("accepts the largest amount the column holds", async () => {
      const res = await call("borrowerA", "POST", "/loan-requests", { amount: "999999999999.99", requestedDueDate: inDays(5) });
      expect(res.status).toBe(201);
      expect((await res.json()).amount).toBe("999999999999.99");
    });

    it("is closed to anyone who is not a borrower who accepted the PDPA terms", async () => {
      const body = { amount: "100", requestedDueDate: inDays(5) };
      const noPdpa = await call("borrowerC", "POST", "/loan-requests", body);
      expect(noPdpa.status).toBe(403);
      expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
      expect((await call("admin", "POST", "/loan-requests", body)).status).toBe(403);
      expect((await call(null, "POST", "/loan-requests", body)).status).toBe(401);
    });
  });

  describe("admin files a request on behalf of a borrower", () => {
    it("works, including for a borrower who has no login", async () => {
      const res = await call("admin", "POST", "/admin/loan-requests", {
        borrowerId: ids.noAccount,
        amount: "2500",
        requestedDueDate: inDays(10),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.borrower.id).toBe(ids.noAccount);
      const row = await prisma.loanRequest.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.createdById).toBe(userIds[0]);
    });

    it("rejects an unknown borrower and a past due date", async () => {
      const unknown = await call("admin", "POST", "/admin/loan-requests", { borrowerId: "nobody", amount: "1", requestedDueDate: inDays(3) });
      expect(unknown.status).toBe(404);
      expect((await unknown.json()).error.code).toBe("BORROWER_NOT_FOUND");
      const past = await call("admin", "POST", "/admin/loan-requests", { borrowerId: ids.borrowerA, amount: "1", requestedDueDate: inDays(0) });
      expect(past.status).toBe(400);
    });

    it("is closed to borrowers and anonymous callers", async () => {
      const path = "/admin/loan-requests";
      expect((await call("borrowerA", "GET", path)).status).toBe(403);
      expect((await call("borrowerA", "POST", path, { borrowerId: ids.borrowerB, amount: "1", requestedDueDate: inDays(3) })).status).toBe(403);
      expect((await call(null, "GET", path)).status).toBe(401);
    });
  });

  describe("list and get", () => {
    it("filters by borrower and status and paginates", async () => {
      const mine = await (await call("admin", "GET", `/admin/loan-requests?borrowerId=${ids.borrowerA}&status=PENDING&limit=2&offset=0`)).json();
      expect(mine.total).toBeGreaterThan(2);
      expect(mine.items).toHaveLength(2);
      expect(mine.items.every((r: { borrower: { id: string }; status: string }) => r.borrower.id === ids.borrowerA && r.status === "PENDING")).toBe(true);
      const next = await (await call("admin", "GET", `/admin/loan-requests?borrowerId=${ids.borrowerA}&status=PENDING&limit=2&offset=2`)).json();
      expect(next.items[0].id).not.toBe(mine.items[0].id);
      expect((await call("admin", "GET", "/admin/loan-requests?status=NOPE")).status).toBe(400);
    });

    it("returns one request or 404", async () => {
      const id = await pendingRequest();
      const res = await call("admin", "GET", `/admin/loan-requests/${id}`);
      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(id);
      expect((await call("admin", "GET", "/admin/loan-requests/nope")).status).toBe(404);
    });
  });

  describe("approve", () => {
    it("creates a contract waiting for disbursement, with no amount owed shown yet", async () => {
      const id = await pendingRequest("12345.67", inDays(45));
      const res = await call("admin", "POST", `/admin/loan-requests/${id}/approve`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("APPROVED");
      expect(body.decidedById).toBe(userIds[0]);
      expect(body.contract).toMatchObject({ status: "AWAITING_DISBURSEMENT" });
      expect(body.contract.contractNo).toMatch(/^LN-\d{4}-\d{6}$/);

      const c = await prisma.contract.findUniqueOrThrow({ where: { loanRequestId: id } });
      expect(c.borrowerId).toBe(ids.borrowerA);
      expect(c.principal.toString()).toBe("12345.67");
      expect(c.outstandingPrincipal.toString()).toBe("12345.67");
      expect(formatDateOnly(c.dueDate)).toBe(inDays(45));
      expect(c.status).toBe("AWAITING_DISBURSEMENT");
      expect(c.disbursedOn).toBeNull();
      expect(c.interestAmount).toBeNull();
      expect(c.interestRatePctPerMonth).toBeNull();
      expect(c.lateFeeRatePctPerDay).toBeNull();
      expect(c.outstandingInterest.toString()).toBe("0");
      expect(c.accruedLateFee.toString()).toBe("0");
      expect(c.isImported).toBe(false);

      const [audit] = await auditFor("LoanRequest", id, "loanRequest.approve");
      expect(audit!.detail).toMatchObject({ contractNo: c.contractNo, before: { status: "PENDING" }, after: { status: "APPROVED" } });
    });

    it("lets the admin approve a request the admin filed (no separation of duties)", async () => {
      const id = await pendingRequest();
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/approve`)).status).toBe(200);
    });

    it("approves a request once only", async () => {
      const id = await pendingRequest();
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/approve`)).status).toBe(200);
      const again = await call("admin", "POST", `/admin/loan-requests/${id}/approve`);
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe("INVALID_STATE");
      expect(await prisma.contract.count({ where: { loanRequestId: id } })).toBe(1);
      expect((await call("admin", "POST", "/admin/loan-requests/nope/approve")).status).toBe(404);
    });

    it("creates exactly one contract when the same request is approved twice at once", async () => {
      const id = await pendingRequest();
      const [a, b] = await Promise.all([
        call("admin", "POST", `/admin/loan-requests/${id}/approve`),
        call("admin", "POST", `/admin/loan-requests/${id}/approve`),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await prisma.contract.count({ where: { loanRequestId: id } })).toBe(1);
    });

    it("gives distinct contract numbers when different requests are approved at once", async () => {
      const ids3 = await Promise.all([pendingRequest(), pendingRequest(), pendingRequest()]);
      const results = await Promise.all(ids3.map((id) => call("admin", "POST", `/admin/loan-requests/${id}/approve`)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const nos = (await prisma.contract.findMany({ where: { loanRequestId: { in: ids3 } }, select: { contractNo: true } })).map((c) => c.contractNo);
      expect(new Set(nos).size).toBe(3);
    });

    it("is closed to borrowers", async () => {
      const id = await pendingRequest();
      expect((await call("borrowerA", "POST", `/admin/loan-requests/${id}/approve`)).status).toBe(403);
      const row = await prisma.loanRequest.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("PENDING");
    });
  });

  describe("reject and cancel a request", () => {
    it("rejects with a reason and creates no contract", async () => {
      const id = await pendingRequest();
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/reject`, {})).status).toBe(400);
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/reject`, { reason: "   " })).status).toBe(400);
      const res = await call("admin", "POST", `/admin/loan-requests/${id}/reject`, { reason: "ข้อมูลไม่ครบ" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "REJECTED", rejectReason: "ข้อมูลไม่ครบ", decidedById: userIds[0], contract: null });
      expect(await prisma.contract.count({ where: { loanRequestId: id } })).toBe(0);
      const [audit] = await auditFor("LoanRequest", id, "loanRequest.reject");
      expect(audit!.detail).toMatchObject({ reason: "ข้อมูลไม่ครบ" });
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/approve`)).status).toBe(409);
    });

    it("cannot reject or cancel what is already decided", async () => {
      const id = await pendingRequest();
      await call("admin", "POST", `/admin/loan-requests/${id}/approve`);
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/reject`, { reason: "x" })).status).toBe(409);
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/cancel`)).status).toBe(409);
      const row = await prisma.loanRequest.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("APPROVED");
    });

    it("cancels a pending request", async () => {
      const id = await pendingRequest();
      const res = await call("admin", "POST", `/admin/loan-requests/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "CANCELLED", decidedById: userIds[0] });
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/cancel`)).status).toBe(409);
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/approve`)).status).toBe(409);
    });
  });

  describe("borrower cancels their own request (P2)", () => {
    async function ownRequest(as: string, amount = "700") {
      const res = await call(as, "POST", "/loan-requests", { amount, requestedDueDate: inDays(20) });
      expect(res.status).toBe(201);
      return (await res.json()).id as string;
    }
    const statusOf = async (id: string) => (await prisma.loanRequest.findUniqueOrThrow({ where: { id } })).status;

    it("cancels a pending request and records who did it", async () => {
      const id = await ownRequest("borrowerA");
      const res = await call("borrowerA", "POST", `/loan-requests/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, status: "CANCELLED", decidedById: userIds[1], contract: null });
      const [audit] = await auditFor("LoanRequest", id, "loanRequest.cancel");
      expect(audit!.actorId).toBe(userIds[1]);
      expect(audit!.detail).toMatchObject({ cancelledBy: "borrower", before: { status: "PENDING" }, after: { status: "CANCELLED" } });
    });

    it("also covers a request the admin filed for that borrower", async () => {
      const id = await pendingRequest(); // filed by the admin for borrower A
      expect((await call("borrowerA", "POST", `/loan-requests/${id}/cancel`)).status).toBe(200);
      expect(await statusOf(id)).toBe("CANCELLED");
    });

    it("cannot touch another borrower's request, and does not reveal that it exists", async () => {
      const id = await ownRequest("borrowerA");
      const res = await call("borrowerB", "POST", `/loan-requests/${id}/cancel`);
      expect(res.status).toBe(404);
      expect(await statusOf(id)).toBe("PENDING");
      const unknown = await call("borrowerB", "POST", "/loan-requests/nope/cancel");
      expect(unknown.status).toBe(404);
      expect(await res.json()).toEqual(await unknown.json());
    });

    it("works only while the request is pending", async () => {
      const approved = await ownRequest("borrowerA");
      await call("admin", "POST", `/admin/loan-requests/${approved}/approve`);
      const a = await call("borrowerA", "POST", `/loan-requests/${approved}/cancel`);
      expect(a.status).toBe(409);
      expect((await a.json()).error.code).toBe("INVALID_STATE");
      expect(await statusOf(approved)).toBe("APPROVED");

      const rejected = await ownRequest("borrowerA");
      await call("admin", "POST", `/admin/loan-requests/${rejected}/reject`, { reason: "x" });
      expect((await call("borrowerA", "POST", `/loan-requests/${rejected}/cancel`)).status).toBe(409);

      const already = await ownRequest("borrowerA");
      expect((await call("borrowerA", "POST", `/loan-requests/${already}/cancel`)).status).toBe(200);
      expect((await call("borrowerA", "POST", `/loan-requests/${already}/cancel`)).status).toBe(409);
    });

    it("leaves the admin unable to approve it afterwards", async () => {
      const id = await ownRequest("borrowerA");
      await call("borrowerA", "POST", `/loan-requests/${id}/cancel`);
      expect((await call("admin", "POST", `/admin/loan-requests/${id}/approve`)).status).toBe(409);
      expect(await prisma.contract.count({ where: { loanRequestId: id } })).toBe(0);
    });

    it("ends consistent when the borrower cancels while the admin approves", async () => {
      for (let i = 0; i < 3; i++) {
        const id = await ownRequest("borrowerA");
        const [cancel, approve] = await Promise.all([
          call("borrowerA", "POST", `/loan-requests/${id}/cancel`),
          call("admin", "POST", `/admin/loan-requests/${id}/approve`),
        ]);
        expect([cancel.status, approve.status].sort()).toEqual([200, 409]);
        const contracts = await prisma.contract.count({ where: { loanRequestId: id } });
        expect(contracts).toBe(approve.status === 200 ? 1 : 0);
        expect(await statusOf(id)).toBe(approve.status === 200 ? "APPROVED" : "CANCELLED");
      }
    });

    it("is closed to anyone who is not a borrower who accepted the PDPA terms", async () => {
      const id = await ownRequest("borrowerA");
      const noPdpa = await call("borrowerC", "POST", `/loan-requests/${id}/cancel`);
      expect(noPdpa.status).toBe(403);
      expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
      expect((await call("admin", "POST", `/loan-requests/${id}/cancel`)).status).toBe(403);
      expect((await call(null, "POST", `/loan-requests/${id}/cancel`)).status).toBe(401);
      expect(await statusOf(id)).toBe("PENDING");
    });

    it("refuses a borrowerId in the request", async () => {
      const id = await ownRequest("borrowerA");
      const res = await call("borrowerA", "POST", `/loan-requests/${id}/cancel`, { borrowerId: ids.borrowerB });
      expect(res.status).toBe(400);
      expect(await statusOf(id)).toBe("PENDING");
    });
  });

  describe("cancel a contract (DES-005)", () => {
    async function approvedContract() {
      const id = await pendingRequest();
      const body = await (await call("admin", "POST", `/admin/loan-requests/${id}/approve`)).json();
      return body.contract.id as string;
    }

    it("cancels a contract that is still waiting for disbursement", async () => {
      const contractId = await approvedContract();
      const res = await call("admin", "POST", `/admin/contracts/${contractId}/cancel`, { reason: "ผู้ยืมขอยกเลิก" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: contractId, status: "CANCELLED", borrowerId: ids.borrowerA });
      const [audit] = await auditFor("Contract", contractId, "contract.cancel");
      expect(audit!.detail).toMatchObject({ reason: "ผู้ยืมขอยกเลิก", after: { status: "CANCELLED" } });
      const again = await call("admin", "POST", `/admin/contracts/${contractId}/cancel`);
      expect(again.status).toBe(409);
    });

    it("refuses once a Disbursement exists, leaving the contract untouched", async () => {
      const contractId = await approvedContract();
      await prisma.disbursement.create({
        data: { contractId, amount: "5000", paidOn: new Date(`${inDays(0)}T00:00:00Z`), slipFileKey: "test-slip", recordedById: userIds[0]! },
      });
      const res = await call("admin", "POST", `/admin/contracts/${contractId}/cancel`);
      expect(res.status).toBe(409);
      const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(c.status).toBe("AWAITING_DISBURSEMENT");
    });

    it("is for ADMIN only and 404s on unknown ids", async () => {
      const contractId = await approvedContract();
      expect((await call("borrowerA", "POST", `/admin/contracts/${contractId}/cancel`)).status).toBe(403);
      expect((await call(null, "POST", `/admin/contracts/${contractId}/cancel`)).status).toBe(401);
      expect((await call("admin", "POST", "/admin/contracts/nope/cancel")).status).toBe(404);
      const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(c.status).toBe("AWAITING_DISBURSEMENT");
    });
  });
});
