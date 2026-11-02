"use client";

import { useState } from "react";
import { Alert, Button, Card, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { checkDate, checkMoney, todayBangkok } from "@/lib/money";
import { contractOnlySchema, type AdminContractDetail } from "@/lib/schemas";
import { RECALC_WARNING } from "./History";

/**
 * ADMIN corrects the terms of a contract: principal and due date while it waits for the payout, plus the
 * interest once the money is out. The total owed is not typed in: it is principal + interest + late fee,
 * so it follows. The server enforces the same rules.
 */
export function ContractEdit({ contract, onChanged }: { contract: AdminContractDetail["contract"]; onChanged: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [principal, setPrincipal] = useState(contract.principal);
  const [dueDate, setDueDate] = useState(contract.dueDate);
  const [interest, setInterest] = useState(contract.interestAmount ?? "");
  const [errors, setErrors] = useState<{ principal?: string; interest?: string; dueDate?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayBangkok();
  const awaiting = contract.status === "AWAITING_DISBURSEMENT";

  if (contract.status === "CANCELLED") return null;

  function close() {
    setOpen(false);
    setErrors({});
    setApiError(null);
    setPrincipal(contract.principal);
    setDueDate(contract.dueDate);
    setInterest(contract.interestAmount ?? "");
  }

  async function save() {
    setApiError(null);
    const dueChanged = dueDate !== contract.dueDate;
    const interestChanged = !awaiting && Number(interest) !== Number(contract.interestAmount);
    const problems = {
      principal: checkMoney(principal, "เงินต้น") ?? undefined,
      interest: interestChanged && !/^\d{1,12}(\.\d{1,2})?$/.test(interest.trim()) ? "ดอกเบี้ยต้องไม่ติดลบและมีทศนิยมไม่เกิน 2 ตำแหน่ง" : undefined,
      dueDate: !dueChanged
        ? undefined
        : (checkDate(dueDate, "วันครบกำหนด") ?? undefined) ??
          (dueDate <= today ? "วันครบกำหนดต้องเป็นวันในอนาคต" : undefined) ??
          (contract.disbursedOn && dueDate <= contract.disbursedOn ? "วันครบกำหนดต้องอยู่หลังวันที่จ่ายเงินอย่างน้อย 1 วัน" : undefined),
    };
    setErrors(problems);
    if (problems.principal || problems.interest || problems.dueDate) return;
    const body: Record<string, string> = {};
    if (Number(principal) !== Number(contract.principal)) body.principal = principal.trim();
    if (interestChanged) body.interestAmount = interest.trim();
    if (dueChanged) body.dueDate = dueDate;
    if (Object.keys(body).length === 0) {
      setApiError("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/admin/contracts/${encodeURIComponent(contract.id)}`, { method: "PATCH", json: body, schema: contractOnlySchema });
      close();
      setBusy(false);
      onChanged("แก้ไขสัญญาแล้ว");
    } catch (err) {
      setApiError(errorMessage(err));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          แก้ไขสัญญา
        </Button>
      </div>
    );
  }
  return (
    <Card title="แก้ไขสัญญา">
      <div className="space-y-3">
        {!awaiting && <Alert kind="warning">{RECALC_WARNING}</Alert>}
        {apiError && <Alert kind="error">{apiError}</Alert>}
        <TextField label="เงินต้น (บาท)" inputMode="decimal" value={principal} error={errors.principal} onChange={(e) => setPrincipal(e.target.value)} />
        {!awaiting && (
          <>
            <TextField label="ดอกเบี้ย (บาท)" inputMode="decimal" value={interest} error={errors.interest} onChange={(e) => setInterest(e.target.value)} />
            <p className="text-sm text-slate-600">
              ถ้าแก้เงินต้นหรือวันครบกำหนดโดยไม่แก้ช่องดอกเบี้ย ระบบจะคำนวณดอกเบี้ยใหม่ด้วยอัตราที่ล็อกไว้ตอนจ่ายเงิน ถ้าแก้ช่องดอกเบี้ยเอง จะใช้ตัวเลขที่กรอก ยอดรวมที่ต้องชำระ = เงินต้น + ดอกเบี้ย + ค่าปรับ ระบบอัปเดตให้เอง
            </p>
          </>
        )}
        <TextField label="วันครบกำหนด" type="date" min={contract.disbursedOn ?? today} value={dueDate} error={errors.dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "กำลังบันทึก..." : "บันทึก"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={close}>
            ยกเลิก
          </Button>
        </div>
      </div>
    </Card>
  );
}
