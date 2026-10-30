import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RequestPage from "@/app/me/request/page";
import { InterestEstimate } from "@/components/InterestEstimate";
import { interestEstimateSchema, type InterestEstimate as Estimate } from "@/lib/schemas";
import { NOW } from "./fixtures";
import { apiError, mockApi, valid } from "./mocks";

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 30 Oct 2026 in Thailand
}

const estimate = (over: Partial<Estimate> = {}) =>
  valid(interestEstimateSchema, {
    amount: "10000",
    payoutDate: "2026-10-30",
    dueDate: null,
    days: 30,
    daysAssumed: true,
    interestRatePctPerMonth: "3",
    interestAmount: "300",
    totalToRepay: "10300",
    isEstimate: true,
    ...over,
  });
const ok = (over: Partial<Estimate> = {}) => ({ body: estimate(over) });
const ROUTE = "GET /loan-requests/interest-estimate";
const box = () => screen.queryByRole("region", { name: "ดอกเบี้ยโดยประมาณ" });
const asked = (calls: ReturnType<typeof mockApi>) => calls.filter((c) => c.path.startsWith("/loan-requests/interest-estimate")).map((c) => c.path.split("?")[1]);

// a short wait, so the tests do not sit through the real 400 ms
const component = (amount: string, dueDate = "") => <InterestEstimate amount={amount} dueDate={dueDate} delayMs={5} />;

describe("InterestEstimate", () => {
  it("shows nothing until the amount is a usable amount, and asks the API nothing for a bad one", async () => {
    const calls = mockApi({ [ROUTE]: ok() });
    const { rerender } = render(component(""));
    for (const bad of ["abc", "0", "-5", "1.234", "1,000", "1234567890123"]) rerender(component(bad));
    await new Promise((r) => setTimeout(r, 40));
    expect(box()).not.toBeInTheDocument();
    expect(screen.queryByText(/กำลังคำนวณ/)).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("with just an amount: asks for that amount only, then shows the interest, the total, the 30 days and the rate", async () => {
    const calls = mockApi({ [ROUTE]: ok() });
    render(component("10000"));
    expect(await screen.findByRole("region", { name: "ดอกเบี้ยโดยประมาณ" })).toBeInTheDocument();
    expect(asked(calls)).toEqual(["amount=10000"]);
    expect(screen.getByText("300 บาท")).toBeInTheDocument();
    expect(screen.getByText("10,300 บาท")).toBeInTheDocument();
    expect(screen.getByText(/คิดตามมาตรฐาน 30 วัน/)).toBeInTheDocument();
    expect(screen.getByText(/อัตรา 3% ต่อเดือน/)).toBeInTheDocument();
  });

  it("says plainly that it is an estimate, counted from the transfer day, rounded up, and that late fees come on top", async () => {
    mockApi({ [ROUTE]: ok() });
    render(component("10000"));
    const note = await screen.findByText(/เป็นการประมาณการเท่านั้น/);
    expect(note).toHaveTextContent("ดอกเบี้ยจริงนับจากวันที่ผู้ให้กู้โอนเงินให้");
    expect(note).toHaveTextContent("ปัดขึ้นเป็นบาทเต็ม");
    expect(note).toHaveTextContent("ค่าปรับรายวัน");
  });

  it("with a due date: sends it too and explains the days it used", async () => {
    pinToday();
    const calls = mockApi({
      [ROUTE]: ok({ dueDate: "2026-11-14", days: 15, daysAssumed: false, interestAmount: "150", totalToRepay: "10150" }),
    });
    render(component("10000", "2026-11-14"));
    expect(await screen.findByText("150 บาท")).toBeInTheDocument();
    expect(asked(calls)).toEqual(["amount=10000&dueDate=2026-11-14"]);
    expect(screen.getByText(/คิดจาก 15 วัน นับจากวันนี้ถึง 14 พ.ย. 2569/)).toBeInTheDocument();
    expect(screen.queryByText(/คิดตามมาตรฐาน/)).not.toBeInTheDocument();
  });

  it.each([
    ["today", "2026-10-30"],
    ["in the past", "2026-10-01"],
    ["half typed", "2026-1"],
  ])("a due date that is %s is left out of the question (the form explains it), the 30 days answer is shown", async (_n, due) => {
    pinToday();
    const calls = mockApi({ [ROUTE]: ok() });
    render(component("10000", due));
    expect(await screen.findByText("300 บาท")).toBeInTheDocument();
    expect(asked(calls)).toEqual(["amount=10000"]);
  });

  it("whole baht have no decimals and satang keep two", async () => {
    mockApi({ [ROUTE]: ok({ amount: "1000.5", interestAmount: "31", totalToRepay: "1031.5" }) });
    render(component("1000.5"));
    expect(await screen.findByText("31 บาท")).toBeInTheDocument();
    expect(screen.getByText("1,031.50 บาท")).toBeInTheDocument();
  });

  it("typing quickly asks once, for the final amount (debounce)", async () => {
    const calls = mockApi({ [ROUTE]: ok() });
    const { rerender } = render(<InterestEstimate amount="1" dueDate="" delayMs={60} />);
    for (const a of ["12", "123", "1234", "12345"]) {
      rerender(<InterestEstimate amount={a} dueDate="" delayMs={60} />);
      await new Promise((r) => setTimeout(r, 15)); // keystrokes a few milliseconds apart
    }
    await screen.findByRole("region", { name: "ดอกเบี้ยโดยประมาณ" });
    expect(asked(calls)).toEqual(["amount=12345"]);
  });

  it("changing the amount keeps the last figure (dimmed, marked busy) until the new one arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockApi({
      [ROUTE]: (call) => (call.path.includes("amount=20000") ? { body: estimate({ amount: "20000", interestAmount: "600", totalToRepay: "20600" }) } : ok()),
    });
    // make the second answer wait for the gate
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("amount=20000")) await gate;
      return real(input, init);
    });
    const { rerender } = render(component("10000"));
    await screen.findByText("300 บาท");
    rerender(component("20000"));
    await waitFor(() => expect(box()).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByText("300 บาท")).toBeInTheDocument(); // the old figure is still there, not blank
    release();
    expect(await screen.findByText("600 บาท")).toBeInTheDocument();
    expect(box()).toHaveAttribute("aria-busy", "false");
  });

  it("never shows an old answer next to a newer amount when the newer one fails", async () => {
    mockApi({
      [ROUTE]: (call) => (call.path.includes("amount=30000") ? apiError(400, "LIMIT_EXCEEDED", "ยอดเกินขีดจำกัดที่ระบบคำนวณได้") : ok()),
    });
    const { rerender } = render(component("10000"));
    await screen.findByText("300 บาท");
    rerender(component("30000"));
    expect(await screen.findByRole("status")).toHaveTextContent("ยอดเกินขีดจำกัด");
    expect(screen.queryByText("300 บาท")).not.toBeInTheDocument();
    expect(box()).not.toBeInTheDocument();
  });

  it("when the lender has not set the rate, shows the API's own words as a warning and no figures", async () => {
    mockApi({ [ROUTE]: apiError(409, "RATES_NOT_SET", "ยังคำนวณดอกเบี้ยให้ไม่ได้ในขณะนี้ กรุณาติดต่อผู้ให้กู้") });
    render(component("10000"));
    expect(await screen.findByRole("status")).toHaveTextContent("กรุณาติดต่อผู้ให้กู้");
    expect(box()).not.toBeInTheDocument();
  });

  it("when the server cannot be reached, says so instead of showing nothing", async () => {
    mockApi({ [ROUTE]: new Error("offline") });
    render(component("10000"));
    expect(await screen.findByRole("status")).toHaveTextContent("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  });

  it("clearing the amount removes the box", async () => {
    mockApi({ [ROUTE]: ok() });
    const { rerender } = render(component("10000"));
    await screen.findByText("300 บาท");
    rerender(component(""));
    expect(box()).not.toBeInTheDocument();
  });

  it("an answer that arrives after the amount was cleared is not shown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockApi({ [ROUTE]: ok() });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return real(input, init);
    });
    const { rerender } = render(component("10000"));
    await new Promise((r) => setTimeout(r, 30));
    rerender(component(""));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(box()).not.toBeInTheDocument();
  });
});

