"use client";

import { useState } from "react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { notificationTestSchema } from "@/lib/schemas";

const CHANNEL_LABEL: Record<string, string> = { LINE: "LINE", WEB_PUSH: "Web Push" };

/** One line per channel, from what the server answered ("sent", "no_recipient" or "failed: ..."). */
export function describeResult(value: string): { tone: "green" | "amber" | "red"; text: string; detail: string | null } {
  if (value === "sent") return { tone: "green", text: "ส่งแล้ว", detail: null };
  if (value === "no_recipient") return { tone: "amber", text: "ยังไม่มีผู้รับ (ยังไม่ได้ผูกบัญชีหรือเปิดการแจ้งเตือน)", detail: null };
  return { tone: "red", text: "ส่งไม่สำเร็จ", detail: value.replace(/^failed:\s*/, "") || null };
}

/** The "test send" button: goes straight to the channels, is not recorded and not de-duplicated. */
export function TestCard() {
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiFetch("/admin/notifications/test", { method: "POST", schema: notificationTestSchema }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const channels = result ? Object.entries(result) : [];
  return (
    <Card title="ทดสอบส่งแจ้งเตือน">
      <p className="mb-3 text-sm text-slate-700">ส่งข้อความทดสอบไปทุกช่องทางที่ตั้งไว้ ถ้าเครื่องนี้เปิด Web Push แล้วจะเห็นการแจ้งเตือนขึ้นภายในไม่กี่วินาที</p>
      <Button disabled={busy} onClick={() => void send()}>
        {busy ? "กำลังส่ง..." : "ส่งทดสอบ"}
      </Button>
      {error && (
        <div className="mt-3">
          <Alert kind="error">{error}</Alert>
        </div>
      )}
      {result && channels.length === 0 && (
        <div className="mt-3">
          <Alert kind="warning">ยังไม่มีช่องทางแจ้งเตือนที่ตั้งค่าบนเซิร์ฟเวอร์</Alert>
        </div>
      )}
      <ul className="mt-3 space-y-2">
        {channels.map(([channel, value]) => {
          const r = describeResult(value);
          return (
            <li key={channel} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{CHANNEL_LABEL[channel] ?? channel}</span>
              <Badge tone={r.tone}>{r.text}</Badge>
              {r.detail && <span className="text-sm text-slate-600">({r.detail})</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
