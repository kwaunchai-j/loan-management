"use client";

import { useState } from "react";
import { Alert, Button, Card, TextAreaField, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { checkDate, checkMoney, formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { contractOnlySchema, disbursementResultSchema, paymentResultSchema, type AdminContractDetail, type DisbursementRow, type Payment } from "@/lib/schemas";
import { allocationText } from "./PaymentPanel";
import { SlipPicker } from "./SlipPicker";

/** What editing or deleting an old record does (DES-016) — shown before every such change. */
export const RECALC_WARNING =
  "ระบบจะคำนวณสัญญานี้ใหม่ทั้งสัญญา ค่าปรับและยอดคงเหลืออาจเปลี่ยน รายงานของช่วงเวลาที่ผ่านมาแล้วจะเปลี่ยนตาม และการแจ้งเตือนที่ส่งไปแล้วจะไม่ถูกเรียกคืน การแก้ไขนี้ถูกบันทึกไว้ในประวัติการใช้งาน";

interface Handlers {
  onChanged: (text: string) => void;
}

export function DisbursementRecord({ d, onChanged }: { d: DisbursementRow } & Handlers) {
  const [mode, setMode] = useState<"idle" | "edit" | "delete">("idle");
  const [showSlip, setShowSlip] = useState(false);
  return (
    <Card title="การจ่ายเงินให้ผู้ยืม">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-slate-600">จำนวนที่โอน</dt>
          <dd className="font-semibold">{formatBaht(d.amount)} บาท</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-600">วันที่โอน</dt>
          <dd>{formatDay(d.paidOn)}</dd>
        </div>
        {d.note && (
          <div className="sm:col-span-2">
            <dt className="text-sm text-slate-600">หมายเหตุ</dt>
            <dd>{d.note}</dd>
          </div>
        )}
      </dl>
      <div className="mt-3">
        <Button variant="secondary" aria-expanded={showSlip} onClick={() => setShowSlip((s) => !s)}>
          {showSlip ? "ซ่อนสลิป" : "ดูสลิป"}
        </Button>
        {showSlip && (
          <div className="mt-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- the slip comes from the API (session cookie), not a static asset */}
            <img src={`/api/admin/slips/${encodeURIComponent(d.slipFileKey)}`} alt="สลิปการโอนเงิน" className="max-h-96 rounded border border-slate-200" />
          </div>
        )}
      </div>

      {mode === "idle" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode("edit")}>
            แก้ไขรายการจ่ายเงิน
          </Button>
          <Button variant="secondary" onClick={() => setMode("delete")}>
            ลบรายการจ่ายเงิน
          </Button>
        </div>
      )}
      {mode === "edit" && <DisbursementEdit d={d} onCancel={() => setMode("idle")} onChanged={onChanged} />}
      {mode === "delete" && <DeleteConfirm what="รายการจ่ายเงินนี้" path={`/admin/disbursements/${encodeURIComponent(d.id)}`} extra="ลบได้เมื่อไม่มีรายการรับชำระเหลืออยู่ สัญญาจะกลับเป็น “รอจ่ายเงิน” และดอกเบี้ย/ค่าปรับของสัญญาจะถูกล้าง" onCancel={() => setMode("idle")} onChanged={onChanged} />}
    </Card>
  );
}

