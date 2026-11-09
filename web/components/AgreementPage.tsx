"use client";

import Link from "next/link";
import { AgreementDocument } from "@/components/AgreementDocument";
import { Alert, Spinner } from "@/components/ui";
import { agreementSchema } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

/** One request's loan agreement, loaded from `path`. Shared by the admin and the borrower pages. */
export function AgreementPage({ path, backHref, backLabel }: { path: string; backHref: string; backLabel: string }) {
  const agreement = useApi(path, agreementSchema);
  return (
    <>
      <Link href={backHref} className="text-sm font-medium text-teal-800 hover:underline print:hidden">
        ← {backLabel}
      </Link>
      {agreement.loading && <Spinner />}
      {agreement.error && <Alert kind="error">{agreement.error}</Alert>}
      {agreement.data && <AgreementDocument agreement={agreement.data} />}
    </>
  );
}
