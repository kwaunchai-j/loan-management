"use client";

import Link from "next/link";
import { Alert } from "@/components/ui";
import { adminSubmissionListSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

/** On a contract page: a reminder when the borrower has sent slips that nobody has checked yet. */
export function PendingClaimsAlert({ contractId }: { contractId: string }) {
  const r = useApi(`/admin/payment-submissions?contractId=${encodeURIComponent(contractId)}&status=PENDING&limit=1`, adminSubmissionListSchema);
  if (!r.data || r.data.total === 0) return null;
  return (
    <Alert kind="warning">
      ผู้ยืมส่งสลิปชำระของสัญญานี้มา {r.data.total} รายการ รอตรวจสอบ{" "}
      <Link href="/admin/payments" className="font-medium underline">
        ไปตรวจสลิป
      </Link>
    </Alert>
  );
}
