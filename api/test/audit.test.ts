import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildAuditDetail, toAuditJson, writeAuditLog, type AuditDb } from "../src/lib/audit.js";

function fakeDb() {
  const calls: Prisma.AuditLogCreateArgs[] = [];
  const db = {
    auditLog: {
      create: async (args: Prisma.AuditLogCreateArgs) => {
        calls.push(args);
        return { id: "x", createdAt: new Date(), actorId: null, detail: null, ...args.data };
      },
    },
  } as unknown as AuditDb;
  return { db, calls };
}

describe("toAuditJson", () => {
  it("keeps Decimal exact as a string and Date as ISO", () => {
    const out = toAuditJson({
      amount: new Prisma.Decimal("1234.50"),
      paidOn: new Date("2026-10-29T00:00:00.000Z"),
    });
    expect(out).toEqual({ amount: "1234.5", paidOn: "2026-10-29T00:00:00.000Z" });
  });

  it("drops undefined and returns null for null/undefined input", () => {
    expect(toAuditJson({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(toAuditJson(undefined)).toBeNull();
    expect(toAuditJson(null)).toBeNull();
  });

  it("redacts secrets at any depth but keeps harmless flags", () => {
    const out = toAuditJson({
      user: {
        username: "admin",
        passwordHash: "$argon2id$secret-hash",
        mustChangePassword: true,
      },
      list: [{ token: "abc", lineChannelSecret: "s", vapidPrivateKey: "k", auth: "a" }],
    });
    expect(out).toEqual({
      user: { username: "admin", passwordHash: "[REDACTED]", mustChangePassword: true },
      list: [
        { token: "[REDACTED]", lineChannelSecret: "[REDACTED]", vapidPrivateKey: "[REDACTED]", auth: "[REDACTED]" },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("argon2id");
  });
});

describe("bank account numbers in audit (decision D1)", () => {
  it("keeps only the last 4 digits at any depth", () => {
    const out = toAuditJson({
      before: { bankAccountNo: "123-4-56789-0", bankName: "ธนาคารตัวอย่าง" },
      list: [{ bankAccountNo: "0123456789" }],
    });
    expect(out).toEqual({
      before: { bankAccountNo: "****7890", bankName: "ธนาคารตัวอย่าง" },
      list: [{ bankAccountNo: "****6789" }],
    });
    expect(JSON.stringify(out)).not.toMatch(/56789|01234/);
  });

  it("leaves a null account number alone", () => {
    expect(toAuditJson({ bankAccountNo: null })).toEqual({ bankAccountNo: null });
  });
});

describe("buildAuditDetail", () => {
  it("combines before, after and extra", () => {
    expect(
      buildAuditDetail({
        before: { amount: new Prisma.Decimal("100") },
        after: { amount: new Prisma.Decimal("80") },
        extra: { contractEffect: { outstandingPrincipal: new Prisma.Decimal("20") } },
      }),
    ).toEqual({
      before: { amount: "100" },
      after: { amount: "80" },
      contractEffect: { outstandingPrincipal: "20" },
    });
  });

  it("has only `before` for deletes and only `after` for creates", () => {
    expect(buildAuditDetail({ before: { id: "p1" } })).toEqual({ before: { id: "p1" } });
    expect(buildAuditDetail({ after: { id: "p1" } })).toEqual({ after: { id: "p1" } });
  });

  it("is undefined when there is nothing to record", () => {
    expect(buildAuditDetail({})).toBeUndefined();
  });
});

describe("writeAuditLog (fake db)", () => {
  it("writes one row with actor, action, entity and detail", async () => {
    const { db, calls } = fakeDb();
    await writeAuditLog(db, {
      actorId: "u1",
      action: "payment.delete",
      entityType: "Payment",
      entityId: "p1",
      before: { id: "p1", amount: new Prisma.Decimal("300.00") },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toEqual({
      actorId: "u1",
      action: "payment.delete",
      entityType: "Payment",
      entityId: "p1",
      detail: { before: { id: "p1", amount: "300" } },
    });
  });

  it("allows a system actor (null)", async () => {
    const { db, calls } = fakeDb();
    await writeAuditLog(db, {
      actorId: null,
      action: "lateFee.backfill",
      entityType: "Contract",
      entityId: "c1",
    });
    expect(calls[0]?.data.actorId).toBeNull();
    expect(calls[0]?.data.detail).toBeUndefined();
  });

  it("rejects empty identifiers and reserved extra keys", async () => {
    const { db, calls } = fakeDb();
    const base = { actorId: "u1", action: "a", entityType: "T", entityId: "1" };
    await expect(writeAuditLog(db, { ...base, action: " " })).rejects.toThrow();
    await expect(writeAuditLog(db, { ...base, entityType: "" })).rejects.toThrow();
    await expect(writeAuditLog(db, { ...base, entityId: "" })).rejects.toThrow();
    await expect(writeAuditLog(db, { ...base, extra: { before: 1 } })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// Real-database checks run only when the dev Postgres is reachable (docker compose up -d).
const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

describe.skipIf(!dbUp)("writeAuditLog (PostgreSQL)", () => {
  const marker = `t104-${Date.now()}`;

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: marker } });
    await prisma.user.deleteMany({ where: { username: marker } });
    await prisma.$disconnect();
  });

  it("persists before/after JSON with a real actor and system actor", async () => {
    const user = await prisma.user.create({
      data: { username: marker, passwordHash: "not-a-real-hash", role: "ADMIN" },
    });

    await writeAuditLog(prisma, {
      actorId: user.id,
      action: "payment.update",
      entityType: marker,
      entityId: "p1",
      before: { amount: new Prisma.Decimal("300.00"), paidOn: new Date("2026-10-01T00:00:00Z") },
      after: { amount: new Prisma.Decimal("250.00"), paidOn: new Date("2026-10-02T00:00:00Z") },
      extra: { contractEffect: { status: "ACTIVE" } },
    });
    await writeAuditLog(prisma, {
      actorId: null,
      action: "job.run",
      entityType: marker,
      entityId: "p2",
    });

    const rows = await prisma.auditLog.findMany({
      where: { entityType: marker },
      orderBy: { entityId: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.actorId).toBe(user.id);
    expect(rows[0]?.detail).toEqual({
      before: { amount: "300", paidOn: "2026-10-01T00:00:00.000Z" },
      after: { amount: "250", paidOn: "2026-10-02T00:00:00.000Z" },
      contractEffect: { status: "ACTIVE" },
    });
    expect(rows[1]?.actorId).toBeNull();
    expect(rows[1]?.detail).toBeNull();
  });

  it("rolls back with the surrounding transaction", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await writeAuditLog(tx, {
          actorId: null,
          action: "payment.delete",
          entityType: marker,
          entityId: "rolled-back",
          before: { id: "p9" },
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(
      await prisma.auditLog.count({ where: { entityType: marker, entityId: "rolled-back" } }),
    ).toBe(0);
  });
});
