import { describe, expect, it } from "vitest";
import {
  checkBankAccount,
  checkPassword,
  checkPhone,
  checkRate,
  checkUsername,
  generatePassword,
  maskAccount,
  normalizeRate,
} from "@/lib/validation";

describe("checkPassword", () => {
  it("accepts 10 to 128 characters", () => {
    expect(checkPassword("a".repeat(10))).toBeNull();
    expect(checkPassword("a".repeat(128))).toBeNull();
  });
  it("rejects shorter and longer", () => {
    expect(checkPassword("a".repeat(9))).toMatch(/10/);
    expect(checkPassword("a".repeat(129))).toMatch(/128/);
  });
});

describe("checkUsername", () => {
  it("rejects empty, spaces inside and over 64 characters", () => {
    expect(checkUsername("  ")).not.toBeNull();
    expect(checkUsername("a b")).not.toBeNull();
    expect(checkUsername("a".repeat(65))).not.toBeNull();
    expect(checkUsername("somchai")).toBeNull();
  });
});

describe("phone and account", () => {
  it("matches the API patterns", () => {
    expect(checkPhone("081-234-5678")).toBeNull();
    expect(checkPhone("+66 81 234 5678")).toBeNull();
    expect(checkPhone("12345")).not.toBeNull();
    expect(checkPhone("08x234567")).not.toBeNull();
    expect(checkBankAccount("123-4-56789-0")).toBeNull();
    expect(checkBankAccount("12345")).not.toBeNull();
    expect(checkBankAccount("1234 5678")).not.toBeNull();
  });
});

describe("rates", () => {
  it("accepts up to 3 integer and 4 decimal digits, never negative", () => {
    for (const ok of ["0", "2", "2.5", "999.9999", "0.0001"]) expect(checkRate(ok)).toBeNull();
    for (const bad of ["", "-1", "1.23456", "1000", "abc", "1,5", "1e3", ".5"]) expect(checkRate(bad)).not.toBeNull();
  });

  it("normalises equal numbers to one spelling", () => {
    expect(normalizeRate("02.50")).toBe("2.5");
    expect(normalizeRate("007")).toBe("7");
    expect(normalizeRate("0.0100")).toBe("0.01");
    expect(normalizeRate("0")).toBe("0");
    expect(normalizeRate("0.0")).toBe("0");
    expect(normalizeRate("1.0")).toBe("1");
    expect(normalizeRate(" 3.25 ")).toBe("3.25");
  });
});

describe("maskAccount", () => {
  it("keeps only the last four digits", () => {
    expect(maskAccount("123-4-56789-0")).toBe("****7890");
    expect(maskAccount("1234567890")).not.toContain("123456");
  });
  it("hides short numbers entirely and handles null", () => {
    expect(maskAccount("123")).toBe("****");
    expect(maskAccount(null)).toBe("-");
  });
});

describe("generatePassword", () => {
  it("makes passwords the API accepts, from an alphabet without look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(checkPassword(p)).toBeNull();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
    }
  });

  it("is random", () => {
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });

  it("does not use biased bytes (values at or above the cut-off are skipped)", () => {
    // 57 symbols: 256 - 256 % 57 = 228, so a byte of 228..255 must be discarded, not wrapped
    const stream = [...Array(12).fill(255), ...Array(12).fill(0)];
    let i = 0;
    const p = generatePassword(12, (n) => Uint8Array.from({ length: n }, () => stream[i++ % stream.length] ?? 0));
    expect(p).toBe("A".repeat(12));
  });
});
