import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { forbidClientBorrowerId, sessionBorrowerId } from "../src/auth/borrower-scope.js";
import { hashPassword } from "../src/lib/password.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t103${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

const profile = (suffix: string, extra: object = {}) => ({
  username: name(suffix),
  password: "initial-password-1",
  fullName: `${marker} ${suffix}`,
  phone: "081-234-5678",
  bankName: "ธนาคารตัวอย่าง",
  bankAccountNo: "123-4-56789-0",
  ...extra,
});

describe.skipIf(!dbUp)("admin borrower management (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  let adminCookie: string;
  let adminId: string;
  let borrowerCookie: string;
  let ownBorrowerId: string;

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  const call = (method: string, path: string, body?: unknown, cookie: string | undefined = adminCookie) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const login = (username: string, password: string) =>
    call("POST", "/auth/login", { username, password }, undefined);

  async function createBorrower(suffix: string, extra: object = {}) {
    const res = await call("POST", "/admin/borrowers", profile(suffix, extra));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; account: { userId: string } };
  }

  const auditFor = (borrowerId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityType: "Borrower", entityId: borrowerId, action } });

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    const admin = await prisma.user.create({ data: { username: name("admin"), role: "ADMIN", ...base } });
    adminId = admin.id;
    const borrowerUser = await prisma.user.create({ data: { username: name("self"), role: "BORROWER", ...base } });
    const own = await prisma.borrower.create({
      data: { userId: borrowerUser.id, fullName: `${marker} self`, pdpaAcceptedAt: new Date() },
    });
    ownBorrowerId = own.id;

    const built = buildApp({
      prisma,
      sessionSecret: SECRET,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
    });
    built.app.all("/_mine", built.auth!.authorizeBorrower, forbidClientBorrowerId, (req, res) => {
      res.json({ borrowerId: sessionBorrowerId(req) });
    });
    server = built.app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    adminCookie = cookieOf(await login(name("admin"), PASSWORD));
    borrowerCookie = cookieOf(await login(name("self"), PASSWORD));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.borrower.deleteMany({ where: { fullName: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  describe("access", () => {
    it("is for ADMIN only", async () => {
      expect((await call("GET", "/admin/borrowers", undefined, "")).status).toBe(401);
      expect((await call("GET", "/admin/borrowers", undefined, borrowerCookie)).status).toBe(403);
      expect((await call("POST", "/admin/borrowers", profile("nope"), borrowerCookie)).status).toBe(403);
      expect(await prisma.user.count({ where: { username: name("nope") } })).toBe(0);
    });
  });

  describe("create", () => {
    it("creates the login and the borrower, returns the bank account to the admin only", async () => {
      const res = await call("POST", "/admin/borrowers", profile("created"));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        fullName: `${marker} created`,
        phone: "081-234-5678",
        bankName: "ธนาคารตัวอย่าง",
        bankAccountNo: "123-4-56789-0",
        pdpaAcceptedAt: null,
        account: { username: name("created"), isActive: true, mustChangePassword: true },
      });
      expect(JSON.stringify(body)).not.toMatch(/initial-password|passwordHash|scrypt/);

      const user = await prisma.user.findUniqueOrThrow({ where: { username: name("created") } });
      expect(user.role).toBe("BORROWER");
      expect(user.mustChangePassword).toBe(true);
      expect(user.passwordHash.startsWith("scrypt$")).toBe(true);
      expect(user.passwordHash).not.toContain("initial-password-1");
    });

    it("stores the account number encrypted, never in plain text (decision D1)", async () => {
      const b = await createBorrower("enc");
      const row = await prisma.borrower.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.bankAccountNo).toMatch(/^enc:v1:/);
      expect(row.bankAccountNo).not.toContain("56789");

      const got = await (await call("GET", `/admin/borrowers/${b.id}`)).json();
      expect(got.bankAccountNo).toBe("123-4-56789-0");
      const listed = await (await call("GET", `/admin/borrowers?q=${encodeURIComponent(marker + " enc")}`)).json();
      expect(listed.items[0].bankAccountNo).toBe("123-4-56789-0");
    });

    it("keeps only the last 4 digits in the audit log, and says which fields changed", async () => {
      const b = await createBorrower("enc-audit");
      const created = await auditFor(b.id, "borrower.create");
      expect(JSON.stringify(created[0]!.detail)).not.toContain("56789");
      expect(created[0]!.detail).toMatchObject({ after: { bankAccountNo: "****7890" } });

      const res = await call("PATCH", `/admin/borrowers/${b.id}`, { bankAccountNo: "999-8-77777-1" });
      expect(res.status).toBe(200);
      expect((await res.json()).bankAccountNo).toBe("999-8-77777-1");
      const row = await prisma.borrower.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.bankAccountNo).toMatch(/^enc:v1:/);
      expect(row.bankAccountNo).not.toContain("77777");

      const [update] = await auditFor(b.id, "borrower.update");
      expect(update!.detail).toMatchObject({
        before: { bankAccountNo: "****7890" },
        after: { bankAccountNo: "****7771" },
        changedFields: ["bankAccountNo"],
      });
      expect(JSON.stringify(update!.detail)).not.toMatch(/56789|77777/);
    });

    it("lets the new borrower log in and forces a password change", async () => {
      await createBorrower("login");
      const res = await login(name("login"), "initial-password-1");
      expect(res.status).toBe(200);
      expect((await res.json()).user).toMatchObject({ role: "BORROWER", mustChangePassword: true });
    });

    it("writes an audit row without any password", async () => {
      const b = await createBorrower("audited");
      const rows = await auditFor(b.id, "borrower.create");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe(adminId);
      expect(rows[0]!.detail).toMatchObject({
        after: { fullName: `${marker} audited`, username: name("audited") },
      });
      expect(JSON.stringify(rows[0]!.detail)).not.toMatch(/initial-password|passwordHash|scrypt/);
    });

    it("requires only the login and the name: the borrower fills in phone and account number themself (CR-5)", async () => {
      for (const field of ["username", "password", "fullName"]) {
        const body: Record<string, unknown> = profile(`missing-${field}`);
        delete body[field];
        expect((await call("POST", "/admin/borrowers", body)).status, field).toBe(400);
      }
      expect(await prisma.user.count({ where: { username: { startsWith: name("missing-") } } })).toBe(0);
    });

    it("creates the account with the name alone, leaving phone, bank and account number empty", async () => {
      const body: Record<string, unknown> = profile("nameonly");
      for (const f of ["phone", "bankName", "bankAccountNo"]) delete body[f];
      const res = await call("POST", "/admin/borrowers", body);
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({ phone: null, bankName: null, bankAccountNo: null, account: { username: name("nameonly"), mustChangePassword: true } });
      const row = await prisma.borrower.findUniqueOrThrow({ where: { id: created.id } });
      expect([row.phone, row.bankName, row.bankAccountNo]).toEqual([null, null, null]);
    });

    it("still accepts them when the admin does give them (the account number stored encrypted), and still checks what is given", async () => {
      const ok = await call("POST", "/admin/borrowers", profile("withall"));
      expect(ok.status).toBe(201);
      const row = await prisma.borrower.findUniqueOrThrow({ where: { id: (await ok.json()).id } });
      expect(row.bankAccountNo).not.toBeNull();
      expect(row.bankAccountNo).toMatch(/^enc:v1:/); // encrypted, not the typed number
      expect(row.bankAccountNo).not.toContain("56789");
      for (const bad of [{ phone: "abc" }, { bankAccountNo: "12ab" }, { bankName: "" }, { phone: "" }]) {
        expect((await call("POST", "/admin/borrowers", profile(`bad${Object.keys(bad)[0]}${Math.random()}`.replace(".", ""), bad))).status, JSON.stringify(bad)).toBe(400);
      }
    });

    it("rejects weak passwords and malformed phone, account number and username", async () => {
      const weak = await call("POST", "/admin/borrowers", profile("weak", { password: "short" }));
      expect(weak.status).toBe(400);
      expect((await weak.json()).error.code).toBe("WEAK_PASSWORD");
      expect((await call("POST", "/admin/borrowers", profile("p1", { phone: "abc" }))).status).toBe(400);
      expect((await call("POST", "/admin/borrowers", profile("p2", { bankAccountNo: "12ab" }))).status).toBe(400);
      expect((await call("POST", "/admin/borrowers", profile("p3", { username: "has space" }))).status).toBe(400);
    });

    it("rejects a username that exists, ignoring case, and creates nothing", async () => {
      await createBorrower("dupe");
      const same = await call("POST", "/admin/borrowers", profile("dupe", { fullName: `${marker} dupe2` }));
      expect(same.status).toBe(409);
      expect((await same.json()).error.code).toBe("USERNAME_TAKEN");
      const upper = await call(
        "POST",
        "/admin/borrowers",
        profile("dupe", { username: name("dupe").toUpperCase(), fullName: `${marker} dupe3` }),
      );
      expect(upper.status).toBe(409);
      expect(await prisma.borrower.count({ where: { fullName: { in: [`${marker} dupe2`, `${marker} dupe3`] } } })).toBe(0);
    });

    it("allows two different borrowers with the same full name", async () => {
      await createBorrower("twin-a", { fullName: `${marker} twin` });
      await createBorrower("twin-b", { fullName: `${marker} twin` });
      expect(await prisma.borrower.count({ where: { fullName: `${marker} twin` } })).toBe(2);
    });
  });

  describe("list and get", () => {
    it("lists, searches by name, paginates, and shows imported borrowers without an account", async () => {
      await prisma.borrower.create({ data: { fullName: `${marker} imported-only` } });
      const found = await (await call("GET", `/admin/borrowers?q=${encodeURIComponent(marker + " IMPORTED")}`)).json();
      expect(found.total).toBe(1);
      expect(found.items[0]).toMatchObject({ fullName: `${marker} imported-only`, account: null, bankAccountNo: null });

      const all = await (await call("GET", `/admin/borrowers?q=${marker}&limit=2&offset=0`)).json();
      expect(all.total).toBeGreaterThan(2);
      expect(all.items).toHaveLength(2);
      const next = await (await call("GET", `/admin/borrowers?q=${marker}&limit=2&offset=2`)).json();
      expect(next.items[0].id).not.toBe(all.items[0].id);
      expect((await call("GET", "/admin/borrowers?limit=0")).status).toBe(400);
    });

    it("returns one borrower or 404", async () => {
      const row = await prisma.borrower.findFirstOrThrow({ where: { fullName: `${marker} self` } });
      const res = await call("GET", `/admin/borrowers/${row.id}`);
      expect(res.status).toBe(200);
      expect((await res.json()).account.username).toBe(name("self"));
      expect((await call("GET", "/admin/borrowers/does-not-exist")).status).toBe(404);
    });
  });

  describe("update", () => {
    it("changes only the given fields and audits before/after", async () => {
      const b = await createBorrower("edit");
      const res = await call("PATCH", `/admin/borrowers/${b.id}`, { phone: "089-999-9999", bankName: "ธนาคารใหม่" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        fullName: `${marker} edit`,
        phone: "089-999-9999",
        bankName: "ธนาคารใหม่",
        bankAccountNo: "123-4-56789-0",
      });
      const [row] = await auditFor(b.id, "borrower.update");
      expect(row!.detail).toMatchObject({
        before: { phone: "081-234-5678", bankName: "ธนาคารตัวอย่าง" },
        after: { phone: "089-999-9999", bankName: "ธนาคารใหม่" },
      });
    });

    it("rejects empty updates, nulls and bad values without writing anything", async () => {
      const b = await createBorrower("edit-bad");
      expect((await call("PATCH", `/admin/borrowers/${b.id}`, {})).status).toBe(400);
      expect((await call("PATCH", `/admin/borrowers/${b.id}`, { phone: null })).status).toBe(400);
      expect((await call("PATCH", `/admin/borrowers/${b.id}`, { bankAccountNo: "x" })).status).toBe(400);
      expect((await call("PATCH", "/admin/borrowers/missing", { phone: "081-234-5678" })).status).toBe(404);
      expect(await auditFor(b.id, "borrower.update")).toHaveLength(0);
    });

    it("can fill in the details of an imported borrower", async () => {
      const row = await prisma.borrower.findFirstOrThrow({ where: { fullName: `${marker} imported-only` } });
      const res = await call("PATCH", `/admin/borrowers/${row.id}`, { phone: "081-111-2222" });
      expect(res.status).toBe(200);
      expect((await res.json()).account).toBeNull();
    });
  });

  describe("deactivate and reactivate", () => {
    it("blocks login and kills the live session, and can be undone", async () => {
      const b = await createBorrower("active");
      const cookie = cookieOf(await login(name("active"), "initial-password-1"));
      expect((await call("GET", "/auth/me", undefined, cookie)).status).toBe(200);

      const off = await call("PUT", `/admin/borrowers/${b.id}/active`, { isActive: false });
      expect(off.status).toBe(200);
      expect((await off.json()).account.isActive).toBe(false);
      expect((await call("GET", "/auth/me", undefined, cookie)).status).toBe(401);
      expect((await login(name("active"), "initial-password-1")).status).toBe(401);

      const on = await call("PUT", `/admin/borrowers/${b.id}/active`, { isActive: true });
      expect((await on.json()).account.isActive).toBe(true);
      expect((await login(name("active"), "initial-password-1")).status).toBe(200);

      const rows = await auditFor(b.id, "borrower.setActive");
      expect(rows.map((r) => (r.detail as { after: { isActive: boolean } }).after.isActive).sort()).toEqual([false, true]);
    });

    it("rejects bad input and borrowers with no account", async () => {
      const b = await createBorrower("active-bad");
      expect((await call("PUT", `/admin/borrowers/${b.id}/active`, { isActive: "no" })).status).toBe(400);
      const imported = await prisma.borrower.findFirstOrThrow({ where: { fullName: `${marker} imported-only` } });
      const res = await call("PUT", `/admin/borrowers/${imported.id}/active`, { isActive: false });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("NO_ACCOUNT");
    });
  });

  describe("reset password", () => {
    it("sets a temporary password, forces a change and ends old sessions", async () => {
      const b = await createBorrower("reset");
      const oldCookie = cookieOf(await login(name("reset"), "initial-password-1"));
      const changed = await call(
        "POST",
        "/auth/change-password",
        { currentPassword: "initial-password-1", newPassword: "chosen-by-user-1" },
        oldCookie,
      );
      expect(changed.status).toBe(200);
      const liveCookie = cookieOf(changed);
      expect((await call("GET", "/auth/me", undefined, liveCookie)).status).toBe(200);

      const res = await call("POST", `/admin/borrowers/${b.id}/reset-password`, { newPassword: "temporary-pass-9" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.account.mustChangePassword).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/temporary-pass|passwordHash|scrypt/);

      expect((await call("GET", "/auth/me", undefined, liveCookie)).status).toBe(401);
      expect((await login(name("reset"), "chosen-by-user-1")).status).toBe(401);
      const fresh = await login(name("reset"), "temporary-pass-9");
      expect(fresh.status).toBe(200);
      expect((await fresh.json()).user.mustChangePassword).toBe(true);

      const [row] = await auditFor(b.id, "borrower.resetPassword");
      expect(row!.actorId).toBe(adminId);
      expect(JSON.stringify(row!.detail)).not.toMatch(/temporary-pass|chosen-by|scrypt/);
    });

    it("rejects weak passwords and borrowers with no account", async () => {
      const b = await createBorrower("reset-bad");
      const weak = await call("POST", `/admin/borrowers/${b.id}/reset-password`, { newPassword: "short" });
      expect(weak.status).toBe(400);
      expect((await weak.json()).error.code).toBe("WEAK_PASSWORD");
      expect((await login(name("reset-bad"), "initial-password-1")).status).toBe(200);
      const imported = await prisma.borrower.findFirstOrThrow({ where: { fullName: `${marker} imported-only` } });
      expect((await call("POST", `/admin/borrowers/${imported.id}/reset-password`, { newPassword: "temporary-pass-9" })).status).toBe(409);
    });
  });

  describe("borrower scope (lib:borrower-scope)", () => {
    it("uses the session borrower and refuses a borrowerId sent by the client", async () => {
      const ok = await call("GET", "/_mine", undefined, borrowerCookie);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ borrowerId: ownBorrowerId });

      const viaQuery = await call("GET", "/_mine?borrowerId=someone-else", undefined, borrowerCookie);
      expect(viaQuery.status).toBe(400);
      expect((await viaQuery.json()).error.code).toBe("BORROWER_ID_NOT_ALLOWED");
      expect((await call("POST", "/_mine", { borrowerId: "someone-else" }, borrowerCookie)).status).toBe(400);
    });
  });
});
