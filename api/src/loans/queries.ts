import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { formatDateOnly } from "../lib/dates.js";
import { simulateContract } from "../lib/late-fee.js";
import { contractMoneyView, disbursementRowView, paymentView } from "./views.js";

/**
 * Admin read side for contracts (T-306). What is owed is computed as of TODAY from the contract's
 * own history, not read from the stored columns, so it is right even if the nightly job missed a
 * day (DES-010/012: "คำนวณ ไม่เก็บ"). "Overdue" and "late" are computed too and never stored.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const detailInclude = {
  borrower: { select: { id: true, fullName: true } },
  disbursement: true,
  payments: { orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }] },
  lateFeeAccruals: { orderBy: { accrualDate: "asc" } },
} satisfies Prisma.ContractInclude;

export type ContractWith = Prisma.ContractGetPayload<{ include: typeof detailInclude }>;

export function computeState(c: ContractWith, today: Date) {
  let state = {
    outstandingPrincipal: c.outstandingPrincipal,
    outstandingInterest: c.outstandingInterest,
    accruedLateFee: c.accruedLateFee,
    closedOn: c.closedOn,
  };
  let accruals = c.lateFeeAccruals.map((a) => ({
    date: formatDateOnly(a.accrualDate),
    baseAmount: a.baseAmount.toString(),
    ratePctPerDay: a.ratePctPerDay.toString(),
    amount: a.amount.toString(),
  }));
  let inconsistent = false;

  if (c.status === "ACTIVE" && c.interestAmount !== null && c.lateFeeRatePctPerDay !== null) {
    const sim = simulateContract({
      principal: c.principal,
      interestAmount: c.interestAmount,
      dueDate: c.dueDate,
      disbursedOn: c.disbursedOn,
      lateFeeRatePctPerDay: c.lateFeeRatePctPerDay,
      payments: c.payments.map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paidOn, createdAt: p.createdAt })),
      today,
    });
    if (sim.ok) {
      state = {
        outstandingPrincipal: sim.outstandingPrincipal,
        outstandingInterest: sim.outstandingInterest,
        accruedLateFee: sim.accruedLateFee,
        closedOn: sim.closedOn,
      };
      accruals = sim.accruals.map((a) => ({
        date: formatDateOnly(a.accrualDate),
        baseAmount: a.baseAmount.toString(),
        ratePctPerDay: a.ratePctPerDay.toString(),
        amount: a.amount.toString(),
      }));
    } else {
      inconsistent = true; // stored history breaks a rule: show the stored numbers and say so
    }
  }

  const isOverdue = c.status === "ACTIVE" && c.dueDate.getTime() < today.getTime();
  const daysOverdue = isOverdue ? Math.round((today.getTime() - c.dueDate.getTime()) / MS_PER_DAY) : 0;
  // DES-012: late = paid after the due date, or still unpaid after it
  const isLate = isOverdue || (c.closedOn !== null && c.closedOn.getTime() > c.dueDate.getTime());
  return { state, accruals, inconsistent, isOverdue, daysOverdue, isLate };
}

function contractView(c: ContractWith, today: Date) {
  const { state, accruals, inconsistent, isOverdue, daysOverdue, isLate } = computeState(c, today);
  return {
    contract: {
      ...contractMoneyView({ ...c, ...state }),
      borrower: c.borrower,
      isImported: c.isImported,
      isOverdue,
      daysOverdue,
      isLate,
      inconsistent,
    },
    accruals,
  };
}

export async function getContractDetail(prisma: Db, id: string, today: Date) {
  const c = await prisma.contract.findUnique({ where: { id }, include: detailInclude });
  if (!c) throw new DomainError(404, "NOT_FOUND", "ไม่พบสัญญา");
  const { contract, accruals } = contractView(c, today);
  return {
    contract,
    disbursement: c.disbursement ? disbursementRowView(c.disbursement) : null,
    payments: c.payments.map(paymentView),
    lateFeeAccruals: accruals,
  };
}

export interface ContractListFilter {
  status?: "AWAITING_DISBURSEMENT" | "ACTIVE" | "CLOSED" | "CANCELLED";
  borrowerId?: string;
  overdue?: boolean;
  q?: string;
  sort: "createdAt" | "dueDate";
  limit: number;
  offset: number;
}

export async function listContracts(prisma: Db, f: ContractListFilter, today: Date) {
  const where: Prisma.ContractWhereInput = {
    ...(f.status ? { status: f.status } : {}),
    ...(f.borrowerId ? { borrowerId: f.borrowerId } : {}),
    // overdue = ACTIVE and past the due date (computed, never stored)
    ...(f.overdue ? { status: "ACTIVE", dueDate: { lt: today } } : {}),
    ...(f.q
      ? {
          OR: [
            { contractNo: { contains: f.q, mode: "insensitive" } },
            { borrower: { fullName: { contains: f.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.ContractOrderByWithRelationInput[] =
    f.sort === "dueDate" ? [{ dueDate: "asc" }, { contractNo: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }];
  const [total, rows] = await Promise.all([
    prisma.contract.count({ where }),
    prisma.contract.findMany({ where, include: detailInclude, orderBy, take: f.limit, skip: f.offset }),
  ]);
  return {
    total,
    items: rows.map((c) => {
      const { contract } = contractView(c, today);
      return {
        id: contract.id,
        contractNo: contract.contractNo,
        status: contract.status,
        borrower: contract.borrower,
        principal: contract.principal,
        dueDate: contract.dueDate,
        disbursedOn: contract.disbursedOn,
        totalDue: contract.status === "ACTIVE" ? contract.totalDue : contract.status === "CLOSED" ? "0" : null,
        isOverdue: contract.isOverdue,
        daysOverdue: contract.daysOverdue,
        isLate: contract.isLate,
        isImported: contract.isImported,
      };
    }),
  };
}
