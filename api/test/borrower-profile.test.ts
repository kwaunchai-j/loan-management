import "dotenv/config";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FieldCipher } from "../src/lib/field-crypto.js";
import { hashPassword } from "../src/lib/password.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_NATIONAL_ID, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma.$queryRaw`select 1`.then(() => true).catch(() => false);
const cipher = new FieldCipher(TEST_FIELD_KEY);

/** CR-5: the admin creates the account with the name; the borrower fills in phone, bank and account number. */
describe.skipIf(!dbUp)("the borrower fills in their own details (PostgreSQL)", () => {
  const marker = `prof${Date.now()}`;
  const PASSWORD = "first-password-1";
  let server: Server;
  let base: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const borrowerIds: Record<string, string> = {};
  let originalSetting: Awaited<ReturnType<typeof prisma.setting.findUnique>>;

  const tomorrow = () => {
    const d = bangkokToday();
    d.setUTCDate(d.getUTCDate() + 20);
    return formatDateOnly(d);
  };
  const api = (as: string | null, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(as ? { cookie: cookies[as]! } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const patch = (as: string | null, body: unknown) => api(as, "PATCH", "/me/profile", body);
  const requestLoan = (as: string) => api(as, "POST", "/loan-requests", { amount: "1000", requestedDueDate: tomorrow() });
  const row = (key: string) => prisma.borrower.findUniqueOrThrow({ where: { id: borrowerIds[key]! } });
  const FULL = { phone: "081-234-5678", bankName: "ธนาคารกสิกรไทย", bankAccountNo: "123-4-56789-0" };

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const uploadIdCard = (as: string, bytes: Buffer = JPEG, type = "image/jpeg") =>
    fetch(`${base}/me/id-card`, { method: "POST", headers: { "content-type": type, cookie: cookies[as]! }, body: new Uint8Array(bytes) });
  /** The identity part of the details (CR-8): real name, national ID number and the ID-card photo. */
  async function finishIdentity(as: string) {
    expect((await patch(as, { fullName: "สมหญิง รักดี", nationalId: TEST_NATIONAL_ID })).status).toBe(200);
    expect((await uploadIdCard(as)).status).toBe(201);
  }

  async function login(username: string) {
    const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
    return res.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
  }

  async function makeBorrower(key: string, data: { phone?: string; bankName?: string; bankAccountNo?: string; pdpa?: boolean } = {}) {
    const user = await prisma.user.create({ data: { username: `${marker}-${key}`, role: "BORROWER", passwordHash: await hashPassword(PASSWORD), mustChangePassword: false } });
    userIds.push(user.id);
    const b = await prisma.borrower.create({
      data: {
        userId: user.id,
        fullName: `${marker} ${key}`,
        phone: data.phone ?? null,
        bankName: data.bankName ?? null,
        bankAccountNo: data.bankAccountNo ? cipher.encrypt(data.bankAccountNo) : null,
        // a borrower who has all of FULL is a finished one: real name confirmed, national ID and ID-card photo on record too (CR-8)
        ...(data.bankAccountNo
          ? { nationalId: cipher.encrypt(TEST_NATIONAL_ID), idCardFileKey: `${"a".repeat(32)}.jpg`, realNameConfirmedAt: new Date() }
          : {}),
        pdpaAcceptedAt: data.pdpa === false ? null : new Date(),
      },
    });
    borrowerIds[key] = b.id;
    cookies[key] = await login(`${marker}-${key}`);
  }

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1, interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" }, update: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" } });
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, role: "ADMIN", passwordHash: await hashPassword(PASSWORD), mustChangePassword: false } });
    userIds.push(admin.id);
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
    cookies.admin = await login(`${marker}-admin`);
    await makeBorrower("empty"); // as the admin creates it: a name and a login
    await makeBorrower("done", FULL);
    await makeBorrower("other");
    await makeBorrower("nopdpa", { pdpa: false });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const ids = Object.values(borrowerIds);
    await prisma.loanRequest.deleteMany({ where: { borrowerId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: ids } }] } });
    await prisma.borrower.deleteMany({ where: { id: { in: ids } } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (originalSetting) {
      await prisma.setting.create({ data: { id: 1, interestRatePctPerMonth: originalSetting.interestRatePctPerMonth, lateFeeRatePctPerDay: originalSetting.lateFeeRatePctPerDay, paymentBankName: originalSetting.paymentBankName, paymentAccountName: originalSetting.paymentAccountName, paymentAccountNo: originalSetting.paymentAccountNo, updatedById: originalSetting.updatedById } });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("GET /me/profile", () => {
    it("says the profile is not complete while phone, bank or account number is missing", async () => {
      const body = await (await api("empty", "GET", "/me/profile")).json();
      expect(body).toMatchObject({ phone: null, bankName: null, bankAccountNo: null, profileComplete: false });
    });

    it("says it is complete once all three are there, and shows the borrower their own number", async () => {
      expect(await (await api("done", "GET", "/me/profile")).json()).toMatchObject({ ...FULL, profileComplete: true, fullName: `${marker} done` });
    });
  });

  describe("PATCH /me/profile", () => {
    it("fills in the three details, stores the account number encrypted, and the profile becomes complete", async () => {
      const res = await patch("other", { phone: "  089-111-2222 ", bankName: " ธนาคารไทยพาณิชย์ ", bankAccountNo: " 987-6-54321-0 " });
      expect(res.status).toBe(200);
      // phone, bank and account number alone are no longer enough: the identity part (CR-8) is still missing
      expect(await res.json()).toMatchObject({ phone: "089-111-2222", bankName: "ธนาคารไทยพาณิชย์", bankAccountNo: "987-6-54321-0", profileComplete: false });
      await finishIdentity("other");
      expect(await (await api("other", "GET", "/me/profile")).json()).toMatchObject({ profileComplete: true });
      const stored = await row("other");
      expect([stored.phone, stored.bankName]).toEqual(["089-111-2222", "ธนาคารไทยพาณิชย์"]);
      expect(stored.bankAccountNo).not.toContain("987");
      expect(cipher.decrypt(stored.bankAccountNo!)).toBe("987-6-54321-0");
    });

    it("can fill in one detail at a time and leaves the others alone", async () => {
      await makeBorrower("step");
      expect((await (await patch("step", { phone: "0812345678" })).json())).toMatchObject({ phone: "0812345678", bankName: null, profileComplete: false });
      expect((await (await patch("step", { bankName: "ธนาคารกรุงเทพ" })).json())).toMatchObject({ phone: "0812345678", bankName: "ธนาคารกรุงเทพ", profileComplete: false });
      expect((await (await patch("step", { bankAccountNo: "1234567890" })).json())).toMatchObject({ bankAccountNo: "1234567890", profileComplete: false });
      await finishIdentity("step");
      expect(await (await api("step", "GET", "/me/profile")).json()).toMatchObject({ profileComplete: true });
    });

    it("can correct a detail that was already there", async () => {
      await makeBorrower("fix", FULL);
      const res = await patch("fix", { bankAccountNo: "555-5-55555-5" });
      expect(res.status).toBe(200);
      expect(cipher.decrypt((await row("fix")).bankAccountNo!)).toBe("555-5-55555-5");
      expect((await row("fix")).phone).toBe(FULL.phone);
    });

    it.each([
      ["a phone with letters", { phone: "abc" }],
      ["a phone that is too short", { phone: "12345" }],
      ["an empty phone", { phone: "" }],
      ["an empty bank name", { bankName: "  " }],
      ["a bank name over 100 characters", { bankName: "ก".repeat(101) }],
      ["an account number with letters", { bankAccountNo: "12ab34567" }],
      ["an account number that is too short", { bankAccountNo: "12345" }],
      ["an empty account number", { bankAccountNo: "" }],
      ["a number instead of text", { phone: 812345678 }],
    ])("refuses %s and saves nothing", async (_n, body) => {
      await makeBorrower("bad", FULL);
      const before = await row("bad");
      const res = await patch("bad", { ...body });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      expect(await row("bad")).toMatchObject({ phone: before.phone, bankName: before.bankName, bankAccountNo: before.bankAccountNo });
      await prisma.borrower.deleteMany({ where: { id: borrowerIds.bad } });
      await prisma.user.deleteMany({ where: { username: `${marker}-bad` } });
    });

    it("refuses an empty body, and one that only tries to change something that is not theirs", async () => {
      for (const body of [{}, { fullName: "ชื่อใหม่" }, { isActive: false }]) {
        expect((await patch("done", body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await row("done")).fullName).toBe(`${marker} done`);
    });

    it("ignores the name even when it is sent along with real details", async () => {
      await patch("done", { phone: "0899999999", fullName: "ชื่อที่แก้เอง", userId: "x", pdpaAcceptedAt: null });
      const stored = await row("done");
      expect(stored.phone).toBe("0899999999");
      expect(stored.fullName).toBe(`${marker} done`);
      expect(stored.pdpaAcceptedAt).not.toBeNull();
      await patch("done", { phone: FULL.phone });
    });

    it("works only on the borrower in the session: naming another borrower is refused and changes nothing", async () => {
      const res = await patch("empty", { phone: "0800000000", borrowerId: borrowerIds.done });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("BORROWER_ID_NOT_ALLOWED");
      expect((await row("done")).phone).toBe(FULL.phone);
      expect((await row("empty")).phone).toBeNull();
    });

    it("is for borrowers who accepted the PDPA terms: a visitor gets 401, an admin 403, an unconsented borrower 403", async () => {
      expect((await patch(null, FULL)).status).toBe(401);
      expect((await patch("admin", FULL)).status).toBe(403);
      const noPdpa = await patch("nopdpa", FULL);
      expect(noPdpa.status).toBe(403);
      expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
      expect((await row("nopdpa")).phone).toBeNull();
    });

    it("writes an audit row by the borrower, naming the fields and masking the account number", async () => {
      await makeBorrower("audit");
      await patch("audit", { phone: "0877777777", bankAccountNo: "111-2-33333-4" });
      const rows = await prisma.auditLog.findMany({ where: { action: "borrower.selfUpdate", entityId: borrowerIds.audit } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe(userIds[userIds.length - 1]);
      expect(rows[0]!.detail).toMatchObject({ changedFields: ["phone", "bankAccountNo"], after: { phone: "0877777777" } });
      expect(JSON.stringify(rows[0]!.detail)).not.toContain("111-2-33333-4");
    });
  });

  describe("a borrower whose details are incomplete can use nothing but their profile page (CR-6)", () => {
    const CLOSED = [
      ["GET", "/me/contracts"],
      ["GET", "/me/loan-requests"],
      ["GET", "/me/payment-account"],
      ["GET", "/me/payment-submissions"],
      ["GET", "/loan-requests/interest-estimate?amount=1000"],
      ["POST", "/loan-requests"],
      ["POST", "/loan-requests/someid/cancel"],
    ] as const;

    it("every other borrower route answers 403 PROFILE_REQUIRED, and no request is saved", async () => {
      for (const [method, path] of CLOSED) {
        const res = await api("empty", method, path, method === "POST" ? { amount: "1000", requestedDueDate: tomorrow() } : undefined);
        expect(res.status, `${method} ${path}`).toBe(403);
        const body = await res.json();
        expect(body.error.code, `${method} ${path}`).toBe("PROFILE_REQUIRED");
        expect(body.error.message).toContain("เลขบัญชี");
      }
      expect(await prisma.loanRequest.count({ where: { borrowerId: borrowerIds.empty } })).toBe(0);
    });

    it("the profile page itself stays open (read and write), and so does the PDPA step", async () => {
      expect((await api("empty", "GET", "/me/profile")).status).toBe(200);
      expect((await patch("empty", {})).status).toBe(400); // reached, then refused for being empty: not a 403
      expect((await api("empty", "GET", "/pdpa")).status).toBe(200);
    });

    it.each([
      ["no phone", { bankName: "ธนาคารกรุงเทพ", bankAccountNo: "1234567890" }],
      ["no bank", { phone: "0812345678", bankAccountNo: "1234567890" }],
      ["no account number", { phone: "0812345678", bankName: "ธนาคารกรุงเทพ" }],
    ])("a borrower with %s is closed out too", async (label, data) => {
      const key = `gate-${label.replace(/\W/g, "")}`;
      await makeBorrower(key, data);
      expect((await api(key, "GET", "/me/contracts")).status).toBe(403);
      expect((await requestLoan(key)).status).toBe(403);
      expect(await prisma.loanRequest.count({ where: { borrowerId: borrowerIds[key] } })).toBe(0);
    });

    it("opens the moment the borrower has filled the three in themself", async () => {
      await makeBorrower("later");
      expect((await requestLoan("later")).status).toBe(403);
      expect((await patch("later", FULL)).status).toBe(200);
      expect((await api("later", "GET", "/me/contracts")).status).toBe(403); // the identity part is still missing (CR-8)
      await finishIdentity("later");
      expect((await api("later", "GET", "/me/contracts")).status).toBe(200);
      expect((await requestLoan("later")).status).toBe(201);
      expect(await prisma.loanRequest.count({ where: { borrowerId: borrowerIds.later } })).toBe(1);
    });

    it("does not touch a borrower whose details are complete", async () => {
      expect((await api("done", "GET", "/me/contracts")).status).toBe(200);
      expect((await requestLoan("done")).status).toBe(201);
    });

    it("does not stop the lender from filing a request for a borrower (the admin route is not gated)", async () => {
      const res = await api("admin", "POST", "/admin/loan-requests", { borrowerId: borrowerIds.empty, amount: "500", requestedDueDate: tomorrow() });
      expect(res.status).toBe(201);
    });

    it("an administrator is not affected by any of this", async () => {
      expect((await api("admin", "GET", "/admin/settings")).status).toBe(200);
    });
  });

  describe("/auth/me tells the web app whether the details are complete", () => {
    it("false for an incomplete borrower, true for a complete one, null for an admin", async () => {
      expect((await (await api("empty", "GET", "/auth/me")).json()).user.profileComplete).toBe(false);
      expect((await (await api("done", "GET", "/auth/me")).json()).user.profileComplete).toBe(true);
      expect((await (await api("admin", "GET", "/auth/me")).json()).user.profileComplete).toBeNull();
    });
  });

  describe("the admin clears a borrower's details: they must fill them in again before using the system", () => {
    const adminPatch = (key: string, body: unknown) => api("admin", "PATCH", `/admin/borrowers/${borrowerIds[key]}`, body);

    it("a borrower who was using the system is shut out at once (their session stays valid), until they fill the details in again", async () => {
      await makeBorrower("wiped", FULL);
      expect((await api("wiped", "GET", "/me/contracts")).status).toBe(200);

      const res = await adminPatch("wiped", { phone: null, bankName: null, bankAccountNo: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ phone: null, bankName: null, bankAccountNo: null });
      const stored = await row("wiped");
      expect([stored.phone, stored.bankName, stored.bankAccountNo]).toEqual([null, null, null]);

      const closed = await api("wiped", "GET", "/me/contracts");
      expect(closed.status).toBe(403);
      expect((await closed.json()).error.code).toBe("PROFILE_REQUIRED");
      expect((await (await api("wiped", "GET", "/auth/me")).json()).user.profileComplete).toBe(false);
      expect(await (await api("wiped", "GET", "/me/profile")).json()).toMatchObject({ phone: null, profileComplete: false, fullName: `${marker} wiped` });

      expect((await patch("wiped", { phone: "089-000-1111", bankName: "ธนาคารออมสิน", bankAccountNo: "000-1-11111-1" })).status).toBe(200);
      expect((await api("wiped", "GET", "/me/contracts")).status).toBe(200);
    });

    it("clearing just one detail is enough: the borrower must fill that one in again", async () => {
      await makeBorrower("partial", FULL);
      expect((await adminPatch("partial", { bankAccountNo: null })).status).toBe(200);
      expect((await row("partial")).phone).toBe(FULL.phone); // the rest is kept
      expect((await api("partial", "GET", "/me/contracts")).status).toBe(403);
      expect((await patch("partial", { bankAccountNo: "222-3-33333-3" })).status).toBe(200);
      expect((await api("partial", "GET", "/me/contracts")).status).toBe(200);
    });

    it("the name cannot be cleared, and clearing something the borrower never had is harmless", async () => {
      await makeBorrower("noname");
      expect((await adminPatch("noname", { fullName: null })).status).toBe(400);
      expect((await adminPatch("noname", { phone: null })).status).toBe(200);
      expect((await row("noname")).fullName).toBe(`${marker} noname`);
    });

    it("is recorded in the audit log with the account number masked", async () => {
      await makeBorrower("audited", FULL);
      await adminPatch("audited", { bankAccountNo: null, phone: null });
      const rows = await prisma.auditLog.findMany({ where: { action: "borrower.update", entityId: borrowerIds.audited } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatchObject({ before: { phone: FULL.phone, bankAccountNo: "****7890" }, after: { phone: null, bankAccountNo: null } });
      expect(JSON.stringify(rows[0]!.detail)).not.toContain("56789");
    });

    it("only an administrator can do it", async () => {
      await makeBorrower("guard", FULL);
      const res = await api("guard", "PATCH", `/admin/borrowers/${borrowerIds.guard}`, { phone: null });
      expect(res.status).toBe(403);
      expect((await row("guard")).phone).toBe(FULL.phone);
    });
  });

  describe("the whole path: the admin creates the account, the borrower comes in and fills in their own details", () => {
    it("works from the admin form to a loan request", async () => {
      const username = `${marker}-journey`;
      const created = await api("admin", "POST", "/admin/borrowers", { username, password: "temporary-pass-9", fullName: `${marker} journey` });
      expect(created.status).toBe(201);
      const borrower = await created.json();
      borrowerIds.journey = borrower.id;
      userIds.push(borrower.account.userId);
      expect(borrower).toMatchObject({ phone: null, bankName: null, bankAccountNo: null });

      // first login: the temporary password must be changed before anything else
      const first = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temporary-pass-9" }) });
      cookies.journey = first.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
      expect((await patch("journey", FULL)).status).toBe(403); // not yet: password change comes first
      const changed = await api("journey", "POST", "/auth/change-password", { currentPassword: "temporary-pass-9", newPassword: "my-new-password-77" });
      expect(changed.status).toBe(200);
      // the old session ends with the old password: sign in again with the new one
      const again = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "my-new-password-77" }) });
      cookies.journey = again.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
      await prisma.borrower.update({ where: { id: borrower.id }, data: { pdpaAcceptedAt: new Date(), pdpaVersion: "test" } }); // the PDPA step (tested in pdpa.test.ts)

      expect((await requestLoan("journey")).status).toBe(403); // details first
      expect((await patch("journey", FULL)).status).toBe(200);
      expect((await requestLoan("journey")).status).toBe(403); // phone, bank and account are not enough any more (CR-8)
      expect((await patch("journey", { fullName: "สมหญิง รักดี", nationalId: TEST_NATIONAL_ID })).status).toBe(200);
      expect((await requestLoan("journey")).status).toBe(403); // the ID-card photo is still missing
      const photo = await fetch(`${base}/me/id-card`, { method: "POST", headers: { "content-type": "image/jpeg", cookie: cookies.journey! }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
      expect(photo.status).toBe(201);
      expect((await requestLoan("journey")).status).toBe(201);

      // and the lender sees what the borrower typed
      const seen = await (await api("admin", "GET", `/admin/borrowers/${borrower.id}`)).json();
      expect(seen).toMatchObject(FULL);
    });
  });
});
