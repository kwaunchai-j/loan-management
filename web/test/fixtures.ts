import {
  adminContractDetailSchema,
  adminContractListSchema,
  portalContractDetailSchema,
  portalContractListSchema,
  requestListSchema,
  requestSchema,
  type AdminContractDetail,
} from "@/lib/schemas";
import { valid } from "./mocks";

/** 30 Oct 2026, 12:00 in Thailand. The pages read "today" from the clock, so tests pin it. */
export const NOW = new Date("2026-10-30T05:00:00.000Z");
export const TODAY = "2026-10-30";

const borrower = { id: "b1", fullName: "สมชาย ใจดี" };

export const request = (over: Record<string, unknown> = {}) =>
  valid(requestSchema, {
    id: "r1",
    borrower,
    amount: "5000.00",
    requestedDueDate: "2026-12-01",
    status: "PENDING",
    createdById: "u2",
    decidedById: null,
    decidedAt: null,
    rejectReason: null,
    createdAt: "2026-10-29T03:00:00.000Z",
    contract: null,
    ...over,
  });
export const requestList = (items: unknown[], total = items.length) => valid(requestListSchema, { total, items });

const money = {
  id: "c1",
  contractNo: "LN-0001",
  status: "ACTIVE",
  principal: "1000.00",
  dueDate: "2026-11-30",
  disbursedOn: "2026-10-20",
  interestRatePctPerMonth: "5.0000",
  lateFeeRatePctPerDay: "1.5000",
  interestAmount: "20.00",
  outstandingPrincipal: "1000.00",
  outstandingInterest: "20.00",
  accruedLateFee: "0.00",
  totalDue: "1020.00",
  closedOn: null,
};
export const contractMoney = (over: Record<string, unknown> = {}) => ({ ...money, ...over });

export const payment = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  contractId: "c1",
  amount: "300.00",
  paidOn: "2026-10-25",
  allocatedLateFee: "50.00",
  allocatedInterest: "200.00",
  allocatedPrincipal: "50.00",
  note: null,
  recordedById: "u1",
  createdAt: "2026-10-25T03:00:00.000Z",
  ...over,
});

export const disbursement = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  contractId: "c1",
  amount: "1000.00",
  paidOn: "2026-10-20",
  note: null,
  slipFileKey: "abc123def456.jpg",
  recordedById: "u1",
  createdAt: "2026-10-20T03:00:00.000Z",
  ...over,
});

export function adminDetail(over: {
  contract?: Record<string, unknown>;
  disbursement?: unknown;
  payments?: unknown[];
  accruals?: unknown[];
} = {}): AdminContractDetail {
  return valid(adminContractDetailSchema, {
    contract: { ...money, borrower, isImported: false, isOverdue: false, daysOverdue: 0, isLate: false, inconsistent: false, ...over.contract },
    disbursement: over.disbursement === undefined ? disbursement() : over.disbursement,
    payments: over.payments ?? [],
    lateFeeAccruals: over.accruals ?? [],
  });
}

/** A contract waiting for its payout: nothing owed, no interest yet. */
export const awaitingDetail = () =>
  adminDetail({
    contract: {
      status: "AWAITING_DISBURSEMENT",
      disbursedOn: null,
      interestRatePctPerMonth: null,
      lateFeeRatePctPerDay: null,
      interestAmount: null,
      outstandingInterest: "0.00",
      totalDue: null,
    },
    disbursement: null,
  });

export const adminList = (items: unknown[], total = items.length) => valid(adminContractListSchema, { total, items });
export const adminListItem = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  contractNo: "LN-0001",
  status: "ACTIVE",
  borrower,
  principal: "1000.00",
  dueDate: "2026-11-30",
  disbursedOn: "2026-10-20",
  totalDue: "1020.00",
  isOverdue: false,
  daysOverdue: 0,
  isLate: false,
  isImported: false,
  ...over,
});

