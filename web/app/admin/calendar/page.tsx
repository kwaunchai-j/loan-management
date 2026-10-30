"use client";

import { CalendarView } from "@/components/calendar/CalendarView";
import { PageTitle } from "@/components/ui";

/** The month at a glance: what falls due on each day and what was paid on it. */
export default function CalendarPage() {
  return (
    <>
      <PageTitle>ปฏิทิน</PageTitle>
      <p className="text-slate-700">สัญญาแต่ละฉบับอยู่ในวันครบกำหนดของมัน และรายการรับชำระอยู่ในวันที่รับเงิน กดที่วันเพื่อดูรายละเอียด</p>
      <CalendarView />
    </>
  );
}
