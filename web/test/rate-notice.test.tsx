import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import BorrowerLayout from "@/app/me/layout";
import RequestPage from "@/app/me/request/page";
import { useRateNotice } from "@/lib/rate-notice-store";
import { rateNoticeSchema } from "@/lib/schemas";
import { useSession } from "@/lib/session-store";
import { apiError, borrowerUser, mockApi, pathnameMock, valid } from "./mocks";

const ME = { "GET /auth/me": { body: { user: borrowerUser } } };
const NONE = { required: false, seq: null, interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, changedAt: null };
const notice = (over: Record<string, unknown> = {}) =>
  valid(rateNoticeSchema, {
    required: true,
    seq: 7,
    interestRatePctPerMonth: { from: "3", to: "4" },
    lateFeeRatePctPerDay: { from: "1", to: "2" },
    changedAt: "2026-11-09T05:00:00.000Z",
    ...over,
  });
const REQUESTS = { "GET /me/loan-requests": { body: { items: [] } } };

beforeEach(() => {
  useRateNotice.getState().reset();
  useSession.setState({ status: "authenticated", user: borrowerUser });
  pathnameMock.value = "/me/request";
});

function renderPages() {
  return render(
    <BorrowerLayout>
      <RequestPage />
    </BorrowerLayout>,
  );
}

describe("the rate-adjustment notice (CR-9)", () => {
  it("opens a dialog with the old and the new interest and late-fee rates when the lender adjusted them", async () => {
    mockApi({ ...ME, ...REQUESTS, "GET /me/rate-notice": { body: notice() } });
    renderPages();
    const dialog = await screen.findByRole("dialog", { name: "ผู้ให้กู้ปรับอัตราดอกเบี้ยและค่าปรับ" });
    expect(within(dialog).getByLabelText("เดิม 3% ต่อเดือน")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("ใหม่ 4% ต่อเดือน")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("เดิม 1% ต่อวัน")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("ใหม่ 2% ต่อวัน")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("9 พ.ย. 2569");
    expect(within(dialog).getAllByText("เพิ่มขึ้น")).toHaveLength(2);
  });

  it("names only the rate that moved", async () => {
    mockApi({ ...ME, ...REQUESTS, "GET /me/rate-notice": { body: notice({ lateFeeRatePctPerDay: null, interestRatePctPerMonth: { from: "4", to: "3" } }) } });
    renderPages();
    const dialog = await screen.findByRole("dialog", { name: "ผู้ให้กู้ปรับอัตราดอกเบี้ย" });
    expect(within(dialog).getByText("ลดลง")).toBeInTheDocument();
    expect(within(dialog).queryByText(/อัตราค่าปรับ/)).not.toBeInTheDocument();
  });

  it("stays out of the way when there is nothing to acknowledge", async () => {
    mockApi({ ...ME, ...REQUESTS, "GET /me/rate-notice": { body: NONE } });
    renderPages();
    expect(await screen.findByRole("button", { name: "ส่งคำขอ" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends the adjustment it showed when the borrower presses รับทราบ, then closes and opens the form", async () => {
    const calls = mockApi({
      ...ME,
      ...REQUESTS,
      "GET /me/rate-notice": { body: notice() },
      "POST /me/rate-notice/acknowledge": { body: NONE },
    });
    renderPages();
    await userEvent.click(await screen.findByRole("button", { name: "รับทราบ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.find((c) => c.path === "/me/rate-notice/acknowledge")?.body).toEqual({ seq: 7 });
    expect(screen.getByRole("button", { name: "ส่งคำขอ" })).toBeEnabled();
    expect(screen.queryByText(/กรุณารับทราบอัตราใหม่/)).not.toBeInTheDocument();
  });

  it("'ไว้ทีหลัง' only closes it: the request form stays held back, with a way to open the dialog again", async () => {
    mockApi({ ...ME, ...REQUESTS, "GET /me/rate-notice": { body: notice() } });
    renderPages();
    await userEvent.click(await screen.findByRole("button", { name: "ไว้ทีหลัง" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ส่งคำขอ" })).toBeDisabled();
    expect(screen.getByText(/กรุณารับทราบอัตราใหม่ก่อนส่งคำขอ/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ดูอัตราใหม่และกดรับทราบ" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the dialog open with the reason when saving the acknowledgement fails", async () => {
    mockApi({
      ...ME,
      ...REQUESTS,
      "GET /me/rate-notice": { body: notice() },
      "POST /me/rate-notice/acknowledge": apiError(500, "INTERNAL_ERROR", "บันทึกไม่ได้"),
    });
    renderPages();
    await userEvent.click(await screen.findByRole("button", { name: "รับทราบ" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("บันทึกไม่ได้");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows the newer figures when the lender adjusted again before the borrower pressed รับทราบ", async () => {
    mockApi({
      ...ME,
      ...REQUESTS,
      "GET /me/rate-notice": { body: notice() },
      "POST /me/rate-notice/acknowledge": { body: notice({ seq: 8, lateFeeRatePctPerDay: null, interestRatePctPerMonth: { from: "4", to: "5" } }) },
    });
    renderPages();
    await userEvent.click(await screen.findByRole("button", { name: "รับทราบ" }));
    const dialog = await screen.findByRole("dialog", { name: "ผู้ให้กู้ปรับอัตราดอกเบี้ย" });
    expect(within(dialog).getByLabelText("ใหม่ 5% ต่อเดือน")).toBeInTheDocument();
  });

  it("asks again, and shows the dialog, when the API refuses a request because an adjustment was made meanwhile", async () => {
    let asked = 0;
    mockApi({
      ...ME,
      ...REQUESTS,
      "GET /me/rate-notice": () => ({ body: ++asked === 1 ? NONE : notice() }),
      "POST /loan-requests": apiError(409, "RATE_NOTICE_REQUIRED", "ผู้ให้กู้ปรับอัตรา กรุณากดรับทราบ"),
    });
    renderPages();
    await userEvent.type(await screen.findByLabelText(/จำนวนเงินที่ต้องการยืม/), "1000");
    await userEvent.type(screen.getByLabelText("วันที่จะคืนเงิน"), "2099-12-31");
    await userEvent.click(screen.getByRole("button", { name: "ส่งคำขอ" }));
    expect(await screen.findByRole("dialog", { name: "ผู้ให้กู้ปรับอัตราดอกเบี้ยและค่าปรับ" })).toBeInTheDocument();
  });

  it("does not stop the borrower from using the app when the notice cannot be loaded", async () => {
    mockApi({ ...ME, ...REQUESTS, "GET /me/rate-notice": apiError(500, "INTERNAL_ERROR", "พัง") });
    renderPages();
    expect(await screen.findByRole("button", { name: "ส่งคำขอ" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