export const portalItem = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  contractNo: "LN-0001",
  status: "ACTIVE",
  principal: "1000.00",
  dueDate: "2026-11-30",
  disbursedOn: "2026-10-20",
  interestAmount: "20.00",
  outstandingPrincipal: "1000.00",
  outstandingInterest: "20.00",
  accruedLateFee: "0.00",
  totalDue: "1020.00",
  isOverdue: false,
  daysOverdue: 0,
  isLate: false,
  closedOn: null,
  ...over,
});
/** What the API sends for a contract still waiting for the payout: four fields and nothing about money owed. */
export const portalAwaiting = (over: Record<string, unknown> = {}) => ({
  id: "c2",
  contractNo: "LN-0002",
  status: "AWAITING_DISBURSEMENT",
  principal: "5000.00",
  dueDate: "2026-12-15",
  ...over,
});
export const portalList = (items: unknown[]) => valid(portalContractListSchema, { items });
export const portalDetail = (over: { contract?: unknown; disbursement?: unknown; payments?: unknown[] } = {}) =>
  valid(portalContractDetailSchema, {
    contract: over.contract ?? portalItem(),
    disbursement: over.disbursement === undefined ? { amount: "1000.00", paidOn: "2026-10-20" } : over.disbursement,
    payments: over.payments ?? [],
  });

// ---- payment slips and calendar (CR-1) ----------------------------------------------------------
import { adminSubmissionListSchema, calendarSchema, mySubmissionListSchema } from "@/lib/schemas";

export const mySubmission = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  contract: { id: "c1", contractNo: "LN-0001" },
  amount: "300.00",
  paidOn: "2026-10-29",
  note: null,
  status: "PENDING",
  rejectReason: null,
  decidedAt: null,
  createdAt: "2026-10-29T08:00:00.000Z",
  ...over,
});
export const mySubmissions = (...items: unknown[]) => valid(mySubmissionListSchema, { items });

export const adminSubmission = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  contract: { id: "c1", contractNo: "LN-0001" },
  borrower: { id: "b1", fullName: "สมชาย ใจดี" },
  amount: "300.00",
  paidOn: "2026-10-29",
  note: null,
  status: "PENDING",
  rejectReason: null,
  slipFileKey: "abc123def456.jpg",
  decidedAt: null,
  paymentId: null,
  createdAt: "2026-10-29T08:00:00.000Z",
  ...over,
});
export const adminSubmissions = (items: unknown[], total = items.length) => valid(adminSubmissionListSchema, { total, items });

export const dueItem = (over: Record<string, unknown> = {}) => ({
  contractId: "c1",
  contractNo: "LN-0001",
  borrower: { id: "b1", fullName: "สมชาย ใจดี" },
  status: "ACTIVE",
  totalDue: "1100.00",
  isOverdue: false,
  daysOverdue: 0,
  isImported: false,
  closedOn: null,
  ...over,
});
export const paidItem = (over: Record<string, unknown> = {}) => ({
  paymentId: "p1",
  contractId: "c1",
  contractNo: "LN-0001",
  borrower: { id: "b1", fullName: "สมชาย ใจดี" },
  amount: "300.00",
  ...over,
});
export const calendarDay = (date: string, o: { due?: unknown[]; paid?: unknown[]; openTotal?: string; paidTotal?: string } = {}) => {
  const due = (o.due ?? []) as Array<{ status: string }>;
  const paid = (o.paid ?? []) as unknown[];
  return {
    date,
    due: { count: due.length, openCount: due.filter((i) => i.status === "ACTIVE").length, openTotal: o.openTotal ?? "0", items: due },
    paid: { count: paid.length, total: o.paidTotal ?? "0", items: paid },
  };
};
export const calendarOf = (month: string, days: unknown[], extra: Record<string, unknown> = {}) =>
  valid(calendarSchema, { month, today: "2026-10-30", truncated: false, days, ...extra });
