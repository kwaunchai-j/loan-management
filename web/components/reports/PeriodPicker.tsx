"use client";

import { useState } from "react";
import { Alert, Button, Card, SelectField, TextField } from "@/components/ui";
import { buildPeriodQuery, defaultSelection, type PeriodKind, type PeriodSelection } from "@/lib/report-period";

const KINDS: Array<[PeriodKind, string]> = [
  ["month", "รายเดือน"],
  ["year", "รายปี"],
  ["range", "ช่วงวันที่เอง"],
  ["all", "ทั้งหมด (ทุกช่วงเวลา)"],
];

/**
 * Chooses the period of a report. The report is only fetched when "แสดงรายงาน" is pressed (so it is
 * not re-requested on every keystroke), and a period the API would refuse is explained here first.
 */
export function PeriodPicker({ onApply }: { onApply: (query: string) => void }) {
  const [sel, setSel] = useState<PeriodSelection>(() => defaultSelection());
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<PeriodSelection>) => setSel((s) => ({ ...s, ...patch }));

  function apply() {
    const r = buildPeriodQuery(sel);
    setError(r.ok ? null : r.error);
    if (r.ok) onApply(r.query);
  }

  return (
    <Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="ช่วงเวลา" value={sel.kind} onChange={(e) => set({ kind: e.target.value as PeriodKind })}>
          {KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        {sel.kind === "month" && <TextField label="เดือน" type="month" value={sel.month} onChange={(e) => set({ month: e.target.value })} />}
        {sel.kind === "year" && (
          <TextField label="ปี (ค.ศ.)" inputMode="numeric" maxLength={4} value={sel.year} onChange={(e) => set({ year: e.target.value })} hint="เช่น 2026 (พ.ศ. 2569)" />
        )}
        {sel.kind === "range" && (
          <>
            <TextField label="ตั้งแต่วันที่" type="date" value={sel.from} onChange={(e) => set({ from: e.target.value })} />
            <TextField label="ถึงวันที่ (รวมวันนี้)" type="date" value={sel.to} onChange={(e) => set({ to: e.target.value })} />
          </>
        )}
      </div>
      {error && (
        <div className="mt-3">
          <Alert kind="error">{error}</Alert>
        </div>
      )}
      <Button className="mt-4 w-full sm:w-auto" onClick={apply}>
        แสดงรายงาน
      </Button>
    </Card>
  );
}
