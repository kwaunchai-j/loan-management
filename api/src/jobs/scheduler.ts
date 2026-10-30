import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { bangkokMinutesOfDay, bangkokToday, formatDateOnly, parseClockTime } from "../lib/dates.js";

/**
 * The one scheduler (T-304). Notifications (T-404) add their jobs here; never create a second one.
 *  - Times are Asia/Bangkok. A job runs once per Bangkok day, at the first tick at/after its time.
 *  - `runOnStart` also runs a job at the first tick after the process starts: after downtime the
 *    work is caught up (jobs must be idempotent; the late-fee job rebuilds anything missing).
 *  - Only one process may run a job at a time: a Postgres advisory lock is taken for the duration
 *    of each run, so a second instance (a mistake, or a deploy overlap) simply skips it.
 */
export interface Job {
  name: string;
  /** "HH:MM", Asia/Bangkok. */
  at: string;
  runOnStart?: boolean;
  run: (ctx: { now: Date }) => Promise<unknown>;
}

export interface SchedulerOptions {
  prisma: Db;
  jobs: Job[];
  now?: () => Date;
  tickMs?: number;
  log?: (message: string) => void;
}

/** Stable 63-bit key per job name for pg advisory locks. */
export function advisoryKey(name: string): bigint {
  return createHash("sha256").update(`loan-management:job:${name}`).digest().readBigInt64BE(0) & 0x7fffffffffffffffn;
}

/** Runs `fn` only if no other process holds the job's lock. Returns whether it ran. */
export async function withJobLock(prisma: Db, name: string, fn: () => Promise<void>): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        select pg_try_advisory_xact_lock(${advisoryKey(name)}::bigint) as locked`;
      if (!rows[0]?.locked) return false;
      await fn();
      return true;
    },
    // the lock lives as long as this transaction, i.e. as long as the job runs
    { maxWait: 10_000, timeout: 30 * 60 * 1000 },
  );
}

export class Scheduler {
  private readonly lastRunDay = new Map<string, string>();
  private readonly started = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => console.log(m));
    for (const j of opts.jobs) parseClockTime(j.at); // fail fast on a bad time
  }

  /** Checks every job once; returns the names of the jobs that actually ran. */
  async tick(): Promise<string[]> {
    if (this.ticking) return []; // a slow tick must not overlap the next one
    this.ticking = true;
    const ran: string[] = [];
    try {
      const now = this.now();
      const day = formatDateOnly(bangkokToday(now));
      const minutes = bangkokMinutesOfDay(now);
      for (const job of this.opts.jobs) {
        const firstTick = !this.started.has(job.name);
        this.started.add(job.name);
        const dueToday = minutes >= parseClockTime(job.at) && this.lastRunDay.get(job.name) !== day;
        if (!dueToday && !(firstTick && job.runOnStart)) continue;
        // Mark first: a failing job is retried tomorrow (or at next start), not every tick.
        this.lastRunDay.set(job.name, day);
        try {
          const executed = await withJobLock(this.opts.prisma, job.name, async () => {
            await job.run({ now });
          });
          if (executed) {
            ran.push(job.name);
            this.log(`job ${job.name} finished`);
          } else {
            this.log(`job ${job.name} skipped: another process holds the lock`);
          }
        } catch (err) {
          this.log(`job ${job.name} failed: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
