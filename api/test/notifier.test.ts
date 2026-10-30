import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import type { NotificationChannel } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { bangkokToday } from "../src/lib/dates.js";
import { MAX_ATTEMPTS, Notifier, STALE_PENDING_MS } from "../src/notifications/service.js";
import type { ChannelAdapter, RenderedMessage } from "../src/notifications/types.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const marker = `t401${Date.now()}`;
const today = bangkokToday();
const message: RenderedMessage = { line: "ข้อความทดสอบ", push: { title: "ทดสอบ", body: "ทดสอบ", url: "/x" } };

interface FakeOptions {
  recipients?: boolean;
  /** how many sends fail before one succeeds; Infinity = always fail */
  failFirst?: number;
  delayMs?: number;
  error?: unknown;
}

function fakeAdapter(channel: NotificationChannel, o: FakeOptions = {}) {
  let calls = 0;
  const adapter: ChannelAdapter & { calls: () => number } = {
    channel,
    calls: () => calls,
    hasRecipients: async () => o.recipients ?? true,
    send: async () => {
      calls++;
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (calls <= (o.failFirst ?? 0)) throw o.error ?? new Error(`${channel} is down`);
    },
  };
  return adapter;
}

describe.skipIf(!dbUp)("Notifier (PostgreSQL)", () => {
  let seq = 0;
  const key = () => `${marker}-${++seq}`;
  const make = (adapters: ChannelAdapter[], extra: Partial<ConstructorParameters<typeof Notifier>[0]> = {}) => {
    const log: string[] = [];
    const notifier = new Notifier({ prisma, adapters, retryDelaysMs: [0, 0], log: (m) => log.push(m), ...extra });
    return { notifier, log };
  };
  const rows = (k: string) => prisma.notificationLog.findMany({ where: { dedupeKey: { contains: k } }, orderBy: { channel: "asc" } });
  const input = (k: string, type: "DUE_TODAY" | "OVERDUE" | "NEW_REQUEST" = "DUE_TODAY") => ({
    type,
    key: k,
    scheduledDate: today,
    message,
  });

  afterAll(async () => {
    await prisma.notificationLog.deleteMany({ where: { dedupeKey: { contains: marker } } });
    await prisma.loanRequest.deleteMany({ where: { borrower: { fullName: { startsWith: marker } } } });
    await prisma.borrower.deleteMany({ where: { fullName: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it("delivers on every channel and records each one", async () => {
    const line = fakeAdapter("LINE");
    const push = fakeAdapter("WEB_PUSH");
    const k = key();
    const { notifier } = make([line, push]);
    expect(await notifier.deliver(input(k))).toEqual({ LINE: "sent", WEB_PUSH: "sent" });
    const list = await rows(k);
    expect(list.map((r) => [r.channel, r.status, r.attempts])).toEqual([["LINE", "SENT", 1], ["WEB_PUSH", "SENT", 1]]);
    expect(list.every((r) => r.sentAt !== null && r.error === null && r.contractId === null)).toBe(true);
    expect(list[0]).toMatchObject({ type: "DUE_TODAY", dedupeKey: `DUE_TODAY:${k}:LINE` });
    expect(list[0]!.scheduledDate.getTime()).toBe(today.getTime());
  });

  it("never sends the same notification twice (dedupeKey), but sends a different one", async () => {
    const line = fakeAdapter("LINE");
    const k = key();
    const { notifier } = make([line]);
    expect(await notifier.deliver(input(k))).toEqual({ LINE: "sent" });
    expect(await notifier.deliver(input(k))).toEqual({ LINE: "skipped" });
    expect(line.calls()).toBe(1);
    expect(await rows(k)).toHaveLength(1);
    // the same key under another type is a different notification
    expect(await notifier.deliver(input(k, "OVERDUE"))).toEqual({ LINE: "sent" });
    expect(line.calls()).toBe(2);
  });

  it("sends only once when the same notification is requested at the same moment", async () => {
    const line = fakeAdapter("LINE", { delayMs: 150 });
    const k = key();
    const { notifier } = make([line]);
    const results = await Promise.all(Array.from({ length: 6 }, () => notifier.deliver(input(k))));
    expect(line.calls()).toBe(1);
    expect(results.map((r) => r.LINE).sort()).toEqual(["sent", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(await rows(k)).toHaveLength(1);
  });

  it("retries a failing channel and succeeds on the third attempt", async () => {
    const line = fakeAdapter("LINE", { failFirst: 2 });
    const k = key();
    const sleeps: number[] = [];
    const { notifier } = make([line], { retryDelaysMs: [5, 7], sleep: async (ms) => void sleeps.push(ms) });
    expect(await notifier.deliver(input(k))).toEqual({ LINE: "sent" });
    expect(line.calls()).toBe(3);
    const [row] = await rows(k);
    expect(row).toMatchObject({ status: "SENT", attempts: 3, error: null });
    expect(sleeps).toEqual([5, 7]); // waits before attempt 2 and 3
  });

  it("gives up after 3 attempts, records FAILED with the error, and the other channel is unaffected", async () => {
    const line = fakeAdapter("LINE", { failFirst: Infinity, error: new Error("LINE push failed with HTTP 500") });
    const push = fakeAdapter("WEB_PUSH");
    const k = key();
    const { notifier, log } = make([line, push]);
    expect(await notifier.deliver(input(k))).toEqual({ LINE: "failed", WEB_PUSH: "sent" });
    expect(line.calls()).toBe(MAX_ATTEMPTS);
    expect(push.calls()).toBe(1);
    const list = await rows(k);
    expect(list.find((r) => r.channel === "LINE")).toMatchObject({ status: "FAILED", attempts: 3, error: "LINE push failed with HTTP 500", sentAt: null });
    expect(list.find((r) => r.channel === "WEB_PUSH")).toMatchObject({ status: "SENT", attempts: 1 });
    expect(log.some((m) => m.includes("FAILED after 3 attempts"))).toBe(true);
  });

  it("a channel that breaks before it can even try (e.g. its recipient lookup errors) does not stop the other", async () => {
    const broken: ChannelAdapter = {
      channel: "LINE",
      hasRecipients: async () => {
        throw new Error("recipient lookup failed");
      },
      send: async () => undefined,
    };
    const push = fakeAdapter("WEB_PUSH");
    const k = key();
    const { notifier, log } = make([broken, push]);
    expect(await notifier.deliver(input(k))).toEqual({ LINE: "failed", WEB_PUSH: "sent" });
    expect(push.calls()).toBe(1);
    expect(log.some((m) => m.includes("errored: recipient lookup failed"))).toBe(true);
  });

  it("does not keep retrying a FAILED notification later", async () => {
    const k = key();
    const broken = fakeAdapter("LINE", { failFirst: Infinity });
    await make([broken]).notifier.deliver(input(k));
    const healthy = fakeAdapter("LINE");
    expect(await make([healthy]).notifier.deliver(input(k))).toEqual({ LINE: "skipped" });
    expect(healthy.calls()).toBe(0);
    expect((await rows(k))[0]!.status).toBe("FAILED");
  });

  it("skips a channel with no recipient: nothing is sent and nothing is logged", async () => {
    const line = fakeAdapter("LINE", { recipients: false });
    const push = fakeAdapter("WEB_PUSH");
    const k = key();
    expect(await make([line, push]).notifier.deliver(input(k))).toEqual({ LINE: "unavailable", WEB_PUSH: "sent" });
    expect(line.calls()).toBe(0);
    expect((await rows(k)).map((r) => r.channel)).toEqual(["WEB_PUSH"]);
  });

  it("truncates long error text and tolerates non-Error failures", async () => {
    const k = key();
    const long = fakeAdapter("LINE", { failFirst: Infinity, error: new Error("x".repeat(2000)) });
    await make([long]).notifier.deliver(input(k));
    expect((await rows(k))[0]!.error!.length).toBe(500);
    const k2 = key();
    const odd = fakeAdapter("LINE", { failFirst: Infinity, error: "plain string" });
    await make([odd]).notifier.deliver(input(k2));
    expect((await rows(k2))[0]).toMatchObject({ status: "FAILED", error: "unknown error" });
  });

  it("takes over a notification abandoned mid-send, but leaves one that is still in progress", async () => {
    const adapter = fakeAdapter("LINE");
    const created = new Date(Date.now() - 60_000);
    const mk = (k: string, attempts: number, createdAt: Date) =>
      prisma.notificationLog.create({
        data: { dedupeKey: `DUE_TODAY:${k}:LINE`, type: "DUE_TODAY", channel: "LINE", scheduledDate: today, status: "PENDING", attempts, createdAt },
      });

    const fresh = key();
    await mk(fresh, 1, created); // 1 minute old: another process may still be sending
    expect(await make([adapter]).notifier.deliver(input(fresh))).toEqual({ LINE: "skipped" });
    expect(adapter.calls()).toBe(0);

    const stale = key();
    await mk(stale, 1, new Date(created.getTime() - STALE_PENDING_MS)); // abandoned
    expect(await make([adapter]).notifier.deliver(input(stale))).toEqual({ LINE: "sent" });
    expect(adapter.calls()).toBe(1);
    expect((await rows(stale))[0]).toMatchObject({ status: "SENT", attempts: 2 });

    const exhausted = key();
    await mk(exhausted, MAX_ATTEMPTS, new Date(created.getTime() - STALE_PENDING_MS));
    expect(await make([adapter]).notifier.deliver(input(exhausted))).toEqual({ LINE: "skipped" });
  });

  it("keeps message content out of the log", async () => {
    const k = key();
    const { notifier, log } = make([fakeAdapter("LINE", { failFirst: Infinity })]);
    await notifier.deliver({ ...input(k), message: { ...message, line: "ลับ-ชื่อลูกค้า-5000" } });
    expect(log.join("\n")).not.toContain("ลับ-ชื่อลูกค้า-5000");
  });

  it("background dispatch never throws into the caller, and drain waits for it", async () => {
    const { notifier, log } = make([fakeAdapter("LINE")]);
    let finished = false;
    notifier.dispatch(async () => {
      await new Promise((r) => setTimeout(r, 80));
      finished = true;
    });
    notifier.dispatch(async () => {
      throw new Error("boom");
    });
    expect(finished).toBe(false);
    await notifier.drain();
    expect(finished).toBe(true);
    expect(log.some((m) => m.includes("background notification failed: boom"))).toBe(true);
  });

  describe("NEW_REQUEST", () => {
    async function request(status: "PENDING" | "APPROVED" = "PENDING") {
      const user = await prisma.user.create({ data: { username: `${marker}-u${++seq}`, passwordHash: "x", role: "BORROWER" } });
      const b = await prisma.borrower.create({ data: { userId: user.id, fullName: `${marker} สมชาย ${seq}` } });
      return prisma.loanRequest.create({
        data: { borrowerId: b.id, amount: "5000", requestedDueDate: new Date(Date.now() + 30 * 86_400_000), status, createdById: user.id },
        include: { borrower: true },
      });
    }

    it("tells the admin about a pending request with its details, once", async () => {
      const r = await request();
      const sent: RenderedMessage[] = [];
      const line = { ...fakeAdapter("LINE"), send: async (m: RenderedMessage) => void sent.push(m) };
      const { notifier } = make([line]);
      expect(await notifier.newRequest(r.id)).toEqual({ LINE: "sent" });
      expect(sent[0]!.line).toContain(r.borrower.fullName);
      expect(sent[0]!.line).toContain("5,000 บาท");
      expect(await notifier.newRequest(r.id)).toEqual({ LINE: "skipped" });
      expect(sent).toHaveLength(1);
      const [row] = await prisma.notificationLog.findMany({ where: { dedupeKey: `NEW_REQUEST:${r.id}:LINE` } });
      expect(row).toMatchObject({ type: "NEW_REQUEST", status: "SENT" });
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { contains: r.id } } });
    });

    it("says nothing for a request that is no longer pending or does not exist", async () => {
      const r = await request("APPROVED");
      const line = fakeAdapter("LINE");
      const { notifier } = make([line]);
      expect(await notifier.newRequest(r.id)).toEqual({});
      expect(await notifier.newRequest("does-not-exist")).toEqual({});
      expect(line.calls()).toBe(0);
    });
  });
});
