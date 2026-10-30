"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, PageTitle, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { checkDate, checkMoney, formatBaht, todayBangkok } from "@/lib/money";
import { borrowerListSchema, requestSchema, type Borrower, type LoanRequest } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

/** The admin files a request for a borrower (DES-004). Approving it can follow at once, in a second call. */
export default function NewRequestPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Borrower | null>(null);
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [approveNow, setApproveNow] = useState(false);
  const [errors, setErrors] = useState<{ borrower?: string; amount?: string; dueDate?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ request: LoanRequest; approved: boolean; approveError: string | null } | null>(null);
  const today = todayBangkok();

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: "8" });
  if (q) params.set("q", q);
  const found = useApi(picked ? null : `/admin/borrowers?${params.toString()}`, borrowerListSchema);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const problems = {
      borrower: picked ? undefined : "กรุณาเลือกผู้ยืม",
      amount: checkMoney(amount) ?? undefined,
      dueDate: checkDate(dueDate, "วันครบกำหนด") ?? (dueDate <= today ? "วันครบกำหนดต้องเป็นวันในอนาคต" : undefined),
    };
    setErrors(problems);
    if (problems.borrower || problems.amount || problems.dueDate || !picked) return;

    setBusy(true);
    try {
      const request = await apiFetch("/admin/loan-requests", {
        method: "POST",
        json: { borrowerId: picked.id, amount: amount.trim(), requestedDueDate: dueDate.trim() },
        schema: requestSchema,
      });
      let approved = false;
      let approveError: string | null = null;
      let latest = request;
      if (approveNow) {
        try {
          latest = await apiFetch(`/admin/loan-requests/${encodeURIComponent(request.id)}/approve`, { method: "POST", schema: requestSchema });
          approved = true;
        } catch (err) {
          approveError = errorMessage(err); // the request exists; it can still be approved from the inbox
        }
      }
      setDone({ request: latest, approved, approveError });
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <PageTitle>สร้างคำขอแล้ว</PageTitle>
        <Alert kind="success">
          สร้างคำขอ {formatBaht(done.request.amount)} บาทให้ {done.request.borrower.fullName} เรียบร้อยแล้ว
        </Alert>
        {done.approved && done.request.contract && (
          <Alert kind="success">
            อนุมัติแล้ว สร้างสัญญา{" "}
            <Link href={`/admin/contracts/${encodeURIComponent(done.request.contract.id)}`} className="font-medium underline">
              {done.request.contract.contractNo}
            </Link>{" "}
            (รอจ่ายเงิน)
          </Alert>
        )}
        {done.approveError && <Alert kind="error">สร้างคำขอแล้ว แต่อนุมัติไม่สำเร็จ: {done.approveError} (อนุมัติต่อได้ที่หน้าคำขอยืม)</Alert>}
        <Link
          href="/admin/requests"
          className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 font-medium text-white hover:bg-teal-800"
        >
          ไปที่คำขอยืม
        </Link>
      </>
    );
  }

  return (
    <>
      <PageTitle>สร้างคำขอแทนผู้ยืม</PageTitle>
      <Card>
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          {apiError && <Alert kind="error">{apiError}</Alert>}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">ผู้ยืม</legend>
            {picked ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal-300 bg-teal-50 p-3">
                <span className="font-semibold text-slate-900">{picked.fullName}</span>
                <Button variant="secondary" onClick={() => setPicked(null)}>
                  เปลี่ยนผู้ยืม
                </Button>
              </div>
            ) : (
              <>
                <TextField label="ค้นหาผู้ยืมตามชื่อ" type="search" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
                {found.error && <Alert kind="error">{found.error}</Alert>}
                {found.data && found.data.items.length === 0 && <p className="text-sm text-slate-600">ไม่พบผู้ยืม</p>}
                <ul className="space-y-2">
                  {found.data?.items.map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => setPicked(b)}
                        className="block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-left hover:border-teal-600"
                      >
                        {b.fullName}
                        {b.account?.isActive === false && <span className="ml-2 text-sm text-red-700">(ปิดใช้งาน)</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {errors.borrower && (
              <p role="alert" className="text-sm font-medium text-red-700">
                {errors.borrower}
              </p>
            )}
          </fieldset>

          <TextField
            label="จำนวนเงิน (บาท)"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            error={errors.amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <TextField label="วันครบกำหนดที่ผู้ยืมเลือก" type="date" min={today} value={dueDate} error={errors.dueDate} onChange={(e) => setDueDate(e.target.value)} />

          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-base">
            <input type="checkbox" checked={approveNow} onChange={(e) => setApproveNow(e.target.checked)} className="mt-1 h-5 w-5 accent-teal-700" />
            <span>อนุมัติทันที (สร้างสัญญารอจ่ายเงิน)</span>
          </label>

          <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
            {busy ? "กำลังบันทึก..." : approveNow ? "สร้างคำขอและอนุมัติ" : "สร้างคำขอ"}
          </Button>
        </form>
      </Card>
    </>
  );
}
