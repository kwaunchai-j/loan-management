import { describe, expect, it } from "vitest";
import { buildPeriodQuery, defaultSelection, periodLabel, type PeriodSelection } from "@/lib/report-period";

const sel = (over: Partial<PeriodSelection>): PeriodSelection => ({ kind: "month", month: "2026-10", year: "2026", from: "2026-10-01", to: "2026-10-31", ...over });

describe("buildPeriodQuery", () => {
  it("all time has no filter", () => {
    expect(buildPeriodQuery(sel({ kind: "all" }))).toEqual({ ok: true, query: "" });
  });

  it("a month, a year, or a range becomes the query the API reads", () => {
    expect(buildPeriodQuery(sel({ kind: "month", month: "2026-10" }))).toEqual({ ok: true, query: "month=2026-10" });
    expect(buildPeriodQuery(sel({ kind: "year", year: "2026" }))).toEqual({ ok: true, query: "year=2026" });
    expect(buildPeriodQuery(sel({ kind: "range", from: "2026-10-01", to: "2026-10-15" }))).toEqual({ ok: true, query: "from=2026-10-01&to=2026-10-15" });
  });

  it("a range may be a single day (both ends included)", () => {
    expect(buildPeriodQuery(sel({ kind: "range", from: "2026-10-05", to: "2026-10-05" }))).toMatchObject({ ok: true });
  });

  it("explains a month or year that is not valid", () => {
    for (const month of ["", "2026-13", "2026-00", "26-10", "2026-1", "1969-12"]) expect(buildPeriodQuery(sel({ kind: "month", month }))).toMatchObject({ ok: false });
    for (const year of ["", "26", "20266", "abc", "1969"]) expect(buildPeriodQuery(sel({ kind: "year", year }))).toMatchObject({ ok: false });
  });

  it("explains a range that is incomplete, backwards, not a real day, or far too long", () => {
    expect(buildPeriodQuery(sel({ kind: "range", from: "", to: "2026-10-01" }))).toMatchObject({ ok: false });
    expect(buildPeriodQuery(sel({ kind: "range", from: "2026-02-30", to: "2026-03-01" }))).toMatchObject({ ok: false });
    expect(buildPeriodQuery(sel({ kind: "range", from: "2026-10-10", to: "2026-10-09" }))).toEqual({ ok: false, error: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น" });
    expect(buildPeriodQuery(sel({ kind: "range", from: "2010-01-01", to: "2026-01-01" }))).toMatchObject({ ok: false });
    // just inside the limit (3700 days) is fine
    expect(buildPeriodQuery(sel({ kind: "range", from: "2016-01-01", to: "2026-01-01" }))).toMatchObject({ ok: true });
  });

  it("every message is Thai", () => {
    const bad = [sel({ month: "" }), sel({ kind: "year", year: "" }), sel({ kind: "range", from: "", to: "" })];
    for (const b of bad) {
      const r = buildPeriodQuery(b);
      expect(r.ok === false && r.error).toMatch(/[฀-๿]/);
    }
  });
});

describe("defaultSelection", () => {
  it("starts on the current month in Thailand", () => {
    // 20:00 UTC on 31 Oct is already 1 Nov in Bangkok
    const d = defaultSelection(new Date("2026-10-31T20:00:00.000Z"));
    expect(d.kind).toBe("month");
    expect(d.month).toBe("2026-11");
    expect(d.from).toBe("2026-11-01");
    expect(d.to).toBe("2026-11-01");
  });
});

describe("periodLabel", () => {
  it("writes the period in Thai Buddhist Era", () => {
    expect(periodLabel({ kind: "month", from: "2026-10-01", to: "2026-10-31" })).toBe("ตุลาคม 2569");
    expect(periodLabel({ kind: "year", from: "2026-01-01", to: "2026-12-31" })).toBe("ปี 2569");
    expect(periodLabel({ kind: "range", from: "2026-10-01", to: "2026-10-15" })).toBe("1 ต.ค. 2569 – 15 ต.ค. 2569");
    expect(periodLabel({ kind: "all", from: null, to: null })).toBe("ทุกช่วงเวลา");
  });
});
