"use client";

import Link from "next/link";
import { useState } from "react";
import { RequestStatusBadge } from "@/components/status";
import { Alert, Button, Card, PageTitle, SelectField, Spinner, TextAreaField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatBaht, formatDay } from "@/lib/money";
import { requestListSchema, requestSchema, type LoanRequest } from "@/lib/schemas";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

const PAGE_SIZE = 20;
const FILTERS = [
  ["PENDING", "รอพิจารณา"],
  ["APPROVED", "อนุมัติแล้ว"],
  ["REJECTED", "ไม่อนุมัติ"],
  ["CANCELLED", "ยกเลิกแล้ว"],
  ["", "ทั้งหมด"],
] as const;

export default function RequestsPage() {
  const [status, setStatus] = useState<string>("PENDING");
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (status) params.set("status", status);
  const list = useApi(`/admin/loan-requests?${params.toString()}`, requestListSchema);
  const total = list.data?.total ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>คำขอยืมเงิน</PageTitle>
        <Link
          href="/admin/requests/new"
          className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 font-medium text-white hover:bg-teal-800"
        >
          + สร้างคำขอแทนผู้ยืม
        </Link>
      </div>

      <SelectField
        label="แสดงคำขอ"
        value={status}
        onChange={(e) => {
          setStatus(e.target.value);
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
        <Card>
          <p className="text-slate-700">{status === "PENDING" ? "ไม่มีคำขอที่รอพิจารณา" : "ไม่มีรายการ"}</p>
        </Card>
      )}

      <ul className="space-y-3">
        {list.data?.items.map((r) => (
          <RequestItem
            key={r.id}
            r={r}
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

type Mode = "idle" | "approve" | "reject" | "cancel";

function RequestItem({ r, onDone, onError }: { r: LoanRequest; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(path: string, json: unknown, doneText: string) {
    setBusy(true);
    try {
      await apiFetch(`/admin/loan-requests/${encodeURIComponent(r.id)}/${path}`, { method: "POST", json, schema: requestSchema });
      setMode("idle");
      onDone(doneText);
    } catch (err) {
      setMode("idle");
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function reject() {
    if (reason.trim() === "") {
      setReasonError("กรุณาระบุเหตุผลที่ไม่อนุมัติ");
      return;
    }
    if (reason.trim().length > 500) {
      setReasonError("เหตุผลยาวไม่เกิน 500 ตัวอักษร");
      return;
    }
    void run("reject", { reason: reason.trim() }, "บันทึกการไม่อนุมัติแล้ว");
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={`/admin/borrowers/${encodeURIComponent(r.borrower.id)}`} className="text-lg font-semibold text-teal-800 hover:underline">
          {r.borrower.fullName}
        </Link>
        <RequestStatusBadge status={r.status} />
      </div>
      <p className="text-xl font-bold text-slate-900">{formatBaht(r.amount)} บาท</p>
      <p className="text-sm text-slate-700">
        ขอคืนวันที่ {formatDay(r.requestedDueDate)} · ยื่นเมื่อ {formatDateTime(r.createdAt)}
      </p>
      {r.status === "REJECTED" && r.rejectReason && <p className="mt-1 text-sm text-red-800">เหตุผล: {r.rejectReason}</p>}
      {r.contract && (
        <p className="mt-1 text-sm">
          <Link href={`/admin/contracts/${encodeURIComponent(r.contract.id)}`} className="font-medium text-teal-800 underline">
            สัญญา {r.contract.contractNo}
          </Link>
        </p>
      )}

      {r.status === "PENDING" && mode === "idle" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => setMode("approve")}>อนุมัติ</Button>
          <Button variant="secondary" onClick={() => setMode("reject")}>
            ไม่อนุมัติ
          </Button>
          <Button variant="secondary" onClick={() => setMode("cancel")}>
            ยกเลิกคำขอ
          </Button>
        </div>
      )}

      {mode === "approve" && (
        <div className="mt-3 space-y-2 rounded-lg border border-teal-200 bg-teal-50 p-3">
          <p className="font-medium text-slate-900">
            อนุมัติ {formatBaht(r.amount)} บาทให้ {r.borrower.fullName}? ระบบจะสร้างสัญญา “รอจ่ายเงิน” ดอกเบี้ยจะคิดตอนบันทึกการโอนเงิน
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void run("approve", undefined, "อนุมัติแล้ว สร้างสัญญารอจ่ายเงิน")}>
              {busy ? "กำลังบันทึก..." : "ยืนยันอนุมัติ"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode("idle")}>
              ย้อนกลับ
            </Button>
          </div>
        </div>
      )}

      {mode === "reject" && (
        <div className="mt-3 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <TextAreaField label="เหตุผลที่ไม่อนุมัติ" value={reason} error={reasonError} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy} onClick={reject}>
              {busy ? "กำลังบันทึก..." : "ยืนยันไม่อนุมัติ"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode("idle")}>
              ย้อนกลับ
            </Button>
          </div>
        </div>
      )}

      {mode === "cancel" && (
        <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="font-medium text-slate-900">ยกเลิกคำขอนี้?</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy} onClick={() => void run("cancel", undefined, "ยกเลิกคำขอแล้ว")}>
              {busy ? "กำลังบันทึก..." : "ยืนยันยกเลิก"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode("idle")}>
              ย้อนกลับ
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
