import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { lateFeeJob } from "../src/jobs/late-fee-job.js";
import { notificationJobs } from "../src/jobs/notify-jobs.js";
import { advisoryKey, Scheduler, type Job } from "../src/jobs/scheduler.js";

/**
 * The scheduler's own logic with NO database: a stand-in for `prisma.$transaction` that either grants or
 * refuses the advisory lock. (The real lock against PostgreSQL is covered in scheduler.test.ts.)
 */
function fakeDb(opts: { locked?: boolean } = {}) {
  const lockResult = opts.locked ?? true;
  const tx = { $queryRaw: vi.fn(async () => [{ locked: lockResult }]) };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) } as unknown as Db;
  return { prisma, tx };
}

// Bangkok is UTC+7: 2026-10-30T02:00Z is 09:00 on the 30th, and 2026-10-30T17:30Z is 00:30 on the 31st.
const at = (iso: string) => () => new Date(iso);

describe("advisoryKey", () => {
  it("is stable for a name, different between names, and a positive 63-bit number", () => {
    expect(advisoryKey("late-fee")).toBe(advisoryKey("late-fee"));
    expect(advisoryKey("late-fee")).not.toBe(advisoryKey("notify-overdue"));
    for (const n of ["late-fee", "notify-due-today", "x", ""]) {
      const k = advisoryKey(n);
      expect(k >= 0n).toBe(true);
      expect(k <= 0x7fffffffffffffffn).toBe(true);
    }
  });
});

