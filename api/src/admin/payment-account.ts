import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AuthMiddleware } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { asyncHandler, sendError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { SETTING_ID } from "../lib/rates.js";

/**
 * The lender's own bank account that borrowers transfer repayments to (CR-4). One account for the whole
 * system, kept in the single Setting row next to the rates and set by an ADMIN. Borrowers read it through
 * GET /me/payment-account (borrower/portal.ts) — it is meant to be seen by them, so it is not encrypted.
 * The three parts are set together or all cleared, so a borrower is never shown half an account.
 */

/** 5–30 characters: digits, with spaces or hyphens between them (e.g. "123-4-56789-0" or "1234567890"). */
export const ACCOUNT_NO_PATTERN = /^[0-9][0-9 -]{3,28}[0-9]$/;

// each part must be PRESENT (a string, or null to clear): an empty body must never wipe the account by accident
const part = (max: number) =>
  z
    .string()
    .nullable()
    .transform((v) => (v === null ? null : v.trim()))
    .refine((v) => v === null || v.length <= max, { message: `ยาวเกิน ${max} ตัวอักษร` });

const putBody = z
  .object({ bankName: part(100), accountName: part(150), accountNo: part(30) })
  .transform((v) => ({
    bankName: v.bankName || null, // a blank box means "clear"
    accountName: v.accountName || null,
    accountNo: v.accountNo || null,
  }))
  .superRefine((v, ctx) => {
    const set = [v.bankName, v.accountName, v.accountNo].filter((x) => x !== null).length;
    if (set !== 0 && set !== 3) {
      ctx.addIssue({ code: "custom", message: "กรุณากรอกให้ครบทั้ง 3 ช่อง (ธนาคาร ชื่อบัญชี เลขบัญชี) หรือเว้นว่างทั้งหมดเพื่อลบบัญชี" });
    } else if (v.accountNo !== null && !ACCOUNT_NO_PATTERN.test(v.accountNo)) {
      ctx.addIssue({ code: "custom", message: "เลขบัญชีต้องเป็นตัวเลข 5–30 หลัก (คั่นด้วยช่องว่างหรือขีดได้)" });
    }
  });

const select = {
  paymentBankName: true,
  paymentAccountName: true,
  paymentAccountNo: true,
  updatedAt: true,
  updatedBy: { select: { id: true, username: true } },
} satisfies Prisma.SettingSelect;
type Row = Prisma.SettingGetPayload<{ select: typeof select }>;

const view = (row: Row | null) => ({
  bankName: row?.paymentBankName ?? null,
  accountName: row?.paymentAccountName ?? null,
  accountNo: row?.paymentAccountNo ?? null,
  updatedAt: row?.updatedAt ?? null,
  updatedBy: row?.updatedBy ?? null,
});

/** For the audit log: who changed what, without writing the whole account number into it. */
const audited = (row: Row | null) => ({
  bankName: row?.paymentBankName ?? null,
  accountName: row?.paymentAccountName ?? null,
  accountNoLast4: row?.paymentAccountNo ? row.paymentAccountNo.replace(/[^0-9]/g, "").slice(-4) : null,
});

export function createAdminPaymentAccountRouter(deps: { prisma: Db; auth: AuthMiddleware }): Router {
  const router = Router();
  const { prisma } = deps;
  router.use(deps.auth.authorize("ADMIN"));

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      res.json(view(await prisma.setting.findUnique({ where: { id: SETTING_ID }, select })));
    }),
  );

  router.put(
    "/",
    asyncHandler(async (req, res) => {
      const body = putBody.safeParse(req.body ?? {});
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", body.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      const actorId = req.user!.id;
      const { bankName, accountName, accountNo } = body.data;
      const updated = await prisma.$transaction(async (tx) => {
        const before = await tx.setting.findUnique({ where: { id: SETTING_ID }, select });
        const data = { paymentBankName: bankName, paymentAccountName: accountName, paymentAccountNo: accountNo, updatedById: actorId };
        const after = await tx.setting.upsert({ where: { id: SETTING_ID }, create: { id: SETTING_ID, ...data }, update: data, select });
        await writeAuditLog(tx, {
          actorId,
          action: "setting.paymentAccount.update",
          entityType: "Setting",
          entityId: String(SETTING_ID),
          before: audited(before),
          after: audited(after),
        });
        return after;
      });
      res.json(view(updated));
    }),
  );

  return router;
}
