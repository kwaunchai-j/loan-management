import express, { Router } from "express";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, sendError } from "../http.js";
import {
  detectSlipType,
  newSlipKey,
  slipTypeOfKey,
  type SlipStorage,
} from "../lib/slip-storage.js";

export const DEFAULT_SLIP_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Slip upload and download — ADMIN only (T-203).
 * Upload: send the raw image bytes as the request body (no multipart). The server picks the key.
 */
export function createAdminSlipsRouter(deps: {
  auth: AuthMiddleware;
  storage: SlipStorage;
  maxBytes: number;
}): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));

  router.post(
    "/",
    express.raw({ type: () => true, limit: deps.maxBytes }),
    asyncHandler(async (req, res) => {
      const body: unknown = req.body;
      // A JSON body was already parsed into an object by the app-level parser: not a file.
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return sendError(res, 400, "NO_FILE", "กรุณาแนบไฟล์สลิป (ส่งไฟล์รูปเป็น body ของคำขอ)");
      }
      const type = detectSlipType(body);
      if (!type) {
        return sendError(res, 415, "UNSUPPORTED_FILE_TYPE", "รองรับเฉพาะไฟล์รูป JPEG หรือ PNG");
      }
      const key = newSlipKey(type);
      await deps.storage.put(key, body);
      res.status(201).json({ slipFileKey: key, contentType: type.mime, size: body.length });
    }),
  );

  router.get(
    "/:key",
    asyncHandler(async (req, res) => {
      const key = String(req.params.key);
      const type = slipTypeOfKey(key);
      const data = type ? await deps.storage.get(key) : null;
      if (!type || !data) return sendError(res, 404, "NOT_FOUND", "ไม่พบสลิป");
      res
        .status(200)
        .set({
          "Content-Type": type.mime,
          "Content-Length": String(data.length),
          "Content-Disposition": `inline; filename="slip.${type.ext}"`,
          // Treat the bytes as an inert image whatever they contain.
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "private, no-store",
        })
        .send(data);
    }),
  );

  return router;
}
