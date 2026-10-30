"use client";

import { useState } from "react";
import { PeriodPicker } from "@/components/reports/PeriodPicker";
import { BorrowerSummaryReport, LatePayersReport, OutstandingReport, ProfitLossReport } from "@/components/reports/Reports";
import { PageTitle } from "@/components/ui";
import { buildPeriodQuery, defaultSelection } from "@/lib/report-period";

const TABS = [
  ["profit", "กำไรขาดทุน"],
  ["late", "ผู้ชำระช้า"],
  ["outstanding", "ยอดค้าง"],
  ["borrowers", "สรุปรายผู้ยืม"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("profit");
  // the current month is shown first; a report is fetched again only when "แสดงรายงาน" changes the query
  const [query, setQuery] = useState(() => {
    const first = buildPeriodQuery(defaultSelection());
    return first.ok ? first.query : "";
  });

  return (
    <>
      <PageTitle>รายงาน</PageTitle>
      <div role="tablist" aria-label="เลือกรายงาน" className="flex gap-1 overflow-x-auto">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`min-h-11 whitespace-nowrap rounded-lg px-4 text-base font-medium ${
              tab === id ? "bg-teal-700 text-white" : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "outstanding" && <PeriodPicker onApply={setQuery} />}

      <div role="tabpanel" className="space-y-4">
        {tab === "profit" && <ProfitLossReport query={query} />}
        {tab === "late" && <LatePayersReport key={query} query={query} />}
        {tab === "outstanding" && <OutstandingReport />}
        {tab === "borrowers" && <BorrowerSummaryReport key={query} query={query} />}
      </div>
    </>
  );
}
