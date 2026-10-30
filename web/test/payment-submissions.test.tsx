import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AdminContractPage from "@/app/admin/contracts/[id]/page";
import PaymentsPage from "@/app/admin/payments/page";
import MyContractDetailPage from "@/app/me/contracts/[id]/page";
import { apiError, mockApi, type Call } from "./mocks";
import { adminDetail, adminSubmission, adminSubmissions, awaitingDetail, mySubmission, mySubmissions, NOW, portalAwaiting, portalDetail, portalItem } from "./fixtures";
import { renderPage } from "./render";

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 30 Oct 2026 in Thailand
}
const slip = (type = "image/png", size = 2048) => new File([new Uint8Array(size)], "slip.png", { type });
const setDate = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const sendCalls = (calls: Call[]) => calls.filter((c) => c.method === "POST");

describe("borrower: sending a slip", () => {
  const open = async (extra: Record<string, unknown> = {}, contract = portalItem()) => {
    pinToday();
    const calls = mockApi({
      "GET /me/contracts/c1": { body: portalDetail({ contract }) },
      "GET /me/payment-submissions": { body: mySubmissions() },
      ...extra,
    });
    await renderPage(MyContractDetailPage, "c1");
    await screen.findByText("แจ้งชำระเงิน (ส่งสลิป)");
    return calls;
  };
  const fill = async (user: ReturnType<typeof userEvent.setup>, amount = "300", file: File | null = slip()) => {
    if (amount) await user.type(screen.getByLabelText(/จำนวนเงินที่โอน/), amount);
    if (file) await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), file);
  };

  it("is offered only on a contract that is paid out and still open", async () => {
    pinToday();
    for (const contract of [portalAwaiting({ id: "c1" }), portalItem({ status: "CLOSED", totalDue: "0.00", closedOn: "2026-10-28" }), portalAwaiting({ id: "c1", status: "CANCELLED" })]) {
      mockApi({ "GET /me/contracts/c1": { body: portalDetail({ contract, disbursement: null }) }, "GET /me/payment-submissions": { body: mySubmissions() } });
      const { unmount } = render(<div />);
      unmount();
      await renderPage(MyContractDetailPage, "c1");
      await screen.findByText(/สัญญา LN-/);
      expect(screen.queryByText("แจ้งชำระเงิน (ส่งสลิป)")).not.toBeInTheDocument();
      document.body.innerHTML = "";
    }
  });

  it("says plainly that sending a slip does not lower the balance yet", async () => {
    await open();
    expect(screen.getByText(/ยอดค้างจะยังไม่ลดลงทันที/)).toBeInTheDocument();
  });

  it("sends the slip itself with the amount and date in the address, and shows the confirmation", async () => {
    let sent = false;
    const calls = await open({
      "GET /me/payment-submissions": () => ({ body: mySubmissions(...(sent ? [mySubmission({ amount: "300.00" })] : [])) }),
      "POST /me/contracts/c1/payment-submissions": () => {
        sent = true;
        return { status: 201, body: mySubmission() };
      },
    });
    const user = userEvent.setup();
    await fill(user);
    await user.type(screen.getByLabelText(/หมายเหตุ/), "  โอนผ่านแอป  ");
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText(/ส่งสลิปแล้ว ผู้ให้กู้จะตรวจสอบ/)).toBeInTheDocument();
    const post = sendCalls(calls)[0]!;
    const url = new URL(post.path, "http://localhost");
    expect(url.pathname).toBe("/me/contracts/c1/payment-submissions");
    expect(Object.fromEntries(url.searchParams)).toEqual({ amount: "300", paidOn: "2026-10-30", note: "โอนผ่านแอป" }); // trimmed
    expect(post.body).toEqual({ file: { type: "image/png", size: 2048 } }); // the picture is the body
    // the list refreshed, and the form is empty again
    expect(await screen.findByText(/โอนวันที่ 29 ต.ค. 2569/)).toBeInTheDocument();
    expect(screen.getByLabelText(/จำนวนเงินที่โอน/)).toHaveValue("");
    expect(screen.getByLabelText(/หมายเหตุ/)).toHaveValue("");
  });

  it("will not send without a slip, or with a file that is not a JPEG/PNG, or one over 5 MB", async () => {
    const calls = await open();
    const user = userEvent.setup({ applyAccept: false });
    await fill(user, "300", null);
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText("กรุณาแนบสลิปการโอนเงิน")).toBeInTheDocument();
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), slip("application/pdf"));
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText("รองรับเฉพาะไฟล์รูป JPEG หรือ PNG")).toBeInTheDocument();
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), slip("image/png", 5 * 1024 * 1024 + 1));
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText("ไฟล์ใหญ่เกิน 5 MB")).toBeInTheDocument();
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("checks the amount and the date before sending", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await fill(user, "0");
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText(/ต้องมากกว่า 0/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/จำนวนเงินที่โอน/));
    await user.type(screen.getByLabelText(/จำนวนเงินที่โอน/), "300");
    setDate("วันที่โอน", "2026-10-31");
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText("วันที่โอนต้องไม่เป็นวันในอนาคต")).toBeInTheDocument();
    setDate("วันที่โอน", "2026-10-19"); // the payout of the fixture was on 2026-10-20
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText("วันที่โอนต้องไม่ก่อนวันที่ได้รับเงิน")).toBeInTheDocument();
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("shows the API's refusal (such as too many waiting) and keeps what was typed", async () => {
    await open({ "POST /me/contracts/c1/payment-submissions": apiError(409, "TOO_MANY_PENDING", "มีสลิปรอตรวจครบ 5 รายการแล้ว กรุณารอผู้ให้กู้ตรวจก่อนส่งเพิ่ม") });
    const user = userEvent.setup();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText(/มีสลิปรอตรวจครบ 5 รายการแล้ว/)).toBeInTheDocument();
    expect(screen.getByLabelText(/จำนวนเงินที่โอน/)).toHaveValue("300");
    expect(screen.queryByText(/ส่งสลิปแล้ว ผู้ให้กู้จะตรวจสอบ/)).not.toBeInTheDocument();
  });

  it("lists the claims of THIS contract with their status, and the reason when one was refused", async () => {
    await open({
      "GET /me/payment-submissions": {
        body: mySubmissions(
          mySubmission({ id: "a", status: "PENDING" }),
          mySubmission({ id: "b", status: "CONFIRMED", amount: "500.00" }),
          mySubmission({ id: "c", status: "REJECTED", amount: "700.00", rejectReason: "สลิปไม่ชัด อ่านยอดไม่ได้" }),
          mySubmission({ id: "d", contract: { id: "other", contractNo: "LN-9999" }, amount: "99999.00" }),
        ),
      },
    });
    expect(screen.getByText("รอผู้ให้กู้ตรวจ")).toBeInTheDocument();
    expect(screen.getByText("ยืนยันแล้ว")).toBeInTheDocument();
    expect(screen.getByText("ไม่ได้รับการยืนยัน")).toBeInTheDocument();
    expect(screen.getByText("เหตุผล: สลิปไม่ชัด อ่านยอดไม่ได้")).toBeInTheDocument();
    expect(screen.getByText(/ส่งสลิปใหม่ให้ชัดเจนได้/)).toBeInTheDocument();
    expect(screen.getByText("มีสลิปรอผู้ให้กู้ตรวจอยู่ 1 รายการ")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("99,999"); // another contract's claim
    expect(document.querySelector("img")).toBeNull(); // the borrower is never shown a slip
  });
});

