import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import BorrowerDetailPage from "@/app/admin/borrowers/[id]/page";
import ProfilePage from "@/app/me/profile/page";
import { borrowerSchema, profileSchema, type Borrower, type Profile } from "@/lib/schemas";
import { checkNationalId, checkRealName, maskNationalId } from "@/lib/validation";
import { mockApi, valid } from "./mocks";
import { renderPage } from "./render";

const VALID_ID = "1101700230732";

const profile = (over: Partial<Profile> = {}) =>
  valid(profileSchema, {
    username: "somchai",
    fullName: "somchai",
    phone: "081-234-5678",
    bankName: "ธนาคารกสิกรไทย",
    bankAccountNo: "123-4-56789-0",
    nationalId: null,
    hasIdCard: false,
    realNameConfirmed: false,
    profileComplete: false,
    pdpaAcceptedAt: "2026-10-01T03:00:00.000Z",
    pdpaVersion: "2",
    ...over,
  });

const borrower = (over: Partial<Borrower> = {}) =>
  valid(borrowerSchema, {
    id: "b1",
    fullName: "สมชาย ใจดี",
    phone: "0812345678",
    bankName: "กสิกรไทย",
    bankAccountNo: "123-4-56789-0",
    nationalId: VALID_ID,
    hasIdCard: true,
    realNameConfirmed: true,
    pdpaAcceptedAt: null,
    pdpaVersion: null,
    createdAt: "2026-10-01T03:00:00.000Z",
    account: { userId: "u9", username: "somchai", isActive: true, mustChangePassword: false },
    ...over,
  });

const photo = (type = "image/jpeg", size = 2048) => new File([new Uint8Array(size)], "card.jpg", { type });
const GET = "GET /me/profile";

describe("checks mirrored from the API", () => {
  it("accepts a real national ID number, with or without dashes, and says what is wrong with a bad one", () => {
    expect(checkNationalId(VALID_ID)).toBeNull();
    expect(checkNationalId("1-1017-00230-73-2")).toBeNull();
    expect(checkNationalId("")).toMatch(/กรุณากรอก/);
    expect(checkNationalId("12345")).toMatch(/13 หลัก/);
    expect(checkNationalId("11017002307ab")).toMatch(/13 หลัก/);
    expect(checkNationalId("1101700230733")).toMatch(/ไม่ถูกต้อง/);
  });

  it("wants a first name and a surname made of letters", () => {
    expect(checkRealName("สมชาย ใจดี")).toBeNull();
    expect(checkRealName("Somchai Jaidee")).toBeNull();
    expect(checkRealName("สมชาย")).not.toBeNull();
    expect(checkRealName("somchai99")).not.toBeNull();
    expect(checkRealName("สมชาย ใจดี 2")).not.toBeNull();
    expect(checkRealName("")).toMatch(/กรุณากรอก/);
    expect(checkRealName("Some Body", "some body")).toMatch(/ชื่อผู้ใช้/);
  });

  it("masks all but the last four digits of the number", () => {
    expect(maskNationalId(VALID_ID)).toBe("*********0732");
    expect(maskNationalId(null)).toBe("-");
  });
});

