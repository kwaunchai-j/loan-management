import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { PDPA_VERSION } from "../src/auth/pdpa.js";
import { hashPassword } from "../src/lib/password.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t102${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

describe.skipIf(!dbUp)("PDPA gate (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const ids: Record<string, string> = {};

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  async function loginAs(user: string) {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name(user), password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return cookieOf(res);
  }
  const get = (path: string, cookie?: string) =>
    fetch(`${baseUrl}${path}`, { headers: cookie ? { cookie } : {} });
  const accept = (cookie: string | undefined, body: unknown = { version: PDPA_VERSION }) =>
    fetch(`${baseUrl}/pdpa/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    const mk = async (user: string, role: "ADMIN" | "BORROWER", extra: object = {}) => {
      const u = await prisma.user.create({ data: { username: name(user), role, ...base, ...extra } });
      ids[user] = u.id;
      return u;
    };
    await mk("admin", "ADMIN");
    await mk("noprofile", "BORROWER");
    await mk("mustchange", "BORROWER", { mustChangePassword: true });
    for (const user of ["a", "b", "done", "mustchange"]) {
      const u = user === "mustchange" ? { id: ids.mustchange! } : await mk(user, "BORROWER");
      const b = await prisma.borrower.create({
        data: {
          userId: u.id,
          fullName: `${marker} ${user}`,
          ...(user === "done"
            ? { pdpaAcceptedAt: new Date("2026-10-01T03:00:00Z"), pdpaVersion: "0-old" }
            : {}),
        },
      });
      ids[`borrower-${user}`] = b.id;
    }

    const built = buildApp({
      prisma,
      sessionSecret: SECRET,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
    });
    built.app.get("/_data", built.auth!.authorizeBorrower, (req, res) => {
      res.json({ borrowerId: req.user!.borrowerId });
    });
    server = built.app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.borrower.deleteMany({ where: { fullName: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it("keeps a borrower who has not accepted out of every borrower endpoint", async () => {
    const cookie = await loginAs("a");
    const res = await get("/_data", cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PDPA_REQUIRED");
  });

  it("reports the status on /pdpa and /auth/me", async () => {
    const cookie = await loginAs("a");
    expect(await (await get("/pdpa", cookie)).json()).toMatchObject({
      currentVersion: PDPA_VERSION,
      accepted: false,
      acceptedAt: null,
    });
    expect((await (await get("/auth/me", cookie)).json()).user.pdpaAccepted).toBe(false);
  });

  it("records time and version on acceptance and then opens the borrower endpoints", async () => {
    const cookie = await loginAs("a");
    const before = Date.now();
    const res = await accept(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, acceptedVersion: PDPA_VERSION });

    const row = await prisma.borrower.findUniqueOrThrow({ where: { id: ids["borrower-a"]! } });
    expect(row.pdpaVersion).toBe(PDPA_VERSION);
    expect(row.pdpaAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.pdpaAcceptedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const data = await get("/_data", cookie);
    expect(data.status).toBe(200);
    expect(await data.json()).toEqual({ borrowerId: ids["borrower-a"] });
    expect((await (await get("/auth/me", cookie)).json()).user.pdpaAccepted).toBe(true);
  });

  it("accepting again does not overwrite the original time or version", async () => {
    const cookie = await loginAs("done");
    expect((await get("/_data", cookie)).status).toBe(200);
    const res = await accept(cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acceptedAt).toBe("2026-10-01T03:00:00.000Z");
    expect(body.acceptedVersion).toBe("0-old");
  });

  it("rejects a missing or stale version and does not record anything", async () => {
    const cookie = await loginAs("b");
    expect((await accept(cookie, {})).status).toBe(400);
    const stale = await accept(cookie, { version: "999" });
    expect(stale.status).toBe(400);
    expect((await stale.json()).error.code).toBe("PDPA_VERSION_MISMATCH");
    const row = await prisma.borrower.findUniqueOrThrow({ where: { id: ids["borrower-b"]! } });
    expect(row.pdpaAcceptedAt).toBeNull();
  });

  it("only ever changes the logged-in borrower, ignoring ids from the client", async () => {
    const b = await loginAs("b");
    const res = await accept(b, { version: PDPA_VERSION, borrowerId: ids["borrower-done"] });
    expect(res.status).toBe(200);
    const other = await prisma.borrower.findUniqueOrThrow({ where: { id: ids["borrower-done"]! } });
    expect(other.pdpaVersion).toBe("0-old");
    const mine = await prisma.borrower.findUniqueOrThrow({ where: { id: ids["borrower-b"]! } });
    expect(mine.pdpaAcceptedAt).not.toBeNull();
  });

  it("requires login and a BORROWER account with a borrower profile", async () => {
    expect((await get("/pdpa")).status).toBe(401);
    expect((await accept(undefined)).status).toBe(401);

    const admin = await loginAs("admin");
    const asAdmin = await get("/pdpa", admin);
    expect(asAdmin.status).toBe(403);
    expect((await asAdmin.json()).error.code).toBe("FORBIDDEN");
    expect((await get("/_data", admin)).status).toBe(403);
    expect((await (await get("/auth/me", admin)).json()).user.pdpaAccepted).toBeNull();

    const noProfile = await loginAs("noprofile");
    const res = await get("/pdpa", noProfile);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_BORROWER_PROFILE");
    expect((await get("/_data", noProfile)).status).toBe(403);
  });

  it("still requires the first password change before the PDPA step", async () => {
    const cookie = await loginAs("mustchange");
    const res = await get("/pdpa", cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});
