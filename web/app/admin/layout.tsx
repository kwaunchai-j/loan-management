"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Gate } from "@/components/Gate";

/** Every /admin page: ADMIN only (and past the first-password step), inside the admin frame and menu. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <Gate need="admin">
      <AppShell wide>{children}</AppShell>
    </Gate>
  );
}
