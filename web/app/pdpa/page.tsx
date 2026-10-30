"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Gate } from "@/components/Gate";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { PDPA_SECTIONS, PDPA_TITLE } from "@/content/pdpa.th";
import { destinationFor } from "@/lib/access";
import { errorMessage } from "@/lib/api";
import { pdpaStatusSchema } from "@/lib/schemas";
import { useSession } from "@/lib/session-store";
import { useApi } from "@/lib/use-api";

export default function PdpaPage() {
  return (
    <Gate need="pdpa">
      <PdpaConsent />
    </Gate>
  );
}

/** A borrower must accept these terms before any other borrower page (DES-002). */
function PdpaConsent() {
  const router = useRouter();
  const { acceptPdpa, logout } = useSession();
  const status = useApi("/pdpa", pdpaStatusSchema);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (!status.data) return;
    setBusy(true);
    setError(null);
    try {
      // the version shown is the version accepted; if the terms changed meanwhile the API refuses
      const user = await acceptPdpa(status.data.currentVersion);
      router.replace(destinationFor(user));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      status.reload();
    }
  }

  async function leave() {
    await logout();
    router.replace("/login");
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl space-y-4 p-4 py-8">
      <h1 className="text-2xl font-bold text-teal-800">{PDPA_TITLE}</h1>
      <p className="text-slate-700">กรุณาอ่านและยอมรับเงื่อนไขต่อไปนี้ก่อนใช้งานระบบ</p>

      {status.loading && <Spinner />}
      {status.error && <Alert kind="error">{status.error}</Alert>}

      {status.data && (
        <Card>
          <div className="space-y-4">
            {PDPA_SECTIONS.map((s) => (
              <section key={s.heading}>
                <h2 className="font-semibold text-slate-900">{s.heading}</h2>
                <p className="text-slate-700">{s.body}</p>
              </section>
            ))}
          </div>
          <hr className="my-4 border-slate-200" />
          {error && <Alert kind="error">{error}</Alert>}
          <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-base">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1 h-5 w-5 accent-teal-700"
            />
            <span>ข้าพเจ้าได้อ่านและยอมรับเงื่อนไขการเก็บและใช้ข้อมูลส่วนบุคคลข้างต้น</span>
          </label>
          <div className="mt-4 space-y-3">
            <Button className="w-full" disabled={!agreed || busy} onClick={() => void accept()}>
              {busy ? "กำลังบันทึก..." : "ยอมรับและเข้าใช้งาน"}
            </Button>
            <button type="button" onClick={() => void leave()} className="block w-full text-center text-sm text-slate-600 underline">
              ไม่ยอมรับ ออกจากระบบ
            </button>
          </div>
        </Card>
      )}
    </main>
  );
}
