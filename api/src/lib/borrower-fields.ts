import { z } from "zod";

/**
 * The borrower's own contact, bank and identity details, validated one way wherever they are written: by the admin
 * (admin/borrowers.ts) and by the borrower themself (borrower/portal.ts, CR-5, CR-8).
 */
export const phoneField = z.string().trim().regex(/^[0-9+\-() ]{6,30}$/, "เบอร์โทรศัพท์ไม่ถูกต้อง");
export const bankNameField = z.string().trim().min(1).max(100);
export const bankAccountNoField = z.string().trim().regex(/^[0-9-]{6,30}$/, "เลขบัญชีไม่ถูกต้อง");

/**
 * Thai national ID number: 13 digits whose last digit is a check digit of the first twelve
 * (sum of digit × (13 − position), check = (11 − sum mod 11) mod 10).
 */
export function isValidNationalId(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

/** Accepts "1-2345-67890-12-1" or "1 2345 67890 12 1" and gives the 13 digits only. */
export const nationalIdField = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .refine((s) => /^\d{13}$/.test(s), "เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก")
  .refine(isValidNationalId, "เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบตัวเลขอีกครั้ง");

/** "1234567890121" -> "*********0121": enough to recognise a person in a list, not enough to use. */
export function maskNationalId(value: string): string {
  return value.length <= 4 ? "*".repeat(value.length) : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * A real name: first name and surname (at least two words), letters only (Thai or Latin, with the marks Thai needs),
 * so a nickname, a login name with digits or a single word is refused. Whether it matches the ID card is for the
 * admin to check against the photo; this only stops the obvious.
 */
const REAL_NAME = /^[\p{L}\p{M}][\p{L}\p{M}.'’-]*(?: [\p{L}\p{M}][\p{L}\p{M}.'’-]*)+$/u;

export const normalizeName = (s: string) => s.trim().replace(/\s+/g, " ");

export function realNameProblem(name: string, username?: string | null): string | null {
  const n = normalizeName(name);
  if (n.length > 200) return "ชื่อยาวไม่เกิน 200 ตัวอักษร";
  if (!REAL_NAME.test(n)) return "กรุณากรอกชื่อจริงและนามสกุลจริง (ตัวอักษรเท่านั้น ไม่ใช้ตัวเลข) เหมือนในบัตรประชาชน";
  if (username && n.toLowerCase() === username.toLowerCase()) return "ชื่อต้องเป็นชื่อจริง ไม่ใช่ชื่อผู้ใช้";
  return null;
}

/**
 * A borrower can use the system only when the lender knows who they are and can reach them and pay them:
 * real name confirmed, national ID number, ID-card photo, phone, bank and account number. The admin creates the account
 * with the name only; the borrower fills the rest in themself after the first login.
 */
export function isProfileComplete(b: {
  phone: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
  nationalId: string | null;
  idCardFileKey: string | null;
  realNameConfirmedAt: Date | null;
}): boolean {
  return !!(b.phone && b.bankName && b.bankAccountNo && b.nationalId && b.idCardFileKey && b.realNameConfirmedAt);
}
