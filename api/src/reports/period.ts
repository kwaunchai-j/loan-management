import { z } from "zod";
import { formatDateOnly, parseDateOnly } from "../lib/dates.js";

/**
 * The period every report can be filtered by (DES-015, F9): a month, a year, or a custom
 * from–to range of Asia/Bangkok calendar days, both ends included. No filter = all time.
 *   ?month=2026-10   ?year=2026   ?from=2026-10-01&to=2026-10-31
 */
export interface Period {
  kind: "month" | "year" | "range" | "all";
  from: Date;
  to: Date;
}

const ALL_FROM = new Date("1970-01-01T00:00:00.000Z");
const ALL_TO = new Date("2999-12-31T00:00:00.000Z");
const MS_PER_DAY = 86_400_000;
/** A sanity limit on a custom range (about 10 years). */
const MAX_RANGE_DAYS = 3700;

const raw = z.object({
  month: z.string().optional(),
  year: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export class PeriodError extends Error {}

export function parsePeriod(query: unknown): Period {
  const q = raw.safeParse(query);
  if (!q.success) throw new PeriodError("ช่วงเวลาไม่ถูกต้อง");
  const { month, year, from, to } = q.data;
  const forms = [month !== undefined, year !== undefined, from !== undefined || to !== undefined].filter(Boolean).length;
  if (forms === 0) return { kind: "all", from: ALL_FROM, to: ALL_TO };
  if (forms > 1) throw new PeriodError("ระบุช่วงเวลาได้แบบเดียว: เดือน หรือ ปี หรือ จากวันที่–ถึงวันที่");

  if (month !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    const start = m ? parseDateOnly(`${month}-01`) : null;
    if (!m || !start) throw new PeriodError("เดือนต้องอยู่ในรูปแบบ YYYY-MM");
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)); // day 0 of next month = last day of this one
    return { kind: "month", from: start, to: end };
  }
  if (year !== undefined) {
    if (!/^\d{4}$/.test(year) || Number(year) < 1970) throw new PeriodError("ปีต้องเป็นตัวเลข 4 หลัก (ค.ศ.)");
    return { kind: "year", from: new Date(`${year}-01-01T00:00:00.000Z`), to: new Date(`${year}-12-31T00:00:00.000Z`) };
  }
  const f = from ? parseDateOnly(from) : null;
  const t = to ? parseDateOnly(to) : null;
  if (!f || !t) throw new PeriodError("ต้องระบุทั้งวันที่เริ่มต้น (from) และสิ้นสุด (to) ในรูปแบบ YYYY-MM-DD");
  if (t.getTime() < f.getTime()) throw new PeriodError("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น");
  if ((t.getTime() - f.getTime()) / MS_PER_DAY > MAX_RANGE_DAYS) throw new PeriodError("ช่วงวันที่ยาวเกินไป (ไม่เกินประมาณ 10 ปี)");
  return { kind: "range", from: f, to: t };
}

export function periodView(p: Period) {
  return p.kind === "all"
    ? { kind: p.kind, from: null, to: null }
    : { kind: p.kind, from: formatDateOnly(p.from), to: formatDateOnly(p.to) };
}
