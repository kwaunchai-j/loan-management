"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, Card, PageTitle, Spinner, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { settingsSchema, type Settings } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { checkRate, normalizeRate } from "@/lib/validation";

export default function SettingsPage() {
  const settings = useApi("/admin/settings", settingsSchema);
  // kept here, not in the form: after a save the form is rebuilt from the new values (new key)
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageTitle>ตั้งค่าอัตรา</PageTitle>
      {settings.loading && <Spinner />}
      {settings.error && <Alert kind="error">{settings.error}</Alert>}
      {saved && <Alert kind="success">บันทึกอัตราเรียบร้อยแล้ว</Alert>}
      {settings.data && (
        <SettingsForm
          key={settings.data.updatedAt ?? "unset"}
          current={settings.data}
          onSubmitting={() => setSaved(false)}
          onSaved={() => {
            setSaved(true);
            settings.reload();
          }}
        />
      )}
    </>
  );
}

type Fields = "interestRatePctPerMonth" | "lateFeeRatePctPerDay";

function SettingsForm({ current, onSaved, onSubmitting }: { current: Settings; onSaved: () => void; onSubmitting: () => void }) {
  const [interest, setInterest] = useState(current.interestRatePctPerMonth ?? "");
  const [lateFee, setLateFee] = useState(current.lateFeeRatePctPerDay ?? "");
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [pending, setPending] = useState<Partial<Record<Fields, string>> | null>(null); // waiting for "confirm"
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const bothSet = current.interestRatePctPerMonth !== null && current.lateFeeRatePctPerDay !== null;

  /** What the admin changed (a blank box that was never set means "leave it"). */
  function changes(): Partial<Record<Fields, string>> | null {
    const found: Partial<Record<Fields, string>> = {};
    const found_errors: Partial<Record<Fields, string>> = {};
    const entries: Array<[Fields, string, string | null]> = [
      ["interestRatePctPerMonth", interest, current.interestRatePctPerMonth],
      ["lateFeeRatePctPerDay", lateFee, current.lateFeeRatePctPerDay],
    ];
    for (const [field, value, before] of entries) {
      if (value.trim() === "" && before === null) continue;
      const problem = checkRate(value);
      if (problem) {
        found_errors[field] = problem;
        continue;
      }
      if (before === null || normalizeRate(value) !== normalizeRate(before)) found[field] = normalizeRate(value);
    }
    setErrors(found_errors);
    return Object.keys(found_errors).length > 0 ? null : found;
  }

  async function save(values: Partial<Record<Fields, string>>) {
    setBusy(true);
    setMessage(null);
    onSubmitting();
    try {
      await apiFetch("/admin/settings", { method: "PATCH", json: values, schema: settingsSchema });
      setPending(null);
      onSaved();
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const values = changes();
    if (values === null) return;
    if (Object.keys(values).length === 0) {
      setMessage({ kind: "info", text: "ไม่มีการเปลี่ยนแปลง กรุณากรอกอัตราที่ต้องการ" });
      return;
    }
    // changing a rate that is already in use needs a second, deliberate click
    const replacing = (["interestRatePctPerMonth", "lateFeeRatePctPerDay"] as const).some(
      (f) => values[f] !== undefined && current[f] !== null,
    );
    if (replacing) setPending(values);
    else void save(values);
  }

  return (
    <>
      {!bothSet && (
        <Alert kind="warning">
          <p className="font-medium">ยังไม่ได้ตั้งอัตราให้ครบ</p>
          <p>ระบบจะบันทึกการจ่ายเงินและนำเข้าข้อมูลไม่ได้ จนกว่าจะตั้งอัตราทั้งสองช่อง</p>
        </Alert>
      )}

      <Card>
        <form onSubmit={submit} className="space-y-5" noValidate>
          {message && message.text && <Alert kind={message.kind}>{message.text}</Alert>}
          <TextField
            label="อัตราดอกเบี้ย (% ต่อเดือน)"
            inputMode="decimal"
            autoComplete="off"
            value={interest}
            error={errors.interestRatePctPerMonth}
            hint="ดอกเบี้ยคงที่ (flat) คิดจากเงินต้นเต็มจำนวน ตามจำนวนวันที่ตกลง ÷ 30 วัน"
            onChange={(e) => setInterest(e.target.value)}
          />
          <TextField
            label="อัตราค่าปรับชำระล่าช้า (% ต่อวัน)"
            inputMode="decimal"
            autoComplete="off"
            value={lateFee}
            error={errors.lateFeeRatePctPerDay}
            hint="คิดทุกวันหลังวันครบกำหนด คิดซ้อนจากยอดที่ค้างรวมค่าปรับสะสม และไม่มีเพดาน"
            onChange={(e) => setLateFee(e.target.value)}
          />
          <p className="text-sm text-slate-600">
            อัตราเดียวทั้งระบบ ใส่ทศนิยมได้ไม่เกิน 4 ตำแหน่ง{" "}
            <strong>การเปลี่ยนอัตรามีผลกับสัญญาที่จ่ายเงินหลังจากนี้เท่านั้น</strong> สัญญาเดิมใช้อัตราที่ล็อกไว้ตอนจ่ายเงิน
          </p>

          {pending ? (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="font-medium text-amber-900">ยืนยันการเปลี่ยนอัตรา?</p>
              <ul className="list-inside list-disc text-sm text-amber-900">
                {pending.interestRatePctPerMonth !== undefined && (
                  <li>
                    ดอกเบี้ย: {current.interestRatePctPerMonth ?? "ยังไม่ตั้ง"} → <strong>{pending.interestRatePctPerMonth}</strong> % ต่อเดือน
                  </li>
                )}
                {pending.lateFeeRatePctPerDay !== undefined && (
                  <li>
                    ค่าปรับ: {current.lateFeeRatePctPerDay ?? "ยังไม่ตั้ง"} → <strong>{pending.lateFeeRatePctPerDay}</strong> % ต่อวัน
                  </li>
                )}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => void save(pending)}>
                  {busy ? "กำลังบันทึก..." : "ยืนยัน บันทึก"}
                </Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setPending(null)}>
                  ยกเลิก
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
              {busy ? "กำลังบันทึก..." : "บันทึกอัตรา"}
            </Button>
          )}
        </form>
      </Card>

      <p className="text-sm text-slate-600">
        {current.updatedAt
          ? `แก้ไขล่าสุด ${formatDateTime(current.updatedAt)} โดย ${current.updatedBy?.username ?? "-"}`
          : "ยังไม่เคยตั้งค่า"}
      </p>
    </>
  );
}
