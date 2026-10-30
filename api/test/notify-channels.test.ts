import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createLineAdapter, LINE_PUSH_URL } from "../src/notifications/line.js";
import { createWebPushAdapter, type PushSender, type PushTarget } from "../src/notifications/webpush.js";
import type { RenderedMessage } from "../src/notifications/types.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const marker = `t402${Date.now()}`;
const TOKEN = "line-secret-token-".padEnd(60, "T");
const message: RenderedMessage = { line: "สรุปประจำวัน", push: { title: "หัวข้อ", body: "เนื้อหา", url: "/admin/contracts" } };
const uid = (n: number) => `U${n.toString(16).padStart(32, "0")}`;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { to: string; messages: Array<{ type: string; text: string }> };
}

function fakeFetch(respond: (c: Captured) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>) {
  const calls: Captured[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const c: Captured = {
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    calls.push(c);
    const r = await respond(c);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {} } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe.skipIf(!dbUp)("LINE and Web Push channels (PostgreSQL)", () => {
  const userIds: string[] = [];
  const mkUser = async (suffix: string, o: { role?: "ADMIN" | "BORROWER"; isActive?: boolean; lineUserId?: string | null } = {}) => {
    const u = await prisma.user.create({
      data: { username: `${marker}-${suffix}`, passwordHash: "x", role: o.role ?? "ADMIN", isActive: o.isActive ?? true, lineUserId: o.lineUserId ?? null },
    });
    userIds.push(u.id);
    return u;
  };

  beforeAll(async () => {
    // other admins in a developer database would receive these tests' messages: keep the test isolated
    // by asserting only on calls addressed to this file's own users
  });

  afterAll(async () => {
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("LINE", () => {
    it("pushes the long text to the admin's LINE user id with the bearer token", async () => {
      const id = uid(0x1a2b);
      await mkUser("admin-line", { lineUserId: id });
      const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
      await createLineAdapter({ prisma, accessToken: TOKEN, fetchFn }).send(message);
      const mine = calls.filter((c) => c.body.to === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ url: LINE_PUSH_URL, body: { messages: [{ type: "text", text: "สรุปประจำวัน" }] } });
      expect(mine[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("sends only to active ADMINs that are bound, never to borrowers or unbound/inactive accounts", async () => {
      const bound = uid(0x3c4d);
      await mkUser("a-bound", { lineUserId: bound });
      await mkUser("a-unbound");
      await mkUser("a-off", { isActive: false, lineUserId: uid(0x5e6f) });
      await mkUser("borrower", { role: "BORROWER", lineUserId: uid(0x7081) });
      const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
      await createLineAdapter({ prisma, accessToken: TOKEN, fetchFn }).send(message);
      const ids = calls.map((c) => c.body.to);
      expect(ids).toContain(bound);
      expect(ids).not.toContain(uid(0x5e6f));
      expect(ids).not.toContain(uid(0x7081));
    });

    it("has a recipient only when an ADMIN has bound a LINE id", async () => {
      // This test file's own users decide the answer only if the database has no other bound admin,
      // so ask the adapter and compare with a direct count.
      const expected = (await prisma.user.count({ where: { role: "ADMIN", isActive: true, lineUserId: { not: null } } })) > 0;
      const { fetchFn } = fakeFetch(() => ({ status: 200 }));
      expect(await createLineAdapter({ prisma, accessToken: TOKEN, fetchFn }).hasRecipients()).toBe(expected);
    });

    it("fails on an HTTP error with LINE's reason, and never leaks the token", async () => {
      await mkUser("a-err", { lineUserId: uid(0x9a0b) });
      const { fetchFn } = fakeFetch(() => ({ status: 401, json: { message: "Authentication failed" } }));
      const adapter = createLineAdapter({ prisma, accessToken: TOKEN, fetchFn });
      const err = await adapter.send(message).then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toContain("HTTP 401");
      expect(err!.message).toContain("Authentication failed");
      expect(err!.message).not.toContain(TOKEN);
    });

    it("fails when the network fails, and cuts the text to LINE's limit", async () => {
      const boom = (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch;
      await expect(createLineAdapter({ prisma, accessToken: TOKEN, fetchFn: boom }).send(message)).rejects.toThrow("socket hang up");

      const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
      await createLineAdapter({ prisma, accessToken: TOKEN, fetchFn }).send({ ...message, line: "ก".repeat(9000) });
      expect(calls.every((c) => c.body.messages[0]!.text.length <= 5000)).toBe(true);
    });
  });

  describe("Web Push", () => {
    const sub = (n: number) => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${marker}-${n}`,
      p256dh: Buffer.alloc(65, n).toString("base64url"),
      auth: Buffer.alloc(16, n).toString("base64url"),
    });
    const addSub = async (userId: string, n: number) => prisma.pushSubscription.create({ data: { userId, ...sub(n) } });
    const mine = (calls: PushTarget[]) => calls.filter((t) => t.endpoint.includes(marker));

    function fakeSender(onSend?: (t: PushTarget) => void | Promise<void>) {
      const targets: PushTarget[] = [];
      const payloads: string[] = [];
      const sender: PushSender = {
        async send(target, payload) {
          targets.push(target);
          payloads.push(payload);
          await onSend?.(target);
        },
      };
      return { sender, targets, payloads };
    }

    it("sends the short JSON payload to every ADMIN subscription", async () => {
      const admin = await mkUser("p-admin");
      await addSub(admin.id, 1);
      await addSub(admin.id, 2);
      const { sender, targets, payloads } = fakeSender();
      await createWebPushAdapter({ prisma, sender }).send(message);
      expect(mine(targets).map((t) => t.endpoint).sort()).toEqual([sub(1).endpoint, sub(2).endpoint].sort());
      expect(mine(targets)[0]!.keys).toHaveProperty("p256dh");
      expect(JSON.parse(payloads[0]!)).toEqual({ title: "หัวข้อ", body: "เนื้อหา", url: "/admin/contracts" });
    });

    it("never sends to a borrower's or an inactive account's subscription", async () => {
      const borrower = await mkUser("p-borrower", { role: "BORROWER" });
      const off = await mkUser("p-off", { isActive: false });
      await addSub(borrower.id, 11);
      await addSub(off.id, 12);
      const { sender, targets } = fakeSender();
      await createWebPushAdapter({ prisma, sender }).send(message).catch(() => undefined);
      const endpoints = targets.map((t) => t.endpoint);
      expect(endpoints).not.toContain(sub(11).endpoint);
      expect(endpoints).not.toContain(sub(12).endpoint);
    });

    it("removes a subscription the push service says is gone (410), and keeps delivering to the rest", async () => {
      const admin = await mkUser("p-gone");
      await addSub(admin.id, 21);
      await addSub(admin.id, 22);
      const { sender, targets } = fakeSender((t) => {
        if (t.endpoint === sub(21).endpoint) throw Object.assign(new Error("gone"), { statusCode: 410 });
      });
      await createWebPushAdapter({ prisma, sender }).send(message); // 22 still delivers, so no error
      // both of this test's subscriptions were tried (earlier tests' admin subscriptions are tried too)
      expect(targets.map((t) => t.endpoint)).toEqual(expect.arrayContaining([sub(21).endpoint, sub(22).endpoint]));
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: sub(21).endpoint } })).toBeNull();
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: sub(22).endpoint } })).not.toBeNull();
    });

    it("fails when nobody could be reached, keeping the subscription after a temporary error", async () => {
      const admin = await mkUser("p-temp");
      await addSub(admin.id, 31);
      const { sender } = fakeSender(() => {
        throw Object.assign(new Error("secret internal detail"), { statusCode: 503 });
      });
      const err = await createWebPushAdapter({ prisma, sender }).send(message).then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toContain("503");
      expect(err!.message).not.toContain("secret internal detail");
      expect(await prisma.pushSubscription.findUnique({ where: { endpoint: sub(31).endpoint } })).not.toBeNull();
    });

    it("has a recipient only when an ADMIN has a subscription", async () => {
      const expected = (await prisma.pushSubscription.count({ where: { user: { role: "ADMIN", isActive: true } } })) > 0;
      expect(await createWebPushAdapter({ prisma, sender: fakeSender().sender }).hasRecipients()).toBe(expected);
    });
  });
});
