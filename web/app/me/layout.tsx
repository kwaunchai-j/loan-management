"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Gate } from "@/components/Gate";

/**
 * Every /me page: a BORROWER who has accepted the PDPA terms (and changed the first password) and filled in their
 * phone, bank and account number. A borrower who has not is sent to /me/profile, the one page open to them (CR-6).
 */
export default function BorrowerLayout({ children }: { children: ReactNode }) {
  const need = usePathname() === "/me/profile" ? "profile" : "borrower";
  return (
    <Gate need={need}>
      <AppShell>{children}</AppShell>
    </Gate>
  );
}
