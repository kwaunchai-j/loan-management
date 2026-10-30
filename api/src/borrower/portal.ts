import express, { Router } from "express";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { forbidClientBorrowerId, sessionBorrowerId } from "../auth/borrower-scope.js";
import { asyncHandler, sendError } from "../http.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import type { FieldCipher } from "../lib/field-crypto.js";
import { dateOnly, idParam, moneyAmount } from "../lib/schemas.js";
import type { SlipStorage } from "../lib/slip-storage.js";
import { computeState, detailInclude, type ContractWith } from "../loans/queries.js";
import { borrowerSubmissionView, createSubmission, listBorrowerSubmissions } from "../loans/submissions.js";
import { z } from "zod";

/**
 * What a borrower sees of their own data (T-503, DES-008, DES-005). Mounted at /me.
 *
 * Every route is behind `authorizeBorrower` (a BORROWER who has accepted the PDPA terms) and
 * `forbidClientBorrowerId`: the borrower is ALWAYS the one in the session, never named by the
 * client. Another borrower's record is answered as "not found", so its existence is not revealed.
 *
 * Deliberately NOT shown to a borrower: transfer slips and who recorded what, the reason a request
 * was rejected, admin notes on payments, interest/late-fee rates, import flags, any other borrower.
 * Before the money is paid out a contract shows no amount owed at all.
 */
const LIST_LIMIT = 500;

/** "I paid": amount, the day of the transfer and an optional note travel in the query; the body is the slip image. */
const submitQuery = z.object({
  amount: moneyAmount,
  paidOn: dateOnly,
  note: z.string().trim().min(1).max(500).optional(),
});

