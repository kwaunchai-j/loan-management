import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { commitImport } from "../src/imports/commit.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { csvBytes, HEADER_ROW, windows874Bytes, xlsxBytes, type FixtureCell } from "./import-fixtures.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t6i${Date.now()}`;
const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));

const EXISTING = `${marker} มีอยู่แล้ว`;
const DUP = `${marker} ชื่อซ้ำ`;
const NEWBIE = `${marker} คนใหม่`;

describe.skipIf(!dbUp)("importing contracts from a file (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  let smallServer: Server;
  let smallUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const b: Record<string, string> = {};
  let originalSetting: Awaited<ReturnType<typeof prisma.setting.findUnique>>;
  let adminId: string;

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("loan_session="))!
      .split(";")[0]!;

  const api = (as: string | null, method: string, path: string, opts: { json?: unknown; raw?: Buffer; url?: string } = {}) =>
    fetch(`${opts.url ?? baseUrl}${path}`, {
      method,
      headers: {
        ...(opts.raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }),
        ...(as ? { cookie: cookies[as]! } : {}),
      },
      body: opts.raw ? new Uint8Array(opts.raw) : opts.json === undefined ? undefined : JSON.stringify(opts.json),
    });
  const preview = (raw: Buffer, as: string | null = "admin", url?: string) => api(as, "POST", "/admin/imports/preview?fileName=C%3A%5Cfakepath%5Cold%20loans.csv", { raw, url });
  const commit = (json: unknown, as: string | null = "admin") => api(as, "POST", "/admin/imports/commit", { json });

  /** The standard good file: an existing borrower (overdue), a new one twice (one blank interest), an ambiguous name. */
  const goodRows = (): FixtureCell[][] => [
    HEADER_ROW,
    [EXISTING, 1000, 100, day(-3)],
    [`  ${NEWBIE}  `, 2000, null, day(30)],
    [NEWBIE, 500, 50, day(10)],
    [DUP, 700, 70, day(5)],
  ];

  const contractsOf = (batchId: string) => prisma.contract.findMany({ where: { importBatchId: batchId }, orderBy: { contractNo: "asc" } });
  const counts = async () => ({
    contracts: await prisma.contract.count({ where: { borrower: { fullName: { startsWith: marker } } } }),
    borrowers: await prisma.borrower.count({ where: { fullName: { startsWith: marker } } }),
    batches: await prisma.importBatch.count({ where: { importedById: adminId } }),
  });

  beforeAll(async () => {
    originalSetting = await prisma.setting.findUnique({ where: { id: 1 } });
    await prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "1" },
      update: { interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "1" },
    });
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, mustChangePassword: false };
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"]] as const) {
      userIds.push((await prisma.user.create({ data: { username: `${marker}-${u}`, role, ...base } })).id);
    }
    adminId = userIds[0]!;
    b.existing = (await prisma.borrower.create({ data: { fullName: EXISTING } })).id;
    b.dup1 = (await prisma.borrower.create({ data: { fullName: DUP, phone: "081-111-1111" } })).id;
    await new Promise((r) => setTimeout(r, 15)); // distinct createdAt, so the candidate order is stable
    b.dup2 = (await prisma.borrower.create({ data: { fullName: DUP, phone: "082-222-2222" } })).id;

    const mk = async (maxBytes?: number) => {
      const s = buildApp({
        prisma,
        sessionSecret: SECRET,
        fieldEncryptionKey: TEST_FIELD_KEY,
        slipStorage: TEST_SLIP_STORAGE,
        importStorage: TEST_IMPORT_STORAGE,
        importMaxBytes: maxBytes,
        loginRateLimit: RELAXED_LOGIN_LIMITS,
      }).app.listen(0);
      await new Promise<void>((resolve) => s.once("listening", () => resolve()));
      return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    const main = await mk();
    server = main.server;
    baseUrl = main.url;
    const small = await mk(2048);
    smallServer = small.server;
    smallUrl = small.url;
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
    await Promise.all([server, smallServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
    const borrowers = (await prisma.borrower.findMany({ where: { fullName: { startsWith: marker } }, select: { id: true } })).map((x) => x.id);
    const contracts = (await prisma.contract.findMany({ where: { borrowerId: { in: borrowers } }, select: { id: true } })).map((x) => x.id);
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.lateFeeAccrual.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.importBatch.deleteMany({ where: { importedById: adminId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowers } } });
    await prisma.setting.deleteMany({ where: { id: 1 } });
    if (originalSetting) {
      await prisma.setting.create({
        data: { id: 1, interestRatePctPerMonth: originalSetting.interestRatePctPerMonth, lateFeeRatePctPerDay: originalSetting.lateFeeRatePctPerDay, updatedById: originalSetting.updatedById },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  // ===================================================================================
  describe("template and access", () => {
    it("serves the template: the header only, UTF-8 with a BOM", async () => {
      const res = await api("admin", "GET", "/admin/imports/template");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const bytes = Buffer.from(await res.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.subarray(3).toString("utf8")).toBe("ชื่อผู้ยืม,จำนวนเงิน,ดอกเบี้ย,วันครบกำหนด\r\n");
    });

    it("is ADMIN only on every endpoint", async () => {
      const calls: Array<[string, string, { json?: unknown; raw?: Buffer }]> = [
        ["GET", "/admin/imports/template", {}],
        ["POST", "/admin/imports/preview", { raw: csvBytes(goodRows()) }],
        ["POST", "/admin/imports/commit", { json: { importKey: "x" } }],
        ["GET", "/admin/imports", {}],
        ["POST", "/admin/imports/anything/rollback", {}],
      ];
      for (const [method, path, opts] of calls) {
        expect((await api("borrower", method, path, opts)).status, `${method} ${path}`).toBe(403);
        expect((await api(null, method, path, opts)).status, `${method} ${path}`).toBe(401);
      }
    });
  });

  // ===================================================================================
  describe("preview (T-601): nothing is saved", () => {
    it("checks every row, matches borrowers, and shows the late fee that would be back-dated", async () => {
      const before = await counts();
      const res = await preview(csvBytes(goodRows(), { bom: true }));
      expect(res.status).toBe(200);
      const p = await res.json();

      expect(p.importKey).toMatch(/^[a-f0-9]{32}\.csv$/);
      expect(p.fileName).toBe("old loans.csv"); // only the file's own name, never a path
      expect(p.ratesReady).toBe(true);
      expect(p.canCommit).toBe(true);
      expect(p.summary).toMatchObject({
        rows: 4,
        validRows: 4,
        invalidRows: 0,
        borrowers: 3,
        newBorrowers: 1,
        existingBorrowers: 1,
        ambiguousBorrowers: 1,
        principal: "4200",
        interest: "220",
        lateFee: "35",
        lateDays: 3,
      });

      const [r1, r2, r3, r4] = p.rows;
      expect(r1).toMatchObject({ rowNumber: 2, name: EXISTING, amount: "1000", interest: "100", valid: true, daysOverdue: 3, lateFee: "35", match: { status: "EXISTING", borrowerId: b.existing } });
      expect(r2).toMatchObject({ rowNumber: 3, name: NEWBIE, interest: "0", match: { status: "NEW" }, lateFee: "0" }); // spaces tidied, blank interest = 0
      expect(r3.match).toEqual({ status: "NEW" });
      expect(r4.match.status).toBe("AMBIGUOUS");

      // the ambiguous name must be chosen: candidates carry enough to tell them apart
      expect(p.needsChoice).toHaveLength(1);
      expect(p.needsChoice[0]).toMatchObject({ name: DUP, rowNumbers: [5] });
      expect(p.needsChoice[0].candidates.map((c: { borrowerId: string; phone: string }) => [c.borrowerId, c.phone])).toEqual([[b.dup1, "081-111-1111"], [b.dup2, "082-222-2222"]]);
      expect(JSON.stringify(p)).not.toMatch(/bankAccount|bankName/);

      // the file waits on the server under that key, and nothing else was written
      expect(await TEST_IMPORT_STORAGE.get(p.importKey)).not.toBeNull();
      expect(await counts()).toEqual(before);
    });

    it("lists invalid rows with their reasons and does not count them", async () => {
      const p = await (
        await preview(
          csvBytes([
            HEADER_ROW,
            ["", 100, 0, day(5)],
            [`${marker} ก`, 0, 0, day(5)],
            [`${marker} ข`, 100, -1, day(5)],
            [`${marker} ค`, 100, 0, "not a date"],
            [`${marker} ง`, 100, 0, day(5)],
          ]),
        )
      ).json();
      expect(p.summary).toMatchObject({ rows: 5, validRows: 1, invalidRows: 4, principal: "100" });
      expect(p.hasInvalidRows).toBe(true);
      expect(p.rows.map((r: { valid: boolean }) => r.valid)).toEqual([false, false, false, false, true]);
      expect(p.rows[0].errors).toContain("ชื่อผู้ยืมว่าง");
      expect(p.rows[1].errors.join()).toMatch(/จำนวนเงินต้องมากกว่า 0/);
      expect(p.rows[2].errors.join()).toMatch(/ดอกเบี้ยต้องไม่ติดลบ/);
      expect(p.rows[3].errors.join()).toMatch(/วันครบกำหนดไม่ถูกต้อง/);
    });

    it("matches names exactly after tidying spaces, and the same name on many rows is one borrower", async () => {
      const p = await (await preview(csvBytes([HEADER_ROW, [`   ${EXISTING.replace(" ", "   ")}  `, 100, 0, day(5)], [EXISTING + "x", 100, 0, day(5)], [EXISTING, 200, 0, day(6)]]))).json();
      expect(p.rows[0].match).toEqual({ status: "EXISTING", borrowerId: b.existing });
      expect(p.rows[1].match).toEqual({ status: "NEW" }); // a different name is not a near-match
      expect(p.rows[2].match).toEqual({ status: "EXISTING", borrowerId: b.existing });
      expect(p.summary).toMatchObject({ existingBorrowers: 1, newBorrowers: 1 });
    });

    it("reads an .xlsx with real date cells just like a CSV", async () => {
      const p = await (await preview(xlsxBytes([HEADER_ROW, [EXISTING, 1000, 100, addDays(today, -3)], [`${marker} xlsx`, 250.75, 0, addDays(today, 40)]]))).json();
      expect(p.importKey).toMatch(/\.xlsx$/);
      expect(p.rows.map((r: { amount: string; dueDate: string; valid: boolean }) => [r.amount, r.dueDate, r.valid])).toEqual([["1000", day(-3), true], ["250.75", day(40), true]]);
      expect(p.rows[0].lateFee).toBe("35");
    });

    it("reads a Thai Windows 'CSV' (Windows-874) correctly", async () => {
      const text = `ชื่อผู้ยืม,จำนวนเงิน,ดอกเบี้ย,วันครบกำหนด\r\nสมชาย ทดสอบ,1500,0,${day(20)}\r\n`;
      const p = await (await preview(windows874Bytes(text))).json();
      expect(p.rows[0].name).toBe("สมชาย ทดสอบ");
      expect(p.rows[0].valid).toBe(true);
    });

    it("cannot compute late fees until the rates are set, and says so", async () => {
      await prisma.setting.update({ where: { id: 1 }, data: { lateFeeRatePctPerDay: null } });
      try {
        const p = await (await preview(csvBytes(goodRows()))).json();
        expect(p.ratesReady).toBe(false);
        expect(p.canCommit).toBe(false);
        expect(p.summary.lateFee).toBeNull();
        expect(p.rows[0].lateFee).toBeNull();
        expect(p.rows[0].daysOverdue).toBe(3);
      } finally {
        await prisma.setting.update({ where: { id: 1 }, data: { lateFeeRatePctPerDay: "1" } });
      }
    });

    it("flags a row whose back-dated late fee would overflow the system, instead of failing later", async () => {
      // 1 % a day compounding from year 2001 is far beyond 999,999,999,999.99
      const p = await (await preview(csvBytes([HEADER_ROW, [`${marker} old`, 100000, 0, "2001-01-01"], [`${marker} fine`, 100, 0, day(5)]]))).json();
      expect(p.rows[0].valid).toBe(false);
      expect(p.rows[0].errors.join()).toMatch(/เกินขีดจำกัด/);
      expect(p.rows[1].valid).toBe(true);
    });

    it("refuses a file that is not the template, empty, not a file, too big, or the old .xls", async () => {
      const wrongHeader = await preview(csvBytes([["Name", "Amount"], ["x", 1]]));
      expect(wrongHeader.status).toBe(400);
      expect((await wrongHeader.json()).error.code).toBe("INVALID_FILE");
      expect((await preview(csvBytes([HEADER_ROW]))).status).toBe(400); // header only
      expect((await preview(Buffer.alloc(0))).status).toBe(400);
      const json = await api("admin", "POST", "/admin/imports/preview", { json: { a: 1 } });
      expect(json.status).toBe(400);
      expect((await json.json()).error.code).toBe("NO_FILE");
      expect((await preview(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).status).toBe(400);
      expect((await preview(csvBytes(goodRows()), "admin", smallUrl)).status).toBe(200); // fits in 2 KB
      const big = csvBytes([HEADER_ROW, ...Array.from({ length: 200 }, (_, i) => [`${marker} คนที่ ${i}`, 100, 0, day(5)])]);
      expect(big.length).toBeGreaterThan(2048);
      expect((await preview(big, "admin", smallUrl)).status).toBe(413);
    });

    it("refuses a decompression bomb disguised as .xlsx", async () => {
      const { zipSync } = await import("fflate");
      const bomb = Buffer.from(zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(30 * 1024 * 1024) }));
      const res = await preview(bomb);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/ใหญ่ผิดปกติ/);
    });
  });

  // ===================================================================================
  describe("confirming (T-602): one transaction, nothing trusted from the browser", () => {
    async function stage(rows = goodRows()) {
      return (await (await preview(csvBytes(rows))).json()).importKey as string;
    }

    it("imports the rows as ACTIVE imported contracts and saves the late fee of the overdue one", async () => {
      const importKey = await stage();
      const before = await counts();
      const res = await commit({ importKey, fileName: "old loans.csv", choices: { [DUP]: b.dup2 } });
      expect(res.status).toBe(201);
      const r = await res.json();
      expect(r).toMatchObject({ contractsCreated: 4, borrowersCreated: 1, borrowersLinked: 2, skippedRows: 0, totalPrincipal: "4200", totalInterest: "220", lateFeeBackfilled: "35", lateFeeRows: 3 });

      const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: r.batchId } });
      expect(batch).toMatchObject({ fileName: "old loans.csv", importedById: adminId, rowCount: 4, status: "COMPLETED", rolledBackAt: null });

      const contracts = await contractsOf(r.batchId);
      expect(contracts).toHaveLength(4);
      const by = Object.fromEntries(contracts.map((c) => [c.principal.toString(), c]));
      // every contract is an imported ACTIVE one with no payout and no request; interest comes from the FILE
      for (const c of contracts) {
        expect(c).toMatchObject({ status: "ACTIVE", isImported: true, disbursedOn: null, loanRequestId: null, interestRatePctPerMonth: null, closedOn: null });
        expect(c.contractNo).toMatch(/^LN-\d{4}-\d{6}$/);
        expect(c.lateFeeRatePctPerDay!.toString()).toBe("1"); // snapshot of the Setting at import
        expect(c.outstandingPrincipal.equals(c.principal)).toBe(true);
      }
      expect(by["1000"]!.interestAmount!.toString()).toBe("100");
      expect(by["2000"]!.interestAmount!.toString()).toBe("0"); // blank = 0 (the 3 %/month rate is NOT applied)
      expect(by["500"]!.interestAmount!.toString()).toBe("50");
      expect(by["1000"]!.outstandingInterest.toString()).toBe("100");
      expect(new Set(contracts.map((c) => c.contractNo)).size).toBe(4);
      expect(await prisma.disbursement.count({ where: { contractId: { in: contracts.map((c) => c.id) } } })).toBe(0);

      // borrowers: the existing one linked, the new name created ONCE (no login), the chosen duplicate used
      expect(by["1000"]!.borrowerId).toBe(b.existing);
      expect(by["2000"]!.borrowerId).toBe(by["500"]!.borrowerId);
      const created = await prisma.borrower.findUniqueOrThrow({ where: { id: by["2000"]!.borrowerId } });
      expect(created).toMatchObject({ fullName: NEWBIE, userId: null });
      expect(by["700"]!.borrowerId).toBe(b.dup2);
      expect(await counts()).toEqual({ contracts: before.contracts + 4, borrowers: before.borrowers + 1, batches: before.batches + 1 });

      // the overdue contract carries its back-dated fees, and the admin read side agrees to the satang
      const overdue = by["1000"]!;
      expect(await prisma.lateFeeAccrual.count({ where: { contractId: overdue.id } })).toBe(3);
      expect(overdue.dueDate.getTime()).toBe(addDays(today, -3).getTime());
      const detail = await (await api("admin", "GET", `/admin/contracts/${overdue.id}`)).json();
      expect(detail.contract).toMatchObject({ isImported: true, accruedLateFee: "35", totalDue: "1135", isOverdue: true, daysOverdue: 3, inconsistent: false });
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: overdue.id } })).accruedLateFee.toFixed(2)).toBe("35.00");
      // the contracts that are not yet due have none
      expect(await prisma.lateFeeAccrual.count({ where: { contractId: by["2000"]!.id } })).toBe(0);

      // the staged file is gone, and the audit trail has the batch
      expect(await TEST_IMPORT_STORAGE.get(importKey)).toBeNull();
      const [audit] = await prisma.auditLog.findMany({ where: { entityType: "ImportBatch", entityId: r.batchId, action: "import.commit" } });
      expect(audit!.actorId).toBe(adminId);
      expect(audit!.detail).toMatchObject({ fileName: "old loans.csv", contractsCreated: 4, lateFeeRows: 3 });
    });

    it("keeps the late-fee rate it saw at import: changing the Setting later changes nothing", async () => {
      const importKey = await stage([HEADER_ROW, [`${marker} snapshot`, 1000, 100, day(-2)]]);
      const r = await (await commit({ importKey })).json();
      await prisma.setting.update({ where: { id: 1 }, data: { lateFeeRatePctPerDay: "9" } });
      try {
        const [c] = await contractsOf(r.batchId);
        expect(c!.lateFeeRatePctPerDay!.toString()).toBe("1");
        expect(c!.accruedLateFee.toFixed(2)).toBe("23.00"); // 11 + 12 (1,111 -> 11.11 rounded up)
      } finally {
        await prisma.setting.update({ where: { id: 1 }, data: { lateFeeRatePctPerDay: "1" } });
      }
    });

    it("will not guess between several borrowers with the same name, and keeps the file so you can choose", async () => {
      const importKey = await stage();
      const before = await counts();
      const none = await commit({ importKey });
      expect(none.status).toBe(409);
      expect((await none.json()).error.code).toBe("AMBIGUOUS_BORROWER_NOT_CHOSEN");
      // choosing a borrower who is not one of the candidates is refused too
      const wrong = await commit({ importKey, choices: { [DUP]: b.existing } });
      expect(wrong.status).toBe(409);
      expect(await counts()).toEqual(before); // nothing at all was saved
      expect(await TEST_IMPORT_STORAGE.get(importKey)).not.toBeNull();
      expect((await commit({ importKey, choices: { [DUP]: b.dup1 } })).status).toBe(201);
    });

    it("refuses to skip invalid rows silently, and imports only the valid ones when told to", async () => {
      const rows: FixtureCell[][] = [HEADER_ROW, [`${marker} ok1`, 100, 0, day(5)], ["", 100, 0, day(5)], [`${marker} ok2`, 0, 0, day(5)], [`${marker} ok3`, 300, 30, day(6)]];
      const importKey = await stage(rows);
      const before = await counts();
      const refused = await commit({ importKey });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe("INVALID_ROWS_PRESENT");
      expect(await counts()).toEqual(before);
      const ok = await commit({ importKey, skipInvalidRows: true });
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({ contractsCreated: 2, skippedRows: 2, totalPrincipal: "400" });
    });

    it("refuses a file with no valid row", async () => {
      const importKey = await stage([HEADER_ROW, ["", 100, 0, day(5)]]);
      const res = await commit({ importKey, skipInvalidRows: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("NO_VALID_ROWS");
    });

    it("refuses while the rates are not set, saving nothing", async () => {
      const importKey = await stage();
      await prisma.setting.update({ where: { id: 1 }, data: { lateFeeRatePctPerDay: null } });
      const before = await counts();
      try {
        const res = await commit({ importKey, choices: { [DUP]: b.dup1 } });
        expect(res.status).toBe(409);
        expect((await res.json()).error.code).toBe("RATES_NOT_SET");
        expect(await counts()).toEqual(before);
      } finally {
        await prisma.setting.update({ where: { id: 1 }, data: { lateFeeRatePctPerDay: "1" } });
      }
    });

    it("an unknown, malformed or already-used key imports nothing, and a second confirm cannot duplicate", async () => {
      const importKey = await stage([HEADER_ROW, [`${marker} once`, 100, 0, day(5)]]);
      expect((await commit({ importKey })).status).toBe(201);
      const again = await commit({ importKey });
      expect(again.status).toBe(404);
      expect((await again.json()).error.code).toBe("IMPORT_NOT_FOUND");
      expect(await prisma.contract.count({ where: { borrower: { fullName: `${marker} once` } } })).toBe(1);
      for (const bad of ["nope", "../../etc/passwd", `${"f".repeat(32)}.csv`]) {
        expect((await commit({ importKey: bad })).status, bad).toBe(404);
      }
      expect((await commit({ importKey: "" })).status).toBe(400);
    });

    it("two confirms at the same moment import the file once", async () => {
      const importKey = await stage([HEADER_ROW, [`${marker} race`, 100, 0, day(5)]]);
      await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`select pg_sleep(0.2)::text`));
      const results = await Promise.all([commit({ importKey }), commit({ importKey })]);
      expect(results.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
      expect(results.map((r) => r.status).filter((s) => s !== 201)[0]).toBeGreaterThanOrEqual(404);
      expect(await prisma.contract.count({ where: { borrower: { fullName: `${marker} race` } } })).toBe(1);
    });

    it("is all or nothing: a failure part-way saves no borrower, no batch, no contract — and the file stays", async () => {
      const importKey = await stage();
      const before = await counts();
      let creates = 0;
      const boom = new Proxy(prisma, {
        get(target, prop) {
          if (prop !== "$transaction") return Reflect.get(target, prop, target);
          return (fn: (tx: unknown) => unknown, opts: unknown) =>
            target.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(t, p) {
                      const v = Reflect.get(t, p, t);
                      if (p === "contract") {
                        return new Proxy(v as object, {
                          get(c, cp) {
                            const cv = Reflect.get(c, cp, c);
                            if (cp !== "create") return typeof cv === "function" ? cv.bind(c) : cv;
                            return async (...args: unknown[]) => {
                              if (++creates === 3) throw new Error("simulated failure on the third contract");
                              return (cv as (...a: unknown[]) => unknown).apply(c, args);
                            };
                          },
                        });
                      }
                      return typeof v === "function" ? v.bind(t) : v;
                    },
                  }),
                ) as never,
              opts as never,
            );
        },
      }) as unknown as typeof prisma;
      await expect(commitImport(boom, TEST_IMPORT_STORAGE, { importKey, fileName: "x.csv", choices: { [DUP]: b.dup1! }, skipInvalidRows: false, actorId: adminId })).rejects.toThrow("simulated failure");
      expect(creates).toBe(3); // two contracts and the new borrower had been written inside the transaction
      expect(await counts()).toEqual(before);
      expect(await TEST_IMPORT_STORAGE.get(importKey)).not.toBeNull();
      // and the same file can still be imported afterwards
      expect((await commit({ importKey, choices: { [DUP]: b.dup1 } })).status).toBe(201);
    });

    it("numbers contracts continuously after the ones that already exist", async () => {
      const importKey = await stage([HEADER_ROW, [`${marker} n1`, 100, 0, day(5)], [`${marker} n2`, 100, 0, day(5)], [`${marker} n3`, 100, 0, day(5)]]);
      const r = await (await commit({ importKey })).json();
      const nos = (await contractsOf(r.batchId)).map((c) => Number(c.contractNo.slice(-6)));
      expect(nos[1]).toBe(nos[0]! + 1);
      expect(nos[2]).toBe(nos[0]! + 2);
    });
  });

  // ===================================================================================
  describe("batches and rollback (DES-014 §6)", () => {
    async function importOne(rows: FixtureCell[][]) {
      const importKey = (await (await preview(csvBytes(rows))).json()).importKey as string;
      const r = await (await commit({ importKey, fileName: "batch.csv" })).json();
      return r.batchId as string;
    }
    const overdueRows = (name: string): FixtureCell[][] => [HEADER_ROW, [`${marker} ${name}`, 1000, 100, day(-3)], [`${marker} ${name}`, 500, 0, day(20)]];

    it("lists the batches and whether each can still be undone", async () => {
      const id = await importOne(overdueRows("list"));
      const list = await (await api("admin", "GET", "/admin/imports")).json();
      const item = list.items.find((i: { id: string }) => i.id === id);
      expect(item).toMatchObject({ fileName: "batch.csv", rowCount: 2, status: "COMPLETED", contractCount: 2, paymentCount: 0, canRollback: true, importedBy: { id: adminId } });
    });

    it("undoes a whole batch: contracts and late fees go, the batch is marked, the borrowers stay", async () => {
      const id = await importOne(overdueRows("undo"));
      const contracts = await contractsOf(id);
      const ids = contracts.map((c) => c.id);
      expect(await prisma.lateFeeAccrual.count({ where: { contractId: { in: ids } } })).toBe(3);
      const borrower = await prisma.borrower.findFirstOrThrow({ where: { fullName: `${marker} undo` } });

      const res = await api("admin", "POST", `/admin/imports/${id}/rollback`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, status: "ROLLED_BACK", contractsDeleted: 2, lateFeeRowsDeleted: 3 });
      expect(await prisma.contract.count({ where: { id: { in: ids } } })).toBe(0);
      expect(await prisma.lateFeeAccrual.count({ where: { contractId: { in: ids } } })).toBe(0);
      const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
      expect(batch.status).toBe("ROLLED_BACK");
      expect(batch.rolledBackAt).not.toBeNull();
      expect(await prisma.borrower.findUnique({ where: { id: borrower.id } })).not.toBeNull();
      const [audit] = await prisma.auditLog.findMany({ where: { entityType: "ImportBatch", entityId: id, action: "import.rollback" } });
      expect(audit!.actorId).toBe(adminId);
      expect(audit!.detail).toMatchObject({ contractsDeleted: 2, lateFeeRowsDeleted: 3 });

      const list = await (await api("admin", "GET", "/admin/imports")).json();
      expect(list.items.find((i: { id: string }) => i.id === id)).toMatchObject({ status: "ROLLED_BACK", canRollback: false, contractCount: 0 });
      // a second undo is refused
      const again = await api("admin", "POST", `/admin/imports/${id}/rollback`);
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe("ALREADY_ROLLED_BACK");
    });

    it("refuses to undo once any contract of the batch has a payment, and deletes nothing", async () => {
      const id = await importOne(overdueRows("paid"));
      const contracts = await contractsOf(id);
      const target = contracts.find((c) => c.principal.toString() === "1000")!;
      const paid = await api("admin", "POST", `/admin/contracts/${target.id}/payments`, { json: { amount: "100", paidOn: day(0) } });
      expect(paid.status).toBe(201);

      const res = await api("admin", "POST", `/admin/imports/${id}/rollback`);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("HAS_PAYMENTS");
      expect(body.error.message).toContain(target.contractNo);
      expect(await contractsOf(id)).toHaveLength(2);
      expect(await prisma.lateFeeAccrual.count({ where: { contractId: target.id } })).toBe(3);
      expect(await prisma.payment.count({ where: { contractId: target.id } })).toBe(1);
      expect((await prisma.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
      const list = await (await api("admin", "GET", "/admin/imports")).json();
      expect(list.items.find((i: { id: string }) => i.id === id)).toMatchObject({ paymentCount: 1, canRollback: false });
    });

    it("404s for an unknown batch", async () => {
      expect((await api("admin", "POST", "/admin/imports/does-not-exist/rollback")).status).toBe(404);
    });
  });
});
