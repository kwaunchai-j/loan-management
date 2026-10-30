"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, Card, TextAreaField, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { checkDate, checkMoney, formatBaht, isZeroMoney, todayBangkok } from "@/lib/money";
import { paymentResultSchema, type AdminContractDetail, type Payment } from "@/lib/schemas";

/** "ตัดเป็น: ค่าปรับ 50.00 · ดอกเบี้ย 200.00 · เงินต้น 50.00" — only the parts that are not zero. */
export function allocationText(p: Pick<Payment, "allocatedLateFee" | "allocatedInterest" | "allocatedPrincipal">): string {
  return [
    !isZeroMoney(p.allocatedLateFee) ? `ค่าปรับ ${formatBaht(p.allocatedLateFee)}` : null,
    !isZeroMoney(p.allocatedInterest) ? `ดอกเบี้ย ${formatBaht(p.allocatedInterest)}` : null,
    !isZeroMoney(p.allocatedPrincipal) ? `เงินต้น ${formatBaht(p.allocatedPrincipal)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Records a payment on an ACTIVE contract (DES-011). The wording "จ่ายเพื่อลดยอดรวมที่ติด" is the one the
 * owner chose. The server rules: more than 0, never above what is owed on the payment date, not before
 * the payout, not in the future; the order of settling is late fee → interest → principal. The
 * "ชำระครบ" button only fills in the amount owed TODAY; the server still checks it.
 */
export function PaymentPanel({ detail, onChanged }: { detail: AdminContractDetail; onChanged: (text: string) => void }) {
  const c = detail.contract;
  const today = todayBangkok();
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; paidOn?: string; note?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const problems = {
      amount: checkMoney(amount) ?? undefined,
      paidOn:
        checkDate(paidOn, "วันที่ชำระ") ??
        (paidOn > today ? "วันที่ชำระต้องไม่เป็นวันในอนาคต" : undefined) ??
        (c.disbursedOn && paidOn < c.disbursedOn ? "วันที่ชำระต้องไม่ก่อนวันที่จ่ายเงิน" : undefined),
      note: note.trim().length > 500 ? "หมายเหตุยาวไม่เกิน 500 ตัวอักษร" : undefined,
    };
    setErrors(problems);
    if (problems.amount || problems.paidOn || problems.note) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/admin/contracts/${encodeURIComponent(c.id)}/payments`, {
        method: "POST",
        json: { amount: amount.trim(), paidOn, ...(note.trim() ? { note: note.trim() } : {}) },
        schema: paymentResultSchema,
      });
      setAmount("");
      setNote("");
      onChanged(
        `บันทึกรับชำระ ${formatBaht(r.payment.amount)} บาทแล้ว ตัดเป็น ${allocationText(r.payment)} · ${
          r.contract.status === "CLOSED" ? "ชำระครบ ปิดสัญญาแล้ว" : `ยอดที่ต้องชำระคงเหลือ ${formatBaht(r.contract.totalDue)} บาท`
        }`,
      );
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="จ่ายเพื่อลดยอดรวมที่ติด">
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        {apiError && <Alert kind="error">{apiError}</Alert>}
        <p className="text-slate-800">
          ยอดที่ต้องชำระวันนี้: <strong>{formatBaht(c.totalDue)} บาท</strong>
        </p>
        <p className="text-sm text-slate-600">จ่ายเกินยอดที่ต้องชำระไม่ได้ ระบบตัดค่าปรับก่อน แล้วดอกเบี้ย แล้วเงินต้น ดอกเบี้ยไม่ลดตามการจ่ายบางส่วน</p>
        <TextField label="จำนวนเงินที่รับชำระ (บาท)" inputMode="decimal" autoComplete="off" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
        {paidOn === today && c.totalDue !== null && (
          <Button variant="secondary" onClick={() => setAmount(c.totalDue ?? "")}>
            ชำระครบ ({formatBaht(c.totalDue)} บาท)
          </Button>
        )}
        <TextField
          label="วันที่ชำระ"
          type="date"
          min={c.disbursedOn ?? undefined}
          max={today}
          value={paidOn}
          error={errors.paidOn}
          hint="ย้อนหลังได้ แต่ไม่ก่อนวันที่จ่ายเงิน และไม่เกินวันนี้ ถ้าเลือกวันอื่น ยอดชำระครบของวันนั้นอาจต่างจากข้างบน"
          onChange={(e) => setPaidOn(e.target.value)}
        />
        <TextAreaField label="หมายเหตุ (ไม่บังคับ)" value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {busy ? "กำลังบันทึก..." : "บันทึกรับชำระ"}
        </Button>
      </form>
    </Card>
  );
}
