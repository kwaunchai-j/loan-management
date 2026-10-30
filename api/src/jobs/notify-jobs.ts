import type { Db } from "../db.js";
import { bangkokToday } from "../lib/dates.js";
import { renderDueToday, renderOverdue } from "../notifications/messages.js";
import type { Notifier } from "../notifications/service.js";
import { dueItems, roundKey } from "../notifications/summaries.js";
import type { DeliveryOutcome } from "../notifications/types.js";
import type { Job } from "./scheduler.js";

/**
 * DES-013 rounds: ONE summary message per round, never one per contract, and nothing at all when no
 * contract qualifies. Re-running a round on the same day (a restart) cannot send twice: the
 * notification key is the Bangkok date and NotificationLog.dedupeKey is unique.
 */
export interface RoundResult {
  contracts: number;
  outcome: Record<string, DeliveryOutcome>;
}

export async function runDueTodayRound(prisma: Db, notifier: Notifier, now: Date = new Date()): Promise<RoundResult> {
  const today = bangkokToday(now);
  const items = await dueItems(prisma, today, "DUE_TODAY");
  if (items.length === 0) return { contracts: 0, outcome: {} };
  const outcome = await notifier.deliver({
    type: "DUE_TODAY",
    key: roundKey(today),
    scheduledDate: today,
    message: renderDueToday(items, today),
  });
  return { contracts: items.length, outcome };
}

export async function runOverdueRound(prisma: Db, notifier: Notifier, now: Date = new Date()): Promise<RoundResult> {
  const today = bangkokToday(now);
  const items = await dueItems(prisma, today, "OVERDUE");
  if (items.length === 0) return { contracts: 0, outcome: {} };
  const outcome = await notifier.deliver({
    type: "OVERDUE",
    key: roundKey(today),
    scheduledDate: today,
    message: renderOverdue(items, today),
  });
  return { contracts: items.length, outcome };
}

const summary = (r: RoundResult) => `${r.contracts} contract(s) ${JSON.stringify(r.outcome)}`;

/** 09:00 DUE_TODAY and 17:00 OVERDUE (Asia/Bangkok), on the scheduler of T-304. */
export function notificationJobs(prisma: Db, notifier: Notifier): Job[] {
  return [
    {
      name: "notify-due-today",
      at: "09:00",
      run: async ({ now }) => console.log(`notify-due-today: ${summary(await runDueTodayRound(prisma, notifier, now))}`),
    },
    {
      name: "notify-overdue",
      at: "17:00",
      run: async ({ now }) => console.log(`notify-overdue: ${summary(await runOverdueRound(prisma, notifier, now))}`),
    },
  ];
}
