"use client";

import { useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { borrowerSchema, type Borrower } from "@/lib/schemas";
import { maskNationalId } from "@/lib/validation";

type Action = { key: string; label: string; ask: string; body: Record<string, unknown>; done: string };

/**
 * What the lender knows about who a borrower is (CR-8): whether they stated their real name, the national ID number
 * (shown masked until the admin asks) and the photo of the ID card, served by the API to admins only. Each way of
 * sending the borrower back to fill something in again needs a second, deliberate click; the borrower is held on their
 * profile page at their next click until it is done.
 */
export function AdminIdentityPanel({ b, onDone, onError }: { b: Borrower; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [showId, setShowId] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const actions: Action[] = [
    ...(b.realNameConfirmed
      ? [{ key: "name", label: "ให้ยืนยันชื่อจริงใหม่", ask: "ให้ผู้ยืมยืนยันชื่อจริงใหม่?", body: { reconfirmName: true }, done: "ผู้ยืมต้องยืนยันชื่อจริงใหม่ก่อนใช้งานระบบต่อ" }]
      : []),
    ...(b.nationalId !== null
      ? [{ key: "id", label: "ล้างเลขบัตร", ask: "ล้างเลขบัตรประชาชน? ผู้ยืมต้องกรอกใหม่", body: { nationalId: null }, done: "ล้างเลขบัตรประชาชนแล้ว ผู้ยืมต้องกรอกใหม่ก่อนใช้งานระบบต่อ" }]
      : []),
    ...(b.hasIdCard
      ? [{ key: "photo", label: "ถอดรูปบัตรออก", ask: "ถอดรูปบัตรออกจากระเบียน? ผู้ยืมต้องส่งรูปใหม่ (ไฟล์เดิมยังเก็บไว้)", body: { removeIdCard: true }, done: "ถอดรูปบัตรออกแล้ว ผู้ยืมต้องส่งรูปใหม่ก่อนใช้งานระบบต่อ" }]
      : []),
  ];

  async function run(a: Action) {
    setBusy(true);
    try {
      await apiFetch(`/admin/borrowers/${encodeURIComponent(b.id)}`, { method: "PATCH", json: a.body, schema: borrowerSchema });
      setConfirming(null);
      onDone(a.done);
    } catch (err) {
      setConfirming(null);
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="ยืนยันตัวตน (เห็นเฉพาะผู้ดูแล)">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-slate-600">ชื่อจริง</dt>
          <dd>{b.realNameConfirmed ? <Badge tone="green">ผู้ยืมยืนยันแล้ว</Badge> : <Badge tone="amber">ยังไม่ได้ยืนยัน</Badge>}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-600">เลขบัตรประชาชน</dt>
          <dd className="flex items-center gap-2 font-mono text-base">
            {b.nationalId === null ? "-" : showId ? b.nationalId : maskNationalId(b.nationalId)}
            {b.nationalId !== null && (
              <button
                type="button"
                aria-pressed={showId}
                onClick={() => setShowId((s) => !s)}
                className="min-h-9 rounded px-2 font-sans text-sm font-medium text-teal-800 hover:bg-teal-50"
              >
                {showId ? "ซ่อน" : "แสดง"}
              </button>
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-sm text-slate-600">รูปบัตรประชาชน</dt>
          <dd>
            {b.hasIdCard ? (
              <>
                <button
                  type="button"
                  aria-expanded={showPhoto}
                  onClick={() => setShowPhoto((s) => !s)}
                  className="min-h-9 rounded px-2 text-sm font-medium text-teal-800 hover:bg-teal-50"
                >
                  {showPhoto ? "ซ่อนรูปบัตร" : "ดูรูปบัตร"}
                </button>
                {showPhoto && (
                  <div className="mt-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- the photo comes from the API (session cookie), not a static asset */}
                    <img src={`/api/admin/borrowers/${encodeURIComponent(b.id)}/id-card`} alt="รูปบัตรประชาชนของผู้ยืม" className="max-h-96 rounded border border-slate-200" />
                  </div>
                )}
              </>
            ) : (
              "-"
            )}
          </dd>
        </div>
      </dl>
      {b.account !== null && actions.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button key={a.key} variant="secondary" disabled={busy} onClick={() => setConfirming(a.key)}>
                {a.label}
              </Button>
            ))}
          </div>
          {actions
            .filter((a) => a.key === confirming)
            .map((a) => (
              <div key={a.key} className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-medium text-slate-900">{a.ask}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="danger" disabled={busy} onClick={() => void run(a)}>
                    {busy ? "กำลังบันทึก..." : "ยืนยัน"}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>
                    ย้อนกลับ
                  </Button>
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
