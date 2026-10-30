import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";

/**
 * Loan requests and contracts before money moves (DES-004, DES-005).
 * PENDING --approve--> APPROVED (+ Contract AWAITING_DISBURSEMENT) | --reject--> REJECTED | --cancel--> CANCELLED
 * Every state change is one transaction with its AuditLog row.
 */

export const requestSelect = {
  id: true,
  borrowerId: true,
  amount: true,
  requestedDueDate: true,
  status: true,
  createdById: true,
  decidedById: true,
  decidedAt: true,
  rejectReason: true,
  createdAt: true,
  borrower: { select: { id: true, fullName: true } },
  contract: { select: { id: true, contractNo: true, status: true } },
} satisfies Prisma.LoanRequestSelect;

export type RequestRow = Prisma.LoanRequestGetPayload<{ select: typeof requestSelect }>;

export function requestView(r: RequestRow) {
  return {
    id: r.id,
    borrower: r.borrower,
    amount: r.amount.toString(),
    requestedDueDate: formatDateOnly(r.requestedDueDate),
    status: r.status,
    createdById: r.createdById,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt,
    rejectReason: r.rejectReason,
    createdAt: r.createdAt,
    contract: r.contract,
  };
}

const auditShape = (r: { amount: Prisma.Decimal; requestedDueDate: Date; status: string; borrowerId: string }) => ({
  borrowerId: r.borrowerId,
  amount: r.amount,
  requestedDueDate: formatDateOnly(r.requestedDueDate),
  status: r.status,
});

const notFound = () => new DomainError(404, "NOT_FOUND", "ไม่พบรายการ");
const wrongState = (what: string) =>
  new DomainError(409, "INVALID_STATE", `ทำรายการนี้ไม่ได้ เพราะ${what}ไม่อยู่ในสถานะที่ถูกต้อง`);

export async function createRequest(
  prisma: Db,
  input: { borrowerId: string; amount: string; requestedDueDate: Date; createdById: string },
  now: Date = new Date(),
) {
  // DES-004: the due date must be in the future (Asia/Bangkok), i.e. after today.
  if (input.requestedDueDate.getTime() <= bangkokToday(now).getTime()) {
    throw new DomainError(400, "DUE_DATE_NOT_FUTURE", "วันครบกำหนดต้องเป็นวันในอนาคต");
  }
  return prisma.$transaction(async (tx) => {
    const borrower = await tx.borrower.findUnique({ where: { id: input.borrowerId }, select: { id: true } });
    if (!borrower) throw new DomainError(404, "BORROWER_NOT_FOUND", "ไม่พบผู้ยืม");
    const row = await tx.loanRequest.create({
      data: {
        borrowerId: input.borrowerId,
        amount: input.amount,
        requestedDueDate: input.requestedDueDate,
        createdById: input.createdById,
      },
      select: requestSelect,
    });
    await writeAuditLog(tx, {
      actorId: input.createdById,
      action: "loanRequest.create",
      entityType: "LoanRequest",
      entityId: row.id,
      after: auditShape(row),
    });
    return row;
  });
}

/** The next `count` contract numbers for `year`: LN-<year>-<6 digits>, continuing after the highest used. */
export async function contractNumbers(tx: Prisma.TransactionClient, year: string, count: number): Promise<string[]> {
  const prefix = `LN-${year}-`;
  const last = await tx.contract.findFirst({
    where: { contractNo: { startsWith: prefix } },
    orderBy: { contractNo: "desc" },
    select: { contractNo: true },
  });
  const first = last ? Number(last.contractNo.slice(prefix.length)) + 1 : 1;
  return Array.from({ length: count }, (_, i) => `${prefix}${String(first + i).padStart(6, "0")}`);
}

async function nextContractNo(tx: Prisma.TransactionClient, year: string): Promise<string> {
  return (await contractNumbers(tx, year, 1))[0]!;
}

