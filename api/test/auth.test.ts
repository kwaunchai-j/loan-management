import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/password.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t101${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

interface Started {
  baseUrl: string;
  server: Server;
}

async function start(app: ReturnType<typeof buildApp>["app"]): Promise<Started> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const stop = (s: Started) => new Promise<void>((resolve) => s.server.close(() => resolve()));

function cookieOf(res: Response): string | undefined {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("loan_session="));
  return raw?.split(";")[0];
}

describe.skipIf(!dbUp)("auth (PostgreSQL)", () => {
  let main: Started;
  let limited: Started;

  async function post(s: Started, path: string, body: unknown, cookie?: string) {
    return fetch(`${s.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  }
  const get = (path: string, cookie?: string) =>
    fetch(`${main.baseUrl}${path}`, { headers: cookie ? { cookie } : {} });

  async function login(username: string, password = PASSWORD, s: Started = main) {
    return post(s, "/auth/login", { username, password });
  }

  beforeAll(async () => {
    const hash = await hashPassword(PASSWORD);
    const base = { passwordHash: hash, mustChangePassword: false };
    await prisma.user.createMany({
      data: [
        { username: name("admin"), role: "ADMIN", ...base },
        { username: name("borrower"), role: "BORROWER", ...base },
        { username: name("inactive"), role: "BORROWER", isActive: false, ...base },
        { username: name("mustchange"), role: "ADMIN", ...base, mustChangePassword: true },
        { username: name("deactivate"), role: "ADMIN", ...base },
        { username: name("pw"), role: "ADMIN", ...base },
        { username: name("limited"), role: "ADMIN", ...base },
      ],
    });
    const borrowerUser = await prisma.user.findUniqueOrThrow({ where: { username: name("borrower") } });
    await prisma.borrower.create({ data: { userId: borrowerUser.id, fullName: `${marker} borrower` } });

    const built = buildApp({
      prisma,
      sessionSecret: SECRET,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
    });
    built.app.get("/_admin", built.auth!.authorize("ADMIN"), (_req, res) => {
      res.json({ ok: true });
    });
    built.app.get("/_borrower", built.auth!.authorize("BORROWER"), (req, res) => {
      res.json({ borrowerId: req.user!.borrowerId });
    });
    main = await start(built.app);

    limited = await start(
      buildApp({
        prisma,
        sessionSecret: SECRET,
        loginRateLimit: { maxFailuresPerPair: 3, maxFailuresPerUser: 1000, maxFailuresPerIp: 1000, windowMs: 60_000 },
        fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      }).app,
    );
  }, 60_000);

  afterAll(async () => {
    await stop(main);
    await stop(limited);
    await prisma.borrower.deleteMany({ where: { fullName: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  describe("login", () => {
    it("logs in, sets an HttpOnly session cookie and never returns the hash", async () => {
      const res = await login(name("admin"));
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      const body = await res.json();
      expect(body.user).toMatchObject({ username: name("admin"), role: "ADMIN", mustChangePassword: false });
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|scrypt/);
    });

    it("gives the same answer for wrong password, unknown user and inactive user", async () => {
      const wrong = await login(name("admin"), "not-the-password");
      const unknown = await login(name("nobody"), PASSWORD);
      const inactive = await login(name("inactive"), PASSWORD);
      for (const r of [wrong, unknown, inactive]) expect(r.status).toBe(401);
      const bodies = await Promise.all([wrong.json(), unknown.json(), inactive.json()]);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(bodies[0].error.code).toBe("INVALID_CREDENTIALS");
    });

    it("rejects malformed bodies without touching credentials", async () => {
      expect((await post(main, "/auth/login", {})).status).toBe(400);
      expect((await post(main, "/auth/login", { username: name("admin") })).status).toBe(400);
      expect((await post(main, "/auth/login", { username: "a", password: "p".repeat(500) })).status).toBe(400);
      const bad = await fetch(`${main.baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
    });

    it("locks a username after repeated failures, even for the right password", async () => {
      for (let i = 0; i < 3; i++) {
        expect((await login(name("limited"), "wrong-password-x", limited)).status).toBe(401);
      }
      const blocked = await login(name("limited"), PASSWORD, limited);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await blocked.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
    });
  });

  describe("session", () => {
    it("requires a valid cookie", async () => {
      expect((await get("/auth/me")).status).toBe(401);
      expect((await get("/auth/me", "loan_session=garbage")).status).toBe(401);
      const cookie = cookieOf(await login(name("admin")))!;
      expect((await get("/auth/me", `${cookie}x`)).status).toBe(401);
      const me = await get("/auth/me", cookie);
      expect(me.status).toBe(200);
      expect((await me.json()).user.username).toBe(name("admin"));
    });

    it("stops working as soon as the user is deactivated", async () => {
      const cookie = cookieOf(await login(name("deactivate")))!;
      expect((await get("/auth/me", cookie)).status).toBe(200);
      await prisma.user.update({ where: { username: name("deactivate") }, data: { isActive: false } });
      expect((await get("/auth/me", cookie)).status).toBe(401);
    });

    it("logout clears the cookie", async () => {
      const res = await post(main, "/auth/logout", {});
      expect(res.status).toBe(204);
      expect(res.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
    });
  });

  describe("roles (lib:authz)", () => {
    it("lets a role in and keeps the others out", async () => {
      const admin = cookieOf(await login(name("admin")))!;
      const borrower = cookieOf(await login(name("borrower")))!;
      expect((await get("/_admin", admin)).status).toBe(200);
      expect((await get("/_admin", borrower)).status).toBe(403);
      expect((await get("/_borrower", admin)).status).toBe(403);
      expect((await get("/_admin")).status).toBe(401);
    });

    it("exposes the borrowerId from the session user, never from the client", async () => {
      const borrower = cookieOf(await login(name("borrower")))!;
      const row = await prisma.borrower.findFirstOrThrow({ where: { fullName: `${marker} borrower` } });
      const res = await fetch(`${main.baseUrl}/_borrower?borrowerId=someone-else`, {
        headers: { cookie: borrower },
      });
      expect(await res.json()).toEqual({ borrowerId: row.id });
    });
  });

  describe("mustChangePassword and change-password", () => {
    it("blocks business routes until the password is changed", async () => {
      const res = await login(name("mustchange"));
      expect((await res.json()).user.mustChangePassword).toBe(true);
      const cookie = cookieOf(res)!;
      const blocked = await get("/_admin", cookie);
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).error.code).toBe("PASSWORD_CHANGE_REQUIRED");
      expect((await get("/auth/me", cookie)).status).toBe(200);

      const changed = await post(main, "/auth/change-password", { currentPassword: PASSWORD, newPassword: "second-password-2" }, cookie);
      expect(changed.status).toBe(200);
      expect((await changed.json()).user.mustChangePassword).toBe(false);
      const fresh = cookieOf(changed)!;

      expect((await get("/_admin", fresh)).status).toBe(200);
      // the old token carried the old password fingerprint
      expect((await get("/auth/me", cookie)).status).toBe(401);
      expect((await login(name("mustchange"), PASSWORD)).status).toBe(401);
      expect((await login(name("mustchange"), "second-password-2")).status).toBe(200);
    });

    it("rejects weak, wrong-current and unchanged passwords", async () => {
      const cookie = cookieOf(await login(name("pw")))!;
      const change = (currentPassword: string, newPassword: string) =>
        post(main, "/auth/change-password", { currentPassword, newPassword }, cookie);

      const weak = await change(PASSWORD, "short");
      expect(weak.status).toBe(400);
      expect((await weak.json()).error.code).toBe("WEAK_PASSWORD");

      const wrong = await change("not-my-password", "another-password-3");
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).error.code).toBe("INVALID_CURRENT_PASSWORD");

      const same = await change(PASSWORD, PASSWORD);
      expect(same.status).toBe(400);
      expect((await same.json()).error.code).toBe("SAME_PASSWORD");

      expect((await post(main, "/auth/change-password", { currentPassword: PASSWORD, newPassword: "another-password-3" })).status).toBe(401);
    });
  });
});