describe("Scheduler.tick (no database)", () => {
  const log = vi.fn();
  beforeEach(() => log.mockClear());
  const job = (over: Partial<Job> = {}): Job & { run: ReturnType<typeof vi.fn> } => ({ name: "j", at: "09:00", run: vi.fn(async () => undefined), ...over }) as never;

  it("does not run a job before its time, and runs it at/after its time", async () => {
    const { prisma } = fakeDb();
    const j = job();
    expect(await new Scheduler({ prisma, jobs: [j], now: at("2026-10-30T01:59:00Z"), log }).tick()).toEqual([]); // 08:59
    expect(j.run).not.toHaveBeenCalled();
    expect(await new Scheduler({ prisma, jobs: [j], now: at("2026-10-30T02:00:00Z"), log }).tick()).toEqual(["j"]); // 09:00
    expect(j.run).toHaveBeenCalledTimes(1);
  });

  it("runs a job once per Bangkok day, and again the next Bangkok day", async () => {
    const { prisma } = fakeDb();
    let now = new Date("2026-10-30T03:00:00Z"); // 10:00 on the 30th
    const j = job();
    const s = new Scheduler({ prisma, jobs: [j], now: () => now, log });
    expect(await s.tick()).toEqual(["j"]);
    expect(await s.tick()).toEqual([]); // same day
    now = new Date("2026-10-30T16:59:00Z"); // 23:59, still the 30th
    expect(await s.tick()).toEqual([]);
    now = new Date("2026-10-31T03:00:00Z"); // 10:00 on the 31st
    expect(await s.tick()).toEqual(["j"]);
    expect(j.run).toHaveBeenCalledTimes(2);
  });

  it("changes day at midnight in Bangkok, not at midnight UTC", async () => {
    const { prisma } = fakeDb();
    const j = job({ at: "00:05" });
    let now = new Date("2026-10-30T16:00:00Z"); // 23:00 on the 30th in Bangkok, still the 30th in UTC
    const s = new Scheduler({ prisma, jobs: [j], now: () => now, log });
    expect(await s.tick()).toEqual(["j"]);
    now = new Date("2026-10-30T17:30:00Z"); // 00:30 on the 31st in Bangkok, but still the 30th in UTC
    expect(await s.tick()).toEqual(["j"]); // a new Bangkok day, so the nightly job runs again
    expect(j.run).toHaveBeenCalledTimes(2);
  });

  it("runOnStart runs a job at the first tick even before its time, but only that once", async () => {
    const { prisma } = fakeDb();
    const j = job({ runOnStart: true, at: "23:00" });
    const s = new Scheduler({ prisma, jobs: [j], now: at("2026-10-30T03:00:00Z"), log }); // 10:00, before 23:00
    expect(await s.tick()).toEqual(["j"]);
    expect(await s.tick()).toEqual([]);
  });

  it("hands the job the clock it was given", async () => {
    const { prisma } = fakeDb();
    const j = job();
    const now = new Date("2026-10-30T03:00:00Z");
    await new Scheduler({ prisma, jobs: [j], now: () => now, log }).tick();
    expect(j.run).toHaveBeenCalledWith({ now });
  });

  it("skips a job whose lock another process holds, and says so", async () => {
    const { prisma } = fakeDb({ locked: false });
    const j = job();
    expect(await new Scheduler({ prisma, jobs: [j], now: at("2026-10-30T03:00:00Z"), log }).tick()).toEqual([]);
    expect(j.run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped: another process holds the lock"));
  });

  it("a failing job is logged without its details, does not stop the others, and is not retried the same day", async () => {
    const { prisma } = fakeDb();
    const bad = job({ name: "bad", run: vi.fn(async () => { throw new Error("boom: secret detail"); }) as never });
    const good = job({ name: "good" });
    let now = new Date("2026-10-30T03:00:00Z");
    const s = new Scheduler({ prisma, jobs: [bad, good], now: () => now, log });
    expect(await s.tick()).toEqual(["good"]);
    expect(log).toHaveBeenCalledWith("job bad failed: boom: secret detail");
    expect(await s.tick()).toEqual([]);
    expect(bad.run).toHaveBeenCalledTimes(1); // not retried every tick
    now = new Date("2026-10-31T03:00:00Z");
    await s.tick();
    expect(bad.run).toHaveBeenCalledTimes(2); // tomorrow it tries again
  });

  it("reports an unknown (non-Error) failure with a generic text", async () => {
    const { prisma } = fakeDb();
    const j = job({ run: vi.fn(async () => { throw "weird"; }) as never });
    await new Scheduler({ prisma, jobs: [j], now: at("2026-10-30T03:00:00Z"), log }).tick();
    expect(log).toHaveBeenCalledWith("job j failed: unknown error");
  });

  it("a slow tick is never overlapped by the next one", async () => {
    const { prisma } = fakeDb();
    let release!: () => void;
    const j = job({ run: vi.fn(() => new Promise<void>((r) => { release = r; })) as never });
    const clock = vi.fn(() => new Date("2026-10-30T03:00:00Z"));
    const s = new Scheduler({ prisma, jobs: [j], now: clock, log });
    const first = s.tick();
    await vi.waitFor(() => expect(j.run).toHaveBeenCalled());
    expect(await s.tick()).toEqual([]); // second tick while the first is still running
    expect(clock).toHaveBeenCalledTimes(1); // it returned at once: it did not even look at the jobs
    release();
    expect(await first).toEqual(["j"]);
    expect(j.run).toHaveBeenCalledTimes(1);
    await s.tick(); // and once the slow one is over, ticking works again
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("refuses a bad time at construction (fail fast), not at 09:00 on some night", () => {
    const { prisma } = fakeDb();
    for (const bad of ["9:00pm", "24:00", "12:60", "", "noon"]) {
      expect(() => new Scheduler({ prisma, jobs: [job({ at: bad })] }), bad).toThrow();
    }
  });
});

describe("Scheduler.start / stop (timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks at once and then every tickMs; start() twice adds no second timer; stop() ends it", async () => {
    const { prisma } = fakeDb();
    const j: Job = { name: "j", at: "00:00", run: vi.fn(async () => undefined) };
    // every tick reads the clock exactly once, so the number of clock reads = the number of ticks
    const clock = vi.fn(() => new Date("2026-10-30T03:00:00Z"));
    const s = new Scheduler({ prisma, jobs: [j], tickMs: 1000, now: clock, log: () => undefined });
    s.start();
    s.start(); // ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(clock).toHaveBeenCalledTimes(1); // the immediate tick
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock).toHaveBeenCalledTimes(2); // one timer: one tick per interval
    await vi.advanceTimersByTimeAsync(2000);
    expect(clock).toHaveBeenCalledTimes(4);
    s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clock).toHaveBeenCalledTimes(4); // stopped: no more ticks
    s.stop(); // stopping twice is harmless
    expect(j.run).toHaveBeenCalledTimes(1); // and the job itself ran once for that Bangkok day
  });

  it("can be started again after it was stopped", async () => {
    const { prisma } = fakeDb();
    const clock = vi.fn(() => new Date("2026-10-30T03:00:00Z"));
    const s = new Scheduler({ prisma, jobs: [], tickMs: 1000, now: clock, log: () => undefined });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    clock.mockClear();
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock).toHaveBeenCalledTimes(2);
    s.stop();
  });
});

describe("the jobs the server registers", () => {
  it("late-fee: 00:05 every night and also at start-up, and its run() works through runLateFeeJob", async () => {
    const findMany = vi.fn(async () => []);
    const job = lateFeeJob({ contract: { findMany } } as unknown as Db);
    expect(job).toMatchObject({ name: "late-fee", at: "00:05", runOnStart: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await job.run({ now: new Date("2026-10-30T03:00:00Z") });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE", dueDate: { lt: new Date("2026-10-30T00:00:00.000Z") } } }));
    expect(logSpy).toHaveBeenCalledWith("late-fee: checked 0, failed 0");
    logSpy.mockRestore();
  });

  it("notifications: 09:00 due-today and 17:00 overdue, each sending nothing when no contract qualifies", async () => {
    const findMany = vi.fn(async () => []);
    const deliver = vi.fn();
    const jobs = notificationJobs({ contract: { findMany } } as unknown as Db, { deliver } as never);
    expect(jobs.map((j) => [j.name, j.at])).toEqual([
      ["notify-due-today", "09:00"],
      ["notify-overdue", "17:00"],
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const j of jobs) await j.run({ now: new Date("2026-10-30T03:00:00Z") });
    expect(logSpy).toHaveBeenCalledWith("notify-due-today: 0 contract(s) {}");
    expect(logSpy).toHaveBeenCalledWith("notify-overdue: 0 contract(s) {}");
    expect(deliver).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
