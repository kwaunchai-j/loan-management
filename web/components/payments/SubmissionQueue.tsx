"use client";

import Link from "next/link";
import { useState } from "react";
import { allocationText } from "@/components/contract/PaymentPanel";
import { Alert, Badge, Button, SelectField, Spinner, TextAreaField, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { checkDate, checkMoney, formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { adminSubmissionListSchema, adminSubmissionSchema, submissionConfirmedSchema, type AdminSubmission, type SubmissionStatus } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

const PAGE_SIZE = 20;
const FILTERS: Array<[SubmissionStatus | "", string]> = [
  ["PENDING", "รอตรวจ"],
  ["CONFIRMED", "ยืนยันแล้ว"],
  ["REJECTED", "ไม่ยืนยัน"],
  ["", "ทั้งหมด"],
];
const STATUS: Record<SubmissionStatus, { label: string; tone: "amber" | "green" | "red" }> = {
  PENDING: { label: "รอตรวจ", tone: "amber" },
  CONFIRMED: { label: "ยืนยันแล้ว", tone: "green" },
  REJECTED: { label: "ไม่ยืนยัน", tone: "red" },
};

/** The slips borrowers sent. The oldest waiting one comes first; each is confirmed (a real payment) or refused. */
export function SubmissionQueue() {
  const [status, setStatus] = useState<SubmissionStatus | "">("PENDING");
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (status) params.set("status", status);
  const list = useApi(`/admin/payment-submissions?${params.toString()}`, adminSubmissionListSchema);
  const total = list.data?.total ?? 0;

  return (
    <>
      <SelectField
        label="แสดงสลิป"
        value={status}
        onChange={(e) => {
          setStatus(e.target.value as SubmissionStatus | "");
          setOffset(0);
        }}
      >
        {FILTERS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.loading && <Spinner />}
      {list.data && list.data.items.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-slate-700">{status === "PENDING" ? "ไม่มีสลิปที่รอตรวจ" : "ไม่มีรายการ"}</p>
      )}

      <ul className="space-y-3">
        {list.data?.items.map((s) => (
          <SubmissionItem
            key={s.id}
            s={s}
            onDone={(text) => {
              setNotice({ kind: "success", text });
              list.reload();
            }}
            onError={(text) => setNotice({ kind: "error", text })}
          />
        ))}
      </ul>

      {list.data && total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            แสดง {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total} รายการ
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              ก่อนหน้า
            </Button>
            <Button variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              ถัดไป
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

type Mode = "idle" | "confirm" | "reject";

function SubmissionItem({ s, onDone, onError }: { s: AdminSubmission; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [showSlip, setShowSlip] = useState(false);
  const st = STATUS[s.status];

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={`/admin/borrowers/${encodeURIComponent(s.borrower.id)}`} className="text-lg font-semibold text-teal-800 hover:underline">
          {s.borrower.fullName}
        </Link>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <p className="text-xl font-bold text-slate-900">{formatBaht(s.amount)} บาท</p>
      <p className="text-sm text-slate-700">
        โอนวันที่ {formatDay(s.paidOn)} · สัญญา{" "}
        <Link href={`/admin/contracts/${encodeURIComponent(s.contract.id)}`} className="font-medium text-teal-800 underline">
          {s.contract.contractNo}
        </Link>{" "}
        · ส่งเมื่อ {formatDateTime(s.createdAt)}
      </p>
      {s.note && <p className="text-sm text-slate-700">หมายเหตุจากผู้ยืม: {s.note}</p>}
      {s.status === "REJECTED" && s.rejectReason && <p className="text-sm font-medium text-red-800">เหตุผลที่ไม่ยืนยัน: {s.rejectReason}</p>}
      {s.status === "CONFIRMED" && <p className="text-sm text-emerald-800">บันทึกเป็นรายการรับชำระแล้ว{s.paymentId ? "" : " (รายการรับชำระถูกลบภายหลัง)"}</p>}

      <div className="mt-3">
        <Button variant="secondary" aria-expanded={showSlip} onClick={() => setShowSlip((v) => !v)}>
          {showSlip ? "ซ่อนสลิป" : "ดูสลิป"}
        </Button>
        {showSlip && (
          <div className="mt-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- the slip comes from the API (session cookie), not a static asset */}
            <img src={`/api/admin/slips/${encodeURIComponent(s.slipFileKey)}`} alt={`สลิปของ ${s.borrower.fullName}`} className="max-h-96 rounded border border-slate-200" />
          </div>
        )}
      </div>

      {s.status === "PENDING" && mode === "idle" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => setMode("confirm")}>ตรวจแล้ว ยืนยัน</Button>
          <Button variant="secondary" onClick={() => setMode("reject")}>
            ไม่ยืนยัน
          </Button>
        </div>
      )}
      {mode === "confirm" && <ConfirmPanel s={s} onCancel={() => setMode("idle")} onDone={onDone} />}
      {mode === "reject" && <RejectPanel s={s} onCancel={() => setMode("idle")} onDone={onDone} onError={onError} />}
    </li>
  );
}

function ConfirmPanel({ s, onCancel, onDone }: { s: AdminSubmission; onCancel: () => void; onDone: (t: string) => void }) {
  const today = todayBangkok();
  const [amount, setAmount] = useState(s.amount);
  const [paidOn, setPaidOn] = useState(s.paidOn);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; paidOn?: string; note?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setApiError(null);
    const problems = {
      amount: checkMoney(amount) ?? undefined,
      paidOn: checkDate(paidOn, "วันที่รับชำระ") ?? (paidOn > today ? "วันที่รับชำระต้องไม่เป็นวันในอนาคต" : undefined),
      note: note.trim().length > 500 ? "หมายเหตุยาวไม่เกิน 500 ตัวอักษร" : undefined,
    };
    setErrors(problems);
    if (problems.amount || problems.paidOn || problems.note) return;
    // only what was corrected is sent: everything else is taken from the borrower's claim
    const body: Record<string, string> = {};
    if (formatBaht(amount.trim()) !== formatBaht(s.amount)) body.amount = amount.trim();
    if (paidOn !== s.paidOn) body.paidOn = paidOn;
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    try {
      const r = await apiFetch(`/admin/payment-submissions/${encodeURIComponent(s.id)}/confirm`, { method: "POST", json: body, schema: submissionConfirmedSchema });
      onDone(
        `ยืนยันแล้ว บันทึกรับชำระ ${formatBaht(r.payment.amount)} บาท ตัดเป็น ${allocationText(r.payment)} · ${
          r.contract.status === "CLOSED" ? "ชำระครบ ปิดสัญญาแล้ว" : `ยอดที่ต้องชำระคงเหลือ ${formatBaht(r.contract.totalDue)} บาท`
        }`,
      );
    } catch (err) {
      setApiError(errorMessage(err)); // shown inside the panel, which stays open for a correction
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-teal-200 bg-teal-50 p-3">
      <p className="text-sm text-slate-800">
        ตรวจยอดและวันที่กับสลิปแล้วแก้ให้ตรงได้ การยืนยันจะ <strong>บันทึกรับชำระจริง</strong> (ตัดค่าปรับ → ดอกเบี้ย → เงินต้น จ่ายเกินยอดที่ติดไม่ได้) ถ้าบันทึกผิดแก้หรือลบได้ที่หน้าสัญญา
      </p>
      {apiError && <Alert kind="error">{apiError}</Alert>}
      <TextField label="จำนวนเงินที่รับชำระ (บาท)" inputMode="decimal" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
      <TextField label="วันที่รับชำระ" type="date" max={today} value={paidOn} error={errors.paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      <TextAreaField label="หมายเหตุของรายการรับชำระ (เว้นว่างใช้ข้อความอัตโนมัติ)" value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void confirm()}>
          {busy ? "กำลังบันทึก..." : "ยืนยันและบันทึกรับชำระ"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          ย้อนกลับ
        </Button>
      </div>
    </div>
  );
}

function RejectPanel({ s, onCancel, onDone, onError }: { s: AdminSubmission; onCancel: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reject() {
    if (reason.trim() === "") return setProblem("กรุณาระบุเหตุผล ผู้ยืมจะเห็นข้อความนี้");
    if (reason.trim().length > 500) return setProblem("เหตุผลยาวไม่เกิน 500 ตัวอักษร");
    setProblem(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/payment-submissions/${encodeURIComponent(s.id)}/reject`, { method: "POST", json: { reason: reason.trim() }, schema: adminSubmissionSchema });
      onDone("บันทึกว่าไม่ยืนยันแล้ว ผู้ยืมจะเห็นเหตุผล");
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-red-200 bg-red-50 p-3">
      <TextAreaField label="เหตุผลที่ไม่ยืนยัน (ผู้ยืมจะเห็น)" value={reason} error={problem} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={busy} onClick={() => void reject()}>
          {busy ? "กำลังบันทึก..." : "ยืนยันไม่ยืนยันสลิปนี้"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          ย้อนกลับ
        </Button>
      </div>
    </div>
  );
}