function DisbursementEdit({ d, onCancel, onChanged }: { d: DisbursementRow; onCancel: () => void } & Handlers) {
  const today = todayBangkok();
  const [paidOn, setPaidOn] = useState(d.paidOn);
  const [note, setNote] = useState(d.note ?? "");
  const [slipKey, setSlipKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ paidOn?: string; note?: string }>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setError(null);
    const problems = {
      paidOn: checkDate(paidOn, "วันที่โอนเงิน") ?? (paidOn > today ? "วันที่โอนเงินต้องไม่เป็นวันในอนาคต" : undefined),
      note: note.trim().length > 500 ? "หมายเหตุยาวไม่เกิน 500 ตัวอักษร" : undefined,
    };
    setFieldErrors(problems);
    if (problems.paidOn || problems.note) return;
    const body: Record<string, unknown> = {};
    if (paidOn !== d.paidOn) body.paidOn = paidOn;
    if (note.trim() !== (d.note ?? "")) body.note = note.trim() === "" ? null : note.trim();
    if (slipKey) body.slipFileKey = slipKey;
    if (Object.keys(body).length === 0) {
      setError("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/admin/disbursements/${encodeURIComponent(d.id)}`, { method: "PATCH", json: body, schema: disbursementResultSchema });
      onCancel(); // the record stays on the page after a save: close the edit panel
      onChanged("แก้ไขรายการจ่ายเงินแล้ว ระบบคำนวณสัญญาใหม่เรียบร้อย");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <Alert kind="warning">{RECALC_WARNING}</Alert>
      {error && <Alert kind="error">{error}</Alert>}
      <TextField label="วันที่โอนเงิน" type="date" max={today} value={paidOn} error={fieldErrors.paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      <SlipPicker label="เปลี่ยนสลิป (เว้นว่างไว้ถ้าใช้สลิปเดิม)" onChange={setSlipKey} />
      <TextAreaField label="หมายเหตุ" value={note} error={fieldErrors.note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "กำลังบันทึก..." : "ยืนยันแก้ไข"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          ยกเลิก
        </Button>
      </div>
    </div>
  );
}

function DeleteConfirm({ what, path, extra, onCancel, onChanged }: { what: string; path: string; extra?: string; onCancel: () => void } & Handlers) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, { method: "DELETE", schema: contractOnlySchema });
      onChanged(`ลบ${what}แล้ว ระบบคำนวณสัญญาใหม่เรียบร้อย`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-red-300 bg-red-50 p-3">
      <Alert kind="warning">
        {RECALC_WARNING}
        {extra ? ` ${extra}` : ""}
      </Alert>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="font-medium text-slate-900">ลบ{what}ใช่หรือไม่?</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={busy} onClick={() => void run()}>
          {busy ? "กำลังลบ..." : "ยืนยันลบ"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          ยกเลิก
        </Button>
      </div>
    </div>
  );
}

export function PaymentList({ contract, payments, onChanged }: { contract: AdminContractDetail["contract"]; payments: Payment[] } & Handlers) {
  return (
    <Card title="รายการรับชำระ">
      {payments.length === 0 ? (
        <p className="text-slate-700">ยังไม่มีรายการรับชำระ</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {payments.map((p) => (
            <PaymentRow key={p.id} p={p} contract={contract} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PaymentRow({ p, contract, onChanged }: { p: Payment; contract: AdminContractDetail["contract"] } & Handlers) {
  const [mode, setMode] = useState<"idle" | "edit" | "delete">("idle");
  return (
    <li className="py-3">
      <p className="font-semibold text-slate-900">
        {formatDay(p.paidOn)} · {formatBaht(p.amount)} บาท
      </p>
      <p className="text-sm text-slate-600">ตัดเป็น: {allocationText(p) || "-"}</p>
      {p.note && <p className="text-sm text-slate-700">หมายเหตุ: {p.note}</p>}
      <p className="text-xs text-slate-500">บันทึกเมื่อ {formatDateTime(p.createdAt)}</p>
      {mode === "idle" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode("edit")}>
            แก้ไข
          </Button>
          <Button variant="secondary" onClick={() => setMode("delete")}>
            ลบ
          </Button>
        </div>
      )}
      {mode === "edit" && <PaymentEdit p={p} disbursedOn={contract.disbursedOn} onCancel={() => setMode("idle")} onChanged={onChanged} />}
      {mode === "delete" && <DeleteConfirm what="รายการรับชำระนี้" path={`/admin/payments/${encodeURIComponent(p.id)}`} onCancel={() => setMode("idle")} onChanged={onChanged} />}
    </li>
  );
}

function PaymentEdit({ p, disbursedOn, onCancel, onChanged }: { p: Payment; disbursedOn: string | null; onCancel: () => void } & Handlers) {
  const today = todayBangkok();
  const [amount, setAmount] = useState(p.amount);
  const [paidOn, setPaidOn] = useState(p.paidOn);
  const [note, setNote] = useState(p.note ?? "");
  const [errors, setErrors] = useState<{ amount?: string; paidOn?: string; note?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError(null);
    const problems = {
      amount: checkMoney(amount) ?? undefined,
      paidOn:
        checkDate(paidOn, "วันที่ชำระ") ??
        (paidOn > today ? "วันที่ชำระต้องไม่เป็นวันในอนาคต" : undefined) ??
        (disbursedOn && paidOn < disbursedOn ? "วันที่ชำระต้องไม่ก่อนวันที่จ่ายเงิน" : undefined),
      note: note.trim().length > 500 ? "หมายเหตุยาวไม่เกิน 500 ตัวอักษร" : undefined,
    };
    setErrors(problems);
    if (problems.amount || problems.paidOn || problems.note) return;
    const body: Record<string, unknown> = {};
    // "100" and "100.00" are the same amount: compare as decimals written the same way
    if (formatBaht(amount.trim()) !== formatBaht(p.amount)) body.amount = amount.trim();
    if (paidOn !== p.paidOn) body.paidOn = paidOn;
    if (note.trim() !== (p.note ?? "")) body.note = note.trim() === "" ? null : note.trim();
    if (Object.keys(body).length === 0) {
      setError("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/admin/payments/${encodeURIComponent(p.id)}`, { method: "PATCH", json: body, schema: paymentResultSchema });
      onCancel(); // the row stays on the page after a save: close the edit panel
      onChanged("แก้ไขรายการรับชำระแล้ว ระบบคำนวณสัญญาใหม่เรียบร้อย");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <Alert kind="warning">{RECALC_WARNING}</Alert>
      {error && <Alert kind="error">{error}</Alert>}
      <TextField label="จำนวนเงิน (บาท)" inputMode="decimal" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
      <TextField label="วันที่ชำระ" type="date" min={disbursedOn ?? undefined} max={today} value={paidOn} error={errors.paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      <TextAreaField label="หมายเหตุ" value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "กำลังบันทึก..." : "ยืนยันแก้ไข"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          ยกเลิก
        </Button>
      </div>
    </div>
  );
}

export function AccrualTable({ accruals }: { accruals: AdminContractDetail["lateFeeAccruals"] }) {
  if (accruals.length === 0) return null;
  return (
    <Card title="ค่าปรับรายวัน">
      <details>
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-teal-800">ดูรายละเอียด {accruals.length} วัน</summary>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-600">
                <th className="py-2 pr-3 font-medium">วันที่</th>
                <th className="py-2 pr-3 text-right font-medium">ฐานที่คิด (บาท)</th>
                <th className="py-2 pr-3 text-right font-medium">อัตรา (%/วัน)</th>
                <th className="py-2 text-right font-medium">ค่าปรับ (บาท)</th>
              </tr>
            </thead>
            <tbody>
              {accruals.map((a) => (
                <tr key={a.date} className="border-b border-slate-100">
                  <td className="py-2 pr-3">{formatDay(a.date)}</td>
                  <td className="py-2 pr-3 text-right">{formatBaht(a.baseAmount)}</td>
                  <td className="py-2 pr-3 text-right">{a.ratePctPerDay}</td>
                  <td className="py-2 text-right">{formatBaht(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
