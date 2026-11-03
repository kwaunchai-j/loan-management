import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, DomainError, sendError } from "../http.js";
import { bangkokToday } from "../lib/dates.js";
import { dateOnly, idParam, moneyAmount } from "../lib/schemas.js";
import { monthCalendar } from "./calendar.js";
import { calendarFeedToken } from "./calendar-feed.js";
import { contractMoneyView, paymentView } from "./views.js";
import { confirmSubmission, listSubmissions, rejectSubmission } from "./submissions.js";

const listQuery = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED"]).optional(),
  contractId: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const confirmBody = z.object({
  amount: moneyAmount.optional(),
  paidOn: dateOnly.optional(),
  note: z.string().trim().min(1).max(500).optional(),
});
const rejectBody = z.object({ reason: z.string().trim().min(1).max(500) });
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "เดือนต้องอยู่ในรูปแบบ YYYY-MM").optional() });

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง";

/** ADMIN: the queue of slips borrowers sent (CR-1). Mounted at /admin/payment-submissions. */
export function createAdminSubmissionsRouter(deps: { prisma: Db; auth: AuthMiddleware }): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));
  const { prisma } = deps;
  const idOf = (raw: unknown) => {
    const id = idParam.safeParse(raw);
    if (!id.success) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการ");
    return id.data;
  };

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) return sendError(res, 400, "VALIDATION_ERROR", "พารามิเตอร์ค้นหาไม่ถูกต้อง");
      res.status(200).json(await listSubmissions(prisma, q.data));
    }),
  );

  // Confirming records a real payment: amount and date may be corrected first (the borrower's figures
  // are only a claim); every ledger rule applies, and a refusal leaves the claim waiting.
  router.post(
    "/:id/confirm",
    asyncHandler(async (req, res) => {
      const body = confirmBody.safeParse(req.body ?? {});
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(body.error));
      const r = await confirmSubmission(prisma, idOf(req.params.id), req.user!.id, body.data);
      res.status(200).json({ submission: r.submission, payment: paymentView(r.payment), contract: contractMoneyView(r.contract) });
    }),
  );

  router.post(
    "/:id/reject",
    asyncHandler(async (req, res) => {
      const body = rejectBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาระบุเหตุผลที่ไม่ยืนยัน");
      res.status(200).json(await rejectSubmission(prisma, idOf(req.params.id), req.user!.id, body.data.reason));
    }),
  );

  return router;
}

/** ADMIN: the month calendar (what is due and what was paid, per day). Mounted at /admin/calendar. */
export function createAdminCalendarRouter(deps: { prisma: Db; auth: AuthMiddleware; sessionSecret: string }): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));

  // The private subscription link for Google / iCloud Calendar (see calendar-feed.ts). The path is relative to the
  // API; the web app puts its own origin and /api in front of it.
  router.get(
    "/feed-link",
    asyncHandler(async (req, res) => {
      const user = await deps.prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, passwordHash: true } });
      res.status(200).set("cache-control", "no-store").json({ path: `/calendar/feed/${calendarFeedToken(user, deps.sessionSecret)}.ics` });
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = monthQuery.safeParse(req.query);
      if (!q.success) return sendError(res, 400, "VALIDATION_ERROR", firstIssue(q.error));
      const today = bangkokToday();
      const raw = q.data.month ?? today.toISOString().slice(0, 7);
      const year = Number(raw.slice(0, 4));
      if (year < 1970 || year > 2100) return sendError(res, 400, "VALIDATION_ERROR", "ปีต้องอยู่ระหว่าง 1970 ถึง 2100 (ค.ศ.)");
      res.status(200).json(await monthCalendar(deps.prisma, { year, month: Number(raw.slice(5, 7)) }, today));
    }),
  );
  return router;
}
