import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { parsePeriod, PeriodError } from "../src/reports/period.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

describe("parsePeriod", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  it("understands a month, a year and a custom range, both ends included", () => {
    const m = parsePeriod({ month: "2024-02" });
    expect([m.kind, iso(m.from), iso(m.to)]).toEqual(["month", "2024-02-01", "2024-02-29"]); // leap year
    const dec = parsePeriod({ month: "2026-12" });
    expect([iso(dec.from), iso(dec.to)]).toEqual(["2026-12-01", "2026-12-31"]);
    const y = parsePeriod({ year: "2026" });
    expect([y.kind, iso(y.from), iso(y.to)]).toEqual(["year", "2026-01-01", "2026-12-31"]);
    const r = parsePeriod({ from: "2026-10-05", to: "2026-10-05" });
    expect([r.kind, iso(r.from), iso(r.to)]).toEqual(["range", "2026-10-05", "2026-10-05"]);
  });

  it("means all time when nothing is given", () => {
    expect(parsePeriod({}).kind).toBe("all");
  });

  it("rejects malformed, impossible, mixed or oversized periods", () => {
    for (const bad of [
      { month: "2026-13" },
      { month: "2026-1" },
      { month: "26-10" },
      { year: "26" },
      { year: "1969" },
      { from: "2026-10-01" },
      { to: "2026-10-01" },
      { from: "2026-10-02", to: "2026-10-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { month: "2026-10", year: "2026" },
      { month: "2026-10", from: "2026-10-01", to: "2026-10-31" },
      { from: "2000-01-01", to: "2026-01-01" },
    ]) {
      expect(() => parsePeriod(bad), JSON.stringify(bad)).toThrow(PeriodError);
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
const marker = `t5r${Date.now()}`;
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));

describe.skipIf(!dbUp)("reports (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const b: Record<string, string> = {}; // borrower ids
  const c: Record<string, string> = {}; // contract numbers
  let recorderId: string;
  let seq = 0;

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((r) => r.startsWith("loan_session="))!
      .split(";")[0]!;
  const get = (as: string | null, path: string) =>
    fetch(`${baseUrl}${path}`, { headers: as ? { cookie: cookies[as]! } : {} });
  const json = async (path: string) => {
    const res = await get("admin", path);
    expect(res.status, path).toBe(200);
    return res.json();
  };

  async function borrower(label: string, name?: string) {
    const x = await prisma.borrower.create({ data: { fullName: name ?? `${marker} ${label}` } });
    b[label] = x.id;
    return x;
  }

  /** A contract written straight to the database, plus its payments (with their allocation). */
  async function contract(
    label: string,
    o: {
      borrower: string;
      principal: string;
      interest: string;
      disbursed: string | null;
      due: string;
      status: "ACTIVE" | "CLOSED" | "AWAITING_DISBURSEMENT" | "CANCELLED";
      closedOn?: string;
      rate?: string;
      imported?: boolean;
      payments?: Array<{ amount: string; paidOn: string; fee?: string; int?: string; princ?: string }>;
    },
  ) {
    const paidOut = o.status === "ACTIVE" || o.status === "CLOSED";
    const created = await prisma.contract.create({
      data: {
        contractNo: `T-${marker}-${++seq}`,
        borrowerId: b[o.borrower]!,
        principal: o.principal,
        dueDate: D(o.due),
        status: o.status,
        disbursedOn: o.disbursed ? D(o.disbursed) : null,
        interestRatePctPerMonth: paidOut && !o.imported ? "3" : null,
        lateFeeRatePctPerDay: paidOut ? (o.rate ?? "1") : null,
        interestAmount: paidOut ? o.interest : null,
        outstandingPrincipal: o.status === "CLOSED" ? "0" : o.principal,
        outstandingInterest: o.status === "CLOSED" ? "0" : paidOut ? o.interest : "0",
        closedOn: o.closedOn ? D(o.closedOn) : null,
        isImported: o.imported ?? false,
      },
    });
    c[label] = created.contractNo;
    let n = 0;
    for (const p of o.payments ?? []) {
      await prisma.payment.create({
        data: {
          contractId: created.id,
          amount: p.amount,
          paidOn: D(p.paidOn),
          allocatedLateFee: p.fee ?? "0",
          allocatedInterest: p.int ?? "0",
          allocatedPrincipal: p.princ ?? "0",
          recordedById: recorderId,
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, ++n)),
        },
      });
    }
    return created;
  }

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"]] as const) {
      userIds.push((await prisma.user.create({ data: { username: `${marker}-${u}`, role, ...base } })).id);
    }
    recorderId = userIds[0]!;
    for (const l of ["X", "Y", "W"]) await borrower(l);

    // ---- 2020 data (absolute dates, far from anything real) ----
    await contract("C1", { borrower: "X", principal: "1000", interest: "100", disbursed: "2020-01-05", due: "2020-02-04", status: "CLOSED", closedOn: "2020-02-04", payments: [{ amount: "1100", paidOn: "2020-02-04", int: "100", princ: "1000" }] });
    // paid 2 days late: 1 % a day -> 22 + 23 (22.22 rounded up) = 45 of late fee
    await contract("C2", { borrower: "X", principal: "2000", interest: "200", disbursed: "2020-02-10", due: "2020-03-10", status: "CLOSED", closedOn: "2020-03-12", payments: [{ amount: "2245", paidOn: "2020-03-12", fee: "45", int: "200", princ: "2000" }] });
    // still unpaid; rate 0 keeps the numbers simple (no fee grows however long it stays open)
    await contract("C3", { borrower: "Y", principal: "3000", interest: "300", disbursed: "2020-04-20", due: "2020-05-20", status: "ACTIVE", rate: "0", payments: [{ amount: "100", paidOn: "2020-05-10", int: "100" }] });
    await contract("C4", { borrower: "Y", principal: "500", interest: "50", disbursed: "2020-05-15", due: "2020-06-15", status: "CLOSED", closedOn: "2020-06-01", payments: [{ amount: "550", paidOn: "2020-06-01", int: "50", princ: "500" }] });
    // imported (no payout date), unpaid
    await contract("C5", { borrower: "X", principal: "400", interest: "40", disbursed: null, due: "2020-12-31", status: "ACTIVE", rate: "0", imported: true });
    // never counted anywhere
    await contract("C6", { borrower: "X", principal: "999", interest: "0", disbursed: null, due: "2020-04-01", status: "AWAITING_DISBURSEMENT" });
    await contract("C7", { borrower: "X", principal: "888", interest: "0", disbursed: null, due: "2020-04-02", status: "CANCELLED" });
    // not yet due (borrower W)
    await contract("W1", { borrower: "W", principal: "700", interest: "70", disbursed: day(-5), due: day(30), status: "ACTIVE" });

    server = buildApp({
      prisma,
      sessionSecret: SECRET,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
    }).app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const u of ["admin", "borrower"]) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: `${marker}-${u}`, password: PASSWORD }),
      });
      cookies[u] = cookieOf(res);
    }
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const contracts = (await prisma.contract.findMany({ where: { borrower: { fullName: { startsWith: marker } } }, select: { id: true } })).map((x) => x.id);
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.borrower.deleteMany({ where: { fullName: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  // ===================================================================================
  describe("profit and loss (T-501)", () => {
    it("shows the cash and accrual bases side by side for a year", async () => {
      const r = await json("/admin/reports/profit-loss?year=2020");
      expect(r.period).toEqual({ kind: "year", from: "2020-01-01", to: "2020-12-31" });
      // cash: interest 100+200+100+50, late fee 45 — what was actually received and allocated
      expect(r.cash).toEqual({ interest: "450", lateFee: "45", total: "495", paymentCount: 4 });
      // accrual: the full interest of every contract that fell due in 2020 (incl. the imported one), late fee when received
      expect(r.accrual).toMatchObject({ interest: "690", lateFee: "45", total: "735", contractCount: 5, interestRecognisedThrough: "2020-12-31" });
    });

    it("matches the payments in the database exactly (cash basis = allocated interest + late fee)", async () => {
      const agg = await prisma.payment.aggregate({
        where: { paidOn: { gte: D("2020-01-01"), lte: D("2020-12-31") } },
        _sum: { allocatedInterest: true, allocatedLateFee: true },
      });
      const r = await json("/admin/reports/profit-loss?year=2020");
      expect(r.cash.interest).toBe(agg._sum.allocatedInterest!.toString());
      expect(r.cash.lateFee).toBe(agg._sum.allocatedLateFee!.toString());
    });

    it("recognises interest in full on the due date even if only part was paid (accrual vs cash differ)", async () => {
      const may = await json("/admin/reports/profit-loss?from=2020-05-01&to=2020-05-31");
      expect(may.cash).toMatchObject({ interest: "100", lateFee: "0", total: "100", paymentCount: 1 }); // C3 paid 100
      expect(may.accrual).toMatchObject({ interest: "300", total: "300", contractCount: 1 }); // C3 fell due: all 300
    });

    it("filters by month", async () => {
      const feb = await json("/admin/reports/profit-loss?month=2020-02");
      expect(feb.cash).toMatchObject({ interest: "100", total: "100" });
      expect(feb.accrual).toMatchObject({ interest: "100", contractCount: 1 });
      const mar = await json("/admin/reports/profit-loss?month=2020-03");
      expect(mar.cash).toMatchObject({ interest: "200", lateFee: "45", total: "245" });
      expect(mar.accrual).toMatchObject({ interest: "200", lateFee: "45", total: "245" });
    });

    it("counts a payment made on the last day of the period and on the first", async () => {
      const edge = await json("/admin/reports/profit-loss?from=2020-02-04&to=2020-03-12");
      expect(edge.cash.paymentCount).toBe(2); // 04 Feb and 12 Mar both included
      const before = await json("/admin/reports/profit-loss?from=2020-02-05&to=2020-03-11");
      expect(before.cash.paymentCount).toBe(0);
    });

    it("never counts contracts that were not paid out or were cancelled", async () => {
      const apr = await json("/admin/reports/profit-loss?month=2020-04");
      expect(apr.accrual.contractCount).toBe(0); // C6 (awaiting) and C7 (cancelled) fall due in April
      expect(apr.accrual.interest).toBe("0");
    });

    it("does not recognise interest before its due date has arrived", async () => {
      const future = await json(`/admin/reports/profit-loss?from=${day(1)}&to=${day(60)}`);
      expect(future.accrual.interest).toBe("0");
      expect(future.accrual.contractCount).toBe(0); // W1 falls due in 30 days: not income yet
      expect(future.accrual.interestRecognisedThrough).toBe(day(0));
      // a range that straddles today is cut at today
      const straddle = await json(`/admin/reports/profit-loss?from=${day(-1)}&to=${day(60)}`);
      expect(straddle.accrual.interestRecognisedThrough).toBe(day(0));
    });

    it("is zero for a period with no activity, and works for all time", async () => {
      const none = await json("/admin/reports/profit-loss?year=2019");
      expect(none.cash).toEqual({ interest: "0", lateFee: "0", total: "0", paymentCount: 0 });
      expect(none.accrual).toMatchObject({ interest: "0", total: "0", contractCount: 0 });
      const all = await json("/admin/reports/profit-loss");
      expect(all.period).toEqual({ kind: "all", from: null, to: null });
      expect(Number(all.cash.total)).toBeGreaterThanOrEqual(494.22);
    });
  });

  // ===================================================================================
  describe("late payers (T-502)", () => {
    it("ranks borrowers by how many contracts were late, counting unpaid overdue ones", async () => {
      const r = await json("/admin/reports/late-payers?year=2020&limit=200");
      // X: C2 (paid 2 days late) + C5 (imported, unpaid, past due). Y: C3 (unpaid, past due). C1 and C4 were on time.
      expect(r.items.map((i: { fullName: string; lateCount: number; rank: number }) => [i.rank, i.fullName, i.lateCount])).toEqual([
        [1, `${marker} X`, 2],
        [2, `${marker} Y`, 1],
      ]);
      expect(r.total).toBe(2);
      const x = r.items[0];
      expect(x.lateContracts).toEqual([
        { contractNo: c.C2, dueDate: "2020-03-10", closedOn: "2020-03-12", stillUnpaid: false, daysLate: 2 },
        { contractNo: c.C5, dueDate: "2020-12-31", closedOn: null, stillUnpaid: true, daysLate: Math.round((today.getTime() - D("2020-12-31").getTime()) / 86_400_000) },
      ]);
    });

    it("counts per contract: two late contracts of one borrower count twice", async () => {
      await borrower("Z");
      await contract("Z1", { borrower: "Z", principal: "100", interest: "10", disbursed: "2018-01-01", due: "2018-02-01", status: "CLOSED", closedOn: "2018-02-10", rate: "0", payments: [{ amount: "110", paidOn: "2018-02-10", int: "10", princ: "100" }] });
      await contract("Z2", { borrower: "Z", principal: "100", interest: "10", disbursed: "2018-01-01", due: "2018-03-01", status: "CLOSED", closedOn: "2018-03-05", rate: "0", payments: [{ amount: "110", paidOn: "2018-03-05", int: "10", princ: "100" }] });
      const r = await json("/admin/reports/late-payers?year=2018");
      expect(r.items).toHaveLength(1);
      expect(r.items[0]).toMatchObject({ fullName: `${marker} Z`, lateCount: 2 });
    });

    it("filters by the period the contracts fall due in", async () => {
      const mar = await json("/admin/reports/late-payers?month=2020-03");
      expect(mar.items.map((i: { fullName: string }) => i.fullName)).toEqual([`${marker} X`]);
      expect(mar.items[0].lateCount).toBe(1);
      expect((await json("/admin/reports/late-payers?year=2019")).items).toEqual([]);
    });

    it("breaks ties by name, and pages", async () => {
      await borrower("Q", `${marker} Bb`);
      await borrower("P", `${marker} Aa`);
      for (const l of ["Q", "P"]) {
        await contract(`${l}1`, { borrower: l, principal: "100", interest: "10", disbursed: "2017-01-01", due: "2017-02-01", status: "CLOSED", closedOn: "2017-02-05", payments: [{ amount: "110", paidOn: "2017-02-05", int: "10", princ: "100" }], rate: "0" });
      }
      const r = await json("/admin/reports/late-payers?year=2017");
      expect(r.items.map((i: { fullName: string }) => i.fullName)).toEqual([`${marker} Aa`, `${marker} Bb`]);
      const page2 = await json("/admin/reports/late-payers?year=2017&limit=1&offset=1");
      expect(page2.total).toBe(2);
      expect(page2.items.map((i: { fullName: string; rank: number }) => [i.rank, i.fullName])).toEqual([[2, `${marker} Bb`]]);
    });

    it("rejects a bad period or page", async () => {
      for (const q of ["month=2020-13", "year=20", "from=2020-01-01", "year=2020&month=2020-01", "limit=0", "limit=999", "offset=-1"]) {
        expect((await get("admin", `/admin/reports/late-payers?${q}`)).status, q).toBe(400);
      }
    });
  });

  // ===================================================================================
  describe("outstanding balance (T-502)", () => {
    it("is what is owed on the contracts open on that day, replayed from their own history", async () => {
      // C1 is open and owes 1,100 before it is paid on 4 Feb; after that nothing is open
      expect(await json("/admin/reports/outstanding?asOf=2020-02-03")).toMatchObject({ openContracts: 1, totalOutstanding: "1100", principal: "1000", interest: "100", lateFee: "0" });
      expect(await json("/admin/reports/outstanding?asOf=2020-02-04")).toMatchObject({ openContracts: 0, totalOutstanding: "0" });
      // C2 the day after it fell due: 2,200 + the 22 fee of that day (the next day adds 23: 2,222 -> 22.22 rounded up)
      expect(await json("/admin/reports/outstanding?asOf=2020-03-11")).toMatchObject({ openContracts: 1, totalOutstanding: "2222", principal: "2000", interest: "200", lateFee: "22" });
    });

    it("uses only the payments made up to that day", async () => {
      // 25 May: C3 owes 3,000 + (300-100) ; C4 (paid out 15 May, paid on 1 Jun) still owes 550; C2 is closed
      expect(await json("/admin/reports/outstanding?asOf=2020-05-25")).toMatchObject({ openContracts: 2, totalOutstanding: "3750" });
      // after C4 is paid
      expect(await json("/admin/reports/outstanding?asOf=2020-06-02")).toMatchObject({ openContracts: 1, totalOutstanding: "3200" });
    });

    it("counts an imported contract only from the day it was imported", async () => {
      const before = await json("/admin/reports/outstanding?asOf=2020-12-30");
      expect(before).toMatchObject({ openContracts: 1, totalOutstanding: "3200" }); // C5 did not exist yet
      const now = await json("/admin/reports/outstanding");
      expect(now.isToday).toBe(true);
      expect(now.asOf).toBe(day(0));
      expect(now.openContracts).toBeGreaterThanOrEqual(3); // C3, C5 and W1 at least
      expect(Number(now.totalOutstanding)).toBeGreaterThanOrEqual(3200 + 440 + 770);
    });

    it("reports a contract whose history breaks a rule instead of hiding it", async () => {
      await borrower("I");
      await contract("I1", { borrower: "I", principal: "100", interest: "10", disbursed: "2016-01-01", due: "2016-02-01", status: "ACTIVE", payments: [{ amount: "99999", paidOn: "2016-01-15" }] });
      const r = await json("/admin/reports/outstanding?asOf=2016-03-01");
      expect(r).toMatchObject({ openContracts: 0, totalOutstanding: "0", inconsistentContracts: 1 });
    });

    it("rejects a future or malformed date", async () => {
      for (const asOf of [day(1), "2020-02-30", "yesterday", "2020-2-3"]) {
        expect((await get("admin", `/admin/reports/outstanding?asOf=${asOf}`)).status, asOf).toBe(400);
      }
    });
  });

  // ===================================================================================
  describe("borrower summary (T-502)", () => {
    const row = (items: Array<{ fullName: string }>, label: string) => items.find((i) => i.fullName === `${marker} ${label}`);

    it("counts loans, late contracts, on-time payments, the on-time rate and what is owed", async () => {
      const r = await json("/admin/reports/borrower-summary?year=2020&limit=200");
      expect(row(r.items, "X")).toMatchObject({ loanCount: 3, lateCount: 2, paidOnTimeCount: 1, notYetDueCount: 0, onTimeRatePct: "33.3", outstanding: "440" });
      expect(row(r.items, "Y")).toMatchObject({ loanCount: 2, lateCount: 1, paidOnTimeCount: 1, notYetDueCount: 0, onTimeRatePct: "50.0", outstanding: "3200" });
      expect(r.items.map((i: { fullName: string }) => i.fullName).slice(0, 2)).toEqual([`${marker} X`, `${marker} Y`]);
    });

    it("leaves out contracts that were never paid out or were cancelled", async () => {
      const r = await json("/admin/reports/borrower-summary?month=2020-04&limit=200");
      expect(row(r.items, "X")).toBeUndefined(); // C6 and C7 fall due in April but never counted
    });

    it("filters by period", async () => {
      const jun = await json("/admin/reports/borrower-summary?month=2020-06&limit=200");
      expect(row(jun.items, "Y")).toMatchObject({ loanCount: 1, lateCount: 0, paidOnTimeCount: 1, onTimeRatePct: "100.0", outstanding: "0" });
      expect(row(jun.items, "X")).toBeUndefined();
    });

    it("has no verdict yet for a contract that is not due: neither on time nor late", async () => {
      const r = await json(`/admin/reports/borrower-summary?from=${day(0)}&to=${day(60)}&limit=200`);
      expect(row(r.items, "W")).toMatchObject({ loanCount: 1, lateCount: 0, paidOnTimeCount: 0, notYetDueCount: 1, onTimeRatePct: null, outstanding: "770" });
    });

    it("pages and rejects bad input", async () => {
      const p = await json("/admin/reports/borrower-summary?year=2020&limit=1&offset=1");
      expect(p.items).toHaveLength(1);
      expect(p.total).toBeGreaterThanOrEqual(2);
      expect((await get("admin", "/admin/reports/borrower-summary?month=bad")).status).toBe(400);
    });
  });

  // ===================================================================================
  describe("access", () => {
    it("is ADMIN only on every report", async () => {
      for (const path of ["profit-loss", "late-payers", "outstanding", "borrower-summary"]) {
        expect((await get("borrower", `/admin/reports/${path}?year=2020`)).status, path).toBe(403);
        expect((await get(null, `/admin/reports/${path}?year=2020`)).status, path).toBe(401);
      }
    });

    it("returns 400 with a reason for an invalid period", async () => {
      const res = await get("admin", "/admin/reports/profit-loss?month=2020-13");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_PERIOD");
    });
  });
});
