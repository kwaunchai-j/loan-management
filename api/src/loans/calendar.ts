import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { formatDateOnly } from "../lib/dates.js";
import { computeState, detailInclude } from "./queries.js";

/**
 * The admin calendar: for each day of a month, what falls due on it and what was paid on it.
 *  - due:  contracts whose DUE DATE is that day (open ones show what is still owed today; settled ones
 *          are listed too, as "ชำระครบ") — so a payment that is due always sits on its due date;
 *  - paid: the payments recorded with that day as `paidOn`.
 * Every amount is the ledger's own (computeState / Payment rows); the page adds nothing up.
 */
const MAX_CONTRACTS = 2000;
const MAX_PAYMENTS = 5000;
const ZERO = new Prisma.Decimal(0);

export interface MonthRef {
  year: number;
  month: number; // 1..12
}

export function monthBounds({ year, month }: MonthRef) {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0)); // day 0 of the next month = the last day of this one
  return { from, to };
}

interface DayBucket {
  date: string;
  due: { count: number; openCount: number; openTotal: Prisma.Decimal; items: Array<Record<string, unknown>> };
  paid: { count: number; total: Prisma.Decimal; items: Array<Record<string, unknown>> };
}

export async function monthCalendar(prisma: Db, ref: MonthRef, today: Date) {
  const { from, to } = monthBounds(ref);
  const [contracts, payments] = await Promise.all([
    prisma.contract.findMany({
      where: { status: { in: ["ACTIVE", "CLOSED"] }, dueDate: { gte: from, lte: to } },
      include: detailInclude,
      orderBy: [{ dueDate: "asc" }, { contractNo: "asc" }],
      take: MAX_CONTRACTS,
    }),
    prisma.payment.findMany({
      where: { paidOn: { gte: from, lte: to } },
      select: {
        id: true,
        amount: true,
        paidOn: true,
        contractId: true,
        contract: { select: { contractNo: true, borrower: { select: { id: true, fullName: true } } } },
      },
      orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
      take: MAX_PAYMENTS,
    }),
  ]);

  const days = new Map<string, DayBucket>();
  const bucket = (d: Date): DayBucket => {
    const key = formatDateOnly(d);
    let b = days.get(key);
    if (!b) {
      b = { date: key, due: { count: 0, openCount: 0, openTotal: ZERO, items: [] }, paid: { count: 0, total: ZERO, items: [] } };
      days.set(key, b);
    }
    return b;
  };

  for (const c of contracts) {
    const { state, isOverdue, daysOverdue } = computeState(c, today);
    const open = c.status === "ACTIVE";
    const owed = open ? state.outstandingPrincipal.plus(state.outstandingInterest).plus(state.accruedLateFee) : ZERO;
    const b = bucket(c.dueDate);
    b.due.count++;
    if (open) {
      b.due.openCount++;
      b.due.openTotal = b.due.openTotal.plus(owed);
    }
    b.due.items.push({
      contractId: c.id,
      contractNo: c.contractNo,
      borrower: c.borrower,
      status: c.status,
      totalDue: owed.toString(),
      isOverdue,
      daysOverdue,
      isImported: c.isImported,
      closedOn: c.closedOn ? formatDateOnly(c.closedOn) : null,
    });
  }

  for (const p of payments) {
    const b = bucket(p.paidOn);
    b.paid.count++;
    b.paid.total = b.paid.total.plus(p.amount);
    b.paid.items.push({
      paymentId: p.id,
      contractId: p.contractId,
      contractNo: p.contract.contractNo,
      borrower: p.contract.borrower,
      amount: p.amount.toString(),
    });
  }

  return {
    month: `${ref.year}-${String(ref.month).padStart(2, "0")}`,
    today: formatDateOnly(today),
    truncated: contracts.length >= MAX_CONTRACTS || payments.length >= MAX_PAYMENTS,
    days: [...days.values()]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({
        date: d.date,
        due: { count: d.due.count, openCount: d.due.openCount, openTotal: d.due.openTotal.toString(), items: d.due.items },
        paid: { count: d.paid.count, total: d.paid.total.toString(), items: d.paid.items },
      })),
  };
}
