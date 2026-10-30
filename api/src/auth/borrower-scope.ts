import type { Request, RequestHandler } from "express";
import { sendError } from "../http.js";

/**
 * lib:borrower-scope — borrower-facing endpoints identify the borrower ONLY from the session
 * (DES-002). Mount `forbidClientBorrowerId` after `auth.authorizeBorrower` on borrower routers and
 * read the id through `sessionBorrowerId`; never take `borrowerId` from params, query or body.
 */
export function sessionBorrowerId(req: Request): string {
  const id = req.user?.borrowerId;
  if (!id) {
    // authorizeBorrower guarantees this; reaching here means the route is missing the guard.
    throw new Error("sessionBorrowerId called on a request without a borrower session");
  }
  return id;
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && key in value;
}

/** Rejects (400) any request that tries to name a borrower itself, so a missed filter cannot be abused. */
export const forbidClientBorrowerId: RequestHandler = (req, res, next) => {
  if (hasKey(req.query, "borrowerId") || hasKey(req.body, "borrowerId") || "borrowerId" in req.params) {
    return sendError(res, 400, "BORROWER_ID_NOT_ALLOWED", "ไม่อนุญาตให้ระบุ borrowerId ในคำขอ");
  }
  next();
};
