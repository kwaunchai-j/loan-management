import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import BorrowerHome from "@/app/me/page";
import ProfilePage from "@/app/me/profile/page";
import RequestPage from "@/app/me/request/page";
import { profileSchema, type Profile } from "@/lib/schemas";
import { apiError, mockApi, valid } from "./mocks";

const profile = (over: Partial<Profile> = {}) =>
  valid(profileSchema, {
    username: "somchai",
    fullName: "สมชาย ใจดี",
    phone: null,
    bankName: null,
    bankAccountNo: null,
    profileComplete: false,
    pdpaAcceptedAt: "2026-10-01T03:00:00.000Z",
    pdpaVersion: "1",
    ...over,
  });
const COMPLETE = { phone: "081-234-5678", bankName: "ธนาคารกสิกรไทย", bankAccountNo: "123-4-56789-0", profileComplete: true };
const GET = "GET /me/profile";
const patches = (calls: ReturnType<typeof mockApi>) => calls.filter((c) => c.method === "PATCH");

describe("ข้อมูลของฉัน (the borrower's own details)", () => {
  it("shows the name and login as plain text (only the lender changes the name), and asks for the three details", async () => {
    mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    expect(await screen.findByText("สมชาย ใจดี")).toBeInTheDocument();
    expect(screen.getByText("somchai")).toBeInTheDocument();
    expect(screen.queryByLabelText(/ชื่อ-นามสกุล/)).not.toBeInTheDocument(); // no box to type the name in
    expect(screen.getByText("ยังกรอกไม่ครบ")).toBeInTheDocument();
    expect(screen.getByText(/ต้องกรอกทั้ง 3 ช่องก่อนจึงจะขอยืมเงินได้/)).toBeInTheDocument();
    expect(screen.getByLabelText("เบอร์โทรศัพท์")).toHaveValue("");
  });

  it("shows what is already there, and says it is complete with a way on to the loan request", async () => {
    mockApi({ [GET]: { body: profile(COMPLETE) } });
    render(<ProfilePage />);
    expect(await screen.findByLabelText("เบอร์โทรศัพท์")).toHaveValue("081-234-5678");
    expect(screen.getByLabelText("ธนาคารที่รับเงิน")).toHaveValue("ธนาคารกสิกรไทย");
    expect(screen.getByLabelText("เลขบัญชี")).toHaveValue("123-4-56789-0");
    expect(screen.getByText("กรอกครบแล้ว")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ไปขอยืมเงิน" })).toHaveAttribute("href", "/me/request");
  });

  it("saves the three details, sends them trimmed, and then shows the profile as complete", async () => {
    let current = profile();
    const calls = mockApi({
      [GET]: () => ({ body: current }),
      "PATCH /me/profile": (c) => {
        current = profile({ ...(c.body as object), profileComplete: true });
        return { body: current };
      },
    });
    render(<ProfilePage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("เบอร์โทรศัพท์"), " 089-111-2222 ");
    await user.type(screen.getByLabelText("ธนาคารที่รับเงิน"), "ธนาคารไทยพาณิชย์");
    await user.type(screen.getByLabelText("เลขบัญชี"), "987-6-54321-0");
    await user.click(screen.getByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByText("บันทึกข้อมูลของคุณแล้ว")).toBeInTheDocument();
    expect(patches(calls)[0]!.body).toEqual({ phone: "089-111-2222", bankName: "ธนาคารไทยพาณิชย์", bankAccountNo: "987-6-54321-0" });
    expect(await screen.findByText("กรอกครบแล้ว")).toBeInTheDocument();
  });

  it("explains a mistake in each box and calls nothing", async () => {
    const calls = mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("เบอร์โทรศัพท์"), "abc");
    await user.type(screen.getByLabelText("เลขบัญชี"), "12ab");
    await user.click(screen.getByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByText(/เบอร์โทรศัพท์ไม่ถูกต้อง/)).toBeInTheDocument();
    expect(screen.getByText("กรุณากรอกชื่อธนาคาร")).toBeInTheDocument();
    expect(screen.getByText(/เลขบัญชีไม่ถูกต้อง/)).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });

  it("sends only what changed, and says so when nothing did", async () => {
    const calls = mockApi({ [GET]: { body: profile(COMPLETE) }, "PATCH /me/profile": { body: profile({ ...COMPLETE, phone: "089-999-9999" }) } });
    render(<ProfilePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
    const phone = screen.getByLabelText("เบอร์โทรศัพท์");
    await user.clear(phone);
    await user.type(phone, "089-999-9999");
    await user.click(screen.getByRole("button", { name: "บันทึกข้อมูล" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).toEqual({ phone: "089-999-9999" });
  });

  it("shows the API's refusal instead of saving silently", async () => {
    mockApi({ [GET]: { body: profile(COMPLETE) }, "PATCH /me/profile": apiError(400, "VALIDATION_ERROR", "เลขบัญชีไม่ถูกต้อง") });
    render(<ProfilePage />);
    const user = userEvent.setup();
    const account = await screen.findByLabelText("เลขบัญชี");
    await user.clear(account);
    await user.type(account, "1234567");
    await user.click(screen.getByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("เลขบัญชีไม่ถูกต้อง");
  });

  it("shows an error when the profile cannot be loaded, not an empty form", async () => {
    mockApi({ [GET]: apiError(500, "INTERNAL_ERROR", "พัง") });
    render(<ProfilePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("พัง");
    expect(screen.queryByRole("button", { name: "บันทึกข้อมูล" })).not.toBeInTheDocument();
  });
});

describe("the reminder on the borrower's home page", () => {
  const home = (p: Profile | Error) =>
    mockApi({
      "GET /me/contracts": { body: { items: [] } },
      "GET /me/loan-requests": { body: { items: [] } },
      [GET]: p instanceof Error ? p : { body: p },
    });

  it("asks the borrower to fill in their details, with a link to the page, while they are incomplete", async () => {
    home(profile());
    render(<BorrowerHome />);
    expect(await screen.findByText(/กรุณากรอกเบอร์โทรศัพท์และเลขบัญชีของคุณก่อนขอยืมเงิน/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "กรอกข้อมูลของฉัน" })).toHaveAttribute("href", "/me/profile");
  });

  it("says nothing once they are complete", async () => {
    home(profile(COMPLETE));
    render(<BorrowerHome />);
    await screen.findByText("ตอนนี้ไม่มีสัญญาที่ต้องชำระ");
    expect(screen.queryByText(/กรุณากรอกเบอร์โทรศัพท์และเลขบัญชีของคุณก่อนขอยืมเงิน/)).not.toBeInTheDocument();
  });

  it("does not nag when the profile could not be read (the API still enforces the rule)", async () => {
    home(new Error("offline"));
    render(<BorrowerHome />);
    await screen.findByText("ตอนนี้ไม่มีสัญญาที่ต้องชำระ");
    expect(screen.queryByText(/กรุณากรอกเบอร์โทรศัพท์และเลขบัญชีของคุณก่อนขอยืมเงิน/)).not.toBeInTheDocument();
  });
});

describe("the loan request form needs the details first", () => {
  const send = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText(/จำนวนเงินที่ต้องการยืม/), "1000");
    await user.type(screen.getByLabelText("วันที่จะคืนเงิน"), "2099-12-01");
    await user.click(screen.getByRole("button", { name: "ส่งคำขอ" }));
  };
  const base = (p: Profile | Error) => ({
    "GET /me/loan-requests": { body: { items: [] } },
    "GET /loan-requests/interest-estimate": apiError(409, "RATES_NOT_SET", "ยังคำนวณไม่ได้"),
    "GET /me/payment-account": { body: { configured: false, bankName: null, accountName: null, accountNo: null } },
    [GET]: p instanceof Error ? p : { body: p },
  });

  it("while the details are incomplete: explains why, links to the page, and the send button is off", async () => {
    const calls = mockApi(base(profile()));
    render(<RequestPage />);
    expect(await screen.findByText("ยังส่งคำขอไม่ได้ เพราะข้อมูลของคุณยังไม่ครบ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "กรอกข้อมูลของฉัน" })).toHaveAttribute("href", "/me/profile");
    const button = screen.getByRole("button", { name: "ส่งคำขอ" });
    expect(button).toBeDisabled();
    await userEvent.setup({ pointerEventsCheck: 0 }).click(button);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("when complete: no warning, and the request is sent", async () => {
    const calls = mockApi({
      ...base(profile(COMPLETE)),
      "POST /loan-requests": { status: 201, body: { id: "r1", borrower: { id: "b1", fullName: "x" }, amount: "1000", requestedDueDate: "2099-12-01", status: "PENDING", createdById: "u", decidedById: null, decidedAt: null, rejectReason: null, createdAt: "2026-10-31T05:00:00.000Z", contract: null } },
    });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    expect(screen.queryByText("ยังส่งคำขอไม่ได้ เพราะข้อมูลของคุณยังไม่ครบ")).not.toBeInTheDocument();
    await send(userEvent.setup());
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/loan-requests")).toBe(true));
  });

  it("shows the server's PROFILE_INCOMPLETE answer if the page did not know (the rule is enforced by the API)", async () => {
    mockApi({
      ...base(new Error("offline")),
      "POST /loan-requests": apiError(409, "PROFILE_INCOMPLETE", 'กรุณากรอกเบอร์โทรศัพท์ ธนาคาร และเลขบัญชีของคุณที่เมนู "ข้อมูลของฉัน" ก่อนส่งคำขอยืมเงิน'),
    });
    render(<RequestPage />);
    await screen.findByText("ยังไม่เคยส่งคำขอ");
    await send(userEvent.setup());
    expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent("ข้อมูลของฉัน");
  });
});
