import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import BorrowerDetailPage from "@/app/admin/borrowers/[id]/page";
import NewBorrowerPage from "@/app/admin/borrowers/new/page";
import BorrowersPage from "@/app/admin/borrowers/page";
import { apiError, mockApi } from "./mocks";

const account = { userId: "u9", username: "somchai", isActive: true, mustChangePassword: true };
const somchai = {
  id: "b1",
  fullName: "สมชาย ใจดี",
  phone: "0812345678",
  bankName: "กสิกรไทย",
  bankAccountNo: "123-4-56789-0",
  pdpaAcceptedAt: null,
  pdpaVersion: null,
  createdAt: "2025-03-01T03:00:00.000Z",
  account,
};
const imported = { ...somchai, id: "b2", fullName: "สมหญิง นำเข้า", account: null, phone: null, bankName: null, bankAccountNo: null };

async function openDetail(id = "b1") {
  const params = Promise.resolve({ id });
  // React's use(params) suspends once; rendering inside an async act lets it settle
  await act(async () => {
    render(
      <Suspense fallback="loading">
        <BorrowerDetailPage params={params} />
      </Suspense>,
    );
  });
}

describe("borrower list", () => {
  it("lists borrowers with the account number masked and the status in words", async () => {
    mockApi({
      "GET /admin/borrowers": {
        body: { total: 3, items: [somchai, { ...somchai, id: "b3", fullName: "ปิดแล้ว", account: { ...account, isActive: false } }, imported] },
      },
    });
    render(<BorrowersPage />);
    expect(await screen.findByText("สมชาย ใจดี")).toBeInTheDocument();
    expect(screen.getByText("ใช้งานอยู่")).toBeInTheDocument();
    expect(screen.getByText("ปิดใช้งาน")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่มีบัญชี (นำเข้า)")).toBeInTheDocument();
    expect(document.body.textContent).toContain("****7890");
    expect(document.body.textContent).not.toContain("123-4-56789-0");
    expect(screen.getAllByText(/ยังไม่ยอมรับเงื่อนไขข้อมูลส่วนบุคคล/).length).toBe(2); // the two with an account
  });

  it("explains an empty list and offers to add the first borrower", async () => {
    mockApi({ "GET /admin/borrowers": { body: { total: 0, items: [] } } });
    render(<BorrowersPage />);
    expect(await screen.findByText(/ยังไม่มีผู้ยืม/)).toBeInTheDocument();
    expect(document.querySelector('a[href="/admin/borrowers/new"]')).not.toBeNull();
  });

  it("searches by name after a short pause and goes back to the first page", async () => {
    const calls = mockApi({ "GET /admin/borrowers": { body: { total: 0, items: [] } } });
    render(<BorrowersPage />);
    await screen.findByText(/ยังไม่มีผู้ยืม/);
    await userEvent.setup().type(screen.getByLabelText("ค้นหาตามชื่อ"), "สม");
    await waitFor(() => expect(calls.some((c) => c.path.includes("q=%E0%B8%AA%E0%B8%A1"))).toBe(true));
    expect(await screen.findByText(/ไม่พบผู้ยืมที่ชื่อมีคำว่า/)).toBeInTheDocument();
    expect(calls[calls.length - 1]!.path).toContain("offset=0");
  });

  it("pages through the list 20 at a time", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ ...somchai, id: `b${i}`, fullName: `คนที่ ${i}` }));
    const calls = mockApi({ "GET /admin/borrowers": { body: { total: 45, items } } });
    render(<BorrowersPage />);
    await screen.findByText("คนที่ 0");
    expect(screen.getByText(/แสดง 1–20 จาก 45 คน/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ก่อนหน้า" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "ถัดไป" }));
    await waitFor(() => expect(calls[calls.length - 1]!.path).toContain("offset=20"));
    expect(calls[0]!.path).toContain("limit=20");
  });

  it("a click on next right after the page opens is not undone by the search timer", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ ...somchai, id: `b${i}`, fullName: `คนที่ ${i}` }));
    const calls = mockApi({ "GET /admin/borrowers": { body: { total: 45, items } } });
    render(<BorrowersPage />);
    await screen.findByText("คนที่ 0");
    await userEvent.setup().click(screen.getByRole("button", { name: "ถัดไป" }));
    await new Promise((r) => setTimeout(r, 600));
    expect(calls[calls.length - 1]!.path).toContain("offset=20");
  });

  it("shows the API's message on failure", async () => {
    mockApi({ "GET /admin/borrowers": apiError(500, "INTERNAL", "ระบบขัดข้อง") });
    render(<BorrowersPage />);
    expect(await screen.findByText("ระบบขัดข้อง")).toBeInTheDocument();
  });
});

