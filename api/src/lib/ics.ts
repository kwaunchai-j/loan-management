/**
 * A minimal iCalendar (RFC 5545) writer: just enough for all-day events that Google Calendar, Apple/iCloud
 * Calendar and Outlook can subscribe to. Text is escaped and every line is folded at 75 octets.
 */
const CRLF = "\r\n";
const FOLD_LIMIT = 75;

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

/** Lines longer than 75 octets continue on the next line after one space (never splitting a character). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > FOLD_LIMIT) {
      out.push(cur);
      cur = ` ${ch}`;
      bytes = 1 + size;
    } else {
      cur += ch;
      bytes += size;
    }
  }
  out.push(cur);
  return out.join(CRLF);
}

/** "2026-11-02" -> "20261102" */
export const icsDate = (day: string): string => day.replaceAll("-", "");

/** A Date -> "20261102T031500Z" (UTC). */
export const icsTimestamp = (d: Date): string => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

export interface AllDayEvent {
  uid: string;
  /** "YYYY-MM-DD" */
  day: string;
  summary: string;
  description: string;
  /** Hours after midnight of the day at which the calendar app should alert; omitted = no alert. */
  alertAtHour?: number;
}

export interface Calendar {
  name: string;
  description: string;
  events: AllDayEvent[];
  stamp: Date;
}

const nextDay = (day: string): string => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

export function buildCalendar(cal: Calendar): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//loan-manage//due-dates//TH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(cal.name)}`,
    `X-WR-CALDESC:${escapeText(cal.description)}`,
    "X-WR-TIMEZONE:Asia/Bangkok",
    // hints for how often a subscribed calendar should be re-read (apps may ignore them)
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  const stamp = icsTimestamp(cal.stamp);
  for (const e of cal.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(e.day)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(e.day))}`,
      `SUMMARY:${escapeText(e.summary)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
      // an all-day reminder must not make the lender look "busy"
      "TRANSP:TRANSPARENT",
      "STATUS:CONFIRMED",
    );
    if (e.alertAtHour !== undefined) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:PT${e.alertAtHour}H`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}
