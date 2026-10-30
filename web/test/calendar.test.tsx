import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CalendarPage from "@/app/admin/calendar/page";
import { daysInMonth, longDay, monthCells, monthLabel, parseMonth, shiftMonth } from "@/lib/calendar";
import { apiError, mockApi } from "./mocks";
import { calendarDay, calendarOf, dueItem, NOW, paidItem } from "./fixtures";

function pinToday() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 30 Oct 2026 in Thailand
}
const lastPath = (calls: Array<{ path: string }>) => calls[calls.length - 1]!.path;

describe("calendar layout helpers", () => {
  it("reads and writes months, and moves across year ends", () => {
    expect(parseMonth("2026-10")).toEqual({ year: 2026, month: 10 });
    for (const bad of ["2026-13", "2026-00", "26-10", "2026-1", "", "abcd-ef"]) expect(parseMonth(bad)).toBeNull();
    expect(shiftMonth("2026-10", 1)).toBe("2026-11");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-03", -15)).toBe("2024-12");
    expect(shiftMonth("nonsense", 1)).toBe("nonsense");
  });

  it("knows how long a month is (including leap years)", () => {
    expect(daysInMonth("2026-10")).toBe(31);
    expect(daysInMonth("2026-11")).toBe(30);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2100-02")).toBe(28); // 2100 is not a leap year
  });

  it("starts the first day on the right weekday (weeks begin on Sunday)", () => {
    const oct = monthCells("2026-10"); // 1 Oct 2026 is a Thursday
    expect(oct.findIndex((c) => c !== null)).toBe(4);
    expect(oct[4]).toBe("2026-10-01");
    expect(oct).toHaveLength(4 + 31);
    expect(oct[oct.length - 1]).toBe("2026-10-31");
    const feb = monthCells("2026-02"); // 1 Feb 2026 is a Sunday: no blanks
    expect(feb[0]).toBe("2026-02-01");
    expect(feb).toHaveLength(28);
    expect(monthCells("bad")).toEqual([]);
  });

  it("writes months and days in Thai Buddhist Era", () => {
    expect(monthLabel("2026-10")).toBe("ตุลาคม 2569");
    expect(longDay("2026-10-30")).toBe("30 ตุลาคม 2569");
    expect(longDay("2026-01-01")).toBe("1 มกราคม 2569");
  });
});

