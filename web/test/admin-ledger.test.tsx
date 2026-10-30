import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AdminContractPage from "@/app/admin/contracts/[id]/page";
import { apiError, mockApi } from "./mocks";
import { adminDetail, awaitingDetail, contractMoney, disbursement, NOW, payment } from "./fixtures";
import { renderPage } from "./render";

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 30 Oct 2026 in Thailand
}

/** an open contract also asks whether the borrower has sent slips nobody has checked yet */
const noClaims = { "GET /admin/payment-submissions": { body: { total: 0, items: [] } } };
const unsetRates = { interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, updatedAt: null, updatedBy: null };
const setRates = { interestRatePctPerMonth: "5", lateFeeRatePctPerDay: "1.5", updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: { id: "u1", username: "boss" } };
const slipFile = (type = "image/png", size = 2048) => new File([new Uint8Array(size)], "slip.png", { type });
const uploaded = { slipFileKey: "k1.png", contentType: "image/png", size: 2048 };
const awaitingParts = () => ({
  contract: {
    status: "AWAITING_DISBURSEMENT",
    disbursedOn: null,
    interestRatePctPerMonth: null,
    lateFeeRatePctPerDay: null,
    interestAmount: null,
    outstandingInterest: "0.00",
    totalDue: null,
  },
  disbursement: null,
});
const setDate = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("contract waiting for the payout", () => {
  const open = async (extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({
      "GET /admin/contracts/c1": { body: awaitingDetail() },
      "GET /admin/settings": { body: setRates },
      "POST /admin/slips": { status: 201, body: uploaded },
      ...extra,
    });
    await renderPage(AdminContractPage, "c1");
    await screen.findByRole("heading", { name: "บันทึกการจ่ายเงินให้ผู้ยืม" });
    return calls;
  };
  const upload = async (user: ReturnType<typeof userEvent.setup>, file = slipFile()) => {
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), file);
    await screen.findByText("✓ อัปโหลดสลิปแล้ว");
  };

  it("shows no amount owed before the payout", async () => {
    await open();
    expect(screen.getByText("ยังไม่แสดง (รอจ่ายเงิน)")).toBeInTheDocument();
    expect(screen.queryByText(/ยอดที่ต้องชำระวันนี้/)).not.toBeInTheDocument();
    expect(screen.queryByText("จ่ายเพื่อลดยอดรวมที่ติด")).not.toBeInTheDocument(); // no payment form yet
  });

  it("warns when the rates are not set (a payout is impossible)", async () => {
    pinToday();
    mockApi({ "GET /admin/contracts/c1": { body: awaitingDetail() }, "GET /admin/settings": { body: unsetRates } });
    await renderPage(AdminContractPage, "c1");
    expect(await screen.findByText(/ยังไม่ได้ตั้งอัตราดอกเบี้ยและค่าปรับ จึงบันทึกการจ่ายเงินไม่ได้/)).toBeInTheDocument();
  });

  it("will not record a payout without a slip", async () => {
    const calls = await open();
    await userEvent.setup().click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" }));
    expect(await screen.findByText("กรุณาแนบสลิปการโอนเงิน")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/disbursement"))).toHaveLength(0);
  });

  it("uploads the slip, then records the payout with its key (the amount is never sent)", async () => {
    const calls = await open({
      "POST /admin/contracts/c1/disbursement": {
        status: 201,
        body: {
          contract: contractMoney({ interestAmount: "20.00", totalDue: "1020.00" }),
          disbursement: { id: "d1", amount: "1000.00", paidOn: "2026-10-30", note: null, slipFileKey: "k1.png" },
        },
      },
    });
    const user = userEvent.setup();
    await upload(user);
    await user.type(screen.getByLabelText(/หมายเหตุ/), "  โอนผ่านแอป  ");
    await user.click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" }));
    expect(await screen.findByText(/บันทึกการจ่ายเงินแล้ว ดอกเบี้ย 20 บาท ยอดที่ต้องชำระ 1,020 บาท/)).toBeInTheDocument();
    const slip = calls.find((c) => c.path === "/admin/slips")!;
    expect(slip.body).toEqual({ file: { type: "image/png", size: 2048 } });
    expect(calls.find((c) => c.path.endsWith("/disbursement"))!.body).toEqual({ paidOn: "2026-10-30", slipFileKey: "k1.png", note: "โอนผ่านแอป" });
  });

  it("refuses a payout date in the future", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await upload(user);
    setDate("วันที่โอนเงิน", "2026-10-31");
    await user.click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" }));
    expect(await screen.findByText("วันที่โอนเงินต้องไม่เป็นวันในอนาคต")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/disbursement"))).toHaveLength(0);
  });

  it("refuses a payout on or after the due date (interest needs at least one day)", async () => {
    pinToday();
    const calls = mockApi({
      "GET /admin/contracts/c1": { body: adminDetail({ ...awaitingParts(), contract: { ...awaitingParts().contract, dueDate: "2026-10-30" } }) },
      "GET /admin/settings": { body: setRates },
      "POST /admin/slips": { status: 201, body: uploaded },
    });
    await renderPage(AdminContractPage, "c1");
    await screen.findByRole("heading", { name: "บันทึกการจ่ายเงินให้ผู้ยืม" });
    const user = userEvent.setup();
    await upload(user);
    await user.click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" })); // paidOn = today = due date
    expect(await screen.findByText("วันครบกำหนดต้องอยู่หลังวันที่โอนเงินอย่างน้อย 1 วัน")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/disbursement"))).toHaveLength(0);
  });

  it("shows the API's refusal (rates not set) and keeps the slip", async () => {
    await open({ "POST /admin/contracts/c1/disbursement": apiError(409, "RATES_NOT_SET", "ยังไม่ได้ตั้งอัตราดอกเบี้ยและอัตราค่าปรับ") });
    const user = userEvent.setup();
    await upload(user);
    await user.click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /ยังไม่ได้ตั้งอัตราดอกเบี้ยและอัตราค่าปรับ/.test(a.textContent ?? ""))).toBe(true);
    expect(screen.getByText("✓ อัปโหลดสลิปแล้ว")).toBeInTheDocument();
  });

  it("does not upload a file that is not a JPEG or PNG", async () => {
    const calls = await open();
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), slipFile("application/pdf"));
    expect(await screen.findByText("รองรับเฉพาะไฟล์รูป JPEG หรือ PNG")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admin/slips")).toBe(false);
  });

  it("does not upload a file over 5 MB", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), slipFile("image/png", 5 * 1024 * 1024 + 1));
    expect(await screen.findByText("ไฟล์ใหญ่เกิน 5 MB")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admin/slips")).toBe(false);
  });

  it("shows the server's message when the upload fails and keeps the payout blocked", async () => {
    const calls = await open({ "POST /admin/slips": apiError(415, "UNSUPPORTED_FILE_TYPE", "รองรับเฉพาะไฟล์รูป JPEG หรือ PNG") });
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), slipFile());
    expect(await screen.findByText("รองรับเฉพาะไฟล์รูป JPEG หรือ PNG")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" }));
    expect(await screen.findByText("กรุณาแนบสลิปการโอนเงิน")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/disbursement"))).toHaveLength(0);
  });

  it("choosing another file clears the previous slip", async () => {
    const calls = await open();
    const user = userEvent.setup({ applyAccept: false });
    await upload(user);
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), slipFile("application/pdf"));
    await user.click(screen.getByRole("button", { name: "บันทึกการจ่ายเงิน" }));
    expect(await screen.findByText("กรุณาแนบสลิปการโอนเงิน")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/disbursement"))).toHaveLength(0);
  });

  it("cancelling the contract needs a confirmation and may carry a reason", async () => {
    const calls = await open({
      "POST /admin/contracts/c1/cancel": { body: { id: "c1", contractNo: "LN-0001", status: "CANCELLED", principal: "1000.00", dueDate: "2026-11-30", borrowerId: "b1" } },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ยกเลิกสัญญา" }));
    expect(calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(0);
    await user.type(screen.getByLabelText(/เหตุผล/), "ผู้ยืมไม่ต้องการแล้ว");
    await user.click(screen.getByRole("button", { name: "ยืนยันยกเลิกสัญญา LN-0001" }));
    expect(await screen.findByText("ยกเลิกสัญญา LN-0001 แล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith("/cancel"))!.body).toEqual({ reason: "ผู้ยืมไม่ต้องการแล้ว" });
  });

  it("shows the API's refusal when the contract can no longer be cancelled", async () => {
    await open({ "POST /admin/contracts/c1/cancel": apiError(409, "INVALID_STATE", "ทำรายการนี้ไม่ได้ เพราะสัญญาไม่อยู่ในสถานะที่ถูกต้อง") });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ยกเลิกสัญญา" }));
    await user.click(screen.getByRole("button", { name: "ยืนยันยกเลิกสัญญา LN-0001" }));
    expect(await screen.findByText(/สัญญาไม่อยู่ในสถานะที่ถูกต้อง/)).toBeInTheDocument();
  });
});

describe("active contract: payments", () => {
  const active = (over: Parameters<typeof adminDetail>[0] = {}) => adminDetail(over);
  const open = async (detail = active(), extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({ "GET /admin/contracts/c1": { body: detail }, ...noClaims, ...extra });
    await renderPage(AdminContractPage, "c1");
    await screen.findByRole("heading", { name: "จ่ายเพื่อลดยอดรวมที่ติด" });
    return calls;
  };
  const payResult = { payment: payment({ id: "p9", amount: "300.00", paidOn: "2026-10-30" }), contract: contractMoney({ totalDue: "720.00" }) };

  it("shows what is owed, how it is made up and the locked rates", async () => {
    await open(active({ contract: { outstandingPrincipal: "800.00", outstandingInterest: "200.00", accruedLateFee: "50.00", totalDue: "1050.00" } }));
    expect(screen.getByText("1,050 บาท", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("800 บาท")).toBeInTheDocument();
    expect(screen.getByText("50 บาท")).toBeInTheDocument();
    expect(screen.getByText(/ดอกเบี้ย 5.0000% ต่อเดือน · ค่าปรับ 1.5000% ต่อวัน/)).toBeInTheDocument();
  });

  it("uses the owner's wording: จ่ายเพื่อลดยอดรวมที่ติด", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "จ่ายเพื่อลดยอดรวมที่ติด" })).toBeInTheDocument();
  });

  it("the full-payment button fills in what is owed today, as text", async () => {
    await open(active({ contract: { totalDue: "1020.05" } }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /ชำระครบ \(1,020.05 บาท\)/ }));
    expect(screen.getByLabelText(/จำนวนเงินที่รับชำระ/)).toHaveValue("1020.05");
  });

  it("offers the full-payment shortcut only for today's date", async () => {
    await open();
    setDate("วันที่ชำระ", "2026-10-25");
    await waitFor(() => expect(screen.queryByRole("button", { name: /ชำระครบ/ })).not.toBeInTheDocument());
    setDate("วันที่ชำระ", "2026-10-30");
    expect(await screen.findByRole("button", { name: /ชำระครบ/ })).toBeInTheDocument();
  });

  it("records a payment and tells how it was settled (late fee, interest, principal)", async () => {
    const calls = await open(active(), { "POST /admin/contracts/c1/payments": { status: 201, body: payResult } });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/จำนวนเงินที่รับชำระ/), "300");
    await user.type(screen.getByLabelText(/หมายเหตุ/), "โอนเข้าบัญชี");
    await user.click(screen.getByRole("button", { name: "บันทึกรับชำระ" }));
    expect(await screen.findByText(/บันทึกรับชำระ 300 บาทแล้ว ตัดเป็น ค่าปรับ 50 · ดอกเบี้ย 200 · เงินต้น 50 · ยอดที่ต้องชำระคงเหลือ 720 บาท/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ amount: "300", paidOn: "2026-10-30", note: "โอนเข้าบัญชี" });
    expect(screen.getByLabelText(/จำนวนเงินที่รับชำระ/)).toHaveValue("");
  });

  it("says the contract is closed when the last payment settles it", async () => {
    await open(active(), {
      "POST /admin/contracts/c1/payments": {
        status: 201,
        body: { payment: payment({ amount: "1020.00", allocatedLateFee: "0.00", allocatedInterest: "20.00", allocatedPrincipal: "1000.00" }), contract: contractMoney({ status: "CLOSED", totalDue: "0.00", closedOn: "2026-10-30" }) },
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /ชำระครบ/ }));
    await user.click(screen.getByRole("button", { name: "บันทึกรับชำระ" }));
    expect(await screen.findByText(/ชำระครบ ปิดสัญญาแล้ว/)).toBeInTheDocument();
  });

  it("refuses an invalid amount or date before calling the API", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/จำนวนเงินที่รับชำระ/), "0");
    await user.click(screen.getByRole("button", { name: "บันทึกรับชำระ" }));
    expect(await screen.findByText(/ต้องมากกว่า 0/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/จำนวนเงินที่รับชำระ/));
    await user.type(screen.getByLabelText(/จำนวนเงินที่รับชำระ/), "100");
    setDate("วันที่ชำระ", "2026-10-31");
    await user.click(screen.getByRole("button", { name: "บันทึกรับชำระ" }));
    expect(await screen.findByText("วันที่ชำระต้องไม่เป็นวันในอนาคต")).toBeInTheDocument();
    setDate("วันที่ชำระ", "2026-10-19"); // the payout was on 2026-10-20
    await user.click(screen.getByRole("button", { name: "บันทึกรับชำระ" }));
    expect(await screen.findByText("วันที่ชำระต้องไม่ก่อนวันที่จ่ายเงิน")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows the API's refusal when the payment is more than is owed", async () => {
    await open(active(), { "POST /admin/contracts/c1/payments": apiError(400, "OVERPAYMENT", "จำนวนที่ชำระเกินยอดที่ต้องชำระ (1,020.00 บาท)") });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/จำนวนเงินที่รับชำระ/), "5000");
    await user.click(screen.getByRole("button", { name: "บันทึกรับชำระ" }));
    expect(await screen.findByText(/จำนวนที่ชำระเกินยอดที่ต้องชำระ/)).toBeInTheDocument();
    expect(screen.getByLabelText(/จำนวนเงินที่รับชำระ/)).toHaveValue("5000"); // kept so it can be corrected
  });

  it("a closed contract offers no payment form", async () => {
    pinToday();
    mockApi({ "GET /admin/contracts/c1": { body: adminDetail({ contract: { status: "CLOSED", totalDue: "0.00", closedOn: "2026-10-28", outstandingPrincipal: "0.00", outstandingInterest: "0.00" }, payments: [payment()] }) } });
    await renderPage(AdminContractPage, "c1");
    await screen.findByText("รายการรับชำระ");
    expect(screen.queryByRole("heading", { name: "จ่ายเพื่อลดยอดรวมที่ติด" })).not.toBeInTheDocument();
    expect(screen.getByText("ชำระครบแล้ว")).toBeInTheDocument();
  });

  it("shows overdue days, the daily late-fee table, the imported flag and an inconsistency warning", async () => {
    pinToday();
    mockApi({
      "GET /admin/contracts/c1": {
        body: adminDetail({
          contract: { isOverdue: true, daysOverdue: 2, isImported: true, inconsistent: true, accruedLateFee: "31.50", totalDue: "1051.50" },
          accruals: [
            { date: "2026-10-29", baseAmount: "1020.00", ratePctPerDay: "1.5000", amount: "15.30" },
            { date: "2026-10-30", baseAmount: "1035.30", ratePctPerDay: "1.5000", amount: "15.54" },
          ],
        }),
      },
    });
    await renderPage(AdminContractPage, "c1");
    expect(await screen.findByText("เลยกำหนด 2 วัน")).toBeInTheDocument();
    expect(screen.getByText("นำเข้าจากไฟล์")).toBeInTheDocument();
    expect(screen.getByText(/ไม่สอดคล้องกับกฎการคำนวณ/)).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("1,035.30")).toBeInTheDocument();
    expect(within(table).getByText("15.54")).toBeInTheDocument();
  });

  it("shows the API's message when the contract is not found", async () => {
    pinToday();
    mockApi({ "GET /admin/contracts/zzz": apiError(404, "NOT_FOUND", "ไม่พบสัญญา") });
    await renderPage(AdminContractPage, "zzz");
    expect(await screen.findByText("ไม่พบสัญญา")).toBeInTheDocument();
  });
});

