"use client";

import Link from "next/link";
import { use, useState } from "react";
import { AccrualTable, DisbursementRecord, PaymentList } from "@/components/contract/History";
import { DisbursementPanel } from "@/components/contract/DisbursementPanel";
import { PaymentPanel } from "@/components/contract/PaymentPanel";
import { PendingClaimsAlert } from "@/components/payments/PendingClaimsAlert";
import { ContractStatusBadges } from "@/components/status";
import { Alert, Badge, Card, Item, PageTitle, Spinner } from "@/components/ui";
import { formatBaht, formatDay } from "@/lib/money";
import { adminContractDetailSchema, type AdminContractDetail } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

export default function AdminContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useApi(`/admin/contracts/${encodeURIComponent(id)}`, adminContractDetailSchema);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <Link href="/admin/contracts" className="text-sm font-medium text-teal-800 hover:underline">
        ← รายการสัญญา
      </Link>
      {detail.loading && <Spinner />}
      {detail.error && <Alert kind="error">{detail.error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {detail.data && (
        <Detail
          d={detail.data}
          onChanged={(text) => {
            setNotice(text);
            detail.reload();
          }}
        />
      )}
    </>
  );
}

function Detail({ d, onChanged }: { d: AdminContractDetail; onChanged: (text: string) => void }) {
  const c = d.contract;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>สัญญา {c.contractNo}</PageTitle>
        <span className="flex flex-wrap items-center gap-2">
          <ContractStatusBadges status={c.status} isOverdue={c.isOverdue} daysOverdue={c.daysOverdue} />
          {c.isImported && <Badge tone="gray">นำเข้าจากไฟล์</Badge>}
        </span>
      </div>
      {c.inconsistent && (
        <Alert kind="error">ประวัติรายการของสัญญานี้ไม่สอดคล้องกับกฎการคำนวณ ตัวเลขที่แสดงเป็นค่าที่เก็บไว้ในระบบ กรุณาตรวจรายการจ่ายเงินและรับชำระ</Alert>
      )}

      <Card>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Item
            label="ผู้ยืม"
            value={
              <Link href={`/admin/borrowers/${encodeURIComponent(c.borrower.id)}`} className="font-medium text-teal-800 underline">
                {c.borrower.fullName}
              </Link>
            }
          />
          <Item label="เงินต้น" value={`${formatBaht(c.principal)} บาท`} />
          <Item label="วันครบกำหนด" value={formatDay(c.dueDate)} />
          {c.disbursedOn && <Item label="วันที่จ่ายเงิน" value={formatDay(c.disbursedOn)} />}
          {c.status === "AWAITING_DISBURSEMENT" && <Item label="ยอดที่ต้องชำระ" value="ยังไม่แสดง (รอจ่ายเงิน)" />}
          {c.totalDue !== null && <Item label={c.status === "CLOSED" ? "ยอดคงค้าง" : "ยอดที่ต้องชำระวันนี้"} value={`${formatBaht(c.totalDue)} บาท`} strong />}
          {(c.status === "ACTIVE" || c.status === "CLOSED") && (
            <>
              <Item label="เงินต้นคงเหลือ" value={`${formatBaht(c.outstandingPrincipal)} บาท`} />
              <Item label={`ดอกเบี้ยคงเหลือ (ทั้งหมด ${formatBaht(c.interestAmount)})`} value={`${formatBaht(c.outstandingInterest)} บาท`} />
              <Item label="ค่าปรับสะสม" value={`${formatBaht(c.accruedLateFee)} บาท`} />
              <Item
                label="อัตราที่ใช้ (ล็อกไว้ตอนจ่ายเงิน)"
                value={c.interestRatePctPerMonth === null ? `ไม่มีดอกเบี้ยจากอัตรา · ค่าปรับ ${c.lateFeeRatePctPerDay ?? "-"}% ต่อวัน` : `ดอกเบี้ย ${c.interestRatePctPerMonth}% ต่อเดือน · ค่าปรับ ${c.lateFeeRatePctPerDay ?? "-"}% ต่อวัน`}
              />
            </>
          )}
          {c.closedOn && <Item label="ชำระครบเมื่อ" value={formatDay(c.closedOn)} />}
        </dl>
      </Card>

      {c.status === "ACTIVE" && <PendingClaimsAlert contractId={c.id} />}
      {c.status === "AWAITING_DISBURSEMENT" && <DisbursementPanel detail={d} onChanged={onChanged} />}
      {c.status === "ACTIVE" && <PaymentPanel detail={d} onChanged={onChanged} />}

      {d.disbursement && <DisbursementRecord d={d.disbursement} onChanged={onChanged} />}
      {(c.status === "ACTIVE" || c.status === "CLOSED" || d.payments.length > 0) && <PaymentList contract={c} payments={d.payments} onChanged={onChanged} />}
      <AccrualTable accruals={d.lateFeeAccruals} />
    </>
  );
}
