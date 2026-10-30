import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MyContractsPage from "@/app/me/contracts/page";
import MyContractDetailPage from "@/app/me/contracts/[id]/page";
import BorrowerHomePage from "@/app/me/page";
import RequestPage from "@/app/me/request/page";
import { useSession } from "@/lib/session-store";
import { apiError, borrowerUser, mockApi } from "./mocks";
import { NOW, portalAwaiting, portalDetail, portalItem, portalList } from "./fixtures";
import { renderPage } from "./render";

const myRequest = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  amount: "5000.00",
  requestedDueDate: "2026-12-01",
  status: "PENDING",
  createdAt: "2026-10-29T03:00:00.000Z",
  decidedAt: null,
  contract: null,
  ...over,
});

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

describe("borrower home", () => {
  it("shows what is owed today on an active contract, with the due date", async () => {
    useSession.setState({ status: "authenticated", user: borrowerUser });
    mockApi({
      "GET /me/contracts": { body: portalList([portalItem({ totalDue: "1020.00" })]) },
      "GET /me/loan-requests": { body: { items: [] } },
    });
    render(<BorrowerHomePage />);
    expect(await screen.findByText("1,020 บาท")).toBeInTheDocument();
    expect(screen.getByText(/ครบกำหนด 30 พ.ย. 2569/)).toBeInTheDocument();
    expect(screen.queryByText(/รวมค่าปรับสะสม/)).not.toBeInTheDocument(); // no late fee yet: nothing to warn about
  });

  it("shows an overdue contract with the days overdue and the accrued late fee", async () => {
    mockApi({
      "GET /me/contracts": {
        body: portalList([portalItem({ isOverdue: true, daysOverdue: 3, accruedLateFee: "45.50", totalDue: "1065.50" })]),
      },
      "GET /me/loan-requests": { body: { items: [] } },
    });
    render(<BorrowerHomePage />);
    expect(await screen.findByText("เลยกำหนด 3 วัน")).toBeInTheDocument();
    expect(screen.getByText(/รวมค่าปรับสะสม 45.50 บาท/)).toBeInTheDocument();
    expect(screen.getByText("1,065.50 บาท")).toBeInTheDocument();
  });

  it("a contract waiting for the payout shows NO amount owed", async () => {
    mockApi({
      "GET /me/contracts": { body: portalList([portalAwaiting()]) },
      "GET /me/loan-requests": { body: { items: [] } },
    });
    render(<BorrowerHomePage />);
    expect(await screen.findByText("รอจ่ายเงิน")).toBeInTheDocument();
    expect(screen.getByText(/ยอดที่ต้องชำระจะแสดงหลังได้รับเงินแล้ว/)).toBeInTheDocument();
    expect(screen.queryByText(/ยอดที่ต้องชำระวันนี้/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ค่าปรับ/)).not.toBeInTheDocument();
  });

  it("tells the borrower about requests still waiting, and offers a new request", async () => {
    mockApi({
      "GET /me/contracts": { body: portalList([]) },
      "GET /me/loan-requests": { body: { items: [myRequest(), myRequest({ id: "r2" })] } },
    });
    render(<BorrowerHomePage />);
    expect(await screen.findByText(/คุณมีคำขอที่รอพิจารณา 2 รายการ/)).toBeInTheDocument();
    expect(screen.getByText("ตอนนี้ไม่มีสัญญาที่ต้องชำระ")).toBeInTheDocument();
    expect(document.querySelector('a[href="/me/request"]')).not.toBeNull();
  });

  it("does not list closed or cancelled contracts as things to pay", async () => {
    mockApi({
      "GET /me/contracts": {
        body: portalList([portalItem({ status: "CLOSED", totalDue: "0.00", closedOn: "2026-11-01" }), portalAwaiting({ status: "CANCELLED" })]),
      },
      "GET /me/loan-requests": { body: { items: [] } },
    });
    render(<BorrowerHomePage />);
    expect(await screen.findByText("ตอนนี้ไม่มีสัญญาที่ต้องชำระ")).toBeInTheDocument();
  });

  it("shows the API's message when the data cannot be loaded", async () => {
    mockApi({
      "GET /me/contracts": apiError(500, "INTERNAL", "ระบบขัดข้อง"),
      "GET /me/loan-requests": { body: { items: [] } },
    });
    render(<BorrowerHomePage />);
    expect(await screen.findByText("ระบบขัดข้อง")).toBeInTheDocument();
  });
});

