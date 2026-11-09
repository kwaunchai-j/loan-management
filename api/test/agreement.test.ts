import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { buildAgreementTerms } from "../src/loans/agreement.js";
import { completeProfile, RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("buildAgreementTerms (no database)", () => {
  const base = {
    borrowerName: "สมชาย ใจดี",
    amount: D("10000"),
    dueDate: day("2026-12-01"),
    issuedOn: day("2026-11-01"),
    interestRatePctPerMonth: D("3"),
    lateFeeRatePctPerDay: D("0.5"),
    payment: { bankName: "ธนาคารกสิกรไทย", accountName: "ผู้ให้กู้", accountNo: "123-4-56789-0" },
  };

  it("copies the request's figures and estimates the interest for the days until the due date", () => {
    const t = buildAgreementTerms(base);
    expect(t).toMatchObject({
      issuedOn: "2026-11-01",
      borrowerName: "สมชาย ใจดี",
      principal: "10000",
      dueDate: "2026-12-01",
      interestRatePctPerMonth: "3",
      lateFeeRatePctPerDay: "0.5",
      // 30 days: 10,000 × 3 % × 30 / 30 = 300
      estimate: { days: 30, interestAmount: "300", totalToRepay: "10300" },
      payment: { bankName: "ธนาคารกสิกรไทย", accountName: "ผู้ให้กู้", accountNo: "123-4-56789-0" },
    });
  });

  it("still produces a document when the lender has set no rate or account yet", () => {
    const t = buildAgreementTerms({ ...base, interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, payment: null });
    expect(t.interestRatePctPerMonth).toBeNull();
    expect(t.lateFeeRatePctPerDay).toBeNull();
    expect(t.estimate).toBeNull();
    expect(t.payment).toBeNull();
    expect(t.principal).toBe("10000");
  });

  it("treats a half-filled lender account as none", () => {
    expect(buildAgreementTerms({ ...base, payment: { bankName: "ธนาคาร", accountName: null, accountNo: "1" } }).payment).toBeNull();
  });

  it("gives no estimate when the due date is not after the day of issue", () => {
    expect(buildAgreementTerms({ ...base, dueDate: day("2026-11-01") }).estimate).toBeNull();
    expect(buildAgreementTerms({ ...base, dueDate: day("2026-10-01") }).estimate).toBeNull();
  });

  it("gives no estimate rather than failing when the figures would not fit the money columns", () => {
    const t = buildAgreementTerms({ ...base, amount: D("999999999999.99"), interestRatePctPerMonth: D("50") });
    expect(t.estimate).toBeNull();
    expect(t.principal).toBe("999999999999.99");
  });
});

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t880${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;
const inDays = (n: number) => {
  const d = bangkokToday();
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateOnly(d);
};

describe.skipIf(!dbUp)("loan agreement generated with every request (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const userIds: string[] = [];
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
  const setSetting = (data: Prisma.SettingUncheckedUpdateInput) =>
    prisma.setting.upsert({ where: { id: 1 }, create: { id: 1, ...(data as Prisma.SettingUncheckedCreateInput) }, update: data });

  async function borrowerRequests(amount = "5000", due = inDays(30)) {
    const res = await call("borrowerA", "POST", "/loan-requests", { amount, requestedDueDate: due });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  }

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await setSetting({
      interestRatePctPerMonth: "3",
      lateFeeRatePctPerDay: "0.5",
      paymentBankName: "ธนาคารทดสอบ",
      paymentAccountName: "ผู้ให้กู้ ทดสอบ",
      paymentAccountNo: "111-2-33333-4",
    });
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    const mkUser = async (u: string, role: "ADMIN" | "BORROWER") => {
      const user = await prisma.user.create({ data: { username: name(u), role, ...base } });
      userIds.push(user.id);
      return user;
    };
    await mkUser("admin", "ADMIN");
    for (const key of ["A", "B"]) {
      const user = await mkUser(`borrower${key}`, "BORROWER");
      ids[`borrower${key}`] = (
        await prisma.borrower.create({
          data: { userId: user.id, fullName: `${marker} ${key}`, ...completeProfile(), pdpaAcceptedAt: new Date() },
        })
      ).id;
    }
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
    for (const u of ["admin", "borrowerA", "borrowerB"]) {
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
    const borrowers = Object.values(ids);
    const requests = (await prisma.loanRequest.findMany({ where: { borrowerId: { in: borrowers } }, select: { id: true } })).map((r) => r.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityType: "LoanRequest", entityId: { in: requests } }] } });
    await prisma.loanAgreement.deleteMany({ where: { loanRequestId: { in: requests } } });
    await prisma.contract.deleteMany({ where: { borrowerId: { in: borrowers } } });
    await prisma.loanRequest.deleteMany({ where: { borrowerId: { in: borrowers } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowers } } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (originalSetting) await prisma.setting.create({ data: { ...originalSetting } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("a borrower's request is saved together with its agreement", async () => {
    const id = await borrowerRequests("5000", inDays(30));
    const row = await prisma.loanAgreement.findUniqueOrThrow({ where: { loanRequestId: id } });
    expect(row.agreementNo).toMatch(/^AG-\d{4}-\d{6}$/);
    expect(row.terms).toMatchObject({
      issuedOn: formatDateOnly(bangkokToday()),
      borrowerName: `${marker} A`,
      principal: "5000",
      dueDate: inDays(30),
      interestRatePctPerMonth: "3",
      lateFeeRatePctPerDay: "0.5",
      estimate: { days: 30, interestAmount: "150", totalToRepay: "5150" },
      payment: { bankName: "ธนาคารทดสอบ", accountName: "ผู้ให้กู้ ทดสอบ", accountNo: "111-2-33333-4" },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "LoanRequest", entityId: id, action: "loanRequest.create" } });
    expect(audit.detail).toMatchObject({ agreementNo: row.agreementNo });
  });

  it("an admin filing a request for a borrower also gets an agreement", async () => {
    const res = await call("admin", "POST", "/admin/loan-requests", { borrowerId: ids.borrowerB, amount: "2000", requestedDueDate: inDays(10) });
    expect(res.status).toBe(201);
    const id = (await res.json()).id as string;
    expect(await prisma.loanAgreement.count({ where: { loanRequestId: id } })).toBe(1);
  });

  it("a request that is refused (bad due date) leaves no agreement behind", async () => {
    const before = await prisma.loanAgreement.count();
    const res = await call("borrowerA", "POST", "/loan-requests", { amount: "100", requestedDueDate: inDays(0) });
    expect(res.status).toBe(400);
    expect(await prisma.loanAgreement.count()).toBe(before);
  });

  it("every agreement has its own number", async () => {
    const made = await Promise.all([borrowerRequests(), borrowerRequests(), borrowerRequests(), borrowerRequests()]);
    const nos = (await prisma.loanAgreement.findMany({ where: { loanRequestId: { in: made } } })).map((a) => a.agreementNo);
    expect(new Set(nos).size).toBe(4);
  });

  it("the admin opens the agreement of any request, whatever its status", async () => {
    const id = await borrowerRequests("7000");
    expect((await call("admin", "POST", `/admin/loan-requests/${id}/reject`, { reason: "ไม่ผ่านเกณฑ์" })).status).toBe(200);
    const res = await call("admin", "GET", `/admin/loan-requests/${id}/agreement`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ requestId: id, requestStatus: "REJECTED", terms: { principal: "7000", borrowerName: `${marker} A` } });
    expect(body.agreementNo).toMatch(/^AG-/);
  });

  it("the agreement stays as it was issued when the rates or the lender's account change later", async () => {
    const id = await borrowerRequests("1000", inDays(30));
    const first = await (await call("admin", "GET", `/admin/loan-requests/${id}/agreement`)).json();
    await setSetting({ interestRatePctPerMonth: "9", paymentAccountNo: "999-9-99999-9" });
    await prisma.borrower.update({ where: { id: ids.borrowerA }, data: { fullName: `${marker} A renamed` } });
    const second = await (await call("admin", "GET", `/admin/loan-requests/${id}/agreement`)).json();
    expect(second).toEqual(first);
    expect(second.terms.interestRatePctPerMonth).toBe("3");
    expect(second.terms.payment.accountNo).toBe("111-2-33333-4");
    expect(second.terms.borrowerName).toBe(`${marker} A`);
    await setSetting({ interestRatePctPerMonth: "3", paymentAccountNo: "111-2-33333-4" });
    await prisma.borrower.update({ where: { id: ids.borrowerA }, data: { fullName: `${marker} A` } });
  });

  it("a borrower opens the agreement of their own request only", async () => {
    const id = await borrowerRequests("3000");
    const own = await call("borrowerA", "GET", `/me/loan-requests/${id}/agreement`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ requestId: id, terms: { principal: "3000" } });
    // another borrower's request looks exactly like one that does not exist
    const other = await call("borrowerB", "GET", `/me/loan-requests/${id}/agreement`);
    expect(other.status).toBe(404);
    expect((await call("borrowerB", "GET", "/me/loan-requests/does-not-exist/agreement")).status).toBe(404);
    expect((await call("borrowerA", "GET", `/admin/loan-requests/${id}/agreement`)).status).toBe(403);
    expect((await call(null, "GET", `/me/loan-requests/${id}/agreement`)).status).toBe(401);
    expect((await call(null, "GET", `/admin/loan-requests/${id}/agreement`)).status).toBe(401);
  });

  it("an unknown request id is 404", async () => {
    expect((await call("admin", "GET", "/admin/loan-requests/nope/agreement")).status).toBe(404);
  });

  it("a request that predates the feature gets its agreement the first time it is opened, dated the day it was filed", async () => {
    const filedAt = new Date(`${inDays(-3)}T05:00:00.000Z`);
    const old = await prisma.loanRequest.create({
      data: { borrowerId: ids.borrowerA!, amount: "4000", requestedDueDate: day(inDays(20)), createdById: userIds[1]!, createdAt: filedAt },
    });
    expect(await prisma.loanAgreement.count({ where: { loanRequestId: old.id } })).toBe(0);
    // two people open it at the same moment: still exactly one agreement
    const [a, b] = await Promise.all([
      call("admin", "GET", `/admin/loan-requests/${old.id}/agreement`),
      call("borrowerA", "GET", `/me/loan-requests/${old.id}/agreement`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [bodyA, bodyB] = [await a.json(), await b.json()];
    expect(bodyA.agreementNo).toBe(bodyB.agreementNo);
    expect(bodyA.terms).toMatchObject({ issuedOn: inDays(-3), principal: "4000", dueDate: inDays(20), estimate: { days: 23 } });
    expect(await prisma.loanAgreement.count({ where: { loanRequestId: old.id } })).toBe(1);
  });

  it("deleting a request takes its agreement with it", async () => {
    const id = await borrowerRequests();
    await prisma.loanRequest.delete({ where: { id } });
    expect(await prisma.loanAgreement.count({ where: { loanRequestId: id } })).toBe(0);
  });
});
