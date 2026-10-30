import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with Node's built-in scrypt (no extra dependency).
 * Stored format: scrypt$N$r$p$<salt b64>$<hash b64> — parameters travel with the hash so
 * they can be raised later without invalidating existing passwords.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const PASSWORD_MIN_LENGTH = 10;
// Upper bound keeps scrypt input (and so CPU/memory per request) bounded.
export const PASSWORD_MAX_LENGTH = 128;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number) {
  const options: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, len, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length === 0) return false;
  const actual = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

/** Why a candidate password is unacceptable, or null when it is fine. */
export function passwordPolicyViolation(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `รหัสผ่านต้องไม่เกิน ${PASSWORD_MAX_LENGTH} ตัวอักษร`;
  }
  return null;
}
