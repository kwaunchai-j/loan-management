import { Prisma } from "@prisma/client";
import { formatBaht, formatThaiDate } from "./format.js";
import type { RenderedMessage } from "./types.js";

/**
 * The texts the admin receives (all Thai). Each round is ONE summary message covering every
 * contract that qualifies (DES-013). LINE has a 5,000-character limit and push payloads are tiny,
 * so lists are cut off with "…และอีก N สัญญา" and the push form carries only the headline.
 */
export const LINE_TEXT_LIMIT = 5000;
const MAX_LISTED = 25;
const MAX_NAME = 60;
/** Where a tapped notification leads (the web app's contract list). */
export const CONTRACTS_URL = "/admin/contracts";
export const REQUESTS_URL = "/admin/loan-requests";
/** The queue of slips borrowers have sent (CR-1). */
export const PAYMENTS_URL = "/admin/payments";

export interface DueItem {
  contractNo: string;
  borrowerName: string;
  dueDate: Date;
  daysOverdue: number;
  totalDue: Prisma.Decimal;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const limitLine = (s: string) => clip(s, LINE_TEXT_LIMIT);

export function renderPaymentSubmitted(r: {
  borrowerName: string;
  contractNo: string;
  amount: Prisma.Decimal;
  paidOn: Date;
}): RenderedMessage {
  const name = clip(r.borrowerName, MAX_NAME);
  return {
    line: limitLine(
      `💸 ผู้ยืมส่งสลิปชำระเงิน
ผู้ยืม: ${name}
สัญญา: ${r.contractNo}
ยอดที่แจ้ง: ${formatBaht(r.amount)} บาท
วันที่โอน: ${formatThaiDate(r.paidOn)}
(รอตรวจสอบและยืนยันในระบบ)`,
    ),
    push: {
      title: "ผู้ยืมส่งสลิปชำระเงิน",
      body: `${name} แจ้งชำระ ${formatBaht(r.amount)} บาท`,
      url: PAYMENTS_URL,
    },
  };
}

export function renderNewRequest(r: {
  borrowerName: string;
  amount: Prisma.Decimal;
  requestedDueDate: Date;
}): RenderedMessage {
  const name = clip(r.borrowerName, MAX_NAME);
  return {
    line: limitLine(
      `📥 มีคำขอยืมเงินใหม่\nผู้ยืม: ${name}\nจำนวน: ${formatBaht(r.amount)} บาท\nวันครบกำหนดที่ขอ: ${formatThaiDate(r.requestedDueDate)}`,
    ),
    push: {
      title: "มีคำขอยืมเงินใหม่",
      body: `${name} ขอยืม ${formatBaht(r.amount)} บาท`,
      url: REQUESTS_URL,
    },
  };
}

function total(items: DueItem[]): Prisma.Decimal {
  return items.reduce((sum, i) => sum.plus(i.totalDue), new Prisma.Decimal(0));
}

function list(items: DueItem[], line: (i: DueItem) => string): string {
  const shown = items.slice(0, MAX_LISTED).map((i, n) => `${n + 1}. ${line(i)}`);
  const more = items.length - shown.length;
  return [...shown, ...(more > 0 ? [`…และอีก ${more} สัญญา`] : [])].join("\n");
}

export function renderDueToday(items: DueItem[], today: Date): RenderedMessage {
  const sum = formatBaht(total(items));
  return {
    line: limitLine(
      `⏰ วันนี้ (${formatThaiDate(today)}) ครบกำหนดชำระ ${items.length} สัญญา รวม ${sum} บาท\n` +
        list(items, (i) => `${clip(i.borrowerName, MAX_NAME)} (${i.contractNo}) ${formatBaht(i.totalDue)} บาท`),
    ),
    push: {
      title: `วันนี้ครบกำหนดชำระ ${items.length} สัญญา`,
      body: `รวม ${sum} บาท`,
      url: CONTRACTS_URL,
    },
  };
}

export function renderOverdue(items: DueItem[], today: Date): RenderedMessage {
  const sum = formatBaht(total(items));
  return {
    line: limitLine(
      `⚠️ เลยกำหนดชำระ ${items.length} สัญญา (ณ ${formatThaiDate(today)}) รวม ${sum} บาท\n` +
        list(items, (i) => {
          const status = i.daysOverdue > 0 ? `เลย ${i.daysOverdue} วัน` : "ครบกำหนดวันนี้";
          return `${clip(i.borrowerName, MAX_NAME)} (${i.contractNo}) ${status} ค้าง ${formatBaht(i.totalDue)} บาท`;
        }),
    ),
    push: {
      title: `เลยกำหนดชำระ ${items.length} สัญญา`,
      body: `ค้างรวม ${sum} บาท`,
      url: CONTRACTS_URL,
    },
  };
}

export function renderTest(): RenderedMessage {
  return {
    line: "✅ ทดสอบการแจ้งเตือนจากระบบขอยืมเงิน — ถ้าเห็นข้อความนี้ แสดงว่าช่องทางนี้ใช้งานได้",
    push: { title: "ทดสอบการแจ้งเตือน", body: "ช่องทางนี้ใช้งานได้", url: "/" },
  };
}
