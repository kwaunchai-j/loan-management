import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RequestPage from "@/app/me/request/page";
import SettingsPage from "@/app/admin/settings/page";
import { PaymentAccountButton } from "@/components/PaymentAccountModal";
import { PaymentSubmitCard } from "@/components/PaymentSubmitCard";
import { apiError, mockApi } from "./mocks";

const ACCOUNT = { configured: true, bankName: "ธนาคารกสิกรไทย", accountName: "นายสมชาย ใจดี", accountNo: "123-4-56789-0" };
const NONE = { configured: false, bankName: null, accountName: null, accountNo: null };
const ROUTE = "GET /me/payment-account";
const open = () => userEvent.click(screen.getByRole("button", { name: "ดูบัญชีที่ต้องโอนเงิน" }));
const dialog = () => screen.getByRole("dialog", { name: "โอนเงินเข้าบัญชีของผู้ให้กู้" });

afterEach(() => vi.unstubAllGlobals());

describe("the borrower's 'which account do I transfer to?' dialog", () => {
  it("asks the API nothing until the button is pressed", async () => {
    const calls = mockApi({ [ROUTE]: { body: ACCOUNT } });
    render(<PaymentAccountButton context="request" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the bank, the account name and the number the lender set", async () => {
    mockApi({ [ROUTE]: { body: ACCOUNT } });
    render(<PaymentAccountButton context="request" />);
    await open();
    expect(await within(dialog()).findByText("ธนาคารกสิกรไทย")).toBeInTheDocument();
    expect(within(dialog()).getByText("นายสมชาย ใจดี")).toBeInTheDocument();
    expect(within(dialog()).getByText("123-4-56789-0")).toBeInTheDocument();
    expect(within(dialog()).getByText("ธนาคาร").tagName).toBe("DT");
    expect(within(dialog()).getByText(/ตรวจชื่อบัญชีก่อนโอนทุกครั้ง/)).toBeInTheDocument();
  });

  it("explains the next step in words that fit where it was opened from", async () => {
    mockApi({ [ROUTE]: { body: ACCOUNT } });
    const { unmount } = render(<PaymentAccountButton context="request" />);
    await open();
    expect(await within(dialog()).findByText(/เมื่อผู้ให้กู้อนุมัติและโอนเงินให้แล้ว/)).toBeInTheDocument();
    unmount();
    render(<PaymentAccountButton context="payment" />);
    await open();
    expect(await within(dialog()).findByText(/แนบสลิปด้านล่างเพื่อแจ้งชำระ/)).toBeInTheDocument();
  });

  it("copies the number WITHOUT the hyphens (what a banking app expects) and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockApi({ [ROUTE]: { body: ACCOUNT } });
    render(<PaymentAccountButton context="request" />);
    await open();
    await userEvent.click(await within(dialog()).findByRole("button", { name: "คัดลอกเลขบัญชี" }));
    expect(writeText).toHaveBeenCalledWith("1234567890");
    expect(await within(dialog()).findByText("คัดลอกเลขบัญชีแล้ว")).toBeInTheDocument();
  });

  it("when copying is not possible it says to write the number down, instead of pretending", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    mockApi({ [ROUTE]: { body: ACCOUNT } });
    render(<PaymentAccountButton context="request" />);
    await open();
    await userEvent.click(await within(dialog()).findByRole("button", { name: "คัดลอกเลขบัญชี" }));
    expect(await within(dialog()).findByText(/คัดลอกอัตโนมัติไม่ได้/)).toBeInTheDocument();
    expect(within(dialog()).queryByText("คัดลอกเลขบัญชีแล้ว")).not.toBeInTheDocument();
  });

  it("tells the borrower to contact the lender when no account is set, and offers no copy button", async () => {
    mockApi({ [ROUTE]: { body: NONE } });
    render(<PaymentAccountButton context="request" />);
    await open();
    expect(await within(dialog()).findByText(/ผู้ให้กู้ยังไม่ได้ตั้งบัญชีรับโอน/)).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: "คัดลอกเลขบัญชี" })).not.toBeInTheDocument();
  });

  it("shows the API's error, not a blank box", async () => {
    mockApi({ [ROUTE]: apiError(403, "PDPA_REQUIRED", "กรุณายอมรับข้อกำหนดก่อน") });
    render(<PaymentAccountButton context="request" />);
    await open();
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("กรุณายอมรับข้อกำหนดก่อน");
  });

  it("asks again each time it opens, so a change the lender made is seen at once", async () => {
    let bank = "ธนาคารกสิกรไทย";
    const calls = mockApi({ [ROUTE]: () => ({ body: { ...ACCOUNT, bankName: bank } }) });
    render(<PaymentAccountButton context="request" />);
    await open();
    expect(await within(dialog()).findByText("ธนาคารกสิกรไทย")).toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole("button", { name: "ปิด" }));
    bank = "ธนาคารออมสิน";
    await open();
    expect(await within(dialog()).findByText("ธนาคารออมสิน")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });

  it("clears an old 'copied' message when it is opened again", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
    mockApi({ [ROUTE]: { body: ACCOUNT } });
    render(<PaymentAccountButton context="request" />);
    await open();
    await userEvent.click(await within(dialog()).findByRole("button", { name: "คัดลอกเลขบัญชี" }));
    await within(dialog()).findByText("คัดลอกเลขบัญชีแล้ว");
    await userEvent.keyboard("{Escape}");
    await open();
    await within(dialog()).findByText("ธนาคารกสิกรไทย");
    expect(within(dialog()).queryByText("คัดลอกเลขบัญชีแล้ว")).not.toBeInTheDocument();
  });
});

