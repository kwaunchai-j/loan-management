import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { formatDateOnly } from "../lib/dates.js";
import { simulateContract } from "../lib/late-fee.js";
import { periodView, type Period } from "./period.js";

/**
 * The three contract-based reports (DES-015 §2–4). Which contracts a period picks up: those paid out
 * (or imported) whose DUE DATE falls in the period — one consistent anchor for "late" and "how many
 * loans". The outstanding balance is a point in time (as of a day), not a period.
 *
 * "Late" (DES-012): paid after the due date, or still unpaid after it. One count per contract, so a
 * contract that is overdue and unpaid counts exactly like one that was paid late.
 */
const MS_PER_DAY = 86_400_000;
const ZERO = new Prisma.Decimal(0);

const contractInclude = {
  borrower: { select: { id: true, fullName: true } },
  payments: { select: { id: true, amount: true, paidOn: true, createdAt: true } },
} satisfies Prisma.ContractInclude;

type Row = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;

const inPeriod = (p: Period): Prisma.ContractWhereInput => ({
  status: { in: ["ACTIVE", "CLOSED"] },
  dueDate: { gte: p.from, lte: p.to },
});

export const isOverdue = (c: Pick<Row, "status" | "dueDate">, today: Date) =>
  c.status === "ACTIVE" && c.dueDate.getTime() < today.getTime();

export const isLate = (c: Pick<Row, "status" | "dueDate" | "closedOn">, today: Date) =>
  isOverdue(c, today) || (c.closedOn !== null && c.closedOn.getTime() > c.dueDate.getTime());

/** What is owed on `asOf`, replayed from the contract's own history up to that day. */
function owedAsOf(c: Row & { interestAmount: Prisma.Decimal | null; lateFeeRatePctPerDay: Prisma.Decimal | null }, asOf: Date) {
  if (c.interestAmount === null || c.lateFeeRatePctPerDay === null) return null;
  const sim = simulateContract({
    principal: c.principal,
    interestAmount: c.interestAmount,
    dueDate: c.dueDate,
    disbursedOn: c.disbursedOn,
    lateFeeRatePctPerDay: c.lateFeeRatePctPerDay,
    payments: c.payments.filter((p) => p.paidOn.getTime() <= asOf.getTime()),
    today: asOf,
  });
  return sim.ok ? sim : null;
}

const pageOf = <T>(items: T[], limit: number, offset: number) => items.slice(offset, offset + limit);

/** §2 — borrowers ranked by how many of their contracts were late. Only borrowers with at least one. */
export async function latePayers(prisma: Db, period: Period, today: Date, page: { limit: number; offset: number }) {
  const contracts = await prisma.contract.findMany({
    where: inPeriod(period),
    include: contractInclude,
    orderBy: [{ dueDate: "asc" }, { contractNo: "asc" }],
  });
  const byBorrower = new Map<string, { borrowerId: string; fullName: string; lateContracts: Array<Record<string, unknown>> }>();
  for (const c of contracts) {
    if (!isLate(c, today)) continue;
    const end = c.closedOn ?? today;
    const entry = byBorrower.get(c.borrowerId) ?? { borrowerId: c.borrowerId, fullName: c.borrower.fullName, lateContracts: [] };
    entry.lateContracts.push({
      contractNo: c.contractNo,
      dueDate: formatDateOnly(c.dueDate),
      closedOn: c.closedOn ? formatDateOnly(c.closedOn) : null,
      stillUnpaid: c.status === "ACTIVE",
      daysLate: Math.round((end.getTime() - c.dueDate.getTime()) / MS_PER_DAY),
    });
    byBorrower.set(c.borrowerId, entry);
  }
  const ranked = [...byBorrower.values()]
    .map((b) => ({ ...b, lateCount: b.lateContracts.length }))
    .sort((a, b) => b.lateCount - a.lateCount || a.fullName.localeCompare(b.fullName, "th") || (a.borrowerId < b.borrowerId ? -1 : 1))
    .map((b, i) => ({ rank: i + 1, ...b }));
  return { period: periodView(period), total: ranked.length, items: pageOf(ranked, page.limit, page.offset) };
}

