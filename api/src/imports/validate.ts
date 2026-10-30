import { Prisma } from "@prisma/client";
import { parseDateOnly } from "../lib/dates.js";
import { ImportFileError, type Cell, type Rows } from "./parse-file.js";

/**
 * Turns the cells of the template into checked rows (DES-014). The template has exactly these four
 * columns, in this order, header in row 1:
 *   ชื่อผู้ยืม | จำนวนเงิน (เงินต้นล้วน) | ดอกเบี้ย (บวกเพิ่ม ว่าง = 0) | วันครบกำหนด
 * A row that fails a check is NOT imported and carries its reasons; a completely blank row is skipped.
 */
export const HEADER = ["ชื่อผู้ยืม", "จำนวนเงิน", "ดอกเบี้ย", "วันครบกำหนด"] as const;

const MAX_MONEY = new Prisma.Decimal("999999999999.99"); // Decimal(14,2)
const MAX_NAME_LENGTH = 200;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** Same person, different spacing: Thai names pasted into a sheet often carry stray spaces. */
export function normalizeName(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ");
}

export interface ParsedRow {
  /** Spreadsheet row number (the header is row 1). */
  rowNumber: number;
  name: string;
  amount: Prisma.Decimal | null;
  interest: Prisma.Decimal | null;
  dueDate: Date | null;
  errors: string[];
}

const isBlank = (c: Cell | undefined) => c === null || c === undefined || (typeof c === "string" && c.trim() === "");

function text(c: Cell | undefined): string {
  if (c === null || c === undefined) return "";
  if (typeof c === "string") return c;
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c);
}

function money(c: Cell | undefined, what: string, allowZero: boolean): { value: Prisma.Decimal | null; error?: string } {
  if (isBlank(c)) return { value: null };
  if (typeof c === "boolean" || c instanceof Date) return { value: null, error: `${what}ไม่ถูกต้อง` };
  // a spreadsheet number is read through its shortest text form, so what the user typed is what we get
  const raw = typeof c === "number" ? (Number.isFinite(c) ? String(c) : "x") : String(c);
  const s = raw.trim().replace(/[,\s]/g, "").replace(/^฿/, "").replace(/บาท$/, "");
  if (/^-/.test(s)) return { value: null, error: `${what}ต้องไม่ติดลบ` };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) {
    return { value: null, error: `${what}ไม่ถูกต้อง (เป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง)` };
  }
  const value = new Prisma.Decimal(s);
  if (value.gt(MAX_MONEY)) return { value: null, error: `${what}เกินขีดจำกัดของระบบ` };
  if (!allowZero && !value.gt(0)) return { value: null, error: `${what}ต้องมากกว่า 0` };
  return { value };
}

function inRange(d: Date | null): Date | null {
  return d && d.getUTCFullYear() >= MIN_YEAR && d.getUTCFullYear() <= MAX_YEAR ? d : null;
}

/** Accepts a spreadsheet date, YYYY-MM-DD, D/M/YYYY (year in the Buddhist Era if 2400 or more), or an Excel date serial. */
export function parseDueDate(c: Cell | undefined): Date | null {
  if (c === null || c === undefined || isBlank(c) || typeof c === "boolean") return null;
  if (c instanceof Date) {
    // a date cell has no time zone: take its calendar day as stored
    return Number.isNaN(c.getTime()) ? null : inRange(new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate())));
  }
  if (typeof c === "number") {
    // a date typed into a cell that is not formatted as a date arrives as the Excel serial number
    if (!Number.isInteger(c)) return null;
    return inRange(new Date(EXCEL_EPOCH_UTC + c * MS_PER_DAY));
  }
  const s = c.trim();
  const iso = parseDateOnly(s);
  if (iso) return inRange(iso);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  let year = Number(m[3]);
  if (year >= 2400) year -= 543; // Buddhist Era
  return inRange(parseDateOnly(`${String(year).padStart(4, "0")}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`));
}

export function parseRows(rows: Rows): ParsedRow[] {
  const header = rows[0];
  if (!header) throw new ImportFileError("ไฟล์ว่างเปล่า");
  const cells = header.slice(0, HEADER.length).map((c) => text(c).trim());
  const extra = header.slice(HEADER.length).some((c) => !isBlank(c));
  if (extra || HEADER.some((h, i) => cells[i] !== h)) {
    throw new ImportFileError(`ไฟล์ไม่ตรงแม่แบบ: แถวแรกต้องเป็น ${HEADER.join(" | ")} ตามลำดับ (ดาวน์โหลดแม่แบบจากระบบ)`);
  }

  const out: ParsedRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.every((c) => isBlank(c))) continue; // blank line: nothing to import, nothing to report
    const errors: string[] = [];
    if (r.slice(HEADER.length).some((c) => !isBlank(c))) errors.push("มีข้อมูลเกิน 4 คอลัมน์");

    const name = normalizeName(text(r[0]));
    if (name === "") errors.push("ชื่อผู้ยืมว่าง");
    else if (name.length > MAX_NAME_LENGTH) errors.push(`ชื่อผู้ยืมยาวเกิน ${MAX_NAME_LENGTH} ตัวอักษร`);

    let amount: Prisma.Decimal | null = null;
    if (isBlank(r[1])) errors.push("จำนวนเงินว่าง");
    else {
      const a = money(r[1], "จำนวนเงิน", false);
      amount = a.value;
      if (a.error) errors.push(a.error);
    }

    // blank interest means 0 (DES-014)
    let interest: Prisma.Decimal | null = new Prisma.Decimal(0);
    if (!isBlank(r[2])) {
      const iv = money(r[2], "ดอกเบี้ย", true);
      interest = iv.value;
      if (iv.error) errors.push(iv.error);
    }

    const dueDate = parseDueDate(r[3]);
    if (isBlank(r[3])) errors.push("วันครบกำหนดว่าง");
    else if (!dueDate) errors.push("วันครบกำหนดไม่ถูกต้อง (ใช้ปี-เดือน-วัน เช่น 2026-12-31 หรือ วัน/เดือน/ปี เช่น 31/12/2026)");

    out.push({ rowNumber: i + 1, name, amount, interest, dueDate, errors });
  }
  if (out.length === 0) throw new ImportFileError("ไม่มีข้อมูลให้นำเข้า (มีแต่แถวหัวตาราง)");
  return out;
}
