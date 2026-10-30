import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { AdminScriptError, resetAdminPassword } from "../src/scripts/admin-accounts.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const OLD = "old-password-123";
const NEW = "recovered-pass-9";
const marker = `t3r${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

describe.skipIf(!dbUp)("reset admin password script (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  let adminId: string;

  const login = (username: string, password: string) =>
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;
  const me = (cookie: string) => fetch(`${baseUrl}/auth/me`, { headers: { cookie } });

  beforeAll(async () => {
    const passwordHash = await hashPassword(OLD);
    const base = { passwordHash, mustChangePassword: false };
    const admin = await prisma.user.create({ data: { username: name("admin"), role: "ADMIN", ...base } });
    adminId = admin.id;
    await prisma.user.create({ data: { username: name("borrower"), role: "BORROWER", ...base } });
    await prisma.user.create({ data: { username: name("off"), role: "ADMIN", isActive: false, ...base } });

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
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ids = (await prisma.user.findMany({ where: { username: { startsWith: marker } }, select: { id: true } })).map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { entityType: "User", entityId: { in: ids } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it("sets the new password, forces a change, and ends the admin's old sessions", async () => {
    const oldCookie = cookieOf(await login(name("admin"), OLD));
    expect((await me(oldCookie)).status).toBe(200);

    const result = await resetAdminPassword(prisma, { username: name("admin"), password: NEW });
    expect(result).toEqual({ username: name("admin"), inactive: false });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(row.mustChangePassword).toBe(true);
    expect(await verifyPassword(NEW, row.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD, row.passwordHash)).toBe(false);
    expect(row.passwordHash).not.toContain(NEW);

    expect((await me(oldCookie)).status).toBe(401);
    expect((await login(name("admin"), OLD)).status).toBe(401);
    const fresh = await login(name("admin"), NEW);
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).user.mustChangePassword).toBe(true);
  });

  it("writes a system audit row that never contains the password", async () => {
    const rows = await prisma.auditLog.findMany({
      where: { entityType: "User", entityId: adminId, action: "admin.resetPassword" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBeNull();
    expect(JSON.stringify(rows[0]!.detail)).not.toMatch(/recovered-pass|old-password|scrypt/);
  });

  it("only touches ADMIN accounts that exist, and changes nothing otherwise", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { username: name("borrower") } });
    await expect(resetAdminPassword(prisma, { username: name("borrower"), password: NEW })).rejects.toBeInstanceOf(AdminScriptError);
    await expect(resetAdminPassword(prisma, { username: name("nobody"), password: NEW })).rejects.toBeInstanceOf(AdminScriptError);
    await expect(resetAdminPassword(prisma, { username: "  ", password: NEW })).rejects.toBeInstanceOf(AdminScriptError);
    const after = await prisma.user.findUniqueOrThrow({ where: { username: name("borrower") } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await verifyPassword(OLD, after.passwordHash)).toBe(true);
  });

  it("enforces the password policy", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    await expect(resetAdminPassword(prisma, { username: name("admin"), password: "short" })).rejects.toBeInstanceOf(AdminScriptError);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it("reports an inactive admin without switching it on", async () => {
    const result = await resetAdminPassword(prisma, { username: name("off"), password: NEW });
    expect(result.inactive).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { username: name("off") } });
    expect(row.isActive).toBe(false);
    expect((await login(name("off"), NEW)).status).toBe(401);
  });
});
