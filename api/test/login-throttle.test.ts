import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp, type AppDeps } from "../src/app.js";
import type { LoginRateLimitOptions } from "../src/auth/routes.js";
import { hashPassword } from "../src/lib/password.js";
import { TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t2d${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;
const WRONG = "definitely-wrong-1";

interface Started {
  baseUrl: string;
  server: Server;
}

async function start(limits: Partial<LoginRateLimitOptions>, extra: Partial<AppDeps> = {}): Promise<Started> {
  const server = buildApp({
    prisma,
    sessionSecret: SECRET,
    fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
    loginRateLimit: {
      maxFailuresPerPair: 1000,
      maxFailuresPerUser: 1000,
      maxFailuresPerIp: 1000,
      windowMs: 60_000,
      ...limits,
    },
    ...extra,
  }).app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const stop = (s: Started) => new Promise<void>((resolve) => s.server.close(() => resolve()));

/** Log in from a pretend client address (only honoured when the app trusts one proxy). */
const login = (s: Started, username: string, password: string, ip?: string) =>
  fetch(`${s.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify({ username, password }),
  });

describe.skipIf(!dbUp)("login throttling (PostgreSQL)", () => {
  let behindProxy: Started; // pair 3, username ceiling 6
  let direct: Started; // pair 3, no proxy trusted
  let ipLimited: Started; // per-IP 3

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await prisma.user.createMany({
      data: ["owner", "ceiling", "reset", "other", "spray-a", "spray-b", "spray-c", "spoof", "pw"].map((u) => ({
        username: name(u),
        passwordHash,
        role: "ADMIN" as const,
        mustChangePassword: false,
      })),
    });
    behindProxy = await start({ maxFailuresPerPair: 3, maxFailuresPerUser: 6 }, { trustProxy: 1 });
    direct = await start({ maxFailuresPerPair: 3 });
    ipLimited = await start({ maxFailuresPerIp: 3 }, { trustProxy: 1 });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([stop(behindProxy), stop(direct), stop(ipLimited)]);
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it("stops a guesser on their own IP without locking the real owner out", async () => {
    const attacker = "10.0.0.1";
    for (let i = 0; i < 3; i++) {
      expect((await login(behindProxy, name("owner"), WRONG, attacker)).status).toBe(401);
    }
    const blocked = await login(behindProxy, name("owner"), PASSWORD, attacker);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // The owner, on another address, is not affected by the attacker's failures.
    expect((await login(behindProxy, name("owner"), PASSWORD, "10.0.0.2")).status).toBe(200);
  });

  it("still bounds a guess spread over many IPs with a higher per-username ceiling", async () => {
    for (const ip of ["10.1.0.1", "10.1.0.2"]) {
      for (let i = 0; i < 3; i++) {
        expect((await login(behindProxy, name("ceiling"), WRONG, ip)).status).toBe(401);
      }
    }
    // 6 failures in total: even a brand-new IP with the right password is refused now…
    const refused = await login(behindProxy, name("ceiling"), PASSWORD, "10.1.0.3");
    expect(refused.status).toBe(429);
    // …but other usernames from that IP are untouched.
    expect((await login(behindProxy, name("other"), PASSWORD, "10.1.0.3")).status).toBe(200);
  });

  it("does not let a successful login wipe the per-username ceiling", async () => {
    const fail = async (ip: string, times: number) => {
      for (let i = 0; i < times; i++) {
        expect((await login(behindProxy, name("reset"), WRONG, ip)).status).toBe(401);
      }
    };
    await fail("10.2.0.1", 2);
    expect((await login(behindProxy, name("reset"), PASSWORD, "10.2.0.9")).status).toBe(200);
    await fail("10.2.0.2", 2);
    await fail("10.2.0.3", 2);
    expect((await login(behindProxy, name("reset"), PASSWORD, "10.2.0.4")).status).toBe(429);
  });

  it("a success clears the counter of that username and IP only", async () => {
    const ip = "10.3.0.1";
    for (let i = 0; i < 2; i++) await login(behindProxy, name("pw"), WRONG, ip);
    expect((await login(behindProxy, name("pw"), PASSWORD, ip)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await login(behindProxy, name("pw"), WRONG, ip)).status).toBe(401);
    expect((await login(behindProxy, name("pw"), PASSWORD, ip)).status).toBe(200);
  });

  it("ignores X-Forwarded-For when no proxy is trusted, so it cannot be spoofed to dodge the limit", async () => {
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      expect((await login(direct, name("spoof"), WRONG, ip)).status).toBe(401);
    }
    const res = await login(direct, name("spoof"), PASSWORD, "4.4.4.4");
    expect(res.status).toBe(429);
  });

  it("limits password spraying from one IP across different usernames", async () => {
    const ip = "10.4.0.1";
    for (const u of ["spray-a", "spray-b", "spray-c"]) {
      expect((await login(ipLimited, name(u), WRONG, ip)).status).toBe(401);
    }
    expect((await login(ipLimited, name("owner"), PASSWORD, ip)).status).toBe(429);
    expect((await login(ipLimited, name("owner"), PASSWORD, "10.4.0.2")).status).toBe(200);
  });

  it("throttles wrong current-password guesses on change-password", async () => {
    const res = await login(direct, name("pw"), PASSWORD);
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
    const change = (currentPassword: string) =>
      fetch(`${direct.baseUrl}/auth/change-password`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ currentPassword, newPassword: "another-password-3" }),
      });
    for (let i = 0; i < 3; i++) expect((await change(WRONG)).status).toBe(400);
    const blocked = await change(PASSWORD);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
  });
});
