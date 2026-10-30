import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { bangkokMinutesOfDay, bangkokToday, formatDateOnly, parseClockTime } from "../src/lib/dates.js";
import { runLateFeeJob } from "../src/jobs/late-fee-job.js";
import { advisoryKey, Scheduler, type Job } from "../src/jobs/scheduler.js";

describe("Bangkok clock helpers", () => {
  it("reads the Asia/Bangkok time (UTC+7), not UTC", () => {
    expect(bangkokMinutesOfDay(new Date("2026-10-29T17:05:00Z"))).toBe(5); // 00:05 on the 30th
    expect(bangkokMinutesOfDay(new Date("2026-10-29T09:00:00Z"))).toBe(16 * 60);
    expect(bangkokMinutesOfDay(new Date("2026-10-29T16:59:00Z"))).toBe(23 * 60 + 59);
    expect(formatDateOnly(bangkokToday(new Date("2026-10-29T17:05:00Z")))).toBe("2026-10-30");
  });

  it("parses HH:MM and rejects anything else", () => {
    expect(parseClockTime("00:05")).toBe(5);
    expect(parseClockTime("17:00")).toBe(1020);
    for (const bad of ["24:00", "9:00", "09:60", "0905", "", "09:00:00"]) {
      expect(() => parseClockTime(bad), bad).toThrow();
    }
  });

  it("gives every job its own stable lock key", () => {
    expect(advisoryKey("late-fee")).toBe(advisoryKey("late-fee"));
    expect(advisoryKey("late-fee")).not.toBe(advisoryKey("notify-due"));
    expect(advisoryKey("late-fee") >= 0n).toBe(true);
  });
});

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const marker = `t304${Date.now()}`;
const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));

/** Bangkok wall-clock time as a real instant: Bangkok is UTC+7 all year. */
const bangkok = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

