import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { forbidClientBorrowerId, sessionBorrowerId } from "../auth/borrower-scope.js";
import { asyncHandler, DomainError, sendError } from "../http.js";
import { formatDateOnly } from "../lib/dates.js";
import { dateOnly, idParam, moneyAmount } from "../lib/schemas.js";
import { disbursementView, recordDisbursement } from "./disbursement.js";
import { estimateInterest } from "./interest-estimate.js";
import type { SlipStorage } from "../lib/slip-storage.js";
import {
  approveRequest,
  cancelContract,
  cancelRequest,
  createRequest,
  rejectRequest,
  requestSelect,
  requestView,
  updateContract,
} from "./service.js";
import { contractMoneyView } from "./views.js";

const createBody = z.object({ amount: moneyAmount, requestedDueDate: dateOnly });
const adminCreateBody = createBody.extend({ borrowerId: idParam });
// the due date is optional (blank = the standard 30 days); an empty box in the form arrives as ""
const estimateQuery = z.object({
  amount: moneyAmount,
  dueDate: z.preprocess((v) => (v === "" ? undefined : v), dateOnly.optional()),
});
const rejectBody = z.object({ reason: z.string().trim().min(1).max(500) });
const disbursementBody = z.object({
  paidOn: dateOnly,
  slipFileKey: z.string().min(1).max(100),
  note: z.string().trim().min(1).max(500).optional(),
  amount: moneyAmount.optional(),
});
// interest may be 0 (unlike every other amount), so it has its own check
const interestAmountInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d{1,12}(\.\d{1,2})?$/.test(s), { message: "ดอกเบี้ยต้องไม่ติดลบและมีทศนิยมไม่เกิน 2 ตำแหน่ง" });
const updateContractBody = z
  .object({ principal: moneyAmount.optional(), dueDate: dateOnly.optional(), interestAmount: interestAmountInput.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "ไม่มีข้อมูลที่ต้องแก้ไข" });
const cancelContractBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });
const listQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  borrowerId: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง";

/** Borrower side: only creating a request, always for the session's own borrower (DES-002/004). */
export function createBorrowerLoanRequestsRouter(deps: {
  prisma: Db;
  auth: AuthMiddleware;
  /** Called after a request filed by a borrower is saved (used to notify the admin, DES-013). */
  onRequestCreated?: (loanRequestId: string) => void;
}): Router {
  const router = Router();

  // "How much interest would this be?" — only a calculation: nothing is saved (see interest-estimate.ts).
  router.get(
    "/interest-estimate",
    deps.auth.authorizeBorrower,
    asyncHandler(async (req, res) => {
      const query = estimateQuery.safeParse(req.query);
      if (!query.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(query.error));
      res.json(await estimateInterest(deps.prisma, { amount: query.data.amount, dueDate: query.data.dueDate }));
    }),
  );

  router.post(
    "/",
    deps.auth.authorizeBorrower,
    forbidClientBorrowerId,
    asyncHandler(async (req, res) => {
      const body = createBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const row = await createRequest(deps.prisma, {
        borrowerId: sessionBorrowerId(req),
        amount: body.data.amount,
        requestedDueDate: body.data.requestedDueDate,
        createdById: req.user!.id,
      });
      deps.onRequestCreated?.(row.id);
      res.status(201).json(requestView(row));
    }),
  );

  // A borrower may withdraw their own request while it is still PENDING (decision P2).
  router.post(
    "/:id/cancel",
    deps.auth.authorizeBorrower,
    forbidClientBorrowerId,
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 404, "NOT_FOUND", "ไม่พบรายการ");
      const row = await cancelRequest(deps.prisma, id.data, req.user!.id, {
        ownedBy: sessionBorrowerId(req),
      });
      res.status(200).json(requestView(row));
    }),
  );
  return router;
}

export function createAdminLoanRequestsRouter(deps: { prisma: Db; auth: AuthMiddleware }): Router {
  const router = Router();
  const { prisma } = deps;
  router.use(deps.auth.authorize("ADMIN"));

  const idOf = (raw: unknown) => {
    const id = idParam.safeParse(raw);
    if (!id.success) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการ");
    return id.data;
  };

  // ADMIN files a request on behalf of a borrower; approving it is a separate call (no maker/checker rule).
  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const body = adminCreateBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const row = await createRequest(prisma, { ...body.data, createdById: req.user!.id });
      res.status(201).json(requestView(row));
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) return sendError(res, 400, "VALIDATION_ERROR", "พารามิเตอร์ค้นหาไม่ถูกต้อง");
      const where: Prisma.LoanRequestWhereInput = {
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(q.data.borrowerId ? { borrowerId: q.data.borrowerId } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.loanRequest.count({ where }),
        prisma.loanRequest.findMany({
          where,
          select: requestSelect,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: q.data.limit,
          skip: q.data.offset,
        }),
      ]);
      res.status(200).json({ total, items: rows.map(requestView) });
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const row = await prisma.loanRequest.findUnique({ where: { id: idOf(req.params.id) }, select: requestSelect });
      if (!row) return sendError(res, 404, "NOT_FOUND", "ไม่พบรายการ");
      res.status(200).json(requestView(row));
    }),
  );

  router.post(
    "/:id/approve",
    asyncHandler(async (req, res) => {
      res.status(200).json(requestView(await approveRequest(prisma, idOf(req.params.id), req.user!.id)));
    }),
  );

  router.post(
    "/:id/reject",
    asyncHandler(async (req, res) => {
      const body = rejectBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาระบุเหตุผลที่ปฏิเสธ");
      res
        .status(200)
        .json(requestView(await rejectRequest(prisma, idOf(req.params.id), req.user!.id, body.data.reason)));
    }),
  );

  router.post(
    "/:id/cancel",
    asyncHandler(async (req, res) => {
      res.status(200).json(requestView(await cancelRequest(prisma, idOf(req.params.id), req.user!.id)));
    }),
  );

  return router;
}

export function createAdminContractsRouter(deps: {
  prisma: Db;
  auth: AuthMiddleware;
  storage: SlipStorage;
}): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 404, "NOT_FOUND", "ไม่พบรายการ");
      const body = updateContractBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const c = await updateContract(deps.prisma, id.data, req.user!.id, body.data);
      res.status(200).json({ contract: contractMoneyView(c) });
    }),
  );

  router.post(
    "/:id/cancel",
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 404, "NOT_FOUND", "ไม่พบรายการ");
      const body = cancelContractBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "เหตุผลไม่ถูกต้อง");
      const c = await cancelContract(deps.prisma, id.data, req.user!.id, body.data.reason);
      res.status(200).json({
        id: c.id,
        contractNo: c.contractNo,
        status: c.status,
        principal: c.principal.toString(),
        dueDate: formatDateOnly(c.dueDate),
        borrowerId: c.borrowerId,
      });
    }),
  );

  router.post(
    "/:id/disbursement",
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 404, "NOT_FOUND", "ไม่พบรายการ");
      const body = disbursementBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const result = await recordDisbursement(deps.prisma, deps.storage, {
        contractId: id.data,
        actorId: req.user!.id,
        ...body.data,
      });
      res.status(201).json(disbursementView(result));
    }),
  );

  return router;
}
