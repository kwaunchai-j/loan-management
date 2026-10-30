import "dotenv/config";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/password.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma.$queryRaw`select 1`.then(() => true).catch(() => false);

const GOOD = { bankName: "ธนาคารกสิกรไทย", accountName: "นายสมชาย ใจดี", accountNo: "123-4-56789-0" };

describe.skipIf(!dbUp)("the lender's payment account (PostgreSQL)", () => {
  const marker = `pay${Date.now()}`;
  const PASSWORD = "first-password-1";
  let server: Server;
  let base: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const borrowerIds: string[] = [];
  let original: Awaited<ReturnType<typeof prisma.setting.findUnique>>;

  const put = (as: string | null, body: unknown) =>
    fetch(`${base}/admin/payment-account`, { method: "PUT", headers: { "content-type": "application/json", ...(as ? { cookie: cookies[as]! } : {}) }, body: JSON.stringify(body) });
  const adminGet = (as: string | null) => fetch(`${base}/admin/payment-account`, { headers: as ? { cookie: cookies[as]! } : {} });
  const mine = (as: string | null) => fetch(`${base}/me/payment-account`, { headers: as ? { cookie: cookies[as]! } : {} });
  const clearRow = () => prisma.setting.updateMany({ where: { id: 1 }, data: { paymentBankName: null, paymentAccountName: null, paymentAccountNo: null } });

  beforeAll(async () => {
    original = await prisma.setting.findUnique({ where: { id: 1 } });
    await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1, interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" }, update: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" } });
    const passwordHash = await hashPassword(PASSWORD);
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"], ["nopdpa", "BORROWER"]] as const) {
      const user = await prisma.user.create({ data: { username: `${marker}-${u}`, role, passwordHash, mustChangePassword: false } });
      userIds.push(user.id);
      if (role === "BORROWER") {
        borrowerIds.push((await prisma.borrower.create({ data: { userId: user.id, fullName: `${marker} ${u}`, pdpaAcceptedAt: u === "nopdpa" ? null : new Date() } })).id);
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

  // every test starts from the same state: rates set, no payment account, no audit rows of ours
  beforeEach(async () => {
    await prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" },
      update: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.5" },
    });
    await clearRow();
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowerIds } } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (original) {
      await prisma.setting.create({
        data: {
          id: 1,
          interestRatePctPerMonth: original.interestRatePctPerMonth,
          lateFeeRatePctPerDay: original.lateFeeRatePctPerDay,
          paymentBankName: original.paymentBankName,
          paymentAccountName: original.paymentAccountName,
          paymentAccountNo: original.paymentAccountNo,
          updatedById: original.updatedById,
        },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("the admin sets it", () => {
    it("starts empty", async () => {
      expect(await (await adminGet("admin")).json()).toMatchObject({ bankName: null, accountName: null, accountNo: null });
    });

    it("saves the account, returns it with who changed it, and it persists", async () => {
      const res = await put("admin", GOOD);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ...GOOD, updatedBy: { username: `${marker}-admin` } });
      expect(await (await adminGet("admin")).json()).toMatchObject(GOOD);
      const row = await prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect([row.paymentBankName, row.paymentAccountName, row.paymentAccountNo]).toEqual([GOOD.bankName, GOOD.accountName, GOOD.accountNo]);
    });

    it("trims the text it is given", async () => {
      const body = await (await put("admin", { bankName: "  ธนาคารไทยพาณิชย์  ", accountName: "\tบริษัท ตัวอย่าง จำกัด\n", accountNo: " 1234567890 " })).json();
      expect(body).toMatchObject({ bankName: "ธนาคารไทยพาณิชย์", accountName: "บริษัท ตัวอย่าง จำกัด", accountNo: "1234567890" });
    });

    it.each(["1234567890", "123-4-56789-0", "123 4 56789 0", "12345", "1".repeat(30)])("accepts the account number %j", async (accountNo) => {
      expect((await put("admin", { ...GOOD, accountNo })).status).toBe(200);
    });

    it.each(["", "abc", "1234", "12-", "-1234567", "1234A67890", "123_456_789", "1".repeat(31), "12 34 5\n6789", "<script>alert(1)</script>"])("refuses the account number %j", async (accountNo) => {
      if (accountNo === "") return; // an empty number with the other two filled in is the 'partial' case, tested below
      const res = await put("admin", { ...GOOD, accountNo });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ paymentAccountNo: null });
    });

    it("refuses half an account: all three parts or none", async () => {
      for (const body of [
        { bankName: GOOD.bankName, accountName: null, accountNo: null },
        { bankName: null, accountName: GOOD.accountName, accountNo: GOOD.accountNo },
        { ...GOOD, accountNo: "" },
        { ...GOOD, bankName: "   " },
      ]) {
        const res = await put("admin", body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect((await res.json()).error.message).toContain("ให้ครบทั้ง 3 ช่อง");
      }
      expect(await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ paymentBankName: null, paymentAccountName: null, paymentAccountNo: null });
    });

    it("refuses parts that are too long, are not text, or are missing from the body (an empty body never wipes the account)", async () => {
      await put("admin", GOOD);
      for (const body of [{ ...GOOD, bankName: "ก".repeat(101) }, { ...GOOD, accountName: "ก".repeat(151) }, { ...GOOD, accountNo: 1234567890 }, {}, { bankName: GOOD.bankName }, { ...GOOD, accountNo: undefined }]) {
        expect((await put("admin", body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(await (await adminGet("admin")).json()).toMatchObject(GOOD); // untouched by every refused attempt
    });

    it("blank or null in all three parts removes the account", async () => {
      await put("admin", GOOD);
      const res = await put("admin", { bankName: "", accountName: null, accountNo: "  " });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ bankName: null, accountName: null, accountNo: null });
      expect(await (await mine("borrower")).json()).toMatchObject({ configured: false });
    });

    it("replaces an earlier account (it is one account for the system)", async () => {
      await put("admin", GOOD);
      await put("admin", { bankName: "ธนาคารกรุงเทพ", accountName: "บริษัท ใหม่ จำกัด", accountNo: "987-6-54321-0" });
      expect(await prisma.setting.count({ where: { id: 1 } })).toBe(1);
      expect(await (await adminGet("admin")).json()).toMatchObject({ bankName: "ธนาคารกรุงเทพ", accountNo: "987-6-54321-0" });
    });

    it("is for the ADMIN only (visitor 401, borrower 403) for reading and for changing", async () => {
      for (const as of [null, "borrower"]) {
        const status = as === null ? 401 : 403;
        expect((await adminGet(as)).status).toBe(status);
        expect((await put(as, GOOD)).status).toBe(status);
      }
      expect(await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ paymentAccountNo: null });
    });

    it("works when no Setting row exists yet (a fresh system)", async () => {
      await prisma.setting.deleteMany({ where: { id: 1 } });
      expect((await put("admin", GOOD)).status).toBe(200);
      expect(await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ paymentAccountNo: GOOD.accountNo, interestRatePctPerMonth: null });
    });

    it("writes an audit row with who, before and after — but only the last 4 digits of the number", async () => {
      await put("admin", GOOD);
      await put("admin", { ...GOOD, accountNo: "987-6-54321-0" });
      const rows = await prisma.auditLog.findMany({ where: { action: "setting.paymentAccount.update", actorId: userIds[0] }, orderBy: { createdAt: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[1]!.detail).toMatchObject({
        before: { bankName: GOOD.bankName, accountName: GOOD.accountName, accountNoLast4: "7890" },
        after: { accountNoLast4: "3210" },
      });
      const text = JSON.stringify(rows.map((r) => r.detail));
      expect(text).not.toContain("123-4-56789-0");
      expect(text).not.toContain("987-6-54321-0");
    });

    it("leaves the rates alone, and a rates change leaves the account alone", async () => {
      await put("admin", GOOD);
      const row = await prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect([row.interestRatePctPerMonth!.toString(), row.lateFeeRatePctPerDay!.toString()]).toEqual(["3", "0.5"]);
      const patch = await fetch(`${base}/admin/settings`, { method: "PATCH", headers: { "content-type": "application/json", cookie: cookies.admin! }, body: JSON.stringify({ interestRatePctPerMonth: "4" }) });
      expect(patch.status).toBe(200);
      expect(await (await adminGet("admin")).json()).toMatchObject(GOOD);
      expect((await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).interestRatePctPerMonth!.toString()).toBe("4");
    });
  });

  describe("the borrower reads it", () => {
    it("sees the account once the admin has set it, and nothing else", async () => {
      await put("admin", GOOD);
      const res = await mine("borrower");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ configured: true, ...GOOD });
      expect(Object.keys(body).sort()).toEqual(["accountName", "accountNo", "bankName", "configured"]);
    });

    it("is told 'not configured' (all null) until then", async () => {
      expect(await (await mine("borrower")).json()).toEqual({ configured: false, bankName: null, accountName: null, accountNo: null });
    });

    it("never shows half an account, even if the row was filled in by hand", async () => {
      await prisma.setting.update({ where: { id: 1 }, data: { paymentBankName: "ธนาคารลับ" } });
      const body = await (await mine("borrower")).json();
      expect(body).toEqual({ configured: false, bankName: null, accountName: null, accountNo: null });
      expect(JSON.stringify(body)).not.toContain("ธนาคารลับ");
    });

    it("follows a change at once", async () => {
      await put("admin", GOOD);
      await put("admin", { ...GOOD, bankName: "ธนาคารออมสิน" });
      expect((await (await mine("borrower")).json()).bankName).toBe("ธนาคารออมสิน");
    });

    it("is for borrowers who have accepted the PDPA terms: a visitor gets 401, an admin 403, others 403", async () => {
      await put("admin", GOOD);
      expect((await mine(null)).status).toBe(401);
      expect((await mine("admin")).status).toBe(403);
      const noPdpa = await mine("nopdpa");
      expect(noPdpa.status).toBe(403);
      expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
    });
  });
});
