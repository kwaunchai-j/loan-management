"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Gate } from "@/components/Gate";
import { Alert, Button, Card, PasswordField } from "@/components/ui";
import { destinationFor } from "@/lib/access";
import { errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session-store";
import { checkPassword } from "@/lib/validation";

export default function ChangePasswordPage() {
  return (
    <Gate need="change-password">
      <ChangePasswordForm />
    </Gate>
  );
}

/** Shown before anything else to a user whose password was set by someone else (first login, or after a reset). */
function ChangePasswordForm() {
  const router = useRouter();
  const { changePassword, logout } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = {
      current: current === "" ? "กรุณากรอกรหัสผ่านปัจจุบัน" : undefined,
      next: checkPassword(next) ?? (next === current && current !== "" ? "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม" : undefined),
      confirm: confirm !== next ? "รหัสผ่านยืนยันไม่ตรงกัน" : undefined,
    };
    setErrors({ current: found.current ?? undefined, next: found.next ?? undefined, confirm: found.confirm });
    if (found.current || found.next || found.confirm) return;
    setBusy(true);
    setApiError(null);
    try {
      const user = await changePassword(current, next);
      router.replace(destinationFor(user));
    } catch (err) {
      setApiError(errorMessage(err));
      setBusy(false);
    }
  }

  async function leave() {
    await logout();
    router.replace("/login");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-teal-800">ตั้งรหัสผ่านใหม่</h1>
        <p className="mt-1 text-slate-600">เพื่อความปลอดภัย กรุณาตั้งรหัสผ่านของคุณเองก่อนใช้งาน</p>
      </div>
      <Card>
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          {apiError && <Alert kind="error">{apiError}</Alert>}
          <PasswordField
            label="รหัสผ่านปัจจุบัน (ที่ได้รับจากผู้ดูแลระบบ)"
            autoComplete="current-password"
            value={current}
            error={errors.current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <PasswordField
            label="รหัสผ่านใหม่"
            autoComplete="new-password"
            hint="อย่างน้อย 10 ตัวอักษร"
            value={next}
            error={errors.next}
            onChange={(e) => setNext(e.target.value)}
          />
          <PasswordField
            label="ยืนยันรหัสผ่านใหม่"
            autoComplete="new-password"
            value={confirm}
            error={errors.confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "กำลังบันทึก..." : "บันทึกรหัสผ่านใหม่"}
          </Button>
          <button type="button" onClick={() => void leave()} className="block w-full text-center text-sm text-slate-600 underline">
            ออกจากระบบ
          </button>
        </form>
      </Card>
    </main>
  );
}
