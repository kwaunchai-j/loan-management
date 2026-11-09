"use client";

import { use } from "react";
import { AgreementPage } from "@/components/AgreementPage";

export default function AdminAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AgreementPage path={`/admin/loan-requests/${encodeURIComponent(id)}/agreement`} backHref="/admin/requests" backLabel="คำขอยืม" />;
}
