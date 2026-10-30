"use client";

import { useState, type ChangeEvent } from "react";
import { Alert, Badge, Button, Card, Item } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { formatBaht, formatDay } from "@/lib/money";
import { importPreviewSchema, importResultSchema, type ImportPreview, type ImportResult } from "@/lib/schemas";

const MATCH_LABEL = { EXISTING: "ผู้ยืมเดิม", NEW: "สร้างผู้ยืมใหม่", AMBIGUOUS: "ชื่อซ้ำ ต้องเลือก" } as const;
const ROWS_SHOWN = 100;

/** What still stops the import button, in plain Thai (empty = ready). Pure so it can be tested on its own. */
export function importBlockers(p: ImportPreview, choices: Record<string, string>, skipInvalid: boolean): string[] {
  const out: string[] = [];
  if (!p.ratesReady) out.push("ยังไม่ได้ตั้งอัตราดอกเบี้ยและค่าปรับ (ไปที่ตั้งค่าอัตราก่อน)");
  else if (!p.canCommit) out.push("ไฟล์นี้ยังนำเข้าไม่ได้ (ไม่มีแถวที่ถูกต้อง หรือมีค่าปรับย้อนหลังมากเกินไป)");
  const missing = p.needsChoice.filter((n) => !choices[n.name]);
  if (missing.length > 0) out.push(`ต้องเลือกผู้ยืมให้ครบสำหรับชื่อที่ซ้ำ (เหลือ ${missing.length} ชื่อ)`);
  if (p.hasInvalidRows && !skipInvalid) out.push("มีแถวที่ไม่ถูกต้อง ต้องยืนยันว่าจะข้ามแถวเหล่านั้น หรือแก้ไฟล์แล้วอัปโหลดใหม่");
  return out;
}

/**
 * Upload → check (nothing saved) → choose borrowers for duplicate names → confirm (DES-014).
 * The file stays on the server under a random key; confirming sends only that key, the choices and the
 * "skip invalid rows" answer, and the server checks the whole file again.
 */