describe("where the button is", () => {
  it("is on the loan request page, and opens the account from there", async () => {
    mockApi({ "GET /me/loan-requests": { body: { items: [] } }, [ROUTE]: { body: ACCOUNT } });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await open();
    expect(await within(dialog()).findByText("123-4-56789-0")).toBeInTheDocument();
  });

  it("is on the payment-slip form of a contract, and opens the account from there", async () => {
    mockApi({ "GET /me/payment-submissions": { body: { items: [] } }, [ROUTE]: { body: ACCOUNT } });
    render(<PaymentSubmitCard contractId="c1" disbursedOn="2026-10-01" />);
    await screen.findByText("ยังไม่เคยส่งสลิปของสัญญานี้");
    await open();
    expect(await within(dialog()).findByText("ธนาคารกสิกรไทย")).toBeInTheDocument();
    expect(within(dialog()).getByText(/แนบสลิปด้านล่างเพื่อแจ้งชำระ/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the admin sets the account (settings page)", () => {
  const unsetRates = { interestRatePctPerMonth: "5", lateFeeRatePctPerDay: "1", updatedAt: "2026-10-01T03:00:00.000Z", updatedBy: { id: "u1", username: "boss" } };
  const empty = { bankName: null, accountName: null, accountNo: null, updatedAt: null, updatedBy: null };
  const set = { bankName: "ธนาคารกสิกรไทย", accountName: "นายสมชาย ใจดี", accountNo: "123-4-56789-0", updatedAt: "2026-10-02T03:00:00.000Z", updatedBy: { id: "u1", username: "boss" } };
  const card = async () => (await screen.findByRole("heading", { name: "บัญชีรับโอนของผู้ให้กู้" })).closest("section")!;
  const put = (calls: ReturnType<typeof mockApi>) => calls.filter((c) => c.method === "PUT");

  it("warns when no account is set, and saves the first account at once (no confirm), sending trimmed text", async () => {
    let body: unknown = empty;
    const calls = mockApi({
      "GET /admin/settings": { body: unsetRates },
      "GET /admin/payment-account": () => ({ body }),
      "PUT /admin/payment-account": (c) => {
        body = { ...(c.body as object), updatedAt: "2026-10-31T03:00:00.000Z", updatedBy: { id: "u1", username: "boss" } };
        return { body };
      },
    });
    render(<SettingsPage />);
    const c = await card();
    expect(await within(c).findByText(/ยังไม่ได้ตั้งบัญชีรับโอน/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(within(c).getByLabelText("ธนาคาร"), "  ธนาคารไทยพาณิชย์ ");
    await user.type(within(c).getByLabelText("ชื่อบัญชี"), "บริษัท ตัวอย่าง จำกัด");
    await user.type(within(c).getByLabelText("เลขบัญชี"), "987-6-54321-0");
    await user.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    expect(await screen.findByText(/บันทึกบัญชีรับโอนแล้ว/)).toBeInTheDocument();
    expect(put(calls)[0]!.body).toEqual({ bankName: "ธนาคารไทยพาณิชย์", accountName: "บริษัท ตัวอย่าง จำกัด", accountNo: "987-6-54321-0" });
    expect(within(await card()).queryByText(/ยังไม่ได้ตั้งบัญชีรับโอน/)).not.toBeInTheDocument();
  });

  it("explains a mistake in each box before calling the API", async () => {
    const calls = mockApi({ "GET /admin/settings": { body: unsetRates }, "GET /admin/payment-account": { body: empty } });
    render(<SettingsPage />);
    const c = await card();
    const user = userEvent.setup();
    await user.type(await within(c).findByLabelText("ธนาคาร"), "ธนาคารกรุงเทพ");
    await user.type(within(c).getByLabelText("เลขบัญชี"), "12-ab");
    await user.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    expect(await within(c).findByText("กรุณากรอกชื่อบัญชี")).toBeInTheDocument();
    expect(within(c).getByText(/เลขบัญชีต้องเป็นตัวเลข 5–30 หลัก/)).toBeInTheDocument();
    expect(put(calls)).toHaveLength(0);
  });

  it("shows the saved account, says nothing changed when nothing did, and does not call the API", async () => {
    const calls = mockApi({ "GET /admin/settings": { body: unsetRates }, "GET /admin/payment-account": { body: set } });
    render(<SettingsPage />);
    const c = await card();
    expect(await within(c).findByLabelText("ธนาคาร")).toHaveValue("ธนาคารกสิกรไทย");
    expect(within(c).getByLabelText("เลขบัญชี")).toHaveValue("123-4-56789-0");
    expect(within(c).getByText(/โดย boss/)).toBeInTheDocument();
    await userEvent.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    expect(await within(c).findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(put(calls)).toHaveLength(0);
  });

  it("changing an account in use needs a second click that shows from-and-to; 'cancel' sends nothing", async () => {
    const calls = mockApi({ "GET /admin/settings": { body: unsetRates }, "GET /admin/payment-account": { body: set }, "PUT /admin/payment-account": { body: set } });
    render(<SettingsPage />);
    const c = await card();
    const user = userEvent.setup();
    const number = await within(c).findByLabelText("เลขบัญชี");
    await user.clear(number);
    await user.type(number, "555-5-55555-5");
    await user.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    expect(await within(c).findByText(/เปลี่ยนบัญชีรับโอน\?/)).toBeInTheDocument();
    expect(within(c).getByText(/จาก ธนาคารกสิกรไทย · นายสมชาย ใจดี · 123-4-56789-0/)).toBeInTheDocument();
    expect(within(c).getByText(/555-5-55555-5/)).toBeInTheDocument();
    expect(put(calls)).toHaveLength(0);
    await user.click(within(c).getByRole("button", { name: "ยกเลิก" }));
    expect(put(calls)).toHaveLength(0);
    await user.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    await user.click(await within(c).findByRole("button", { name: "ยืนยัน เปลี่ยนบัญชี" }));
    await waitFor(() => expect(put(calls)).toHaveLength(1));
    expect(put(calls)[0]!.body).toEqual({ bankName: "ธนาคารกสิกรไทย", accountName: "นายสมชาย ใจดี", accountNo: "555-5-55555-5" });
  });

  it("emptying all three boxes removes the account, after a confirm", async () => {
    const calls = mockApi({ "GET /admin/settings": { body: unsetRates }, "GET /admin/payment-account": { body: set }, "PUT /admin/payment-account": { body: empty } });
    render(<SettingsPage />);
    const c = await card();
    const user = userEvent.setup();
    for (const label of ["ธนาคาร", "ชื่อบัญชี", "เลขบัญชี"]) await user.clear(await within(c).findByLabelText(label));
    await user.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    expect(await within(c).findByText(/ลบบัญชีรับโอน\?/)).toBeInTheDocument();
    expect(put(calls)).toHaveLength(0);
    await user.click(within(c).getByRole("button", { name: "ยืนยัน ลบบัญชี" }));
    await waitFor(() => expect(put(calls)).toHaveLength(1));
    expect(put(calls)[0]!.body).toEqual({ bankName: null, accountName: null, accountNo: null });
    expect(await screen.findByText("ลบบัญชีรับโอนแล้ว")).toBeInTheDocument();
  });

  it("shows the API's refusal instead of saving silently", async () => {
    mockApi({
      "GET /admin/settings": { body: unsetRates },
      "GET /admin/payment-account": { body: empty },
      "PUT /admin/payment-account": apiError(400, "VALIDATION_ERROR", "เลขบัญชีต้องเป็นตัวเลข 5–30 หลัก (คั่นด้วยช่องว่างหรือขีดได้)"),
    });
    render(<SettingsPage />);
    const c = await card();
    const user = userEvent.setup();
    await user.type(await within(c).findByLabelText("ธนาคาร"), "ธนาคารกรุงเทพ");
    await user.type(within(c).getByLabelText("ชื่อบัญชี"), "นายทดสอบ");
    await user.type(within(c).getByLabelText("เลขบัญชี"), "12345");
    await user.click(within(c).getByRole("button", { name: "บันทึกบัญชี" }));
    expect(await within(c).findByRole("alert")).toHaveTextContent("เลขบัญชีต้องเป็นตัวเลข");
  });
});
