import { randomBytes } from "node:crypto";
import type { LoginRateLimitOptions } from "../src/auth/routes.js";
import { FieldCipher } from "../src/lib/field-crypto.js";
import { LocalDiskSlipStorage } from "../src/lib/slip-storage.js";
import { LocalDiskImportStorage } from "../src/imports/storage.js";
import { TEST_IMPORT_DIR, TEST_SLIP_DIR } from "./slip-dir.js";

/** A throwaway key so tests never depend on the developer's real FIELD_ENCRYPTION_KEY. */
export const TEST_FIELD_KEY = randomBytes(32).toString("base64");

/** Throttling effectively off, for tests that are not about throttling. */
export const RELAXED_LOGIN_LIMITS: LoginRateLimitOptions = {
  maxFailuresPerPair: 1000,
  maxFailuresPerUser: 1000,
  maxFailuresPerIp: 1000,
  windowMs: 60_000,
};

/** Slips written by tests go to a shared temp folder that test/global-setup.ts empties before and after the run. */
export const TEST_SLIP_STORAGE = new LocalDiskSlipStorage(TEST_SLIP_DIR);

/** Import files staged by tests live in a shared temp folder emptied by test/global-setup.ts. */
export const TEST_IMPORT_STORAGE = new LocalDiskImportStorage(TEST_IMPORT_DIR);

/**
 * The phone, bank and (encrypted) account number a borrower must have filled in before they can ask for a loan
 * (CR-5). Spread into `prisma.borrower.create({ data: { ..., ...completeProfile() } })` in tests that file requests.
 */
export const completeProfile = () => ({
  phone: "081-234-5678",
  bankName: "ธนาคารทดสอบ",
  bankAccountNo: new FieldCipher(TEST_FIELD_KEY).encrypt("123-4-56789-0"),
});
