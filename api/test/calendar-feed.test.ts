import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { bangkokToday, formatDateOnly } from "../src/lib/dates.js";
import { hashPassword } from "../src/lib/password.js";
import { calendarFeedToken } from "../src/loans/calendar-feed.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

const prisma = new PrismaClient();
const dbUp = await prisma
  .$queryRaw`select 1`
  .then(() => true)
  .catch(() => false);

const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "first-password-1";
const marker = `cal${Date.now()}`;
const today = bangkokToday();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const compact = (d: Date) => formatDateOnly(d).replaceAll("-", "");

describe.skipIf(!dbUp)("calendar feed for Google / iCloud Calendar (PostgreSQL)", () => {
  let server: Server;
  let baseUrl: string;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const contractNos: Record<string, string> = {};
  let borrowerId: string;
  let adminId: string;

  const cookieOf = (res: Response) => res.headers.getSetCookie().find((r) => r.startsWith("loan_session="))!.split(";")[0]!;
  const login = async (username: string, password = PASSWORD) =>
    fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const feedLink = async (as: string | null) =>
    fetch(`${baseUrl}/admin/calendar/feed-link`, { headers: as ? { cookie: cookies[as]! } : {} });
  /** the whole feed, with folded lines joined back */
  const readFeed = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`);
    return { res, text: (await res.text()).replace(/\r\n /g, "") };
  };

  async function mkContract(label: string, status: "ACTIVE" | "CLOSED" | "AWAITING_DISBURSEMENT", dueIn: number) {
    const paidOut = status !== "AWAITING_DISBURSEMENT";
    const c = await prisma.contract.create({
      data: {
        contractNo: `C-${marker}-${label}`,
        borrowerId,
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
    contractNos[label] = c.contractNo;
    return c;
  }

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, passwordHash: await hashPassword(PASSWORD), role: "ADMIN", mustChangePassword: false } });
    const other = await prisma.user.create({ data: { username: `${marker}-b`, passwordHash: await hashPassword(PASSWORD), role: "BORROWER", mustChangePassword: false } });
    adminId = admin.id;
    userIds.push(admin.id, other.id);
    borrowerId = (await prisma.borrower.create({ data: { userId: other.id, fullName: `${marker} ผู้ยืมทดสอบ` } })).id;
    await mkContract("open", "ACTIVE", 10);
    await mkContract("late", "ACTIVE", -5);
    await mkContract("done", "CLOSED", 3);
    await mkContract("wait", "AWAITING_DISBURSEMENT", 3);

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
    cookies.admin = cookieOf(await login(`${marker}-admin`));
    cookies.borrower = cookieOf(await login(`${marker}-b`));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.contract.deleteMany({ where: { borrowerId } });
    await prisma.borrower.deleteMany({ where: { id: borrowerId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("gives the admin a private link and nobody else", async () => {
    const res = await feedLink("admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(/^\/calendar\/feed\/.+\.ics$/);
    expect(path).toBe(`/calendar/feed/${calendarFeedToken({ id: adminId, passwordHash: (await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).passwordHash }, SECRET)}.ics`);
    expect((await feedLink("borrower")).status).toBe(403);
    expect((await feedLink(null)).status).toBe(401);
  });

  it("serves open contracts as all-day events on their due dates, needing no login", async () => {
    const { path } = (await (await feedLink("admin")).json()) as { path: string };
    const { res, text } = await readFeed(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);

    const events = text.split("BEGIN:VEVENT\r\n").slice(1);
    const eventOf = (label: string) => events.find((e) => e.includes(contractNos[label]!));
    const open = eventOf("open")!;
    expect(open).toContain(`DTSTART;VALUE=DATE:${compact(addDays(today, 10))}`);
    expect(open).toContain(`DTEND;VALUE=DATE:${compact(addDays(today, 11))}`);
    expect(open).toContain(`SUMMARY:ครบกำหนด ${contractNos.open} · ${marker} ผู้ยืมทดสอบ`);
    expect(open).toContain("ยอดค้างชำระ 1\\,100 บาท");
    expect(open).toContain("TRIGGER:PT9H");
    expect(open).not.toContain("เลยกำหนด");

    // an overdue one sits on its past due date and says how late it is, with the late fee in what is owed
    const late = eventOf("late")!;
    expect(late).toContain(`DTSTART;VALUE=DATE:${compact(addDays(today, -5))}`);
    expect(late).toContain("เลยกำหนด 5 วัน");

    // settled and not-yet-paid-out contracts owe nothing to collect, so they are not in the calendar
    expect(eventOf("done")).toBeUndefined();
    expect(eventOf("wait")).toBeUndefined();
  });

  it("answers a wrong, altered or foreign token as not found", async () => {
    const { path } = (await (await feedLink("admin")).json()) as { path: string };
    const token = path.slice("/calendar/feed/".length, -".ics".length);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (const bad of [tampered, `${adminId}.`, adminId, "nonsense", `${adminId}.${"x".repeat(43)}`, `nobody.${token.split(".")[1]}`, "." + token.split(".")[1]]) {
      const res = await fetch(`${baseUrl}/calendar/feed/${encodeURIComponent(bad)}.ics`);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    // a borrower's id does not become an admin link
    const borrowerUser = userIds[1]!;
    const forged = calendarFeedToken({ id: borrowerUser, passwordHash: (await prisma.user.findUniqueOrThrow({ where: { id: borrowerUser } })).passwordHash }, SECRET);
    expect((await fetch(`${baseUrl}/calendar/feed/${forged}.ics`)).status).toBe(404);
    // a link made with another secret is no good either
    const other = calendarFeedToken({ id: adminId, passwordHash: (await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).passwordHash }, "another-secret-".padEnd(48, "z"));
    expect((await fetch(`${baseUrl}/calendar/feed/${other}.ics`)).status).toBe(404);
  });

  it("stops working when the admin's password changes, and when the admin is switched off", async () => {
    const { path } = (await (await feedLink("admin")).json()) as { path: string };
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(200);

    const original = (await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).passwordHash;
    await prisma.user.update({ where: { id: adminId }, data: { passwordHash: await hashPassword("a-new-password-2") } });
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(404);

    // the new password gives a new, working link
    await prisma.user.update({ where: { id: adminId }, data: { passwordHash: original } });
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(200);

    await prisma.user.update({ where: { id: adminId }, data: { isActive: false } });
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(404);
    await prisma.user.update({ where: { id: adminId }, data: { isActive: true } });
  });
});
