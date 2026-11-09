import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminAgreementPage from "@/app/admin/requests/[id]/agreement/page";
import MyAgreementPage from "@/app/me/request/[id]/agreement/page";
import RequestsPage from "@/app/admin/requests/page";
import MyRequestPage from "@/app/me/request/page";
import { agreementSchema } from "@/lib/schemas";
import { apiError, mockApi, valid } from "./mocks";
import { request, requestList } from "./fixtures";
import { renderPage } from "./render";

const agreement = (over: Record<string, unknown> = {}, terms: Record<string, unknown> = {}) =>
  valid(agreementSchema, {
    agreementNo: "AG-2026-000007",
    issuedAt: "2026-10-30T05:00:00.000Z",
    requestId: "r1",
    requestStatus: "PENDING",
    terms: {
      issuedOn: "2026-10-30",
      borrowerName: "สมชาย ใจดี",
      principal: "5000",
      dueDate: "2026-11-29",
      interestRatePctPerMonth: "3.0000",
      lateFeeRatePctPerDay: "0.5000",
      estimate: { days: 30, interestAmount: "150", totalToRepay: "5150" },
      payment: { bankName: "ธนาคารกสิกรไทย", accountName: "นายผู้ให้กู้ ใจดี", accountNo: "123-4-56789-0" },
      ...terms,
    },
    ...over,
  });

afterEach(() => vi.restoreAllMocks());

describe("loan agreement document", () => {
  it("shows the agreement of a request to the admin: number, parties, amount in figures and words, due date, rates, account", async () => {
    const calls = mockApi({ "GET /admin/loan-requests/r1/agreement": { body: agreement() } });
    await renderPage(AdminAgreementPage, "r1");
    const doc = await screen.findByRole("article", { name: "สัญญาเงินกู้" });
    expect(calls[0]!.path).toBe("/admin/loan-requests/r1/agreement");
    expect(doc).toHaveTextContent("AG-2026-000007");
    expect(doc).toHaveTextContent("30 ต.ค. 2569");
    expect(doc).toHaveTextContent("นายผู้ให้กู้ ใจดี");
    expect(doc).toHaveTextContent("สมชาย ใจดี");
    expect(doc).toHaveTextContent("5,000 บาท (ห้าพันบาทถ้วน)");
    expect(doc).toHaveTextContent("29 พ.ย. 2569");
    expect(doc).toHaveTextContent("อัตราร้อยละ 3 ต่อเดือน");
    expect(doc).toHaveTextContent("อัตราร้อยละ 0.5 ต่อวัน");
    expect(doc).toHaveTextContent("ดอกเบี้ยประมาณ 150 บาท รวมที่ต้องชำระ 5,150 บาท");
    expect(doc).toHaveTextContent("123-4-56789-0");
    expect(screen.queryByText(/ไม่มีผลผูกพัน/)).toBeNull();
  });

  it("is also what the borrower opens, from their own endpoint", async () => {
    const calls = mockApi({ "GET /me/loan-requests/r1/agreement": { body: agreement() } });
    await renderPage(MyAgreementPage, "r1");
    expect(await screen.findByRole("article", { name: "สัญญาเงินกู้" })).toHaveTextContent("AG-2026-000007");
    expect(calls[0]!.path).toBe("/me/loan-requests/r1/agreement");
    expect(document.querySelector('a[href="/me/request"]')).not.toBeNull();
  });

  it("still reads as a contract when the lender has set no rate or account yet", async () => {
    mockApi({
      "GET /admin/loan-requests/r1/agreement": {
        body: agreement({}, { interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, estimate: null, payment: null }),
      },
    });
    await renderPage(AdminAgreementPage, "r1");
    const doc = await screen.findByRole("article", { name: "สัญญาเงินกู้" });
    expect(doc).toHaveTextContent("คิดตามอัตราที่ผู้ให้กู้กำหนด");
    expect(doc).toHaveTextContent("ค่าปรับรายวันตามอัตราที่ผู้ให้กู้กำหนด");
    expect(doc).toHaveTextContent("ตามช่องทางที่ผู้ให้กู้แจ้ง");
    expect(doc).not.toHaveTextContent("ตัวอย่างการคำนวณ");
  });

  it.each([
    ["REJECTED", "คำขอนี้ไม่ได้รับอนุมัติ"],
    ["CANCELLED", "คำขอนี้ถูกยกเลิก"],
  ])("says a %s request's agreement binds nobody", async (requestStatus, text) => {
    mockApi({ "GET /admin/loan-requests/r1/agreement": { body: agreement({ requestStatus }) } });
    await renderPage(AdminAgreementPage, "r1");
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });

  it("prints the page from the browser's own print dialog", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    mockApi({ "GET /admin/loan-requests/r1/agreement": { body: agreement() } });
    await renderPage(AdminAgreementPage, "r1");
    await userEvent.setup().click(await screen.findByRole("button", { name: "พิมพ์ / บันทึกเป็น PDF" }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("shows the error when the agreement cannot be opened", async () => {
    mockApi({ "GET /me/loan-requests/nope/agreement": apiError(404, "NOT_FOUND", "ไม่พบรายการ") });
    await renderPage(MyAgreementPage, "nope");
    expect(await screen.findByText("ไม่พบรายการ")).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
  });
});

describe("a way to the agreement from each request", () => {
  it("the admin's inbox links every request to its agreement", async () => {
    mockApi({ "GET /admin/loan-requests": { body: requestList([request(), request({ id: "r2", status: "REJECTED", rejectReason: "x" })]) } });
    render(<RequestsPage />);
    await screen.findAllByText("สัญญาเงินกู้");
    expect(document.querySelector('a[href="/admin/requests/r1/agreement"]')).not.toBeNull();
    expect(document.querySelector('a[href="/admin/requests/r2/agreement"]')).not.toBeNull();
  });

  it("the borrower's list links each of their requests to its agreement", async () => {
    mockApi({
      "GET /me/loan-requests": {
        body: {
          items: [{ id: "r1", amount: "5000", requestedDueDate: "2026-12-01", status: "PENDING", createdAt: "2026-10-29T03:00:00.000Z", decidedAt: null, contract: null }],
        },
      },
    });
    render(<MyRequestPage />);
    const link = await screen.findByRole("link", { name: "ดูสัญญาเงินกู้" });
    expect(link).toHaveAttribute("href", "/me/request/r1/agreement");
  });
});
