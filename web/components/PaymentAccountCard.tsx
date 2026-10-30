"use client";

import { useState, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { adminPaymentAccountSchema, type AdminPaymentAccount } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { checkAccountName, checkBankName, checkPaymentAccountNo } from "@/lib/validation";
import { Alert, Button, Card, Spinner, TextField } from "./ui";

type Parts = { bankName: string; accountName: string; accountNo: string };

/**
 * The lender's own bank account that borrowers are shown (the "ดูบัญชีที่ต้องโอนเงิน" dialog). One account for the
 * whole system. Changing an account that is already in use needs a second, deliberate click, because borrowers
 * transfer real money to whatever is shown here; removing it too.
 */
export function PaymentAccountCard() {
  const r = useApi("/admin/payment-account", adminPaymentAccountSchema);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <Card title="บัญชีรับโอนของผู้ให้กู้">
      <p className="mb-3 text-sm text-slate-700">บัญชีนี้จะแสดงให้ผู้ยืมเห็นในหน้าขอยืมและหน้าแจ้งชำระ เพื่อให้รู้ว่าต้องโอนเงินคืนที่ไหน</p>
      {r.loading && <Spinner />}
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {saved && (
        <div className="mb-3">
          <Alert kind="success">{saved}</Alert>
        </div>
      )}
      {r.data && (
        <AccountForm
          key={r.data.updatedAt ?? "unset"}
          current={r.data}
          onSubmitting={() => setSaved(null)}
          onSaved={(text) => {
            setSaved(text);
            r.reload();
          }}
        />
      )}
    </Card>
  );
}

function AccountForm({ current, onSaved, onSubmitting }: { current: AdminPaymentAccount; onSaved: (text: string) => void; onSubmitting: () => void }) {
  const isSet = current.bankName !== null && current.accountName !== null && current.accountNo !== null;
  const [parts, setParts] = useState<Parts>({ bankName: current.bankName ?? "", accountName: current.accountName ?? "", accountNo: current.accountNo ?? "" });
  const [errors, setErrors] = useState<Partial<Parts>>({});
  const [pending, setPending] = useState<"replace" | "remove" | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Parts>) => setParts((p) => ({ ...p, ...patch }));

  const trimmed = { bankName: parts.bankName.trim(), accountName: parts.accountName.trim(), accountNo: parts.accountNo.trim() };
  const allBlank = trimmed.bankName === "" && trimmed.accountName === "" && trimmed.accountNo === "";
  const unchanged = isSet
    ? trimmed.bankName === current.bankName && trimmed.accountName === current.accountName && trimmed.accountNo === current.accountNo
    : allBlank;

  async function save(body: { bankName: string | null; accountName: string | null; accountNo: string | null }, doneText: string) {
    setBusy(true);
    setMessage(null);
    onSubmitting();
    try {
      await apiFetch("/admin/payment-account", { method: "PUT", json: body, schema: adminPaymentAccountSchema });
      setPending(null);
      onSaved(doneText);
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (unchanged) {
      setErrors({});
      setMessage({ kind: "info", text: "ไม่มีการเปลี่ยนแปลง" });
      return;
    }
    if (allBlank) {
      // every box emptied on purpose: that removes the account (after a confirm)
      setErrors({});
      setPending("remove");
      return;
    }
    const found: Partial<Parts> = {
      bankName: checkBankName(parts.bankName) ?? undefined,
      accountName: checkAccountName(parts.accountName) ?? undefined,
      accountNo: checkPaymentAccountNo(parts.accountNo) ?? undefined,
    };
    setErrors(found);
    if (found.bankName || found.accountName || found.accountNo) return;
    if (isSet) setPending("replace");
    else void save(trimmed, "บันทึกบัญชีรับโอนแล้ว ผู้ยืมจะเห็นบัญชีนี้ทันที");
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {!isSet && (
        <Alert kind="warning">ยังไม่ได้ตั้งบัญชีรับโอน ผู้ยืมจะเห็นข้อความให้ติดต่อผู้ให้กู้แทน</Alert>
      )}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <TextField label="ธนาคาร" autoComplete="off" value={parts.bankName} error={errors.bankName} onChange={(e) => set({ bankName: e.target.value })} />
      <TextField label="ชื่อบัญชี" autoComplete="off" value={parts.accountName} error={errors.accountName} onChange={(e) => set({ accountName: e.target.value })} />
      <TextField
        label="เลขบัญชี"
        inputMode="numeric"
        autoComplete="off"
        value={parts.accountNo}
        error={errors.accountNo}
        hint="ตัวเลข 5–30 หลัก ใส่ขีดหรือเว้นวรรคได้ เช่น 123-4-56789-0"
        onChange={(e) => set({ accountNo: e.target.value })}
      />
      <p className="text-sm text-slate-600">เว้นว่างทั้งสามช่องแล้วบันทึก เพื่อลบบัญชีที่ตั้งไว้</p>

      {pending ? (
        <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          {pending === "replace" ? (
            <>
              <p className="font-medium text-amber-900">เปลี่ยนบัญชีรับโอน? ผู้ยืมจะโอนเงินไปที่บัญชีใหม่ทันที</p>
              <p className="text-sm text-amber-900">
                จาก {current.bankName} · {current.accountName} · {current.accountNo}
              </p>
              <p className="text-sm text-amber-900">
                เป็น <strong>{trimmed.bankName} · {trimmed.accountName} · {trimmed.accountNo}</strong>
              </p>
            </>
          ) : (
            <p className="font-medium text-amber-900">ลบบัญชีรับโอน? ผู้ยืมจะไม่เห็นบัญชีจนกว่าจะตั้งใหม่</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void (pending === "replace"
                  ? save(trimmed, "เปลี่ยนบัญชีรับโอนแล้ว")
                  : save({ bankName: null, accountName: null, accountNo: null }, "ลบบัญชีรับโอนแล้ว"))
              }
            >
              {busy ? "กำลังบันทึก..." : pending === "replace" ? "ยืนยัน เปลี่ยนบัญชี" : "ยืนยัน ลบบัญชี"}
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setPending(null)}>
              ยกเลิก
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {busy ? "กำลังบันทึก..." : "บันทึกบัญชี"}
        </Button>
      )}

      <p className="text-sm text-slate-600">
        {current.updatedAt && isSet ? `แก้ไขล่าสุด ${formatDateTime(current.updatedAt)} โดย ${current.updatedBy?.username ?? "-"}` : ""}
      </p>
    </form>
  );
}
