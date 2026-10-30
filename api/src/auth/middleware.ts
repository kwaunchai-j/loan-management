import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@prisma/client";
import type { Db } from "../db.js";
import { SESSION_COOKIE, parseCookies } from "../lib/cookie.js";
import { passwordVersion, verifySession } from "../lib/session.js";
import { asyncHandler, sendError } from "../http.js";

/** lib:authz — the authenticated principal, always reloaded from the database. */
export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  /** Set for BORROWER accounts; borrower-facing endpoints must filter by this, never by client input. */
  borrowerId: string | null;
  /** When the borrower accepted the PDPA terms; null until then (always null for ADMIN). */
  pdpaAcceptedAt: Date | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface AuthMiddleware {
  /** Valid session required; allowed even while `mustChangePassword` (me, change-password). */
  authenticate: RequestHandler;
  /** Valid session, password already changed, and one of `roles`. Use this on every business route. */
  authorize: (...roles: Role[]) => RequestHandler;
  /**
   * Guard for EVERY borrower-facing endpoint (DES-002): a BORROWER with a borrower profile who has
   * accepted the PDPA terms. Others get 403 (PDPA_REQUIRED until accepted).
   */
  authorizeBorrower: RequestHandler;
  /** Same as `authorizeBorrower` but without the PDPA check — only for the PDPA endpoints themselves. */
  authorizeBorrowerForPdpa: RequestHandler;
}

export function createAuthMiddleware(deps: { prisma: Db; sessionSecret: string }): AuthMiddleware {
  const authenticate = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const claims = token ? await verifySession(token, deps.sessionSecret) : null;
    const user = claims
      ? await deps.prisma.user.findUnique({
          where: { id: claims.userId },
          select: {
            id: true,
            username: true,
            role: true,
            isActive: true,
            mustChangePassword: true,
            passwordHash: true,
            borrower: { select: { id: true, pdpaAcceptedAt: true } },
          },
        })
      : null;
    if (!claims || !user || !user.isActive || passwordVersion(user.passwordHash) !== claims.passwordVersion) {
      return sendError(res, 401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบ");
    }
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      borrowerId: user.borrower?.id ?? null,
      pdpaAcceptedAt: user.borrower?.pdpaAcceptedAt ?? null,
    };
    next();
  });

  const authorize =
    (...roles: Role[]): RequestHandler =>
    (req, res, next) => {
      authenticate(req, res, (err?: unknown) => {
        if (err) return next(err);
        const user = req.user;
        if (!user) return;
        if (user.mustChangePassword) {
          return sendError(res, 403, "PASSWORD_CHANGE_REQUIRED", "กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน");
        }
        if (!roles.includes(user.role)) {
          return sendError(res, 403, "FORBIDDEN", "คุณไม่มีสิทธิ์ใช้งานส่วนนี้");
        }
        next();
      });
    };

  const borrowerGuard =
    (requirePdpa: boolean): RequestHandler =>
    (req, res, next) => {
      authorize("BORROWER")(req, res, (err?: unknown) => {
        if (err) return next(err);
        const user = req.user!;
        if (!user.borrowerId) {
          return sendError(res, 403, "NO_BORROWER_PROFILE", "บัญชีนี้ยังไม่ได้ผูกกับข้อมูลผู้ยืม");
        }
        if (requirePdpa && !user.pdpaAcceptedAt) {
          return sendError(
            res,
            403,
            "PDPA_REQUIRED",
            "กรุณายอมรับเงื่อนไขการเก็บข้อมูลส่วนบุคคลก่อนใช้งาน",
          );
        }
        next();
      });
    };

  return {
    authenticate,
    authorize,
    authorizeBorrower: borrowerGuard(true),
    authorizeBorrowerForPdpa: borrowerGuard(false),
  };
}
