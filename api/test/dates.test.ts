import { describe, expect, it } from "vitest";
import { bangkokToday, formatDateOnly, parseDateOnly } from "../src/lib/dates.js";

describe("bangkokToday", () => {
  it("uses the Asia/Bangkok calendar date, not UTC", () => {
    // 17:30 UTC on the 29th is 00:30 on the 30th in Bangkok (UTC+7)
    expect(formatDateOnly(bangkokToday(new Date("2026-10-29T17:30:00Z")))).toBe("2026-10-30");
    // 16:59 UTC is still 23:59 on the 29th in Bangkok
    expect(formatDateOnly(bangkokToday(new Date("2026-10-29T16:59:00Z")))).toBe("2026-10-29");
    expect(formatDateOnly(bangkokToday(new Date("2026-12-31T20:00:00Z")))).toBe("2027-01-01");
  });

  it("returns a date-only value (UTC midnight)", () => {
    expect(bangkokToday(new Date("2026-10-29T05:12:34Z")).toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });
});

describe("parseDateOnly", () => {
  it("accepts real calendar dates", () => {
    expect(parseDateOnly("2026-10-29")?.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(parseDateOnly("2028-02-29")).not.toBeNull();
  });

  it("rejects malformed and impossible dates", () => {
    for (const bad of ["", "2026-1-1", "26-10-29", "2026-02-30", "2027-02-29", "2026-13-01", "2026-10-32", "2026-10-29T00:00:00Z", " 2026-10-29"]) {
      expect(parseDateOnly(bad), bad).toBeNull();
    }
  });
});
