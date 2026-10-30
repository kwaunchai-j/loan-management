import webpush from "web-push";
import type { Db } from "../db.js";
import type { ChannelAdapter, RenderedMessage } from "./types.js";

/**
 * Web Push channel (T-403) to the ADMIN's registered browsers/PWAs. VAPID keys come from env only.
 * A subscription the push service reports as gone (404/410) is deleted; other errors are failures
 * that the central service retries.
 */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSender {
  send(target: PushTarget, payload: string): Promise<void>;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** "mailto:..." or an https URL identifying the sender to push services. */
  subject: string;
}

export function createVapidSender(vapid: VapidConfig): PushSender {
  return {
    async send(target, payload) {
      await webpush.sendNotification(target, payload, {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 60 * 60,
        urgency: "high",
        timeout: 10_000,
      });
    },
  };
}

const isGone = (err: unknown) => {
  const code = (err as { statusCode?: number } | null)?.statusCode;
  return code === 404 || code === 410;
};

export function createWebPushAdapter(opts: { prisma: Db; sender: PushSender }): ChannelAdapter {
  const subscriptions = () =>
    opts.prisma.pushSubscription.findMany({
      where: { user: { role: "ADMIN", isActive: true } },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

  return {
    channel: "WEB_PUSH",
    async hasRecipients() {
      return (await subscriptions()).length > 0;
    },
    async send(message: RenderedMessage) {
      const subs = await subscriptions();
      if (subs.length === 0) throw new Error("no push subscription is registered");
      const payload = JSON.stringify(message.push);
      let delivered = 0;
      let lastError: unknown = null;
      for (const s of subs) {
        try {
          await opts.sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          delivered++;
        } catch (err) {
          if (isGone(err)) {
            await opts.prisma.pushSubscription.deleteMany({ where: { id: s.id } });
            lastError = new Error("push subscription expired and was removed");
          } else {
            const code = (err as { statusCode?: number } | null)?.statusCode;
            lastError = new Error(`web push failed${code ? ` with HTTP ${code}` : ""}`);
          }
        }
      }
      if (delivered === 0) throw lastError instanceof Error ? lastError : new Error("web push failed");
    },
  };
}