describe("editing and deleting recorded payments", () => {
  const withPayment = () => adminDetail({ payments: [payment({ note: "เดิม" })] });
  const open = async (extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({ "GET /admin/contracts/c1": { body: withPayment() }, ...noClaims, ...extra });
    await renderPage(AdminContractPage, "c1");
    await screen.findByText("รายการรับชำระ");
    return calls;
  };
  const list = () => screen.getByText("รายการรับชำระ").closest("section")!;

  it("shows the recorded payments with how each was settled", async () => {
    await open();
    expect(within(list()).getByText(/25 ต.ค. 2569 · 300 บาท/)).toBeInTheDocument();
    expect(within(list()).getByText(/ตัดเป็น: ค่าปรับ 50 · ดอกเบี้ย 200 · เงินต้น 50/)).toBeInTheDocument();
    expect(within(list()).getByText("หมายเหตุ: เดิม")).toBeInTheDocument();
  });

  it("warns what an edit does to the contract, reports and sent notifications, and sends only the change", async () => {
    const calls = await open({ "PATCH /admin/payments/p1": { body: { payment: payment({ amount: "250.00" }), contract: contractMoney() } } });
    const user = userEvent.setup();
    await user.click(within(list()).getByRole("button", { name: "แก้ไข" }));
    expect(screen.getByText(/คำนวณสัญญานี้ใหม่ทั้งสัญญา/)).toBeInTheDocument();
    expect(screen.getByText(/รายงานของช่วงเวลาที่ผ่านมาแล้วจะเปลี่ยนตาม/)).toBeInTheDocument();
    expect(screen.getByText(/การแจ้งเตือนที่ส่งไปแล้วจะไม่ถูกเรียกคืน/)).toBeInTheDocument();
    const amount = within(list()).getByLabelText("จำนวนเงิน (บาท)");
    await user.clear(amount);
    await user.type(amount, "250");
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    expect(await screen.findByText(/แก้ไขรายการรับชำระแล้ว ระบบคำนวณสัญญาใหม่เรียบร้อย/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ amount: "250" });
    // the payment is still on the page, so the edit panel must close by itself (no stuck "saving...")
    expect(screen.queryByRole("button", { name: "ยืนยันแก้ไข" })).not.toBeInTheDocument();
    expect(within(list()).getByRole("button", { name: "แก้ไข" })).toBeEnabled();
  });

  it("an amount typed as 300 or 300.0 is not a change from 300.00", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.click(within(list()).getByRole("button", { name: "แก้ไข" }));
    const amount = within(list()).getByLabelText("จำนวนเงิน (บาท)");
    await user.clear(amount);
    await user.type(amount, "300");
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    expect(await screen.findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("emptying the note sends null (clears it)", async () => {
    const calls = await open({ "PATCH /admin/payments/p1": { body: { payment: payment(), contract: contractMoney() } } });
    const user = userEvent.setup();
    await user.click(within(list()).getByRole("button", { name: "แก้ไข" }));
    await user.clear(within(list()).getByLabelText("หมายเหตุ"));
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ note: null }));
  });

  it("shows the API's refusal when an edit would make the history invalid", async () => {
    await open({ "PATCH /admin/payments/p1": apiError(400, "OVERPAYMENT", "รายการรับชำระเกินยอดที่ติดอยู่ในวันนั้น") });
    const user = userEvent.setup();
    await user.click(within(list()).getByRole("button", { name: "แก้ไข" }));
    const amount = within(list()).getByLabelText("จำนวนเงิน (บาท)");
    await user.clear(amount);
    await user.type(amount, "99999");
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    expect(await screen.findByText("รายการรับชำระเกินยอดที่ติดอยู่ในวันนั้น")).toBeInTheDocument();
  });

  it("deleting a payment shows the warning, needs a confirmation, then deletes", async () => {
    const calls = await open({ "DELETE /admin/payments/p1": { body: { contract: contractMoney({ totalDue: "1020.00" }) } } });
    const user = userEvent.setup();
    await user.click(within(list()).getByRole("button", { name: "ลบ" }));
    expect(screen.getByText(/คำนวณสัญญานี้ใหม่ทั้งสัญญา/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "ยืนยันลบ" }));
    expect(await screen.findByText(/ลบรายการรับชำระนี้แล้ว ระบบคำนวณสัญญาใหม่เรียบร้อย/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("backing out of an edit or a delete sends nothing", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.click(within(list()).getByRole("button", { name: "ลบ" }));
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    await user.click(within(list()).getByRole("button", { name: "แก้ไข" }));
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("the payout record", () => {
  const open = async (extra: Record<string, unknown> = {}, detail = adminDetail({ payments: [] })) => {
    pinToday();
    const calls = mockApi({ "GET /admin/contracts/c1": { body: detail }, ...noClaims, "POST /admin/slips": { status: 201, body: uploaded }, ...extra });
    await renderPage(AdminContractPage, "c1");
    await screen.findByRole("heading", { name: "การจ่ายเงินให้ผู้ยืม" });
    return calls;
  };
  const card = () => screen.getByRole("heading", { name: "การจ่ายเงินให้ผู้ยืม" }).closest("section")!;

  it("keeps the slip hidden until asked, then shows it from the API with the session cookie", async () => {
    await open();
    expect(document.querySelector("img")).toBeNull();
    await userEvent.setup().click(within(card()).getByRole("button", { name: "ดูสลิป" }));
    expect(document.querySelector("img")!.getAttribute("src")).toBe("/api/admin/slips/abc123def456.jpg");
    await userEvent.setup().click(within(card()).getByRole("button", { name: "ซ่อนสลิป" }));
    expect(document.querySelector("img")).toBeNull();
  });

  it("edits only the changed fields and warns about the recalculation", async () => {
    const calls = await open({ "PATCH /admin/disbursements/d1": { body: { disbursement: disbursement({ paidOn: "2026-10-19" }), contract: contractMoney() } } });
    const user = userEvent.setup();
    await user.click(within(card()).getByRole("button", { name: "แก้ไขรายการจ่ายเงิน" }));
    expect(screen.getByText(/คำนวณสัญญานี้ใหม่ทั้งสัญญา/)).toBeInTheDocument();
    setDate("วันที่โอนเงิน", "2026-10-19");
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    expect(await screen.findByText(/แก้ไขรายการจ่ายเงินแล้ว/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ paidOn: "2026-10-19" });
    expect(screen.queryByRole("button", { name: "ยืนยันแก้ไข" })).not.toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "แก้ไขรายการจ่ายเงิน" })).toBeInTheDocument();
  });

  it("can replace the slip", async () => {
    const calls = await open({ "PATCH /admin/disbursements/d1": { body: { disbursement: disbursement({ slipFileKey: "k1.png" }), contract: contractMoney() } } });
    const user = userEvent.setup();
    await user.click(within(card()).getByRole("button", { name: "แก้ไขรายการจ่ายเงิน" }));
    await user.upload(screen.getByLabelText(/เปลี่ยนสลิป/), slipFile());
    await screen.findByText("✓ อัปโหลดสลิปแล้ว");
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ slipFileKey: "k1.png" }));
  });

  it("an edit with nothing changed is not sent", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.click(within(card()).getByRole("button", { name: "แก้ไขรายการจ่ายเงิน" }));
    await user.click(screen.getByRole("button", { name: "ยืนยันแก้ไข" }));
    expect(await screen.findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("deleting the payout explains it and needs a confirmation", async () => {
    const calls = await open({ "DELETE /admin/disbursements/d1": { body: { contract: contractMoney({ status: "AWAITING_DISBURSEMENT" }) } } });
    const user = userEvent.setup();
    await user.click(within(card()).getByRole("button", { name: "ลบรายการจ่ายเงิน" }));
    expect(screen.getByText(/ลบได้เมื่อไม่มีรายการรับชำระเหลืออยู่/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "ยืนยันลบ" }));
    expect(await screen.findByText(/ลบรายการจ่ายเงินนี้แล้ว/)).toBeInTheDocument();
  });

  it("shows the API's refusal when payments still exist", async () => {
    await open({ "DELETE /admin/disbursements/d1": apiError(409, "HAS_PAYMENTS", "ลบการจ่ายเงินไม่ได้ ต้องลบรายการรับชำระของสัญญานี้ก่อน") });
    const user = userEvent.setup();
    await user.click(within(card()).getByRole("button", { name: "ลบรายการจ่ายเงิน" }));
    await user.click(screen.getByRole("button", { name: "ยืนยันลบ" }));
    expect(await screen.findByText("ลบการจ่ายเงินไม่ได้ ต้องลบรายการรับชำระของสัญญานี้ก่อน")).toBeInTheDocument();
  });

  it("an imported contract has no payout record to show", async () => {
    pinToday();
    mockApi({ "GET /admin/contracts/c1": { body: adminDetail({ disbursement: null, contract: { isImported: true } }) } });
    await renderPage(AdminContractPage, "c1");
    await screen.findByText("นำเข้าจากไฟล์");
    expect(screen.queryByRole("heading", { name: "การจ่ายเงินให้ผู้ยืม" })).not.toBeInTheDocument();
  });
});