describe("request page", () => {
  const fill = async (amount: string, due: string) => {
    const user = userEvent.setup();
    if (amount) await user.type(screen.getByLabelText(/จำนวนเงินที่ต้องการยืม/), amount);
    if (due) await user.type(screen.getByLabelText("วันที่จะคืนเงิน"), due);
    await user.click(screen.getByRole("button", { name: "ส่งคำขอ" }));
    return user;
  };

  it("sends only the amount and the due date, as text", async () => {
    pinToday();
    let sent = false;
    const calls = mockApi({
      "GET /me/loan-requests": () => ({ body: { items: sent ? [myRequest()] : [] } }),
      "POST /loan-requests": () => {
        sent = true;
        return {
          status: 201,
          body: {
            id: "r1",
            borrower: { id: "b1", fullName: "x" },
            amount: "5000.50",
            requestedDueDate: "2026-12-01",
            status: "PENDING",
            createdById: "u2",
            decidedById: null,
            decidedAt: null,
            rejectReason: null,
            createdAt: "2026-10-30T05:00:00.000Z",
            contract: null,
          },
        };
      },
    });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await fill("5000.50", "2026-12-01");
    expect(await screen.findByText(/ส่งคำขอเรียบร้อยแล้ว/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ amount: "5000.50", requestedDueDate: "2026-12-01" });
    expect(await screen.findByText("5,000 บาท")).toBeInTheDocument(); // the list reloaded
    expect(screen.getByLabelText(/จำนวนเงินที่ต้องการยืม/)).toHaveValue(""); // the form is clear again
  });

  it("refuses a missing, zero or over-precise amount without calling the API", async () => {
    pinToday();
    const calls = mockApi({ "GET /me/loan-requests": { body: { items: [] } } });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await fill("0", "2026-12-01");
    expect(await screen.findByText(/ต้องมากกว่า 0/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses a due date that is not in the future", async () => {
    pinToday();
    const calls = mockApi({ "GET /me/loan-requests": { body: { items: [] } } });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await fill("1000", "2026-10-30"); // today
    expect(await screen.findByText("วันครบกำหนดต้องเป็นวันในอนาคต")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("asks for both fields", async () => {
    pinToday();
    mockApi({ "GET /me/loan-requests": { body: { items: [] } } });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await fill("", "");
    expect(await screen.findByText("กรุณากรอกจำนวนเงิน")).toBeInTheDocument();
    expect(screen.getByText("กรุณาเลือกวันครบกำหนด")).toBeInTheDocument();
  });

  it("shows the API's refusal in Thai and keeps what was typed", async () => {
    pinToday();
    mockApi({
      "GET /me/loan-requests": { body: { items: [] } },
      "POST /loan-requests": apiError(400, "DUE_DATE_NOT_FUTURE", "วันครบกำหนดต้องเป็นวันในอนาคต"),
    });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await fill("1000", "2026-12-01");
    expect(await screen.findByText("วันครบกำหนดต้องเป็นวันในอนาคต")).toBeInTheDocument();
    expect(screen.getByLabelText(/จำนวนเงินที่ต้องการยืม/)).toHaveValue("1000");
  });

  it("lists my requests with their status in words, and the contract number once approved", async () => {
    mockApi({
      "GET /me/loan-requests": {
        body: {
          items: [
            myRequest({ id: "a", status: "APPROVED", contract: { id: "c1", contractNo: "LN-0001", status: "AWAITING_DISBURSEMENT" } }),
            myRequest({ id: "b", status: "REJECTED" }),
            myRequest({ id: "c", status: "CANCELLED" }),
            myRequest({ id: "d", status: "PENDING" }),
          ],
        },
      },
    });
    render(<RequestPage />);
    expect(await screen.findByText("อนุมัติแล้ว")).toBeInTheDocument();
    expect(screen.getByText("ไม่อนุมัติ")).toBeInTheDocument();
    expect(screen.getByText("ยกเลิกแล้ว")).toBeInTheDocument();
    expect(screen.getByText("รอพิจารณา")).toBeInTheDocument();
    expect(screen.getByText("สัญญาเลขที่ LN-0001")).toBeInTheDocument();
    // only the pending one can be withdrawn
    expect(screen.getAllByRole("button", { name: "ยกเลิกคำขอ" })).toHaveLength(1);
  });

  it("cancelling a pending request needs a second click", async () => {
    let cancelled = false;
    const calls = mockApi({
      "GET /me/loan-requests": () => ({ body: { items: [myRequest({ status: cancelled ? "CANCELLED" : "PENDING" })] } }),
      "POST /loan-requests/r1/cancel": () => {
        cancelled = true;
        return {
          body: {
            id: "r1",
            borrower: { id: "b1", fullName: "x" },
            amount: "5000.00",
            requestedDueDate: "2026-12-01",
            status: "CANCELLED",
            createdById: "u2",
            decidedById: null,
            decidedAt: null,
            rejectReason: null,
            createdAt: "2026-10-29T03:00:00.000Z",
            contract: null,
          },
        };
      },
    });
    render(<RequestPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ยกเลิกคำขอ" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "ยืนยันยกเลิก" }));
    expect(await screen.findByText("ยกเลิกคำขอแล้ว", { selector: "[role=status] div" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "ยกเลิกคำขอ" })).not.toBeInTheDocument());
  });

  it("backing out of the cancellation sends nothing", async () => {
    const calls = mockApi({ "GET /me/loan-requests": { body: { items: [myRequest()] } } });
    render(<RequestPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ยกเลิกคำขอ" }));
    await user.click(screen.getByRole("button", { name: "ไม่ยกเลิก" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("my contracts", () => {
  it("lists every contract", async () => {
    mockApi({
      "GET /me/contracts": {
        body: portalList([portalItem(), portalAwaiting(), portalItem({ id: "c3", contractNo: "LN-0003", status: "CLOSED", totalDue: "0.00", closedOn: "2026-11-01" })]),
      },
    });
    render(<MyContractsPage />);
    expect(await screen.findByText("สัญญา LN-0001")).toBeInTheDocument();
    expect(screen.getByText("สัญญา LN-0002")).toBeInTheDocument();
    expect(screen.getByText(/ชำระครบเมื่อ 1 พ.ย. 2569/)).toBeInTheDocument();
  });

  it("explains an empty list", async () => {
    mockApi({ "GET /me/contracts": { body: portalList([]) } });
    render(<MyContractsPage />);
    expect(await screen.findByText(/ยังไม่มีสัญญา/)).toBeInTheDocument();
  });
});

describe("my contract detail", () => {
  it("shows the breakdown, the amount owed and the payment history", async () => {
    mockApi({
      "GET /me/contracts/c1": {
        body: portalDetail({
          contract: portalItem({ totalDue: "700.00", outstandingPrincipal: "700.00", outstandingInterest: "0.00" }),
          payments: [
            { id: "p1", amount: "300.00", paidOn: "2026-10-25", allocatedLateFee: "50.00", allocatedInterest: "20.00", allocatedPrincipal: "230.00" },
          ],
        }),
      },
    });
    await renderPage(MyContractDetailPage, "c1");
    expect(await screen.findByText("700 บาท", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("เงินต้นคงเหลือ")).toBeInTheDocument();
    expect(screen.getByText(/25 ต.ค. 2569 · 300 บาท/)).toBeInTheDocument();
    expect(screen.getByText(/ตัดเป็น: ค่าปรับ 50 · ดอกเบี้ย 20 · เงินต้น 230/)).toBeInTheDocument();
  });

  it("a contract waiting for the payout shows no amount owed, no interest and no history", async () => {
    mockApi({ "GET /me/contracts/c2": { body: portalDetail({ contract: portalAwaiting(), disbursement: null }) } });
    await renderPage(MyContractDetailPage, "c2");
    expect(await screen.findByText(/รอผู้ให้กู้โอนเงิน/)).toBeInTheDocument();
    expect(screen.queryByText(/ยอดที่ต้องชำระวันนี้/)).not.toBeInTheDocument();
    expect(screen.queryByText("ดอกเบี้ย")).not.toBeInTheDocument();
    expect(screen.queryByText("ประวัติการชำระ")).not.toBeInTheDocument();
    expect(screen.getByText("เงินต้น")).toBeInTheDocument();
  });

  it("shows another borrower's contract as not found (the API answers 404)", async () => {
    mockApi({ "GET /me/contracts/other": apiError(404, "NOT_FOUND", "ไม่พบสัญญา") });
    await renderPage(MyContractDetailPage, "other");
    expect(await screen.findByText("ไม่พบสัญญา")).toBeInTheDocument();
  });

  it("never shows the lender's slips, rates, who recorded a payment, admin notes or import flags", async () => {
    mockApi({ "GET /me/contracts/c1": { body: portalDetail() }, "GET /me/payment-submissions": { body: { items: [] } } });
    await renderPage(MyContractDetailPage, "c1");
    await screen.findByText(/ข้อมูลสัญญา/);
    // the page may talk about the borrower's OWN slip (the "send a slip" form), never the lender's data
    expect(document.body.textContent).not.toMatch(/อัตรา|นำเข้า|ผู้บันทึก/);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('a[href^="/admin"]')).toBeNull();
    expect(document.querySelector('[src*="/admin/slips"]')).toBeNull();
  });

  it("a closed contract says it is fully paid", async () => {
    mockApi({
      "GET /me/contracts/c1": {
        body: portalDetail({ contract: portalItem({ status: "CLOSED", totalDue: "0.00", outstandingPrincipal: "0.00", outstandingInterest: "0.00", closedOn: "2026-11-01" }) }),
      },
    });
    await renderPage(MyContractDetailPage, "c1");
    expect(await screen.findByText("ชำระครบแล้ว", { selector: "h2" })).toBeInTheDocument();
    const card = screen.getByText("ชำระครบแล้ว", { selector: "h2" }).closest("section")!;
    expect(within(card).getByText("0 บาท", { selector: "p" })).toBeInTheDocument();
  });
});
