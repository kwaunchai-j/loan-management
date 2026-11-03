"use client";

import { useState } from "react";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { feedLinks } from "@/lib/calendar";
import { calendarFeedLinkSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

const LINK_CLASS =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-base font-medium text-slate-800 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";

/**
 * Subscribes Google Calendar or iCloud / Apple Calendar to the contracts' due dates. The calendar app reads a
 * private link by itself (no login), so the link is a secret: it is shown only to the admin, and it stops
 * working when the admin changes their password. The subscription is read-only and refreshed by the calendar app.
 */
export function CalendarLink() {
  const feed = useApi("/admin/calendar/feed-link", calendarFeedLinkSchema);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const links = feed.data ? feedLinks(window.location.origin, feed.data.path) : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(links!.https);
      setCopied("done");
    } catch {
      setCopied("failed"); // no clipboard permission: the address is shown below to copy by hand
    }
  }

  return (
    <Card title="เชื่อมต่อกับ Google Calendar / iCloud">
      <p className="mb-3 text-slate-700">
        แสดงวันครบกำหนดชำระของสัญญาที่ยังค้างอยู่ในปฏิทินของคุณ พร้อมเตือน 9:00 น. ของวันครบกำหนด รายการจะอัปเดตตามที่ปฏิทินดึงข้อมูลใหม่ (Google อาจใช้เวลาหลายชั่วโมง) และแก้ไขในปฏิทินไม่ได้
      </p>
      {feed.error && <Alert kind="error">{feed.error}</Alert>}
      {feed.loading && <Spinner />}
      {links && (
        <div className="space-y-3">
          {!links.reachable && (
            <Alert kind="warning">
              หน้านี้เปิดจากที่อยู่ที่ใช้ได้เฉพาะในเครื่อง/เครือข่ายนี้ Google และ iCloud จึงเข้าถึงลิงก์ไม่ได้ ให้ใช้งานจากที่อยู่จริงของระบบ (https) แทน
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <a className={LINK_CLASS} href={links.google} target="_blank" rel="noopener noreferrer">
              เพิ่มใน Google Calendar
            </a>
            <a className={LINK_CLASS} href={links.webcal}>
              เพิ่มใน iCloud / Apple Calendar
            </a>
            <Button variant="secondary" onClick={() => void copy()}>
              คัดลอกลิงก์
            </Button>
          </div>
          {copied === "done" && <Alert kind="success">คัดลอกลิงก์แล้ว</Alert>}
          {copied === "failed" && <Alert kind="warning">คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอกจากช่องด้านล่าง</Alert>}
          <details className="text-sm text-slate-700">
            <summary className="cursor-pointer font-medium text-teal-800">วิธีเพิ่มเอง และข้อควรระวัง</summary>
            <div className="mt-2 space-y-2">
              <p>
                <span className="font-medium">Google Calendar (เว็บ):</span> การตั้งค่า → เพิ่มปฏิทิน → จาก URL แล้ววางลิงก์ด้านล่าง ·{" "}
                <span className="font-medium">iPhone:</span> การตั้งค่า → ปฏิทิน → บัญชี → เพิ่มบัญชี → อื่น ๆ → เพิ่มปฏิทินที่สมัครรับ
              </p>
              <input
                readOnly
                aria-label="ลิงก์ปฏิทิน"
                value={links.https}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs"
              />
              <p>
                ลิงก์นี้เป็นความลับ ใครมีลิงก์จะเห็นชื่อผู้ยืมและยอดค้างทั้งหมด อย่าส่งต่อ ชื่อและยอดจะถูกเก็บไว้ที่ Google/Apple ด้วย หากลิงก์หลุด ให้เปลี่ยนรหัสผ่านของคุณ ลิงก์เดิมจะใช้ไม่ได้ทันที แล้วเพิ่มปฏิทินใหม่ด้วยลิงก์ใหม่
              </p>
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}
