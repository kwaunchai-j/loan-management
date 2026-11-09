"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { InterestEstimate } from "@/components/InterestEstimate";
import { PaymentAccountButton } from "@/components/PaymentAccountModal";
import { RequestStatusBadge } from "@/components/status";
import { Alert, Button, Card, PageTitle, Spinner, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { checkDate, checkMoney, formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { myRequestListSchema, requestSchema, type MyRequest } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

export default function RequestPage() {
  const list = useApi("/me/loan-requests", myRequestListSchema);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  return (
    <>
      <PageTitle>ขอยืมเงิน</PageTitle>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card">
        <p className="min-w-0 text-sm text-slate-700">ต้องโอนเงินคืนที่บัญชีไหน? ดูบัญชีของผู้ให้กู้ได้ที่นี่</p>
        <PaymentAccountButton context="request" />
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      <RequestForm
        onCreated={() => {
          setNotice({ kind: "success", text: "ส่งคำขอเรียบร้อยแล้ว ระบบสร้างสัญญาเงินกู้ให้แล้ว ดูได้ที่ “คำขอของฉัน” ผู้ให้กู้จะพิจารณา" });
          list.reload();
        }}
      />
      <h2 className="text-lg font-semibold text-slate-900">คำขอของฉัน</h2>
      {list.loading && <Spinner />}
      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.data && list.data.items.length === 0 && (
        <Card>
          <p className="text-slate-700">ยังไม่เคยส่งคำขอ</p>
        </Card>
      )}
      <ul className="space-y-3">
        {list.data?.items.map((r) => (
          <RequestRow
            key={r.id}
            r={r}
            onChanged={(text) => {
              setNotice({ kind: "success", text });
              list.reload();
            }}
            onError={(text) => setNotice({ kind: "error", text })}
          />
        ))}
      </ul>
    </>
  );
}

function RequestForm({ onCreated }: { onCreated: () => void }) {
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; dueDate?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayBangkok();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const found = {
      amount: checkMoney(amount) ?? undefined,
      dueDate: checkDate(dueDate, "วันครบกำหนด") ?? (dueDate <= today ? "วันครบกำหนดต้องเป็นวันในอนาคต" : undefined),
    };
    setErrors(found);
    if (found.amount || found.dueDate) return;
    setBusy(true);
    try {
      await apiFetch("/loan-requests", {
        method: "POST",
        json: { amount: amount.trim(), requestedDueDate: dueDate.trim() },
        schema: requestSchema,
      });
      setAmount("");
      setDueDate("");
      onCreated();
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="ส่งคำขอใหม่">
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        {apiError && <Alert kind="error">{apiError}</Alert>}
        <TextField
          label="จำนวนเงินที่ต้องการยืม (บาท)"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          error={errors.amount}
          hint="กรอกจำนวนเงินเพื่อดูดอกเบี้ยโดยประมาณ ดอกเบี้ยจริงจะคำนวณตอนผู้ให้กู้โอนเงินให้"
          onChange={(e) => setAmount(e.target.value)}
        />
        <InterestEstimate amount={amount} dueDate={dueDate} />
        <TextField
          label="วันที่จะคืนเงิน"
          type="date"
          min={today}
          value={dueDate}
          error={errors.dueDate}
          hint="ต้องเป็นวันหลังจากวันนี้ ถ้าคืนช้ากว่าวันที่เลือก จะมีค่าปรับรายวัน"
          onChange={(e) => setDueDate(e.target.value)}
        />
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {busy ? "กำลังส่ง..." : "ส่งคำขอ"}
        </Button>
      </form>
    </Card>
  );
}

function RequestRow({ r, onChanged, onError }: { r: MyRequest; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    try {
      await apiFetch(`/loan-requests/${encodeURIComponent(r.id)}/cancel`, { method: "POST", schema: requestSchema });
      setConfirming(false);
      onChanged("ยกเลิกคำขอแล้ว");
    } catch (err) {
      setConfirming(false);
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-lg font-semibold text-slate-900">{formatBaht(r.amount)} บาท</p>
        <RequestStatusBadge status={r.status} />
      </div>
      <p className="text-sm text-slate-700">ขอคืนวันที่ {formatDay(r.requestedDueDate)}</p>
      {r.status === "APPROVED" && r.contract && <p className="text-sm text-slate-700">สัญญาเลขที่ {r.contract.contractNo}</p>}
      <p className="mt-1 text-sm">
        <Link href={`/me/request/${encodeURIComponent(r.id)}/agreement`} className="font-medium text-teal-800 underline">
          ดูสัญญาเงินกู้
        </Link>
      </p>
      {r.status === "PENDING" &&
        (confirming ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">ยกเลิกคำขอนี้?</span>
            <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
              {busy ? "กำลังยกเลิก..." : "ยืนยันยกเลิก"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              ไม่ยกเลิก
            </Button>
          </div>
        ) : (
          <Button className="mt-3" variant="secondary" onClick={() => setConfirming(true)}>
            ยกเลิกคำขอ
          </Button>
        ))}
    </li>
  );
}
