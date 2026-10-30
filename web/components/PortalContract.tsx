import Link from "next/link";
import type { PortalContract } from "@/lib/schemas";
import { formatBaht, formatDay } from "@/lib/money";
import { ContractStatusBadges } from "./status";

/**
 * A contract as a borrower sees it. Before the payout (`AWAITING_DISBURSEMENT`) the API sends no
 * amount owed, and none is shown: only what was asked for and a plain explanation.
 */
export function PortalContractCard({ c }: { c: PortalContract }) {
  return (
    <Link href={`/me/contracts/${encodeURIComponent(c.id)}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-teal-600">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-lg font-semibold text-slate-900">สัญญา {c.contractNo}</p>
        <ContractStatusBadges status={c.status} isOverdue={c.isOverdue} daysOverdue={c.daysOverdue} />
      </div>
      {c.status === "ACTIVE" && c.totalDue !== undefined && (
        <>
          <p className="mt-2 text-sm text-slate-600">ยอดที่ต้องชำระวันนี้</p>
          <p className="text-2xl font-bold text-slate-900">{formatBaht(c.totalDue)} บาท</p>
          <p className="text-sm text-slate-700">ครบกำหนด {formatDay(c.dueDate)}</p>
          {c.accruedLateFee !== undefined && !/^0(\.0+)?$/.test(c.accruedLateFee) && (
            <p className="text-sm text-red-700">รวมค่าปรับสะสม {formatBaht(c.accruedLateFee)} บาท</p>
          )}
        </>
      )}
      {c.status === "AWAITING_DISBURSEMENT" && (
        <p className="mt-2 text-sm text-slate-700">
          จำนวนที่ขอ {formatBaht(c.principal)} บาท · ครบกำหนด {formatDay(c.dueDate)}
          <br />
          รอผู้ให้กู้โอนเงิน ยอดที่ต้องชำระจะแสดงหลังได้รับเงินแล้ว
        </p>
      )}
      {c.status === "CLOSED" && (
        <p className="mt-2 text-sm text-slate-700">ชำระครบเมื่อ {formatDay(c.closedOn ?? null)}</p>
      )}
      {c.status === "CANCELLED" && <p className="mt-2 text-sm text-slate-700">สัญญานี้ถูกยกเลิก</p>}
    </Link>
  );
}
