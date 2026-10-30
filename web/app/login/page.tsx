"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BrandMark } from "@/components/AppShell";
import { Gate } from "@/components/Gate";
import { Alert, Button, Card, PasswordField, TextField } from "@/components/ui";
import { destinationFor } from "@/lib/access";
import { errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session-store";

export default function LoginPage() {
  return (
    <Gate need="anonymous">
      <LoginForm />
    </Gate>
  );
}

function LoginForm() {
  const router = useRouter();
  const login = useSession((s) => s.login);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (username.trim() === "" || password === "") {
      setError("กรุณากรอกชื่อผู้ใช้และรหัสผ่าน");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      // always the page this user belongs to: there is no "return to" address to abuse
      router.replace(destinationFor(user));
    } catch (err) {
      setPassword("");
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md animate-rise flex-col justify-center gap-6 p-4">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="h-16 w-16 text-3xl" />
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-teal-900">ระบบขอยืมเงิน</h1>
        <p className="mt-1 text-slate-600">เข้าสู่ระบบ</p>
      </div>
      <Card>
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          {error && <Alert kind="error">{error}</Alert>}
          <TextField
            label="ชื่อผู้ใช้"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <PasswordField
            label="รหัสผ่าน"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
          </Button>
          <p className="text-center text-sm text-slate-600">ลืมรหัสผ่าน? กรุณาติดต่อผู้ดูแลระบบเพื่อขอรีเซ็ตรหัสผ่าน</p>
        </form>
      </Card>
    </main>
  );
}
