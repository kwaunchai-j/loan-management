import "dotenv/config";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FieldCipher } from "../src/lib/field-crypto.js";
import { hashPassword } from "../src/lib/password.js";
import {
  isProfileComplete,
  isValidNationalId,
  maskNationalId,
  nationalIdField,
  realNameProblem,
} from "../src/lib/borrower-fields.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_NATIONAL_ID, TEST_SLIP_STORAGE } from "./helpers.js";

describe("national ID number and real name rules (no database)", () => {
  it("accepts a 13-digit number with the right check digit, and only that", () => {
    expect(isValidNationalId(TEST_NATIONAL_ID)).toBe(true);
    expect(isValidNationalId("1101700230733")).toBe(false); // wrong check digit
    expect(isValidNationalId("110170023073")).toBe(false); // 12 digits
    expect(isValidNationalId("11017002307321")).toBe(false); // 14 digits
    expect(isValidNationalId("11017002307a2")).toBe(false);
    expect(isValidNationalId("")).toBe(false);
  });

  it("reads the number with dashes or spaces, and says why a bad one is refused", () => {
    expect(nationalIdField.parse(" 1-1017-00230-73-2 ")).toBe(TEST_NATIONAL_ID);
    expect(nationalIdField.parse("1 1017 00230 73 2")).toBe(TEST_NATIONAL_ID);
    expect(nationalIdField.safeParse("12345").error?.issues[0]?.message).toMatch(/13 หลัก/);
    expect(nationalIdField.safeParse("1101700230733").error?.issues[0]?.message).toMatch(/ไม่ถูกต้อง/);
  });

  it("masks all but the last four digits", () => {
    expect(maskNationalId(TEST_NATIONAL_ID)).toBe("*********0732");
    expect(maskNationalId("12")).toBe("**");
  });

  it.each(["สมชาย ใจดี", "Somchai Jaidee", "นางสาว สมหญิง รักดี", "John O'Neil-Smith Jr.", "  สมชาย    ใจดี  "])("%s is a real name", (name) => {
    expect(realNameProblem(name, "somchai")).toBeNull();
  });

  it.each([
    ["one word only", "สมชาย"],
    ["digits", "สมชาย ใจดี 2"],
    ["a login-style name", "somchai99"],
    ["symbols", "สมชาย @ใจดี"],
    ["empty", "   "],
    ["too long", `${"ก".repeat(150)} ${"ข".repeat(100)}`],
  ])("refuses %s", (_label, name) => {
    expect(realNameProblem(name, "someone")).not.toBeNull();
  });

  it("refuses a name that is just the login name", () => {
    expect(realNameProblem("Somchai Jaidee", "somchai jaidee")).toMatch(/ชื่อผู้ใช้/);
  });

  it("a profile is complete only when every part is there", () => {
    const full = {
      phone: "0812345678",
      bankName: "ธนาคาร",
      bankAccountNo: "enc",
      nationalId: "enc",
      idCardFileKey: "k.jpg",
      realNameConfirmedAt: new Date(),
    };
    expect(isProfileComplete(full)).toBe(true);
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      expect(isProfileComplete({ ...full, [key]: null }), key).toBe(false);
    }
  });
});

const prisma = new PrismaClient();
const dbUp = await prisma.$queryRaw`select 1`.then(() => true).catch(() => false);
const cipher = new FieldCipher(TEST_FIELD_KEY);

