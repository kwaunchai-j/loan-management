"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ContractStatusBadges } from "@/components/status";
import { Alert, Badge, Button, Card, PageTitle, SelectField, Spinner, TextField } from "@/components/ui";
import { formatBaht, formatDay } from "@/lib/money";
import { adminContractListSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

const PAGE_SIZE = 20;
const STATUS_FILTERS = [
  ["", "ทุกสถานะ"],
  ["AWAITING_DISBURSEMENT", "รอจ่ายเงิน"],
  ["ACTIVE", "กำลังใช้งาน"],
  ["CLOSED", "ชำระครบแล้ว"],
  ["CANCELLED", "ยกเลิกแล้ว"],
] as const;

export default function ContractsPage() {
  const [status, setStatus] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [sort, setSort] = useState<"createdAt" | "dueDate">("createdAt");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  // Only a CHANGED search term sends the list back to page 1: the timer also fires once after the page
  // opens, and that must not undo a click on "next" made in the meantime.
  const searched = useRef("");
  useEffect(() => {
    const t = setTimeout(() => {
      const next = search.trim();
      if (next === searched.current) return;
      searched.current = next;
      setQ(next);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort });
  if (status) params.set("status", status);
  if (overdue) params.set("overdue", "true");
  if (q) params.set("q", q);
  const list = useApi(`/admin/contracts?${params.toString()}`, adminContractListSchema);
  const total = list.data?.total ?? 0;

  return (
    <>
      <PageTitle>สัญญา</PageTitle>

      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="ค้นหาเลขสัญญาหรือชื่อผู้ยืม" type="search" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
          <SelectField
            label="สถานะ"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            {STATUS_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="เรียงตาม"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as "createdAt" | "dueDate");
              setOffset(0);
            }}
          >
            <option value="createdAt">สร้างล่าสุด</option>
            <option value="dueDate">ครบกำหนดใกล้ที่สุด</option>
          </SelectField>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 self-end text-base">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => {
                setOverdue(e.target.checked);
                setOffset(0);
              }}
              className="h-5 w-5 accent-teal-700"
            />
            <span>เฉพาะที่เลยกำหนดชำระ</span>
          </label>
        </div>
      </Card>

      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.loading && <Spinner />}
      {list.data && list.data.items.length === 0 && (
        <Card>
          <p className="text-slate-700">ไม่พบสัญญา</p>
        </Card>
      )}

      <ul className="space-y-3">
        {list.data?.items.map((c) => (
          <li key={c.id}>
            <Link href={`/admin/contracts/${encodeURIComponent(c.id)}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-teal-600">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-lg font-semibold text-slate-900">
                  {c.contractNo} · {c.borrower.fullName}
                </p>
                <span className="flex flex-wrap items-center gap-2">
                  <ContractStatusBadges status={c.status} isOverdue={c.isOverdue} daysOverdue={c.daysOverdue} />
                  {c.isImported && <Badge tone="gray">นำเข้า</Badge>}
                </span>
              </div>
              <p className="text-sm text-slate-700">
                เงินต้น {formatBaht(c.principal)} บาท · ครบกำหนด {formatDay(c.dueDate)}
              </p>
              {c.totalDue !== null && <p className="text-base font-semibold text-slate-900">ยอดที่ต้องชำระ {formatBaht(c.totalDue)} บาท</p>}
            </Link>
          </li>
        ))}
      </ul>

      {list.data && total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            แสดง {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total} สัญญา
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
