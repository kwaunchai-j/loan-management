"use client";

import Link from "next/link";
import { use } from "react";
import { PaymentSubmitCard } from "@/components/PaymentSubmitCard";
import { ContractStatusBadges } from "@/components/status";
import { Alert, Card, Item, PageTitle, Spinner } from "@/components/ui";
import { formatBaht, formatDay, isZeroMoney } from "@/lib/money";
import { portalContractDetailSchema, type PortalContractDetail } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

export default function MyContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useApi(`/me/contracts/${encodeURIComponent(id)}`, portalContractDetailSchema);
  return (
    <>
      <Link href="/me/contracts" className="text-sm font-medium text-teal-800 hover:underline">
        ← สัญญาทั้งหมด
      </Link>
      {detail.loading && <Spinner />}
      {detail.error && <Alert kind="error">{detail.error}</Alert>}
      {detail.data && <Detail d={detail.data} />}
    </>
  );
}

function Detail({ d }: { d: PortalContractDetail }) {
  const c = d.contract;
  const paidOut = c.status === "ACTIVE" || c.status === "CLOSED";
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>สัญญา {c.contractNo}</PageTitle>
        <ContractStatusBadges status={c.status} isOverdue={c.isOverdue} daysOverdue={c.daysOverdue} />
      </div>

      {c.status === "AWAITING_DISBURSEMENT" && (
        <Alert kind="info">รอผู้ให้กู้โอนเงิน ระบบจะแสดงดอกเบี้ยและยอดที่ต้องชำระหลังจากได้รับเงินแล้ว</Alert>
      )}
      {c.status === "CANCELLED" && <Alert kind="info">สัญญานี้ถูกยกเลิก</Alert>}

      {paidOut && c.totalDue !== undefined && (
        <Card title={c.status === "CLOSED" ? "ชำระครบแล้ว" : "ยอดที่ต้องชำระวันนี้"}>
          <p className="text-3xl font-bold text-slate-900">{formatBaht(c.totalDue)} บาท</p>
          {c.status === "ACTIVE" && (
            <p className="mt-1 text-slate-700">
              ครบกำหนด {formatDay(c.dueDate)}
              {c.isOverdue ? ` · เลยกำหนด ${c.daysOverdue ?? 0} วัน ค่าปรับเพิ่มทุกวัน` : ""}
            </p>
          )}
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <Item label="เงินต้นคงเหลือ" value={`${formatBaht(c.outstandingPrincipal)} บาท`} />
            <Item label="ดอกเบี้ยคงเหลือ" value={`${formatBaht(c.outstandingInterest)} บาท`} />
            <Item label="ค่าปรับสะสม" value={`${formatBaht(c.accruedLateFee)} บาท`} />
          </dl>
          <p className="mt-3 text-sm text-slate-600">ชำระเงินให้ผู้ให้กู้โดยตรง แล้วผู้ให้กู้จะบันทึกการรับชำระในระบบ</p>
        </Card>
      )}

      {c.status === "ACTIVE" && <PaymentSubmitCard contractId={c.id} disbursedOn={d.disbursement?.paidOn ?? c.disbursedOn ?? null} />}

      <Card title="ข้อมูลสัญญา">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Item label="เงินต้น" value={`${formatBaht(c.principal)} บาท`} />
          <Item label="วันครบกำหนด" value={formatDay(c.dueDate)} />
          {paidOut && <Item label="ดอกเบี้ย" value={`${formatBaht(c.interestAmount ?? null)} บาท`} />}
          {paidOut && d.disbursement && <Item label="วันที่ได้รับเงิน" value={formatDay(d.disbursement.paidOn)} />}
          {c.status === "CLOSED" && <Item label="ชำระครบเมื่อ" value={formatDay(c.closedOn ?? null)} />}
        </dl>
      </Card>

      {paidOut && (
        <Card title="ประวัติการชำระ">
          {d.payments.length === 0 ? (
            <p className="text-slate-700">ยังไม่มีรายการชำระ</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.payments.map((p) => (
                <li key={p.id} className="py-3">
                  <p className="font-semibold text-slate-900">
                    {formatDay(p.paidOn)} · {formatBaht(p.amount)} บาท
                  </p>
                  <p className="text-sm text-slate-600">
                    ตัดเป็น: {[
                      !isZeroMoney(p.allocatedLateFee) ? `ค่าปรับ ${formatBaht(p.allocatedLateFee)}` : null,
                      !isZeroMoney(p.allocatedInterest) ? `ดอกเบี้ย ${formatBaht(p.allocatedInterest)}` : null,
                      !isZeroMoney(p.allocatedPrincipal) ? `เงินต้น ${formatBaht(p.allocatedPrincipal)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
