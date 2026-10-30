import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-level encryption for sensitive columns (currently Borrower.bankAccountNo, decision D1).
 * AES-256-GCM, random 96-bit IV per value, stored as  enc:v1:<iv>:<tag>:<ciphertext>  (base64url).
 * The key lives only in the environment (FIELD_ENCRYPTION_KEY, 32 random bytes, base64). Losing the
 * key makes the encrypted values unrecoverable — back it up separately from the database.
 * The "v1" tag leaves room to rotate to a new key/format later without guessing what a value is.
 */
const PREFIX = "enc:v1:";
const AAD = Buffer.from("loan-management:field:v1");

export class FieldCryptoError extends Error {}

export function parseFieldKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new FieldCryptoError("FIELD_ENCRYPTION_KEY must be 32 random bytes encoded as base64");
  }
  return key;
}

export class FieldCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = parseFieldKey(keyBase64);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${body.toString("base64url")}`;
  }

  /** Throws FieldCryptoError for anything that is not a valid value made with this key. */
  decrypt(stored: string): string {
    if (!stored.startsWith(PREFIX)) {
      // Never pass plaintext through silently: a value that is not encrypted is a bug.
      throw new FieldCryptoError("value is not encrypted");
    }
    const parts = stored.slice(PREFIX.length).split(":");
    if (parts.length !== 3) throw new FieldCryptoError("malformed encrypted value");
    try {
      const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new FieldCryptoError("could not decrypt value (wrong key or tampered data)");
    }
  }
}

/** "****6789" — enough to recognise an account in an audit trail, not enough to use it. */
export function maskAccountNumber(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length > 4 ? `****${digits.slice(-4)}` : "****";
}
