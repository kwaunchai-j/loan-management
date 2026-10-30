import type { Db } from "../db.js";
import { bangkokToday } from "../lib/dates.js";
import { lockContract, reconcileContract } from "../loans/ledger.js";
import type { Job } from "./scheduler.js";

/**
 * Nightly late-fee run (DES-012), 00:05 Asia/Bangkok. For every ACTIVE contract past its due date
 * it replays the contract up to today and writes any missing LateFeeAccrual rows, which also makes
 * it a catch-up after downtime: any number of missed days are filled in one run. Idempotent — rows
 * that already match are not touched (and unique(contractId, accrualDate) backs that up).
 * One contract failing never stops the others.
 */
export interface LateFeeJobResult {
  checked: number;
  failed: Array<{ contractId: string; reason: string }>;
}

export async function runLateFeeJob(prisma: Db, now: Date = new Date()): Promise<LateFeeJobResult> {
  const today = bangkokToday(now);
  const candidates = await prisma.contract.findMany({
    where: { status: "ACTIVE", dueDate: { lt: today } },
    select: { id: true },
    orderBy: { dueDate: "asc" },
  });
  const failed: LateFeeJobResult["failed"] = [];
  for (const { id } of candidates) {
    try {
      await prisma.$transaction(async (tx) => {
        await lockContract(tx, id);
        await reconcileContract(tx, id, today);
      });
    } catch (err) {
      // Only a short reason: amounts and names stay out of logs.
      failed.push({ contractId: id, reason: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return { checked: candidates.length, failed };
}

export function lateFeeJob(prisma: Db): Job {
  return {
    name: "late-fee",
    at: "00:05",
    runOnStart: true,
    run: async ({ now }) => {
      const result = await runLateFeeJob(prisma, now);
      console.log(`late-fee: checked ${result.checked}, failed ${result.failed.length}`);
      for (const f of result.failed) console.error(`late-fee: contract ${f.contractId} failed: ${f.reason}`);
    },
  };
}
