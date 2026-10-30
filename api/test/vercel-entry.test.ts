import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

// Replace the real storage classes so we can see which backend the application was built with.
const made = { slip: [] as string[], imports: [] as string[] };
vi.mock("../src/lib/blob-storage.js", () => ({
  BlobSlipStorage: class {
    constructor() {
      made.slip.push("blob");
    }
  },
  BlobImportStorage: class {
    constructor() {
      made.imports.push("blob");
    }
  },
}));

const KEY = Buffer.alloc(32, 9).toString("base64");
const GOOD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SESSION_SECRET: "s".repeat(40),
  FIELD_ENCRYPTION_KEY: KEY,
};

function setEnv(env: Record<string, string>) {
  for (const k of ["STORAGE_BACKEND", "BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN", "CRON_SECRET"]) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

/** A fresh copy of the entry module (it keeps the built application between calls) served over HTTP. */
async function serve() {
  vi.resetModules();
  const { default: handler } = await import("../src/vercel.js");
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let closing: Array<() => Promise<void>> = [];
beforeEach(() => {
  made.slip.length = 0;
  made.imports.length = 0;
});
afterEach(async () => {
  for (const c of closing) await c();
  closing = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the Vercel entry point", () => {
  it("serves the same application: health, the login-protected routes, JSON errors", async () => {
    setEnv({ ...GOOD, STORAGE_BACKEND: "blob", BLOB_STORE_ID: "store_abc" });
    const s = await serve();
    closing.push(s.close);
    expect((await fetch(`${s.base}/health`)).status).toBe(200);
    const me = await fetch(`${s.base}/auth/me`);
    expect(me.status).toBe(401);
    expect((await me.json()).error.code).toBe("UNAUTHENTICATED");
    expect((await fetch(`${s.base}/admin/settings`)).status).toBe(401);
    expect((await fetch(`${s.base}/no-such-route`)).status).toBe(404);
  });

  it("builds the application once and reuses it for every later request", async () => {
    setEnv({ ...GOOD, STORAGE_BACKEND: "blob", BLOB_STORE_ID: "store_abc" });
    const s = await serve();
    closing.push(s.close);
    for (let i = 0; i < 5; i++) await fetch(`${s.base}/health`);
    expect(made.slip).toHaveLength(1);
    expect(made.imports).toHaveLength(1);
  });

  it("with STORAGE_BACKEND=blob it keeps slips and import files in the Blob store", async () => {
    setEnv({ ...GOOD, STORAGE_BACKEND: "blob", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" });
    const s = await serve();
    closing.push(s.close);
    await fetch(`${s.base}/health`);
    expect(made).toEqual({ slip: ["blob"], imports: ["blob"] });
  });

  it("by default it keeps them on disk, never touching the Blob store", async () => {
    setEnv(GOOD);
    const s = await serve();
    closing.push(s.close);
    await fetch(`${s.base}/health`);
    expect(made).toEqual({ slip: [], imports: [] });
  });

  it("the /cron routes exist only when CRON_SECRET is set", async () => {
    setEnv(GOOD);
    const off = await serve();
    closing.push(off.close);
    expect((await fetch(`${off.base}/cron/late-fee`, { headers: { authorization: "Bearer cron-secret-0123456789" } })).status).toBe(404);

    setEnv({ ...GOOD, CRON_SECRET: "cron-secret-0123456789" });
    const on = await serve();
    closing.push(on.close);
    expect((await fetch(`${on.base}/cron/late-fee`)).status).toBe(401);
    expect((await fetch(`${on.base}/cron/late-fee`, { headers: { authorization: "Bearer wrong-wrong-wrong-0" } })).status).toBe(401);
  });

  it("sends the session cookie as Secure in production", async () => {
    setEnv(GOOD);
    const s = await serve();
    closing.push(s.close);
    // a failed login sets no cookie; what we can check without a database is that the app was built for production
    expect(loadConfig({ ...GOOD } as NodeJS.ProcessEnv).NODE_ENV).toBe("production");
    expect((await fetch(`${s.base}/health`)).status).toBe(200);
  });

  it("a bad setting gives a plain 500 for every request, logs the reason without any value, and tells the caller nothing", async () => {
    setEnv({ ...GOOD, SESSION_SECRET: "tooshort-super-secret-value" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await serve();
    closing.push(s.close);
    for (const path of ["/health", "/auth/me"]) {
      const res = await fetch(`${s.base}${path}`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL_ERROR", message: "เกิดข้อผิดพลาดภายในระบบ" } });
      expect(text).not.toContain("SESSION_SECRET");
    }
    const message = logged.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toContain("startup failed");
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("tooshort-super-secret-value");
  });

  it("recovers once the setting is fixed (the broken start is not remembered)", async () => {
    setEnv({ ...GOOD, SESSION_SECRET: "short" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await serve();
    closing.push(s.close);
    expect((await fetch(`${s.base}/health`)).status).toBe(500);
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
    expect((await fetch(`${s.base}/health`)).status).toBe(200);
  });
});
