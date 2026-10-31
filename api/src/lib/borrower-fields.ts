import { z } from "zod";

/**
 * The borrower's own contact and bank details, validated one way wherever they are written: by the admin
 * (admin/borrowers.ts) and by the borrower themself (borrower/portal.ts, CR-5).
 */
export const phoneField = z.string().trim().regex(/^[0-9+\-() ]{6,30}$/, "เบอร์โทรศัพท์ไม่ถูกต้อง");
export const bankNameField = z.string().trim().min(1).max(100);
export const bankAccountNoField = z.string().trim().regex(/^[0-9-]{6,30}$/, "เลขบัญชีไม่ถูกต้อง");

/**
 * A borrower can ask for a loan only when the lender can reach them and knows where to send the money:
 * a phone number, a bank and an account number. The admin creates the account with the name only; the
 * borrower fills these in themself after the first login.
 */
export function isProfileComplete(b: { phone: string | null; bankName: string | null; bankAccountNo: string | null }): boolean {
  return !!(b.phone && b.bankName && b.bankAccountNo);
}
