import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import NewRequestPage from "@/app/admin/requests/new/page";
import RequestsPage from "@/app/admin/requests/page";
import { apiError, mockApi } from "./mocks";
import { NOW, request, requestList } from "./fixtures";

const someone = {
  id: "b1",
  fullName: "สมชาย ใจดี",
  phone: null,
  bankName: null,
  bankAccountNo: null,
  pdpaAcceptedAt: null,
  pdpaVersion: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  account: { userId: "u9", username: "somchai", isActive: true, mustChangePassword: false },
};

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

describe("request inbox", () => {
  it("opens on the requests waiting for a decision", async () => {
    const calls = mockApi({ "GET /admin/loan-requests": { body: requestList([request()]) } });
    render(<RequestsPage />);
    expect(await screen.findByText("สมชาย ใจดี")).toBeInTheDocument();
    expect(calls[0]!.path).toContain("status=PENDING");
    expect(screen.getByText("5,000 บาท")).toBeInTheDocument();
    expect(screen.getByText(/ขอคืนวันที่ 1 ธ.ค. 2569/)).toBeInTheDocument();
  });

  it("says so when nothing is waiting", async () => {
    mockApi({ "GET /admin/loan-requests": { body: requestList([]) } });
    render(<RequestsPage />);
    expect(await screen.findByText("ไม่มีคำขอที่รอพิจารณา")).toBeInTheDocument();
  });

  it("switches the filter and asks the API for that status (or all)", async () => {
    const calls = mockApi({ "GET /admin/loan-requests": { body: requestList([]) } });
    render(<RequestsPage />);
    await screen.findByText("ไม่มีคำขอที่รอพิจารณา");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("แสดงคำขอ"), "REJECTED");
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("status=REJECTED"));
    await user.selectOptions(screen.getByLabelText("แสดงคำขอ"), "");
    await waitFor(() => expect(calls[calls.length - 1]!.path).not.toContain("status="));
  });

  it("approving needs a confirmation and then creates the contract", async () => {
    let approved = false;
    const calls = mockApi({
      "GET /admin/loan-requests": () => ({ body: requestList(approved ? [] : [request()]) }),
      "POST /admin/loan-requests/r1/approve": () => {
        approved = true;
        return { body: request({ status: "APPROVED", contract: { id: "c9", contractNo: "LN-0009", status: "AWAITING_DISBURSEMENT" } }) };
      },
    });
    render(<RequestsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "อนุมัติ" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // nothing sent before the confirm
    expect(screen.getByText(/อนุมัติ 5,000 บาทให้ สมชาย ใจดี/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ยืนยันอนุมัติ" }));
    expect(await screen.findByText(/อนุมัติแล้ว สร้างสัญญารอจ่ายเงิน/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText("สมชาย ใจดี")).not.toBeInTheDocument());
  });

  it("rejecting needs a reason and sends it", async () => {
    const calls = mockApi({
      "GET /admin/loan-requests": { body: requestList([request()]) },
      "POST /admin/loan-requests/r1/reject": { body: request({ status: "REJECTED", rejectReason: "ยอดสูงเกินไป" }) },
    });
    render(<RequestsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ไม่อนุมัติ" }));
    await user.click(screen.getByRole("button", { name: "ยืนยันไม่อนุมัติ" }));
    expect(await screen.findByText("กรุณาระบุเหตุผลที่ไม่อนุมัติ")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.type(screen.getByLabelText("เหตุผลที่ไม่อนุมัติ"), "  ยอดสูงเกินไป  ");
    await user.click(screen.getByRole("button", { name: "ยืนยันไม่อนุมัติ" }));
    expect(await screen.findByText("บันทึกการไม่อนุมัติแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ reason: "ยอดสูงเกินไป" });
  });

  it("a whitespace-only reason does not count", async () => {
    const calls = mockApi({ "GET /admin/loan-requests": { body: requestList([request()]) } });
    render(<RequestsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ไม่อนุมัติ" }));
    await user.type(screen.getByLabelText("เหตุผลที่ไม่อนุมัติ"), "   ");
    await user.click(screen.getByRole("button", { name: "ยืนยันไม่อนุมัติ" }));
    expect(await screen.findByText("กรุณาระบุเหตุผลที่ไม่อนุมัติ")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("cancelling a request also needs a confirmation", async () => {
    const calls = mockApi({
      "GET /admin/loan-requests": { body: requestList([request()]) },
      "POST /admin/loan-requests/r1/cancel": { body: request({ status: "CANCELLED" }) },
    });
    render(<RequestsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ยกเลิกคำขอ" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "ยืนยันยกเลิก" }));
    expect(await screen.findByText("ยกเลิกคำขอแล้ว")).toBeInTheDocument();
  });

  it("backing out of a decision sends nothing", async () => {
    const calls = mockApi({ "GET /admin/loan-requests": { body: requestList([request()]) } });
    render(<RequestsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "อนุมัติ" }));
    await user.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "อนุมัติ" })).toBeInTheDocument();
  });

  it("shows the API's refusal when the request is no longer pending", async () => {
    mockApi({
      "GET /admin/loan-requests": { body: requestList([request()]) },
      "POST /admin/loan-requests/r1/approve": apiError(409, "INVALID_STATE", "ทำรายการนี้ไม่ได้ เพราะคำขอไม่อยู่ในสถานะที่ถูกต้อง"),
    });
    render(<RequestsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "อนุมัติ" }));
    await user.click(screen.getByRole("button", { name: "ยืนยันอนุมัติ" }));
    expect(await screen.findByText(/คำขอไม่อยู่ในสถานะที่ถูกต้อง/)).toBeInTheDocument();
  });

  it("decided requests have no decision buttons, but show the reason and the contract link", async () => {
    mockApi({
      "GET /admin/loan-requests": {
        body: requestList([
          request({ id: "r2", status: "REJECTED", rejectReason: "ยอดสูงเกินไป" }),
          request({ id: "r3", status: "APPROVED", contract: { id: "c9", contractNo: "LN-0009", status: "ACTIVE" } }),
        ]),
      },
    });
    render(<RequestsPage />);
    expect(await screen.findByText("เหตุผล: ยอดสูงเกินไป")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "อนุมัติ" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/admin/contracts/c9"]')).not.toBeNull();
  });

  it("pages through the inbox 20 at a time", async () => {
    const items = Array.from({ length: 20 }, (_, i) => request({ id: `r${i}` }));
    const calls = mockApi({ "GET /admin/loan-requests": { body: requestList(items, 45) } });
    render(<RequestsPage />);
    await screen.findAllByText("สมชาย ใจดี");
    expect(screen.getByText(/แสดง 1–20 จาก 45 รายการ/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "ถัดไป" }));
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("offset=20"));
  });
});

describe("create a request for a borrower", () => {
  async function pick() {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("ค้นหาผู้ยืมตามชื่อ"), "สมชาย");
    await user.click(await screen.findByRole("button", { name: "สมชาย ใจดี" }));
    return user;
  }
  const borrowers = { "GET /admin/borrowers": { body: { total: 1, items: [someone] } } };

  it("needs a borrower, an amount and a future due date", async () => {
    pinToday();
    const calls = mockApi(borrowers);
    render(<NewRequestPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "สร้างคำขอ" }));
    expect(await screen.findByText("กรุณาเลือกผู้ยืม")).toBeInTheDocument();
    expect(screen.getByText("กรุณากรอกจำนวนเงิน")).toBeInTheDocument();
    expect(screen.getByText("กรุณาเลือกวันครบกำหนด")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates the request for the chosen borrower", async () => {
    pinToday();
    const calls = mockApi({ ...borrowers, "POST /admin/loan-requests": { status: 201, body: request() } });
    render(<NewRequestPage />);
    const user = await pick();
    await user.type(screen.getByLabelText("จำนวนเงิน (บาท)"), "5000");
    await user.type(screen.getByLabelText("วันครบกำหนดที่ผู้ยืมเลือก"), "2026-12-01");
    await user.click(screen.getByRole("button", { name: "สร้างคำขอ" }));
    expect(await screen.findByText("สร้างคำขอแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ borrowerId: "b1", amount: "5000", requestedDueDate: "2026-12-01" });
    expect(calls.some((c) => c.path.includes("/approve"))).toBe(false); // not approved unless asked
  });

  it("can approve straight away", async () => {
    pinToday();
    const calls = mockApi({
      ...borrowers,
      "POST /admin/loan-requests": { status: 201, body: request() },
      "POST /admin/loan-requests/r1/approve": { body: request({ status: "APPROVED", contract: { id: "c9", contractNo: "LN-0009", status: "AWAITING_DISBURSEMENT" } }) },
    });
    render(<NewRequestPage />);
    const user = await pick();
    await user.type(screen.getByLabelText("จำนวนเงิน (บาท)"), "5000");
    await user.type(screen.getByLabelText("วันครบกำหนดที่ผู้ยืมเลือก"), "2026-12-01");
    await user.click(screen.getByLabelText(/อนุมัติทันที/));
    await user.click(screen.getByRole("button", { name: "สร้างคำขอและอนุมัติ" }));
    expect(await screen.findByText(/อนุมัติแล้ว สร้างสัญญา/)).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining(["POST /admin/loan-requests", "POST /admin/loan-requests/r1/approve"]),
    );
    expect(document.querySelector('a[href="/admin/contracts/c9"]')).not.toBeNull();
  });

  it("if approving fails the request still exists and the page says so", async () => {
    pinToday();
    mockApi({
      ...borrowers,
      "POST /admin/loan-requests": { status: 201, body: request() },
      "POST /admin/loan-requests/r1/approve": apiError(500, "INTERNAL", "ระบบขัดข้อง"),
    });
    render(<NewRequestPage />);
    const user = await pick();
    await user.type(screen.getByLabelText("จำนวนเงิน (บาท)"), "5000");
    await user.type(screen.getByLabelText("วันครบกำหนดที่ผู้ยืมเลือก"), "2026-12-01");
    await user.click(screen.getByLabelText(/อนุมัติทันที/));
    await user.click(screen.getByRole("button", { name: "สร้างคำขอและอนุมัติ" }));
    expect(await screen.findByText(/สร้างคำขอแล้ว แต่อนุมัติไม่สำเร็จ: ระบบขัดข้อง/)).toBeInTheDocument();
    expect(screen.getByText(/สร้างคำขอ 5,000 บาทให้ สมชาย ใจดี เรียบร้อยแล้ว/)).toBeInTheDocument();
  });

  it("shows the API's refusal and keeps the form", async () => {
    pinToday();
    mockApi({ ...borrowers, "POST /admin/loan-requests": apiError(404, "BORROWER_NOT_FOUND", "ไม่พบผู้ยืม") });
    render(<NewRequestPage />);
    const user = await pick();
    await user.type(screen.getByLabelText("จำนวนเงิน (บาท)"), "5000");
    await user.type(screen.getByLabelText("วันครบกำหนดที่ผู้ยืมเลือก"), "2026-12-01");
    await user.click(screen.getByRole("button", { name: "สร้างคำขอ" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("ไม่พบผู้ยืม")).toBeInTheDocument();
    expect(screen.getByLabelText("จำนวนเงิน (บาท)")).toHaveValue("5000");
  });

  it("refuses today as the due date", async () => {
    pinToday();
    const calls = mockApi({ ...borrowers, "POST /admin/loan-requests": { status: 201, body: request() } });
    render(<NewRequestPage />);
    const user = await pick();
    await user.type(screen.getByLabelText("จำนวนเงิน (บาท)"), "5000");
    await user.type(screen.getByLabelText("วันครบกำหนดที่ผู้ยืมเลือก"), "2026-10-30");
    await user.click(screen.getByRole("button", { name: "สร้างคำขอ" }));
    expect(await screen.findByText("วันครบกำหนดต้องเป็นวันในอนาคต")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
