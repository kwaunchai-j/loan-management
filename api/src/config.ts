import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TZ: z.string().default("Asia/Bangkok"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "FIELD_ENCRYPTION_KEY must be 32 random bytes encoded as base64",
    }),
  // Number of reverse proxies in front of the API (0 = none). Needed for the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  // Where transfer slips are stored (a folder on the Thai server). Swap via env, no code change.
  SLIP_STORAGE_DIR: z.string().min(1).default("uploads/slips"),
  SLIP_MAX_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(5 * 1024 * 1024),
  // Where an uploaded import file waits between "preview" and "confirm", and the largest accepted file.
  IMPORT_STORAGE_DIR: z.string().min(1).default("uploads/imports"),
  IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(2 * 1024 * 1024),
  // LINE Official Account (Messaging API) channel access token. Without it LINE is not used.
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(20).optional(),
  // Web Push (VAPID). All three or none: `npm run vapid:generate` creates the key pair.
  VAPID_PUBLIC_KEY: z.string().min(20).optional(),
  VAPID_PRIVATE_KEY: z.string().min(20).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:.+@.+|https:\/\/.+)$/, "VAPID_SUBJECT must be mailto:you@example.com or an https URL")
    .optional(),
  // Runs the nightly jobs (late fees, later notifications) in THIS process. Enable it on exactly
  // one instance. Default: on in production, off elsewhere.
  SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  // Where slips and staged import files are kept: "disk" (a folder, the default) or "blob" (a PRIVATE
  // Vercel Blob store: on Vercel the disk of a function is read-only and lost between calls).
  STORAGE_BACKEND: z.enum(["disk", "blob"]).default("disk"),
  // Credentials for the Blob store, read by the Blob SDK itself: on Vercel the store id (OIDC), elsewhere a token.
  BLOB_STORE_ID: z.string().min(1).optional(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  // Vercel Cron calls /cron/* with "Authorization: Bearer <this>". Without it those routes do not exist.
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").optional(),
});

const vapidKeys = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

export type Env = z.infer<typeof envSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Env {
  // A blank value (NAME= or an empty box in a dashboard) means "not set", not "an empty string".
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const set = vapidKeys.filter((k) => parsed.data[k] !== undefined);
  if (set.length > 0 && set.length < vapidKeys.length) {
    throw new Error(`Invalid environment: set all of ${vapidKeys.join(", ")} or none (missing: ${vapidKeys.filter((k) => parsed.data[k] === undefined).join(", ")})`);
  }
  if (parsed.data.STORAGE_BACKEND === "blob" && !parsed.data.BLOB_STORE_ID && !parsed.data.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Invalid environment: STORAGE_BACKEND=blob needs BLOB_STORE_ID (on Vercel) or BLOB_READ_WRITE_TOKEN");
  }
  return parsed.data;
}
