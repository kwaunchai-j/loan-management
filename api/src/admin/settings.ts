import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, sendError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { recordRateChange } from "../lib/rate-notice.js";
import { SETTING_ID } from "../lib/rates.js";

/**
 * Master data (DES-003): the interest rate (% per month, flat) and late-fee rate (% per day).
 * One value for the whole system, set by ADMIN. The system imposes no cap (user's decision);
 * the only limit is the column type Decimal(7,4): up to 3 integer and 4 decimal digits.
 * Changing a rate never touches existing contracts — they keep the rate snapshotted at disbursement.
 */

// Accept "2.5" or 2.5; read through the text form so no binary float ever reaches the database.
const rate = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d{1,3}(\.\d{1,4})?$/.test(s), {
    message: "อัตราต้องเป็นตัวเลขไม่ติดลบ ไม่เกิน 999.9999 และมีทศนิยมไม่เกิน 4 ตำแหน่ง",
  });

const patchBody = z
  .object({
    interestRatePctPerMonth: rate.optional(),
    lateFeeRatePctPerDay: rate.optional(),
  })
  .refine(
    (v) => v.interestRatePctPerMonth !== undefined || v.lateFeeRatePctPerDay !== undefined,
    { message: "ไม่มีอัตราที่ต้องแก้ไข" },
  );

const settingSelect = {
  interestRatePctPerMonth: true,
  lateFeeRatePctPerDay: true,
  updatedAt: true,
  updatedBy: { select: { id: true, username: true } },
} satisfies Prisma.SettingSelect;

type SettingRow = Prisma.SettingGetPayload<{ select: typeof settingSelect }>;

function view(row: SettingRow | null) {
  return {
    // Strings keep Decimal exact; null means "not set yet" (disbursement and import are refused).
    interestRatePctPerMonth: row?.interestRatePctPerMonth?.toString() ?? null,
    lateFeeRatePctPerDay: row?.lateFeeRatePctPerDay?.toString() ?? null,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

const ratesOf = (row: SettingRow | null) => ({
  interestRatePctPerMonth: row?.interestRatePctPerMonth ?? null,
  lateFeeRatePctPerDay: row?.lateFeeRatePctPerDay ?? null,
});

export function createAdminSettingsRouter(deps: { prisma: Db; auth: AuthMiddleware }): Router {
  const router = Router();
  const { prisma } = deps;
  router.use(deps.auth.authorize("ADMIN"));

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const row = await prisma.setting.findUnique({
        where: { id: SETTING_ID },
        select: settingSelect,
      });
      res.status(200).json(view(row));
    }),
  );

  router.patch(
    "/",
    asyncHandler(async (req, res) => {
      const body = patchBody.safeParse(req.body);
      if (!body.success) {
        return sendError(res, 400, "VALIDATION_ERROR", body.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      }
      const actorId = req.user!.id;
      const data = body.data;
      const updated = await prisma.$transaction(async (tx) => {
        const before = await tx.setting.findUnique({
          where: { id: SETTING_ID },
          select: settingSelect,
        });
        const after = await tx.setting.upsert({
          where: { id: SETTING_ID },
          create: { id: SETTING_ID, ...data, updatedById: actorId },
          update: { ...data, updatedById: actorId },
          select: settingSelect,
        });
        await writeAuditLog(tx, {
          actorId,
          action: "setting.update",
          entityType: "Setting",
          entityId: String(SETTING_ID),
          before: ratesOf(before),
          after: ratesOf(after),
        });
        // borrowers must acknowledge an adjustment before they can borrow again (CR-9)
        await recordRateChange(tx, ratesOf(before), ratesOf(after), actorId);
        return after;
      });
      res.status(200).json(view(updated));
    }),
  );

  return router;
}
