"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, TextAreaField, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { checkDate, formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { cancelledContractSchema, disbursementCreatedSchema, settingsSchema, type AdminContractDetail } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { SlipPicker } from "./SlipPicker";

/**
 * A contract waiting for its payout (DES-011): record the transfer (date + slip, the amount is always
 * the principal) or cancel the contract. Interest is worked out by the server from the rate in force
 * on the day, so nothing here asks for it.
 */
export function DisbursementPanel({ detail, onChanged }: { detail: AdminContractDetail; onChanged: (text: string) => void }) {
  const c = detail.contract;
  const settings = useApi("/admin/settings", settingsSchema);
  const ratesMissing = settings.data ? settings.data.interestRatePctPerMonth === null || settings.data.lateFeeRatePctPerDay === null : false;
  return (
    <>
      {ratesMissing && (
        <Alert kind="warning">
          ยังไม่ได้ตั้งอัตราดอกเบี้ยและค่าปรับ จึงบันทึกการจ่ายเงินไม่ได้{" "}
          <Link href="/admin/settings" className="font-medium underline">
            ไปตั้งค่าอัตรา
          </Link>
        </Alert>
      )}
      <PayoutForm contractId={c.id} principal={c.principal} dueDate={c.dueDate} onChanged={onChanged} />
      <CancelPanel contractId={c.id} contractNo={c.contractNo} onChanged={onChanged} />
    </>
  );
}

function PayoutForm({ contractId, principal, dueDate, onChanged }: { contractId: string; principal: string; dueDate: string; onChanged: (text: string) => void }) {
  const today = todayBangkok();
  const [paidOn, setPaidOn] = useState(today);
  const [slipKey, setSlipKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ paidOn?: string; slip?: string; note?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const problems = {
      paidOn: checkDate(paidOn, "วันที่โอนเงิน") ?? (paidOn > today ? "วันที่โอนเงินต้องไม่เป็นวันในอนาคต" : undefined) ?? (paidOn >= dueDate ? "วันครบกำหนดต้องอยู่หลังวันที่โอนเงินอย่างน้อย 1 วัน" : undefined),
      slip: slipKey ? undefined : "กรุณาแนบสลิปการโอนเงิน",
      note: note.trim().length > 500 ? "หมายเหตุยาวไม่เกิน 500 ตัวอักษร" : undefined,
    };
    setErrors(problems);
    if (problems.paidOn || problems.slip || problems.note || !slipKey) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/admin/contracts/${encodeURIComponent(contractId)}/disbursement`, {
        method: "POST",
        json: { paidOn, slipFileKey: slipKey, ...(note.trim() ? { note: note.trim() } : {}) },
        schema: disbursementCreatedSchema,
      });
      onChanged(
        `บันทึกการจ่ายเงินแล้ว ดอกเบี้ย ${formatBaht(r.contract.interestAmount)} บาท ยอดที่ต้องชำระ ${formatBaht(r.contract.totalDue)} บาท`,
      );
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="บันทึกการจ่ายเงินให้ผู้ยืม">
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        {apiError && <Alert kind="error">{apiError}</Alert>}
        <p className="text-slate-800">
          จำนวนที่โอน: <strong>{formatBaht(principal)} บาท</strong> (เท่ากับที่ขอเสมอ) · ครบกำหนด {formatDay(dueDate)}
        </p>
        <TextField label="วันที่โอนเงิน" type="date" max={today} value={paidOn} error={errors.paidOn} hint="ย้อนหลังได้ ดอกเบี้ยคิดจากวันนี้ถึงวันครบกำหนด" onChange={(e) => setPaidOn(e.target.value)} />
        <SlipPicker error={errors.slip} onChange={setSlipKey} />
        <TextAreaField label="หมายเหตุ (ไม่บังคับ)" value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {busy ? "กำลังบันทึก..." : "บันทึกการจ่ายเงิน"}
        </Button>
      </form>
    </Card>
  );
}

function CancelPanel({ contractId, contractNo, onChanged }: { contractId: string; contractNo: string; onChanged: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (reason.trim().length > 500) {
      setError("เหตุผลยาวไม่เกิน 500 ตัวอักษร");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/admin/contracts/${encodeURIComponent(contractId)}/cancel`, {
        method: "POST",
        json: reason.trim() ? { reason: reason.trim() } : {},
        schema: cancelledContractSchema,
      });
      onChanged(`ยกเลิกสัญญา ${contractNo} แล้ว`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card title="ยกเลิกสัญญา">
      <p className="mb-3 text-sm text-slate-700">ยกเลิกได้ตราบที่ยังไม่ได้บันทึกการจ่ายเงิน สัญญาที่ยกเลิกแล้วจะไม่มียอดชำระ</p>
      {error && <Alert kind="error">{error}</Alert>}
      {open ? (
        <div className="mt-3 space-y-3 rounded-lg border border-red-200 bg-red-50 p-3">
          <TextAreaField label="เหตุผล (ไม่บังคับ)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
              {busy ? "กำลังยกเลิก..." : `ยืนยันยกเลิกสัญญา ${contractNo}`}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              ย้อนกลับ
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" onClick={() => setOpen(true)}>
          ยกเลิกสัญญา
        </Button>
      )}
    </Card>
  );
}
