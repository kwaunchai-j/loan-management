"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button, Spinner } from "@/components/ui";
import { destinationFor } from "@/lib/access";
import { useSession } from "@/lib/session-store";

/** "/" has no page of its own: it sends everyone where they belong (login, first password, PDPA, home). */
export default function RootPage() {
  const router = useRouter();
  const { status, user, load } = useSession();

  useEffect(() => {
    if (status === "loading") void load();
  }, [status, load]);

  const target = status === "anonymous" || status === "authenticated" ? destinationFor(user) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (status === "error") {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <p>เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่</p>
        <Button onClick={() => void load()}>ลองใหม่</Button>
      </div>
    );
  }
  return <Spinner />;
}
