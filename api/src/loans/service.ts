import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { computeInterest, InterestError } from "../lib/interest.js";
import { ledgerSnapshot, lockContract, reconcileContract, withLedgerErrors } from "./ledger.js";

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

const contractAudit = (c: { principal: Prisma.Decimal; dueDate: Date; interestAmount: Prisma.Decimal | null }) => ({
  principal: c.principal,
  dueDate: formatDateOnly(c.dueDate),
  interestAmount: c.interestAmount,
});

/**
 * ADMIN corrects the terms of a contract (the router enforces ADMIN): principal, interest, due date.
 * The total owed is never typed in — it is principal + interest + late fee, so it follows.
 *  - AWAITING_DISBURSEMENT: principal and due date (no interest exists before the payout).
 *  - ACTIVE / CLOSED: also the interest. The payout row follows the principal (it always equals it).
 *    When the principal or due date change and no interest is given, the interest is recomputed with
 *    the contract's own locked rate; a given interest is kept as typed. Then the whole contract is
 *    replayed like any other change to money after the payout (DES-016).
 *  - CANCELLED: refused.
 */
export async function updateContract(
  prisma: Db,
  id: string,
  actorId: string,
  patch: { principal?: string; dueDate?: Date; interestAmount?: string },
  now: Date = new Date(),
) {
  const today = bangkokToday(now);
  if (patch.dueDate && patch.dueDate.getTime() <= today.getTime()) {
    throw new DomainError(400, "DUE_DATE_NOT_FUTURE", "วันครบกำหนดต้องเป็นวันในอนาคต");
  }
  return withLedgerErrors(
    () => undefined,
    () =>
      prisma.$transaction(async (tx) => {
        if (!(await lockContract(tx, id))) throw notFound();
        const before = await tx.contract.findUniqueOrThrow({ where: { id } });

        if (before.status === "AWAITING_DISBURSEMENT") {
          if (patch.interestAmount !== undefined) {
            throw new DomainError(409, "NO_INTEREST_YET", "ดอกเบี้ยจะคำนวณตอนจ่ายเงิน ยังแก้ไขไม่ได้ในสถานะรอจ่ายเงิน");
          }
          const principal = patch.principal ?? before.principal;
          const updated = await tx.contract.update({
            where: { id },
            data: {
              principal,
              outstandingPrincipal: principal,
              ...(patch.dueDate ? { dueDate: patch.dueDate } : {}),
            },
          });
          await writeAuditLog(tx, {
            actorId,
            action: "contract.update",
            entityType: "Contract",
            entityId: id,
            before: contractAudit(before),
            after: contractAudit(updated),
            extra: { contractNo: before.contractNo, status: before.status },
          });
          return updated;
        }

        if (before.status !== "ACTIVE" && before.status !== "CLOSED") throw wrongState("สัญญา");
        if (before.interestRatePctPerMonth === null || before.disbursedOn === null) {
          throw new Error(`contract ${before.id} is ${before.status} but has no interest rate or payout date`);
        }
        const principal = patch.principal === undefined ? before.principal : new Prisma.Decimal(patch.principal);
        const dueDate = patch.dueDate ?? before.dueDate;
        const termsChanged = !principal.equals(before.principal) || dueDate.getTime() !== before.dueDate.getTime();

        let interestAmount = before.interestAmount;
        if (patch.interestAmount !== undefined) {
          interestAmount = new Prisma.Decimal(patch.interestAmount);
        } else if (termsChanged) {
          try {
            interestAmount = computeInterest({
              principal,
              ratePctPerMonth: before.interestRatePctPerMonth,
              disbursedOn: before.disbursedOn,
              dueDate,
            }).interestAmount;
          } catch (err) {
            if (err instanceof InterestError && err.code === "INVALID_DAYS") {
              throw new DomainError(400, "DUE_DATE_TOO_SOON", "วันครบกำหนดต้องอยู่หลังวันที่จ่ายเงินอย่างน้อย 1 วัน");
            }
            throw err;
          }
        }
        if (!termsChanged && (interestAmount === null || interestAmount.equals(before.interestAmount ?? -1))) {
          return before;
        }

        await tx.contract.update({ where: { id }, data: { principal, dueDate, interestAmount } });
        // The payout always equals the principal.
        await tx.disbursement.updateMany({ where: { contractId: id }, data: { amount: principal } });
        const { contract } = await reconcileContract(tx, id, today);
        await writeAuditLog(tx, {
          actorId,
          action: "contract.update",
          entityType: "Contract",
          entityId: id,
          before: contractAudit(before),
          after: contractAudit(contract),
          extra: {
            contractNo: before.contractNo,
            status: before.status,
            contractBefore: ledgerSnapshot(before),
            contractAfter: ledgerSnapshot(contract),
          },
        });
        return contract;
      }),
  );
}
