import { z } from "zod";
import { parseDateOnly } from "./dates.js";

/** Money amount > 0 with at most 2 decimals, fitting Decimal(14,2). Read via text so no float reaches the DB. */
export const moneyAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d{1,12}(\.\d{1,2})?$/.test(s) && Number(s) > 0, {
    message: "จำนวนเงินต้องมากกว่า 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง",
  });

/** "YYYY-MM-DD" calendar date -> date-only Date. */
export const dateOnly = z
  .string()
  .transform((s, ctx) => {
    const d = parseDateOnly(s.trim());
    if (!d) {
      ctx.addIssue({ code: "custom", message: "วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD และเป็นวันที่จริง" });
      return z.NEVER;
    }
    return d;
  });

export const idParam = z.string().min(1).max(40);