describe.skipIf(!dbUp)("scheduler (PostgreSQL advisory lock)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const makeJob = (name: string, at: string, opts: Partial<Job> = {}) => {
    const runs: Date[] = [];
    const job: Job = { name: `${marker}-${name}`, at, run: async ({ now }) => void runs.push(now), ...opts };
    return { job, runs };
  };
  const scheduler = (jobs: Job[], clock: { now: Date }, log: string[] = []) =>
    new Scheduler({ prisma, jobs, now: () => clock.now, log: (m) => log.push(m) });

  it("does not run before its time, runs once at the first tick after it, and not again that day", async () => {
    const { job, runs } = makeJob("daily", "00:05");
    const clock = { now: bangkok("2026-11-02", "00:04") };
    const s = scheduler([job], clock);
    expect(await s.tick()).toEqual([]);
    clock.now = bangkok("2026-11-02", "00:05");
    expect(await s.tick()).toEqual([job.name]);
    clock.now = bangkok("2026-11-02", "13:00");
    expect(await s.tick()).toEqual([]);
    expect(runs).toHaveLength(1);
  });

  it("runs again on the next Bangkok day, using Bangkok midnight not UTC midnight", async () => {
    const { job, runs } = makeJob("nextday", "00:05");
    const clock = { now: bangkok("2026-11-02", "00:10") };
    const s = scheduler([job], clock);
    await s.tick();
    clock.now = bangkok("2026-11-02", "23:59");
    await s.tick();
    clock.now = bangkok("2026-11-03", "00:04");
    expect(await s.tick()).toEqual([]);
    clock.now = bangkok("2026-11-03", "00:06");
    expect(await s.tick()).toEqual([job.name]);
    expect(runs).toHaveLength(2);
  });

  it("catches up when the process starts late: a job whose time has passed runs at the first tick", async () => {
    const { job, runs } = makeJob("late-start", "09:00");
    const s = scheduler([job], { now: bangkok("2026-11-02", "14:30") });
    expect(await s.tick()).toEqual([job.name]);
    expect(runs).toHaveLength(1);
  });

  it("runOnStart runs a job at the first tick even before its time, then waits for the next day", async () => {
    const { job, runs } = makeJob("on-start", "00:05", { runOnStart: true });
    const clock = { now: bangkok("2026-11-02", "23:50") };
    const s = scheduler([job], clock);
    expect(await s.tick()).toEqual([job.name]);
    clock.now = bangkok("2026-11-03", "00:05");
    expect(await s.tick()).toEqual([job.name]);
    expect(runs).toHaveLength(2);
  });

  it("a failing job does not stop the others and is not retried the same day", async () => {
    let attempts = 0;
    const broken: Job = { name: `${marker}-broken`, at: "00:05", run: async () => void (attempts++, Promise.reject(new Error("boom")).catch(() => undefined), (() => { throw new Error("boom"); })()) };
    const good = makeJob("good", "00:05");
    const log: string[] = [];
    const clock = { now: bangkok("2026-11-02", "00:10") };
    const s = scheduler([broken, good.job], clock, log);
    expect(await s.tick()).toEqual([good.job.name]);
    clock.now = bangkok("2026-11-02", "00:11");
    await s.tick();
    expect(attempts).toBe(1);
    expect(good.runs).toHaveLength(1);
    expect(log.some((m) => m.includes("failed: boom"))).toBe(true);
  });

  it("rejects a bad time at construction", () => {
    expect(() => scheduler([makeJob("bad", "25:00").job], { now: new Date() })).toThrow();
  });

  it("lets only one process run a job at a time (advisory lock)", { timeout: 30_000 }, async () => {
    // open the pooled connections first: a fresh one takes ~2 s through Docker Desktop, which would
    // let the first run finish before the second process even asks for the lock
    await Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw`select pg_sleep(0.3)::text`));
    let running = 0;
    let peak = 0;
    let total = 0;
    const job: Job = {
      name: `${marker}-exclusive`,
      at: "00:05",
      run: async () => {
        running++;
        peak = Math.max(peak, running);
        total++;
        await new Promise((r) => setTimeout(r, 1500));
        running--;
      },
    };
    const clock = { now: bangkok("2026-11-02", "00:10") };
    const logA: string[] = [];
    const logB: string[] = [];
    const a = scheduler([job], clock, logA);
    const b = scheduler([job], clock, logB); // a second instance, e.g. by mistake or during a deploy
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect(total).toBe(1);
    expect(peak).toBe(1);
    expect([ra.length, rb.length].sort()).toEqual([0, 1]);
    expect([...logA, ...logB].some((m) => m.includes("skipped: another process holds the lock"))).toBe(true);
    // once the first run is over the lock is free again
    clock.now = bangkok("2026-11-03", "00:10");
    expect(await a.tick()).toEqual([job.name]);
  });

  it("does not overlap its own ticks", async () => {
    const slow: Job = { name: `${marker}-slow`, at: "00:05", run: () => new Promise((r) => setTimeout(r, 300)) };
    const s = scheduler([slow], { now: bangkok("2026-11-02", "00:10") });
    const [first, second] = await Promise.all([s.tick(), s.tick()]);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
  });
});

