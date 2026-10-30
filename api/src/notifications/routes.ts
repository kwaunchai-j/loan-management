import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, sendError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { renderTest } from "./messages.js";
import { isAllowedPushEndpoint, isValidSubscriptionKeys } from "./push-endpoint.js";
import type { ChannelAdapter } from "./types.js";

/**
 * Admin-only setup for the notification channels (T-402, T-403) plus a test button.
 *  - LINE: the admin binds their LINE user id by hand. (A "follow" webhook would let anyone who adds
 *    the Official Account overwrite it, so that needs a pairing step — an open question, Q1.)
 *  - Web Push: the browser registers its subscription; the VAPID public key is served to it.
 */
const lineBody = z.object({ lineUserId: z.string().trim().regex(/^U[0-9a-f]{32}$/, "LINE user id ต้องขึ้นต้นด้วย U ตามด้วยเลขฐานสิบหก 32 ตัว") });
const subscribeBody = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
const unsubscribeBody = z.object({ endpoint: z.string().min(1).max(2048) });

export function createNotificationSetupRouter(deps: {
  prisma: Db;
  auth: AuthMiddleware;
  adapters: ChannelAdapter[];
  vapidPublicKey?: string;
}): Router {
  const router = Router();
  const admin = deps.auth.authorize("ADMIN");
  const { prisma } = deps;

  const mask = (id: string | null) => (id ? `${id.slice(0, 2)}…${id.slice(-4)}` : null);

  router.get(
    "/line-binding",
    admin,
    asyncHandler(async (req, res) => {
      const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { lineUserId: true } });
      res.status(200).json({ bound: me.lineUserId !== null, lineUserId: mask(me.lineUserId) });
    }),
  );

  router.put(
    "/line-binding",
    admin,
    asyncHandler(async (req, res) => {
      const body = lineBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", body.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      await prisma.$transaction(async (tx) => {
        const before = await tx.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { lineUserId: true } });
        await tx.user.update({ where: { id: req.user!.id }, data: { lineUserId: body.data.lineUserId } });
        await writeAuditLog(tx, {
          actorId: req.user!.id,
          action: "user.lineBinding.set",
          entityType: "User",
          entityId: req.user!.id,
          before: { lineUserId: mask(before.lineUserId) },
          after: { lineUserId: mask(body.data.lineUserId) },
        });
      });
      res.status(200).json({ bound: true, lineUserId: mask(body.data.lineUserId) });
    }),
  );

  router.delete(
    "/line-binding",
    admin,
    asyncHandler(async (req, res) => {
      await prisma.$transaction(async (tx) => {
        const before = await tx.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { lineUserId: true } });
        await tx.user.update({ where: { id: req.user!.id }, data: { lineUserId: null } });
        await writeAuditLog(tx, {
          actorId: req.user!.id,
          action: "user.lineBinding.clear",
          entityType: "User",
          entityId: req.user!.id,
          before: { lineUserId: mask(before.lineUserId) },
        });
      });
      res.status(200).json({ bound: false, lineUserId: null });
    }),
  );

  router.get("/push/public-key", admin, (_req, res) => {
    if (!deps.vapidPublicKey) {
      return sendError(res, 503, "PUSH_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า Web Push บนเซิร์ฟเวอร์ (VAPID)");
    }
    res.status(200).json({ publicKey: deps.vapidPublicKey });
  });

  router.post(
    "/push-subscriptions",
    admin,
    asyncHandler(async (req, res) => {
      const body = subscribeBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "ข้อมูลการสมัครรับแจ้งเตือนไม่ถูกต้อง");
      const { endpoint, keys } = body.data;
      if (!isAllowedPushEndpoint(endpoint)) {
        return sendError(res, 400, "PUSH_ENDPOINT_NOT_ALLOWED", "ที่อยู่ของบริการแจ้งเตือนนี้ไม่ได้รับอนุญาต");
      }
      if (!isValidSubscriptionKeys(keys.p256dh, keys.auth)) {
        return sendError(res, 400, "VALIDATION_ERROR", "กุญแจของการสมัครรับแจ้งเตือนไม่ถูกต้อง");
      }
      // The same browser re-subscribing (or another account on it) simply takes over the endpoint.
      await prisma.pushSubscription.upsert({
        where: { endpoint },
        create: { userId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
        update: { userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth },
      });
      res.status(201).json({ subscribed: true });
    }),
  );

  router.delete(
    "/push-subscriptions",
    admin,
    asyncHandler(async (req, res) => {
      const body = unsubscribeBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาระบุ endpoint");
      // only the caller's own subscription can be removed
      const removed = await prisma.pushSubscription.deleteMany({ where: { endpoint: body.data.endpoint, userId: req.user!.id } });
      if (removed.count === 0) return sendError(res, 404, "NOT_FOUND", "ไม่พบการสมัครรับแจ้งเตือนนี้");
      res.status(200).json({ subscribed: false });
    }),
  );

  // "Test send" button: goes straight to the channels, is not logged and not de-duplicated.
  router.post(
    "/notifications/test",
    admin,
    asyncHandler(async (_req, res) => {
      const message = renderTest();
      const result: Record<string, string> = {};
      for (const adapter of deps.adapters) {
        if (!(await adapter.hasRecipients())) {
          result[adapter.channel] = "no_recipient";
          continue;
        }
        try {
          await adapter.send(message);
          result[adapter.channel] = "sent";
        } catch (err) {
          result[adapter.channel] = `failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`;
        }
      }
      res.status(200).json(result);
    }),
  );

  return router;
}
