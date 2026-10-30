import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createPrisma } from "./db.js";
import { LocalDiskImportStorage } from "./imports/storage.js";
import { LocalDiskSlipStorage } from "./lib/slip-storage.js";
import { lateFeeJob } from "./jobs/late-fee-job.js";
import { notificationJobs } from "./jobs/notify-jobs.js";
import { createLineAdapter } from "./notifications/line.js";
import { Notifier } from "./notifications/service.js";
import { createVapidSender, createWebPushAdapter } from "./notifications/webpush.js";
import type { ChannelAdapter } from "./notifications/types.js";
import { Scheduler } from "./jobs/scheduler.js";

const config = loadConfig();
process.env.TZ = config.TZ;

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
const app = createApp({
  prisma,
  sessionSecret: config.SESSION_SECRET,
  secureCookie: config.NODE_ENV === "production",
  fieldEncryptionKey: config.FIELD_ENCRYPTION_KEY,
  trustProxy: config.TRUST_PROXY,
  slipStorage: new LocalDiskSlipStorage(config.SLIP_STORAGE_DIR),
  slipMaxBytes: config.SLIP_MAX_BYTES,
  importStorage: new LocalDiskImportStorage(config.IMPORT_STORAGE_DIR),
  importMaxBytes: config.IMPORT_MAX_BYTES,
  notifier,
  vapidPublicKey: config.VAPID_PUBLIC_KEY,
});
app.listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT}`);
});

// Exactly one process may run the scheduler (see SCHEDULER_ENABLED).
if (config.SCHEDULER_ENABLED ?? config.NODE_ENV === "production") {
  new Scheduler({ prisma, jobs: [lateFeeJob(prisma), ...notificationJobs(prisma, notifier)] }).start();
  console.log("scheduler started");
}
