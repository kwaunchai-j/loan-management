import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { parse as parseCsv } from "csv-parse/sync";
import { unzipSync } from "fflate";

/**
 * Reads an uploaded Excel or CSV file into rows of cells (T-601). The file is untrusted, so:
 *  - the TYPE comes from the bytes (zip signature = .xlsx, otherwise text/CSV), never from the name;
 *  - an .xlsx is a zip: its declared sizes are checked first (entry count, per-entry and total
 *    uncompressed size), and it is then parsed in a separate worker thread with a memory ceiling and
 *    a time limit, so a decompression bomb or a parser bug cannot take the API down;
 *  - CSV text is decoded as UTF-8 (with or without BOM) and, only if that is invalid, as Windows-874
 *    (what Thai Excel writes for plain "CSV");
 *  - the row count is capped.
 * A problem with the file's contents is an ImportFileError with a message for the admin.
 */
export const MAX_DATA_ROWS = 2000;
const MAX_ZIP_ENTRIES = 200;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 20_000;
const WORKER_MEMORY_MB = 256;

export class ImportFileError extends Error {}

export type Cell = string | number | boolean | Date | null;
export type Rows = Cell[][];

const require = createRequire(import.meta.url);
const READ_EXCEL_PATH = require.resolve("read-excel-file/node");

const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readSheet } = require(workerData.modulePath);
readSheet(Buffer.from(workerData.data)).then(
  (rows) => parentPort.postMessage({ ok: true, rows }),
  (err) => parentPort.postMessage({ ok: false, message: String((err && err.message) || err) }),
);
`;

export function detectFileType(data: Buffer): "xlsx" | "csv" | "xls" {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return "xlsx";
  if (data.length >= 4 && data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return "xls";
  return "csv";
}

function checkZipLooksSane(data: Buffer): void {
  let entries = 0;
  let total = 0;
  try {
    // filter -> false: only walk the directory, nothing is inflated
    unzipSync(new Uint8Array(data), {
      filter: (f) => {
        entries++;
        total += f.originalSize;
        if (entries > MAX_ZIP_ENTRIES || f.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
          throw new ImportFileError("ไฟล์ Excel มีขนาดหลังแตกไฟล์ใหญ่ผิดปกติ จึงไม่รับ");
        }
        return false;
      },
    });
  } catch (err) {
    if (err instanceof ImportFileError) throw err;
    throw new ImportFileError("ไฟล์ Excel เสียหรืออ่านไม่ได้");
  }
}

export interface IsolationOptions {
  /** The worker program; only tests replace it, to prove that a misbehaving worker is contained. */
  code?: string;
  timeoutMs?: number;
  memoryMb?: number;
}

export function readXlsxIsolated(data: Buffer, o: IsolationOptions = {}): Promise<Rows> {
  return new Promise<Rows>((resolve, reject) => {
    const worker = new Worker(o.code ?? WORKER_CODE, {
      eval: true,
      workerData: { modulePath: READ_EXCEL_PATH, data },
      resourceLimits: { maxOldGenerationSizeMb: o.memoryMb ?? WORKER_MEMORY_MB, maxYoungGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ImportFileError("อ่านไฟล์นานเกินไป จึงยกเลิก"))),
      o.timeoutMs ?? WORKER_TIMEOUT_MS,
    );
    worker.once("message", (m: { ok: boolean; rows?: Rows; message?: string }) =>
      finish(() =>
        m.ok ? resolve(m.rows ?? []) : reject(new ImportFileError("อ่านไฟล์ Excel ไม่ได้ ตรวจสอบว่าเป็นไฟล์ .xlsx ที่ไม่เสียหาย")),
      ),
    );
    worker.once("error", () => finish(() => reject(new ImportFileError("อ่านไฟล์ Excel ไม่ได้หรือไฟล์ใหญ่เกินไป"))));
    worker.once("exit", () => finish(() => reject(new ImportFileError("อ่านไฟล์ Excel ไม่สำเร็จ"))));
  });
}

export function decodeCsvText(data: Buffer): string {
  try {
    // fatal: bytes that are not valid UTF-8 throw instead of turning into replacement characters;
    // ignoreBOM:false makes the decoder drop a leading byte-order mark
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return new TextDecoder("windows-874").decode(data);
  }
}

function readCsv(data: Buffer): Rows {
  const text = decodeCsvText(data);
  try {
    const rows = parseCsv(text, {
      delimiter: [",", ";", "\t"],
      relax_column_count: true, // a short row is reported by the row check, not as a file error
      skip_empty_lines: false,
      to_line: MAX_DATA_ROWS + 2, // stop early on a huge file
      max_record_size: 64 * 1024,
    }) as string[][];
    return rows;
  } catch {
    throw new ImportFileError("อ่านไฟล์ CSV ไม่ได้ รูปแบบไฟล์ไม่ถูกต้อง");
  }
}

/** Returns the first sheet / the CSV as rows of cells; the first row is the header. */
export async function readUpload(data: Buffer): Promise<{ type: "xlsx" | "csv"; rows: Rows }> {
  const type = detectFileType(data);
  if (type === "xls") throw new ImportFileError("ไม่รองรับไฟล์ .xls แบบเก่า กรุณาบันทึกเป็น .xlsx หรือ .csv");
  let rows: Rows;
  if (type === "xlsx") {
    checkZipLooksSane(data);
    rows = await readXlsxIsolated(data);
  } else {
    rows = readCsv(data);
  }
  if (rows.length - 1 > MAX_DATA_ROWS) {
    throw new ImportFileError(`ไฟล์มีมากกว่า ${MAX_DATA_ROWS} แถว กรุณาแบ่งเป็นหลายไฟล์`);
  }
  return { type, rows };
}