export function createBorrowerPortalRouter(deps: {
  prisma: Db;
  auth: AuthMiddleware;
  cipher: FieldCipher;
  /** Where payment slips sent by borrowers are kept (the same private store as the lender's own slips). */
  storage: SlipStorage;
  slipMaxBytes: number;
  /** Called after a slip was saved (used to tell the admin, DES-013). */
  onPaymentSubmitted?: (submissionId: string) => void;
}): Router {
  const router = Router();
  router.use(deps.auth.authorizeBorrower, forbidClientBorrowerId);
  const { prisma } = deps;

  function contractView(c: ContractWith, today: Date) {
    const { state, isOverdue, daysOverdue, isLate } = computeState(c, today);
    const base = {
      id: c.id,
      contractNo: c.contractNo,
      status: c.status,
      principal: c.principal.toString(),
      dueDate: formatDateOnly(c.dueDate),
    };
    // waiting for the payout, or cancelled: no interest, no amount owed (DES-005)
    if (c.status !== "ACTIVE" && c.status !== "CLOSED") return base;
    const totalDue = state.outstandingPrincipal.plus(state.outstandingInterest).plus(state.accruedLateFee);
    return {
      ...base,
      disbursedOn: c.disbursedOn ? formatDateOnly(c.disbursedOn) : null,
      interestAmount: c.interestAmount?.toString() ?? null,
      outstandingPrincipal: state.outstandingPrincipal.toString(),
      outstandingInterest: state.outstandingInterest.toString(),
      accruedLateFee: state.accruedLateFee.toString(),
      totalDue: totalDue.toString(),
      isOverdue,
      daysOverdue,
      isLate,
      closedOn: state.closedOn ? formatDateOnly(state.closedOn) : null,
    };
  }

  router.get(
    "/profile",
    asyncHandler(async (req, res) => {
      const b = await prisma.borrower.findUniqueOrThrow({
        where: { id: sessionBorrowerId(req) },
        select: {
          fullName: true,
          phone: true,
          bankName: true,
          bankAccountNo: true,
          pdpaAcceptedAt: true,
          pdpaVersion: true,
          user: { select: { username: true } },
        },
      });
      res.status(200).json({
        username: b.user?.username ?? null,
        fullName: b.fullName,
        phone: b.phone,
        bankName: b.bankName,
        // the borrower may see their own account number (DES-002); it is stored encrypted
        bankAccountNo: b.bankAccountNo === null ? null : deps.cipher.decrypt(b.bankAccountNo),
        pdpaAcceptedAt: b.pdpaAcceptedAt,
        pdpaVersion: b.pdpaVersion,
      });
    }),
  );

  router.get(
    "/loan-requests",
    asyncHandler(async (req, res) => {
      const rows = await prisma.loanRequest.findMany({
        where: { borrowerId: sessionBorrowerId(req) },
        select: {
          id: true,
          amount: true,
          requestedDueDate: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          contract: { select: { id: true, contractNo: true, status: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: LIST_LIMIT,
      });
      res.status(200).json({
        items: rows.map((r) => ({
          id: r.id,
          amount: r.amount.toString(),
          requestedDueDate: formatDateOnly(r.requestedDueDate),
          status: r.status,
          createdAt: r.createdAt,
          decidedAt: r.decidedAt,
          contract: r.contract,
        })),
      });
    }),
  );

  router.get(
    "/contracts",
    asyncHandler(async (req, res) => {
      const rows = await prisma.contract.findMany({
        where: { borrowerId: sessionBorrowerId(req) },
        include: detailInclude,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: LIST_LIMIT,
      });
      const today = bangkokToday();
      res.status(200).json({ items: rows.map((c) => contractView(c, today)) });
    }),
  );

  router.get(
    "/contracts/:id",
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      // someone else's contract and a contract that does not exist look exactly the same
      const c = id.success
        ? await prisma.contract.findFirst({ where: { id: id.data, borrowerId: sessionBorrowerId(req) }, include: detailInclude })
        : null;
      if (!c) return sendError(res, 404, "NOT_FOUND", "ไม่พบสัญญา");
      const paidOut = c.status === "ACTIVE" || c.status === "CLOSED";
      res.status(200).json({
        contract: contractView(c, bangkokToday()),
        // payout and payments are history the borrower may see once the money has moved
        disbursement: paidOut && c.disbursement ? { amount: c.disbursement.amount.toString(), paidOn: formatDateOnly(c.disbursement.paidOn) } : null,
        payments: paidOut
          ? c.payments.map((p) => ({
              id: p.id,
              amount: p.amount.toString(),
              paidOn: formatDateOnly(p.paidOn),
              allocatedLateFee: p.allocatedLateFee.toString(),
              allocatedInterest: p.allocatedInterest.toString(),
              allocatedPrincipal: p.allocatedPrincipal.toString(),
            }))
          : [],
      });
    }),
  );

  // The borrower's own payment claims (CR-1): the status, and the reason when one was refused.
  router.get(
    "/payment-submissions",
    asyncHandler(async (req, res) => {
      res.status(200).json({ items: await listBorrowerSubmissions(prisma, sessionBorrowerId(req)) });
    }),
  );

  // "I paid": a claim with the slip attached. It changes NO balance; the admin confirms or refuses it.
  router.post(
    "/contracts/:id/payment-submissions",
    express.raw({ type: () => true, limit: deps.slipMaxBytes }),
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 404, "NOT_FOUND", "ไม่พบสัญญา");
      const q = submitQuery.safeParse(req.query);
      if (!q.success) return sendError(res, 400, "VALIDATION_ERROR", q.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      const body: unknown = req.body;
      const row = await createSubmission(prisma, deps.storage, {
        borrowerId: sessionBorrowerId(req),
        userId: req.user!.id,
        contractId: id.data,
        amount: q.data.amount,
        paidOn: q.data.paidOn,
        note: q.data.note,
        bytes: Buffer.isBuffer(body) ? body : Buffer.alloc(0),
      });
      deps.onPaymentSubmitted?.(row.id);
      res.status(201).json(borrowerSubmissionView(row));
    }),
  );

  return router;
}
