import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ContractsPage from "@/app/admin/contracts/page";
import { mockApi, apiError } from "./mocks";
import { adminList, adminListItem } from "./fixtures";

describe("contract list", () => {
  it("shows each contract with its status, due date and what is owed", async () => {
    mockApi({
      "GET /admin/contracts": {
        body: adminList([
          adminListItem(),
          adminListItem({ id: "c2", contractNo: "LN-0002", status: "AWAITING_DISBURSEMENT", disbursedOn: null, totalDue: null }),
          adminListItem({ id: "c3", contractNo: "LN-0003", isOverdue: true, daysOverdue: 4, totalDue: "1100.00", isImported: true }),
        ]),
      },
    });
    render(<ContractsPage />);
    expect(await screen.findByText("LN-0001 · สมชาย ใจดี")).toBeInTheDocument();
    expect(screen.getByText("ยอดที่ต้องชำระ 1,020 บาท")).toBeInTheDocument();
    const rows = within(screen.getByRole("list"));
    expect(rows.getByText("รอจ่ายเงิน")).toBeInTheDocument();
    expect(screen.getByText("เลยกำหนด 4 วัน")).toBeInTheDocument();
    expect(screen.getByText("นำเข้า")).toBeInTheDocument();
    // the one waiting for its payout has no amount owed
    expect(screen.getAllByText(/ยอดที่ต้องชำระ/)).toHaveLength(2);
    expect(document.querySelector('a[href="/admin/contracts/c2"]')).not.toBeNull();
  });

  it("says so when nothing matches", async () => {
    mockApi({ "GET /admin/contracts": { body: adminList([]) } });
    render(<ContractsPage />);
    expect(await screen.findByText("ไม่พบสัญญา")).toBeInTheDocument();
  });

  it("passes the filters to the API", async () => {
    const calls = mockApi({ "GET /admin/contracts": { body: adminList([]) } });
    render(<ContractsPage />);
    await screen.findByText("ไม่พบสัญญา");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("สถานะ"), "ACTIVE");
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("status=ACTIVE"));
    await user.click(screen.getByLabelText("เฉพาะที่เลยกำหนดชำระ"));
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("overdue=true"));
    await user.selectOptions(screen.getByLabelText("เรียงตาม"), "dueDate");
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("sort=dueDate"));
    await user.type(screen.getByLabelText("ค้นหาเลขสัญญาหรือชื่อผู้ยืม"), "LN-00");
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("q=LN-00"));
    // by default nothing is filtered
    expect(calls[0]!.path).not.toMatch(/status=|overdue=|q=/);
  });

  it("returns to the first page whenever the filter changes", async () => {
    const items = Array.from({ length: 20 }, (_, i) => adminListItem({ id: `c${i}`, contractNo: `LN-${i}` }));
    const calls = mockApi({ "GET /admin/contracts": { body: adminList(items, 45) } });
    render(<ContractsPage />);
    await screen.findByText("LN-0 · สมชาย ใจดี");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ถัดไป" }));
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("offset=20"));
    await user.selectOptions(screen.getByLabelText("สถานะ"), "CLOSED");
    await waitFor(() => expect(calls[calls.length - 1]!.path).toMatch(/offset=0.*status=CLOSED|status=CLOSED.*offset=0/));
  });

  it("a click on next right after the page opens is not undone by the search timer", async () => {
    const items = Array.from({ length: 20 }, (_, i) => adminListItem({ id: `c${i}`, contractNo: `LN-${i}` }));
    const calls = mockApi({ "GET /admin/contracts": { body: adminList(items, 45) } });
    render(<ContractsPage />);
    await screen.findByText("LN-0 · สมชาย ใจดี");
    await userEvent.setup().click(screen.getByRole("button", { name: "ถัดไป" }));
    await new Promise((r) => setTimeout(r, 600)); // longer than the 300 ms search pause
    expect(calls[calls.length - 1]!.path).toContain("offset=20");
  });

  it("shows the API's message on failure", async () => {
    mockApi({ "GET /admin/contracts": apiError(500, "INTERNAL", "ระบบขัดข้อง") });
    render(<ContractsPage />);
    expect(await screen.findByText("ระบบขัดข้อง")).toBeInTheDocument();
  });
});