describe.skipIf(!dbUp)("identity: national ID, ID-card photo and real name (PostgreSQL)", () => {
  const marker = `idn${Date.now()}`;
  const PASSWORD = "first-password-1";
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let server: Server;
  let base: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const borrowerIds: Record<string, string> = {};

  const api = (as: string | null, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(as ? { cookie: cookies[as]! } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const patch = (as: string, body: unknown) => api(as, "PATCH", "/me/profile", body);
  const upload = (as: string | null, bytes: Buffer, type = "image/jpeg") =>
    fetch(`${base}/me/id-card`, { method: "POST", headers: { "content-type": type, ...(as ? { cookie: cookies[as]! } : {}) }, body: bytes.length ? new Uint8Array(bytes) : undefined });
  const row = (key: string) => prisma.borrower.findUniqueOrThrow({ where: { id: borrowerIds[key]! } });
  const adminPatch = (key: string, body: unknown) => api("admin", "PATCH", `/admin/borrowers/${borrowerIds[key]}`, body);

  async function login(username: string) {
    const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
    return res.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
  }

  /** `fresh`: only the name and a login, as the admin creates it. Otherwise everything but the identity part is filled in. */
  async function makeBorrower(key: string, options: { name?: string; contact?: boolean } = {}) {
    const user = await prisma.user.create({ data: { username: `${marker}-${key}`, role: "BORROWER", passwordHash: await hashPassword(PASSWORD), mustChangePassword: false } });
    userIds.push(user.id);
    const b = await prisma.borrower.create({
      data: {
        userId: user.id,
        fullName: options.name ?? `${marker} ${key}`,
        pdpaAcceptedAt: new Date(),
        ...(options.contact === false ? {} : { phone: "081-234-5678", bankName: "ธนาคารทดสอบ", bankAccountNo: cipher.encrypt("123-4-56789-0") }),
      },
    });
    borrowerIds[key] = b.id;
    cookies[key] = await login(`${marker}-${key}`);
  }

  beforeAll(async () => {
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
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const ids = Object.values(borrowerIds);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: ids } }] } });
    await prisma.borrower.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("the national ID number", () => {
    it("is stored encrypted and the borrower sees their own number back", async () => {
      await makeBorrower("num");
      const res = await patch("num", { nationalId: "1-1017-00230-73-2" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ nationalId: TEST_NATIONAL_ID, hasIdCard: false, profileComplete: false });
      const stored = await row("num");
      expect(stored.nationalId).not.toContain("1101700230732");
      expect(cipher.decrypt(stored.nationalId!)).toBe(TEST_NATIONAL_ID);
    });

    it.each([
      ["too short", "12345"],
      ["letters", "11017002307ab"],
      ["the wrong check digit", "1101700230733"],
      ["empty", ""],
    ])("refuses a number that is %s and saves nothing", async (_label, nationalId) => {
      await makeBorrower(`bad${_label.replace(/\W/g, "")}`);
      const key = `bad${_label.replace(/\W/g, "")}`;
      const res = await patch(key, { nationalId });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      expect((await row(key)).nationalId).toBeNull();
    });

    it("never reaches the audit trail in the clear", async () => {
      await makeBorrower("audit");
      await patch("audit", { nationalId: TEST_NATIONAL_ID });
      const logs = await prisma.auditLog.findMany({ where: { entityType: "Borrower", entityId: borrowerIds.audit, action: "borrower.selfUpdate" } });
      expect(logs).toHaveLength(1);
      const text = JSON.stringify(logs[0]!.detail);
      expect(text).not.toContain(TEST_NATIONAL_ID);
      expect(text).toContain("****0732");
    });
  });

  describe("the real name", () => {
    it("is stated once: the borrower's own spelling is saved, tidied, and marked confirmed", async () => {
      await makeBorrower("name");
      expect(await (await api("name", "GET", "/me/profile")).json()).toMatchObject({ realNameConfirmed: false });
      const res = await patch("name", { fullName: "  สมหญิง    รักดี " });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ fullName: "สมหญิง รักดี", realNameConfirmed: true });
      const stored = await row("name");
      expect(stored.fullName).toBe("สมหญิง รักดี");
      expect(stored.realNameConfirmedAt).not.toBeNull();
    });

    it.each([
      ["a single word", "สมหญิง"],
      ["digits", "สมหญิง รักดี 99"],
      ["a login-style name", "somying99"],
    ])("refuses %s, leaves the name unconfirmed and saves nothing sent with it", async (label, name) => {
      const key = `rn${label.replace(/\W/g, "")}`;
      await makeBorrower(key);
      const res = await patch(key, { fullName: name, phone: "0899999999" });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      expect((await row(key)).realNameConfirmedAt).toBeNull();
      expect((await row(key)).phone).toBe("081-234-5678");
    });

    it("is the lender's to change after that: a new name from the borrower is ignored", async () => {
      await makeBorrower("locked");
      await patch("locked", { fullName: "สมชาย ใจดี" });
      const res = await patch("locked", { fullName: "คนอื่น ที่ไหนสักแห่ง", phone: "0877777777" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ fullName: "สมชาย ใจดี", phone: "0877777777" });
      expect((await row("locked")).fullName).toBe("สมชาย ใจดี");
      // only the name: nothing to change, so it is refused like any empty update
      expect((await patch("locked", { fullName: "คนอื่น ที่ไหนสักแห่ง" })).status).toBe(400);
    });
  });

  describe("the ID-card photo", () => {
    it("is uploaded by the borrower, kept in the private store and shown to them only as 'uploaded'", async () => {
      await makeBorrower("photo");
      const res = await upload("photo", JPEG);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({ hasIdCard: true });
      expect(JSON.stringify(body)).not.toMatch(/idCardFileKey|\.jpg/);
      const stored = await row("photo");
      expect(stored.idCardFileKey).toMatch(/^[a-f0-9]{32}\.jpg$/);
      expect(await TEST_SLIP_STORAGE.get(stored.idCardFileKey!)).toEqual(JPEG);
    });

    it("accepts a PNG too, decided from the bytes and not from what the client says", async () => {
      await makeBorrower("png");
      expect((await upload("png", PNG, "application/octet-stream")).status).toBe(201);
      expect((await row("png")).idCardFileKey).toMatch(/\.png$/);
    });

    it("refuses anything that is not a JPEG or PNG, and an empty upload", async () => {
      await makeBorrower("junk");
      const text = await upload("junk", Buffer.from("not an image at all"), "image/jpeg");
      expect(text.status).toBe(415);
      expect((await text.json()).error.code).toBe("UNSUPPORTED_FILE_TYPE");
      const empty = await upload("junk", Buffer.alloc(0));
      expect(empty.status).toBe(400);
      expect((await row("junk")).idCardFileKey).toBeNull();
    });

    it("a second upload replaces the one on record; the first file is kept and its key stays in the audit trail", async () => {
      await makeBorrower("again");
      await upload("again", JPEG);
      const first = (await row("again")).idCardFileKey!;
      await upload("again", PNG);
      const second = (await row("again")).idCardFileKey!;
      expect(second).not.toBe(first);
      expect(await TEST_SLIP_STORAGE.exists(first)).toBe(true);
      const logs = await prisma.auditLog.findMany({ where: { entityType: "Borrower", entityId: borrowerIds.again, action: "borrower.idCardUpload" }, orderBy: { createdAt: "asc" } });
      expect(logs).toHaveLength(2);
      expect(logs[1]!.detail).toMatchObject({ before: { idCardFileKey: first }, after: { idCardFileKey: second } });
    });

    it("needs a signed-in borrower (not an admin, not nobody)", async () => {
      expect((await upload(null, JPEG)).status).toBe(401);
      expect((await upload("admin", JPEG)).status).toBe(403);
    });

    it("cannot be read back by any borrower route", async () => {
      await makeBorrower("private");
      await upload("private", JPEG);
      const key = (await row("private")).idCardFileKey!;
      for (const path of ["/me/id-card", `/me/id-card/${key}`, `/admin/slips/${key}`, `/admin/borrowers/${borrowerIds.private}/id-card`]) {
        const res = await api("private", "GET", path);
        expect([401, 403, 404], path).toContain(res.status);
        expect(res.headers.get("content-type") ?? "", path).not.toMatch(/image\//);
      }
    });
  });

  describe("everything together", () => {
    it("the borrower is held until real name, national ID, photo, phone, bank and account are all in", async () => {
      await makeBorrower("all", { contact: false });
      const claims = () => api("all", "GET", "/me/contracts");
      expect((await claims()).status).toBe(403);
      await patch("all", { phone: "0812345678", bankName: "ธนาคาร", bankAccountNo: "123-4-56789-0" });
      expect((await claims()).status).toBe(403);
      await patch("all", { nationalId: TEST_NATIONAL_ID });
      expect((await claims()).status).toBe(403);
      await patch("all", { fullName: "สมชาย ใจดี" });
      expect((await claims()).status).toBe(403);
      await upload("all", JPEG);
      expect((await claims()).status).toBe(200);
      expect(((await (await api("all", "GET", "/auth/me")).json()).user ?? {}).profileComplete).toBe(true);
    });
  });

  describe("the admin", () => {
    it("reads the full number on one borrower, a masked one in the list, and never the file key", async () => {
      await makeBorrower("view");
      await patch("view", { nationalId: TEST_NATIONAL_ID });
      await upload("view", JPEG);
      const one = await (await api("admin", "GET", `/admin/borrowers/${borrowerIds.view}`)).json();
      expect(one).toMatchObject({ nationalId: TEST_NATIONAL_ID, hasIdCard: true, realNameConfirmed: false });
      expect(JSON.stringify(one)).not.toContain("idCardFileKey");
      const list = await (await api("admin", "GET", `/admin/borrowers?q=${marker}%20view`)).json();
      const item = list.items.find((b: { id: string }) => b.id === borrowerIds.view);
      expect(item.nationalId).toBe("*********0732");
      expect(JSON.stringify(list)).not.toContain(TEST_NATIONAL_ID);
    });

    it("opens the ID-card photo, as an inert image that is never cached", async () => {
      await makeBorrower("open");
      await upload("open", PNG);
      const res = await api("admin", "GET", `/admin/borrowers/${borrowerIds.open}/id-card`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    });

    it("gets 404 when there is no photo yet, and only an admin may ask at all", async () => {
      await makeBorrower("nophoto");
      expect((await api("admin", "GET", `/admin/borrowers/${borrowerIds.nophoto}/id-card`)).status).toBe(404);
      expect((await api("nophoto", "GET", `/admin/borrowers/${borrowerIds.nophoto}/id-card`)).status).toBe(403);
      expect((await api(null, "GET", `/admin/borrowers/${borrowerIds.nophoto}/id-card`)).status).toBe(401);
    });

    it("can give the number when creating the account, and refuses a bad one", async () => {
      const username = `${marker}-created`;
      const ok = await api("admin", "POST", "/admin/borrowers", { username, password: "temporary-pass-9", fullName: `${marker} created`, nationalId: TEST_NATIONAL_ID });
      expect(ok.status).toBe(201);
      const body = await ok.json();
      borrowerIds.created = body.id;
      userIds.push(body.account.userId);
      expect(body).toMatchObject({ nationalId: TEST_NATIONAL_ID, hasIdCard: false, realNameConfirmed: false });
      const bad = await api("admin", "POST", "/admin/borrowers", { username: `${marker}-created2`, password: "temporary-pass-9", fullName: "x", nationalId: "123" });
      expect(bad.status).toBe(400);
    });

    it("can clear the number, take the photo off the record or ask for the name again: the borrower is held again", async () => {
      await makeBorrower("redo");
      await patch("redo", { nationalId: TEST_NATIONAL_ID, fullName: "สมชาย ใจดี" });
      await upload("redo", JPEG);
      const key = (await row("redo")).idCardFileKey!;
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(200);

      expect((await adminPatch("redo", { nationalId: null })).status).toBe(200);
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(403);
      await patch("redo", { nationalId: TEST_NATIONAL_ID });
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(200);

      expect((await adminPatch("redo", { removeIdCard: true })).status).toBe(200);
      expect((await row("redo")).idCardFileKey).toBeNull();
      expect(await TEST_SLIP_STORAGE.exists(key)).toBe(true); // the file stays; only the record lets go
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(403);
      await upload("redo", JPEG);
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(200);

      expect((await adminPatch("redo", { reconfirmName: true })).status).toBe(200);
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(403);
      expect((await patch("redo", { fullName: "สมชาย ใจดี" })).status).toBe(200);
      expect((await api("redo", "GET", "/me/contracts")).status).toBe(200);
    });

    it("can still correct the name itself, and the audit row masks the number", async () => {
      await makeBorrower("fixname");
      await patch("fixname", { nationalId: TEST_NATIONAL_ID, fullName: "สมชาย ใจดี" });
      expect((await adminPatch("fixname", { fullName: "สมชาย ใจดีมาก" })).status).toBe(200);
      expect((await row("fixname")).fullName).toBe("สมชาย ใจดีมาก");
      const logs = await prisma.auditLog.findMany({ where: { entityId: borrowerIds.fixname, action: "borrower.update" } });
      expect(JSON.stringify(logs.map((l) => l.detail))).not.toContain(TEST_NATIONAL_ID);
    });
  });
});