describe.skipIf(!dbUp)("nightly late-fee job (PostgreSQL)", () => {
  let borrowerId: string;
  let seq = 0;
  const mine = new Set<string>();
  // The job looks at every overdue contract in the database, so only this file's contracts are judged.
  const failedOfMine = (r: { failed: Array<{ contractId: string; reason: string }> }) => r.failed.filter((f) => mine.has(f.contractId));

  async function makeActive(o: { dueIn: number; principal?: string; interest?: string; status?: "ACTIVE" | "CLOSED" | "AWAITING_DISBURSEMENT" }) {
    const { dueIn, principal = "1000", interest = "100", status = "ACTIVE" } = o;
    const awaiting = status === "AWAITING_DISBURSEMENT";
    const created = await prisma.contract.create({
      data: {
        contractNo: `T-${marker}-${++seq}`,
        borrowerId,
        principal,
        dueDate: addDays(today, dueIn),
        status,
        disbursedOn: awaiting ? null : addDays(today, -60),
        interestRatePctPerMonth: awaiting ? null : "3",
        lateFeeRatePctPerDay: awaiting ? null : "1",
        interestAmount: awaiting ? null : interest,
        outstandingPrincipal: principal,
        outstandingInterest: awaiting ? 0 : interest,
      },
    });
    mine.add(created.id);
    return created;
  }
  const rows = (contractId: string) => prisma.lateFeeAccrual.findMany({ where: { contractId }, orderBy: { accrualDate: "asc" } });

  beforeAll(async () => {
    borrowerId = (await prisma.borrower.create({ data: { fullName: `${marker} borrower` } })).id;
  });

  afterAll(async () => {
    const contracts = (await prisma.contract.findMany({ where: { borrowerId }, select: { id: true } })).map((c) => c.id);
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.lateFeeAccrual.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.borrower.deleteMany({ where: { id: borrowerId } });
    await prisma.user.deleteMany({ where: { username: `${marker}-recorder` } });
  });

  it("writes every missing day for an overdue contract and updates its balances", async () => {
    const c = await makeActive({ dueIn: -3 });
    const result = await runLateFeeJob(prisma);
    expect(failedOfMine(result)).toEqual([]);
    expect((await rows(c.id)).map((r) => [formatDateOnly(r.accrualDate), r.baseAmount.toFixed(2), r.amount.toFixed(2)])).toEqual([
      [day(-2), "1100.00", "11.00"],
      [day(-1), "1111.00", "12.00"],
      [day(0), "1123.00", "12.00"],
    ]);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.accruedLateFee.toFixed(2)).toBe("35.00");
    expect(after.status).toBe("ACTIVE");
  });

  it("is idempotent: a second run changes nothing and rewrites no rows", async () => {
    const c = await makeActive({ dueIn: -2 });
    await runLateFeeJob(prisma);
    const first = await rows(c.id);
    const second = await runLateFeeJob(prisma);
    expect(failedOfMine(second)).toEqual([]);
    const again = await rows(c.id);
    expect(again.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(again.map((r) => r.createdAt.getTime())).toEqual(first.map((r) => r.createdAt.getTime()));
    expect(again).toHaveLength(2);
  });

  it("ignores contracts that are not overdue, not paid out, or already closed", async () => {
    const notDue = await makeActive({ dueIn: 0 }); // due today: no fee yet
    const future = await makeActive({ dueIn: 5 });
    const awaiting = await makeActive({ dueIn: -5, status: "AWAITING_DISBURSEMENT" });
    const closed = await makeActive({ dueIn: -5, status: "CLOSED" });
    await runLateFeeJob(prisma);
    for (const c of [notDue, future, awaiting, closed]) expect(await rows(c.id)).toHaveLength(0);
  });

  it("catches up several missed days in one run, even after partial progress", async () => {
    const c = await makeActive({ dueIn: -2 });
    // as if the job ran on the first late day and then the server was down
    await prisma.lateFeeAccrual.create({
      data: { contractId: c.id, accrualDate: addDays(today, -1), baseAmount: "1100", ratePctPerDay: "1", amount: "11" },
    });
    await prisma.contract.update({ where: { id: c.id }, data: { accruedLateFee: "11" } });
    // the job comes back 3 days later: today + 3 (injected clock)
    const result = await runLateFeeJob(prisma, addDays(new Date(), 3));
    expect(failedOfMine(result)).toEqual([]);
    const list = await rows(c.id);
    expect(list).toHaveLength(5); // days -1 .. +3 after the due date, i.e. 5 late days in total
    const fees = list.map((r) => r.amount.toFixed(2));
    expect(fees).toEqual(["11.00", "12.00", "12.00", "12.00", "12.00"]); // bases 1100, 1111, 1123, 1135, 1147 at 1 %, each rounded up to a whole baht
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.accruedLateFee.toFixed(2)).toBe("59.00");
  });

  it("a contract that cannot be reconciled is reported and does not stop the others", async () => {
    const broken = await makeActive({ dueIn: -3 });
    // a payment far above anything owed, inserted behind the application's back
    await prisma.payment.create({
      data: { contractId: broken.id, amount: "50000", paidOn: addDays(today, -1), recordedById: (await ensureUser()).id },
    });
    const fine = await makeActive({ dueIn: -3 });
    const result = await runLateFeeJob(prisma);
    expect(failedOfMine(result).map((f) => f.contractId)).toEqual([broken.id]);
    expect(result.failed.find((f) => f.contractId === broken.id)!.reason).toContain("AMOUNT_EXCEEDS_DUE");
    expect(await rows(broken.id)).toHaveLength(0); // its transaction rolled back
    expect(await rows(fine.id)).toHaveLength(3);
  });

  async function ensureUser() {
    return prisma.user.upsert({
      where: { username: `${marker}-recorder` },
      create: { username: `${marker}-recorder`, passwordHash: "x", role: "ADMIN" },
      update: {},
    });
  }

});
