import type { NotificationChannel } from "@prisma/client";

/** What an admin receives. LINE gets the long text; Web Push (tiny payload limit) the short form. */
export interface RenderedMessage {
  line: string;
  push: { title: string; body: string; url: string };
}

/**
 * One delivery channel (LINE, Web Push). Recipients are the ADMIN account(s) only (DES-013); the
 * adapter looks them up itself. Adapters throw on failure and never put secrets in the message.
 */
export interface ChannelAdapter {
  channel: NotificationChannel;
  /** False when nothing can be delivered on this channel (no LINE id bound, no push subscription). */
  hasRecipients(): Promise<boolean>;
  /** Sends to every recipient; throws if it could not deliver to anyone. */
  send(message: RenderedMessage): Promise<void>;
}

export type DeliveryOutcome = "sent" | "failed" | "skipped" | "unavailable";
