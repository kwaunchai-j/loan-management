"use client";

import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api";
import { checkDate, checkMoney, formatBaht, formatDay, todayBangkok } from "@/lib/money";
import { interestEstimateSchema, type InterestEstimate as Estimate } from "@/lib/schemas";
import { Alert, Icon } from "./ui";

/**
 * "How much interest would this be?" for the request form. As soon as the amount is a valid amount it
 * asks the API (the same formula as the real contract — nothing is calculated here) and shows the interest and
 * the total to pay back. Without a due date the API answers for 30 days and says so.
 * It is an ESTIMATE: the real interest counts the days from the day the lender actually transfers the money.
 */
export function InterestEstimate({ amount, dueDate, delayMs = 400 }: { amount: string; dueDate: string; delayMs?: number }) {
  const today = todayBangkok();
  const amountOk = checkMoney(amount) === null;
  // a date that is not usable yet (half typed, today, the past) is simply left out: the form itself explains it
  const dueOk = checkDate(dueDate, "วันครบกำหนด") === null && dueDate > today;
  const query = amountOk ? new URLSearchParams({ amount: amount.trim(), ...(dueOk ? { dueDate } : {}) }).toString() : null;

  // keyed by the question, so an old answer is never shown next to a newer amount
  const [answer, setAnswer] = useState<{ query: string; estimate?: Estimate; error?: string } | null>(null);

  useEffect(() => {
    if (query === null) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      apiFetch(`/loan-requests/interest-estimate?${query}`, { schema: interestEstimateSchema, signal: ac.signal }).then(
        (estimate) => setAnswer({ query, estimate }),
        (err: unknown) => {
          if (!ac.signal.aborted) setAnswer({ query, error: errorMessage(err) });
        },
      );
    }, delayMs);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [query, delayMs]);

  if (query === null) return null;
  const current = answer?.query === query ? answer : null;
  const shown = current?.estimate ?? answer?.estimate; // keep the last figure on screen while a new one is on its way
  const loading = current === null;

  if (current?.error) return <Alert kind="warning">{current.error}</Alert>;
  if (!shown) return <p className="text-sm text-slate-600">กำลังคำนวณดอกเบี้ย...</p>;

  return (
    <section aria-label="ดอกเบี้ยโดยประมาณ" aria-busy={loading} className={`rounded-xl border border-teal-200 bg-teal-50/60 p-4 transition ${loading ? "opacity-60" : ""}`}>
      <h3 className="flex items-center gap-2 font-semibold text-teal-900">
        <Icon name="chart" className="h-5 w-5" />
        ดอกเบี้ยโดยประมาณ
      </h3>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-slate-700">ดอกเบี้ย</dt>
          <dd className="text-2xl font-bold tabular-nums text-slate-900">{formatBaht(shown.interestAmount)} บาท</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-700">ยอดที่ต้องชำระคืนรวม</dt>
          <dd className="text-2xl font-bold tabular-nums text-slate-900">{formatBaht(shown.totalToRepay)} บาท</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-slate-800">
        {shown.daysAssumed
          ? `คิดตามมาตรฐาน ${shown.days} วัน (เลือกวันที่จะคืนเงินด้านล่างเพื่อให้ตรงกับที่ต้องการ)`
          : `คิดจาก ${shown.days} วัน นับจากวันนี้ถึง ${formatDay(shown.dueDate ?? "")}`}{" "}
        · อัตรา {shown.interestRatePctPerMonth}% ต่อเดือน
      </p>
      <p className="mt-1 text-xs text-slate-600">
        เป็นการประมาณการเท่านั้น ดอกเบี้ยจริงนับจากวันที่ผู้ให้กู้โอนเงินให้ และปัดขึ้นเป็นบาทเต็ม ถ้าชำระช้ากว่ากำหนดจะมีค่าปรับรายวันเพิ่ม
      </p>
    </section>
  );
}
