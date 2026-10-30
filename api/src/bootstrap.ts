import { createApp } from "./app.js";
import type { Env } from "./config.js";
import { createPrisma } from "./db.js";
import { LocalDiskImportStorage } from "./imports/storage.js";
import { BlobImportStorage, BlobSlipStorage } from "./lib/blob-storage.js";
import { LocalDiskSlipStorage } from "./lib/slip-storage.js";
import { createLineAdapter } from "./notifications/line.js";
import { Notifier } from "./notifications/service.js";
import type { ChannelAdapter } from "./notifications/types.js";
import { createVapidSender, createWebPushAdapter } from "./notifications/webpush.js";

/**
 * Builds the real application from the validated environment. Shared by the long-running server
 * (index.ts) and the Vercel function (vercel.ts), so both are wired the same way.
 */
export function createServices(config: Env) {
  const prisma = createPrisma();

  // Admin notification channels: each one is used only if its credentials are configured.
  const adapters: ChannelAdapter[] = [];
  if (config.LINE_CHANNEL_ACCESS_TOKEN) {
    adapters.push(createLineAdapter({ prisma, accessToken: config.LINE_CHANNEL_ACCESS_TOKEN }));
  }
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT) {
    adapters.push(
      createWebPushAdapter({
        prisma,
        sender: createVapidSender({
          publicKey: config.VAPID_PUBLIC_KEY,
          privateKey: config.VAPID_PRIVATE_KEY,
          subject: config.VAPID_SUBJECT,
        }),
      }),
    );
  }
  const notifier = new Notifier({ prisma, adapters });

  const blob = config.STORAGE_BACKEND === "blob";
  const app = createApp({
    prisma,
    sessionSecret: config.SESSION_SECRET,
    secureCookie: config.NODE_ENV === "production",
    fieldEncryptionKey: config.FIELD_ENCRYPTION_KEY,
    trustProxy: config.TRUST_PROXY,
    slipStorage: blob ? new BlobSlipStorage() : new LocalDiskSlipStorage(config.SLIP_STORAGE_DIR),
    slipMaxBytes: config.SLIP_MAX_BYTES,
    importStorage: blob ? new BlobImportStorage() : new LocalDiskImportStorage(config.IMPORT_STORAGE_DIR),
    importMaxBytes: config.IMPORT_MAX_BYTES,
    notifier,
    vapidPublicKey: config.VAPID_PUBLIC_KEY,
    cronSecret: config.CRON_SECRET,
  });
  return { app, prisma, notifier };
}
