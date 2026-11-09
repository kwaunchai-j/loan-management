"use client";

import { use } from "react";
import { AgreementPage } from "@/components/AgreementPage";

export default function MyAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AgreementPage path={`/me/loan-requests/${encodeURIComponent(id)}/agreement`} backHref="/me/request" backLabel="ขอยืมเงิน" />;
}
