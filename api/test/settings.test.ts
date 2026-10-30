import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { asyncHandler, errorHandler } from "../src/http.js";
import { hashPassword } from "../src/lib/password.js";
import { getRates, requireRates, RatesNotSetError, SETTING_ID, type RatesDb } from "../src/lib/rates.js";

const D = (v: string) => new Prisma.Decimal(v);

function fakeSettingDb(row: { interestRatePctPerMonth: Prisma.Decimal | null; lateFeeRatePctPerDay: Prisma.Decimal | null } | null) {
  return { setting: { findUnique: async () => row } } as unknown as RatesDb;
}

describe("requireRates (no database)", () => {
  it("throws when there is no row or either rate is null", async () => {
    await expect(requireRates(fakeSettingDb(null))).rejects.toBeInstanceOf(RatesNotSetError);
    await expect(
      requireRates(fakeSettingDb({ interestRatePctPerMonth: D("2.5"), lateFeeRatePctPerDay: null })),
    ).rejects.toBeInstanceOf(RatesNotSetError);
    await expect(
      requireRates(fakeSettingDb({ interestRatePctPerMonth: null, lateFeeRatePctPerDay: D("0.5") })),
    ).rejects.toBeInstanceOf(RatesNotSetError);
  });

  it("returns both rates, treating 0 as set", async () => {
    const rates = await requireRates(
      fakeSettingDb({ interestRatePctPerMonth: D("0"), lateFeeRatePctPerDay: D("0.5") }),
    );
    expect(rates.interestRatePctPerMonth.toString()).toBe("0");
    expect(rates.lateFeeRatePctPerDay.toString()).toBe("0.5");
  });

  it("getRates reports nulls for a missing row", async () => {
    expect(await getRates(fakeSettingDb(null))).toEqual({
      interestRatePctPerMonth: null,
      lateFeeRatePctPerDay: null,
    });
  });
});

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t105${Date.now()}`;
const name = (s: string) => `${marker}-${s}`;

describe.skipIf(!dbUp)("admin settings (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  let adminCookie: string;
  let borrowerCookie: string;
  let adminId: string;
  // The Setting row is global; keep whatever a developer had and put it back afterwards.
  let original: Awaited<ReturnType<typeof prisma.setting.findUnique>>;

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  const call = (method: string, path: string, body?: unknown, cookie: string = adminCookie) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const patch = (body: unknown) => call("PATCH", "/admin/settings", body);
  const stored = () => prisma.setting.findUnique({ where: { id: SETTING_ID } });
  const clearRow = () => prisma.setting.deleteMany({ where: { id: SETTING_ID } });

  async function login(username: string) {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return cookieOf(res);
  }

  beforeAll(async () => {
    original = await prisma.setting.findUnique({ where: { id: SETTING_ID } });
    await clearRow();

    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    const admin = await prisma.user.create({ data: { username: name("admin"), role: "ADMIN", ...base } });
    adminId = admin.id;
    await prisma.user.create({ data: { username: name("borrower"), role: "BORROWER", ...base } });

    const built = buildApp({
      prisma,
      sessionSecret: SECRET,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
    });
    // What disbursement/import will do: call requireRates and let the error handler answer.
    built.app.post(
      "/_money",
      built.auth!.authorize("ADMIN"),
      asyncHandler(async (_req, res) => {
        const rates = await requireRates(prisma);
        res.json({ interest: rates.interestRatePctPerMonth.toString() });
      }),
    );
    built.app.use(errorHandler);
    server = built.app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    adminCookie = await login(name("admin"));
    borrowerCookie = await login(name("borrower"));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await clearRow();
    if (original) {
      await prisma.setting.create({
        data: {
          id: SETTING_ID,
          interestRatePctPerMonth: original.interestRatePctPerMonth,
          lateFeeRatePctPerDay: original.lateFeeRatePctPerDay,
          updatedById: original.updatedById,
        },
      });
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it("is for ADMIN only", async () => {
    expect((await call("GET", "/admin/settings", undefined, "")).status).toBe(401);
    expect((await call("GET", "/admin/settings", undefined, borrowerCookie)).status).toBe(403);
    const res = await call("PATCH", "/admin/settings", { interestRatePctPerMonth: "9" }, borrowerCookie);
    expect(res.status).toBe(403);
    expect(await stored()).toBeNull();
  });

  it("reports both rates as null until an admin sets them", async () => {
    const res = await call("GET", "/admin/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      interestRatePctPerMonth: null,
      lateFeeRatePctPerDay: null,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("refuses money operations (409 RATES_NOT_SET) until both rates exist", async () => {
    let res = await call("POST", "/_money", {});
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("RATES_NOT_SET");

    await patch({ interestRatePctPerMonth: "2.5" });
    res = await call("POST", "/_money", {});
    expect(res.status).toBe(409);

    await patch({ lateFeeRatePctPerDay: "0.5" });
    res = await call("POST", "/_money", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interest: "2.5" });
    await clearRow();
  });

  it("sets both rates, stores them exactly and records who and when", async () => {
    const res = await patch({ interestRatePctPerMonth: "2.5", lateFeeRatePctPerDay: "0.1234" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      interestRatePctPerMonth: "2.5",
      lateFeeRatePctPerDay: "0.1234",
      updatedBy: { id: adminId, username: name("admin") },
    });
    expect(body.updatedAt).not.toBeNull();

    const row = (await stored())!;
    expect(row.interestRatePctPerMonth!.toString()).toBe("2.5");
    expect(row.lateFeeRatePctPerDay!.toString()).toBe("0.1234");
    expect(row.updatedById).toBe(adminId);
    expect(await (await call("GET", "/admin/settings")).json()).toMatchObject({
      interestRatePctPerMonth: "2.5",
      lateFeeRatePctPerDay: "0.1234",
    });
  });

  it("lets requireRates read the stored rates as exact Decimals", async () => {
    const rates = await requireRates(prisma);
    expect(rates.interestRatePctPerMonth.toString()).toBe("2.5");
    expect(rates.lateFeeRatePctPerDay.toString()).toBe("0.1234");
  });

  it("changes one rate and leaves the other, with a before/after audit row", async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    const res = await patch({ interestRatePctPerMonth: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.1234" });

    const rows = await prisma.auditLog.findMany({ where: { entityType: "Setting", actorId: adminId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "setting.update", entityId: String(SETTING_ID) });
    expect(rows[0]!.detail).toEqual({
      before: { interestRatePctPerMonth: "2.5", lateFeeRatePctPerDay: "0.1234" },
      after: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "0.1234" },
    });
  });

  it("accepts 0 as a real rate and the largest value the column holds", async () => {
    const res = await patch({ interestRatePctPerMonth: "0", lateFeeRatePctPerDay: "999.9999" });
    expect(res.status).toBe(200);
    const rates = await requireRates(prisma);
    expect(rates.interestRatePctPerMonth.toString()).toBe("0");
    expect(rates.lateFeeRatePctPerDay.toString()).toBe("999.9999");
  });

  it("rejects invalid rates and changes nothing", async () => {
    await patch({ interestRatePctPerMonth: "2.5", lateFeeRatePctPerDay: "0.5" });
    const bad: unknown[] = [
      {},
      { interestRatePctPerMonth: null },
      { interestRatePctPerMonth: "-1" },
      { interestRatePctPerMonth: -0.5 },
      { interestRatePctPerMonth: "abc" },
      { interestRatePctPerMonth: "" },
      { interestRatePctPerMonth: "1.23456" },
      { interestRatePctPerMonth: "1000" },
      { interestRatePctPerMonth: "1e2" },
      { interestRatePctPerMonth: 1e21 },
      { lateFeeRatePctPerDay: { value: 1 } },
      { unknownField: "1" },
    ];
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    for (const body of bad) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    }
    const row = (await stored())!;
    expect(row.interestRatePctPerMonth!.toString()).toBe("2.5");
    expect(row.lateFeeRatePctPerDay!.toString()).toBe("0.5");
    expect(await prisma.auditLog.count({ where: { actorId: adminId } })).toBe(0);
  });
});
