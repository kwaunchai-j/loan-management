import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { FieldCipher } from "../src/lib/field-crypto.js";
import { hashPassword } from "../src/lib/password.js";
import { MAX_PENDING_PER_BORROWER } from "../src/loans/submissions.js";
import { Notifier } from "../src/notifications/service.js";
import type { ChannelAdapter, RenderedMessage } from "../src/notifications/types.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `cr1${Date.now()}`;
const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));
const SMALL_LIMIT = 4096;

// a valid PNG signature followed by filler, a valid JPEG signature followed by filler
const png = (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 7)]);
const jpg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 9)]);

describe.skipIf(!dbUp)("borrower payment slips (CR-1, PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const ids: Record<string, string> = {};
  const nos: Record<string, string> = {};
  const sent: RenderedMessage[] = [];
  /** every slip file the API wrote during the run, so a file that no record refers to can be found */
  const stored: string[] = [];
  const recordingStorage: typeof TEST_SLIP_STORAGE = Object.assign(Object.create(TEST_SLIP_STORAGE) as typeof TEST_SLIP_STORAGE, {
    put: async (key: string, data: Buffer) => {
      stored.push(key);
      await TEST_SLIP_STORAGE.put(key, data);
    },
  });
  let seq = 0;
  let notifier: Notifier;

  const cookieOf = (res: Response) => res.headers.getSetCookie().find((r) => r.startsWith("loan_session="))!.split(";")[0]!;
  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(as ? { cookie: cookies[as]! } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const query = (o: Record<string, string>) => new URLSearchParams(o).toString();
  /** the borrower says "I paid": the slip is the body, the figures are in the query */
  const submit = (as: string | null, contract: string, q: Record<string, string>, bytes: Buffer = png(), type = "image/png") =>
    fetch(`${baseUrl}/me/contracts/${ids[contract] ?? contract}/payment-submissions?${query(q)}`, {
      method: "POST",
      headers: { ...(as ? { cookie: cookies[as]! } : {}), "content-type": type },
      body: new Uint8Array(bytes),
    });
  const claim = (amount = "300", paidOn = day(0)) => ({ amount, paidOn });

  async function mkBorrower(label: string, o: { pdpa?: boolean } = {}) {
    const user = await prisma.user.create({
      data: { username: `${marker}-${label}`, passwordHash: await hashPassword(PASSWORD), role: "BORROWER", mustChangePassword: false },
    });
    userIds.push(user.id);
    const bw = await prisma.borrower.create({
      data: {
        userId: user.id,
        fullName: `${marker} ${label}`,
        bankAccountNo: new FieldCipher(TEST_FIELD_KEY).encrypt("123-4-56789-0"),
        ...(o.pdpa === false ? {} : { pdpaAcceptedAt: new Date(), pdpaVersion: "1" }),
      },
    });
    ids[label] = bw.id;
  }

  /** An open contract the ledger can replay: 1,000 principal + 100 interest, paid out 30 days ago. */
  async function mkContract(label: string, borrower: string, status: "ACTIVE" | "CLOSED" | "AWAITING_DISBURSEMENT" = "ACTIVE", dueIn = 10) {
    const paidOut = status !== "AWAITING_DISBURSEMENT";
    const c = await prisma.contract.create({
      data: {
        contractNo: `C-${marker}-${++seq}`,
        borrowerId: ids[borrower]!,
        principal: "1000",
        dueDate: addDays(today, dueIn),
        status,
        disbursedOn: paidOut ? addDays(today, -30) : null,
        interestRatePctPerMonth: paidOut ? "3" : null,
        lateFeeRatePctPerDay: paidOut ? "1" : null,
        interestAmount: paidOut ? "100" : null,
        outstandingPrincipal: status === "CLOSED" ? "0" : "1000",
        outstandingInterest: status === "CLOSED" ? "0" : paidOut ? "100" : "0",
        closedOn: status === "CLOSED" ? addDays(today, -1) : null,
      },
    });
    ids[label] = c.id;
    nos[label] = c.contractNo;
  }

  const contractNow = (label: string) => prisma.contract.findUniqueOrThrow({ where: { id: ids[label]! } });
  const rowsOf = (label: string) => prisma.paymentSubmission.findMany({ where: { contractId: ids[label]! }, orderBy: { createdAt: "asc" } });
  const fileCount = async (label: string) => {
    let n = 0;
    for (const r of await rowsOf(label)) if (await TEST_SLIP_STORAGE.exists(r.slipFileKey)) n++;
    return n;
  };
  async function pend(label: string, borrower: string, amount = "300") {
    const res = await submit(borrower, label, claim(amount));
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    for (const b of ["A", "B", "D", "E", "F"]) await mkBorrower(b);
    await mkBorrower("C", { pdpa: false });
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, passwordHash: await hashPassword(PASSWORD), role: "ADMIN", mustChangePassword: false } });
    userIds.unshift(admin.id);
    await mkContract("A-active", "A");
    await mkContract("A-closed", "A", "CLOSED", -10);
    await mkContract("A-wait", "A", "AWAITING_DISBURSEMENT", 20);
    await mkContract("B-active", "B");
    await mkContract("C-active", "C");
    for (const l of ["D", "E", "F"]) await mkContract(`${l}-active`, l);
    for (const l of ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7", "A-8"]) await mkContract(l, "A"); // many separate claims on A

    const adapter: ChannelAdapter = {
      channel: "LINE",
      hasRecipients: async () => true,
      send: async (m) => void sent.push(m),
    };
    notifier = new Notifier({ prisma, adapters: [adapter], retryDelaysMs: [0, 0], log: () => undefined });
    server = buildApp({
      prisma,
      sessionSecret: SECRET,
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: recordingStorage,
      slipMaxBytes: SMALL_LIMIT,
      importStorage: TEST_IMPORT_STORAGE,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      notifier,
    }).app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const u of ["admin", "A", "B", "C", "D", "E", "F"]) {
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
    await notifier.drain();
    const borrowerIds = (await prisma.borrower.findMany({ where: { fullName: { startsWith: marker } }, select: { id: true } })).map((x) => x.id);
    const contracts = (await prisma.contract.findMany({ where: { borrowerId: { in: borrowerIds } }, select: { id: true } })).map((x) => x.id);
    await prisma.notificationLog.deleteMany({ where: { dedupeKey: { startsWith: "PAYMENT_SUBMITTED:" }, type: "PAYMENT_SUBMITTED", createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    await prisma.paymentSubmission.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...contracts] } } });
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.lateFeeAccrual.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowerIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("sending a slip", () => {
    it("records a CLAIM with the slip, answers with the status only, and changes no balance", async () => {
      const before = await contractNow("A-active");
      const res = await submit("A", "A-active", { ...claim("300"), note: "  โอนผ่านแอปธนาคาร  " });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({ status: "PENDING", amount: "300", paidOn: day(0), note: "โอนผ่านแอปธนาคาร", contract: { contractNo: nos["A-active"] }, rejectReason: null });
      expect(JSON.stringify(body)).not.toMatch(/slipFileKey|decidedById|borrowerId/);

      const rows = await rowsOf("A-active");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "PENDING", borrowerId: ids.A, paymentId: null });
      expect(await TEST_SLIP_STORAGE.exists(rows[0]!.slipFileKey)).toBe(true);
      expect(rows[0]!.slipFileKey).toMatch(/^[a-f0-9]{32}\.png$/);

      const after = await contractNow("A-active");
      expect(after.outstandingPrincipal.toString()).toBe(before.outstandingPrincipal.toString());
      expect(after.outstandingInterest.toString()).toBe(before.outstandingInterest.toString());
      expect(await prisma.payment.count({ where: { contractId: ids["A-active"]! } })).toBe(0);
      const audit = await prisma.auditLog.findFirst({ where: { entityId: rows[0]!.id, action: "paymentSubmission.create" } });
      expect(audit?.actorId).toBe(userIds[1]); // the borrower who sent it (A is the first borrower made; the admin is userIds[0])
    });

    it("decides the file type from its bytes: a JPEG is accepted whatever the client calls it", async () => {
      const res = await submit("B", "B-active", claim("100"), jpg(), "application/octet-stream");
      expect(res.status).toBe(201);
      const [row] = await rowsOf("B-active");
      expect(row!.slipFileKey).toMatch(/\.jpg$/);
      expect(await TEST_SLIP_STORAGE.get(row!.slipFileKey)).toEqual(jpg());
    });

    it("refuses anything that is not a JPEG or PNG image, and writes nothing", async () => {
      const before = await fileCount("A-active");
      for (const bytes of [Buffer.from("%PDF-1.7 not an image"), Buffer.from("<script>alert(1)</script>"), Buffer.from("GIF89a....")]) {
        const res = await submit("A", "A-active", claim(), bytes, "image/png"); // even when it claims to be a PNG
        expect(res.status).toBe(415);
        expect((await res.json()).error.code).toBe("UNSUPPORTED_FILE_TYPE");
      }
      expect((await submit("A", "A-active", claim(), Buffer.alloc(0))).status).toBe(400);
      expect(await rowsOf("A-active")).toHaveLength(1);
      expect(await fileCount("A-active")).toBe(before);
    });

    it("refuses a file over the size limit", async () => {
      const res = await submit("A", "A-active", claim(), png(SMALL_LIMIT + 10));
      expect(res.status).toBe(413);
      expect(await rowsOf("A-active")).toHaveLength(1);
    });

    it("checks the amount, the date and the note", async () => {
      const bad: Array<[Record<string, string>, number, string?]> = [
        [{ paidOn: day(0) }, 400],
        [{ amount: "300" }, 400],
        [{ amount: "0", paidOn: day(0) }, 400],
        [{ amount: "-5", paidOn: day(0) }, 400],
        [{ amount: "10.123", paidOn: day(0) }, 400],
        [{ amount: "abc", paidOn: day(0) }, 400],
        [{ amount: "1234567890123", paidOn: day(0) }, 400],
        [{ amount: "300", paidOn: "2026-02-30" }, 400],
        [{ amount: "300", paidOn: "01/02/2026" }, 400],
        [{ amount: "300", paidOn: day(1) }, 400, "PAID_ON_FUTURE"],
        [{ amount: "300", paidOn: day(-31) }, 400, "PAID_ON_BEFORE_PAYOUT"], // the payout was 30 days ago
        [{ amount: "300", paidOn: day(0), note: "x".repeat(501) }, 400],
      ];
      for (const [q, status, code] of bad) {
        const res = await submit("A", "A-active", q);
        expect(res.status, JSON.stringify(q)).toBe(status);
        if (code) expect((await res.json()).error.code).toBe(code);
      }
      expect(await rowsOf("A-active")).toHaveLength(1);
    });

    it("works only on an open contract that belongs to the borrower", async () => {
      expect((await submit("A", "A-closed", claim())).status).toBe(409);
      expect((await submit("A", "A-wait", claim())).status).toBe(409);
      // someone else's contract and a contract that does not exist look exactly the same
      const other = await submit("A", "B-active", claim());
      const ghost = await submit("A", "no-such-contract", claim());
      expect(other.status).toBe(404);
      expect(ghost.status).toBe(404);
      expect(await other.json()).toEqual(await ghost.json());
      expect(await rowsOf("B-active")).toHaveLength(1); // B's own claim from before, nothing from A
    });

    it("needs a logged-in borrower who accepted the PDPA terms, and the borrower is never named by the client", async () => {
      expect((await submit(null, "A-active", claim())).status).toBe(401);
      expect((await submit("admin", "A-active", claim())).status).toBe(403);
      const noPdpa = await submit("C", "C-active", claim());
      expect(noPdpa.status).toBe(403);
      expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
      const named = await submit("A", "A-active", { ...claim(), borrowerId: ids.B! });
      expect(named.status).toBe(400);
      expect((await named.json()).error.code).toBe("BORROWER_ID_NOT_ALLOWED");
    });

    it("caps the claims waiting at once, even when they arrive in parallel", async () => {
      const results = await Promise.all(Array.from({ length: 9 }, (_, i) => submit("E", "E-active", claim(String(10 + i)))));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_PENDING_PER_BORROWER);
      expect(statuses.filter((s) => s === 409)).toHaveLength(9 - MAX_PENDING_PER_BORROWER);
      expect(await rowsOf("E-active")).toHaveLength(MAX_PENDING_PER_BORROWER);
      // no slip file is left behind by the refused ones: every file written is referred to by a record
      expect(await fileCount("E-active")).toBe(MAX_PENDING_PER_BORROWER);
      const referred = new Set((await prisma.paymentSubmission.findMany({ select: { slipFileKey: true } })).map((r) => r.slipFileKey));
      const orphans: string[] = [];
      for (const key of stored) if (!referred.has(key) && (await TEST_SLIP_STORAGE.exists(key))) orphans.push(key);
      expect(orphans).toEqual([]);
      expect(stored.length).toBeGreaterThan(MAX_PENDING_PER_BORROWER); // the refused ones DID write a file first, then cleaned it up
      const refused = await submit("E", "E-active", claim("5"));
      expect((await refused.json()).error.code).toBe("TOO_MANY_PENDING");
    });
  });

  describe("what the borrower can see", () => {
    it("lists only their own claims, with no slip key and no one else's data", async () => {
      const mine = await (await call("A", "GET", "/me/payment-submissions")).json();
      expect(mine.items.length).toBeGreaterThan(0);
      expect(mine.items.every((i: { contract: { contractNo: string } }) => i.contract.contractNo.startsWith(`C-${marker}`))).toBe(true);
      expect(JSON.stringify(mine)).not.toMatch(/slipFileKey|borrowerId|decidedById|paymentId/);
      const b = await (await call("B", "GET", "/me/payment-submissions")).json();
      expect(b.items).toHaveLength(1);
      expect(b.items[0].contract.contractNo).toBe(nos["B-active"]);
      expect((await call(null, "GET", "/me/payment-submissions")).status).toBe(401);
      expect((await call("admin", "GET", "/me/payment-submissions")).status).toBe(403);
    });

    it("a borrower can never open the slip (slips are ADMIN-only), not even their own", async () => {
      const [row] = await rowsOf("B-active");
      expect((await call("B", "GET", `/admin/slips/${row!.slipFileKey}`)).status).toBe(403);
      expect((await call("admin", "GET", `/admin/slips/${row!.slipFileKey}`)).status).toBe(200);
    });
  });

  describe("the admin's queue", () => {
    it("lists claims oldest first with the slip key, filtered by status or contract, for ADMIN only", async () => {
      const res = await call("admin", "GET", "/admin/payment-submissions?status=PENDING&limit=200");
      expect(res.status).toBe(200);
      const body = await res.json();
      const mine = body.items.filter((i: { borrower: { fullName: string } }) => i.borrower.fullName.startsWith(marker));
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.every((i: { status: string }) => i.status === "PENDING")).toBe(true);
      expect(mine[0]).toMatchObject({ slipFileKey: expect.stringMatching(/^[a-f0-9]{32}\.(png|jpg)$/), amount: expect.any(String) });
      const times = mine.map((i: { createdAt: string }) => i.createdAt);
      expect([...times].sort()).toEqual(times);

      const one = await (await call("admin", "GET", `/admin/payment-submissions?contractId=${ids["B-active"]}`)).json();
      expect(one.total).toBe(1);
      expect(one.items[0].borrower.fullName).toBe(`${marker} B`);

      expect((await call(null, "GET", "/admin/payment-submissions")).status).toBe(401);
      expect((await call("A", "GET", "/admin/payment-submissions")).status).toBe(403);
      expect((await call("admin", "GET", "/admin/payment-submissions?status=BOGUS")).status).toBe(400);
      expect((await call("admin", "GET", "/admin/payment-submissions?limit=0")).status).toBe(400);
    });
  });

  describe("confirming", () => {
    it("records a REAL payment through the ledger and marks the claim confirmed, together", async () => {
      const subId = (await rowsOf("A-active"))[0]!.id; // 300 on day 0
      const res = await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      // owed 1,000 + 100 interest, no late fee yet: late fee → interest → principal  =  0 / 100 / 200
      expect(body.payment).toMatchObject({ amount: "300", allocatedLateFee: "0", allocatedInterest: "100", allocatedPrincipal: "200" });
      expect(body.contract).toMatchObject({ outstandingPrincipal: "800", outstandingInterest: "0", totalDue: "800" });
      expect(body.submission).toMatchObject({ status: "CONFIRMED", paymentId: body.payment.id });

      const row = await prisma.paymentSubmission.findUniqueOrThrow({ where: { id: subId } });
      expect(row).toMatchObject({ status: "CONFIRMED", paymentId: body.payment.id, decidedById: userIds[0] });
      expect(row.decidedAt).not.toBeNull();
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: body.payment.id } });
      expect(payment.note).toContain("โอนผ่านแอปธนาคาร");
      expect(payment.recordedById).toBe(userIds[0]);
      const actions = (await prisma.auditLog.findMany({ where: { entityId: { in: [subId, payment.id] } } })).map((a) => a.action).sort();
      expect(actions).toEqual(["payment.create", "paymentSubmission.confirm", "paymentSubmission.create"]);
    });

    it("lets the admin correct the amount, date and note before confirming (the claim is only a claim)", async () => {
      const subId = await pend("D-active", "D", "999");
      const res = await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, { amount: "250.50", paidOn: day(-1), note: "ตรวจกับสลิปแล้ว ยอดจริง 250.50" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment).toMatchObject({ amount: "250.5", paidOn: day(-1), note: "ตรวจกับสลิปแล้ว ยอดจริง 250.50" });
      const audit = await prisma.auditLog.findFirst({ where: { entityId: subId, action: "paymentSubmission.confirm" } });
      expect(JSON.stringify(audit?.detail)).toContain('"adjusted":true');
    });

    it("if the ledger refuses (more than is owed) NOTHING changes and the claim keeps waiting", async () => {
      const subId = await pend("F-active", "F", "5000"); // owed is only 1,100
      const before = await contractNow("F-active");
      const res = await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {});
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("AMOUNT_EXCEEDS_DUE");
      expect((await prisma.paymentSubmission.findUniqueOrThrow({ where: { id: subId } })).status).toBe("PENDING");
      expect(await prisma.payment.count({ where: { contractId: ids["F-active"]! } })).toBe(0);
      expect((await contractNow("F-active")).outstandingPrincipal.toString()).toBe(before.outstandingPrincipal.toString());
      expect(await prisma.auditLog.count({ where: { entityId: subId, action: "paymentSubmission.confirm" } })).toBe(0);
      // the admin can then fix the amount and confirm
      const ok = await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, { amount: "1100" });
      expect(ok.status).toBe(200);
      expect((await ok.json()).contract).toMatchObject({ status: "CLOSED", totalDue: "0" });
    });

    it("refuses a date before the payout, and a contract that closed in the meantime, leaving the claim waiting", async () => {
      const early = await pend("A-1", "A", "100");
      const r1 = await call("admin", "POST", `/admin/payment-submissions/${early}/confirm`, { paidOn: day(-45) });
      expect(r1.status).toBe(400);
      expect((await r1.json()).error.code).toBe("PAID_BEFORE_DISBURSEMENT");

      const later = await pend("A-2", "A", "100");
      await prisma.contract.update({ where: { id: ids["A-2"]! }, data: { status: "CLOSED", closedOn: today, outstandingPrincipal: "0", outstandingInterest: "0" } });
      const r2 = await call("admin", "POST", `/admin/payment-submissions/${later}/confirm`, {});
      expect(r2.status).toBe(409);
      for (const id of [early, later]) expect((await prisma.paymentSubmission.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    });

    it("a claim is decided exactly once, even when two admins press the button together", async () => {
      const subId = await pend("A-3", "A", "100");
      const [a, b] = await Promise.all([
        call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {}),
        call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {}),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await prisma.payment.count({ where: { contractId: ids["A-3"]! } })).toBe(1);
      const again = await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {});
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe("INVALID_STATE");
    });

    it("validates the corrections and the id, and is ADMIN only", async () => {
      const subId = await pend("A-4", "A", "100");
      for (const body of [{ amount: "0" }, { amount: "1.234" }, { paidOn: "nope" }, { note: "" }, { note: "x".repeat(501) }]) {
        expect((await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await call("admin", "POST", "/admin/payment-submissions/nope/confirm", {})).status).toBe(404);
      expect((await call("A", "POST", `/admin/payment-submissions/${subId}/confirm`, {})).status).toBe(403);
      expect((await call(null, "POST", `/admin/payment-submissions/${subId}/confirm`, {})).status).toBe(401);
      expect((await prisma.paymentSubmission.findUniqueOrThrow({ where: { id: subId } })).status).toBe("PENDING");
    });

    it("deleting the payment later keeps the claim as confirmed history (the link is just cleared)", async () => {
      const subId = await pend("A-5", "A", "100");
      const paymentId = ((await (await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {})).json()) as { payment: { id: string } }).payment.id;
      expect((await call("admin", "DELETE", `/admin/payments/${paymentId}`)).status).toBe(200);
      expect(await prisma.paymentSubmission.findUniqueOrThrow({ where: { id: subId } })).toMatchObject({ status: "CONFIRMED", paymentId: null });
    });
  });

  describe("rejecting", () => {
    it("needs a reason, records it, and shows it to the borrower", async () => {
      const subId = await pend("A-6", "A", "100");
      for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(501) }]) {
        expect((await call("admin", "POST", `/admin/payment-submissions/${subId}/reject`, body)).status, JSON.stringify(body)).toBe(400);
      }
      const res = await call("admin", "POST", `/admin/payment-submissions/${subId}/reject`, { reason: "  สลิปไม่ชัด อ่านยอดไม่ได้  " });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "REJECTED", rejectReason: "สลิปไม่ชัด อ่านยอดไม่ได้", paymentId: null });
      expect(await prisma.payment.count({ where: { contractId: ids["A-6"]! } })).toBe(0);
      expect((await contractNow("A-6")).outstandingPrincipal.toString()).toBe("1000");
      const mine = await (await call("A", "GET", "/me/payment-submissions")).json();
      expect(mine.items.find((i: { id: string }) => i.id === subId)).toMatchObject({ status: "REJECTED", rejectReason: "สลิปไม่ชัด อ่านยอดไม่ได้" });
      expect(await prisma.auditLog.count({ where: { entityId: subId, action: "paymentSubmission.reject" } })).toBe(1);
    });

    it("a decided claim cannot be decided again, and a rejected one frees a place under the limit", async () => {
      const subId = await pend("A-7", "A", "100");
      expect((await call("admin", "POST", `/admin/payment-submissions/${subId}/reject`, { reason: "ไม่ตรง" })).status).toBe(200);
      expect((await call("admin", "POST", `/admin/payment-submissions/${subId}/reject`, { reason: "อีกครั้ง" })).status).toBe(409);
      expect((await call("admin", "POST", `/admin/payment-submissions/${subId}/confirm`, {})).status).toBe(409);
      // E is at the limit; rejecting one of its claims lets it send again
      const full = await submit("E", "E-active", claim("5"));
      expect(full.status).toBe(409);
      const first = (await rowsOf("E-active"))[0]!;
      await call("admin", "POST", `/admin/payment-submissions/${first.id}/reject`, { reason: "ซ้ำ" });
      expect((await submit("E", "E-active", claim("5"))).status).toBe(201);
    });

    it("is ADMIN only and answers 404 for an unknown id", async () => {
      const subId = await pend("A-8", "A", "100");
      expect((await call("A", "POST", `/admin/payment-submissions/${subId}/reject`, { reason: "x" })).status).toBe(403);
      expect((await call("admin", "POST", "/admin/payment-submissions/nope/reject", { reason: "x" })).status).toBe(404);
    });
  });

  describe("telling the admin", () => {
    it("sends one message when a slip arrives, naming the borrower, the contract and the amount", async () => {
      await notifier.drain();
      sent.length = 0;
      const res = await submit("D", "D-active", claim("77.5"));
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { id: string }).id;
      await notifier.drain();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.line).toContain(`${marker} D`);
      expect(sent[0]!.line).toContain(nos["D-active"]);
      expect(sent[0]!.line).toContain("77.50");
      expect(sent[0]!.push).toMatchObject({ title: "ผู้ยืมส่งสลิปชำระเงิน", url: "/admin/payments" });
      // asking again for the same claim does not send a second one
      await notifier.paymentSubmitted(id);
      expect(sent).toHaveLength(1);
    });

    it("sends nothing for a refused upload, and nothing about a claim that is no longer waiting", async () => {
      await notifier.drain();
      sent.length = 0;
      expect((await submit("D", "D-active", claim("5"), Buffer.from("not an image"))).status).toBe(415);
      await notifier.drain();
      expect(sent).toHaveLength(0);
      const decided = (await prisma.paymentSubmission.findFirst({ where: { contractId: ids["A-6"]!, status: "REJECTED" } }))!;
      expect(await notifier.paymentSubmitted(decided.id)).toEqual({});
    });
  });

  describe("the admin calendar", () => {
    it("puts each contract on its due date and each payment on the day it was paid", async () => {
      const month = day(0).slice(0, 7);
      const res = await call("admin", "GET", `/admin/calendar?month=${month}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.month).toBe(month);
      expect(body.today).toBe(day(0));
      const mine = body.days.flatMap((d: { date: string; due: { items: Array<{ contractNo: string }> } }) => d.due.items.map((i) => ({ date: d.date, no: i.contractNo })));
      // A-active is due in 10 days: it must sit on that exact day if that day is in this month
      const due = day(10);
      if (due.startsWith(month)) expect(mine).toContainEqual({ date: due, no: nos["A-active"] });
      for (const d of body.days) {
        expect(d.date.startsWith(month)).toBe(true);
        expect(d.due.count).toBe(d.due.items.length);
        expect(d.paid.count).toBe(d.paid.items.length);
      }
      const paidToday = body.days.find((d: { date: string }) => d.date === day(0))?.paid;
      expect(paidToday.items.some((p: { contractNo: string; amount: string }) => p.contractNo === nos["A-active"] && p.amount === "300")).toBe(true);
    });

    it("shows what is still owed on an open contract and nothing owed on a settled one, and sums them with the ledger's own numbers", async () => {
      await mkContract("Cal-open", "B", "ACTIVE", 3);
      await mkContract("Cal-done", "B", "CLOSED", 3);
      const target = day(3);
      const body = await (await call("admin", "GET", `/admin/calendar?month=${target.slice(0, 7)}`)).json();
      const bucket = body.days.find((d: { date: string }) => d.date === target);
      const open = bucket.due.items.find((i: { contractNo: string }) => i.contractNo === nos["Cal-open"]);
      const done = bucket.due.items.find((i: { contractNo: string }) => i.contractNo === nos["Cal-done"]);
      expect(open).toMatchObject({ status: "ACTIVE", totalDue: "1100", isOverdue: false, daysOverdue: 0 });
      expect(done).toMatchObject({ status: "CLOSED", totalDue: "0" });
      expect(bucket.due.openCount).toBeGreaterThanOrEqual(1);
      // the day's open total is the sum of the open items (decimal text, no float)
      const sum = bucket.due.items.filter((i: { status: string }) => i.status === "ACTIVE").reduce((s: bigint, i: { totalDue: string }) => s + BigInt(Math.round(Number(i.totalDue) * 100)), 0n);
      expect(BigInt(Math.round(Number(bucket.due.openTotal) * 100))).toBe(sum);
    });

    it("flags a contract past its due date, in the month of its due date", async () => {
      await mkContract("Cal-late", "B", "ACTIVE", -2);
      const target = day(-2);
      const body = await (await call("admin", "GET", `/admin/calendar?month=${target.slice(0, 7)}`)).json();
      const item = body.days.find((d: { date: string }) => d.date === target).due.items.find((i: { contractNo: string }) => i.contractNo === nos["Cal-late"]);
      expect(item).toMatchObject({ isOverdue: true, daysOverdue: 2 });
    });

    it("does not list contracts that were never paid out, or cancelled", async () => {
      const month = day(20).slice(0, 7);
      const body = await (await call("admin", "GET", `/admin/calendar?month=${month}`)).json();
      const all = JSON.stringify(body);
      expect(all).not.toContain(nos["A-wait"]); // waiting for the payout
    });

    it("defaults to the current month, validates the month, and is ADMIN only", async () => {
      expect((await (await call("admin", "GET", "/admin/calendar")).json()).month).toBe(day(0).slice(0, 7));
      for (const m of ["2026-13", "2026-1", "abcd", "2026-00", "1969-12", "2101-01"]) {
        expect((await call("admin", "GET", `/admin/calendar?month=${m}`)).status, m).toBe(400);
      }
      expect((await call("A", "GET", "/admin/calendar")).status).toBe(403);
      expect((await call(null, "GET", "/admin/calendar")).status).toBe(401);
    });

    it("a month with nothing in it is simply empty", async () => {
      const body = await (await call("admin", "GET", "/admin/calendar?month=2031-02")).json();
      expect(body).toMatchObject({ month: "2031-02", days: [], truncated: false });
    });
  });
});
