import type { NextFunction, Request, RequestHandler, Response } from "express";
import { RatesNotSetError } from "./lib/rates.js";

export function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

/** Express 4 does not catch rejected promises from async handlers. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Last-resort handler: never leak internals to the client. */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.parse.failed") {
    return sendError(res, 400, "INVALID_JSON", "รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง");
  }
  if (type === "entity.too.large") {
    return sendError(res, 413, "PAYLOAD_TOO_LARGE", "ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป");
  }
  if (err instanceof DomainError) {
    return sendError(res, err.status, err.code, err.message);
  }
  if (err instanceof RatesNotSetError) {
    return sendError(
      res,
      409,
      "RATES_NOT_SET",
      "ยังไม่ได้ตั้งอัตราดอกเบี้ยและอัตราค่าปรับ กรุณาตั้งค่าที่หน้าตั้งค่าก่อน",
    );
  }
  console.error("unhandled error:", err instanceof Error ? err.message : "unknown");
  return sendError(res, 500, "INTERNAL_ERROR", "เกิดข้อผิดพลาดภายในระบบ");
}

/** An expected business-rule failure; the error handler turns it into a JSON error response. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
