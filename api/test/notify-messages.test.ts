import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { formatBaht, formatThaiDate } from "../src/notifications/format.js";
import {
  CONTRACTS_URL,
  LINE_TEXT_LIMIT,
  renderDueToday,
  renderNewRequest,
  renderOverdue,
  type DueItem,
} from "../src/notifications/messages.js";
import { isAllowedPushEndpoint, isValidSubscriptionKeys } from "../src/notifications/push-endpoint.js";

const D = (v: string) => new Prisma.Decimal(v);
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const item = (n: number, over: Partial<DueItem> = {}): DueItem => ({
  contractNo: `LN-2026-${String(n).padStart(6, "0")}`,
  borrowerName: `ผู้ยืมคนที่ ${n}`,
  dueDate: date("2026-10-29"),
  daysOverdue: 0,
  totalDue: D("1000.5"),
  ...over,
});

describe("formatBaht", () => {
  it("adds thousands separators and always shows 2 decimals, exactly", () => {
    expect(formatBaht(D("0"))).toBe("0");
    expect(formatBaht(D("5"))).toBe("5");
    expect(formatBaht(D("999.5"))).toBe("999.50");
    expect(formatBaht(D("1000"))).toBe("1,000");
    expect(formatBaht(D("1234567.5"))).toBe("1,234,567.50");
    expect(formatBaht(D("999999999999.99"))).toBe("999,999,999,999.99");
    expect(formatBaht(D("1133.34"))).toBe("1,133.34");
  });

  it("rounds only for display at 2 places and keeps the sign", () => {
    expect(formatBaht(D("-1500"))).toBe("-1,500");
  });
});

describe("formatThaiDate", () => {
  it("writes day/month/year in the Buddhist Era", () => {
    expect(formatThaiDate(date("2026-10-29"))).toBe("29/10/2569");
    expect(formatThaiDate(date("2027-01-01"))).toBe("01/01/2570");
  });
});

describe("rendered messages", () => {
  it("new request names the borrower, amount and requested due date", () => {
    const m = renderNewRequest({ borrowerName: "สมชาย ใจดี", amount: D("5000"), requestedDueDate: date("2026-11-15") });
    expect(m.line).toContain("สมชาย ใจดี");
    expect(m.line).toContain("5,000 บาท");
    expect(m.line).toContain("15/11/2569");
    expect(m.push.title).toBe("มีคำขอยืมเงินใหม่");
    expect(m.push.body).toBe("สมชาย ใจดี ขอยืม 5,000 บาท");
  });

  it("due-today is ONE message listing every contract with the total", () => {
    const m = renderDueToday([item(1), item(2, { totalDue: D("2000") }), item(3)], date("2026-10-29"));
    expect(m.line).toContain("ครบกำหนดชำระ 3 สัญญา รวม 4,001 บาท");
    for (const n of [1, 2, 3]) expect(m.line).toContain(`LN-2026-00000${n}`);
    expect(m.line).toContain("2,000 บาท");
    expect(m.push).toMatchObject({ title: "วันนี้ครบกำหนดชำระ 3 สัญญา", body: "รวม 4,001 บาท", url: CONTRACTS_URL });
  });

  it("overdue shows how many days late, and 'due today' for contracts due today", () => {
    const m = renderOverdue([item(1, { daysOverdue: 3, totalDue: D("1133.34") }), item(2, { daysOverdue: 0 })], date("2026-10-29"));
    expect(m.line).toContain("เลย 3 วัน");
    expect(m.line).toContain("ค้าง 1,133.34 บาท");
    expect(m.line).toContain("ครบกำหนดวันนี้");
    expect(m.push.title).toBe("เลยกำหนดชำระ 2 สัญญา");
    expect(m.push.body).toBe("ค้างรวม 2,133.84 บาท");
  });

  it("cuts a long list and says how many were left out", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1));
    const m = renderOverdue(items, date("2026-10-29"));
    expect(m.line).toContain("…และอีก 15 สัญญา");
    expect(m.line).toContain("25. ");
    expect(m.line).not.toContain("26. ");
    // the headline still counts all 40
    expect(m.line).toContain("เลยกำหนดชำระ 40 สัญญา");
  });

  it("never exceeds LINE's text limit, even with very long names", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1, { borrowerName: "ก".repeat(300) }));
    for (const m of [renderOverdue(items, date("2026-10-29")), renderDueToday(items, date("2026-10-29"))]) {
      expect(m.line.length).toBeLessThanOrEqual(LINE_TEXT_LIMIT);
    }
  });

  it("keeps the push payload small", () => {
    const items = Array.from({ length: 500 }, (_, i) => item(i + 1, { borrowerName: "ข".repeat(100) }));
    const bytes = Buffer.byteLength(JSON.stringify(renderOverdue(items, date("2026-10-29")).push));
    expect(bytes).toBeLessThan(500);
  });
});

describe("push endpoint allow-list (SSRF guard)", () => {
  it("accepts the real browser push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGxxxx",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
  });

  it("rejects anything that could make the server call somewhere else", () => {
    for (const bad of [
      "",
      "not a url",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://evil.example.com/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example.com/x",
      "https://evilfcm.googleapis.com.attacker.io/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "ftp://fcm.googleapis.com/x",
      "javascript:alert(1)",
    ]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });

  it("checks the subscription keys' real sizes", () => {
    const p256dh = Buffer.alloc(65, 7).toString("base64url");
    const auth = Buffer.alloc(16, 9).toString("base64url");
    expect(isValidSubscriptionKeys(p256dh, auth)).toBe(true);
    expect(isValidSubscriptionKeys(auth, p256dh)).toBe(false);
    expect(isValidSubscriptionKeys("short", auth)).toBe(false);
    expect(isValidSubscriptionKeys(p256dh, "bad key!")).toBe(false);
  });
});
