/**
 * Calendar dates (@db.Date) are handled as "date-only" Date values: UTC midnight of the
 * Asia/Bangkok calendar date. Never use the server's local time for business dates.
 */
const bangkokFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in Asia/Bangkok as a date-only value. */
export function bangkokToday(now: Date = new Date()): Date {
  return new Date(`${bangkokFormat.format(now)}T00:00:00.000Z`);
}

/** Strict "YYYY-MM-DD" -> date-only Date; null when malformed or not a real calendar date. */
export function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const bangkokClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes since midnight, Asia/Bangkok (0..1439). */
export function bangkokMinutesOfDay(now: Date = new Date()): number {
  const parts = bangkokClock.formatToParts(now);
  const num = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return num("hour") * 60 + num("minute");
}

/** "HH:MM" -> minutes since midnight; throws on anything else. */
export function parseClockTime(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`invalid time "${hhmm}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}
