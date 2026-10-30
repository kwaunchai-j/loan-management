"use client";

import Link from "next/link";
import { Alert, Card, Icon, PageTitle, Spinner, type IconName } from "@/components/ui";
import { settingsSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

const SHORTCUTS: Array<{ href: string; label: string; icon: IconName; settings?: true }> = [
  { href: "/admin/settings", label: "ตั้งอัตราดอกเบี้ยและค่าปรับ", icon: "sliders", settings: true },
  { href: "/admin/calendar", label: "ปฏิทิน (สัญญาที่ครบกำหนดและรายการรับชำระรายวัน)", icon: "calendar" },
  { href: "/admin/payments", label: "สลิปชำระที่ผู้ยืมส่งมา", icon: "receipt" },
  { href: "/admin/requests", label: "คำขอยืมที่รอพิจารณา", icon: "inbox" },
  { href: "/admin/contracts", label: "สัญญา จ่ายเงิน และรับชำระ", icon: "document" },
  { href: "/admin/borrowers", label: "จัดการผู้ยืม (สร้างบัญชี แก้ข้อมูล รีเซ็ตรหัสผ่าน)", icon: "users" },
];

export default function AdminHomePage() {
  const settings = useApi("/admin/settings", settingsSchema);
  const ratesReady = settings.data ? settings.data.interestRatePctPerMonth !== null && settings.data.lateFeeRatePctPerDay !== null : null;

  return (
    <>
      <PageTitle>หน้าหลักผู้ดูแลระบบ</PageTitle>

      {settings.loading && <Spinner />}
      {settings.error && <Alert kind="error">{settings.error}</Alert>}
      {ratesReady === false && (
        <Alert kind="warning">
          <p className="font-medium">ยังไม่ได้ตั้งอัตราดอกเบี้ยและอัตราค่าปรับ</p>
          <p>
            ระบบจะบันทึกการจ่ายเงินและนำเข้าข้อมูลไม่ได้จนกว่าจะตั้งค่า{" "}
            <Link href="/admin/settings" className="font-medium underline">
              ไปตั้งค่าอัตรา
            </Link>
          </p>
        </Alert>
      )}

      <Card title="เริ่มต้นใช้งาน">
        <ul className="grid gap-3 sm:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <li key={s.href}>
              <Link
                href={s.href}
                className="group flex min-h-16 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:-translate-y-px hover:border-teal-500 hover:shadow-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
              >
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-800 transition group-hover:bg-teal-700 group-hover:text-white">
                  <Icon name={s.icon} className="h-6 w-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-900">{s.label}</span>
                  {s.settings && ratesReady !== null && (
                    <span className={`block text-sm font-medium ${ratesReady ? "text-emerald-700" : "text-amber-700"}`}>
                      {ratesReady ? "✓ ตั้งแล้ว" : "⚠ ยังไม่ตั้ง"}
                    </span>
                  )}
                </span>
                <Icon name="chevronRight" className="h-5 w-5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-teal-700" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
