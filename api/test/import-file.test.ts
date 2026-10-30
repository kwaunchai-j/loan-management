import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { decodeCsvText, detectFileType, ImportFileError, MAX_DATA_ROWS, readUpload, readXlsxIsolated } from "../src/imports/parse-file.js";
import { normalizeName, parseDueDate, parseRows } from "../src/imports/validate.js";
import { csvBytes, HEADER_ROW, windows874Bytes, xlsxBytes, type FixtureCell } from "./import-fixtures.js";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

describe("reading an uploaded file", () => {
  const rows: FixtureCell[][] = [HEADER_ROW, ["สมชาย ใจดี", 1500.5, 100, "2026-12-31"], ["Mary, Jane", 2000, null, "31/12/2026"]];

  it("decides the type from the bytes, not the name", () => {
    expect(detectFileType(xlsxBytes(rows))).toBe("xlsx");
    expect(detectFileType(csvBytes(rows))).toBe("csv");
    expect(detectFileType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).toBe("xls");
    expect(detectFileType(Buffer.from("PK\u0003\u0004 pretend"))).toBe("xlsx"); // zip signature
  });

  it("reads a CSV (UTF-8, with and without BOM) with quoted commas and Windows line ends", async () => {
    for (const bom of [false, true]) {
      const { type, rows: got } = await readUpload(csvBytes(rows, { bom }));
      expect(type).toBe("csv");
      expect(got[1]).toEqual(["สมชาย ใจดี", "1500.5", "100", "2026-12-31"]);
      expect(got[2]![0]).toBe("Mary, Jane");
    }
  });

  it("reads semicolon- and tab-separated files too", async () => {
    for (const delimiter of [";", "\t"]) {
      const got = (await readUpload(csvBytes(rows, { delimiter }))).rows;
      expect(got[1]![0]).toBe("สมชาย ใจดี");
      expect(got[1]).toHaveLength(4);
    }
  });

  it("reads Thai Excel's plain 'CSV' (Windows-874) instead of showing garbage", async () => {
    const thai = windows874Bytes("ชื่อผู้ยืม,จำนวนเงิน,ดอกเบี้ย,วันครบกำหนด\r\nสมชาย ใจดี,1500,100,2026-12-31\r\n");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(thai)).toThrow(); // it is NOT valid UTF-8
    expect(decodeCsvText(thai)).toContain("สมชาย ใจดี");
    const parsed = parseRows((await readUpload(thai)).rows);
    expect(parsed[0]!.name).toBe("สมชาย ใจดี");
    expect(parsed[0]!.errors).toEqual([]);
  });

  it("reads an .xlsx: text, numbers and real date cells, in an isolated worker", async () => {
    const { type, rows: got } = await readUpload(xlsxBytes([HEADER_ROW, ["สมชาย", 1500.5, 100, d("2026-12-31")], ["สมหญิง", 2000, null, d("2027-01-15")]]));
    expect(type).toBe("xlsx");
    expect(got[1]![0]).toBe("สมชาย");
    expect(got[1]![1]).toBe(1500.5);
    expect(got[1]![3]).toBeInstanceOf(Date);
    const parsed = parseRows(got);
    expect(parsed.map((r) => [r.name, r.amount!.toString(), r.interest!.toString(), iso(r.dueDate)])).toEqual([
      ["สมชาย", "1500.5", "100", "2026-12-31"],
      ["สมหญิง", "2000", "0", "2027-01-15"],
    ]);
  });

  it("refuses the old .xls format, with advice", async () => {
    await expect(readUpload(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]))).rejects.toThrow(/\.xls/);
  });

  it("refuses a corrupt .xlsx without crashing", async () => {
    await expect(readUpload(Buffer.from("PK\u0003\u0004 this is not really a zip file at all"))).rejects.toBeInstanceOf(ImportFileError);
    // a valid zip that is not a spreadsheet
    const notExcel = Buffer.from(zipSync({ "hello.txt": new TextEncoder().encode("hi") }));
    await expect(readUpload(notExcel)).rejects.toBeInstanceOf(ImportFileError);
  });

  it("refuses a decompression bomb before inflating it", async () => {
    // 30 MB of zeros compresses to a few KB: far above the 20 MB per-entry ceiling
    const bomb = Buffer.from(zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(30 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(200 * 1024);
    const started = Date.now();
    await expect(readUpload(bomb)).rejects.toThrow(/ใหญ่ผิดปกติ/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses a zip with far too many parts", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 250; i++) files[`part${i}.xml`] = new Uint8Array([1]);
    await expect(readUpload(Buffer.from(zipSync(files)))).rejects.toThrow(/ใหญ่ผิดปกติ/);
  });

  describe("a misbehaving parser is contained", () => {
    const data = Buffer.from("PK\u0003\u0004");

    it("an uncaught error inside the worker rejects the upload instead of crashing the server", async () => {
      const code = `setTimeout(() => { throw new Error("boom inside the worker"); }, 0); setInterval(() => {}, 1000);`;
      await expect(readXlsxIsolated(data, { code, timeoutMs: 5000 })).rejects.toBeInstanceOf(ImportFileError);
    });

    it("a worker that eats memory is stopped at its ceiling", async () => {
      const code = `const hog = []; setInterval(() => {}, 1000); for (;;) hog.push(new Array(1_000_000).fill(Math.random()));`;
      const started = Date.now();
      await expect(readXlsxIsolated(data, { code, memoryMb: 24, timeoutMs: 15_000 })).rejects.toBeInstanceOf(ImportFileError);
      expect(Date.now() - started).toBeLessThan(14_000); // the memory limit, not the timeout, ended it
    });

    it("a worker that never answers is cut off after the time limit", async () => {
      const code = `setInterval(() => {}, 1000);`;
      const started = Date.now();
      await expect(readXlsxIsolated(data, { code, timeoutMs: 300 })).rejects.toThrow(/นานเกินไป/);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("a worker that exits without an answer is reported, not awaited forever", async () => {
      await expect(readXlsxIsolated(data, { code: `process.exit(0);`, timeoutMs: 5000 })).rejects.toBeInstanceOf(ImportFileError);
    });
  });

  it("caps the number of rows", async () => {
    const make = (n: number) => csvBytes([HEADER_ROW, ...Array.from({ length: n }, (_, i) => [`ชื่อ ${i}`, 100, 0, "2026-12-31"])]);
    expect((await readUpload(make(MAX_DATA_ROWS))).rows).toHaveLength(MAX_DATA_ROWS + 1);
    await expect(readUpload(make(MAX_DATA_ROWS + 1))).rejects.toThrow(/มากกว่า/);
  });

  it("treats garbage text as a CSV whose header will not match, never as a crash", async () => {
    const { rows: got } = await readUpload(Buffer.from([0x00, 0xff, 0x10, 0x41, 0x42, 0x0a, 0xfe]));
    expect(() => parseRows(got)).toThrow(ImportFileError);
  });
});

describe("checking the rows of the template (DES-014)", () => {
  const one = (cells: FixtureCell[]) => parseRows([HEADER_ROW as never, cells as never])[0]!;

  it("insists on the template header, in order, and nothing extra", () => {
    expect(() => parseRows([])).toThrow(ImportFileError);
    expect(() => parseRows([["Name", "Amount", "Interest", "Due"]])).toThrow(/ไม่ตรงแม่แบบ/);
    expect(() => parseRows([["จำนวนเงิน", "ชื่อผู้ยืม", "ดอกเบี้ย", "วันครบกำหนด"], ["a", 1, 1, "2026-01-01"]])).toThrow(/ไม่ตรงแม่แบบ/);
    expect(() => parseRows([[...HEADER_ROW, "หมายเหตุ"]])).toThrow(/ไม่ตรงแม่แบบ/);
    expect(() => parseRows([HEADER_ROW])).toThrow(/ไม่มีข้อมูล/); // header only
    expect(parseRows([[...HEADER_ROW, null], ["ก", 100, 0, "2026-01-01"]])).toHaveLength(1); // a trailing empty column is fine
  });

  it("skips blank lines and reports spreadsheet row numbers (the header is row 1)", () => {
    const parsed = parseRows([HEADER_ROW, [null, null, null, null], ["ก", 100, 0, "2026-01-01"], ["", "  ", "", ""], ["ข", 200, 0, "2026-01-02"]] as never);
    expect(parsed.map((r) => [r.rowNumber, r.name])).toEqual([[3, "ก"], [5, "ข"]]);
  });

  it("tidies names: spaces collapsed and trimmed, composed Unicode", () => {
    expect(normalizeName("  สมชาย   ใจดี  ")).toBe("สมชาย ใจดี");
    expect(normalizeName("Café")).toBe("Café");
    expect(one(["  สมชาย   ใจดี ", 100, 0, "2026-01-01"]).name).toBe("สมชาย ใจดี");
  });

  it("accepts amounts as numbers, with thousands separators, currency marks", () => {
    for (const [cell, expected] of [[1500.5, "1500.5"], ["1,500.50", "1500.5"], ["฿2000", "2000"], ["3000 บาท", "3000"], ["10", "10"], [999999999999.99, "999999999999.99"]] as const) {
      const r = one(["ก", cell, 0, "2026-01-01"]);
      expect(r.errors, String(cell)).toEqual([]);
      expect(r.amount!.toString()).toBe(expected);
    }
  });

  it("refuses bad amounts with a reason", () => {
    for (const bad of [0, "0", -5, "-5", "abc", "1.234", "1e3", "1,2,3x", 1000000000000, "NaN"]) {
      const r = one(["ก", bad as never, 0, "2026-01-01"]);
      expect(r.errors.length, String(bad)).toBeGreaterThan(0);
      expect(r.errors.join()).toMatch(/จำนวนเงิน/);
    }
    expect(one(["ก", null, 0, "2026-01-01"]).errors).toContain("จำนวนเงินว่าง");
  });

  it("treats a blank interest as 0, allows 0, refuses negatives and junk", () => {
    expect(one(["ก", 100, null, "2026-01-01"]).interest!.toString()).toBe("0");
    expect(one(["ก", 100, "", "2026-01-01"]).interest!.toString()).toBe("0");
    expect(one(["ก", 100, 0, "2026-01-01"]).errors).toEqual([]);
    expect(one(["ก", 100, 12.5, "2026-01-01"]).interest!.toString()).toBe("12.5");
    for (const bad of [-1, "-0.01", "abc", "1.234"]) {
      const r = one(["ก", 100, bad as never, "2026-01-01"]);
      expect(r.errors.join(), String(bad)).toMatch(/ดอกเบี้ย/);
    }
    // a negative interest is refused for being negative, with that very reason
    expect(one(["ก", 100, -1, "2026-01-01"]).errors).toContain("ดอกเบี้ยต้องไม่ติดลบ");
    expect(one(["ก", 100, "-0.01", "2026-01-01"]).errors).toContain("ดอกเบี้ยต้องไม่ติดลบ");
    expect(one(["ก", -5, 0, "2026-01-01"]).errors).toContain("จำนวนเงินต้องไม่ติดลบ");
  });

  it("reads due dates written the ways people write them", () => {
    expect(iso(parseDueDate("2026-12-31"))).toBe("2026-12-31");
    expect(iso(parseDueDate("31/12/2026"))).toBe("2026-12-31");
    expect(iso(parseDueDate("1/2/2026"))).toBe("2026-02-01");
    expect(iso(parseDueDate("31/12/2569"))).toBe("2026-12-31"); // Buddhist Era
    expect(iso(parseDueDate(d("2026-12-31")))).toBe("2026-12-31"); // a real date cell
    expect(iso(parseDueDate(46000))).toBe("2025-12-09"); // an Excel serial in a cell not formatted as a date
    expect(iso(parseDueDate(" 2026-12-31 "))).toBe("2026-12-31");
  });

  it("refuses dates that are impossible, out of range or not dates", () => {
    for (const bad of ["32/01/2026", "2026-02-30", "29/02/2027", "01/13/2026x", "yesterday", "", "1999-12-31", "2101-01-01", "31/12/1999", 12.5, true, "2026/12/31", "12-31-2026"]) {
      expect(parseDueDate(bad as never), String(bad)).toBeNull();
    }
    expect(one(["ก", 100, 0, "nope"]).errors.join()).toMatch(/วันครบกำหนดไม่ถูกต้อง/);
    expect(one(["ก", 100, 0, null]).errors).toContain("วันครบกำหนดว่าง");
  });

  it("collects every problem of a row, and keeps good rows apart from bad ones", () => {
    const [bad, good] = parseRows([HEADER_ROW, ["", 0, -1, "x"], ["ข", 100, 0, "2026-01-01"]] as never);
    expect(bad!.errors.length).toBe(4);
    expect(good!.errors).toEqual([]);
  });

  it("rejects an over-long name", () => {
    expect(one(["ก".repeat(201), 100, 0, "2026-01-01"]).errors.join()).toMatch(/ยาวเกิน/);
    expect(one(["ก".repeat(200), 100, 0, "2026-01-01"]).errors).toEqual([]);
  });
});