export async function approveRequest(prisma: Db, id: string, actorId: string, now: Date = new Date()) {
  const year = formatDateOnly(bangkokToday(now)).slice(0, 4);
  // contractNo is unique; if two approvals race for the same number, the loser retries with the next one.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const claimed = await tx.loanRequest.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "APPROVED", decidedById: actorId, decidedAt: now },
        });
        if (claimed.count === 0) {
          const exists = await tx.loanRequest.findUnique({ where: { id }, select: { id: true } });
          throw exists ? wrongState("คำขอ") : notFound();
        }
        const req = await tx.loanRequest.findUniqueOrThrow({ where: { id } });
        const contract = await tx.contract.create({
          data: {
            contractNo: await nextContractNo(tx, year),
            borrowerId: req.borrowerId,
            loanRequestId: req.id,
            principal: req.amount,
            dueDate: req.requestedDueDate,
            // Nothing is owed until the money is paid out; DES-016 restores this value on
            // deleting a Disbursement, so it starts equal to the principal.
            outstandingPrincipal: req.amount,
          },
        });
        await writeAuditLog(tx, {
          actorId,
          action: "loanRequest.approve",
          entityType: "LoanRequest",
          entityId: id,
          before: { status: "PENDING" },
          after: { status: "APPROVED" },
          extra: { contractId: contract.id, contractNo: contract.contractNo },
        });
        return tx.loanRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
      });
    } catch (err) {
      const retry =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        String(err.meta?.target ?? "").includes("contractNo");
      if (!retry || attempt === 4) throw err;
    }
  }
  throw new Error("unreachable");
}

export async function rejectRequest(prisma: Db, id: string, actorId: string, reason: string, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.loanRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "REJECTED", decidedById: actorId, decidedAt: now, rejectReason: reason },
    });
    if (claimed.count === 0) {
      const exists = await tx.loanRequest.findUnique({ where: { id }, select: { id: true } });
      throw exists ? wrongState("คำขอ") : notFound();
    }
    await writeAuditLog(tx, {
      actorId,
      action: "loanRequest.reject",
      entityType: "LoanRequest",
      entityId: id,
      before: { status: "PENDING" },
      after: { status: "REJECTED" },
      extra: { reason },
    });
    return tx.loanRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
  });
}

/**
 * Cancels a PENDING request. ADMIN may cancel any; a borrower may cancel only their own, which the
 * caller states with `ownedBy` (taken from the session). A request of another borrower is answered
 * as "not found" so its existence is not revealed.
 */
export async function cancelRequest(
  prisma: Db,
  id: string,
  actorId: string,
  options: { ownedBy?: string; now?: Date } = {},
) {
  const { ownedBy, now = new Date() } = options;
  const scope = ownedBy ? { borrowerId: ownedBy } : {};
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.loanRequest.updateMany({
      where: { id, status: "PENDING", ...scope },
      data: { status: "CANCELLED", decidedById: actorId, decidedAt: now },
    });
    if (claimed.count === 0) {
      const exists = await tx.loanRequest.findFirst({ where: { id, ...scope }, select: { id: true } });
      throw exists ? wrongState("คำขอ") : notFound();
    }
    await writeAuditLog(tx, {
      actorId,
      action: "loanRequest.cancel",
      entityType: "LoanRequest",
      entityId: id,
      before: { status: "PENDING" },
      after: { status: "CANCELLED" },
      extra: { cancelledBy: ownedBy ? "borrower" : "admin" },
    });
    return tx.loanRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
  });
}

/** DES-005: ADMIN may cancel a contract that is still AWAITING_DISBURSEMENT and has no Disbursement. */
export async function cancelContract(prisma: Db, id: string, actorId: string, reason: string | undefined) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.contract.updateMany({
      where: { id, status: "AWAITING_DISBURSEMENT", disbursement: { is: null } },
      data: { status: "CANCELLED" },
    });
    if (claimed.count === 0) {
      const exists = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      throw exists ? wrongState("สัญญา") : notFound();
    }
    await writeAuditLog(tx, {
      actorId,
      action: "contract.cancel",
      entityType: "Contract",
      entityId: id,
      before: { status: "AWAITING_DISBURSEMENT" },
      after: { status: "CANCELLED" },
      extra: reason ? { reason } : undefined,
    });
    return tx.contract.findUniqueOrThrow({
      where: { id },
      select: { id: true, contractNo: true, status: true, principal: true, dueDate: true, borrowerId: true },
    });
  });
}
