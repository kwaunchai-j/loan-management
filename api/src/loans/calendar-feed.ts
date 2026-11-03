import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "../db.js";
import { asyncHandler, sendError } from "../http.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { buildCalendar } from "../lib/ics.js";
import { passwordVersion } from "../lib/session.js";
import { formatBaht, formatThaiDate } from "../notifications/format.js";
import { computeState, detailInclude } from "./queries.js";

/**
 * The due-date calendar as an iCalendar feed that Google Calendar ("From URL") and iCloud / Apple Calendar
 * (webcal://) can subscribe to. A calendar app cannot log in, so the link itself is the credential:
 *   token = <admin user id>.<HMAC(SESSION_SECRET, id + password fingerprint)>
 * It is never stored. Changing or resetting the admin's password changes the fingerprint, which turns the old
 * link into "not found" — that is how a leaked link is revoked. A wrong token and an unknown admin look the same.
 *
 * One all-day event per open (ACTIVE) contract, on its due date, with what is owed as of the moment the feed is read.
 */
const MAX_CONTRACTS = 2000;
/** The calendar app alerts at 09:00 on the due date (the same hour as the "due today" notification). */
const ALERT_HOUR = 9;
const FILE_SUFFIX = ".ics";

const mac = (secret: string, userId: string, passwordHash: string) =>
  createHmac("sha256", secret).update(`calendar-feed\n${userId}\n${passwordVersion(passwordHash)}`).digest("base64url");

export function calendarFeedToken(user: { id: string; passwordHash: string }, secret: string): string {
  return `${user.id}.${mac(secret, user.id, user.passwordHash)}`;
}

/** The admin the token belongs to, or null for anything that is not a currently valid token. */
export async function adminForFeedToken(prisma: Db, token: string, secret: string): Promise<{ id: string } | null> {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  if (userId.length > 64) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true, passwordHash: true } });
  if (!user || user.role !== "ADMIN" || !user.isActive) return null;
  const given = Buffer.from(token);
  const expected = Buffer.from(calendarFeedToken(user, secret));
  return given.length === expected.length && timingSafeEqual(given, expected) ? { id: user.id } : null;
}

export async function dueDateFeed(prisma: Db, now: Date = new Date()): Promise<string> {
  const today = bangkokToday(now);
  const contracts = await prisma.contract.findMany({
    where: { status: "ACTIVE" },
    include: detailInclude,
    orderBy: [{ dueDate: "asc" }, { contractNo: "asc" }],
    take: MAX_CONTRACTS,
  });
  return buildCalendar({
    name: "วันครบกำหนดชำระ",
    description: "สัญญาเงินยืมที่ยังค้างชำระ แสดงในวันครบกำหนด",
    stamp: now,
    events: contracts.map((c) => {
      const { state, isOverdue, daysOverdue } = computeState(c, today);
      const owed = state.outstandingPrincipal.plus(state.outstandingInterest).plus(state.accruedLateFee);
      return {
        uid: `contract-${c.id}@loan-manage`,
        day: formatDateOnly(c.dueDate),
        summary: `ครบกำหนด ${c.contractNo} · ${c.borrower.fullName}`,
        description: [
          `สัญญา ${c.contractNo} ผู้ยืม ${c.borrower.fullName}`,
          `ครบกำหนด ${formatThaiDate(c.dueDate)}`,
          `ยอดค้างชำระ ${formatBaht(owed)} บาท (ณ ${formatThaiDate(today)})`,
          ...(isOverdue ? [`เลยกำหนด ${daysOverdue} วัน`] : []),
        ].join("\n"),
        alertAtHour: ALERT_HOUR,
      };
    }),
  });
}

/** PUBLIC (the token is the credential). Mounted at /calendar. */
export function createCalendarFeedRouter(deps: { prisma: Db; sessionSecret: string }): Router {
  const router = Router();
  router.get(
    "/feed/:file",
    asyncHandler(async (req, res) => {
      const file = String(req.params.file);
      const token = file.endsWith(FILE_SUFFIX) ? file.slice(0, -FILE_SUFFIX.length) : file;
      const admin = await adminForFeedToken(deps.prisma, token, deps.sessionSecret);
      if (!admin) return sendError(res, 404, "NOT_FOUND", "ไม่พบปฏิทินนี้");
      res
        .status(200)
        .set({
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'inline; filename="due-dates.ics"',
          // the link is private; keep proxies and shared caches from holding the lender's data
          "cache-control": "private, max-age=300",
          "x-robots-tag": "noindex",
        })
        .send(await dueDateFeed(deps.prisma));
    }),
  );
  return router;
}
