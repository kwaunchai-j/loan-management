import { Prisma } from "@prisma/client";
import { simulateContract } from "../lib/late-fee.js";
import { formatDateOnly } from "../lib/dates.js";
import { normalizeName, type ParsedRow } from "./validate.js";

/**
 * Matching rows to borrowers and working out the back-dated late fee (DES-014 §3–§4).
 *
 * A borrower is matched by FULL NAME, exactly (after tidying spaces). One match → that borrower; no
 * match → a new borrower is created, once per name (no login); several people with that name → the
 * admin must choose one. The same name on many rows is normal (one borrower, many loans).
 * An overdue imported contract gets late fees from the day after its due date up to today; they are
 * computed here with the same pure function the ledger uses, so the preview shows what will be saved.
 */
export interface Candidate {
  borrowerId: string;
  fullName: string;
  phone: string | null;
  hasAccount: boolean;
  createdAt: Date;
}

export type Match =
  | { status: "EXISTING"; borrowerId: string }
  | { status: "NEW" }
  | { status: "AMBIGUOUS"; candidates: Candidate[] };

export interface AnalyzedRow extends ParsedRow {
  match: Match;
  /** Late days between the due date and today (0 if not yet due). */
  lateDays: number;
  /** Fee that will be back-dated, or null when it cannot be computed yet (rates not set). */
  lateFee: Prisma.Decimal | null;
}

export type BorrowerIndex = Map<string, Candidate[]>;

type BorrowerDb = Pick<Prisma.TransactionClient, "borrower">;

export async function loadBorrowerIndex(db: BorrowerDb): Promise<BorrowerIndex> {
  const all = await db.borrower.findMany({ select: { id: true, fullName: true, phone: true, userId: true, createdAt: true } });
  const index: BorrowerIndex = new Map();
  for (const b of all) {
    const key = normalizeName(b.fullName);
    const list = index.get(key) ?? [];
    list.push({ borrowerId: b.id, fullName: b.fullName, phone: b.phone, hasAccount: b.userId !== null, createdAt: b.createdAt });
    index.set(key, list);
  }
  for (const list of index.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.borrowerId < b.borrowerId ? -1 : 1));
  return index;
}

export function matchName(index: BorrowerIndex, name: string): Match {
  const found = index.get(name) ?? [];
  if (found.length === 0) return { status: "NEW" };
  if (found.length === 1) return { status: "EXISTING", borrowerId: found[0]!.borrowerId };
  return { status: "AMBIGUOUS", candidates: found };
}

/** Maximum rows of back-dated late fees one import may create (a protection for the database). */
export const MAX_BACKFILL_ACCRUALS = 250_000;

export function analyzeRows(
  rows: ParsedRow[],
  index: BorrowerIndex,
  today: Date,
  lateFeeRatePctPerDay: Prisma.Decimal | null,
): AnalyzedRow[] {
  return rows.map((row) => {
    const errors = [...row.errors];
    let lateDays = 0;
    let lateFee: Prisma.Decimal | null = null;
    const pastDue = row.dueDate !== null && row.dueDate.getTime() < today.getTime();

    if (errors.length === 0 && row.amount && row.interest && row.dueDate) {
      if (!pastDue) {
        lateFee = new Prisma.Decimal(0);
      } else if (lateFeeRatePctPerDay) {
        const sim = simulateContract({
          principal: row.amount,
          interestAmount: row.interest,
          dueDate: row.dueDate,
          disbursedOn: null,
          lateFeeRatePctPerDay,
          payments: [],
          today,
        });
        if (sim.ok) {
          lateDays = sim.accruals.length;
          lateFee = sim.accruedLateFee;
        } else {
          errors.push("ค่าปรับย้อนหลังที่คำนวณได้เกินขีดจำกัดของระบบ (วันครบกำหนดเก่ามากหรืออัตราสูงมาก)");
        }
      } else {
        lateDays = Math.round((today.getTime() - row.dueDate.getTime()) / 86_400_000);
      }
    }
    return {
      ...row,
      errors,
      match: row.name === "" ? { status: "NEW" } : matchName(index, row.name),
      lateDays,
      lateFee,
    };
  });
}

const money = (v: Prisma.Decimal | null) => (v === null ? null : v.toString());

export function rowView(r: AnalyzedRow, today: Date) {
  return {
    rowNumber: r.rowNumber,
    name: r.name,
    amount: money(r.amount),
    interest: money(r.interest),
    dueDate: r.dueDate ? formatDateOnly(r.dueDate) : null,
    valid: r.errors.length === 0,
    errors: r.errors,
    match:
      r.match.status === "EXISTING"
        ? { status: "EXISTING" as const, borrowerId: r.match.borrowerId }
        : { status: r.match.status },
    daysOverdue: r.dueDate && r.dueDate.getTime() < today.getTime() ? Math.round((today.getTime() - r.dueDate.getTime()) / 86_400_000) : 0,
    lateFee: money(r.lateFee),
  };
}

export function summarize(rows: AnalyzedRow[], rateKnown: boolean) {
  const valid = rows.filter((r) => r.errors.length === 0);
  let principal = new Prisma.Decimal(0);
  let interest = new Prisma.Decimal(0);
  let lateFee = new Prisma.Decimal(0);
  let lateDays = 0;
  for (const r of valid) {
    principal = principal.plus(r.amount!);
    interest = interest.plus(r.interest!);
    lateFee = lateFee.plus(r.lateFee ?? 0);
    lateDays += r.lateDays;
  }
  const names = new Set(valid.map((r) => r.name));
  const status = (s: Match["status"]) => new Set(valid.filter((r) => r.match.status === s).map((r) => r.name)).size;
  return {
    rows: rows.length,
    validRows: valid.length,
    invalidRows: rows.length - valid.length,
    borrowers: names.size,
    newBorrowers: status("NEW"),
    existingBorrowers: status("EXISTING"),
    ambiguousBorrowers: status("AMBIGUOUS"),
    principal: principal.toString(),
    interest: interest.toString(),
    lateFee: rateKnown ? lateFee.toString() : null,
    lateDays,
  };
}
