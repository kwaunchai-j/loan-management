import { describe, expect, it } from "vitest";
import { checkDate, checkMoney, formatBaht, formatDay, isRealDate, isZeroMoney, todayBangkok } from "@/lib/money";

describe("formatBaht (text only, never a float)", () => {
  it("groups thousands, shows whole baht without decimals and satang with two", () => {
    expect(formatBaht("0")).toBe("0");
    expect(formatBaht("5")).toBe("5");
    expect(formatBaht("1234.5")).toBe("1,234.50");
    expect(formatBaht("1000000.07")).toBe("1,000,000.07");
    expect(formatBaht("1020.00")).toBe("1,020");
    expect(formatBaht("1020.5")).toBe("1,020.50");
    expect(formatBaht("1020.01")).toBe("1,020.01");
  });

  it("is exact for amounts a float would corrupt", () => {
    expect(formatBaht("999999999999.99")).toBe("999,999,999,999.99");
    expect(formatBaht("9007199254740993.01")).toBe("9,007,199,254,740,993.01");
    expect(formatBaht("0.10")).toBe("0.10");
  });

  it("handles missing and odd values without inventing a number", () => {
    expect(formatBaht(null)).toBe("-");
    expect(formatBaht(undefined)).toBe("-");
    expect(formatBaht("abc")).toBe("abc");
    expect(formatBaht("-50")).toBe("-50");
  });
});

describe("isZeroMoney", () => {
  it("is true only when every digit is zero", () => {
    for (const z of ["0", "0.00", "000.0"]) expect(isZeroMoney(z)).toBe(true);
    for (const n of ["0.01", "10", "100.00"]) expect(isZeroMoney(n)).toBe(false);
  });
});

describe("checkMoney", () => {
  it("accepts positive amounts with up to two decimals", () => {
    for (const ok of ["1", "0.01", "1234.5", "999999999999.99"]) expect(checkMoney(ok)).toBeNull();
  });
  it("rejects empty, zero, negative, too many decimals, too many digits, text", () => {
    for (const bad of ["", "0", "0.00", "-5", "1.234", "1234567890123", "abc", "1,000", "1e3"]) expect(checkMoney(bad)).not.toBeNull();
  });
  it("names the field in Thai", () => {
    expect(checkMoney("", "จำนวนที่ชำระ")).toContain("จำนวนที่ชำระ");
  });
});

describe("dates", () => {
  it("knows real calendar days", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("30/10/2026")).toBe(false);
    expect(checkDate("", "วันครบกำหนด")).toMatch(/กรุณา/);
    expect(checkDate("2026-02-30", "วันครบกำหนด")).toMatch(/ไม่ถูกต้อง/);
  });

  it("today is the day in Thailand, whatever the phone's time zone", () => {
    // 20:00 UTC on 30 Oct is already 03:00 on 31 Oct in Bangkok
    expect(todayBangkok(new Date("2026-10-30T20:00:00.000Z"))).toBe("2026-10-31");
    expect(todayBangkok(new Date("2026-10-30T16:59:59.000Z"))).toBe("2026-10-30");
    expect(todayBangkok(new Date("2026-10-30T17:00:00.000Z"))).toBe("2026-10-31");
  });

  it("shows a day in Thai Buddhist Era without time-zone drift", () => {
    expect(formatDay("2026-11-30")).toBe("30 พ.ย. 2569");
    expect(formatDay("2026-01-01")).toBe("1 ม.ค. 2569");
    expect(formatDay(null)).toBe("-");
  });
});
