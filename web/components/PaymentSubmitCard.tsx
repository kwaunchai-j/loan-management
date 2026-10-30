"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { checkDate, checkMoney, formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { mySubmissionListSchema, mySubmissionSchema, type MySubmission, type SubmissionStatus } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { Alert, Badge, Button, Card, Spinner, TextAreaField, TextField } from "./ui";

/** Mirrors the API's default slip limit (5 MB); the API checks again and its answer wins. */
export const SUBMIT_MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png"];

const STATUS: Record<SubmissionStatus, { label: string; tone: "amber" | "green" | "red" }> = {
  PENDING: { label: "รอผู้ให้กู้ตรวจ", tone: "amber" },
  CONFIRMED: { label: "ยืนยันแล้ว", tone: "green" },
  REJECTED: { label: "ไม่ได้รับการยืนยัน", tone: "red" },
};

/**
 * "I paid": the borrower sends the amount, the day of the transfer and the slip. This is only a
 * CLAIM — it changes no balance. The balance goes down when the lender checks the slip and confirms.
 * Shown for a contract that is paid out and still open.
 */
export function PaymentSubmitCard({ contractId, disbursedOn }: { contractId: string; disbursedOn: string | null }) {
  const list = useApi("/me/payment-submissions", mySubmissionListSchema);
  const mine = list.data?.items.filter((s) => s.contract.id === contractId) ?? [];
  const pending = mine.filter((s) => s.status === "PENDING").length;

  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayBangkok());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<{ amount?: string; paidOn?: string; file?: string; note?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const today = todayBangkok();

  function pick(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setErrors((x) => ({ ...x, file: undefined }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    setSentNotice(false);
    const problems = {
      amount: checkMoney(amount) ?? undefined,
      paidOn:
        checkDate(paidOn, "วันที่โอน") ??
        (paidOn > today ? "วันที่โอนต้องไม่เป็นวันในอนาคต" : undefined) ??
        (disbursedOn && paidOn < disbursedOn ? "วันที่โอนต้องไม่ก่อนวันที่ได้รับเงิน" : undefined),
      file: !file
        ? "กรุณาแนบสลิปการโอนเงิน"
        : !ACCEPTED.includes(file.type)
          ? "รองรับเฉพาะไฟล์รูป JPEG หรือ PNG"
          : file.size > SUBMIT_MAX_BYTES
            ? "ไฟล์ใหญ่เกิน 5 MB"
            : undefined,
      note: note.trim().length > 500 ? "หมายเหตุยาวไม่เกิน 500 ตัวอักษร" : undefined,
    };
    setErrors(problems);
    if (problems.amount || problems.paidOn || problems.file || problems.note || !file) return;
    const params = new URLSearchParams({ amount: amount.trim(), paidOn });
    if (note.trim()) params.set("note", note.trim());
    setBusy(true);
    try {
      await apiFetch(`/me/contracts/${encodeURIComponent(contractId)}/payment-submissions?${params.toString()}`, {
        method: "POST",
        file,
        schema: mySubmissionSchema,
      });
      setAmount("");
      setNote("");
      setFile(null);
      if (input.current) input.current.value = "";
      setSentNotice(true);
      list.reload();
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="แจ้งชำระเงิน (ส่งสลิป)">
      <p className="mb-3 text-sm text-slate-700">
        โอนเงินให้ผู้ให้กู้แล้ว แนบสลิปที่นี่ได้เลย <strong>ยอดค้างจะยังไม่ลดลงทันที</strong> จนกว่าผู้ให้กู้ตรวจสลิปและกดยืนยัน
      </p>
      {sentNotice && (
        <div className="mb-3">
          <Alert kind="success">ส่งสลิปแล้ว ผู้ให้กู้จะตรวจสอบ ยอดค้างจะลดลงเมื่อผู้ให้กู้ยืนยัน</Alert>
        </div>
      )}
      {apiError && (
        <div className="mb-3">
          <Alert kind="error">{apiError}</Alert>
        </div>
      )}
      {pending > 0 && <p className="mb-3 text-sm font-medium text-amber-900">มีสลิปรอผู้ให้กู้ตรวจอยู่ {pending} รายการ</p>}
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <TextField label="จำนวนเงินที่โอน (บาท)" inputMode="decimal" autoComplete="off" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
        <TextField label="วันที่โอน" type="date" min={disbursedOn ?? undefined} max={today} value={paidOn} error={errors.paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        <div className="space-y-1">
          <label className="block text-sm font-medium text-slate-800">
            สลิปการโอนเงิน (ภาพ JPEG หรือ PNG ไม่เกิน 5 MB)
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png"
              onChange={pick}
              className="mt-1 block min-h-11 w-full text-base file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-teal-700 file:px-4 file:font-medium file:text-white"
            />
          </label>
          {file && <p className="text-sm text-slate-600">เลือกแล้ว: {file.name}</p>}
          {errors.file && (
            <p role="alert" className="text-sm font-medium text-red-700">
              {errors.file}
            </p>
          )}
        </div>
        <TextAreaField label="หมายเหตุ (ไม่บังคับ)" value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {busy ? "กำลังส่ง..." : "ส่งสลิป"}
        </Button>
      </form>

      <h3 className="mb-2 mt-6 font-semibold text-slate-900">สลิปที่เคยส่ง</h3>
      {list.loading && <Spinner />}
      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.data && mine.length === 0 && <p className="text-sm text-slate-600">ยังไม่เคยส่งสลิปของสัญญานี้</p>}
      <ul className="divide-y divide-slate-100">
        {mine.map((s) => (
          <SubmissionRow key={s.id} s={s} />
        ))}
      </ul>
    </Card>
  );
}

function SubmissionRow({ s }: { s: MySubmission }) {
  const st = STATUS[s.status];
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-semibold text-slate-900">
          {formatBaht(s.amount)} บาท · โอนวันที่ {formatDay(s.paidOn)}
        </p>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      {s.note && <p className="text-sm text-slate-700">หมายเหตุ: {s.note}</p>}
      {s.status === "REJECTED" && s.rejectReason && <p className="text-sm font-medium text-red-800">เหตุผล: {s.rejectReason}</p>}
      {s.status === "REJECTED" && <p className="text-sm text-slate-700">ถ้าโอนจริงแล้ว ส่งสลิปใหม่ให้ชัดเจนได้ หรือติดต่อผู้ให้กู้</p>}
      <p className="text-xs text-slate-500">ส่งเมื่อ {formatDateTime(s.createdAt)}</p>
    </li>
  );
}
