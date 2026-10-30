"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { importBatchListSchema, rollbackResultSchema, type ImportBatch } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

/** Imported batches and the "undo the whole batch" button (DES-014): only while nothing was paid on them. */
export function BatchList({ reloadKey }: { reloadKey: number }) {
  const list = useApi("/admin/imports", importBatchListSchema);
  const { reload } = list;
  // a new import was just made elsewhere on the page: fetch the list again
  useEffect(() => {
    if (reloadKey > 0) reload();
  }, [reloadKey, reload]);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  return (
    <Card title="ประวัติการนำเข้า">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {list.loading && <Spinner />}
      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.data && list.data.items.length === 0 && <p className="text-slate-700">ยังไม่เคยนำเข้า</p>}
      <ul className="divide-y divide-slate-100">
        {list.data?.items.map((b) => (
          <BatchRow
            key={b.id}
            b={b}
            onDone={(text) => {
              setNotice({ kind: "success", text });
              list.reload();
            }}
            onError={(text) => setNotice({ kind: "error", text })}
          />
        ))}
      </ul>
    </Card>
  );
}

function BatchRow({ b, onDone, onError }: { b: ImportBatch; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function rollback() {
    setBusy(true);
    try {
      const r = await apiFetch(`/admin/imports/${encodeURIComponent(b.id)}/rollback`, { method: "POST", schema: rollbackResultSchema });
      setConfirming(false);
      onDone(`ย้อนกลับแล้ว ลบ ${r.contractsDeleted} สัญญาและค่าปรับย้อนหลัง ${r.lateFeeRowsDeleted} รายการ (ผู้ยืมที่สร้างไว้ยังอยู่)`);
    } catch (err) {
      setConfirming(false);
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-semibold text-slate-900">{b.fileName}</p>
        {b.status === "COMPLETED" ? <Badge tone="green">นำเข้าแล้ว</Badge> : <Badge tone="gray">ย้อนกลับแล้ว</Badge>}
      </div>
      <p className="text-sm text-slate-700">
        {formatDateTime(b.createdAt)} โดย {b.importedBy.username} · {b.rowCount} แถว · {b.contractCount} สัญญา
        {b.status === "ROLLED_BACK" ? ` · ย้อนกลับเมื่อ ${formatDateTime(b.rolledBackAt)}` : ""}
      </p>
      {b.status === "COMPLETED" && !b.canRollback && (
        <p className="text-sm text-amber-900">ย้อนกลับไม่ได้ เพราะมีรายการรับชำระในสัญญาของชุดนี้แล้ว ({b.paymentCount} รายการ)</p>
      )}
      {b.canRollback &&
        (confirming ? (
          <div className="mt-2 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="font-medium text-slate-900">
              ย้อนกลับชุดนี้? จะลบ {b.contractCount} สัญญาและค่าปรับย้อนหลังของชุดนี้ (ผู้ยืมที่ถูกสร้างตอนนำเข้ายังอยู่) ทำซ้ำไม่ได้
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void rollback()}>
                {busy ? "กำลังย้อนกลับ..." : "ยืนยันย้อนกลับ"}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                ยกเลิก
              </Button>
            </div>
          </div>
        ) : (
          <Button className="mt-2" variant="secondary" onClick={() => setConfirming(true)}>
            ย้อนกลับทั้งชุด
          </Button>
        ))}
    </li>
  );
}
