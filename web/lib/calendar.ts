/**
 * Calendar layout only: which weekday a month starts on, how many days it has, the Thai names.
 * No amount is worked out here — the figures on every day come from the API.
 * A month is the text "YYYY-MM" and a day "YYYY-MM-DD" (Thailand's calendar), never a local-time Date.
 */
export const WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"] as const;

export function parseMonth(month: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

export function formatMonth(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** The month before (-1) or after (+1) another, rolling over the year. */
export function shiftMonth(month: string, delta: number): string {
  const p = parseMonth(month);
  if (!p) return month;
  const index = p.year * 12 + (p.month - 1) + delta;
  return formatMonth(Math.floor(index / 12), (index % 12) + 1);
}

export function daysInMonth(month: string): number {
  const p = parseMonth(month);
  return p ? new Date(Date.UTC(p.year, p.month, 0)).getUTCDate() : 0;
}

/** The cells of a month laid out from Sunday: blanks (null) before day 1, then every date as "YYYY-MM-DD". */
export function monthCells(month: string): Array<string | null> {
  const p = parseMonth(month);
  if (!p) return [];
  const lead = new Date(Date.UTC(p.year, p.month - 1, 1)).getUTCDay();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth(month); d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  return cells;
}

/** "2026-10" -> "ตุลาคม 2569" (Buddhist Era). */
export function monthLabel(month: string): string {
  const p = parseMonth(month);
  if (!p) return month;
  return new Date(Date.UTC(p.year, p.month - 1, 1)).toLocaleDateString("th-TH", { timeZone: "UTC", month: "long", year: "numeric" });
}

/** "2026-10-30" -> "30 ตุลาคม 2569". */
export function longDay(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("th-TH", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}