describe("the request form with the estimate", () => {
  it("shows the estimate under the amount while typing, and sending the request still sends only the amount and the due date", async () => {
    pinToday();
    let sent = false;
    const calls = mockApi({
      "GET /me/loan-requests": () => ({ body: { items: [] } }),
      [ROUTE]: ok({ amount: "5000", interestAmount: "150", totalToRepay: "5150" }),
      "POST /loan-requests": () => {
        sent = true;
        return {
          status: 201,
          body: { id: "r1", borrower: { id: "b1", fullName: "x" }, amount: "5000", requestedDueDate: "2026-12-01", status: "PENDING", createdById: "u2", decidedById: null, decidedAt: null, rejectReason: null, createdAt: "2026-10-30T05:00:00.000Z", contract: null },
        };
      },
    });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    const user = userEvent.setup();
    expect(box()).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/จำนวนเงินที่ต้องการยืม/), "5000");
    expect(await screen.findByText("150 บาท", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("5,150 บาท")).toBeInTheDocument();
    await user.type(screen.getByLabelText("วันที่จะคืนเงิน"), "2026-12-01");
    await user.click(screen.getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(sent).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ amount: "5000", requestedDueDate: "2026-12-01" }); // no interest sent
    expect(await screen.findByText(/ส่งคำขอเรียบร้อยแล้ว/)).toBeInTheDocument();
    expect(box()).not.toBeInTheDocument(); // the form was cleared, so the estimate is gone with it
  });

  it("tells the borrower the figure is a guide: the amount hint mentions the estimate", async () => {
    mockApi({ "GET /me/loan-requests": () => ({ body: { items: [] } }) });
    render(<RequestPage />);
    expect(await screen.findByText(/ดอกเบี้ยโดยประมาณ ดอกเบี้ยจริงจะคำนวณตอนผู้ให้กู้โอนเงินให้/)).toBeInTheDocument();
  });
});
