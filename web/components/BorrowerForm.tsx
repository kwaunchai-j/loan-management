"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, TextField } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import {
  checkBankAccount,
  checkBankName,
  checkFullName,
  checkPhone,
} from "@/lib/validation";

export interface BorrowerFields {
  fullName: string;
  phone: string;
  bankName: string;
  bankAccountNo: string;
}

type Errors = Partial<Record<keyof BorrowerFields, string>>;

/**
 * Why a field is wrong, or nothing. When `required` (creating a borrower) only the name must be given: the borrower
 * fills in the phone number and the account number themself later (CR-5); what is typed is still checked.
 * When editing, an empty field is simply left alone.
 */
function validate(values: BorrowerFields, required: boolean): Errors {
  const out: Errors = {};
  const rules: Array<[keyof BorrowerFields, (v: string) => string | null]> = [
    ["fullName", checkFullName],
    ["phone", checkPhone],
    ["bankName", checkBankName],
    ["bankAccountNo", checkBankAccount],
  ];
  for (const [field, rule] of rules) {
    if (values[field].trim() === "" && !(required && field === "fullName")) continue;
    const problem = rule(values[field]);
    if (problem) out[field] = problem;
  }
  return out;
}

/**
 * The borrower's own details (name, phone, bank, account number). The same form creates (only the name
 * required) and edits (only fields that were changed are sent; an empty one that was already empty is
 * left alone). `onSubmit` receives only what should be sent.
 */
export function BorrowerForm({
  initial,
  required,
  submitLabel,
  onSubmit,
  extra,
  precheck,
}: {
  initial: BorrowerFields;
  required: boolean;
  submitLabel: string;
  onSubmit: (values: Partial<BorrowerFields>) => Promise<void>;
  /** More fields the page owns (e.g. the login name and password when creating). */
  extra?: React.ReactNode;
  /** Checks those extra fields; a returned message stops the submit and is shown. */
  precheck?: () => string | null;
}) {
  const [values, setValues] = useState<BorrowerFields>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof BorrowerFields) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const found = validate(values, required);
    setErrors(found);
    const extraProblem = precheck?.() ?? null;
    if (extraProblem) setApiError(extraProblem);
    if (Object.keys(found).length > 0 || extraProblem) return;

    const send: Partial<BorrowerFields> = {};
    for (const k of Object.keys(values) as Array<keyof BorrowerFields>) {
      const v = values[k].trim();
      // when creating, the name and whatever else was typed are sent; when editing, only what actually changed
      if (required ? k === "fullName" || v !== "" : v !== "" && v !== initial[k].trim()) send[k] = v;
    }
    if (!required && Object.keys(send).length === 0) {
      setApiError("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(send);
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {apiError && <Alert kind="error">{apiError}</Alert>}
      <TextField label="ชื่อ-นามสกุล" autoComplete="off" value={values.fullName} error={errors.fullName} onChange={set("fullName")} />
      {required && (
        <p className="rounded-xl border border-teal-200 bg-teal-50/60 p-3 text-sm text-slate-800">
          กรอกแค่ชื่อก็สร้างได้ เบอร์โทรศัพท์ ธนาคาร และเลขบัญชี <strong>ผู้ยืมจะกรอกเอง</strong>หลังเข้าสู่ระบบครั้งแรก (ที่เมนู ข้อมูลของฉัน) — ใส่ให้เองตรงนี้ได้ถ้ามีข้อมูลอยู่แล้ว
        </p>
      )}
      <TextField
        label="เบอร์โทรศัพท์"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        value={values.phone}
        error={errors.phone}
        hint={required ? "ไม่บังคับ" : undefined}
        onChange={set("phone")}
      />
      <TextField label="ธนาคารที่รับเงิน" autoComplete="off" value={values.bankName} error={errors.bankName} hint={required ? "ไม่บังคับ" : undefined} onChange={set("bankName")} />
      <TextField
        label="เลขบัญชี"
        inputMode="numeric"
        autoComplete="off"
        value={values.bankAccountNo}
        error={errors.bankAccountNo}
        hint={required ? "ไม่บังคับ · ตัวเลขและขีด (-) เท่านั้น" : "ตัวเลขและขีด (-) เท่านั้น"}
        onChange={set("bankAccountNo")}
      />
      {extra}
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
        {busy ? "กำลังบันทึก..." : submitLabel}
      </Button>
    </form>
  );
}
