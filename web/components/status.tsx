import type { ContractStatus, RequestStatus } from "@/lib/schemas";
import { Badge } from "./ui";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: "รอพิจารณา",
  APPROVED: "อนุมัติแล้ว",
  REJECTED: "ไม่อนุมัติ",
  CANCELLED: "ยกเลิกแล้ว",
};

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  AWAITING_DISBURSEMENT: "รอจ่ายเงิน",
  ACTIVE: "กำลังใช้งาน",
  CLOSED: "ชำระครบแล้ว",
  CANCELLED: "ยกเลิกแล้ว",
};

const REQUEST_TONE = { PENDING: "amber", APPROVED: "green", REJECTED: "red", CANCELLED: "gray" } as const;
const CONTRACT_TONE = { AWAITING_DISBURSEMENT: "amber", ACTIVE: "green", CLOSED: "gray", CANCELLED: "gray" } as const;

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={REQUEST_TONE[status]}>{REQUEST_STATUS_LABEL[status]}</Badge>;
}

/** The status, plus "เลยกำหนด N วัน" in red when the contract is past its due date and still open. */
export function ContractStatusBadges({
  status,
  isOverdue,
  daysOverdue,
}: {
  status: ContractStatus;
  isOverdue?: boolean;
  daysOverdue?: number;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={CONTRACT_TONE[status]}>{CONTRACT_STATUS_LABEL[status]}</Badge>
      {status === "ACTIVE" && isOverdue && <Badge tone="red">เลยกำหนด {daysOverdue ?? 0} วัน</Badge>}
    </span>
  );
}