describe("create borrower", () => {
  async function fillAll(overrides: Partial<Record<string, string>> = {}) {
    const user = userEvent.setup();
    const v = { name: "สมชาย ใจดี", phone: "0812345678", bank: "กสิกรไทย", acct: "123-4-56789-0", username: "somchai", password: "temp-pass-12345", ...overrides };
    await user.type(screen.getByLabelText("ชื่อ-นามสกุล"), v.name);
    await user.type(screen.getByLabelText("เบอร์โทรศัพท์"), v.phone);
    await user.type(screen.getByLabelText("ธนาคารที่รับเงิน"), v.bank);
    await user.type(screen.getByLabelText("เลขบัญชี"), v.acct);
    await user.type(screen.getByLabelText("ชื่อผู้ใช้"), v.username);
    await user.type(screen.getByLabelText("รหัสผ่านชั่วคราว"), v.password);
    return user;
  }

  it("creates the borrower and shows the temporary password once", async () => {
    const calls = mockApi({ "POST /admin/borrowers": { status: 201, body: somchai } });
    render(<NewBorrowerPage />);
    const user = await fillAll();
    await user.click(screen.getByRole("button", { name: "สร้างบัญชีผู้ยืม" }));
    expect(await screen.findByText("สร้างผู้ยืมแล้ว")).toBeInTheDocument();
    expect(calls[0]!.body).toEqual({
      fullName: "สมชาย ใจดี",
      phone: "0812345678",
      bankName: "กสิกรไทย",
      bankAccountNo: "123-4-56789-0",
      username: "somchai",
      password: "temp-pass-12345",
    });
    expect(screen.getByText("temp-pass-12345")).toBeInTheDocument();
    expect(screen.getByText(/ดูรหัสผ่านนี้อีกไม่ได้/)).toBeInTheDocument();
    expect(document.querySelector('a[href="/admin/borrowers/b1"]')).not.toBeNull();
  });

  it("requires every field and calls nothing while any is wrong", async () => {
    const calls = mockApi({});
    render(<NewBorrowerPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "สร้างบัญชีผู้ยืม" }));
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThanOrEqual(4);
    expect(calls).toHaveLength(0);
  });

  it("checks the password length of the account", async () => {
    const calls = mockApi({});
    render(<NewBorrowerPage />);
    const user = await fillAll({ password: "short" });
    await user.click(screen.getByRole("button", { name: "สร้างบัญชีผู้ยืม" }));
    expect(await screen.findByText(/อย่างน้อย 10/, { selector: "[role=alert] div, [role=alert]" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("the generator fills a password that passes the length check", async () => {
    mockApi({});
    render(<NewBorrowerPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "สุ่มรหัสผ่าน" }));
    expect((screen.getByLabelText("รหัสผ่านชั่วคราว") as HTMLInputElement).value).toHaveLength(12);
  });

  it("shows 'username taken' from the API and keeps the form", async () => {
    mockApi({ "POST /admin/borrowers": apiError(409, "USERNAME_TAKEN", "ชื่อผู้ใช้นี้ถูกใช้แล้ว") });
    render(<NewBorrowerPage />);
    const user = await fillAll();
    await user.click(screen.getByRole("button", { name: "สร้างบัญชีผู้ยืม" }));
    expect(await screen.findByText("ชื่อผู้ใช้นี้ถูกใช้แล้ว")).toBeInTheDocument();
    expect(screen.getByLabelText("ชื่อผู้ใช้")).toHaveValue("somchai");
  });
});

describe("borrower detail", () => {
  it("masks the account number until the admin chooses to show it", async () => {
    mockApi({ "GET /admin/borrowers/b1": { body: somchai } });
    await openDetail();
    await screen.findByRole("heading", { name: "สมชาย ใจดี" });
    const row = screen.getByText(/เลขบัญชี \(เห็นเฉพาะผู้ดูแล\)/).parentElement!;
    expect(row.textContent).toContain("****7890");
    expect(row.textContent).not.toContain("123-4-56789-0");
    await userEvent.setup().click(within(row).getByRole("button", { name: "แสดง" }));
    expect(row.textContent).toContain("123-4-56789-0");
  });

  it("edits only the fields that changed", async () => {
    const calls = mockApi({
      "GET /admin/borrowers/b1": { body: somchai },
      "PATCH /admin/borrowers/b1": { body: { ...somchai, phone: "0899999999" } },
    });
    await openDetail();
    const user = userEvent.setup();
    const phone = await screen.findByDisplayValue("0812345678");
    await user.clear(phone);
    await user.type(phone, "0899999999");
    await user.click(screen.getByRole("button", { name: "บันทึกการแก้ไข" }));
    expect(await screen.findByText("บันทึกข้อมูลเรียบร้อยแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ phone: "0899999999" });
  });

  it("says nothing changed instead of sending an empty edit", async () => {
    const calls = mockApi({ "GET /admin/borrowers/b1": { body: somchai } });
    await openDetail();
    await userEvent.setup().click(await screen.findByRole("button", { name: "บันทึกการแก้ไข" }));
    expect(await screen.findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("refuses an invalid phone number before calling the API", async () => {
    const calls = mockApi({ "GET /admin/borrowers/b1": { body: somchai } });
    await openDetail();
    const user = userEvent.setup();
    const phone = await screen.findByDisplayValue("0812345678");
    await user.clear(phone);
    await user.type(phone, "abc");
    await user.click(screen.getByRole("button", { name: "บันทึกการแก้ไข" }));
    expect(await screen.findByText(/เบอร์โทรศัพท์ไม่ถูกต้อง/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("deactivating needs a confirmation, then sends isActive=false", async () => {
    const calls = mockApi({
      "GET /admin/borrowers/b1": { body: somchai },
      "PUT /admin/borrowers/b1/active": { body: { ...somchai, account: { ...account, isActive: false } } },
    });
    await openDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ปิดใช้งานบัญชี" }));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "ยืนยัน" }));
    expect(await screen.findByText(/ปิดใช้งานบัญชีแล้ว/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ isActive: false });
  });

  it("a deactivated account can be activated again", async () => {
    const calls = mockApi({
      "GET /admin/borrowers/b1": { body: { ...somchai, account: { ...account, isActive: false } } },
      "PUT /admin/borrowers/b1/active": { body: somchai },
    });
    await openDetail();
    const user = userEvent.setup();
    expect(await screen.findByText("ปิดใช้งาน")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เปิดใช้งานบัญชี" }));
    await user.click(await screen.findByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ isActive: true }));
  });

  it("cancelling the deactivation sends nothing", async () => {
    const calls = mockApi({ "GET /admin/borrowers/b1": { body: somchai } });
    await openDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ปิดใช้งานบัญชี" }));
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("resets the password, shows the new one once and can hide it", async () => {
    const calls = mockApi({
      "GET /admin/borrowers/b1": { body: somchai },
      "POST /admin/borrowers/b1/reset-password": { body: somchai },
    });
    await openDetail();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("รหัสผ่านชั่วคราวใหม่"), "brand-new-pass-1");
    await user.click(screen.getByRole("button", { name: "รีเซ็ตรหัสผ่าน" }));
    expect(await screen.findByText("รีเซ็ตรหัสผ่านเรียบร้อยแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ newPassword: "brand-new-pass-1" });
    expect(screen.getByText("brand-new-pass-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ซ่อนรหัสผ่าน" }));
    expect(screen.queryByText("brand-new-pass-1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("รหัสผ่านชั่วคราวใหม่")).toHaveValue("");
  });

  it("refuses a short new password without calling the API", async () => {
    const calls = mockApi({ "GET /admin/borrowers/b1": { body: somchai } });
    await openDetail();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("รหัสผ่านชั่วคราวใหม่"), "short");
    await user.click(screen.getByRole("button", { name: "รีเซ็ตรหัสผ่าน" }));
    expect(await screen.findByText(/อย่างน้อย 10/, { selector: "p" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("an imported borrower has no account: the account controls are not offered", async () => {
    mockApi({ "GET /admin/borrowers/b2": { body: imported } });
    await openDetail("b2");
    expect(await screen.findByText(/ยังไม่มีบัญชีเข้าสู่ระบบ/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ปิดใช้งานบัญชี" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "รีเซ็ตรหัสผ่าน" })).not.toBeInTheDocument();
    // the profile can still be completed
    expect(screen.getByRole("button", { name: "บันทึกการแก้ไข" })).toBeInTheDocument();
  });

  it("shows 'not found' from the API", async () => {
    mockApi({ "GET /admin/borrowers/zzz": apiError(404, "NOT_FOUND", "ไม่พบผู้ยืม") });
    await openDetail("zzz");
    expect(await screen.findByText("ไม่พบผู้ยืม")).toBeInTheDocument();
  });

  it("shows when the borrower accepted the PDPA terms", async () => {
    mockApi({ "GET /admin/borrowers/b1": { body: { ...somchai, pdpaAcceptedAt: "2025-03-02T03:00:00.000Z", pdpaVersion: "2025-01" } } });
    await openDetail();
    expect(await screen.findByText(/ยอมรับเมื่อ .* \(เวอร์ชัน 2025-01\)/)).toBeInTheDocument();
  });
});
