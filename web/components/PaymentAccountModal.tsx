"use client";

import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api";
import { paymentAccountSchema, type PaymentAccount } from "@/lib/schemas";
import { Modal } from "./Modal";
import { Alert, Button, Icon, Spinner } from "./ui";

/** Why the borrower is looking at the account: the wording of the last line differs. */
export type PaymentAccountContext = "request" | "payment";

const NOTE: Record<PaymentAccountContext, string> = {
  request: "เมื่อผู้ให้กู้อนุมัติและโอนเงินให้แล้ว ถึงกำหนดคืนเงินให้โอนมาที่บัญชีนี้ แล้วแจ้งชำระพร้อมแนบสลิปที่หน้าสัญญาของคุณ",
  payment: "โอนเงินมาที่บัญชีนี้ แล้วแนบสลิปด้านล่างเพื่อแจ้งชำระ ยอดค้างจะลดลงเมื่อผู้ให้กู้ตรวจสลิปและกดยืนยัน",
};

/**
 * A button that opens a dialog with the lender's bank account (bank, account name, number) to transfer to.
 * The account is asked from the API each time the dialog opens, so a change the lender made is seen at once.
 * Nothing is requested until the button is pressed.
 */
export function PaymentAccountButton({ context, className = "" }: { context: PaymentAccountContext; className?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; account?: PaymentAccount; error?: string }>({ loading: false });
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  async function show() {
    setOpen(true);
    setCopied(null);
    setState({ loading: true });
    try {
      setState({ loading: false, account: await apiFetch("/me/payment-account", { schema: paymentAccountSchema }) });
    } catch (err) {
      setState({ loading: false, error: errorMessage(err) });
    }
  }

  async function copy(accountNo: string) {
    // banking apps want the digits only: drop the spaces and hyphens used for reading
    const digits = accountNo.replace(/[^0-9]/g, "");
    try {
      await navigator.clipboard.writeText(digits);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  const { account } = state;
  return (
    <>
      <Button variant="secondary" className={className} onClick={() => void show()}>
        <Icon name="receipt" className="h-5 w-5" />
        ดูบัญชีที่ต้องโอนเงิน
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="โอนเงินเข้าบัญชีของผู้ให้กู้">
        {state.loading && <Spinner />}
        {state.error && <Alert kind="error">{state.error}</Alert>}
        {account && !account.configured && <Alert kind="warning">ผู้ให้กู้ยังไม่ได้ตั้งบัญชีรับโอน กรุณาติดต่อผู้ให้กู้เพื่อสอบถามบัญชีที่ต้องโอน</Alert>}
        {account?.configured && (
          <div className="space-y-4">
            <dl className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/60 p-4">
              <div>
                <dt className="text-sm text-slate-700">ธนาคาร</dt>
                <dd className="text-lg font-semibold text-slate-900">{account.bankName}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-700">ชื่อบัญชี</dt>
                <dd className="text-lg font-semibold text-slate-900">{account.accountName}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-700">เลขบัญชี</dt>
                <dd className="break-all text-2xl font-bold tabular-nums tracking-wide text-slate-900">{account.accountNo}</dd>
              </div>
            </dl>
            <Button className="w-full" onClick={() => void copy(account.accountNo!)}>
              <Icon name="document" className="h-5 w-5" />
              คัดลอกเลขบัญชี
            </Button>
            <div aria-live="polite" className="min-h-5 text-center text-sm font-medium">
              {copied === "yes" && <span className="text-emerald-700">คัดลอกเลขบัญชีแล้ว</span>}
              {copied === "failed" && <span className="text-amber-800">คัดลอกอัตโนมัติไม่ได้ กรุณาจดเลขบัญชีด้านบน</span>}
            </div>
            <p className="text-sm text-slate-700">{NOTE[context]}</p>
            <p className="text-xs text-slate-600">ตรวจชื่อบัญชีก่อนโอนทุกครั้ง ถ้าชื่อไม่ตรงกับที่แสดงที่นี่ อย่าโอนและติดต่อผู้ให้กู้</p>
          </div>
        )}
        <div className="mt-4">
          <Button variant="secondary" className="w-full" onClick={() => setOpen(false)}>
            ปิด
          </Button>
        </div>
      </Modal>
    </>
  );
}
