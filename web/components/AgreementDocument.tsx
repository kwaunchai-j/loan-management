"use client";

import { Alert, Button } from "@/components/ui";
import { bahtText, formatBaht, formatDay } from "@/lib/money";
import type { Agreement } from "@/lib/schemas";

const VOID_NOTE: Partial<Record<Agreement["requestStatus"], string>> = {
  REJECTED: "คำขอนี้ไม่ได้รับอนุมัติ เอกสารนี้จึงไม่มีผลผูกพัน",
  CANCELLED: "คำขอนี้ถูกยกเลิก เอกสารนี้จึงไม่มีผลผูกพัน",
};

/** "3.0000" -> "3", "0.5000" -> "0.5": a rate as a person would write it. */
const rate = (r: string) => r.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/**
 * The loan agreement (สัญญาเงินกู้) generated with a loan request. Shows exactly the figures the API froze when
 * it was issued; nothing is recomputed here. It prints cleanly (the page header is hidden by `print:`), so
 * "พิมพ์ / บันทึกเป็น PDF" in the browser produces the paper copy.
 */
export function AgreementDocument({ agreement }: { agreement: Agreement }) {
  const t = agreement.terms;
  const note = VOID_NOTE[agreement.requestStatus];
  const lender = t.payment?.accountName ?? "ผู้ให้กู้";
  return (
    <>
      {note && <Alert kind="info">{note}</Alert>}
      <div className="flex justify-end print:hidden">
        <Button variant="secondary" onClick={() => window.print()}>
          พิมพ์ / บันทึกเป็น PDF
        </Button>
      </div>

      <article
        aria-label="สัญญาเงินกู้"
        className="mx-auto max-w-3xl space-y-4 rounded-2xl border border-slate-200/80 bg-white p-6 leading-relaxed text-slate-900 shadow-card sm:p-10 print:rounded-none print:border-0 print:p-0 print:shadow-none"
      >
        <header className="space-y-1 text-center">
          <h1 className="text-2xl font-bold">สัญญาเงินกู้</h1>
          <p>
            เลขที่ <span className="font-semibold">{agreement.agreementNo}</span>
          </p>
          <p>วันที่ {formatDay(t.issuedOn)}</p>
        </header>

        <p>
          สัญญานี้ทำขึ้นระหว่าง <strong>{lender}</strong> (ต่อไปนี้เรียกว่า “ผู้ให้กู้”) ฝ่ายหนึ่ง กับ <strong>{t.borrowerName}</strong> (ต่อไปนี้เรียกว่า “ผู้กู้”)
          อีกฝ่ายหนึ่ง โดยทั้งสองฝ่ายตกลงกันดังนี้
        </p>

        <ol className="list-decimal space-y-3 pl-6">
          <li>
            <strong>จำนวนเงินกู้</strong> ผู้กู้ขอกู้ยืมเงินจากผู้ให้กู้เป็นเงินต้นจำนวน <strong>{formatBaht(t.principal)} บาท</strong> ({bahtText(t.principal)})
          </li>
          <li>
            <strong>กำหนดชำระคืน</strong> ผู้กู้จะชำระเงินต้นพร้อมดอกเบี้ยคืนให้แก่ผู้ให้กู้ภายในวันที่ <strong>{formatDay(t.dueDate)}</strong>
          </li>
          <li>
            <strong>ดอกเบี้ย</strong>{" "}
            {t.interestRatePctPerMonth !== null ? (
              <>
                คิดในอัตราร้อยละ <strong>{rate(t.interestRatePctPerMonth)}</strong> ต่อเดือน (คิดจากเงินต้นคงที่ 30 วันเป็น 1 เดือน ปัดเศษขึ้นเป็นจำนวนเต็มบาท)
                นับตั้งแต่วันที่ผู้ให้กู้โอนเงินให้ผู้กู้จริงจนถึงวันครบกำหนด
              </>
            ) : (
              <>คิดตามอัตราที่ผู้ให้กู้กำหนด ณ วันที่โอนเงิน นับตั้งแต่วันที่ผู้ให้กู้โอนเงินให้ผู้กู้จริงจนถึงวันครบกำหนด</>
            )}
            {t.estimate && (
              <span className="mt-2 block rounded-lg bg-slate-50 p-3 text-sm print:border print:border-slate-300">
                ตัวอย่างการคำนวณ: หากผู้ให้กู้โอนเงินในวันที่ {formatDay(t.issuedOn)} ({t.estimate.days} วัน) ดอกเบี้ยประมาณ{" "}
                <strong>{formatBaht(t.estimate.interestAmount)} บาท</strong> รวมที่ต้องชำระ <strong>{formatBaht(t.estimate.totalToRepay)} บาท</strong>{" "}
                ทั้งนี้ดอกเบี้ยจริงจะคิดตามวันที่โอนเงินจริง
              </span>
            )}
          </li>
          <li>
            <strong>ค่าปรับผิดนัด</strong>{" "}
            {t.lateFeeRatePctPerDay !== null ? (
              <>
                หากผู้กู้ชำระไม่ครบภายในวันครบกำหนด ผู้กู้ยอมเสียค่าปรับในอัตราร้อยละ <strong>{rate(t.lateFeeRatePctPerDay)}</strong> ต่อวัน
                นับจากวันถัดจากวันครบกำหนดจนกว่าจะชำระครบถ้วน
              </>
            ) : (
              <>หากผู้กู้ชำระไม่ครบภายในวันครบกำหนด ผู้กู้ยอมเสียค่าปรับรายวันตามอัตราที่ผู้ให้กู้กำหนด นับจากวันถัดจากวันครบกำหนดจนกว่าจะชำระครบถ้วน</>
            )}
          </li>
          <li>
            <strong>การชำระเงินคืน</strong>{" "}
            {t.payment ? (
              <>
                ผู้กู้ชำระเงินโดยโอนเข้าบัญชี {t.payment.bankName} ชื่อบัญชี {t.payment.accountName} เลขที่{" "}
                <span className="font-semibold">{t.payment.accountNo}</span> หรือช่องทางอื่นที่ผู้ให้กู้แจ้ง
              </>
            ) : (
              <>ผู้กู้ชำระเงินตามช่องทางที่ผู้ให้กู้แจ้ง</>
            )}
          </li>
          <li>
            <strong>การมีผลของสัญญา</strong> สัญญานี้มีผลเมื่อผู้ให้กู้อนุมัติและโอนเงินให้ผู้กู้แล้ว
            จำนวนเงินและดอกเบี้ยที่แท้จริงเป็นไปตามที่ระบบบันทึกในสัญญาเงินกู้ที่ออกให้เมื่ออนุมัติ
          </li>
        </ol>

        <p>คู่สัญญาได้อ่านและเข้าใจข้อความในสัญญานี้โดยตลอดแล้ว จึงลงลายมือชื่อไว้เป็นหลักฐาน</p>

        <div className="grid grid-cols-2 gap-8 pt-8 text-center">
          <div>
            <div className="border-b border-slate-400 pb-8" aria-hidden="true" />
            <p className="mt-2">ผู้ให้กู้</p>
            <p className="text-sm text-slate-700">({lender})</p>
          </div>
          <div>
            <div className="border-b border-slate-400 pb-8" aria-hidden="true" />
            <p className="mt-2">ผู้กู้</p>
            <p className="text-sm text-slate-700">({t.borrowerName})</p>
          </div>
        </div>
      </article>
    </>
  );
}
