"use client";

import { InstallGuide } from "@/components/notifications/InstallGuide";
import { LineCard } from "@/components/notifications/LineCard";
import { PushCard } from "@/components/notifications/PushCard";
import { TestCard } from "@/components/notifications/TestCard";
import { PageTitle } from "@/components/ui";

/** Where the admin chooses how to be told about new requests and contracts that are due or overdue (DES-013). */
export default function NotificationsPage() {
  return (
    <>
      <PageTitle>ตั้งค่าแจ้งเตือน</PageTitle>
      <p className="text-slate-700">ผู้ดูแลระบบจะได้รับแจ้งเมื่อมีคำขอยืมใหม่ (ทันที) และสรุปสัญญาที่ครบกำหนดวันนี้ (09:00) กับที่เลยกำหนด (17:00) ผู้ยืมไม่ได้รับการแจ้งเตือนจากระบบนี้</p>
      <PushCard />
      <InstallGuide />
      <LineCard />
      <TestCard />
    </>
  );
}
