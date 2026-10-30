import type { Prisma } from "@prisma/client";
import { formatDateOnly } from "../lib/dates.js";

type Money = Prisma.Decimal;
const m = (v: Money | null) => (v === null ? null : v.toString());
const day = (d: Date | null) => (d === null ? null : formatDateOnly(d));

interface ContractRow {
  id: string;
  contractNo: string;
  status: string;
  principal: Money;
  dueDate: Date;
  disbursedOn: Date | null;
  interestRatePctPerMonth: Money | null;
  lateFeeRatePctPerDay: Money | null;
  interestAmount: Money | null;
  outstandingPrincipal: Money;
  outstandingInterest: Money;
  accruedLateFee: Money;
  closedOn: Date | null;
}

/** Money fields as strings (Decimal stays exact). totalDue = principal + interest + late fee (DES-010). */
export function contractMoneyView(c: ContractRow) {
  return {
    id: c.id,
    contractNo: c.contractNo,
    status: c.status,
    principal: m(c.principal),
    dueDate: formatDateOnly(c.dueDate),
    disbursedOn: day(c.disbursedOn),
    interestRatePctPerMonth: m(c.interestRatePctPerMonth),
    lateFeeRatePctPerDay: m(c.lateFeeRatePctPerDay),
    interestAmount: m(c.interestAmount),
    outstandingPrincipal: m(c.outstandingPrincipal),
    outstandingInterest: m(c.outstandingInterest),
    accruedLateFee: m(c.accruedLateFee),
    // No amount is shown before the money is paid out (DES-005), nor for a cancelled contract.
    totalDue:
      c.status === "ACTIVE" || c.status === "CLOSED"
        ? c.outstandingPrincipal.plus(c.outstandingInterest).plus(c.accruedLateFee).toString()
        : null,
    closedOn: day(c.closedOn),
  };
}

interface PaymentRow {
  id: string;
  contractId: string;
  amount: Money;
  paidOn: Date;
  allocatedLateFee: Money;
  allocatedInterest: Money;
  allocatedPrincipal: Money;
  note: string | null;
  recordedById: string;
  createdAt: Date;
}

export function paymentView(p: PaymentRow) {
  return {
    id: p.id,
    contractId: p.contractId,
    amount: p.amount.toString(),
    paidOn: formatDateOnly(p.paidOn),
    allocatedLateFee: p.allocatedLateFee.toString(),
    allocatedInterest: p.allocatedInterest.toString(),
    allocatedPrincipal: p.allocatedPrincipal.toString(),
    note: p.note,
    recordedById: p.recordedById,
    createdAt: p.createdAt,
  };
}

interface DisbursementRow {
  id: string;
  contractId: string;
  amount: Money;
  paidOn: Date;
  slipFileKey: string;
  note: string | null;
  recordedById: string;
  createdAt: Date;
}

export function disbursementRowView(d: DisbursementRow) {
  return {
    id: d.id,
    contractId: d.contractId,
    amount: d.amount.toString(),
    paidOn: formatDateOnly(d.paidOn),
    note: d.note,
    slipFileKey: d.slipFileKey,
    recordedById: d.recordedById,
    createdAt: d.createdAt,
  };
}
