/**
 * Money and calendar dates in the browser. Amounts arrive from the API as exact decimal strings and
 * are only ever formatted or compared as TEXT — never turned into `number` — so no rounding can creep
 * in. The API decides every figure; this file only shows it and checks what the user typed.
 */
import type { Check } from "./validation";

/** "1234.5" -> "1,234.50", "1234.00" -> "1,234" (whole baht have no decimals); anything that is not a plain decimal is returned as is. */
export function formatBaht(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return value;
  const [, sign = "", whole = "0", frac = ""] = m;
  const grouped = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = frac.length >= 2 ? frac : frac.padEnd(2, "0");
  // amounts are whole baht (interest and late fee are rounded up to the baht): show ".00" only when satang really exist
  return /^0+$/.test(cents) ? `${sign}${grouped}` : `${sign}${grouped}.${cents}`;
}

/** True when the decimal string is zero (for "nothing left to pay"). */
export function isZeroMoney(value: string): boolean {
  return !/[1-9]/.test(value);
}

/** An amount to pay or lend: more than 0, at most 12 digits before and 2 after the point (the API's rule). */
export function checkMoney(v: string, label = "จำนวนเงิน"): Check {
  const s = v.trim();
  if (s === "") return `กรุณากรอก${label}`;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s) || isZeroMoney(s)) return `${label}ต้องมากกว่า 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง`;
  return null;
}

/** "YYYY-MM-DD" and a real calendar day. */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function checkDate(v: string, label: string): Check {
  const s = v.trim();
  if (s === "") return `กรุณาเลือก${label}`;
  return isRealDate(s) ? null : `${label}ไม่ถูกต้อง`;
}

const bangkokDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's date in Thailand ("YYYY-MM-DD"), whatever time zone the phone is set to. */
export function todayBangkok(now: Date = new Date()): string {
  return bangkokDay.format(now);
}

/** "2026-11-30" -> "30 พ.ย. 2569" (Buddhist Era). */
export function formatDay(day: string | null | undefined): string {
  if (!day || !isRealDate(day)) return day ?? "-";
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("th-TH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

const THAI_DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const THAI_PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/** One group of up to 6 digits (below a million). `hasHigher`: a larger group comes before it, so a lone 1 is "เอ็ด". */
function readThaiGroup(group: string, hasHigher: boolean): string {
  const digits = group.replace(/^0+/, "");
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[i]);
    const place = digits.length - 1 - i;
    if (d === 0) continue;
    if (place === 0) out += d === 1 && (digits.length > 1 || hasHigher) ? "เอ็ด" : THAI_DIGITS[d];
    else if (place === 1) out += d === 1 ? "สิบ" : d === 2 ? "ยี่สิบ" : `${THAI_DIGITS[d]}สิบ`;
    else out += `${THAI_DIGITS[d]}${THAI_PLACES[place]}`;
  }
  return out;
}

function readThaiInteger(whole: string): string {
  const digits = whole.replace(/^0+/, "");
  if (digits === "") return THAI_DIGITS[0]!;
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 6) groups.unshift(digits.slice(Math.max(0, end - 6), end));
  return groups
    .map((g, i) => (/^0+$/.test(g) ? "" : readThaiGroup(g, i > 0 || /[1-9]/.test(groups.slice(0, i).join(""))) + (i < groups.length - 1 ? "ล้าน" : "")))
    .join("");
}

/** "1234.5" -> "หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์", "5000" -> "ห้าพันบาทถ้วน" (the amount in words, as a Thai contract writes it). */
export function bahtText(value: string | null | undefined): string {
  const m = value === null || value === undefined ? null : /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return "";
  const whole = m[1]!;
  const satang = (m[2] ?? "").padEnd(2, "0").slice(0, 2);
  const baht = /^0*$/.test(whole) ? "" : `${readThaiInteger(whole)}บาท`;
  if (satang === "00") return baht === "" ? `${THAI_DIGITS[0]}บาทถ้วน` : `${baht}ถ้วน`;
  return `${baht}${readThaiInteger(satang)}สตางค์`;
}
