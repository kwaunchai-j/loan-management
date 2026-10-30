"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { PushError, readPushState, subscribeThisDevice, unsubscribeThisDevice, type PushState } from "@/lib/push";
import { pushPublicKeySchema, pushSubscribedSchema } from "@/lib/schemas";

/** Web Push for THIS device: ask permission, register the browser with the server, or switch it off. */
export function PushCard() {
  const [state, setState] = useState<PushState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await readPushState());
    } catch {
      setState({ kind: "unsupported" });
    }
  }, []);
  // the first reading happens in a promise callback (not in the effect body itself)
  useEffect(() => {
    let live = true;
    readPushState().then(
      (s) => live && setState(s),
      () => live && setState({ kind: "unsupported" }),
    );
    return () => {
      live = false;
    };
  }, []);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const { publicKey } = await apiFetch("/admin/push/public-key", { schema: pushPublicKeySchema });
      const sub = await subscribeThisDevice(publicKey);
      await apiFetch("/admin/push-subscriptions", { method: "POST", json: sub, schema: pushSubscribedSchema });
    } catch (err) {
      setError(err instanceof PushError ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const endpoint = await unsubscribeThisDevice();
      if (endpoint) {
        // the server forgetting it is a courtesy: a 404 (already gone) is fine
        await apiFetch("/admin/push-subscriptions", { method: "DELETE", json: { endpoint }, schema: pushSubscribedSchema }).catch(() => undefined);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return (
    <Card title="แจ้งเตือนบนเครื่องนี้ (Web Push)">
      {state === null && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {state?.kind === "unsupported" && <Alert kind="warning">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนแบบ Web Push ลองใช้ Chrome, Edge, Firefox หรือ Safari บน iPhone ที่เพิ่มแอปลงหน้าจอโฮมแล้ว</Alert>}
      {state?.kind === "needs-install" && (
        <Alert kind="warning">
          iPhone/iPad ใช้ Web Push ได้เฉพาะเมื่อ <strong>เพิ่มแอปลงหน้าจอโฮม</strong> แล้วเปิดจากไอคอนนั้น ทำตามขั้นตอนด้านล่าง แล้วกลับมาที่หน้านี้
        </Alert>
      )}
      {state?.kind === "no-worker" && (
        <Alert kind="warning">ยังไม่พบ service worker ของแอป (ใช้ได้เฉพาะเวอร์ชันที่เปิดใช้งานจริง) ลองรีเฟรชหน้านี้หนึ่งครั้ง ถ้ายังไม่ขึ้นให้ตรวจว่าเปิดผ่าน HTTPS</Alert>
      )}
      {state?.kind === "blocked" && (
        <Alert kind="warning">เบราว์เซอร์ถูกตั้งไว้ไม่ให้เว็บนี้แสดงการแจ้งเตือน กรุณาเปิดอนุญาตในการตั้งค่าของเบราว์เซอร์ (หรือการตั้งค่าแอปบน iPhone) แล้วกลับมาหน้านี้</Alert>
      )}
      {state?.kind === "off" && (
        <>
          <p className="mb-3 text-slate-700">เครื่องนี้ยังไม่ได้เปิดการแจ้งเตือน เมื่อเปิดแล้วจะได้รับแจ้งทันทีเมื่อมีคำขอยืมใหม่ และสรุปสัญญาที่ครบกำหนดหรือเลยกำหนด</p>
          <Button disabled={busy} onClick={() => void enable()}>
            {busy ? "กำลังเปิด..." : "เปิดการแจ้งเตือนบนเครื่องนี้"}
          </Button>
        </>
      )}
      {state?.kind === "on" && (
        <>
          <p className="mb-3 flex items-center gap-2 text-slate-800">
            <Badge tone="green">เปิดอยู่</Badge> เครื่องนี้รับการแจ้งเตือนแล้ว (กดปุ่ม “ส่งทดสอบ” ด้านล่างเพื่อตรวจ)
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => void disable()}>
            {busy ? "กำลังปิด..." : "ปิดการแจ้งเตือนบนเครื่องนี้"}
          </Button>
        </>
      )}
    </Card>
  );
}
