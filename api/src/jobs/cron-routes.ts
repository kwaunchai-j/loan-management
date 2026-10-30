import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Db } from "../db.js";
import { asyncHandler, sendError } from "../http.js";
import type { Notifier } from "../notifications/service.js";
import { runLateFeeJob } from "./late-fee-job.js";
import { runDueTodayRound, runOverdueRound } from "./notify-jobs.js";
import { withJobLock } from "./scheduler.js";

/**
 * The nightly jobs as HTTP routes, for a host with no long-running process (Vercel). Vercel Cron calls
 * them with GET and "Authorization: Bearer <CRON_SECRET>"; anything else is refused. Each run takes the same
 * advisory lock as the in-process scheduler, so two overlapping calls (or a call and a scheduler) never
 * run the same job twice. The jobs are idempotent (late-fee rows have a unique key, a notification round
 * is deduplicated by its date), so a repeated call is harmless.
 * The answers carry counts only: no names, amounts or contract numbers.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

export function createCronRouter(deps: { prisma: Db; secret: string; notifier?: Notifier }): Router {
  const router = Router();
  const expected = digest(`Bearer ${deps.secret}`);

  const requireSecret: RequestHandler = (req, res, next) => {
    const given = digest(req.headers.authorization ?? "");
    // compare fixed-length digests in constant time, so the secret cannot be guessed byte by byte
    if (!timingSafeEqual(given, expected)) return void sendError(res, 401, "UNAUTHENTICATED", "ไม่ได้รับอนุญาต");
    next();
  };
  router.use(requireSecret);

  async function run<T>(name: string, job: () => Promise<T>): Promise<{ ran: boolean; result?: T }> {
    let result: T | undefined;
    const ran = await withJobLock(deps.prisma, name, async () => {
      result = await job();
    });
    return { ran, result };
  }

  router.get(
    "/late-fee",
    asyncHandler(async (_req, res) => {
      const { ran, result } = await run("late-fee", () => runLateFeeJob(deps.prisma));
      if (result) for (const f of result.failed) console.error(`late-fee: contract ${f.contractId} failed: ${f.reason}`);
      res.json({ job: "late-fee", ran, checked: result?.checked ?? 0, failed: result?.failed.length ?? 0 });
    }),
  );

  router.get(
    "/notify-due-today",
    asyncHandler(async (_req, res) => {
      const notifier = deps.notifier;
      if (!notifier) return void res.json({ job: "notify-due-today", ran: false, reason: "no notifier" });
      const { ran, result } = await run("notify-due-today", () => runDueTodayRound(deps.prisma, notifier));
      res.json({ job: "notify-due-today", ran, contracts: result?.contracts ?? 0, outcome: result?.outcome ?? {} });
    }),
  );

  router.get(
    "/notify-overdue",
    asyncHandler(async (_req, res) => {
      const notifier = deps.notifier;
      if (!notifier) return void res.json({ job: "notify-overdue", ran: false, reason: "no notifier" });
      const { ran, result } = await run("notify-overdue", () => runOverdueRound(deps.prisma, notifier));
      res.json({ job: "notify-overdue", ran, contracts: result?.contracts ?? 0, outcome: result?.outcome ?? {} });
    }),
  );

  return router;
}