/** §3 — what is owed on contracts that are open on `asOf`, and how many are open. */
export async function outstanding(prisma: Db, asOf: Date, today: Date) {
  const nextBangkokMidnightUtc = new Date(asOf.getTime() + MS_PER_DAY - 7 * 3_600_000);
  const contracts = await prisma.contract.findMany({
    where: {
      status: { in: ["ACTIVE", "CLOSED"] },
      OR: [
        { disbursedOn: { lte: asOf } },
        // imported contracts have no payout date: they exist from the day they were imported
        { disbursedOn: null, createdAt: { lt: nextBangkokMidnightUtc } },
      ],
    },
    include: contractInclude,
  });
  let open = 0;
  let inconsistent = 0;
  let principal = ZERO;
  let interest = ZERO;
  let lateFee = ZERO;
  for (const c of contracts) {
    const sim = owedAsOf(c, asOf);
    if (!sim) {
      inconsistent++;
      continue;
    }
    if (sim.status !== "ACTIVE") continue;
    open++;
    principal = principal.plus(sim.outstandingPrincipal);
    interest = interest.plus(sim.outstandingInterest);
    lateFee = lateFee.plus(sim.accruedLateFee);
  }
  return {
    asOf: formatDateOnly(asOf),
    isToday: asOf.getTime() === today.getTime(),
    openContracts: open,
    totalOutstanding: principal.plus(interest).plus(lateFee).toString(),
    principal: principal.toString(),
    interest: interest.toString(),
    lateFee: lateFee.toString(),
    // contracts whose stored history breaks a rule are left out and counted here, never hidden
    inconsistentContracts: inconsistent,
  };
}

/** §4 — per borrower: how many loans, how many were late, how reliably they pay, what is owed now. */
export async function borrowerSummary(prisma: Db, period: Period, today: Date, page: { limit: number; offset: number }) {
  const contracts = await prisma.contract.findMany({ where: inPeriod(period), include: contractInclude });
  const by = new Map<string, { borrowerId: string; fullName: string; loanCount: number; lateCount: number; paidOnTimeCount: number; notYetDueCount: number; outstanding: Prisma.Decimal }>();
  for (const c of contracts) {
    const b = by.get(c.borrowerId) ?? {
      borrowerId: c.borrowerId,
      fullName: c.borrower.fullName,
      loanCount: 0,
      lateCount: 0,
      paidOnTimeCount: 0,
      notYetDueCount: 0,
      outstanding: ZERO,
    };
    b.loanCount++;
    if (isLate(c, today)) b.lateCount++;
    else if (c.status === "CLOSED") b.paidOnTimeCount++;
    else b.notYetDueCount++; // open and not past its due date yet: neither on time nor late so far
    if (c.status === "ACTIVE") {
      const sim = owedAsOf(c, today);
      b.outstanding = b.outstanding.plus(sim ? sim.outstandingPrincipal.plus(sim.outstandingInterest).plus(sim.accruedLateFee) : c.outstandingPrincipal.plus(c.outstandingInterest).plus(c.accruedLateFee));
    }
    by.set(c.borrowerId, b);
  }
  const rows = [...by.values()]
    .map((b) => {
      const judged = b.paidOnTimeCount + b.lateCount;
      return {
        borrowerId: b.borrowerId,
        fullName: b.fullName,
        loanCount: b.loanCount,
        lateCount: b.lateCount,
        paidOnTimeCount: b.paidOnTimeCount,
        notYetDueCount: b.notYetDueCount,
        // share of the contracts that have a verdict (paid on time vs late); null when none has yet
        onTimeRatePct: judged === 0 ? null : (Math.round((b.paidOnTimeCount * 1000) / judged) / 10).toFixed(1),
        outstanding: b.outstanding.toString(),
      };
    })
    .sort((a, b) => b.lateCount - a.lateCount || b.loanCount - a.loanCount || a.fullName.localeCompare(b.fullName, "th") || (a.borrowerId < b.borrowerId ? -1 : 1));
  return { period: periodView(period), total: rows.length, items: pageOf(rows, page.limit, page.offset) };
}
