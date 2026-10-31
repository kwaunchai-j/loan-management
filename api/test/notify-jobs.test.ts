import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient, type NotificationChannel } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { notificationJobs, runDueTodayRound, runOverdueRound } from "../src/jobs/notify-jobs.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { Notifier } from "../src/notifications/service.js";
import type { ChannelAdapter, RenderedMessage } from "../src/notifications/types.js";
import { completeProfile, RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t404${Date.now()}`;
// The rounds are exercised on a made-up day far from any real one, so a notification already logged by a
// running developer scheduler (one per type/day/channel) can never collide with these tests.
const NOW = new Date("2031-03-15T05:00:00Z");
const today = bangkokToday(NOW);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));
// the request hook runs on the real clock
const realDay = (n: number) => formatDateOnly(addDays(bangkokToday(), n));

function recorder(channel: NotificationChannel, o: { delayMs?: number; fail?: boolean } = {}) {
  const sent: RenderedMessage[] = [];
  const adapter: ChannelAdapter = {
    channel,
    hasRecipients: async () => true,
    send: async (m) => {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.fail) throw new Error("channel down");
      sent.push(m);
    },
  };
  return { adapter, sent };
}

const makeNotifier = (adapters: ChannelAdapter[]) => new Notifier({ prisma, adapters, retryDelaysMs: [0, 0], log: () => undefined });

describe.skipIf(!dbUp)("notification rounds and the new-request hook (PostgreSQL)", () => {
  let borrowerId: string;
  let borrowerUserId: string;
  let adminId: string;
  let seq = 0;
  const contractNos: Record<string, string> = {};

  async function contract(label: string, o: { dueIn: number; principal?: string; interest?: string; status?: "ACTIVE" | "CLOSED" | "AWAITING_DISBURSEMENT" | "CANCELLED" }) {
    const { dueIn, principal = "1000", interest = "100", status = "ACTIVE" } = o;
    const paidOut = status === "ACTIVE" || status === "CLOSED";
    const c = await prisma.contract.create({
      data: {
        contractNo: `T-${marker}-${++seq}`,
        borrowerId,
        principal,
        dueDate: addDays(today, dueIn),
        status,
        disbursedOn: paidOut ? addDays(today, -60) : null,
        interestRatePctPerMonth: paidOut ? "3" : null,
        lateFeeRatePctPerDay: paidOut ? "1" : null,
        interestAmount: paidOut ? interest : null,
        outstandingPrincipal: status === "CLOSED" ? "0" : principal,
        outstandingInterest: status === "CLOSED" ? "0" : paidOut ? interest : 0,
        closedOn: status === "CLOSED" ? addDays(today, -1) : null,
      },
    });
    contractNos[label] = c.contractNo;
    return c;
  }

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, passwordHash: await hashPassword(PASSWORD), role: "ADMIN", mustChangePassword: false } });
    adminId = admin.id;
    const bu = await prisma.user.create({ data: { username: `${marker}-b`, passwordHash: await hashPassword(PASSWORD), role: "BORROWER", mustChangePassword: false } });
    borrowerUserId = bu.id;
    borrowerId = (await prisma.borrower.create({ data: { userId: bu.id, fullName: `${marker} สมหญิง`, ...completeProfile(), pdpaAcceptedAt: new Date() } })).id;
  });

  afterAll(async () => {
    const contracts = (await prisma.contract.findMany({ where: { borrowerId }, select: { id: true } })).map((c) => c.id);
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    const requests = (await prisma.loanRequest.findMany({ where: { borrowerId }, select: { id: true } })).map((r) => r.id);
    await prisma.notificationLog.deleteMany({ where: { OR: [{ dedupeKey: { contains: marker } }, { dedupeKey: { in: requests.flatMap((id) => [`NEW_REQUEST:${id}:LINE`, `NEW_REQUEST:${id}:WEB_PUSH`]) } }] } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, borrowerUserId] } } });
    await prisma.loanRequest.deleteMany({ where: { borrowerId } });
    await prisma.borrower.deleteMany({ where: { id: borrowerId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, borrowerUserId] } } });
    await prisma.$disconnect();
  });

  describe("09:00 due-today and 17:00 overdue rounds (DES-013)", () => {
    it("sends ONE due-today summary listing every contract due today that still owes money", async () => {
      await contract("dueA", { dueIn: 0 });
      await contract("dueB", { dueIn: 0, principal: "2000", interest: "200" });
      await contract("future", { dueIn: 3 });
      await contract("closedToday", { dueIn: 0, status: "CLOSED" });
      await contract("awaiting", { dueIn: 0, status: "AWAITING_DISBURSEMENT" });
      await contract("overdue", { dueIn: -2 });
      const { adapter, sent } = recorder("LINE");
      const result = await runDueTodayRound(prisma, makeNotifier([adapter]), NOW);
      expect(result.outcome).toEqual({ LINE: "sent" });
      expect(sent).toHaveLength(1); // one message for the whole round, not one per contract
      const text = sent[0]!.line;
      expect(text).toContain(contractNos.dueA!);
      expect(text).toContain(contractNos.dueB!);
      expect(text).toContain("1,100 บาท");
      expect(text).toContain("2,200 บาท");
      for (const left of ["future", "closedToday", "awaiting", "overdue"]) expect(text).not.toContain(contractNos[left]!);
      expect(sent[0]!.push.title).toMatch(/วันนี้ครบกำหนดชำระ \d+ สัญญา/);
      const [row] = await prisma.notificationLog.findMany({ where: { dedupeKey: `DUE_TODAY:${day(0)}:LINE` } });
      expect(row).toMatchObject({ type: "DUE_TODAY", status: "SENT" });
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: `DUE_TODAY:${day(0)}` } } });
    });

    it("sends ONE overdue summary from the due date on, with how many days late and what is owed incl. today's fee", async () => {
      // due 3 days ago: owed today 1,135 (1 % a day, compounding, each day rounded up to a whole baht); due today: 1,100
      await contract("late3", { dueIn: -3 });
      await contract("dueNow", { dueIn: 0 });
      await contract("notYet", { dueIn: 1 });
      await contract("settled", { dueIn: -3, status: "CLOSED" });
      const { adapter, sent } = recorder("LINE");
      await runOverdueRound(prisma, makeNotifier([adapter]), NOW);
      expect(sent).toHaveLength(1);
      const text = sent[0]!.line;
      expect(text).toContain(`(${contractNos.late3}) เลย 3 วัน ค้าง 1,135 บาท`);
      expect(text).toContain(`(${contractNos.dueNow}) ครบกำหนดวันนี้ ค้าง 1,100 บาท`);
      for (const left of ["notYet", "settled"]) expect(text).not.toContain(contractNos[left]!);
      // oldest first
      expect(text.indexOf(contractNos.late3!)).toBeLessThan(text.indexOf(contractNos.dueNow!));
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: `OVERDUE:${day(0)}` } } });
    });

    it("uses what is owed after payments, and leaves out a contract that has been paid off", async () => {
      const c = await contract("part", { dueIn: -1 }); // owed today: 1,100 + 11 = 1,111
      const paid = await contract("paidoff", { dueIn: -1 });
      const admin = adminId;
      await prisma.payment.create({ data: { contractId: c.id, amount: "111", paidOn: today, recordedById: admin, allocatedLateFee: "11", allocatedInterest: "100" } });
      await prisma.payment.create({ data: { contractId: paid.id, amount: "1111", paidOn: today, recordedById: admin, allocatedLateFee: "11", allocatedInterest: "100", allocatedPrincipal: "1000" } });
      const { adapter, sent } = recorder("LINE");
      await runOverdueRound(prisma, makeNotifier([adapter]), NOW);
      expect(sent[0]!.line).toContain(`(${c.contractNo}) เลย 1 วัน ค้าง 1,000 บาท`);
      expect(sent[0]!.line).not.toContain(paid.contractNo);
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: `OVERDUE:${day(0)}` } } });
    });

    it("sends nothing at all when no contract qualifies", async () => {
      const { adapter, sent } = recorder("LINE");
      // a day long ago on which none of this file's contracts is due
      const longAgo = new Date("2000-01-01T05:00:00Z");
      expect(await runDueTodayRound(prisma, makeNotifier([adapter]), longAgo)).toEqual({ contracts: 0, outcome: {} });
      expect(await runOverdueRound(prisma, makeNotifier([adapter]), longAgo)).toEqual({ contracts: 0, outcome: {} });
      expect(sent).toHaveLength(0);
    });

    it("runs a round again on the same day without sending a second time", async () => {
      await contract("rerun", { dueIn: 0 });
      const { adapter, sent } = recorder("LINE");
      const notifier = makeNotifier([adapter]);
      expect((await runDueTodayRound(prisma, notifier, NOW)).outcome).toEqual({ LINE: "sent" });
      expect((await runDueTodayRound(prisma, notifier, NOW)).outcome).toEqual({ LINE: "skipped" });
      expect(sent).toHaveLength(1);
      // the 17:00 round is protected the same way
      expect((await runOverdueRound(prisma, notifier, NOW)).outcome).toEqual({ LINE: "sent" });
      expect((await runOverdueRound(prisma, notifier, NOW)).outcome).toEqual({ LINE: "skipped" });
      expect(sent).toHaveLength(2);
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: `OVERDUE:${day(0)}` } } });
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: `DUE_TODAY:${day(0)}` } } });
    });

    it("delivers on both channels, and one failing channel does not stop the other", async () => {
      const line = recorder("LINE", { fail: true });
      const push = recorder("WEB_PUSH");
      const result = await runOverdueRound(prisma, makeNotifier([line.adapter, push.adapter]), NOW);
      expect(result.outcome).toEqual({ LINE: "failed", WEB_PUSH: "sent" });
      expect(push.sent).toHaveLength(1);
      const rows = await prisma.notificationLog.findMany({ where: { dedupeKey: { startsWith: `OVERDUE:${day(0)}` } }, orderBy: { channel: "asc" } });
      expect(rows.map((r) => [r.channel, r.status, r.attempts])).toEqual([["LINE", "FAILED", 3], ["WEB_PUSH", "SENT", 1]]);
      await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: `OVERDUE:${day(0)}` } } });
    });

    it("registers the jobs at 09:00 and 17:00 on the shared scheduler", () => {
      const jobs = notificationJobs(prisma, makeNotifier([]));
      expect(jobs.map((j) => [j.name, j.at])).toEqual([["notify-due-today", "09:00"], ["notify-overdue", "17:00"]]);
    });
  });

  describe("NEW_REQUEST is sent as soon as a borrower files a request (DES-013)", () => {
    let server: Server;
    let baseUrl: string;
    let borrowerCookie: string;
    let adminCookie: string;

    const cookieOf = (res: Response) =>
      res.headers
        .getSetCookie()
        .find((c) => c.startsWith("loan_session="))!
        .split(";")[0]!;

    async function boot(notifier: Notifier) {
      server = buildApp({
        prisma,
        sessionSecret: SECRET,
        fieldEncryptionKey: TEST_FIELD_KEY,
        slipStorage: TEST_SLIP_STORAGE,
        importStorage: TEST_IMPORT_STORAGE,
        loginRateLimit: RELAXED_LOGIN_LIMITS,
        notifier,
      }).app.listen(0);
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const login = async (u: string) =>
        cookieOf(
          await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: `${marker}-${u}`, password: PASSWORD }),
          }),
        );
      borrowerCookie = await login("b");
      adminCookie = await login("admin");
    }
    const post = (path: string, cookie: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const stop = () => new Promise<void>((r) => server.close(() => r()));

    it("notifies the admin with the borrower, amount and due date, once", async () => {
      const { adapter, sent } = recorder("LINE");
      const notifier = makeNotifier([adapter]);
      await boot(notifier);
      try {
        const res = await post("/loan-requests", borrowerCookie, { amount: "5000", requestedDueDate: realDay(30) });
        expect(res.status).toBe(201);
        const id = (await res.json()).id as string;
        await notifier.drain();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.line).toContain("สมหญิง");
        expect(sent[0]!.line).toContain("5,000 บาท");
        expect(await prisma.notificationLog.count({ where: { dedupeKey: `NEW_REQUEST:${id}:LINE`, status: "SENT" } })).toBe(1);
      } finally {
        await stop();
      }
    });

    it("never fails or waits for the borrower when a channel is down or slow", async () => {
      const slowFailing = recorder("LINE", { delayMs: 600, fail: true });
      const notifier = makeNotifier([slowFailing.adapter]);
      await boot(notifier);
      try {
        const started = Date.now();
        const res = await post("/loan-requests", borrowerCookie, { amount: "100", requestedDueDate: realDay(20) });
        expect(res.status).toBe(201);
        expect(Date.now() - started).toBeLessThan(500); // the response did not wait for the 3 slow attempts
        await notifier.drain();
        expect(await prisma.notificationLog.count({ where: { channel: "LINE", status: "FAILED", type: "NEW_REQUEST", dedupeKey: { contains: (await res.json()).id } } })).toBe(1);
      } finally {
        await stop();
      }
    });

    it("says nothing for a request the borrower could not file, or one the admin filed on their behalf", async () => {
      const { adapter, sent } = recorder("LINE");
      const notifier = makeNotifier([adapter]);
      await boot(notifier);
      try {
        expect((await post("/loan-requests", borrowerCookie, { amount: "0", requestedDueDate: realDay(30) })).status).toBe(400);
        expect((await post("/loan-requests", borrowerCookie, { amount: "10", requestedDueDate: realDay(0) })).status).toBe(400);
        const onBehalf = await post("/admin/loan-requests", adminCookie, { borrowerId, amount: "70", requestedDueDate: realDay(30) });
        expect(onBehalf.status).toBe(201);
        await notifier.drain();
        expect(sent).toHaveLength(0);
      } finally {
        await stop();
      }
    });
  });
});
