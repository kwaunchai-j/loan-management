import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { errorHandler } from "../src/http.js";
import { createCronRouter } from "../src/jobs/cron-routes.js";
import * as lateFee from "../src/jobs/late-fee-job.js";
import type { Notifier } from "../src/notifications/service.js";

/**
 * The /cron routes with no database: a stand-in that grants or refuses the advisory lock and has no contracts,
 * so every job finds nothing to do (the jobs themselves are tested against PostgreSQL in scheduler.test.ts and
 * notify-jobs.test.ts).
 */
const SECRET = "cron-secret-0123456789abcdef";

function fakeDb(opts: { locked?: boolean } = {}) {
  const findMany = vi.fn(async () => []);
  const tx = { $queryRaw: vi.fn(async () => [{ locked: opts.locked ?? true }]) };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)), contract: { findMany } } as unknown as Db;
  return { prisma, findMany, tx };
}

let server: Server;
let base: string;
const deliver = vi.fn(async () => ({}));

async function start(db: Db, notifier: Notifier | null = { deliver } as unknown as Notifier) {
  const app = express();
  app.use("/cron", createCronRouter({ prisma: db, secret: SECRET, notifier: notifier ?? undefined }));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cron`;
}
afterEach(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => deliver.mockClear());

const call = (path: string, authorization?: string, method = "GET") => fetch(`${base}${path}`, { method, headers: authorization === undefined ? {} : { authorization } });
const ok = `Bearer ${SECRET}`;
const PATHS = ["/late-fee", "/notify-due-today", "/notify-overdue"];

describe("the secret", () => {
  it.each(PATHS)("%s: no header, a wrong secret or a wrong scheme is refused (401) and nothing runs", async (path) => {
    const { prisma, findMany, tx } = fakeDb();
    await start(prisma);
    for (const bad of [undefined, "", "Bearer", "Bearer nope", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, SECRET, `bearer ${SECRET}`, `Basic ${SECRET}`, `Bearer  ${SECRET}`]) {
      const res = await call(path, bad);
      expect(res.status, JSON.stringify(bad)).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled(); // not even the lock was taken
    expect(deliver).not.toHaveBeenCalled();
  });

  it("the secret in the address does not count, and the answer never contains the secret", async () => {
    const { prisma, findMany } = fakeDb();
    await start(prisma);
    const res = await fetch(`${base}/late-fee?secret=${SECRET}&authorization=${encodeURIComponent(ok)}`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("only GET is accepted (that is what Vercel Cron sends); anything else is not a route", async () => {
    const { prisma, findMany } = fakeDb();
    await start(prisma);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await call("/late-fee", ok, method)).status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("/late-fee", () => {
  it("runs the nightly late-fee job and reports only counts", async () => {
    const { prisma, findMany } = fakeDb();
    await start(prisma);
    const res = await call("/late-fee", ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: "late-fee", ran: true, checked: 0, failed: 0 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "ACTIVE" }) }));
  });

  it("counts failed contracts, logs which ones, but never puts a contract id or reason in the answer", async () => {
    const { prisma } = fakeDb();
    vi.spyOn(lateFee, "runLateFeeJob").mockResolvedValueOnce({ checked: 3, failed: [{ contractId: "contract-secret-id", reason: "AMOUNT_EXCEEDS_DUE" }] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start(prisma);
    const res = await call("/late-fee", ok);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ job: "late-fee", ran: true, checked: 3, failed: 1 });
    expect(text).not.toContain("contract-secret-id");
    expect(text).not.toContain("AMOUNT_EXCEEDS_DUE");
    expect(errors).toHaveBeenCalledWith("late-fee: contract contract-secret-id failed: AMOUNT_EXCEEDS_DUE");
    errors.mockRestore();
  });

  it("does not run while another process holds the job's lock, and says so", async () => {
    const { prisma, findMany } = fakeDb({ locked: false });
    await start(prisma);
    const res = await call("/late-fee", ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: "late-fee", ran: false, checked: 0, failed: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a crash inside the job is a 500 with no detail (and Vercel will show the run as failed)", async () => {
    const { prisma, findMany } = fakeDb();
    findMany.mockRejectedValueOnce(new Error("connection to 10.0.0.5 refused, password=hunter2"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start(prisma);
    const res = await call("/late-fee", ok);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
    errors.mockRestore();
  });
});

describe("the notification rounds", () => {
  it.each(["/notify-due-today", "/notify-overdue"])("%s: with no contract that qualifies it sends nothing and says so", async (path) => {
    const { prisma, findMany } = fakeDb();
    await start(prisma);
    const res = await call(path, ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: path.slice(1), ran: true, contracts: 0, outcome: {} });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(["/notify-due-today", "/notify-overdue"])("%s: skips (without error) when no notifier is configured", async (path) => {
    const { prisma, findMany } = fakeDb();
    await start(prisma, null);
    const res = await call(path, ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: path.slice(1), ran: false, reason: "no notifier" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(["/notify-due-today", "/notify-overdue"])("%s: does not run while another process holds the lock", async (path) => {
    const { prisma, findMany } = fakeDb({ locked: false });
    await start(prisma);
    const body = await (await call(path, ok)).json();
    expect(body).toMatchObject({ ran: false, contracts: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("each job takes its own lock (a slow late-fee run does not block the notifications)", async () => {
    const { prisma, tx } = fakeDb();
    await start(prisma);
    for (const p of PATHS) await call(p, ok);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    const keys = tx.$queryRaw.mock.calls.map((c) => (c as unknown[]).slice(1).map(String).join(","));
    expect(new Set(keys).size).toBe(3);
  });
});
