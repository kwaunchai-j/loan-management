import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ReportsPage from "@/app/admin/reports/page";
import { borrowerSummarySchema, latePayersSchema, outstandingSchema, profitLossSchema } from "@/lib/schemas";
import { apiError, mockApi, valid } from "./mocks";
import { NOW } from "./fixtures";

const month = { kind: "month", from: "2026-10-01", to: "2026-10-31" };
// Deliberately NOT adding up (cash total is not interest + late fee): the page must show the API's
// figures as they are and never work them out itself.
const pnl = (over: Record<string, unknown> = {}) =>
  valid(profitLossSchema, {
    period: month,
    cash: { interest: "258.34", lateFee: "30.00", total: "300.00", paymentCount: 3 },
    accrual: { interest: "1500.00", lateFee: "30.00", total: "1600.00", contractCount: 4, interestRecognisedThrough: "2026-10-30" },
    ...over,
  });
const lateItem = (n: number, over: Record<string, unknown> = {}) => ({
  rank: n,
  borrowerId: `b${n}`,
  fullName: `ผู้ยืม ${n}`,
  lateCount: 3 - Math.min(n, 2),
  lateContracts: [{ contractNo: `LN-000${n}`, dueDate: "2026-10-10", closedOn: null, stillUnpaid: true, daysLate: 20 }],
  ...over,
});
const late = (items: unknown[], total = items.length) => valid(latePayersSchema, { period: month, total, items });
const outstanding = (over: Record<string, unknown> = {}) =>
  valid(outstandingSchema, {
    asOf: "2026-10-30",
    isToday: true,
    openContracts: 2,
    totalOutstanding: "7000.00",
    principal: "5000.00",
    interest: "1500.00",
    lateFee: "500.00",
    inconsistentContracts: 0,
    ...over,
  });
const summary = (items: unknown[], total = items.length) => valid(borrowerSummarySchema, { period: month, total, items });
const person = (over: Record<string, unknown> = {}) => ({
  borrowerId: "b1",
  fullName: "สมชาย ใจดี",
  loanCount: 4,
  lateCount: 1,
  paidOnTimeCount: 2,
  notYetDueCount: 1,
  onTimeRatePct: "66.7",
  outstanding: "1020.00",
  ...over,
});

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 30 Oct 2026
}

const reports = {
  "GET /admin/reports/profit-loss": { body: pnl() },
  "GET /admin/reports/late-payers": { body: late([lateItem(1)]) },
  "GET /admin/reports/outstanding": { body: outstanding() },
  "GET /admin/reports/borrower-summary": { body: summary([person()]) },
};
const lastPath = (calls: Array<{ path: string }>) => calls[calls.length - 1]!.path;