describe("admin: the slips queue", () => {
  const open = async (items = [adminSubmission()], extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({ "GET /admin/payment-submissions": { body: adminSubmissions(items) }, ...extra });
    render(<PaymentsPage />);
    await screen.findByText(items[0] ? "สมชาย ใจดี" : "ไม่มีสลิปที่รอตรวจ");
    return calls;
  };

  it("opens on the claims waiting for a check, showing who, how much, which contract and the borrower's note", async () => {
    const calls = await open([adminSubmission({ note: "โอนตอนเช้า" })]);
    expect(calls[0]!.path).toContain("status=PENDING");
    expect(screen.getByText("300 บาท")).toBeInTheDocument();
    expect(screen.getByText(/โอนวันที่ 29 ต.ค. 2569/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LN-0001" })).toHaveAttribute("href", "/admin/contracts/c1");
    expect(screen.getByText("หมายเหตุจากผู้ยืม: โอนตอนเช้า")).toBeInTheDocument();
  });

  it("says so when nothing is waiting", async () => {
    await open([]);
    expect(screen.getByText("ไม่มีสลิปที่รอตรวจ")).toBeInTheDocument();
  });

  it("keeps the slip hidden until asked, then shows it from the API with the session cookie", async () => {
    await open();
    expect(document.querySelector("img")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ดูสลิป" }));
    expect(document.querySelector("img")!.getAttribute("src")).toBe("/api/admin/slips/abc123def456.jpg");
    await user.click(screen.getByRole("button", { name: "ซ่อนสลิป" }));
    expect(document.querySelector("img")).toBeNull();
  });

  it("filters by status, and a decided claim has no decision buttons", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("แสดงสลิป"), "REJECTED");
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("status=REJECTED"));
    await user.selectOptions(screen.getByLabelText("แสดงสลิป"), "");
    await waitFor(() => expect(calls[calls.length - 1]!.path).not.toContain("status="));
  });

  it("shows a refused claim with its reason, and a confirmed one as recorded — neither can be decided again", async () => {
    await open([
      adminSubmission({ id: "r", status: "REJECTED", rejectReason: "ยอดไม่ตรงสลิป" }),
      adminSubmission({ id: "k", status: "CONFIRMED", paymentId: "p1", borrower: { id: "b2", fullName: "สมหญิง รักดี" } }),
      adminSubmission({ id: "g", status: "CONFIRMED", paymentId: null, borrower: { id: "b3", fullName: "ลบแล้ว คนหนึ่ง" } }),
    ]);
    expect(screen.getByText("เหตุผลที่ไม่ยืนยัน: ยอดไม่ตรงสลิป")).toBeInTheDocument();
    expect(screen.getAllByText(/บันทึกเป็นรายการรับชำระแล้ว/)).toHaveLength(2);
    expect(screen.getByText(/รายการรับชำระถูกลบภายหลัง/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ตรวจแล้ว ยืนยัน" })).not.toBeInTheDocument();
  });

  describe("confirming", () => {
    const result = {
      submission: adminSubmission({ status: "CONFIRMED", paymentId: "p9" }),
      payment: { id: "p9", contractId: "c1", amount: "300.00", paidOn: "2026-10-29", allocatedLateFee: "0.00", allocatedInterest: "100.00", allocatedPrincipal: "200.00", note: null, recordedById: "u1", createdAt: "2026-10-30T05:00:00.000Z" },
      contract: { id: "c1", contractNo: "LN-0001", status: "ACTIVE", principal: "1000.00", dueDate: "2026-11-30", disbursedOn: "2026-10-01", interestRatePctPerMonth: "3", lateFeeRatePctPerDay: "1", interestAmount: "100.00", outstandingPrincipal: "800.00", outstandingInterest: "0.00", accruedLateFee: "0.00", totalDue: "800.00", closedOn: null },
    };

    it("explains that this records a real payment, pre-filled from the claim", async () => {
      await open();
      await userEvent.setup().click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      expect(screen.getByText(/บันทึกรับชำระจริง/)).toBeInTheDocument();
      expect(screen.getByLabelText("จำนวนเงินที่รับชำระ (บาท)")).toHaveValue("300.00");
      expect(screen.getByLabelText("วันที่รับชำระ")).toHaveValue("2026-10-29");
    });

    it("confirms as sent (nothing corrected → nothing but an empty body) and shows how it was settled", async () => {
      const calls = await open([adminSubmission()], { "POST /admin/payment-submissions/s1/confirm": { body: result } });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      await user.click(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" }));
      expect(await screen.findByText(/ยืนยันแล้ว บันทึกรับชำระ 300 บาท ตัดเป็น ดอกเบี้ย 100 · เงินต้น 200 · ยอดที่ต้องชำระคงเหลือ 800 บาท/)).toBeInTheDocument();
      expect(sendCalls(calls)[0]!).toMatchObject({ path: "/admin/payment-submissions/s1/confirm" });
      expect(sendCalls(calls)[0]!.body).toEqual({});
    });

    it("sends only what the admin corrected (amount, date, note)", async () => {
      const calls = await open([adminSubmission()], { "POST /admin/payment-submissions/s1/confirm": { body: result } });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      const amount = screen.getByLabelText("จำนวนเงินที่รับชำระ (บาท)");
      await user.clear(amount);
      await user.type(amount, "250.50");
      setDate("วันที่รับชำระ", "2026-10-28");
      await user.type(screen.getByLabelText(/หมายเหตุของรายการรับชำระ/), "ยอดตามสลิปจริง");
      await user.click(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" }));
      await screen.findByText(/ยืนยันแล้ว บันทึกรับชำระ/);
      expect(sendCalls(calls)[0]!.body).toEqual({ amount: "250.50", paidOn: "2026-10-28", note: "ยอดตามสลิปจริง" });
    });

    it("an amount typed as 300 is not a correction of 300.00", async () => {
      const calls = await open([adminSubmission()], { "POST /admin/payment-submissions/s1/confirm": { body: result } });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      const amount = screen.getByLabelText("จำนวนเงินที่รับชำระ (บาท)");
      await user.clear(amount);
      await user.type(amount, "300");
      await user.click(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" }));
      await screen.findByText(/ยืนยันแล้ว บันทึกรับชำระ/);
      expect(sendCalls(calls)[0]!.body).toEqual({});
    });

    it("shows the ledger's refusal in Thai and leaves the claim waiting so the amount can be fixed", async () => {
      await open([adminSubmission({ amount: "5000.00" })], {
        "POST /admin/payment-submissions/s1/confirm": apiError(400, "AMOUNT_EXCEEDS_DUE", "ชำระเกินยอดที่ติดไม่ได้ ยอดที่ต้องชำระ ณ วันนั้นคือ 1100.00 บาท"),
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      await user.click(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" }));
      expect(await screen.findByText(/ชำระเกินยอดที่ติดไม่ได้/)).toBeInTheDocument(); // once, inside the open panel
      expect(screen.getByLabelText("จำนวนเงินที่รับชำระ (บาท)")).toHaveValue("5000.00"); // still open for correction
      expect(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" })).toBeEnabled();
    });

    it("checks the corrected amount and date itself before calling the API", async () => {
      const calls = await open();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      const amount = screen.getByLabelText("จำนวนเงินที่รับชำระ (บาท)");
      await user.clear(amount);
      await user.type(amount, "0");
      await user.click(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" }));
      expect(await screen.findByText(/ต้องมากกว่า 0/)).toBeInTheDocument();
      await user.clear(amount);
      await user.type(amount, "100");
      setDate("วันที่รับชำระ", "2026-10-31");
      await user.click(screen.getByRole("button", { name: "ยืนยันและบันทึกรับชำระ" }));
      expect(await screen.findByText("วันที่รับชำระต้องไม่เป็นวันในอนาคต")).toBeInTheDocument();
      expect(sendCalls(calls)).toHaveLength(0);
    });

    it("backing out sends nothing", async () => {
      const calls = await open();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" }));
      await user.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
      expect(sendCalls(calls)).toHaveLength(0);
      expect(screen.getByRole("button", { name: "ตรวจแล้ว ยืนยัน" })).toBeInTheDocument();
    });
  });

  describe("refusing", () => {
    it("needs a reason that the borrower will see, and sends it trimmed", async () => {
      const calls = await open([adminSubmission()], { "POST /admin/payment-submissions/s1/reject": { body: adminSubmission({ status: "REJECTED", rejectReason: "สลิปไม่ชัด" }) } });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ไม่ยืนยัน" }));
      await user.click(screen.getByRole("button", { name: "ยืนยันไม่ยืนยันสลิปนี้" }));
      expect(await screen.findByText(/กรุณาระบุเหตุผล/)).toBeInTheDocument();
      expect(sendCalls(calls)).toHaveLength(0);
      await user.type(screen.getByLabelText(/เหตุผลที่ไม่ยืนยัน/), "   ");
      await user.click(screen.getByRole("button", { name: "ยืนยันไม่ยืนยันสลิปนี้" }));
      expect(sendCalls(calls)).toHaveLength(0); // blank spaces are not a reason
      await user.clear(screen.getByLabelText(/เหตุผลที่ไม่ยืนยัน/));
      await user.type(screen.getByLabelText(/เหตุผลที่ไม่ยืนยัน/), "  สลิปไม่ชัด  ");
      await user.click(screen.getByRole("button", { name: "ยืนยันไม่ยืนยันสลิปนี้" }));
      expect(await screen.findByText(/ผู้ยืมจะเห็นเหตุผล/, { selector: "[role=status] div" })).toBeInTheDocument();
      expect(sendCalls(calls)[0]!.body).toEqual({ reason: "สลิปไม่ชัด" });
    });

    it("shows the API's message when the claim was already decided by someone else", async () => {
      await open([adminSubmission()], { "POST /admin/payment-submissions/s1/reject": apiError(409, "INVALID_STATE", "รายการนี้ถูกดำเนินการไปแล้ว") });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "ไม่ยืนยัน" }));
      await user.type(screen.getByLabelText(/เหตุผลที่ไม่ยืนยัน/), "ซ้ำ");
      await user.click(screen.getByRole("button", { name: "ยืนยันไม่ยืนยันสลิปนี้" }));
      expect(await screen.findByText("รายการนี้ถูกดำเนินการไปแล้ว")).toBeInTheDocument();
    });
  });

  it("pages through the queue 20 at a time", async () => {
    const items = Array.from({ length: 20 }, (_, i) => adminSubmission({ id: `s${i}` }));
    const calls = mockApi({ "GET /admin/payment-submissions": { body: adminSubmissions(items, 45) } });
    render(<PaymentsPage />);
    await screen.findAllByText("สมชาย ใจดี");
    expect(screen.getByText(/แสดง 1–20 จาก 45 รายการ/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "ถัดไป" }));
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("offset=20"));
  });
});

describe("admin: reminder on the contract page", () => {
  const base = { "GET /admin/contracts/c1": { body: adminDetail() } };

  it("tells the admin when the borrower has slips nobody has checked, with a link to the queue", async () => {
    pinToday();
    const calls = mockApi({ ...base, "GET /admin/payment-submissions": { body: adminSubmissions([adminSubmission()], 2) } });
    await renderPage(AdminContractPage, "c1");
    expect(await screen.findByText(/ผู้ยืมส่งสลิปชำระของสัญญานี้มา 2 รายการ รอตรวจสอบ/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ไปตรวจสลิป" })).toHaveAttribute("href", "/admin/payments");
    expect(calls.find((c) => c.path.startsWith("/admin/payment-submissions"))!.path).toBe("/admin/payment-submissions?contractId=c1&status=PENDING&limit=1");
  });

  it("says nothing when there is none, and not at all on a contract that is not open", async () => {
    pinToday();
    mockApi({ ...base, "GET /admin/payment-submissions": { body: adminSubmissions([]) } });
    await renderPage(AdminContractPage, "c1");
    await screen.findByText(/สัญญา LN-0001/);
    expect(screen.queryByText(/ผู้ยืมส่งสลิปชำระ/)).not.toBeInTheDocument();
    document.body.innerHTML = "";
    const calls = mockApi({ "GET /admin/contracts/c1": { body: awaitingDetail() }, "GET /admin/settings": { body: { interestRatePctPerMonth: "5", lateFeeRatePctPerDay: "1", updatedAt: null, updatedBy: null } } });
    await renderPage(AdminContractPage, "c1");
    await screen.findByText(/สัญญา LN-0001/);
    expect(calls.some((c) => c.path.startsWith("/admin/payment-submissions"))).toBe(false);
  });
});

