"use client";

import Link from "next/link";
import { PortalContractCard } from "@/components/PortalContract";
import { Alert, Card, PageTitle, Spinner } from "@/components/ui";
import { myRequestListSchema, portalContractListSchema } from "@/lib/schemas";
import { useSession } from "@/lib/session-store";
import { useApi } from "@/lib/use-api";

export default function BorrowerHomePage() {
  const user = useSession((s) => s.user);
  const contracts = useApi("/me/contracts", portalContractListSchema);
  const requests = useApi("/me/loan-requests", myRequestListSchema);

  const open = contracts.data?.items.filter((c) => c.status === "ACTIVE" || c.status === "AWAITING_DISBURSEMENT") ?? [];
  const pending = requests.data?.items.filter((r) => r.status === "PENDING").length ?? 0;
  const loading = contracts.loading || requests.loading;

  return (
    <>
      <PageTitle>สวัสดี {user?.username}</PageTitle>

      <Link
        href="/me/request"
        className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 font-medium text-white hover:bg-teal-800"
      >
        + ขอยืมเงิน
      </Link>

      {contracts.error && <Alert kind="error">{contracts.error}</Alert>}
      {requests.error && <Alert kind="error">{requests.error}</Alert>}
      {loading && <Spinner />}

      {pending > 0 && (
        <Alert kind="info">
          คุณมีคำขอที่รอพิจารณา {pending} รายการ{" "}
          <Link href="/me/request" className="font-medium underline">
            ดูคำขอ
          </Link>
        </Alert>
      )}

      {contracts.data && open.length === 0 && (
        <Card>
          <p className="text-slate-700">ตอนนี้ไม่มีสัญญาที่ต้องชำระ</p>
        </Card>
      )}
      {open.length > 0 && (
        <section aria-label="สัญญาที่ยังไม่ปิด" className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">สัญญาที่ยังไม่ปิด</h2>
          {open.map((c) => (
            <PortalContractCard key={c.id} c={c} />
          ))}
        </section>
      )}

      <p className="text-sm text-slate-600">
        <Link href="/me/contracts" className="font-medium text-teal-800 underline">
          ดูสัญญาทั้งหมดและประวัติการชำระ
        </Link>
      </p>
    </>
  );
}
