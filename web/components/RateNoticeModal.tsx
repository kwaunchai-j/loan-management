"use client";

import { useEffect } from "react";
import { useRateNotice } from "@/lib/rate-notice-store";
import type { RateNotice } from "@/lib/schemas";
import { useSession } from "@/lib/session-store";
import { formatDay } from "@/lib/money";
import { Modal } from "./Modal";
import { Alert, Button } from "./ui";

const pct = (v: string) => `${v}%`;

/** "ปรับอัตราดอกเบี้ยและค่าปรับ", or only the one that moved. */
function titleOf(n: RateNotice) {
  if (n.interestRatePctPerMonth && n.lateFeeRatePctPerDay) return "ผู้ให้กู้ปรับอัตราดอกเบี้ยและค่าปรับ";
  return n.interestRatePctPerMonth ? "ผู้ให้กู้ปรับอัตราดอกเบี้ย" : "ผู้ให้กู้ปรับอัตราค่าปรับ";
}

/** The day of the adjustment in Thailand ("2026-11-09T..." -> "9 พ.ย. 2569"). */
const dayOf = (iso: string) => formatDay(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(iso)));

function Row({ label, unit, from, to }: { label: string; unit: string; from: string; to: string }) {
  const up = Number(to) > Number(from);
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
      <dt className="text-sm text-slate-700">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-lg tabular-nums text-slate-500 line-through" aria-label={`เดิม ${pct(from)} ${unit}`}>
          {pct(from)}
        </span>
        <span aria-hidden="true" className="text-slate-500">
          →
        </span>
        <span className="text-2xl font-bold tabular-nums text-slate-900" aria-label={`ใหม่ ${pct(to)} ${unit}`}>
          {pct(to)}
        </span>
        <span className="text-sm text-slate-700">{unit}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${up ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{up ? "เพิ่มขึ้น" : "ลดลง"}</span>
      </dd>
    </div>
  );
}

/**
 * The dialog that tells a borrower the lender adjusted the interest rate and/or the late-fee rate (CR-9). They must press
 * "รับทราบ" before they can file a new loan request; "ไว้ทีหลัง" only closes it (they can still look around), and the request
 * page keeps asking. Mounted once, in the /me layout.
 */
export function RateNoticeModal() {
  const userId = useSession((s) => s.user?.id);
  const { notice, open, busy, error, load, hide, acknowledge, reset } = useRateNotice();

  // asked once when the borrower's pages open (and again for another borrower in the same tab)
  useEffect(() => {
    void load();
    return () => reset();
  }, [userId, load, reset]);

  if (!notice?.required) return null;
  const { interestRatePctPerMonth: interest, lateFeeRatePctPerDay: lateFee } = notice;
  return (
    <Modal open={open} onClose={hide} title={titleOf(notice)}>
      <div className="space-y-4">
        <p className="text-sm text-slate-800">
          ผู้ให้กู้ปรับอัตราเมื่อวันที่ {notice.changedAt ? dayOf(notice.changedAt) : "-"} กรุณาอ่านและกดรับทราบ ก่อนส่งคำขอยืมเงินครั้งต่อไป
        </p>
        <dl className="space-y-3">
          {interest && <Row label="อัตราดอกเบี้ย" unit="ต่อเดือน" from={interest.from} to={interest.to} />}
          {lateFee && <Row label="อัตราค่าปรับ (กรณีชำระช้ากว่ากำหนด)" unit="ต่อวัน" from={lateFee.from} to={lateFee.to} />}
        </dl>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>สัญญาที่ได้รับเงินไปแล้วยังใช้อัตราเดิม ไม่เปลี่ยนแปลง</li>
          <li>คำขอที่ยังไม่ได้รับเงิน จะใช้อัตราใหม่ตามวันที่ผู้ให้กู้โอนเงินให้</li>
          <li>คำขอยืมครั้งต่อไปจะคิดตามอัตราใหม่นี้</li>
        </ul>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={busy} onClick={hide}>
            ไว้ทีหลัง
          </Button>
          <Button disabled={busy} onClick={() => void acknowledge()}>
            {busy ? "กำลังบันทึก..." : "รับทราบ"}
          </Button>
        </div>
        <p className="text-xs text-slate-600">ถ้ายังไม่กดรับทราบ จะยังดูสัญญาและแจ้งชำระได้ตามปกติ แต่ส่งคำขอยืมเงินใหม่ไม่ได้</p>
      </div>
    </Modal>
  );
}
