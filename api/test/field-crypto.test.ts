import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FieldCipher,
  FieldCryptoError,
  maskAccountNumber,
  parseFieldKey,
} from "../src/lib/field-crypto.js";

const key = () => randomBytes(32).toString("base64");

describe("FieldCipher", () => {
  it("round-trips values, including Thai text and digits with dashes", () => {
    const c = new FieldCipher(key());
    for (const v of ["123-4-56789-0", "0123456789", "บัญชี 123", "x"]) {
      expect(c.decrypt(c.encrypt(v))).toBe(v);
    }
  });

  it("never stores the plaintext and uses a fresh IV every time", () => {
    const c = new FieldCipher(key());
    const a = c.encrypt("123-4-56789-0");
    const b = c.encrypt("123-4-56789-0");
    expect(a).not.toBe(b);
    expect(a.startsWith("enc:v1:")).toBe(true);
    expect(a).not.toContain("56789");
  });

  it("rejects tampered ciphertext, tag or IV", () => {
    const c = new FieldCipher(key());
    // enc : v1 : <iv> : <tag> : <ciphertext>
    const [, , iv, tag, body] = c.encrypt("123-4-56789-0").split(":") as [string, string, string, string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `enc:v1:${iv}:${tag}:${flip(body)}`,
      `enc:v1:${flip(iv)}:${tag}:${body}`,
      `enc:v1:${iv}:${flip(tag)}:${body}`,
    ]) {
      expect(() => c.decrypt(bad)).toThrow(FieldCryptoError);
    }
  });

  it("cannot be read with another key", () => {
    const stored = new FieldCipher(key()).encrypt("123-4-56789-0");
    expect(() => new FieldCipher(key()).decrypt(stored)).toThrow(FieldCryptoError);
  });

  it("refuses to treat a plain or malformed value as encrypted", () => {
    const c = new FieldCipher(key());
    expect(() => c.decrypt("123-4-56789-0")).toThrow(FieldCryptoError);
    expect(() => c.decrypt("enc:v1:onlyone")).toThrow(FieldCryptoError);
    expect(() => c.decrypt("enc:v2:a:b:c")).toThrow(FieldCryptoError);
    expect(() => c.decrypt("")).toThrow(FieldCryptoError);
  });

  it("requires a 32-byte key", () => {
    expect(() => new FieldCipher("")).toThrow(FieldCryptoError);
    expect(() => new FieldCipher(randomBytes(16).toString("base64"))).toThrow(FieldCryptoError);
    expect(() => parseFieldKey(randomBytes(33).toString("base64"))).toThrow(FieldCryptoError);
    expect(parseFieldKey(key()).length).toBe(32);
  });
});

describe("maskAccountNumber", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskAccountNumber("123-4-56789-0")).toBe("****7890");
    expect(maskAccountNumber("0123456789")).toBe("****6789");
  });

  it("hides short values entirely", () => {
    expect(maskAccountNumber("1234")).toBe("****");
    expect(maskAccountNumber("12")).toBe("****");
    expect(maskAccountNumber("")).toBe("****");
  });
});
