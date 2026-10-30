"use client";

import { useSyncExternalStore } from "react";
import { Card } from "@/components/ui";
import { isIos, isStandalone } from "@/lib/push";

/** How to put the app on an iPhone's home screen — the only way an iPhone gets Web Push (iOS 16.4+). */
export function InstallGuide() {
  // read from the browser itself (nothing to subscribe to); the server render has no browser, so no answer yet
  const snapshot = useSyncExternalStore(
    () => () => undefined,
    () => `${isIos()}|${isStandalone()}`,
    () => "",
  );
  const where = snapshot === "" ? null : { ios: snapshot.startsWith("true"), standalone: snapshot.endsWith("true") };
  return (
    <Card title="ติดตั้งแอปบน iPhone (เพิ่มลงหน้าจอโฮม)">
      {where && (
        <p className="mb-3 text-sm font-medium text-slate-800">
          {where.standalone ? "✓ เครื่องนี้เปิดจากไอคอนบนหน้าจอโฮมแล้ว" : where.ios ? "เครื่องนี้เป็น iPhone/iPad และยังไม่ได้เปิดจากไอคอนบนหน้าจอโฮม" : "ขั้นตอนนี้ใช้เฉพาะ iPhone/iPad (เครื่องอื่นเปิดแจ้งเตือนได้เลยโดยไม่ต้องติดตั้ง)"}
        </p>
      )}
      <ol className="list-inside list-decimal space-y-2 text-slate-800">
        <li>เปิดเว็บนี้ด้วย <strong>Safari</strong> (ไม่ใช่เบราว์เซอร์อื่นหรือแอปแชท) บน iOS 16.4 ขึ้นไป</li>
        <li>แตะปุ่ม <strong>แชร์</strong> (ไอคอนสี่เหลี่ยมมีลูกศรชี้ขึ้น) ที่แถบด้านล่าง</li>
        <li>เลื่อนหาแล้วแตะ <strong>“เพิ่มลงหน้าจอโฮม”</strong> จากนั้นแตะ “เพิ่ม”</li>
        <li>ปิด Safari แล้ว <strong>เปิดแอปจากไอคอนบนหน้าจอโฮม</strong> และเข้าสู่ระบบ</li>
        <li>มาที่หน้านี้ แล้วกด “เปิดการแจ้งเตือนบนเครื่องนี้” และเลือก “อนุญาต”</li>
      </ol>
      <p className="mt-3 text-sm text-slate-600">หากเคยกด “ไม่อนุญาต” ไปแล้ว ให้เปิดที่ การตั้งค่า &gt; การแจ้งเตือน &gt; ระบบขอยืมเงิน บน iPhone</p>
    </Card>
  );
}
