import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** loadConfig(source) validates an environment object; these tests never touch the real process.env. */
const KEY = Buffer.alloc(32, 7).toString("base64");
const SECRET = "s".repeat(32);
const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db", SESSION_SECRET: SECRET, FIELD_ENCRYPTION_KEY: KEY };
const withEnv = (extra: Record<string, string | undefined> = {}) => ({ ...base, ...extra }) as NodeJS.ProcessEnv;
const VAPID = {
  VAPID_PUBLIC_KEY: "p".repeat(24),
  VAPID_PRIVATE_KEY: "k".repeat(24),
  VAPID_SUBJECT: "mailto:admin@example.com",
};

describe("loadConfig (environment validation)", () => {
  it("accepts the minimum environment and fills in the defaults", () => {
    const c = loadConfig(withEnv());
    expect(c).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      TZ: "Asia/Bangkok",
      TRUST_PROXY: 0,
      SLIP_STORAGE_DIR: "uploads/slips",
      SLIP_MAX_BYTES: 5 * 1024 * 1024,
      IMPORT_STORAGE_DIR: "uploads/imports",
      IMPORT_MAX_BYTES: 2 * 1024 * 1024,
    });
    expect(c.SCHEDULER_ENABLED).toBeUndefined();
    expect(c.LINE_CHANNEL_ACCESS_TOKEN).toBeUndefined();
  });

  it("turns numeric text into numbers", () => {
    const c = loadConfig(withEnv({ PORT: "8080", TRUST_PROXY: "2", SLIP_MAX_BYTES: "2048" }));
    expect(c).toMatchObject({ PORT: 8080, TRUST_PROXY: 2, SLIP_MAX_BYTES: 2048 });
  });

  it.each([
    ["DATABASE_URL", undefined],
    ["DATABASE_URL", ""],
    ["SESSION_SECRET", undefined],
    ["SESSION_SECRET", "s".repeat(31)],
    ["FIELD_ENCRYPTION_KEY", undefined],
    ["FIELD_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64")], // 16 bytes, not 32
    ["FIELD_ENCRYPTION_KEY", Buffer.alloc(33, 1).toString("base64")], // 33 bytes
    ["PORT", "0"],
    ["PORT", "abc"],
    ["TRUST_PROXY", "-1"],
    ["TRUST_PROXY", "11"],
    ["SLIP_MAX_BYTES", "100"], // below 1 KB
    ["SLIP_MAX_BYTES", String(51 * 1024 * 1024)], // above 50 MB
    ["IMPORT_MAX_BYTES", String(21 * 1024 * 1024)], // above 20 MB
    ["NODE_ENV", "staging"],
    ["LINE_CHANNEL_ACCESS_TOKEN", "short"],
    ["SCHEDULER_ENABLED", "yes"],
  ])("rejects %s = %j", (name, value) => {
    expect(() => loadConfig(withEnv({ [name]: value }))).toThrow(/Invalid environment/);
  });

  it("names every problem in one message, and never prints the value that was wrong", () => {
    let message = "";
    try {
      loadConfig({ SESSION_SECRET: "too-short-secret-value", FIELD_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("too-short-secret-value");
  });

  it("reads SCHEDULER_ENABLED as a real boolean", () => {
    expect(loadConfig(withEnv({ SCHEDULER_ENABLED: "true" })).SCHEDULER_ENABLED).toBe(true);
    expect(loadConfig(withEnv({ SCHEDULER_ENABLED: "false" })).SCHEDULER_ENABLED).toBe(false);
  });

  describe("a blank value means not set", () => {
    it("treats NAME= (empty) like a missing optional setting instead of rejecting it", () => {
      const c = loadConfig(withEnv({ LINE_CHANNEL_ACCESS_TOKEN: "", CRON_SECRET: "", BLOB_STORE_ID: "", VAPID_PUBLIC_KEY: "", PORT: "" }));
      expect(c.LINE_CHANNEL_ACCESS_TOKEN).toBeUndefined();
      expect(c.CRON_SECRET).toBeUndefined();
      expect(c.PORT).toBe(4000); // the default
    });

    it("a blank required setting is still missing, and named in the error", () => {
      for (const name of ["DATABASE_URL", "SESSION_SECRET", "FIELD_ENCRYPTION_KEY"]) {
        expect(() => loadConfig(withEnv({ [name]: "" }))).toThrow(new RegExp(name));
      }
    });
  });

  describe("where files are kept (STORAGE_BACKEND)", () => {
    it("is the disk unless asked otherwise", () => {
      expect(loadConfig(withEnv()).STORAGE_BACKEND).toBe("disk");
      expect(loadConfig(withEnv({ STORAGE_BACKEND: "disk" })).STORAGE_BACKEND).toBe("disk");
    });

    it("blob needs the store id (on Vercel) or a token, and says so when neither is there", () => {
      expect(() => loadConfig(withEnv({ STORAGE_BACKEND: "blob" }))).toThrow(/BLOB_STORE_ID.*BLOB_READ_WRITE_TOKEN/);
      expect(loadConfig(withEnv({ STORAGE_BACKEND: "blob", BLOB_STORE_ID: "store_abc" })).STORAGE_BACKEND).toBe("blob");
      expect(loadConfig(withEnv({ STORAGE_BACKEND: "blob", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).STORAGE_BACKEND).toBe("blob");
    });

    it("does not need Blob credentials while the disk is used", () => {
      expect(() => loadConfig(withEnv({ STORAGE_BACKEND: "disk" }))).not.toThrow();
    });

    it("accepts only disk or blob", () => {
      for (const bad of ["s3", "BLOB", "memory"]) expect(() => loadConfig(withEnv({ STORAGE_BACKEND: bad }))).toThrow(/STORAGE_BACKEND/);
    });
  });

  describe("CRON_SECRET (Vercel Cron)", () => {
    it("is optional, and when given must be long enough to be a secret", () => {
      expect(loadConfig(withEnv()).CRON_SECRET).toBeUndefined();
      expect(loadConfig(withEnv({ CRON_SECRET: "c".repeat(16) })).CRON_SECRET).toBe("c".repeat(16));
      expect(() => loadConfig(withEnv({ CRON_SECRET: "c".repeat(15) }))).toThrow(/CRON_SECRET must be at least 16/);
    });
  });

  describe("Web Push keys: all three or none", () => {
    it("accepts none and accepts all three (mailto or https subject)", () => {
      expect(loadConfig(withEnv()).VAPID_PUBLIC_KEY).toBeUndefined();
      expect(loadConfig(withEnv(VAPID)).VAPID_SUBJECT).toBe("mailto:admin@example.com");
      expect(loadConfig(withEnv({ ...VAPID, VAPID_SUBJECT: "https://loan.example.com" })).VAPID_SUBJECT).toBe("https://loan.example.com");
    });

    it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"])("refuses a partial set when %s is missing and says which one", (missing) => {
      const partial: Record<string, string | undefined> = { ...VAPID, [missing]: undefined };
      expect(() => loadConfig(withEnv(partial))).toThrow(new RegExp(`missing: ${missing}`));
    });

    it.each(["admin@example.com", "http://insecure.example.com", "mailto:", "ftp://x.example.com"])("refuses the subject %j", (subject) => {
      expect(() => loadConfig(withEnv({ ...VAPID, VAPID_SUBJECT: subject }))).toThrow(/VAPID_SUBJECT/);
    });
  });
});