export function ImportFlow({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [onlyInvalid, setOnlyInvalid] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);

  function reset() {
    setPreview(null);
    setChoices({});
    setSkipInvalid(false);
    setOnlyInvalid(false);
    setShowAll(false);
  }

  function pick(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setError(null);
    setResult(null);
    reset();
  }

  async function check() {
    if (!file) return setError("กรุณาเลือกไฟล์ Excel (.xlsx) หรือ CSV ก่อน");
    setBusy("preview");
    setError(null);
    setResult(null);
    reset();
    try {
      setPreview(
        await apiFetch(`/admin/imports/preview?fileName=${encodeURIComponent(file.name)}`, { method: "POST", file, schema: importPreviewSchema }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy("commit");
    setError(null);
    // only the names that really needed a choice are sent
    const chosen = Object.fromEntries(preview.needsChoice.map((n) => [n.name, choices[n.name]!]));
    try {
      const r = await apiFetch("/admin/imports/commit", {
        method: "POST",
        json: { importKey: preview.importKey, fileName: preview.fileName, choices: chosen, skipInvalidRows: skipInvalid },
        schema: importResultSchema,
      });
      setResult(r);
      setPreview(null);
      setFile(null);
      onImported();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const blockers = preview ? importBlockers(preview, choices, skipInvalid) : [];
  const rows = preview ? (onlyInvalid ? preview.rows.filter((r) => !r.valid) : preview.rows) : [];
  const shownRows = showAll ? rows : rows.slice(0, ROWS_SHOWN);

  return (
    <>
      <Card title="1. เลือกไฟล์">
        <p className="mb-3 text-sm text-slate-700">
          นำเข้าสัญญาเก่าจากไฟล์ที่มี 4 คอลัมน์: ชื่อผู้ยืม · จำนวนเงิน (เงินต้นล้วน) · ดอกเบี้ย (บวกเพิ่ม เว้นว่าง = 0) · วันครบกำหนด{" "}
          <a href="/api/admin/imports/template" download className="font-medium text-teal-800 underline">
            ดาวน์โหลดแม่แบบ
          </a>
        </p>
        <label className="block text-sm font-medium text-slate-800">
          ไฟล์ Excel (.xlsx) หรือ CSV
          <input
            type="file"
            accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={pick}
            className="mt-1 block min-h-11 w-full text-base file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-teal-700 file:px-4 file:font-medium file:text-white"
          />
        </label>
        <Button className="mt-4 w-full sm:w-auto" disabled={busy !== null} onClick={() => void check()}>
          {busy === "preview" ? "กำลังตรวจไฟล์..." : "ตรวจไฟล์ (ยังไม่บันทึกข้อมูล)"}
        </Button>
      </Card>

      {error && <Alert kind="error">{error}</Alert>}

      {result && (
        <Alert kind="success">
          <p className="font-medium">นำเข้าเรียบร้อยแล้ว</p>
          <p>
            สร้าง {result.contractsCreated} สัญญา (เงินต้น {formatBaht(result.totalPrincipal)} · ดอกเบี้ย {formatBaht(result.totalInterest)} บาท) · ผู้ยืมใหม่ {result.borrowersCreated} คน · ผูกกับผู้ยืมเดิม {result.borrowersLinked} คน · ข้าม {result.skippedRows} แถว · ค่าปรับย้อนหลัง {formatBaht(result.lateFeeBackfilled)} บาท ({result.lateFeeRows} วัน)
          </p>
        </Alert>
      )}

      {preview && (
        <>
          <Card title="2. ผลการตรวจไฟล์">
            <p className="mb-3 text-sm text-slate-600">ไฟล์: {preview.fileName} — ตรวจแล้วแต่ยังไม่ได้บันทึกอะไร</p>
            {!preview.ratesReady && (
              <Alert kind="warning">ยังไม่ได้ตั้งอัตราดอกเบี้ยและค่าปรับ จึงนำเข้าไม่ได้ และยังคำนวณค่าปรับย้อนหลังไม่ได้ ไปที่ “ตั้งค่าอัตรา” ก่อนแล้วตรวจไฟล์ใหม่</Alert>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Item label="แถวทั้งหมด" value={preview.summary.rows} />
              <Item label="แถวที่ถูกต้อง" value={preview.summary.validRows} />
              <Item label="แถวที่ไม่ถูกต้อง" value={preview.summary.invalidRows} />
              <Item label="ผู้ยืม" value={`${preview.summary.borrowers} คน`} />
              <Item label="ผู้ยืมเดิม" value={`${preview.summary.existingBorrowers} คน`} />
              <Item label="ผู้ยืมใหม่" value={`${preview.summary.newBorrowers} คน`} />
              <Item label="ชื่อซ้ำต้องเลือก" value={`${preview.summary.ambiguousBorrowers} ชื่อ`} />
              <Item label="วันค่าปรับย้อนหลัง" value={`${preview.summary.lateDays} วัน`} />
              <Item label="เงินต้นรวม" value={`${formatBaht(preview.summary.principal)} บาท`} />
              <Item label="ดอกเบี้ยรวม" value={`${formatBaht(preview.summary.interest)} บาท`} />
              <Item label="ค่าปรับย้อนหลังรวม" value={preview.summary.lateFee === null ? "ยังคำนวณไม่ได้" : `${formatBaht(preview.summary.lateFee)} บาท`} />
            </dl>
          </Card>

          {preview.needsChoice.length > 0 && (
            <Card title="3. เลือกผู้ยืมสำหรับชื่อที่ซ้ำกันในระบบ">
              <p className="mb-3 text-sm text-slate-700">พบผู้ยืมหลายคนที่ใช้ชื่อเดียวกัน ระบบไม่เดาให้ กรุณาเลือกว่าสัญญาในไฟล์เป็นของคนไหน</p>
              <div className="space-y-4">
                {preview.needsChoice.map((n) => (
                  <fieldset key={n.name} className="space-y-2 rounded-lg border border-slate-200 p-3">
                    <legend className="px-1 font-medium text-slate-900">
                      {n.name} <span className="text-sm font-normal text-slate-600">(แถว {n.rowNumbers.join(", ")})</span>
                    </legend>
                    {n.candidates.map((c) => (
                      <label key={c.borrowerId} className="flex min-h-11 cursor-pointer items-start gap-3">
                        <input
                          type="radio"
                          name={`choice-${n.name}`}
                          checked={choices[n.name] === c.borrowerId}
                          onChange={() => setChoices((s) => ({ ...s, [n.name]: c.borrowerId }))}
                          className="mt-1 h-5 w-5 accent-teal-700"
                        />
                        <span>
                          {c.fullName} · {c.phone ?? "ไม่มีเบอร์"} · {c.hasAccount ? "มีบัญชีเข้าสู่ระบบ" : "ไม่มีบัญชี"} · สร้างเมื่อ {formatDateTime(c.createdAt)}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </Card>
          )}

          <Card title="แถวในไฟล์">
            {preview.hasInvalidRows && (
              <label className="mb-3 flex min-h-11 cursor-pointer items-center gap-3">
                <input type="checkbox" checked={onlyInvalid} onChange={(e) => setOnlyInvalid(e.target.checked)} className="h-5 w-5 accent-teal-700" />
                <span>แสดงเฉพาะแถวที่ไม่ถูกต้อง</span>
              </label>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-600">
                    <th className="py-2 pr-3 font-medium">แถว</th>
                    <th className="py-2 pr-3 font-medium">ชื่อ</th>
                    <th className="py-2 pr-3 text-right font-medium">จำนวนเงิน</th>
                    <th className="py-2 pr-3 text-right font-medium">ดอกเบี้ย</th>
                    <th className="py-2 pr-3 font-medium">ครบกำหนด</th>
                    <th className="py-2 pr-3 text-right font-medium">ค่าปรับย้อนหลัง</th>
                    <th className="py-2 font-medium">สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((r) => (
                    <tr key={r.rowNumber} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-3">{r.rowNumber}</td>
                      <td className="py-2 pr-3">{r.name || "-"}</td>
                      <td className="py-2 pr-3 text-right">{r.amount === null ? "-" : formatBaht(r.amount)}</td>
                      <td className="py-2 pr-3 text-right">{r.interest === null ? "-" : formatBaht(r.interest)}</td>
                      <td className="py-2 pr-3">{formatDay(r.dueDate)}{r.daysOverdue > 0 ? ` (เลย ${r.daysOverdue} วัน)` : ""}</td>
                      <td className="py-2 pr-3 text-right">{r.lateFee === null ? "-" : formatBaht(r.lateFee)}</td>
                      <td className="py-2">
                        {r.valid ? (
                          <Badge tone={r.match.status === "AMBIGUOUS" ? "amber" : "green"}>{MATCH_LABEL[r.match.status]}</Badge>
                        ) : (
                          <ul className="list-inside list-disc text-red-800">
                            {r.errors.map((m) => (
                              <li key={m}>{m}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > ROWS_SHOWN && (
              <Button className="mt-3" variant="secondary" onClick={() => setShowAll((s) => !s)}>
                {showAll ? `แสดงแค่ ${ROWS_SHOWN} แถวแรก` : `แสดงทั้งหมด ${rows.length} แถว`}
              </Button>
            )}
          </Card>

          <Card title="ยืนยันการนำเข้า">
            {preview.hasInvalidRows && (
              <label className="mb-3 flex min-h-11 cursor-pointer items-start gap-3">
                <input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} className="mt-1 h-5 w-5 accent-teal-700" />
                <span>ข้ามแถวที่ไม่ถูกต้อง {preview.summary.invalidRows} แถว และนำเข้าเฉพาะแถวที่ถูกต้อง</span>
              </label>
            )}
            {blockers.length > 0 && (
              <ul role="status" className="mb-3 list-inside list-disc text-sm text-amber-900">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <p className="mb-3 text-sm text-slate-600">การนำเข้าทำทั้งหมดหรือไม่ทำเลย และย้อนกลับทั้งชุดได้ตราบใดที่ยังไม่มีรายการรับชำระในสัญญาของชุดนั้น</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={blockers.length > 0 || busy !== null} onClick={() => void commit()}>
                {busy === "commit" ? "กำลังนำเข้า..." : `ยืนยันนำเข้า ${preview.summary.validRows} สัญญา`}
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={reset}>
                ยกเลิก
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
