"use client";

import { SubmissionQueue } from "@/components/payments/SubmissionQueue";
import { PageTitle } from "@/components/ui";

/** Slips that borrowers sent for payments (CR-1): check each one, then confirm it or refuse it. */
export default function PaymentsPage() {
  return (
    <>
      <PageTitle>สลิปชำระที่ผู้ยืมส่งมา</PageTitle>
      <p className="text-slate-700">ผู้ยืมแจ้งว่าโอนแล้ว ยอดค้างยังไม่ลดจนกว่าคุณจะตรวจสลิปและกดยืนยัน</p>
      <SubmissionQueue />
    </>
  );
}
