"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, Item, Spinner, TextField } from "@/components/ui";
import { formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { periodLabel } from "@/lib/report-period";
import { borrowerSummarySchema, latePayersSchema, outstandingSchema, profitLossSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

const PAGE_SIZE = 20;

function Pager({ total, offset, onOffset }: { total: number; offset: number; onOffset: (n: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-slate-600">
        แสดง {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total} คน
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}>
          ก่อนหน้า
        </Button>
        <Button variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => onOffset(offset + PAGE_SIZE)}>
          ถัดไป
        </Button>
      </div>
    </div>
  );
}

const withQuery = (path: string, ...parts: string[]) => {
  const q = parts.filter(Boolean).join("&");
  return q ? `${path}?${q}` : path;
};

const borrowerLink = (id: string, name: string) => (
  <Link href={`/admin/borrowers/${encodeURIComponent(id)}`} className="text-teal-800 hover:underline">
    {name}
  </Link>
);

/** Profit & loss: the cash basis and the accrual basis side by side (DES-015 §1). Figures are the API's. */
export function ProfitLossReport({ query }: { query: string }) {
  const r = useApi(withQuery("/admin/reports/profit-loss", query), profitLossSchema);
  return (
    <>
      {r.loading && <Spinner />}
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {r.data && (
        <>
          <p className="text-slate-700">ช่วงเวลา: {periodLabel(r.data.period)}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="เกณฑ์เงินสด">
              <p className="mb-3 text-sm text-slate-600">ดอกเบี้ยและค่าปรับที่ตัดจากเงินที่ได้รับจริงในช่วงนี้ ({r.data.cash.paymentCount} รายการรับชำระ)</p>
              <dl className="space-y-2">
                <Item label="ดอกเบี้ย" value={`${formatBaht(r.data.cash.interest)} บาท`} />
                <Item label="ค่าปรับ" value={`${formatBaht(r.data.cash.lateFee)} บาท`} />
                <Item label="รายได้รวม" value={`${formatBaht(r.data.cash.total)} บาท`} strong />
              </dl>
            </Card>
            <Card title="เกณฑ์คงค้าง">
              <p className="mb-3 text-sm text-slate-600">
                ดอกเบี้ยเต็มจำนวนของสัญญาที่ครบกำหนดในช่วงนี้ ({r.data.accrual.contractCount} สัญญา) นับถึง {formatDay(r.data.accrual.interestRecognisedThrough)} ส่วนค่าปรับนับเมื่อได้รับเงินจริง
              </p>
              <dl className="space-y-2">
                <Item label="ดอกเบี้ย" value={`${formatBaht(r.data.accrual.interest)} บาท`} />
                <Item label="ค่าปรับ" value={`${formatBaht(r.data.accrual.lateFee)} บาท`} />
                <Item label="รายได้รวม" value={`${formatBaht(r.data.accrual.total)} บาท`} strong />
              </dl>
            </Card>
          </div>
          <p className="text-sm text-slate-600">
            รายได้มีเฉพาะดอกเบี้ยและค่าปรับ ไม่มีหนี้สูญหรือค่าใช้จ่ายอื่น การแก้ไขหรือลบรายการเดิมจะเปลี่ยนรายงานของช่วงที่ผ่านมา
          </p>
        </>
      )}
    </>
  );
}

/** Borrowers ranked by how many of their contracts were late (DES-015 §2). */
export function LatePayersReport({ query }: { query: string }) {
  const [offset, setOffset] = useState(0);
  const r = useApi(withQuery("/admin/reports/late-payers", query, `limit=${PAGE_SIZE}`, `offset=${offset}`), latePayersSchema);
  return (
    <>
      {r.loading && <Spinner />}
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {r.data && (
        <>
          <p className="text-slate-700">ช่วงเวลา: {periodLabel(r.data.period)} (นับสัญญาที่ครบกำหนดในช่วงนี้)</p>
          {r.data.items.length === 0 && (
            <Card>
              <p className="text-slate-700">ไม่มีผู้ชำระช้าในช่วงนี้</p>
            </Card>
          )}
          <ul className="space-y-3">
            {r.data.items.map((b) => (
              <li key={b.borrowerId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-lg font-semibold text-slate-900">
                    {b.rank}. {borrowerLink(b.borrowerId, b.fullName)}
                  </p>
                  <Badge tone="red">ชำระช้า {b.lateCount} สัญญา</Badge>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-slate-700">
                  {b.lateContracts.map((c) => (
                    <li key={c.contractNo}>
                      {c.contractNo} · ครบกำหนด {formatDay(c.dueDate)} ·{" "}
                      {c.stillUnpaid ? `ยังไม่ชำระ เลยมา ${c.daysLate} วัน` : `ชำระครบ ${formatDay(c.closedOn)} ช้า ${c.daysLate} วัน`}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <Pager total={r.data.total} offset={offset} onOffset={setOffset} />
        </>
      )}
    </>
  );
}

/** What is owed on contracts that are open on a chosen day (DES-015 §3). */
export function OutstandingReport() {
  const today = todayBangkok();
  const [asOf, setAsOf] = useState(today);
  const [applied, setApplied] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const r = useApi(`/admin/reports/outstanding?asOf=${applied}`, outstandingSchema);

  function apply() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return setError("กรุณาเลือกวันที่");
    if (asOf > today) return setError("เลือกวันในอนาคตไม่ได้");
    setError(null);
    setApplied(asOf);
  }

  return (
    <>
      <Card>
        <TextField label="ยอดค้าง ณ วันที่" type="date" max={today} value={asOf} error={error} onChange={(e) => setAsOf(e.target.value)} />
        <Button className="mt-4 w-full sm:w-auto" onClick={apply}>
          แสดงรายงาน
        </Button>
      </Card>
      {r.loading && <Spinner />}
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {r.data && (
        <>
          <p className="text-slate-700">
            ณ วันที่ {formatDay(r.data.asOf)}
            {r.data.isToday ? " (วันนี้)" : ""}
          </p>
          {r.data.inconsistentContracts > 0 && (
            <Alert kind="warning">
              มี {r.data.inconsistentContracts} สัญญาที่ประวัติรายการไม่สอดคล้องกับกฎการคำนวณ จึงไม่ถูกนับรวมในยอดนี้ กรุณาตรวจสัญญาเหล่านั้น
            </Alert>
          )}
          <Card>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Item label="ยอดค้างรวม" value={`${formatBaht(r.data.totalOutstanding)} บาท`} strong />
              <Item label="จำนวนสัญญาที่ยังไม่ปิด" value={`${r.data.openContracts} สัญญา`} strong />
              <Item label="เงินต้น" value={`${formatBaht(r.data.principal)} บาท`} />
              <Item label="ดอกเบี้ย" value={`${formatBaht(r.data.interest)} บาท`} />
              <Item label="ค่าปรับ" value={`${formatBaht(r.data.lateFee)} บาท`} />
            </dl>
          </Card>
        </>
      )}
    </>
  );
}

/** One block per borrower: loans, late, on-time share, owed now (DES-015 §4). */
export function BorrowerSummaryReport({ query }: { query: string }) {
  const [offset, setOffset] = useState(0);
  const r = useApi(withQuery("/admin/reports/borrower-summary", query, `limit=${PAGE_SIZE}`, `offset=${offset}`), borrowerSummarySchema);
  return (
    <>
      {r.loading && <Spinner />}
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {r.data && (
        <>
          <p className="text-slate-700">ช่วงเวลา: {periodLabel(r.data.period)} (นับสัญญาที่ครบกำหนดในช่วงนี้)</p>
          {r.data.items.length === 0 && (
            <Card>
              <p className="text-slate-700">ไม่มีข้อมูลในช่วงนี้</p>
            </Card>
          )}
          <ul className="space-y-3">
            {r.data.items.map((b) => (
              <li key={b.borrowerId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-lg font-semibold text-slate-900">{borrowerLink(b.borrowerId, b.fullName)}</p>
                <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Item label="สัญญาทั้งหมด" value={b.loanCount} />
                  <Item label="ชำระช้า" value={b.lateCount} />
                  <Item label="ชำระตรงเวลา" value={b.paidOnTimeCount} />
                  <Item label="ยังไม่ถึงกำหนด" value={b.notYetDueCount} />
                  <Item label="ตรงเวลา" value={b.onTimeRatePct === null ? "ยังไม่มีผล" : `${b.onTimeRatePct}%`} />
                </dl>
                <p className="mt-2 text-sm text-slate-700">ยอดค้างตอนนี้ {formatBaht(b.outstanding)} บาท</p>
              </li>
            ))}
          </ul>
          <Pager total={r.data.total} offset={offset} onOffset={setOffset} />
        </>
      )}
    </>
  );
}
