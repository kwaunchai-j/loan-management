"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, Item, Spinner } from "@/components/ui";
import { longDay, monthCells, monthLabel, shiftMonth, WEEKDAYS } from "@/lib/calendar";
import { formatBaht, todayBangkok } from "@/lib/money";
import { calendarSchema, type CalendarDay } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

/**
 * The admin calendar: every contract sits on its DUE DATE and every payment on the day it was paid, so
 * what is due on a day is recorded on that day and can be opened from it. All amounts and the
 * "overdue" flags come from the API; this page only lays them out.
 */
export function CalendarView() {
  const today = todayBangkok();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(today);
  const cal = useApi(`/admin/calendar?month=${month}`, calendarSchema);
  const byDate = new Map<string, CalendarDay>((cal.data?.days ?? []).map((d) => [d.date, d]));
  const selected = picked && picked.startsWith(month) ? (byDate.get(picked) ?? null) : null;

  const go = (m: string) => {
    setMonth(m);
    setPicked(m === today.slice(0, 7) ? today : null); // today when it is in the month, else nothing chosen yet
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" aria-label="เดือนก่อนหน้า" onClick={() => go(shiftMonth(month, -1))}>
          ← ก่อนหน้า
        </Button>
        <h2 className="text-xl font-bold tracking-tight text-slate-900" aria-live="polite">
          {monthLabel(month)}
        </h2>
        <Button variant="secondary" aria-label="เดือนถัดไป" onClick={() => go(shiftMonth(month, 1))}>
          ถัดไป →
        </Button>
      </div>
      {month !== today.slice(0, 7) && (
        <div>
          <Button variant="secondary" onClick={() => go(today.slice(0, 7))}>
            กลับไปเดือนนี้
          </Button>
        </div>
      )}

      {cal.error && <Alert kind="error">{cal.error}</Alert>}
      {cal.loading && <Spinner />}
      {cal.data?.truncated && <Alert kind="warning">เดือนนี้มีรายการมากจนแสดงไม่ครบ กรุณาดูจากหน้าสัญญาหรือรายงานเพิ่มเติม</Alert>}

      <div role="group" aria-label={`ปฏิทิน ${monthLabel(month)}`} className="rounded-2xl border border-slate-200/80 bg-white p-2 shadow-card sm:p-3">
        <div aria-hidden="true" className="grid grid-cols-7 text-center text-xs font-semibold text-slate-600">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`py-1.5 ${i === 0 ? "text-red-700" : ""}`}>
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
          {monthCells(month).map((date, i) =>
            date === null ? (
              <div key={`blank-${i}`} aria-hidden="true" />
            ) : (
              <DayCell key={date} date={date} day={byDate.get(date)} isToday={date === today} isSelected={date === picked} onPick={() => setPicked(date)} />
            ),
          )}
        </div>
      </div>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-red-600 align-middle" />ครบกำหนดแล้วและยังค้าง</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-500 align-middle" />ยังไม่ถึงกำหนด/วันนี้</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-emerald-600 align-middle" />ชำระครบแล้ว</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-sky-600 align-middle" />รับชำระในวันนั้น</span>
      </p>

      <DayDetail date={picked && picked.startsWith(month) ? picked : null} day={selected} loading={cal.loading} />
    </>
  );
}

function DayCell({ date, day, isToday, isSelected, onPick }: { date: string; day: CalendarDay | undefined; isToday: boolean; isSelected: boolean; onPick: () => void }) {
  const due = day?.due;
  const paid = day?.paid;
  const overdue = due?.items.some((i) => i.isOverdue) ?? false;
  const dueColor = !due || due.count === 0 ? "" : overdue ? "bg-red-600" : due.openCount > 0 ? "bg-amber-500" : "bg-emerald-600";
  const summary = [due && due.count > 0 ? `ครบกำหนด ${due.count} สัญญา` : null, paid && paid.count > 0 ? `รับชำระ ${paid.count} รายการ` : null].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`${longDay(date)}${summary ? ` ${summary}` : " ไม่มีรายการ"}`}
      aria-pressed={isSelected}
      className={`flex min-h-16 flex-col items-center gap-1 rounded-xl border p-1 text-sm transition hover:-translate-y-px hover:border-teal-500 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 sm:min-h-20 ${
        isSelected ? "border-teal-700 bg-teal-50 shadow-sm" : "border-slate-200 bg-white"
      }`}
    >
      <span
        className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 font-semibold ${
          isToday ? "bg-teal-700 text-white" : "text-slate-900"
        }`}
      >
        {Number(date.slice(8))}
      </span>
      {due && due.count > 0 && (
        <span className={`rounded-full px-1.5 text-xs font-medium text-white ${dueColor}`} aria-hidden="true">
          ครบ {due.count}
        </span>
      )}
      {paid && paid.count > 0 && (
        <span className="rounded-full bg-sky-600 px-1.5 text-xs font-medium text-white" aria-hidden="true">
          รับ {paid.count}
        </span>
      )}
    </button>
  );
}

function DayDetail({ date, day, loading }: { date: string | null; day: CalendarDay | null; loading: boolean }) {
  if (!date) return <Card><p className="text-slate-700">กดที่วันในปฏิทินเพื่อดูรายการของวันนั้น</p></Card>;
  return (
    <Card title={longDay(date)}>
      {!day && !loading && <p className="text-slate-700">ไม่มีสัญญาครบกำหนดและไม่มีการรับชำระในวันนี้</p>}
      {day && day.due.count > 0 && (
        <section aria-label="ครบกำหนดชำระ" className="mb-4">
          <h3 className="font-semibold text-slate-900">ครบกำหนดชำระ {day.due.count} สัญญา</h3>
          {day.due.openCount > 0 && (
            <dl className="my-2">
              <Item label={`ยังค้างอยู่ ${day.due.openCount} สัญญา รวม`} value={`${formatBaht(day.due.openTotal)} บาท`} strong />
            </dl>
          )}
          <ul className="divide-y divide-slate-100">
            {day.due.items.map((i) => (
              <li key={i.contractId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <Link href={`/admin/contracts/${encodeURIComponent(i.contractId)}`} className="font-medium text-teal-800 hover:underline">
                    {i.contractNo}
                  </Link>{" "}
                  · {i.borrower.fullName}
                  {i.isImported && <span className="ml-2 text-xs text-slate-500">(นำเข้า)</span>}
                </div>
                <div className="flex items-center gap-2">
                  {i.status === "CLOSED" ? (
                    <Badge tone="green">ชำระครบแล้ว</Badge>
                  ) : (
                    <>
                      {i.isOverdue && <Badge tone="red">เลยกำหนด {i.daysOverdue} วัน</Badge>}
                      <span className="font-semibold text-slate-900">ค้าง {formatBaht(i.totalDue)} บาท</span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {day && day.paid.count > 0 && (
        <section aria-label="รับชำระ">
          <h3 className="font-semibold text-slate-900">รับชำระ {day.paid.count} รายการ รวม {formatBaht(day.paid.total)} บาท</h3>
          <ul className="divide-y divide-slate-100">
            {day.paid.items.map((p) => (
              <li key={p.paymentId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <Link href={`/admin/contracts/${encodeURIComponent(p.contractId)}`} className="font-medium text-teal-800 hover:underline">
                    {p.contractNo}
                  </Link>{" "}
                  · {p.borrower.fullName}
                </div>
                <span className="font-semibold text-slate-900">{formatBaht(p.amount)} บาท</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