describe("profit & loss", () => {
  it("opens on the current month and shows the cash and accrual bases side by side", async () => {
    pinToday();
    const calls = mockApi(reports);
    render(<ReportsPage />);
    expect(await screen.findByText("เกณฑ์เงินสด")).toBeInTheDocument();
    expect(screen.getByText("เกณฑ์คงค้าง")).toBeInTheDocument();
    expect(calls[0]!.path).toBe("/admin/reports/profit-loss?month=2026-10");
    expect(screen.getByText("ช่วงเวลา: ตุลาคม 2569")).toBeInTheDocument();
    const cash = screen.getByText("เกณฑ์เงินสด").closest("section")!;
    const accrual = screen.getByText("เกณฑ์คงค้าง").closest("section")!;
    expect(within(cash).getByText("258.34 บาท")).toBeInTheDocument();
    expect(within(accrual).getByText("1,500 บาท")).toBeInTheDocument();
    expect(within(accrual).getByText(/นับถึง 30 ต.ค. 2569/)).toBeInTheDocument();
    expect(within(cash).getByText(/3 รายการรับชำระ/)).toBeInTheDocument();
  });

  it("shows the API's totals as they are and never adds up the parts itself", async () => {
    pinToday();
    mockApi(reports);
    render(<ReportsPage />);
    const cash = (await screen.findByText("เกณฑ์เงินสด")).closest("section")!;
    // 258.34 + 30.00 = 288.34, but the API said 300.00: the page must show 300.00
    expect(within(cash).getByText("300 บาท")).toBeInTheDocument();
    expect(within(cash).queryByText("288.34 บาท")).not.toBeInTheDocument();
  });

  it("explains that income is only interest and late fees", async () => {
    pinToday();
    mockApi(reports);
    render(<ReportsPage />);
    expect(await screen.findByText(/รายได้มีเฉพาะดอกเบี้ยและค่าปรับ/)).toBeInTheDocument();
  });

  it("asks for a year, a custom range or all time only when the button is pressed", async () => {
    pinToday();
    const calls = mockApi(reports);
    render(<ReportsPage />);
    await screen.findByText("เกณฑ์เงินสด");
    const user = userEvent.setup();
    const before = calls.length;

    await user.selectOptions(screen.getByLabelText("ช่วงเวลา"), "year");
    expect(calls.length).toBe(before); // choosing is not asking
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/reports/profit-loss?year=2026"));

    await user.selectOptions(screen.getByLabelText("ช่วงเวลา"), "range");
    fireEvent.change(screen.getByLabelText("ตั้งแต่วันที่"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("ถึงวันที่ (รวมวันนี้)"), { target: { value: "2026-10-15" } });
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/reports/profit-loss?from=2026-10-01&to=2026-10-15"));

    await user.selectOptions(screen.getByLabelText("ช่วงเวลา"), "all");
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/reports/profit-loss"));
  });

  it("does not call the API for a period it would refuse", async () => {
    pinToday();
    const calls = mockApi(reports);
    render(<ReportsPage />);
    await screen.findByText("เกณฑ์เงินสด");
    const before = calls.length;
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("ช่วงเวลา"), "range");
    fireEvent.change(screen.getByLabelText("ตั้งแต่วันที่"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("ถึงวันที่ (รวมวันนี้)"), { target: { value: "2026-10-10" } });
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    expect(await screen.findByText("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น")).toBeInTheDocument();
    expect(calls.length).toBe(before);
  });

  it("shows the API's message when the report cannot be produced", async () => {
    pinToday();
    mockApi({ ...reports, "GET /admin/reports/profit-loss": apiError(400, "INVALID_PERIOD", "ช่วงวันที่ยาวเกินไป (ไม่เกินประมาณ 10 ปี)") });
    render(<ReportsPage />);
    expect(await screen.findByText(/ช่วงวันที่ยาวเกินไป/)).toBeInTheDocument();
  });
});

describe("late payers", () => {
  const open = async (extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({ ...reports, ...extra });
    render(<ReportsPage />);
    await screen.findByText("เกณฑ์เงินสด");
    await userEvent.setup().click(screen.getByRole("tab", { name: "ผู้ชำระช้า" }));
    return calls;
  };

  it("lists borrowers in the API's order with their late contracts", async () => {
    const calls = await open({
      "GET /admin/reports/late-payers": {
        body: late([
          lateItem(1, { lateCount: 2, lateContracts: [{ contractNo: "LN-0001", dueDate: "2026-10-10", closedOn: null, stillUnpaid: true, daysLate: 20 }, { contractNo: "LN-0002", dueDate: "2026-10-05", closedOn: "2026-10-08", stillUnpaid: false, daysLate: 3 }] }),
          lateItem(2, { lateCount: 1 }),
        ]),
      },
    });
    expect(await screen.findByText(/1\./)).toBeInTheDocument();
    expect(screen.getByText("ชำระช้า 2 สัญญา")).toBeInTheDocument();
    expect(screen.getAllByText(/ยังไม่ชำระ เลยมา 20 วัน/)).toHaveLength(2); // one per borrower in this data
    expect(screen.getByText(/ชำระครบ 8 ต.ค. 2569 ช้า 3 วัน/)).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").filter((li) => li.querySelector("a"));
    expect(items[0]!.textContent).toContain("ผู้ยืม 1");
    expect(calls.some((c) => c.path.startsWith("/admin/reports/late-payers?month=2026-10&limit=20&offset=0"))).toBe(true);
  });

  it("says so when nobody was late", async () => {
    await open({ "GET /admin/reports/late-payers": { body: late([]) } });
    expect(await screen.findByText("ไม่มีผู้ชำระช้าในช่วงนี้")).toBeInTheDocument();
  });

  it("pages 20 at a time", async () => {
    const items = Array.from({ length: 20 }, (_, i) => lateItem(i + 1));
    const calls = await open({ "GET /admin/reports/late-payers": { body: late(items, 45) } });
    await screen.findByText(/แสดง 1–20 จาก 45 คน/);
    await userEvent.setup().click(screen.getByRole("button", { name: "ถัดไป" }));
    await waitFor(() => expect(lastPath(calls)).toContain("offset=20"));
  });

  it("goes back to the first page when the period changes", async () => {
    const items = Array.from({ length: 20 }, (_, i) => lateItem(i + 1));
    const calls = await open({ "GET /admin/reports/late-payers": { body: late(items, 45) } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ถัดไป" }));
    await waitFor(() => expect(lastPath(calls)).toContain("offset=20"));
    await user.selectOptions(screen.getByLabelText("ช่วงเวลา"), "all");
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    await waitFor(() => expect(lastPath(calls)).toMatch(/^\/admin\/reports\/late-payers\?limit=20&offset=0/));
  });
});

describe("outstanding", () => {
  const open = async (extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({ ...reports, ...extra });
    render(<ReportsPage />);
    await screen.findByText("เกณฑ์เงินสด");
    await userEvent.setup().click(screen.getByRole("tab", { name: "ยอดค้าง" }));
    return calls;
  };

  it("shows the balance as of today, as the API reports it", async () => {
    const calls = await open();
    expect(await screen.findByText("7,000 บาท")).toBeInTheDocument();
    expect(screen.getByText("2 สัญญา")).toBeInTheDocument();
    expect(screen.getByText(/ณ วันที่ 30 ต.ค. 2569 \(วันนี้\)/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admin/reports/outstanding?asOf=2026-10-30")).toBe(true);
    expect(screen.queryByLabelText("ช่วงเวลา")).not.toBeInTheDocument(); // a point in time has no period
  });

  it("asks for another day, but not a day in the future", async () => {
    const calls = await open();
    await screen.findByText("7,000 บาท");
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText("ยอดค้าง ณ วันที่"), { target: { value: "2026-10-31" } });
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    expect(await screen.findByText("เลือกวันในอนาคตไม่ได้")).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("2026-10-31"))).toBe(false);
    fireEvent.change(screen.getByLabelText("ยอดค้าง ณ วันที่"), { target: { value: "2026-09-30" } });
    await user.click(screen.getByRole("button", { name: "แสดงรายงาน" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/reports/outstanding?asOf=2026-09-30"));
  });

  it("warns when contracts had to be left out because their history is inconsistent", async () => {
    await open({ "GET /admin/reports/outstanding": { body: outstanding({ inconsistentContracts: 2 }) } });
    expect(await screen.findByText(/มี 2 สัญญาที่ประวัติรายการไม่สอดคล้อง/)).toBeInTheDocument();
  });

  it("does not call a past day 'today'", async () => {
    await open({ "GET /admin/reports/outstanding": { body: outstanding({ asOf: "2026-09-30", isToday: false }) } });
    expect(await screen.findByText(/ณ วันที่ 30 ก.ย. 2569/)).toBeInTheDocument();
    expect(screen.queryByText(/\(วันนี้\)/)).not.toBeInTheDocument();
  });
});

describe("borrower summary", () => {
  const open = async (extra: Record<string, unknown> = {}) => {
    pinToday();
    const calls = mockApi({ ...reports, ...extra });
    render(<ReportsPage />);
    await screen.findByText("เกณฑ์เงินสด");
    await userEvent.setup().click(screen.getByRole("tab", { name: "สรุปรายผู้ยืม" }));
    return calls;
  };

  it("shows the counts, the on-time rate and what is owed, from the API", async () => {
    await open();
    expect(await screen.findByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("ยอดค้างตอนนี้ 1,020 บาท")).toBeInTheDocument();
    expect(screen.getByText("ชำระตรงเวลา")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่ถึงกำหนด")).toBeInTheDocument();
  });

  it("a borrower with no verdict yet has no percentage, not 0%", async () => {
    await open({ "GET /admin/reports/borrower-summary": { body: summary([person({ onTimeRatePct: null, lateCount: 0, paidOnTimeCount: 0 })]) } });
    expect(await screen.findByText("ยังไม่มีผล")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("says so when there is nothing in the period", async () => {
    await open({ "GET /admin/reports/borrower-summary": { body: summary([]) } });
    expect(await screen.findByText("ไม่มีข้อมูลในช่วงนี้")).toBeInTheDocument();
  });

  it("links each borrower to the borrower's page", async () => {
    await open();
    await screen.findByText("66.7%");
    expect(document.querySelector('a[href="/admin/borrowers/b1"]')).not.toBeNull();
  });
});

describe("tabs", () => {
  it("shows one report at a time and keeps the period picker for all but the outstanding balance", async () => {
    pinToday();
    mockApi(reports);
    render(<ReportsPage />);
    await screen.findByText("เกณฑ์เงินสด");
    expect(screen.getByRole("tab", { name: "กำไรขาดทุน" })).toHaveAttribute("aria-selected", "true");
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "ผู้ชำระช้า" }));
    expect(screen.queryByText("เกณฑ์เงินสด")).not.toBeInTheDocument();
    expect(screen.getByLabelText("ช่วงเวลา")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "ยอดค้าง" }));
    expect(screen.queryByLabelText("ช่วงเวลา")).not.toBeInTheDocument();
  });
});
