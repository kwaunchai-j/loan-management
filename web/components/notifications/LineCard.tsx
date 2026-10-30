"use client";

import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, Spinner, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { lineBindingSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

/** Mirrors the API: "U" followed by 32 hexadecimal digits. */
export const LINE_USER_ID = /^U[0-9a-f]{32}$/;

/**
 * Binds the admin's LINE account by typing the LINE user id (the webhook "follow" way is an open
 * question, Q1: it would let anyone who adds the Official Account take over the binding). Only a
 * masked id ever comes back from the server, so the full id is never shown again.
 */
export function LineCard() {
  const binding = useApi("/admin/line-binding", lineBindingSchema);
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const id = value.trim();
    if (!LINE_USER_ID.test(id)) {
      setFieldError("LINE user id ต้องขึ้นต้นด้วย U ตามด้วยตัวเลข/ตัวอักษร a-f อีก 32 ตัว");
      return;
    }
    setFieldError(null);
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch("/admin/line-binding", { method: "PUT", json: { lineUserId: id }, schema: lineBindingSchema });
      setValue("");
      setNotice({ kind: "success", text: "ผูกบัญชี LINE แล้ว" });
      binding.reload();
    } catch (err) {
      setNotice({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch("/admin/line-binding", { method: "DELETE", schema: lineBindingSchema });
      setConfirmingRemove(false);
      setNotice({ kind: "success", text: "ยกเลิกการผูกบัญชี LINE แล้ว" });
      binding.reload();
    } catch (err) {
      setConfirmingRemove(false);
      setNotice({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="แจ้งเตือนทาง LINE">
      {binding.loading && <Spinner />}
      {binding.error && <Alert kind="error">{binding.error}</Alert>}
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {binding.data && (
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-slate-800">
            {binding.data.bound ? (
              <>
                <Badge tone="green">ผูกแล้ว</Badge> บัญชี LINE <span className="font-mono">{binding.data.lineUserId}</span>
              </>
            ) : (
              <>
                <Badge tone="amber">ยังไม่ผูก</Badge> ยังไม่มีบัญชี LINE ที่จะรับแจ้งเตือน
              </>
            )}
          </p>
          <form onSubmit={(e) => void save(e)} className="space-y-3" noValidate>
            <TextField
              label={binding.data.bound ? "เปลี่ยนเป็น LINE user id ใหม่" : "LINE user id"}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={value}
              error={fieldError}
              hint="รหัสผู้ใช้ LINE (ขึ้นต้นด้วย U ตามด้วย 32 ตัว) ไม่ใช่ชื่อหรือ LINE ID ที่ใช้ค้นหาเพื่อน — ดูได้จาก LINE Developers ของ Official Account ของคุณ"
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              {busy ? "กำลังบันทึก..." : binding.data.bound ? "บันทึกการเปลี่ยน" : "ผูกบัญชี LINE"}
            </Button>
          </form>
          {binding.data.bound &&
            (confirmingRemove ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <span className="font-medium text-slate-900">ยกเลิกการผูกบัญชี LINE?</span>
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                  ยืนยันยกเลิกการผูก
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setConfirmingRemove(false)}>
                  ไม่ยกเลิก
                </Button>
              </div>
            ) : (
              <Button variant="secondary" onClick={() => setConfirmingRemove(true)}>
                ยกเลิกการผูกบัญชี LINE
              </Button>
            ))}
        </div>
      )}
    </Card>
  );
}
