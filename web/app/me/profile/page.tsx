"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, Item, PageTitle, Spinner, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { profileSchema, type Profile } from "@/lib/schemas";
import { useSession } from "@/lib/session-store";
import { useApi } from "@/lib/use-api";
import { checkBankAccount, checkBankName, checkPhone } from "@/lib/validation";

/**
 * "ข้อมูลของฉัน": the borrower fills in their own phone number, bank and account number (CR-5). The lender creates
 * the account with the name only, and may clear these later (CR-6); until all three are filled in this is the only page
 * the borrower can open, because the lender has to be able to reach them and to know where to send the money.
 * The name is shown but only the lender changes it.
 */
export default function ProfilePage() {
  const router = useRouter();
  const profile = useApi("/me/profile", profileSchema);
  const [saved, setSaved] = useState<string | null>(null);
  const forced = profile.data ? !profile.data.profileComplete : false;
  return (
    <>
      <PageTitle>ข้อมูลของฉัน</PageTitle>
      {profile.loading && <Spinner />}
      {profile.error && <Alert kind="error">{profile.error}</Alert>}
      {saved && <Alert kind="success">{saved}</Alert>}
      {forced && (
        <Alert kind="warning">
          <p className="font-medium">กรุณากรอกเบอร์โทรศัพท์ ธนาคาร และเลขบัญชีของคุณให้ครบก่อน จึงจะใช้งานระบบต่อได้</p>
          <p>ผู้ให้กู้ต้องใช้ข้อมูลนี้เพื่อติดต่อคุณและโอนเงินให้</p>
        </Alert>
      )}
      {profile.data && (
        <>
          <Card title="บัญชีของคุณ">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Item label="ชื่อ-นามสกุล" value={profile.data.fullName} />
              <Item label="ชื่อผู้ใช้" value={profile.data.username ?? "-"} />
            </dl>
            <p className="mt-3 text-sm text-slate-600">ถ้าชื่อไม่ถูกต้อง กรุณาแจ้งผู้ให้กู้ให้แก้ให้</p>
          </Card>
          <Card title="เบอร์โทรศัพท์และบัญชีรับเงิน">
            <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-800">
              {profile.data.profileComplete ? <Badge tone="green">กรอกครบแล้ว</Badge> : <Badge tone="amber">ยังกรอกไม่ครบ</Badge>}
              {profile.data.profileComplete ? (
                <Link href="/me" className="font-medium text-teal-800 underline">
                  ไปหน้าหลัก
                </Link>
              ) : (
                "ต้องกรอกทั้ง 3 ช่องก่อนจึงจะใช้งานระบบต่อได้"
              )}
            </p>
            <ProfileForm
              key={`${profile.data.phone}|${profile.data.bankName}|${profile.data.bankAccountNo}`}
              current={profile.data}
              onSaved={async (text) => {
                setSaved(text);
                profile.reload();
                // the session now says the details are complete: a borrower who was held on this page goes on to the system
                await useSession.getState().load();
                if (forced && useSession.getState().user?.profileComplete === true) router.replace("/me");
              }}
              onSubmitting={() => setSaved(null)}
            />
          </Card>
        </>
      )}
    </>
  );
}

type Fields = "phone" | "bankName" | "bankAccountNo";

function ProfileForm({ current, onSaved, onSubmitting }: { current: Profile; onSaved: (text: string) => void | Promise<void>; onSubmitting: () => void }) {
  const [values, setValues] = useState({ phone: current.phone ?? "", bankName: current.bankName ?? "", bankAccountNo: current.bankAccountNo ?? "" });
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: Fields) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const found: Partial<Record<Fields, string>> = {
      phone: checkPhone(values.phone) ?? undefined,
      bankName: checkBankName(values.bankName) ?? undefined,
      bankAccountNo: checkBankAccount(values.bankAccountNo) ?? undefined,
    };
    setErrors(found);
    if (found.phone || found.bankName || found.bankAccountNo) return;
    // only what changed is sent
    const send: Partial<Record<Fields, string>> = {};
    for (const k of ["phone", "bankName", "bankAccountNo"] as const) {
      const v = values[k].trim();
      if (v !== (current[k] ?? "")) send[k] = v;
    }
    if (Object.keys(send).length === 0) {
      setApiError("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    setBusy(true);
    onSubmitting();
    try {
      await apiFetch("/me/profile", { method: "PATCH", json: send, schema: profileSchema });
      await onSaved("บันทึกข้อมูลของคุณแล้ว");
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {apiError && <Alert kind="error">{apiError}</Alert>}
      <TextField label="เบอร์โทรศัพท์" type="tel" inputMode="tel" autoComplete="tel" value={values.phone} error={errors.phone} hint="ที่ผู้ให้กู้ติดต่อคุณได้" onChange={set("phone")} />
      <TextField label="ธนาคารที่รับเงิน" autoComplete="off" value={values.bankName} error={errors.bankName} hint="ธนาคารของบัญชีที่ต้องการให้ผู้ให้กู้โอนเงินเข้า" onChange={set("bankName")} />
      <TextField label="เลขบัญชี" inputMode="numeric" autoComplete="off" value={values.bankAccountNo} error={errors.bankAccountNo} hint="ตัวเลขและขีด (-) เท่านั้น ตรวจให้ถูกต้อง เพราะเป็นบัญชีที่รับเงินกู้" onChange={set("bankAccountNo")} />
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
        {busy ? "กำลังบันทึก..." : "บันทึกข้อมูล"}
      </Button>
    </form>
  );
}
