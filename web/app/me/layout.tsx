"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Gate } from "@/components/Gate";

/** Every /me page: a BORROWER who has accepted the PDPA terms (and changed the first password). */
export default function BorrowerLayout({ children }: { children: ReactNode }) {
  return (
    <Gate need="borrower">
      <AppShell>{children}</AppShell>
    </Gate>
  );
}
