import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/password.js";
import {
  detectSlipType,
  isValidSlipKey,
  LocalDiskSlipStorage,
  newSlipKey,
} from "../src/lib/slip-storage.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const jpeg = (extra = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(extra)]);
const png = (extra = 64) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(extra)]);

describe("detectSlipType", () => {
  it("recognises JPEG and PNG by their bytes", () => {
    expect(detectSlipType(jpeg())?.mime).toBe("image/jpeg");
    expect(detectSlipType(png())?.mime).toBe("image/png");
  });

  it("rejects everything else, whatever it is called", () => {
    for (const bad of [
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]),
      Buffer.from("GIF89a....."),
      Buffer.from("%PDF-1.7 ..."),
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      Buffer.from("MZ\x90\x00 pretend this is photo.jpg"),
      Buffer.from("<?php echo 1; ?>"),
    ]) {
      expect(detectSlipType(bad)).toBeNull();
    }
  });
});

describe("slip keys", () => {
  it("accepts only keys we generate", () => {
    expect(isValidSlipKey(newSlipKey({ ext: "jpg", mime: "image/jpeg" }))).toBe(true);
    expect(isValidSlipKey(newSlipKey({ ext: "png", mime: "image/png" }))).toBe(true);
    for (const bad of [
      "",
      "../secret.jpg",
      "..\\secret.png",
      "a/b.jpg",
      `${"a".repeat(32)}.gif`,
      `${"A".repeat(32)}.jpg`,
      `${"a".repeat(31)}.jpg`,
      `${"a".repeat(33)}.jpg`,
      `${"a".repeat(32)}.jpg.exe`,
      `${"a".repeat(32)}.jpg\n`,
      "test-slip",
    ]) {
      expect(isValidSlipKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("are random and never repeat", () => {
    const type = { ext: "jpg", mime: "image/jpeg" } as const;
    expect(newSlipKey(type)).not.toBe(newSlipKey(type));
  });
});

describe("LocalDiskSlipStorage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slip-unit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new LocalDiskSlipStorage(path.join(dir, "nested", "slips"));

  it("stores and returns bytes, creating the folder on demand", async () => {
    const key = newSlipKey({ ext: "png", mime: "image/png" });
    const data = png(200);
    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, data);
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.get(key))!.equals(data)).toBe(true);
  });

  it("never overwrites an existing slip", async () => {
    const key = newSlipKey({ ext: "jpg", mime: "image/jpeg" });
    await storage.put(key, jpeg());
    await expect(storage.put(key, jpeg())).rejects.toThrow();
  });

  it("answers null/false for unknown keys and refuses to touch the disk for invalid ones", async () => {
    expect(await storage.get(`${"b".repeat(32)}.jpg`)).toBeNull();
    expect(await storage.exists(`${"b".repeat(32)}.jpg`)).toBe(false);
    for (const bad of ["../../etc/passwd", "..\\..\\windows\\win.ini", `${"b".repeat(32)}/../x.jpg`]) {
      expect(await storage.get(bad)).toBeNull();
      expect(await storage.exists(bad)).toBe(false);
      await expect(storage.put(bad, jpeg())).rejects.toThrow("invalid slip key");
    }
  });
});

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t203${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

describe.skipIf(!dbUp)("slip upload and download (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  let tinyServer: Server; // 1 KB limit
  let tinyUrl: string;
  const cookies: Record<string, string> = {};

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  async function listen(maxBytes?: number) {
    const s = buildApp({
      prisma,
      sessionSecret: SECRET,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      slipMaxBytes: maxBytes,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
    }).app.listen(0);
    await new Promise<void>((resolve) => s.once("listening", () => resolve()));
    return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }

  const upload = (as: string | null, body: BodyInit, contentType = "application/octet-stream", url = baseUrl) =>
    fetch(`${url}/admin/slips`, {
      method: "POST",
      headers: { "content-type": contentType, ...(as ? { cookie: cookies[as]! } : {}) },
      body,
    });
  const download = (as: string | null, key: string) =>
    fetch(`${baseUrl}/admin/slips/${key}`, { headers: as ? { cookie: cookies[as]! } : {} });

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    await prisma.user.create({ data: { username: name("admin"), role: "ADMIN", ...base } });
    const bu = await prisma.user.create({ data: { username: name("borrower"), role: "BORROWER", ...base } });
    await prisma.borrower.create({ data: { userId: bu.id, fullName: `${marker} b`, pdpaAcceptedAt: new Date() } });

    const main = await listen();
    server = main.server;
    baseUrl = main.url;
    const tiny = await listen(1024);
    tinyServer = tiny.server;
    tinyUrl = tiny.url;

    for (const u of ["admin", "borrower"]) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name(u), password: PASSWORD }),
      });
      cookies[u] = cookieOf(res);
    }
    // the tiny app has its own app instance but shares the secret, so the same cookie works there
  }, 60_000);

  afterAll(async () => {
    await Promise.all([server, tinyServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
    await prisma.borrower.deleteMany({ where: { fullName: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it("stores an uploaded JPEG under a server-chosen key and serves the same bytes back", async () => {
    const data = jpeg(500);
    const res = await upload("admin", data, "image/jpeg");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slipFileKey).toMatch(/^[a-f0-9]{32}\.jpg$/);
    expect(body).toMatchObject({ contentType: "image/jpeg", size: data.length });
    expect((await TEST_SLIP_STORAGE.get(body.slipFileKey))!.equals(data)).toBe(true);

    const got = await download("admin", body.slipFileKey);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(data)).toBe(true);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(got.headers.get("cache-control")).toContain("no-store");
  });

  it("accepts PNG too, and the same bytes never get the same key twice", async () => {
    const data = png(300);
    const a = await (await upload("admin", data, "image/png")).json();
    const b = await (await upload("admin", data, "image/png")).json();
    expect(a.slipFileKey).toMatch(/\.png$/);
    expect(a.slipFileKey).not.toBe(b.slipFileKey);
  });

  it("decides the type from the bytes, not from what the client claims", async () => {
    for (const [body, claimed] of [
      [Buffer.from("<svg onload=alert(1)>"), "image/png"],
      [Buffer.from("MZ not an image"), "image/jpeg"],
      [Buffer.from("%PDF-1.7"), "application/pdf"],
    ] as const) {
      const res = await upload("admin", body, claimed);
      expect(res.status).toBe(415);
      expect((await res.json()).error.code).toBe("UNSUPPORTED_FILE_TYPE");
    }
    // a real JPEG labelled as something else is still a JPEG
    expect((await upload("admin", jpeg(), "text/plain")).status).toBe(201);
  });

  it("rejects empty bodies and JSON bodies as 'no file'", async () => {
    const empty = await upload("admin", new Uint8Array(0));
    expect(empty.status).toBe(400);
    const json = await upload("admin", JSON.stringify({ a: 1 }), "application/json");
    expect(json.status).toBe(400);
    expect((await json.json()).error.code).toBe("NO_FILE");
  });

  it("refuses files over the size limit (413)", async () => {
    const res = await upload("admin", jpeg(4000), "image/jpeg", tinyUrl);
    expect(res.status).toBe(413);
    expect((await upload("admin", jpeg(200), "image/jpeg", tinyUrl)).status).toBe(201);
  });

  it("is ADMIN only for both upload and download", async () => {
    const key = (await (await upload("admin", jpeg(), "image/jpeg")).json()).slipFileKey as string;
    expect((await upload("borrower", jpeg(), "image/jpeg")).status).toBe(403);
    expect((await upload(null, jpeg(), "image/jpeg")).status).toBe(401);
    expect((await download("borrower", key)).status).toBe(403);
    expect((await download(null, key)).status).toBe(401);
  });

  it("answers 404 for unknown keys and path-traversal attempts", async () => {
    expect((await download("admin", `${"c".repeat(32)}.jpg`)).status).toBe(404);
    for (const bad of ["..%2F..%2Fetc%2Fpasswd", "%2e%2e%2fsecret.jpg", "not-a-key", `${"a".repeat(32)}.exe`]) {
      expect((await download("admin", bad)).status, bad).toBe(404);
    }
  });
});
