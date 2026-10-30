"use client";

import { PortalContractCard } from "@/components/PortalContract";
import { Alert, Card, PageTitle, Spinner } from "@/components/ui";
import { portalContractListSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

export default function MyContractsPage() {
  const contracts = useApi("/me/contracts", portalContractListSchema);
  return (
    <>
      <PageTitle>สัญญาของฉัน</PageTitle>
      {contracts.loading && <Spinner />}
      {contracts.error && <Alert kind="error">{contracts.error}</Alert>}
      {contracts.data && contracts.data.items.length === 0 && (
        <Card>
          <p className="text-slate-700">ยังไม่มีสัญญา เมื่อคำขอได้รับอนุมัติ สัญญาจะแสดงที่นี่</p>
        </Card>
      )}
      <div className="space-y-3">
        {contracts.data?.items.map((c) => (
          <PortalContractCard key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}
