/**
 * Quick checks in the form so people see a mistake before sending. They MIRROR the API's rules
 * (api/src/admin/borrowers.ts, api/src/lib/password.ts, api/src/admin/settings.ts) but never replace
 * them: the API checks everything again and its message is shown if it disagrees.
 * Each returns a Thai message, or null when the value is fine.
 */
export type Check = string | null;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function checkRequired(value: string, label: string): Check {
  return value.trim() === "" ? `กรุณากรอก${label}` : null;
}

export function checkUsername(v: string): Check {
  const s = v.trim();
  if (s === "") return "กรุณากรอกชื่อผู้ใช้";
  if (/\s/.test(s)) return "ชื่อผู้ใช้ต้องไม่มีช่องว่าง";
  if (s.length > 64) return "ชื่อผู้ใช้ยาวไม่เกิน 64 ตัวอักษร";
  return null;
}

export function checkPassword(v: string): Check {
  if (v.length < PASSWORD_MIN) return `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัวอักษร`;
  if (v.length > PASSWORD_MAX) return `รหัสผ่านต้องไม่เกิน ${PASSWORD_MAX} ตัวอักษร`;
  return null;
}

export function checkFullName(v: string): Check {
  const s = v.trim();
  if (s === "") return "กรุณากรอกชื่อ-นามสกุล";
  if (s.length > 200) return "ชื่อยาวไม่เกิน 200 ตัวอักษร";
  return null;
}

export function checkPhone(v: string): Check {
  return /^[0-9+\-() ]{6,30}$/.test(v.trim()) ? null : "เบอร์โทรศัพท์ไม่ถูกต้อง (ตัวเลข 6–30 ตัว)";
}

export function checkBankName(v: string): Check {
  const s = v.trim();
  if (s === "") return "กรุณากรอกชื่อธนาคาร";
  if (s.length > 100) return "ชื่อธนาคารยาวไม่เกิน 100 ตัวอักษร";
  return null;
}

export function checkBankAccount(v: string): Check {
  return /^[0-9-]{6,30}$/.test(v.trim()) ? null : "เลขบัญชีไม่ถูกต้อง (ตัวเลขและขีด 6–30 ตัว)";
}

/** The lender's receiving account (mirrors api/src/admin/payment-account.ts): 5–30 characters, digits with spaces or hyphens between. */
export function checkPaymentAccountNo(v: string): Check {
  return /^[0-9][0-9 -]{3,28}[0-9]$/.test(v.trim()) ? null : "เลขบัญชีต้องเป็นตัวเลข 5–30 หลัก (คั่นด้วยช่องว่างหรือขีดได้)";
}

export function checkAccountName(v: string): Check {
  const s = v.trim();
  if (s === "") return "กรุณากรอกชื่อบัญชี";
  if (s.length > 150) return "ชื่อบัญชียาวไม่เกิน 150 ตัวอักษร";
  return null;
}

/** A rate in % : not negative, at most 3 digits before and 4 after the point (the column limit). */
export function checkRate(v: string): Check {
  const s = v.trim();
  if (s === "") return "กรุณากรอกอัตรา";
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) return "อัตราต้องเป็นตัวเลขไม่ติดลบ ไม่เกิน 999.9999 และมีทศนิยมไม่เกิน 4 ตำแหน่ง";
  return null;
}

/** "02.50" -> "2.5", "007" -> "7": the same number written one way, so a change can be told from a re-typed value. */
export function normalizeRate(s: string): string {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return t;
  const [whole = "0", frac = ""] = t.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

/** "123-4-56789-0" -> "****7890": enough to recognise an account, not enough to use it. */
export function maskAccount(v: string | null): string {
  if (!v) return "-";
  const digits = v.replace(/\D/g, "");
  return digits.length > 4 ? `****${digits.slice(-4)}` : "****";
}

// no 0/O, 1/l/I: nothing to misread when a password is read out or typed from a message
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random temporary password from the browser's secure random source (no modulo bias). */
export function generatePassword(length = 12, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte < limit && out.length < length) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

/** Thai national ID number: 13 digits, the last a check digit (mirrors api/src/lib/borrower-fields.ts). Dashes and spaces are allowed. */
export function checkNationalId(v: string): Check {
  const s = v.trim().replace(/[\s-]/g, "");
  if (s === "") return "กรุณากรอกเลขบัตรประชาชน";
  if (!/^\d{13}$/.test(s)) return "เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก";
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]) ? null : "เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบตัวเลขอีกครั้ง";
}

const REAL_NAME = /^[\p{L}\p{M}][\p{L}\p{M}.'’-]*(?: [\p{L}\p{M}][\p{L}\p{M}.'’-]*)+$/u;

/** A real first name and surname, letters only, as on the ID card (mirrors api/src/lib/borrower-fields.ts realNameProblem). */
export function checkRealName(v: string, username?: string | null): Check {
  const s = v.trim().replace(/\s+/g, " ");
  if (s === "") return "กรุณากรอกชื่อ-นามสกุลจริง";
  if (s.length > 200) return "ชื่อยาวไม่เกิน 200 ตัวอักษร";
  if (!REAL_NAME.test(s)) return "กรุณากรอกชื่อจริงและนามสกุลจริง (ตัวอักษรเท่านั้น ไม่ใช้ตัวเลข) เหมือนในบัตรประชาชน";
  if (username && s.toLowerCase() === username.toLowerCase()) return "ชื่อต้องเป็นชื่อจริง ไม่ใช่ชื่อผู้ใช้";
  return null;
}

/** "1101700230732" -> "*********0732". */
export function maskNationalId(v: string | null): string {
  if (!v) return "-";
  return v.length <= 4 ? "*".repeat(v.length) : `${"*".repeat(v.length - 4)}${v.slice(-4)}`;
}
