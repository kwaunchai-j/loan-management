import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, DomainError, sendError } from "../http.js";
import { bangkokToday } from "../lib/dates.js";
import { dateOnly, idParam, moneyAmount } from "../lib/schemas.js";
import type { SlipStorage } from "../lib/slip-storage.js";
import { deletePayment, recordPayment, updatePayment } from "./payments.js";
import { getContractDetail, listContracts } from "./queries.js";
import { deleteDisbursement, updateDisbursement } from "./records.js";
import { contractMoneyView, disbursementRowView, paymentView } from "./views.js";

const note = z.string().trim().min(1).max(500);

const paymentBody = z.object({ amount: moneyAmount, paidOn: dateOnly, note: note.optional() });
const paymentPatch = z
  .object({ amount: moneyAmount.optional(), paidOn: dateOnly.optional(), note: note.nullable().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "ไม่มีข้อมูลที่ต้องแก้ไข" });
const disbursementPatch = z
  .object({
    paidOn: dateOnly.optional(),
    slipFileKey: z.string().min(1).max(100).optional(),
    note: note.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "ไม่มีข้อมูลที่ต้องแก้ไข" });

const listQuery = z.object({
  status: z.enum(["AWAITING_DISBURSEMENT", "ACTIVE", "CLOSED", "CANCELLED"]).optional(),
  borrowerId: idParam.optional(),
  overdue: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["createdAt", "dueDate"]).default("createdAt"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง";
const idOf = (raw: unknown) => {
  const id = idParam.safeParse(raw);
  if (!id.success) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการ");
  return id.data;
};

/**
 * ADMIN-only money endpoints after the payout: contract queries (T-306), payments (T-303) and
 * editing/deleting payments and payouts (T-305). Mounted at /admin.
 */
export function createAdminLedgerRouter(deps: { prisma: Db; auth: AuthMiddleware; storage: SlipStorage }): Router {
  const router = Router();
  const admin = deps.auth.authorize("ADMIN");
  const { prisma } = deps;

  router.get(
    "/contracts",
    admin,
    asyncHandler(async (req, res) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) return sendError(res, 400, "VALIDATION_ERROR", "พารามิเตอร์ค้นหาไม่ถูกต้อง");
      const { overdue, ...rest } = q.data;
      res.status(200).json(await listContracts(prisma, { ...rest, overdue: overdue === "true" }, bangkokToday()));
    }),
  );

  router.get(
    "/contracts/:id",
    admin,
    asyncHandler(async (req, res) => {
      res.status(200).json(await getContractDetail(prisma, idOf(req.params.id), bangkokToday()));
    }),
  );

  router.post(
    "/contracts/:id/payments",
    admin,
    asyncHandler(async (req, res) => {
      const body = paymentBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const r = await recordPayment(prisma, {
        contractId: idOf(req.params.id),
        actorId: req.user!.id,
        ...body.data,
      });
      res.status(201).json({ payment: paymentView(r.payment), contract: contractMoneyView(r.contract) });
    }),
  );

  router.patch(
    "/payments/:id",
    admin,
    asyncHandler(async (req, res) => {
      const body = paymentPatch.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const r = await updatePayment(prisma, idOf(req.params.id), req.user!.id, body.data);
      res.status(200).json({ payment: paymentView(r.payment!), contract: contractMoneyView(r.contract) });
    }),
  );

  router.delete(
    "/payments/:id",
    admin,
    asyncHandler(async (req, res) => {
      const r = await deletePayment(prisma, idOf(req.params.id), req.user!.id);
      res.status(200).json({ contract: contractMoneyView(r.contract) });
    }),
  );

  router.patch(
    "/disbursements/:id",
    admin,
    asyncHandler(async (req, res) => {
      const body = disbursementPatch.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const r = await updateDisbursement(prisma, deps.storage, idOf(req.params.id), req.user!.id, body.data);
      res.status(200).json({ disbursement: disbursementRowView(r.disbursement), contract: contractMoneyView(r.contract) });
    }),
  );

  router.delete(
    "/disbursements/:id",
    admin,
    asyncHandler(async (req, res) => {
      const r = await deleteDisbursement(prisma, idOf(req.params.id), req.user!.id);
      res.status(200).json({ contract: contractMoneyView(r.contract) });
    }),
  );

  return router;
}
