import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { FieldCipher } from "../src/lib/field-crypto.js";
import { hashPassword } from "../src/lib/password.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `t503${Date.now()}`;
const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const day = (n: number) => formatDateOnly(addDays(today, n));
const ACCOUNT_NO = "123-4-56789-0";
const INTERNAL_REASON = "ภายใน-ห้ามเปิดเผย-เหตุผลปฏิเสธ";
const INTERNAL_NOTE = "หมายเหตุภายใน-ของแอดมิน";
const SLIP_KEY = "slip".padEnd(32, "s") + ".jpg";

describe.skipIf(!dbUp)("borrower portal (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const ids: Record<string, string> = {};
  const nos: Record<string, string> = {};
  let seq = 0;

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((r) => r.startsWith("loan_session="))!
      .split(";")[0]!;
  const get = (as: string | null, path: string) =>
    fetch(`${baseUrl}${path}`, { headers: as ? { cookie: cookies[as]! } : {} });

  async function mkBorrower(label: string, o: { pdpa?: boolean } = {}) {
    const user = await prisma.user.create({
      data: { username: `${marker}-${label}`, passwordHash: await hashPassword(PASSWORD), role: "BORROWER", mustChangePassword: false },
    });
    userIds.push(user.id);
    const bw = await prisma.borrower.create({
      data: {
        userId: user.id,
        fullName: `${marker} ${label}`,
        phone: "081-234-5678",
        bankName: "ธนาคารตัวอย่าง",
        bankAccountNo: new FieldCipher(TEST_FIELD_KEY).encrypt(ACCOUNT_NO),
        ...(o.pdpa === false ? {} : { pdpaAcceptedAt: new Date(), pdpaVersion: "1" }),
      },
    });
    ids[label] = bw.id;
  }

  async function mkContract(label: string, borrower: string, o: { status: "ACTIVE" | "CLOSED" | "AWAITING_DISBURSEMENT" | "CANCELLED"; dueIn: number; principal?: string; interest?: string; withHistory?: boolean }) {
    const { principal = "1000", interest = "100" } = o;
    const paidOut = o.status === "ACTIVE" || o.status === "CLOSED";
    const contract = await prisma.contract.create({
      data: {
        contractNo: `T-${marker}-${++seq}`,
        borrowerId: ids[borrower]!,
        principal,
        dueDate: addDays(today, o.dueIn),
        status: o.status,
        disbursedOn: paidOut ? addDays(today, -60) : null,
        interestRatePctPerMonth: paidOut ? "3" : null,
        lateFeeRatePctPerDay: paidOut ? "1" : null,
        interestAmount: paidOut ? interest : null,
        outstandingPrincipal: o.status === "CLOSED" ? "0" : principal,
        outstandingInterest: o.status === "CLOSED" ? "0" : paidOut ? interest : "0",
        closedOn: o.status === "CLOSED" ? addDays(today, -1) : null,
      },
    });
    ids[label] = contract.id;
    nos[label] = contract.contractNo;
    if (o.withHistory && paidOut) {
      await prisma.disbursement.create({
        data: { contractId: contract.id, amount: principal, paidOn: addDays(today, -60), slipFileKey: SLIP_KEY + label, note: INTERNAL_NOTE, recordedById: userIds[0]! },
      });
      await prisma.payment.create({
        data: { contractId: contract.id, amount: "300", paidOn: today, allocatedLateFee: "35", allocatedInterest: "100", allocatedPrincipal: "165", note: INTERNAL_NOTE, recordedById: userIds[0]! },
      });
    }
  }

  beforeAll(async () => {
    await mkBorrower("A");
    await mkBorrower("B");
    await mkBorrower("C", { pdpa: false });
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, passwordHash: await hashPassword(PASSWORD), role: "ADMIN", mustChangePassword: false } });
    userIds.unshift(admin.id); // keep the admin first: it is the "recorder" in the data below

    // A's contracts: waiting for payout, overdue (3 days, 1 %/day), closed, cancelled
    await mkContract("A-wait", "A", { status: "AWAITING_DISBURSEMENT", dueIn: 20, principal: "5000" });
    await mkContract("A-active", "A", { status: "ACTIVE", dueIn: -3, withHistory: true });
    await mkContract("A-closed", "A", { status: "CLOSED", dueIn: -10, principal: "800", interest: "80" });
    await mkContract("A-cancel", "A", { status: "CANCELLED", dueIn: 5, principal: "300" });
    await mkContract("B-active", "B", { status: "ACTIVE", dueIn: 4, principal: "7777", interest: "77", withHistory: true });

    // A's requests: pending, rejected (with an internal reason), cancelled, approved (-> the waiting contract)
    const req = (label: string, o: { borrower: string; status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"; reason?: string; amount?: string }) =>
      prisma.loanRequest.create({
        data: { borrowerId: ids[o.borrower]!, amount: o.amount ?? "1500", requestedDueDate: addDays(today, 15), status: o.status, createdById: userIds[0]!, decidedById: o.status === "PENDING" ? null : userIds[0]!, decidedAt: o.status === "PENDING" ? null : new Date(), rejectReason: o.reason ?? null },
      }).then((r) => void (ids[label] = r.id));
    await req("A-req-pending", { borrower: "A", status: "PENDING" });
    await req("A-req-rejected", { borrower: "A", status: "REJECTED", reason: INTERNAL_REASON, amount: "2500" });
    await req("A-req-cancelled", { borrower: "A", status: "CANCELLED" });
    await req("A-req-approved", { borrower: "A", status: "APPROVED", amount: "5000" });
    await prisma.contract.update({ where: { id: ids["A-wait"]! }, data: { loanRequestId: ids["A-req-approved"]! } });
    await req("B-req", { borrower: "B", status: "PENDING", amount: "4242" });

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
    for (const u of ["admin", "A", "B", "C"]) {
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
    const borrowerIds = (await prisma.borrower.findMany({ where: { fullName: { startsWith: marker } }, select: { id: true } })).map((x) => x.id);
    const contracts = (await prisma.contract.findMany({ where: { borrowerId: { in: borrowerIds } }, select: { id: true } })).map((x) => x.id);
    await prisma.payment.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.disbursement.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.loanRequest.deleteMany({ where: { borrowerId: { in: borrowerIds } } });
    await prisma.borrower.deleteMany({ where: { id: { in: borrowerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("shows the borrower their own profile, including their own account number (decrypted)", async () => {
    const res = await get("A", "/me/profile");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      username: `${marker}-A`,
      fullName: `${marker} A`,
      phone: "081-234-5678",
      bankName: "ธนาคารตัวอย่าง",
      bankAccountNo: ACCOUNT_NO,
      pdpaVersion: "1",
    });
    // stored encrypted, shown plain only to its owner
    expect((await prisma.borrower.findUniqueOrThrow({ where: { id: ids.A! } })).bankAccountNo).toMatch(/^enc:v1:/);
    const text = JSON.stringify(await (await get("A", "/me/profile")).json());
    expect(text).not.toMatch(/passwordHash|scrypt|userId/);
  });

  it("lists only the borrower's own requests with their status, and never the internal reject reason", async () => {
    const body = await (await get("A", "/me/loan-requests")).json();
    expect(body.items.map((r: { id: string }) => r.id).sort()).toEqual(["A-req-pending", "A-req-rejected", "A-req-cancelled", "A-req-approved"].map((l) => ids[l]!).sort());
    const byId = Object.fromEntries(body.items.map((r: { id: string; status: string }) => [r.id, r]));
    expect(byId[ids["A-req-pending"]!].status).toBe("PENDING");
    expect(byId[ids["A-req-rejected"]!]).toMatchObject({ status: "REJECTED", amount: "2500" });
    expect(byId[ids["A-req-approved"]!].contract).toMatchObject({ contractNo: nos["A-wait"], status: "AWAITING_DISBURSEMENT" });
    const text = JSON.stringify(body);
    expect(text).not.toContain(INTERNAL_REASON);
    expect(text).not.toMatch(/rejectReason|createdById|decidedById/);
    expect(text).not.toContain(ids["B-req"]!);
    expect(text).not.toContain("4242");
  });

  describe("contracts", () => {
    it("lists only the borrower's own contracts", async () => {
      const body = await (await get("A", "/me/contracts")).json();
      expect(body.items.map((c: { contractNo: string }) => c.contractNo).sort()).toEqual(["A-wait", "A-active", "A-closed", "A-cancel"].map((l) => nos[l]!).sort());
      expect(JSON.stringify(body)).not.toContain(nos["B-active"]!);
      expect(JSON.stringify(body)).not.toContain("7777");
    });

    it("shows NO amount owed before the money is paid out, nor for a cancelled contract", async () => {
      const items = (await (await get("A", "/me/contracts")).json()).items as Array<Record<string, unknown>>;
      for (const label of ["A-wait", "A-cancel"]) {
        const c = items.find((i) => i.contractNo === nos[label])!;
        expect(Object.keys(c).sort()).toEqual(["contractNo", "dueDate", "id", "principal", "status"]);
      }
      const wait = items.find((i) => i.contractNo === nos["A-wait"])!;
      expect(wait).toMatchObject({ status: "AWAITING_DISBURSEMENT", principal: "5000" });
    });

    it("shows what is owed today, the due date and the accrued late fee once it is paid out", async () => {
      const items = (await (await get("A", "/me/contracts")).json()).items as Array<Record<string, unknown>>;
      const c = items.find((i) => i.contractNo === nos["A-active"])!;
      // due 3 days ago, 1 %/day compounding on 1,100, each day rounded up to a whole baht: 11 + 12 + 12 = 35 ; a payment of 300 is in the data
      expect(c).toMatchObject({
        status: "ACTIVE",
        dueDate: day(-3),
        isOverdue: true,
        daysOverdue: 3,
        isLate: true,
        interestAmount: "100",
      });
      // 300 paid today: fee 35, interest 100, principal 165 -> owes 835 of principal and nothing else
      expect(c).toMatchObject({ outstandingPrincipal: "835", outstandingInterest: "0", accruedLateFee: "0", totalDue: "835" });
      const closed = items.find((i) => i.contractNo === nos["A-closed"])!;
      expect(closed).toMatchObject({ status: "CLOSED", totalDue: "0", isOverdue: false });
    });

    it("returns the history of one contract: the payout and every payment", async () => {
      const res = await get("A", `/me/contracts/${ids["A-active"]}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contract.contractNo).toBe(nos["A-active"]);
      expect(body.disbursement).toEqual({ amount: "1000", paidOn: day(-60) });
      expect(body.payments).toHaveLength(1);
      expect(body.payments[0]).toMatchObject({ amount: "300", paidOn: day(0), allocatedLateFee: "35", allocatedInterest: "100", allocatedPrincipal: "165" });
    });

    it("has no history to show for a contract that has not been paid out", async () => {
      const body = await (await get("A", `/me/contracts/${ids["A-wait"]}`)).json();
      expect(body.disbursement).toBeNull();
      expect(body.payments).toEqual([]);
      expect(Object.keys(body.contract).sort()).toEqual(["contractNo", "dueDate", "id", "principal", "status"]);
    });

    it("never exposes slips, who recorded what, admin notes, rates or import details", async () => {
      const list = JSON.stringify(await (await get("A", "/me/contracts")).json());
      const detail = JSON.stringify(await (await get("A", `/me/contracts/${ids["A-active"]}`)).json());
      for (const text of [list, detail]) {
        expect(text).not.toContain(SLIP_KEY);
        expect(text).not.toContain(INTERNAL_NOTE);
        expect(text).not.toMatch(/slipFileKey|recordedById|note|RatePct|isImported|importBatchId|loanRequestId|borrowerId/);
      }
    });

    it("answers 'not found' for another borrower's contract, exactly as for one that does not exist", async () => {
      const other = await get("A", `/me/contracts/${ids["B-active"]}`);
      const none = await get("A", "/me/contracts/does-not-exist");
      expect(other.status).toBe(404);
      expect(none.status).toBe(404);
      expect(await other.json()).toEqual(await none.json());
      // and B can still see it
      expect((await get("B", `/me/contracts/${ids["B-active"]}`)).status).toBe(200);
    });
  });

  describe("access", () => {
    const paths = ["/me/profile", "/me/loan-requests", "/me/contracts", "/me/contracts/x"];

    it("each borrower sees only their own data", async () => {
      const b = await (await get("B", "/me/contracts")).json();
      expect(b.items.map((c: { contractNo: string }) => c.contractNo)).toEqual([nos["B-active"]]);
      expect((await (await get("B", "/me/profile")).json()).fullName).toBe(`${marker} B`);
      expect((await (await get("B", "/me/loan-requests")).json()).items).toHaveLength(1);
    });

    it("refuses anyone who is not logged in, an admin, or a borrower who has not accepted the PDPA terms", async () => {
      for (const p of paths) {
        expect((await get(null, p)).status, p).toBe(401);
        expect((await get("admin", p)).status, p).toBe(403);
        const noPdpa = await get("C", p);
        expect(noPdpa.status, p).toBe(403);
        expect((await noPdpa.json()).error.code).toBe("PDPA_REQUIRED");
      }
    });

    it("refuses a borrowerId sent by the client, so the session is the only source", async () => {
      for (const p of ["/me/contracts", "/me/loan-requests", "/me/profile"]) {
        const res = await get("A", `${p}?borrowerId=${ids.B}`);
        expect(res.status, p).toBe(400);
        expect((await res.json()).error.code).toBe("BORROWER_ID_NOT_ALLOWED");
      }
    });

    it("stops working as soon as the account is switched off", async () => {
      await prisma.user.update({ where: { username: `${marker}-B` }, data: { isActive: false } });
      expect((await get("B", "/me/contracts")).status).toBe(401);
    });
  });
});