describe("calendar page", () => {
  const october = () =>
    calendarOf("2026-10", [
      calendarDay("2026-10-30", {
        due: [dueItem({ contractNo: "LN-0007", totalDue: "5258.34", borrower: { id: "b7", fullName: "สมหญิง รักดี" } }), dueItem({ contractId: "c8", contractNo: "LN-0008", status: "CLOSED", totalDue: "0", closedOn: "2026-10-29" })],
        paid: [paidItem({ amount: "1000.00" })],
        openTotal: "5258.34",
        paidTotal: "1000.00",
      }),
      calendarDay("2026-10-12", { due: [dueItem({ contractId: "c9", contractNo: "LN-0009", isOverdue: true, daysOverdue: 18, totalDue: "1450.25" })], openTotal: "1450.25" }),
      calendarDay("2026-10-05", { paid: [paidItem({ paymentId: "p2", contractNo: "LN-0002", amount: "250.00" })], paidTotal: "250.00" }),
    ]);

  it("opens on the current month with today selected, asking the API for that month", async () => {
    pinToday();
    const calls = mockApi({ "GET /admin/calendar": { body: october() } });
    render(<CalendarPage />);
    expect(await screen.findByRole("heading", { name: "ตุลาคม 2569" })).toBeInTheDocument();
    expect(calls[0]!.path).toBe("/admin/calendar?month=2026-10");
    // today's detail is already open
    expect(await screen.findByRole("heading", { name: "30 ตุลาคม 2569" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^30 ตุลาคม 2569/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("puts what is due on its day and what was paid on its day, with a plain-words label for each cell", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": { body: october() } });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    expect(screen.getByRole("button", { name: "30 ตุลาคม 2569 ครบกำหนด 2 สัญญา รับชำระ 1 รายการ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "12 ตุลาคม 2569 ครบกำหนด 1 สัญญา" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "5 ตุลาคม 2569 รับชำระ 1 รายการ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7 ตุลาคม 2569 ไม่มีรายการ" })).toBeInTheDocument();
    // all 31 days are there
    expect(screen.getAllByRole("button", { name: /ตุลาคม 2569/ })).toHaveLength(31);
  });

  it("shows the contracts due on the chosen day with what is still owed, taken from the API as it is", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": { body: october() } });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    const due = screen.getByRole("region", { name: "ครบกำหนดชำระ" });
    expect(within(due).getByText("ครบกำหนดชำระ 2 สัญญา")).toBeInTheDocument();
    expect(within(due).getByText("5,258.34 บาท", { selector: "dd" })).toBeInTheDocument(); // the API's day total
    expect(within(due).getByText("ค้าง 5,258.34 บาท")).toBeInTheDocument();
    expect(within(due).getByText(/สมหญิง รักดี/)).toBeInTheDocument();
    expect(within(due).getByText("ชำระครบแล้ว")).toBeInTheDocument(); // the settled one owes nothing
    expect(within(due).getByRole("link", { name: "LN-0007" })).toHaveAttribute("href", "/admin/contracts/c1");
    const paid = screen.getByRole("region", { name: "รับชำระ" });
    expect(within(paid).getByText("รับชำระ 1 รายการ รวม 1,000 บาท")).toBeInTheDocument();
  });

  it("opens another day when it is pressed, and flags a day that is overdue", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": { body: october() } });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    await userEvent.setup().click(screen.getByRole("button", { name: /^12 ตุลาคม 2569/ }));
    expect(screen.getByRole("heading", { name: "12 ตุลาคม 2569" })).toBeInTheDocument();
    expect(screen.getByText("เลยกำหนด 18 วัน")).toBeInTheDocument();
    expect(screen.getByText("ค้าง 1,450.25 บาท")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "รับชำระ" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^12 ตุลาคม 2569/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^30 ตุลาคม 2569/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("colours a day red when something due is overdue, amber when open, green when settled", async () => {
    pinToday();
    const cal = calendarOf("2026-10", [
      calendarDay("2026-10-12", { due: [dueItem({ isOverdue: true, daysOverdue: 18 })] }),
      calendarDay("2026-10-31", { due: [dueItem({ contractId: "c2", contractNo: "LN-2" })] }),
      calendarDay("2026-10-08", { due: [dueItem({ contractId: "c3", contractNo: "LN-3", status: "CLOSED", totalDue: "0" })] }),
    ]);
    mockApi({ "GET /admin/calendar": { body: cal } });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    const pill = (name: RegExp) => within(screen.getByRole("button", { name })).getByText(/ครบ 1/);
    expect(pill(/^12 ตุลาคม/)).toHaveClass("bg-red-600");
    expect(pill(/^31 ตุลาคม/)).toHaveClass("bg-amber-500");
    expect(pill(/^8 ตุลาคม/)).toHaveClass("bg-emerald-600");
  });

  it("says so when the chosen day has nothing on it", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": { body: october() } });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    await userEvent.setup().click(screen.getByRole("button", { name: /^7 ตุลาคม 2569/ }));
    expect(screen.getByText("ไม่มีสัญญาครบกำหนดและไม่มีการรับชำระในวันนี้")).toBeInTheDocument();
  });

  it("moves to the next and previous month (also across the year), asking the API each time", async () => {
    pinToday();
    const calls = mockApi({ "GET /admin/calendar": () => ({ body: calendarOf("2026-10", []) }) });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "ตุลาคม 2569" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "เดือนถัดไป" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/calendar?month=2026-11"));
    expect(screen.getByRole("heading", { name: "พฤศจิกายน 2569" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เดือนถัดไป" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/calendar?month=2026-12"));
    await user.click(screen.getByRole("button", { name: "เดือนถัดไป" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/calendar?month=2027-01"));
    expect(screen.getByRole("heading", { name: "มกราคม 2570" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เดือนก่อนหน้า" }));
    await waitFor(() => expect(lastPath(calls)).toBe("/admin/calendar?month=2026-12"));
  });

  it("another month starts with no day chosen, and 'back to this month' returns with today chosen", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": () => ({ body: calendarOf("2026-10", []) }) });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: "กลับไปเดือนนี้" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เดือนถัดไป" }));
    expect(await screen.findByText("กดที่วันในปฏิทินเพื่อดูรายการของวันนั้น")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "กลับไปเดือนนี้" }));
    expect(await screen.findByRole("heading", { name: "30 ตุลาคม 2569" })).toBeInTheDocument();
  });

  it("starts the first of the month on the right weekday column", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": { body: october() } });
    render(<CalendarPage />);
    await screen.findByRole("heading", { name: "30 ตุลาคม 2569" });
    const cells = screen.getByRole("group", { name: "ปฏิทิน ตุลาคม 2569" }).querySelectorAll(":scope > div:last-child > *");
    expect(cells[4]!.getAttribute("aria-label")).toMatch(/^1 ตุลาคม 2569/); // Thursday = 5th column (Sunday first)
    expect(cells[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("warns when the month had too much to show, and shows the API's message on failure", async () => {
    pinToday();
    mockApi({ "GET /admin/calendar": { body: calendarOf("2026-10", [], { truncated: true }) } });
    const first = render(<CalendarPage />);
    expect(await screen.findByText(/แสดงไม่ครบ/)).toBeInTheDocument();
    first.unmount();
    mockApi({ "GET /admin/calendar": apiError(500, "INTERNAL", "ระบบขัดข้อง") });
    render(<CalendarPage />);
    expect(await screen.findByText("ระบบขัดข้อง")).toBeInTheDocument();
  });
});
