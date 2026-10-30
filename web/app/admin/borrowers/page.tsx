"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, PageTitle, Spinner, TextField } from "@/components/ui";
import { borrowerListSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { maskAccount } from "@/lib/validation";

const PAGE_SIZE = 20;

export default function BorrowersPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState(""); // what is actually searched (after a short pause in typing)
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

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (q) params.set("q", q);
  const list = useApi(`/admin/borrowers?${params.toString()}`, borrowerListSchema);

  const total = list.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>ผู้ยืม</PageTitle>
        <Link
          href="/admin/borrowers/new"
          className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 font-medium text-white hover:bg-teal-800"
        >
          + เพิ่มผู้ยืม
        </Link>
      </div>

      <TextField
        label="ค้นหาตามชื่อ"
        type="search"
        autoComplete="off"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="พิมพ์ชื่อผู้ยืม"
      />

      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.loading && <Spinner />}

      {list.data && list.data.items.length === 0 && (
        <Card>
          <p className="text-slate-700">{q ? `ไม่พบผู้ยืมที่ชื่อมีคำว่า "${q}"` : "ยังไม่มีผู้ยืม กด \"เพิ่มผู้ยืม\" เพื่อสร้างบัญชีแรก"}</p>
        </Card>
      )}

      {list.data && list.data.items.length > 0 && (
        <>
          <ul className="space-y-3">
            {list.data.items.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/admin/borrowers/${b.id}`}
                  className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-teal-600"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-lg font-semibold text-slate-900">{b.fullName}</p>
                    {b.account === null ? (
                      <Badge tone="gray">ยังไม่มีบัญชี (นำเข้า)</Badge>
                    ) : b.account.isActive ? (
                      <Badge tone="green">ใช้งานอยู่</Badge>
                    ) : (
                      <Badge tone="red">ปิดใช้งาน</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {b.phone ?? "ไม่มีเบอร์"} · {b.bankName ?? "ไม่มีข้อมูลธนาคาร"} {b.bankAccountNo ? maskAccount(b.bankAccountNo) : ""}
                  </p>
                  {b.account && (
                    <p className="mt-1 text-sm text-slate-600">
                      ชื่อผู้ใช้: {b.account.username}
                      {b.pdpaAcceptedAt === null && " · ยังไม่ยอมรับเงื่อนไขข้อมูลส่วนบุคคล"}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              แสดง {from}–{to} จาก {total} คน
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
        </>
      )}
    </>
  );
}
