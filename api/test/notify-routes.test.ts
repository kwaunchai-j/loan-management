import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient, type NotificationChannel } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/password.js";
import { Notifier } from "../src/notifications/service.js";
import type { ChannelAdapter } from "../src/notifications/types.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t402r${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;
const LINE_ID = `U${"ab12".repeat(8)}`;
const OTHER_LINE_ID = `U${"cd34".repeat(8)}`;
const PUBLIC_KEY = "BPublicKeyForTests".padEnd(87, "x");

const adapter = (channel: NotificationChannel, o: { recipients?: boolean; fail?: string } = {}): ChannelAdapter => ({
  channel,
  hasRecipients: async () => o.recipients ?? true,
  send: async () => {
    if (o.fail) throw new Error(o.fail);
  },
});

const goodKeys = () => ({ p256dh: Buffer.alloc(65, 5).toString("base64url"), auth: Buffer.alloc(16, 6).toString("base64url") });
const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/${marker}-${n}`;

describe.skipIf(!dbUp)("notification setup endpoints (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  let noVapid: Server;
  let noVapidUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: Record<string, string> = {};

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  const call = (as: string | null, method: string, path: string, body?: unknown, url = baseUrl) =>
    fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { cookie: cookies[as]! } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function start(adapters: ChannelAdapter[], vapidPublicKey?: string) {
    const s = buildApp({
      prisma,
      sessionSecret: SECRET,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      notifier: new Notifier({ prisma, adapters, retryDelaysMs: [0, 0], log: () => undefined }),
      vapidPublicKey,
    }).app.listen(0);
    await new Promise<void>((resolve) => s.once("listening", () => resolve()));
    return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    for (const [u, role] of [["admin", "ADMIN"], ["admin2", "ADMIN"], ["borrower", "BORROWER"]] as const) {
      userIds[u] = (await prisma.user.create({ data: { username: name(u), role, ...base } })).id;
    }
    const main = await start([adapter("LINE"), adapter("WEB_PUSH", { recipients: false })], PUBLIC_KEY);
    server = main.server;
    baseUrl = main.url;
    const other = await start([]);
    noVapid = other.server;
    noVapidUrl = other.url;
    for (const u of ["admin", "admin2", "borrower"]) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name(u), password: PASSWORD }),
      });
      cookies[u] = cookieOf(res);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all([server, noVapid].map((s) => new Promise<void>((r) => s.close(() => r()))));
    const ids = Object.values(userIds);
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  describe("LINE binding (T-402)", () => {
    it("starts unbound, binds a valid LINE user id, and only shows it masked", async () => {
      const before = await (await call("admin", "GET", "/admin/line-binding")).json();
      expect(before).toEqual({ bound: false, lineUserId: null });

      const res = await call("admin", "PUT", "/admin/line-binding", { lineUserId: LINE_ID });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bound).toBe(true);
      expect(body.lineUserId).toBe(`${LINE_ID.slice(0, 2)}…${LINE_ID.slice(-4)}`);
      expect(JSON.stringify(body)).not.toContain(LINE_ID);

      expect((await prisma.user.findUniqueOrThrow({ where: { id: userIds.admin! } })).lineUserId).toBe(LINE_ID);
      expect(await (await call("admin", "GET", "/admin/line-binding")).json()).toMatchObject({ bound: true });
    });

    it("only changes the caller's own binding", async () => {
      await call("admin2", "PUT", "/admin/line-binding", { lineUserId: OTHER_LINE_ID });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userIds.admin! } })).lineUserId).toBe(LINE_ID);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userIds.admin2! } })).lineUserId).toBe(OTHER_LINE_ID);
    });

    it("rejects ids that are not LINE user ids and changes nothing", async () => {
      for (const bad of ["", "U123", `u${"ab12".repeat(8)}`, `U${"zz".repeat(16)}`, `U${"ab12".repeat(8)}0`, 12345, null]) {
        const res = await call("admin", "PUT", "/admin/line-binding", { lineUserId: bad });
        expect(res.status, String(bad)).toBe(400);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userIds.admin! } })).lineUserId).toBe(LINE_ID);
    });

    it("audits changes with the id masked", async () => {
      const rows = await prisma.auditLog.findMany({ where: { actorId: userIds.admin!, action: "user.lineBinding.set" } });
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows.map((r) => r.detail))).not.toContain(LINE_ID);
    });

    it("can be removed", async () => {
      const res = await call("admin2", "DELETE", "/admin/line-binding");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ bound: false, lineUserId: null });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userIds.admin2! } })).lineUserId).toBeNull();
      expect((await prisma.auditLog.findMany({ where: { actorId: userIds.admin2!, action: "user.lineBinding.clear" } })).length).toBe(1);
    });

    it("is ADMIN only", async () => {
      for (const [method, body] of [["GET", undefined], ["PUT", { lineUserId: LINE_ID }], ["DELETE", undefined]] as const) {
        expect((await call("borrower", method, "/admin/line-binding", body)).status).toBe(403);
        expect((await call(null, method, "/admin/line-binding", body)).status).toBe(401);
      }
    });
  });

  describe("Web Push subscriptions (T-403)", () => {
    it("serves the VAPID public key, or 503 when push is not configured", async () => {
      const ok = await call("admin", "GET", "/admin/push/public-key");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ publicKey: PUBLIC_KEY });
      expect(JSON.stringify(await (await call("admin", "GET", "/admin/push/public-key")).json())).not.toMatch(/private/i);

      const none = await call("admin", "GET", "/admin/push/public-key", undefined, noVapidUrl);
      expect(none.status).toBe(503);
      expect((await none.json()).error.code).toBe("PUSH_NOT_CONFIGURED");
    });

    it("registers a subscription for the logged-in admin, and re-registering updates it", async () => {
      const k = goodKeys();
      const res = await call("admin", "POST", "/admin/push-subscriptions", { endpoint: endpoint(1), keys: k });
      expect(res.status).toBe(201);
      const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint(1) } });
      expect(row).toMatchObject({ userId: userIds.admin, p256dh: k.p256dh, auth: k.auth });

      const k2 = { p256dh: Buffer.alloc(65, 8).toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") };
      expect((await call("admin", "POST", "/admin/push-subscriptions", { endpoint: endpoint(1), keys: k2 })).status).toBe(201);
      expect(await prisma.pushSubscription.count({ where: { endpoint: endpoint(1) } })).toBe(1);
      expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint(1) } })).p256dh).toBe(k2.p256dh);
    });

    it("refuses endpoints that are not a real push service (SSRF guard) and bad keys", async () => {
      const k = goodKeys();
      for (const bad of ["http://fcm.googleapis.com/fcm/send/x", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/latest/meta-data", "https://evil.example.com/x", "not-a-url"]) {
        const res = await call("admin", "POST", "/admin/push-subscriptions", { endpoint: bad, keys: k });
        expect(res.status, bad).toBe(400);
        expect((await prisma.pushSubscription.findUnique({ where: { endpoint: bad } }))).toBeNull();
      }
      for (const keys of [{ p256dh: "short", auth: k.auth }, { p256dh: k.p256dh, auth: "bad key!" }, { p256dh: k.auth, auth: k.p256dh }]) {
        expect((await call("admin", "POST", "/admin/push-subscriptions", { endpoint: endpoint(2), keys })).status).toBe(400);
      }
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint(2) } })).toBeNull();
      expect((await call("admin", "POST", "/admin/push-subscriptions", { endpoint: endpoint(2) })).status).toBe(400);
    });

    it("removes only the caller's own subscription", async () => {
      await call("admin2", "POST", "/admin/push-subscriptions", { endpoint: endpoint(3), keys: goodKeys() });
      const notMine = await call("admin", "DELETE", "/admin/push-subscriptions", { endpoint: endpoint(3) });
      expect(notMine.status).toBe(404);
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint(3) } })).not.toBeNull();

      const mine = await call("admin2", "DELETE", "/admin/push-subscriptions", { endpoint: endpoint(3) });
      expect(mine.status).toBe(200);
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint(3) } })).toBeNull();
      expect((await call("admin2", "DELETE", "/admin/push-subscriptions", { endpoint: endpoint(3) })).status).toBe(404);
      expect((await call("admin", "DELETE", "/admin/push-subscriptions", {})).status).toBe(400);
    });

    it("is ADMIN only", async () => {
      const body = { endpoint: endpoint(4), keys: goodKeys() };
      expect((await call("borrower", "POST", "/admin/push-subscriptions", body)).status).toBe(403);
      expect((await call(null, "POST", "/admin/push-subscriptions", body)).status).toBe(401);
      expect((await call("borrower", "GET", "/admin/push/public-key")).status).toBe(403);
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint(4) } })).toBeNull();
    });
  });

  describe("test button", () => {
    it("reports what happened on each channel", async () => {
      const res = await call("admin", "POST", "/admin/notifications/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ LINE: "sent", WEB_PUSH: "no_recipient" });
    });

    it("reports a failing channel without leaking more than a short reason", async () => {
      const { server: s, url } = await start([adapter("LINE", { fail: "LINE push failed with HTTP 401: Authentication failed" })]);
      try {
        const login = await fetch(`${url}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: name("admin"), password: PASSWORD }),
        });
        const res = await fetch(`${url}/admin/notifications/test`, { method: "POST", headers: { cookie: cookieOf(login) } });
        expect((await res.json()).LINE).toBe("failed: LINE push failed with HTTP 401: Authentication failed");
      } finally {
        await new Promise<void>((r) => s.close(() => r()));
      }
    });

    it("is ADMIN only", async () => {
      expect((await call("borrower", "POST", "/admin/notifications/test")).status).toBe(403);
      expect((await call(null, "POST", "/admin/notifications/test")).status).toBe(401);
    });
  });
});
