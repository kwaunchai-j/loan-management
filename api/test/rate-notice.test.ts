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
const marker = `cr9${Date.now()}`;
const dueDay = formatDateOnly(new Date(bangkokToday().getTime() + 30 * 86_400_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dbUp)("rate-adjustment notice (CR-9, PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const borrowerIds: Record<string, string> = {};
  let adminId: string;
  let originalSetting: Awaited<ReturnType<typeof prisma.setting.findUnique>>;

  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { cookie: cookies[as]! } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const notice = async (as: string) => (await call(as, "GET", "/me/rate-notice")).json();
  const setRates = (body: { interestRatePctPerMonth?: string; lateFeeRatePctPerDay?: string }) => call("admin", "PATCH", "/admin/settings", body);
  const request = (as: string) => call(as, "POST", "/loan-requests", { amount: "1000", requestedDueDate: dueDay });
  const latestSeq = async () => (await prisma.rateChange.aggregate({ _max: { seq: true } }))._max.seq ?? 0;

  async function login(username: string) {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    return res.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
  }

  async function mkBorrower(label: string) {
    const user = await prisma.user.create({
      data: { username: `${marker}-${label}`, passwordHash: await hashPassword(PASSWORD), role: "BORROWER", mustChangePassword: false },
    });
    userIds.push(user.id);
    const b = await prisma.borrower.create({
      data: { userId: user.id, fullName: `${marker} ${label}`, pdpaAcceptedAt: new Date(), pdpaVersion: "2", ...completeProfile() },
    });
    borrowerIds[label] = b.id;
    cookies[label] = await login(`${marker}-${label}`);
    await sleep(15); // a change made "after" the borrower joined must have a later timestamp
  }

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "1" },
      update: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "1" },
    });
    server = buildApp({
      prisma,
      sessionSecret: SECRET,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
    }).app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, passwordHash: await hashPassword(PASSWORD), role: "ADMIN", mustChangePassword: false } });
    adminId = admin.id;
    userIds.push(admin.id);
    cookies.admin = await login(`${marker}-admin`);
    await mkBorrower("A");
    await mkBorrower("B");
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ids = Object.values(borrowerIds);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.rateChange.deleteMany({ where: { changedById: adminId } });
    await prisma.loanRequest.deleteMany({ where: { borrowerId: { in: ids } } }); // the agreements go with them
    await prisma.borrower.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (originalSetting) await prisma.setting.create({ data: { ...originalSetting } });
    await prisma.$disconnect();
  });

  it("has nothing to acknowledge until the lender adjusts a rate, and a borrower may file a request", async () => {
    expect(await notice("A")).toMatchObject({ required: false, seq: null, interestRatePctPerMonth: null, lateFeeRatePctPerDay: null });
    expect((await request("B")).status).toBe(201);
  });

  it("is for a logged-in borrower only", async () => {
    expect((await call(null, "GET", "/me/rate-notice")).status).toBe(401);
    expect((await call("admin", "GET", "/me/rate-notice")).status).toBe(403);
    expect((await call("admin", "POST", "/me/rate-notice/acknowledge", { seq: 1 })).status).toBe(403);
  });

  it("an interest adjustment makes borrowers acknowledge it before a new request; reading stays open", async () => {
    const before = await prisma.rateChange.count();
    expect((await setRates({ interestRatePctPerMonth: "4" })).status).toBe(200);
    expect(await prisma.rateChange.count()).toBe(before + 1);

    expect(await notice("A")).toMatchObject({
      required: true,
      seq: await latestSeq(),
      interestRatePctPerMonth: { from: "3", to: "4" },
      lateFeeRatePctPerDay: null,
    });
    const refused = await request("A");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "RATE_NOTICE_REQUIRED" } });
    expect(await prisma.loanRequest.count({ where: { borrowerId: borrowerIds.A } })).toBe(0);
    expect((await call("A", "GET", "/me/loan-requests")).status).toBe(200); // everything else is open
    expect((await call("A", "GET", "/me/contracts")).status).toBe(200);
  });

  it("does not hold back the lender filing a request on the borrower's behalf", async () => {
    const res = await call("admin", "POST", "/admin/loan-requests", { borrowerId: borrowerIds.A, amount: "500", requestedDueDate: dueDay });
    expect(res.status).toBe(201);
    await prisma.loanRequest.deleteMany({ where: { borrowerId: borrowerIds.A } });
  });

  it("an adjustment of the same value changes nothing and notifies nobody", async () => {
    const before = await prisma.rateChange.count();
    expect((await setRates({ interestRatePctPerMonth: "4", lateFeeRatePctPerDay: "1" })).status).toBe(200);
    expect(await prisma.rateChange.count()).toBe(before);
  });

  it("shows several adjustments as one, and a late-fee adjustment alongside the interest one", async () => {
    await setRates({ interestRatePctPerMonth: "5" }); // 3 -> 4 -> 5 is shown as 3 -> 5
    await setRates({ lateFeeRatePctPerDay: "2" });
    expect(await notice("A")).toMatchObject({
      required: true,
      seq: await latestSeq(),
      interestRatePctPerMonth: { from: "3", to: "5" },
      lateFeeRatePctPerDay: { from: "1", to: "2" },
    });
  });

  it("acknowledging an older notice leaves the newer adjustment still to acknowledge", async () => {
    const newest = await latestSeq();
    const second = await prisma.rateChange.findFirstOrThrow({ where: { seq: { lt: newest } }, orderBy: { seq: "desc" } });
    const res = await call("A", "POST", "/me/rate-notice/acknowledge", { seq: second.seq });
    expect(res.status).toBe(200);
    // what is left is the late-fee change only
    expect(await res.json()).toMatchObject({ required: true, seq: newest, interestRatePctPerMonth: null, lateFeeRatePctPerDay: { from: "1", to: "2" } });
    expect((await request("A")).status).toBe(409);
  });

  it("acknowledging the newest notice opens borrowing again and leaves an audit row with what was shown", async () => {
    const res = await call("A", "POST", "/me/rate-notice/acknowledge", { seq: await latestSeq() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ required: false });
    const created = await request("A");
    expect(created.status).toBe(201);
    expect((await prisma.borrower.findUniqueOrThrow({ where: { id: borrowerIds.A } })).rateNoticeAckAt).not.toBeNull();
    const rows = await prisma.auditLog.findMany({ where: { action: "borrower.rateNoticeAck", entityId: borrowerIds.A } });
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)!.detail).toMatchObject({ lateFeeRatePctPerDay: { from: "1", to: "2" } });
  });

  it("acknowledging twice writes nothing the second time", async () => {
    const seq = await latestSeq();
    await call("A", "POST", "/me/rate-notice/acknowledge", { seq });
    expect(await prisma.auditLog.count({ where: { action: "borrower.rateNoticeAck", entityId: borrowerIds.A } })).toBe(2);
  });

  it("each borrower acknowledges for themself: B is still held up after A acknowledged", async () => {
    expect((await notice("B")).required).toBe(true);
    expect((await request("B")).status).toBe(409);
  });

  it("refuses an acknowledgement for a notice that does not exist or a malformed one", async () => {
    for (const body of [{ seq: (await latestSeq()) + 1000 }, { seq: 0 }, { seq: "x" }, {}]) {
      expect((await call("B", "POST", "/me/rate-notice/acknowledge", body)).status).toBe(400);
    }
    expect((await notice("B")).required).toBe(true);
  });

  it("asks for nothing when the adjustments cancel each other out", async () => {
    await mkBorrower("C");
    await setRates({ interestRatePctPerMonth: "6" });
    await setRates({ interestRatePctPerMonth: "5" }); // 5 -> 6 -> 5: back to what C knew when they joined
    expect(await notice("C")).toMatchObject({ required: false });
    expect((await request("C")).status).toBe(201);
  });

  it("a borrower who joined after an adjustment owes no acknowledgement for it", async () => {
    await mkBorrower("D");
    expect(await notice("D")).toMatchObject({ required: false });
    expect((await request("D")).status).toBe(201);
    await setRates({ lateFeeRatePctPerDay: "3" });
    expect(await notice("D")).toMatchObject({ required: true, lateFeeRatePctPerDay: { from: "2", to: "3" } });
  });
});
