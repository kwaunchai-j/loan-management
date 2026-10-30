import type { Db } from "../db.js";
import { formatDateOnly } from "../lib/dates.js";
import { simulateContract } from "../lib/late-fee.js";
import type { DueItem } from "./messages.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The contracts a round of notifications is about (DES-013), computed for `today` (Asia/Bangkok):
 *  - DUE_TODAY: ACTIVE contracts whose due date is today and that still owe something;
 *  - OVERDUE:   ACTIVE contracts due today or earlier that still owe something ("from the due date
 *               until paid in full", so today's due ones are included in the 17:00 round).
 * "Owes" is read from a fresh replay of the contract, so today's late fee is included and the list
 * is right even if the nightly job has not run.
 */
export async function dueItems(prisma: Db, today: Date, kind: "DUE_TODAY" | "OVERDUE"): Promise<DueItem[]> {
  const contracts = await prisma.contract.findMany({
    where: { status: "ACTIVE", dueDate: kind === "DUE_TODAY" ? today : { lte: today } },
    include: { borrower: { select: { fullName: true } }, payments: true },
    orderBy: [{ dueDate: "asc" }, { contractNo: "asc" }],
  });

  const items: DueItem[] = [];
  for (const c of contracts) {
    let totalDue = c.outstandingPrincipal.plus(c.outstandingInterest).plus(c.accruedLateFee);
    if (c.interestAmount !== null && c.lateFeeRatePctPerDay !== null) {
      const sim = simulateContract({
        principal: c.principal,
        interestAmount: c.interestAmount,
        dueDate: c.dueDate,
        disbursedOn: c.disbursedOn,
        lateFeeRatePctPerDay: c.lateFeeRatePctPerDay,
        payments: c.payments.map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paidOn, createdAt: p.createdAt })),
        today,
      });
      // if the stored history breaks a rule, fall back to the stored balances rather than stay silent
      if (sim.ok) totalDue = sim.outstandingPrincipal.plus(sim.outstandingInterest).plus(sim.accruedLateFee);
    }
    if (!totalDue.gt(0)) continue;
    items.push({
      contractNo: c.contractNo,
      borrowerName: c.borrower.fullName,
      dueDate: c.dueDate,
      daysOverdue: Math.max(0, Math.round((today.getTime() - c.dueDate.getTime()) / MS_PER_DAY)),
      totalDue,
    });
  }
  return items;
}

export const roundKey = (today: Date) => formatDateOnly(today);
