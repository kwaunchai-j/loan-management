import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import BorrowerHome from "@/app/me/page";
import BorrowerLayout from "@/app/me/layout";
import ProfilePage from "@/app/me/profile/page";
import { apiFetch } from "@/lib/api";
import { profileSchema, type Profile } from "@/lib/schemas";
import { useSession } from "@/lib/session-store";
import { apiError, borrowerUser, mockApi, pathnameMock, routerMock, valid } from "./mocks";

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
const incompleteUser = { ...borrowerUser, profileComplete: false };
const me = (user: object) => ({ "GET /auth/me": { body: { user } } });

describe("ข้อมูลของฉัน (the borrower's own details)", () => {
  it("shows the name and login as plain text (only the lender changes the name), and asks for the three details", async () => {
    mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    expect(await screen.findByText("สมชาย ใจดี")).toBeInTheDocument();
    expect(screen.getByText("somchai")).toBeInTheDocument();
    expect(screen.queryByLabelText(/ชื่อ-นามสกุล/)).not.toBeInTheDocument(); // no box to type the name in
    expect(screen.getByText("ยังกรอกไม่ครบ")).toBeInTheDocument();
    expect(screen.getByText(/ต้องกรอกทั้ง 3 ช่องก่อนจึงจะใช้งานระบบต่อได้/)).toBeInTheDocument();
    expect(screen.getByLabelText("เบอร์โทรศัพท์")).toHaveValue("");
  });

  it("while the details are missing it says up front that nothing else opens until they are filled in", async () => {
    mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    expect(await screen.findByText(/กรุณากรอกเบอร์โทรศัพท์ ธนาคาร และเลขบัญชีของคุณให้ครบก่อน จึงจะใช้งานระบบต่อได้/)).toBeInTheDocument();
  });

  it("when everything is filled in there is no such warning, and a way back to the home page", async () => {
    mockApi({ [GET]: { body: profile(COMPLETE) } });
    render(<ProfilePage />);
    expect(await screen.findByLabelText("เบอร์โทรศัพท์")).toHaveValue("081-234-5678");
    expect(screen.getByLabelText("ธนาคารที่รับเงิน")).toHaveValue("ธนาคารกสิกรไทย");
    expect(screen.getByLabelText("เลขบัญชี")).toHaveValue("123-4-56789-0");
    expect(screen.getByText("กรอกครบแล้ว")).toBeInTheDocument();
    expect(screen.queryByText(/จึงจะใช้งานระบบต่อได้/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ไปหน้าหลัก" })).toHaveAttribute("href", "/me");
  });

  it("saves the three details, sends them trimmed, and a borrower who was held here goes on to the home page", async () => {
    useSession.setState({ status: "authenticated", user: incompleteUser });
    let current = profile();
    const calls = mockApi({
      [GET]: () => ({ body: current }),
      "PATCH /me/profile": (c) => {
        current = profile({ ...(c.body as object), profileComplete: true });
        return { body: current };
      },
      ...me(borrowerUser), // after the save the session says the details are complete
    });
    render(<ProfilePage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("เบอร์โทรศัพท์"), " 089-111-2222 ");
    await user.type(screen.getByLabelText("ธนาคารที่รับเงิน"), "ธนาคารไทยพาณิชย์");
    await user.type(screen.getByLabelText("เลขบัญชี"), "987-6-54321-0");
    await user.click(screen.getByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByText("บันทึกข้อมูลของคุณแล้ว")).toBeInTheDocument();
    expect(patches(calls)[0]!.body).toEqual({ phone: "089-111-2222", bankName: "ธนาคารไทยพาณิชย์", bankAccountNo: "987-6-54321-0" });
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me"));
    expect(useSession.getState().user?.profileComplete).toBe(true);
  });

  it("a borrower who only corrects a detail stays on the page (no redirect)", async () => {
    useSession.setState({ status: "authenticated", user: borrowerUser });
    const calls = mockApi({ [GET]: { body: profile(COMPLETE) }, "PATCH /me/profile": { body: profile({ ...COMPLETE, phone: "089-999-9999" }) }, ...me(borrowerUser) });
    render(<ProfilePage />);
    const user = userEvent.setup();
    const phone = await screen.findByLabelText("เบอร์โทรศัพท์");
    await user.clear(phone);
    await user.type(phone, "089-999-9999");
    await user.click(screen.getByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByText("บันทึกข้อมูลของคุณแล้ว")).toBeInTheDocument();
    expect(patches(calls)[0]!.body).toEqual({ phone: "089-999-9999" });
    expect(routerMock.replace).not.toHaveBeenCalled();
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

  it("says when nothing changed and sends nothing", async () => {
    const calls = mockApi({ [GET]: { body: profile(COMPLETE) } });
    render(<ProfilePage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "บันทึกข้อมูล" }));
    expect(await screen.findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
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

describe("a borrower with missing details can open nothing but ข้อมูลของฉัน (CR-6)", () => {
  it("is sent from the borrower home page to the profile page, and sees nothing of the page", async () => {
    mockApi({ ...me(incompleteUser), "GET /me/contracts": { body: { items: [] } }, "GET /me/loan-requests": { body: { items: [] } } });
    pathnameMock.value = "/me";
    render(
      <BorrowerLayout>
        <BorrowerHome />
      </BorrowerLayout>,
    );
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me/profile"));
    expect(screen.queryByText(/สวัสดี somchai/)).not.toBeInTheDocument();
  });

  it("is sent there from the loan request page too", async () => {
    mockApi(me(incompleteUser));
    pathnameMock.value = "/me/request";
    render(
      <BorrowerLayout>
        <p>แบบฟอร์มขอยืม</p>
      </BorrowerLayout>,
    );
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me/profile"));
    expect(screen.queryByText("แบบฟอร์มขอยืม")).not.toBeInTheDocument();
  });

  it("is let onto the profile page itself, and the menu offers only that page", async () => {
    mockApi({ ...me(incompleteUser), [GET]: { body: profile() } });
    pathnameMock.value = "/me/profile";
    render(
      <BorrowerLayout>
        <ProfilePage />
      </BorrowerLayout>,
    );
    expect(await screen.findByRole("heading", { name: "ข้อมูลของฉัน" })).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/me/profile"]);
  });

  it("a borrower whose details are complete sees the whole menu and is not redirected", async () => {
    mockApi({ ...me(borrowerUser), "GET /me/contracts": { body: { items: [] } }, "GET /me/loan-requests": { body: { items: [] } } });
    pathnameMock.value = "/me";
    render(
      <BorrowerLayout>
        <BorrowerHome />
      </BorrowerLayout>,
    );
    expect(await screen.findByText(/สวัสดี somchai/)).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/me", "/me/request", "/me/contracts", "/me/profile"]);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("when the lender clears the details while the borrower is logged in, the next call that is refused re-reads who they are and they are held on the profile page", async () => {
    useSession.setState({ status: "authenticated", user: borrowerUser });
    mockApi({
      "GET /me/contracts": apiError(403, "PROFILE_REQUIRED", "กรุณากรอกเบอร์โทรศัพท์ ธนาคาร และเลขบัญชีของคุณก่อนใช้งาน"),
      ...me(incompleteUser),
    });
    await apiFetch("/me/contracts").catch(() => undefined);
    await waitFor(() => expect(useSession.getState().user?.profileComplete).toBe(false));
  });

  it("other refusals do not make the session re-read itself", async () => {
    useSession.setState({ status: "authenticated", user: borrowerUser });
    const calls = mockApi({ "GET /me/contracts": apiError(403, "FORBIDDEN", "ไม่มีสิทธิ์") });
    await apiFetch("/me/contracts").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.path === "/auth/me")).toHaveLength(0);
  });
});