describe("ยืนยันตัวตน on the borrower's profile page", () => {
  it("asks for the real name, the ID number and the card photo, and says they are not done", async () => {
    mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    expect(await screen.findByLabelText(/ชื่อ-นามสกุลจริง/)).toHaveValue("somchai");
    expect(screen.getByLabelText(/เลขบัตรประชาชน/)).toHaveValue("");
    expect(screen.getByLabelText(/รูปบัตรประชาชน/)).toBeInTheDocument();
    expect(screen.getByText("ยังยืนยันตัวตนไม่ครบ")).toBeInTheDocument();
  });

  it("checks everything before sending, and sends nothing while something is wrong", async () => {
    const calls = mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "บันทึกการยืนยันตัวตน" }));
    expect(await screen.findByText(/กรุณากรอกชื่อจริงและนามสกุลจริง/)).toBeInTheDocument();
    expect(screen.getByText("กรุณากรอกเลขบัตรประชาชน")).toBeInTheDocument();
    expect(screen.getByText("กรุณาแนบรูปบัตรประชาชน")).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/ชื่อ-นามสกุลจริง/));
    await user.type(screen.getByLabelText(/ชื่อ-นามสกุลจริง/), "สมชาย ใจดี");
    await user.type(screen.getByLabelText(/เลขบัตรประชาชน/), "1101700230733");
    await user.click(screen.getByRole("button", { name: "บันทึกการยืนยันตัวตน" }));
    expect(await screen.findByText(/ไม่ถูกต้อง กรุณาตรวจสอบตัวเลข/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("only takes a JPEG or PNG within the size limit", async () => {
    mockApi({ [GET]: { body: profile() } });
    render(<ProfilePage />);
    const user = userEvent.setup({ applyAccept: false });
    const input = await screen.findByLabelText(/รูปบัตรประชาชน/);
    await user.upload(input, new File(["x"], "card.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("รองรับเฉพาะไฟล์รูป JPEG หรือ PNG")).toBeInTheDocument();
    await user.upload(input, photo("image/png", 6 * 1024 * 1024));
    expect(await screen.findByText(/ไฟล์ใหญ่เกิน 5 MB/)).toBeInTheDocument();
  });

  it("sends the name and number first, then the photo, and shows the borrower they are done", async () => {
    let current = profile();
    const calls = mockApi({
      [GET]: () => ({ body: current }),
      "PATCH /me/profile": (c) => {
        const sent = c.body as { fullName?: string; nationalId?: string };
        current = profile({ ...current, fullName: sent.fullName ?? current.fullName, nationalId: sent.nationalId ?? current.nationalId, realNameConfirmed: true });
        return { body: current };
      },
      "POST /me/id-card": () => {
        current = profile({ ...current, hasIdCard: true, profileComplete: true });
        return { status: 201, body: current };
      },
      "GET /auth/me": { body: { user: { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: false, borrowerId: "b1", pdpaAccepted: true, profileComplete: true } } },
    });
    render(<ProfilePage />);
    const user = userEvent.setup();
    const name = await screen.findByLabelText(/ชื่อ-นามสกุลจริง/);
    await user.clear(name);
    await user.type(name, "  สมชาย   ใจดี ");
    await user.type(screen.getByLabelText(/เลขบัตรประชาชน/), "1-1017-00230-73-2");
    await user.upload(screen.getByLabelText(/รูปบัตรประชาชน/), photo());
    expect(screen.getByAltText("ตัวอย่างรูปบัตรที่เลือก")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "บันทึกการยืนยันตัวตน" }));

    expect(await screen.findByText("บันทึกข้อมูลยืนยันตัวตนแล้ว")).toBeInTheDocument();
    const writes = calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/auth"));
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /me/profile", "POST /me/id-card"]);
    expect(writes[0]!.body).toEqual({ fullName: "สมชาย ใจดี", nationalId: VALID_ID });
    expect(writes[1]!.body).toEqual({ file: { type: "image/jpeg", size: 2048 } });
    expect(await screen.findByText("ยืนยันตัวตนครบแล้ว")).toBeInTheDocument();
  });

  it("once the name is confirmed it is plain text, and the number and photo can still be corrected", async () => {
    mockApi({ [GET]: { body: profile({ fullName: "สมชาย ใจดี", realNameConfirmed: true, nationalId: VALID_ID, hasIdCard: true, profileComplete: true }) } });
    render(<ProfilePage />);
    expect(await screen.findByLabelText(/เลขบัตรประชาชน/)).toHaveValue(VALID_ID);
    expect(screen.queryByLabelText(/ชื่อ-นามสกุลจริง/)).not.toBeInTheDocument();
    expect(screen.getByText("ยืนยันแล้ว")).toBeInTheDocument();
    expect(screen.getByText("ส่งรูปแล้ว")).toBeInTheDocument();
    expect(screen.getByText("ยืนยันตัวตนครบแล้ว")).toBeInTheDocument();
  });

  it("says nothing changed instead of sending an empty edit", async () => {
    const calls = mockApi({ [GET]: { body: profile({ fullName: "สมชาย ใจดี", realNameConfirmed: true, nationalId: VALID_ID, hasIdCard: true, profileComplete: true }) } });
    render(<ProfilePage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "บันทึกการยืนยันตัวตน" }));
    expect(await screen.findByText("ไม่มีการเปลี่ยนแปลง")).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("ยืนยันตัวตน on the admin's borrower page", () => {
  const open = async (b: Borrower) => {
    const calls = mockApi({ "GET /admin/borrowers/b1": { body: b }, "PATCH /admin/borrowers/b1": { body: b } });
    await renderPage(BorrowerDetailPage, "b1");
    await screen.findByText("ยืนยันตัวตน (เห็นเฉพาะผู้ดูแล)");
    return calls;
  };

  it("masks the ID number until the admin shows it", async () => {
    await open(borrower());
    expect(screen.getByText("*********0732")).toBeInTheDocument();
    expect(screen.queryByText(VALID_ID)).not.toBeInTheDocument();
    const panel = within(screen.getByText("ยืนยันตัวตน (เห็นเฉพาะผู้ดูแล)").closest("section")!);
    await userEvent.setup().click(panel.getByRole("button", { name: "แสดง" }));
    expect(screen.getByText(VALID_ID)).toBeInTheDocument();
  });

  it("shows the ID-card photo only when asked, loaded from the admin-only address", async () => {
    await open(borrower());
    expect(screen.queryByAltText("รูปบัตรประชาชนของผู้ยืม")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "ดูรูปบัตร" }));
    expect(screen.getByAltText("รูปบัตรประชาชนของผู้ยืม")).toHaveAttribute("src", "/api/admin/borrowers/b1/id-card");
  });

  it("says what is missing for a borrower who has not done it yet, and offers nothing to clear", async () => {
    await open(borrower({ nationalId: null, hasIdCard: false, realNameConfirmed: false }));
    expect(screen.getByText("ยังไม่ได้ยืนยัน")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ดูรูปบัตร" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ล้างเลขบัตร" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ถอดรูปบัตรออก" })).not.toBeInTheDocument();
  });

  it.each([
    ["ให้ยืนยันชื่อจริงใหม่", { reconfirmName: true }],
    ["ล้างเลขบัตร", { nationalId: null }],
    ["ถอดรูปบัตรออก", { removeIdCard: true }],
  ])("%s needs a second click and then sends exactly that", async (label, body) => {
    const calls = await open(borrower());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: label }));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual(body));
    expect(await screen.findByText(/ผู้ยืมต้อง/)).toBeInTheDocument();
  });

  it("backing out sends nothing", async () => {
    const calls = await open(borrower());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ล้างเลขบัตร" }));
    await user.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("an imported borrower (no login) cannot be sent back to fill things in", async () => {
    await open(borrower({ account: null }));
    expect(screen.queryByRole("button", { name: "ล้างเลขบัตร" })).not.toBeInTheDocument();
  });
});
