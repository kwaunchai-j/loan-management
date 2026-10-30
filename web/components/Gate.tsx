"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { resolveAccess, type Need } from "@/lib/access";
import { useSession } from "@/lib/session-store";
import { Button, Spinner } from "./ui";

/**
 * Wraps a page: shows it only to the kind of user it is for, otherwise sends them where they belong
 * (see lib/access.ts). Nothing of the page is rendered meanwhile. This is about what the PAGES show;
 * the API enforces the real access rules.
 */
export function Gate({ need, children }: { need: Need; children: ReactNode }) {
  const router = useRouter();
  const { status, user, load } = useSession();

  // learn who we are the first time any page is opened
  useEffect(() => {
    if (status === "loading") void load();
  }, [status, load]);

  const access = status === "anonymous" || status === "authenticated" ? resolveAccess(user, need) : null;
  const redirect = access && !access.allowed ? access.redirect : null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (status === "loading") return <Spinner />;
  if (status === "error") {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <p className="text-slate-800">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่</p>
        <Button onClick={() => void load()}>ลองใหม่</Button>
      </div>
    );
  }
  if (!access || !access.allowed) return <Spinner label="กำลังพาไปหน้าที่ถูกต้อง..." />;
  return <>{children}</>;
}
