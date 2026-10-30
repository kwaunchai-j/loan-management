import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, sendError } from "../http.js";
import { bangkokToday, parseDateOnly } from "../lib/dates.js";
import { borrowerSummary, latePayers, outstanding } from "./contract-reports.js";
import { parsePeriod, PeriodError } from "./period.js";
import { profitLoss } from "./profit-loss.js";

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The four reports (T-501, T-502). ADMIN only; every one can be filtered by month, year or custom range. */
export function createAdminReportsRouter(deps: { prisma: Db; auth: AuthMiddleware }): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));
  const { prisma } = deps;

  const period = (query: unknown) => parsePeriod(query);

  router.get(
    "/profit-loss",
    asyncHandler(async (req, res) => {
      res.status(200).json(await profitLoss(prisma, period(req.query), bangkokToday()));
    }),
  );

  router.get(
    "/late-payers",
    asyncHandler(async (req, res) => {
      const page = pageQuery.safeParse(req.query);
      if (!page.success) return sendError(res, 400, "VALIDATION_ERROR", "พารามิเตอร์แบ่งหน้าไม่ถูกต้อง");
      res.status(200).json(await latePayers(prisma, period(req.query), bangkokToday(), page.data));
    }),
  );

  router.get(
    "/outstanding",
    asyncHandler(async (req, res) => {
      const today = bangkokToday();
      const raw = typeof req.query.asOf === "string" ? req.query.asOf : undefined;
      const asOf = raw === undefined ? today : parseDateOnly(raw);
      if (!asOf || asOf.getTime() > today.getTime()) {
        return sendError(res, 400, "VALIDATION_ERROR", "asOf ต้องเป็นวันที่ในรูปแบบ YYYY-MM-DD และไม่เป็นวันในอนาคต");
      }
      res.status(200).json(await outstanding(prisma, asOf, today));
    }),
  );

  router.get(
    "/borrower-summary",
    asyncHandler(async (req, res) => {
      const page = pageQuery.safeParse(req.query);
      if (!page.success) return sendError(res, 400, "VALIDATION_ERROR", "พารามิเตอร์แบ่งหน้าไม่ถูกต้อง");
      res.status(200).json(await borrowerSummary(prisma, period(req.query), bangkokToday(), page.data));
    }),
  );

  // A bad period is the caller's mistake, not a server error.
  router.use((err: unknown, _req: unknown, res: import("express").Response, next: import("express").NextFunction) => {
    if (err instanceof PeriodError) return sendError(res, 400, "INVALID_PERIOD", err.message);
    next(err);
  });

  return router;
}
