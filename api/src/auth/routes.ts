import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import { asyncHandler, sendError } from "../http.js";
import { clearedSessionCookie, sessionCookie } from "../lib/cookie.js";
import { FailureLimiter } from "../lib/rate-limit.js";
import {
  hashPassword,
  passwordPolicyViolation,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from "../lib/password.js";
import { passwordVersion, SESSION_TTL_SECONDS, signSession } from "../lib/session.js";
import type { AuthMiddleware } from "./middleware.js";

/**
 * Login throttling (decision D2). Three independent counters of FAILED attempts in the window:
 *  - per (username, client IP): the tight one. Someone guessing from their own IP is stopped after
 *    a few tries, but cannot lock the real owner out, who logs in from a different IP.
 *  - per username across all IPs: a much higher ceiling, so a guess spread over many IPs is still
 *    bounded, and locking an account out takes a large distributed effort.
 *  - per IP across all usernames: limits password spraying from one address.
 */
export interface LoginRateLimitOptions {
  maxFailuresPerPair: number;
  maxFailuresPerUser: number;
  maxFailuresPerIp: number;
  windowMs: number;
  now?: () => number;
}

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitOptions = {
  maxFailuresPerPair: 5,
  maxFailuresPerUser: 50,
  maxFailuresPerIp: 20,
  windowMs: 15 * 60 * 1000,
};

export interface AuthRouterDeps {
  prisma: Db;
  auth: AuthMiddleware;
  sessionSecret: string;
  secureCookie: boolean;
  rateLimit?: LoginRateLimitOptions;
}

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(1024),
});

const BAD_LOGIN = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง";

function publicUser(u: { id: string; username: string; role: string; mustChangePassword: boolean }) {
  return { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword };
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const rl = deps.rateLimit ?? DEFAULT_LOGIN_RATE_LIMIT;
  const pairLimiter = new FailureLimiter({
    maxFailures: rl.maxFailuresPerPair,
    windowMs: rl.windowMs,
    now: rl.now,
  });
  const userLimiter = new FailureLimiter({
    maxFailures: rl.maxFailuresPerUser,
    windowMs: rl.windowMs,
    now: rl.now,
  });
  const ipLimiter = new FailureLimiter({
    maxFailures: rl.maxFailuresPerIp,
    windowMs: rl.windowMs,
    now: rl.now,
  });
  // Unknown usernames still pay for one scrypt verification so response time does not reveal them.
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  async function issueSession(res: Response, userId: string, passwordHash: string) {
    const token = await signSession(
      { userId, passwordVersion: passwordVersion(passwordHash) },
      deps.sessionSecret,
    );
    res.append("Set-Cookie", sessionCookie(token, SESSION_TTL_SECONDS, deps.secureCookie));
  }

  const ipKey = (req: Request) => `ip:${req.ip ?? "unknown"}`;

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const body = loginBody.safeParse(req.body);
      if (!body.success) {
        return sendError(res, 400, "VALIDATION_ERROR", "กรุณากรอกชื่อผู้ใช้และรหัสผ่าน");
      }
      const { username, password } = body.data;
      const userKey = `user:${username.toLowerCase()}`;
      const pairKey = `pair:${username.toLowerCase()}|${req.ip ?? "unknown"}`;
      const wait = Math.max(
        pairLimiter.retryAfterSeconds(pairKey),
        userLimiter.retryAfterSeconds(userKey),
        ipLimiter.retryAfterSeconds(ipKey(req)),
      );
      if (wait > 0) {
        res.setHeader("Retry-After", String(wait));
        return sendError(
          res,
          429,
          "TOO_MANY_ATTEMPTS",
          "พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่",
        );
      }

      const user = await deps.prisma.user.findUnique({ where: { username } });
      const valid = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
      if (!user || !user.isActive || !valid) {
        pairLimiter.recordFailure(pairKey);
        userLimiter.recordFailure(userKey);
        ipLimiter.recordFailure(ipKey(req));
        return sendError(res, 401, "INVALID_CREDENTIALS", BAD_LOGIN);
      }

      // Clear only this IP's counter: the per-username ceiling must not be resettable by one
      // successful login, or a guesser holding any valid account could keep resetting it.
      pairLimiter.reset(pairKey);
      await issueSession(res, user.id, user.passwordHash);
      return res.status(200).json({ user: publicUser(user) });
    }),
  );

  router.post("/logout", (_req, res) => {
    res.append("Set-Cookie", clearedSessionCookie(deps.secureCookie));
    res.status(204).end();
  });

  router.get("/me", deps.auth.authenticate, (req, res) => {
    const me = req.user!;
    res.status(200).json({
      user: {
        ...publicUser(me),
        borrowerId: me.borrowerId,
        // BORROWER only: the web app sends the user to the PDPA page while this is false.
        pdpaAccepted: me.role === "BORROWER" ? me.pdpaAcceptedAt !== null : null,
      },
    });
  });

  router.post(
    "/change-password",
    deps.auth.authenticate,
    asyncHandler(async (req, res) => {
      const body = changePasswordBody.safeParse(req.body);
      if (!body.success) {
        return sendError(res, 400, "VALIDATION_ERROR", "กรุณากรอกรหัสผ่านปัจจุบันและรหัสผ่านใหม่");
      }
      const { currentPassword, newPassword } = body.data;
      const me = req.user!;
      const key = `pw:${me.id}`;
      const wait = pairLimiter.retryAfterSeconds(key);
      if (wait > 0) {
        res.setHeader("Retry-After", String(wait));
        return sendError(res, 429, "TOO_MANY_ATTEMPTS", "พยายามผิดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่");
      }

      const violation = passwordPolicyViolation(newPassword);
      if (violation) return sendError(res, 400, "WEAK_PASSWORD", violation);

      const row = await deps.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
      if (!(await verifyPassword(currentPassword, row.passwordHash))) {
        pairLimiter.recordFailure(key);
        return sendError(res, 400, "INVALID_CURRENT_PASSWORD", "รหัสผ่านปัจจุบันไม่ถูกต้อง");
      }
      if (currentPassword === newPassword) {
        return sendError(res, 400, "SAME_PASSWORD", "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม");
      }

      pairLimiter.reset(key);
      const passwordHash = await hashPassword(newPassword);
      const updated = await deps.prisma.user.update({
        where: { id: me.id },
        data: { passwordHash, mustChangePassword: false },
      });
      // The old token carries the old password fingerprint, so issue a fresh one for this device.
      await issueSession(res, updated.id, updated.passwordHash);
      return res.status(200).json({ user: publicUser(updated) });
    }),
  );

  return router;
}
