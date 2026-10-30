import { formatDay, isRealDate, todayBangkok } from "./money";

/**
 * The period a report is asked for (DES-015, F9): all time, one month, one year (ค.ศ.), or a custom
 * range of days with both ends included. Mirrors api/src/reports/period.ts; the API checks again.
 */
export type PeriodKind = "all" | "month" | "year" | "range";

export interface PeriodSelection {
  kind: PeriodKind;
  month: string; // "2026-10"
  year: string; // "2026"
  from: string; // "2026-10-01"
  to: string;
}

const MAX_RANGE_DAYS = 3700;

export function defaultSelection(now: Date = new Date()): PeriodSelection {
  const today = todayBangkok(now);
  return { kind: "month", month: today.slice(0, 7), year: today.slice(0, 4), from: `${today.slice(0, 7)}-01`, to: today };
}

export type PeriodQuery = { ok: true; query: string } | { ok: false; error: string };

/** The query string for the chosen period, or the Thai reason it is not valid. */
export function buildPeriodQuery(p: PeriodSelection): PeriodQuery {
  switch (p.kind) {
    case "all":
      return { ok: true, query: "" };
    case "month":
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) && Number(p.month.slice(0, 4)) >= 1970
        ? { ok: true, query: `month=${p.month}` }
        : { ok: false, error: "กรุณาเลือกเดือน" };
    case "year":
      return /^\d{4}$/.test(p.year) && Number(p.year) >= 1970
        ? { ok: true, query: `year=${p.year}` }
        : { ok: false, error: "ปีต้องเป็นตัวเลข 4 หลัก (ค.ศ. เช่น 2026)" };
    case "range": {
      if (!isRealDate(p.from) || !isRealDate(p.to)) return { ok: false, error: "กรุณาเลือกวันที่เริ่มต้นและสิ้นสุดให้ครบ" };
      if (p.to < p.from) return { ok: false, error: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น" };
      const days = (Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000;
      if (days > MAX_RANGE_DAYS) return { ok: false, error: "ช่วงวันที่ยาวเกินไป (ไม่เกินประมาณ 10 ปี)" };
      return { ok: true, query: `from=${p.from}&to=${p.to}` };
    }
  }
}

/** The period the API actually used, in words ("ตุลาคม 2569", "ปี 2569", "1 ต.ค. 2569 – 31 ต.ค. 2569"). */
export function periodLabel(p: { kind: PeriodKind; from: string | null; to: string | null }): string {
  if (p.kind === "all" || !p.from || !p.to) return "ทุกช่วงเวลา";
  if (p.kind === "month") {
    return new Date(`${p.from}T00:00:00.000Z`).toLocaleDateString("th-TH", { timeZone: "UTC", month: "long", year: "numeric" });
  }
  if (p.kind === "year") return `ปี ${Number(p.from.slice(0, 4)) + 543}`;
  return `${formatDay(p.from)} – ${formatDay(p.to)}`;
}
