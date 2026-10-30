import express, { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, DomainError, sendError } from "../http.js";
import { bangkokToday } from "../lib/dates.js";
import { getRates } from "../lib/rates.js";
import { idParam } from "../lib/schemas.js";
import { analyzeRows, loadBorrowerIndex, MAX_BACKFILL_ACCRUALS, rowView, summarize } from "./analyze.js";
import { commitImport, listBatches, rollbackBatch } from "./commit.js";
import { ImportFileError, readUpload } from "./parse-file.js";
import { newImportKey, STAGED_MAX_AGE_MS, type ImportStorage } from "./storage.js";
import { HEADER, parseRows } from "./validate.js";

export const DEFAULT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** The template: just the header, UTF-8 with a BOM so Excel shows the Thai correctly. */
const BOM = String.fromCharCode(0xfeff);
const TEMPLATE_CSV = `${BOM}${HEADER.join(",")}\r\n`;

const commitBody = z.object({
  importKey: z.string().min(1).max(100),
  fileName: z.string().max(300).optional(),
  choices: z.record(z.string().max(200), idParam).refine((c) => Object.keys(c).length <= 2000, "too many choices").default({}),
  skipInvalidRows: z.boolean().default(false),
});

/** Just the file's own name, without any folder the browser or a script may have added. */
const baseName = (raw: unknown) => {
  const last = String(raw ?? "").split(/[\\/]/).pop()!;
  // keep printable characters only (no control characters in a stored file name)
  const clean = [...last].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim();
  return clean.slice(0, 200) || "import";
};

/**
 * Importing contracts from Excel/CSV (T-601, T-602). ADMIN only.
 *   GET  /admin/imports/template        download the template
 *   POST /admin/imports/preview         raw file bytes -> checked rows + borrower matches (nothing saved)
 *   POST /admin/imports/commit          { importKey, choices, skipInvalidRows } -> import (one transaction)
 *   GET  /admin/imports                 batches, and whether each can still be rolled back
 *   POST /admin/imports/:id/rollback    undo a batch (only while none of its contracts has a payment)
 */
export function createAdminImportsRouter(deps: {
  prisma: Db;
  auth: AuthMiddleware;
  storage: ImportStorage;
  maxBytes: number;
}): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));
  const { prisma, storage } = deps;

  router.get("/template", (_req, res) => {
    res
      .status(200)
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="import-template.csv"',
        "Cache-Control": "no-store",
      })
      .send(TEMPLATE_CSV);
  });

  router.post(
    "/preview",
    express.raw({ type: () => true, limit: deps.maxBytes }),
    asyncHandler(async (req, res) => {
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return sendError(res, 400, "NO_FILE", "กรุณาแนบไฟล์ Excel หรือ CSV (ส่งไฟล์เป็น body ของคำขอ)");
      }
      let upload;
      let parsed;
      try {
        upload = await readUpload(body);
        parsed = parseRows(upload.rows);
      } catch (err) {
        if (err instanceof ImportFileError) return sendError(res, 400, "INVALID_FILE", err.message);
        throw err;
      }

      const rates = await getRates(prisma);
      const today = bangkokToday();
      const rateKnown = rates.lateFeeRatePctPerDay !== null && rates.interestRatePctPerMonth !== null;
      const analyzed = analyzeRows(parsed, await loadBorrowerIndex(prisma), today, rates.lateFeeRatePctPerDay);
      const summary = summarize(analyzed, rates.lateFeeRatePctPerDay !== null);

      const needsChoice = new Map<string, { name: string; rowNumbers: number[]; candidates: unknown }>();
      for (const r of analyzed) {
        if (r.errors.length > 0 || r.match.status !== "AMBIGUOUS") continue;
        const e = needsChoice.get(r.name) ?? { name: r.name, rowNumbers: [], candidates: r.match.candidates };
        e.rowNumbers.push(r.rowNumber);
        needsChoice.set(r.name, e);
      }

      // The file waits on the server under a random key; confirming sends only that key and the choices.
      const importKey = newImportKey(upload.type);
      await storage.put(importKey, body);
      void storage.purgeOlderThan(STAGED_MAX_AGE_MS).catch(() => undefined);

      res.status(200).json({
        importKey,
        fileName: baseName(req.query.fileName),
        ratesReady: rateKnown,
        summary,
        canCommit: rateKnown && summary.validRows > 0 && summary.lateDays <= MAX_BACKFILL_ACCRUALS,
        needsChoice: [...needsChoice.values()],
        hasInvalidRows: summary.invalidRows > 0,
        rows: analyzed.map((r) => rowView(r, today)),
      });
    }),
  );

  router.post(
    "/commit",
    asyncHandler(async (req, res) => {
      const body = commitBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "ข้อมูลการยืนยันนำเข้าไม่ถูกต้อง");
      const result = await commitImport(prisma, storage, {
        importKey: body.data.importKey,
        fileName: baseName(body.data.fileName),
        choices: body.data.choices,
        skipInvalidRows: body.data.skipInvalidRows,
        actorId: req.user!.id,
      });
      res.status(201).json(result);
    }),
  );

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await listBatches(prisma) });
    }),
  );

  router.post(
    "/:id/rollback",
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) throw new DomainError(404, "NOT_FOUND", "ไม่พบชุดนำเข้า");
      const r = await rollbackBatch(prisma, id.data, req.user!.id);
      res.status(200).json({
        id: r.batch.id,
        status: r.batch.status,
        rolledBackAt: r.batch.rolledBackAt,
        contractsDeleted: r.contractsDeleted,
        lateFeeRowsDeleted: r.lateFeeRowsDeleted,
      });
    }),
  );

  return router;
}
