"use client";

import { useState } from "react";
import { BatchList } from "@/components/imports/BatchList";
import { ImportFlow } from "@/components/imports/ImportFlow";
import { PageTitle } from "@/components/ui";

export default function ImportsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <PageTitle>นำเข้าสัญญาเก่า</PageTitle>
      <ImportFlow onImported={() => setReloadKey((k) => k + 1)} />
      <BatchList reloadKey={reloadKey} />
    </>
  );
}
