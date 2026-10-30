import { strToU8, zipSync } from "fflate";

/** Builders for the files an admin would upload, so tests can use real bytes. */

export type FixtureCell = string | number | Date | null;

const CSV_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const csvCell = (c: FixtureCell) => {
  const t = c === null ? "" : c instanceof Date ? c.toISOString().slice(0, 10) : String(c);
  return /[",\r\n;\t]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function csvBytes(rows: FixtureCell[][], o: { bom?: boolean; delimiter?: string; eol?: string } = {}): Buffer {
  const text = rows.map((r) => r.map(csvCell).join(o.delimiter ?? ",")).join(o.eol ?? "\r\n") + (o.eol ?? "\r\n");
  const body = Buffer.from(text, "utf8");
  return o.bom ? Buffer.concat([CSV_BOM, body]) : body;
}

/** What Thai Windows writes for a plain "CSV": TIS-620 / Windows-874 (Thai letters are 0xA1..0xFB). */
export function windows874Bytes(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp >= 0x0e01 && cp <= 0x0e5b) out.push(cp - 0x0e00 + 0xa0);
    else throw new Error(`cannot encode ${ch} as Windows-874`);
  }
  return Buffer.from(out);
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COLUMNS = "ABCDEFGH";
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** A minimal but real .xlsx (zip of XML parts): strings, numbers and date cells (stored as serials). */
export function xlsxBytes(rows: FixtureCell[][]): Buffer {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((c, i) => {
          if (c === null) return "";
          const ref = `${COLUMNS[i]}${r + 1}`;
          if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
          if (c instanceof Date) return `<c r="${ref}" s="1"><v>${Math.round((c.getTime() - EXCEL_EPOCH) / 86_400_000)}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)]))));
}

/** The header of the template, as an admin would see it. */
export const HEADER_ROW: FixtureCell[] = ["ชื่อผู้ยืม", "จำนวนเงิน", "ดอกเบี้ย", "วันครบกำหนด"];
