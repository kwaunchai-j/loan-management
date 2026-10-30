import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import AdminDashboard from "@/app/admin/page";
import SettingsPage from "@/app/admin/settings/page";
import { useSession } from "@/lib/session-store";
import { admin, apiError, mockApi } from "./mocks";

const unset = { interestRatePctPerMonth: null, lateFeeRatePctPerDay: null, updatedAt: null, updatedBy: null };
// the page also shows the lender's payment account card, which reads its own endpoint
const account = { "GET /admin/payment-account": { body: { bankName: null, accountName: null, accountNo: null, updatedAt: null, updatedBy: null } } };
const set = {
  interestRatePctPerMonth: "5",
  lateFeeRatePctPerDay: "1.5",
  updatedAt: "2025-03-01T03:00:00.000Z",
  updatedBy: { id: "u1", username: "boss" },
};

describe("settings page (rates)", () => {
  it("warns that payouts and imports are impossible until both rates are set", async () => {
    mockApi({ ...account, "GET /admin/settings": { body: unset } });
    render(<SettingsPage />);
    expect(await screen.findByText("ยังไม่ได้ตั้งอัตราให้ครบ")).toBeInTheDocument();
    expect(screen.getByText(/บันทึกการจ่ายเงินและนำเข้าข้อมูลไม่ได้/)).toBeInTheDocument();
  });

  it("warns when only one of the two rates is set", async () => {
    mockApi({ ...account, "GET /admin/settings": { body: { ...unset, interestRatePctPerMonth: "5" } } });
    render(<SettingsPage />);
    expect(await screen.findByText("ยังไม่ได้ตั้งอัตราให้ครบ")).toBeInTheDocument();
  });

  it("shows no warning once both are set, and who changed them last", async () => {
    mockApi({ ...account, "GET /admin/settings": { body: set } });
    render(<SettingsPage />);
    expect(await screen.findByLabelText(/อัตราดอกเบี้ย/)).toHaveValue("5");
    expect(screen.getByLabelText(/อัตราค่าปรับ/)).toHaveValue("1.5");
    expect(screen.queryByText("ยังไม่ได้ตั้งอัตราให้ครบ")).not.toBeInTheDocument();
    expect(screen.getByText(/โดย boss/)).toBeInTheDocument();
  });

  it("saves the first values without a confirm step, sending both as normalised strings", async () => {
    let saved = false;
    const calls = mockApi({
      "GET /admin/settings": () => ({ body: saved ? set : unset }),
      "PATCH /admin/settings": () => {
        saved = true;
        return { body: set };
      },
    });
    render(<SettingsPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/อัตราดอกเบี้ย/), "05.0");
    await user.type(screen.getByLabelText(/อัตราค่าปรับ/), "1.50");
    await user.click(screen.getByRole("button", { name: "บันทึกอัตรา" }));
    expect(await screen.findByText("บันทึกอัตราเรียบร้อยแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ interestRatePctPerMonth: "5", lateFeeRatePctPerDay: "1.5" });
    await waitFor(() => expect(screen.queryByText("ยังไม่ได้ตั้งอัตราให้ครบ")).not.toBeInTheDocument());
  });

  it("rejects an invalid rate before calling the API", async () => {
    const calls = mockApi({ ...account, "GET /admin/settings": { body: unset } });
    render(<SettingsPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/อัตราดอกเบี้ย/), "-3");
    await user.type(screen.getByLabelText(/อัตราค่าปรับ/), "1.23456");
    await user.click(screen.getByRole("button", { name: "บันทึกอัตรา" }));
    expect((await screen.findAllByRole("alert")).length).toBe(2);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("does not call the API when nothing changed", async () => {
    const calls = mockApi({ ...account, "GET /admin/settings": { body: set } });
    render(<SettingsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "บันทึกอัตรา" }));
    expect(await screen.findByText(/ไม่มีการเปลี่ยนแปลง/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("treats a re-typed identical number as no change", async () => {
    const calls = mockApi({ ...account, "GET /admin/settings": { body: set } });
    render(<SettingsPage />);
    const user = userEvent.setup();
    const box = await screen.findByLabelText(/อัตราดอกเบี้ย/);
    await user.clear(box);
    await user.type(box, "5.0");
    await user.click(screen.getByRole("button", { name: "บันทึกอัตรา" }));
    expect(await screen.findByText(/ไม่มีการเปลี่ยนแปลง/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("asks for confirmation before replacing a rate that is in use, and sends only the changed field", async () => {
    const calls = mockApi({
      "GET /admin/settings": { body: set },
      "PATCH /admin/settings": { body: { ...set, interestRatePctPerMonth: "6" } },
    });
    render(<SettingsPage />);
    const user = userEvent.setup();
    const box = await screen.findByLabelText(/อัตราดอกเบี้ย/);
    await user.clear(box);
    await user.type(box, "6");
    await user.click(screen.getByRole("button", { name: "บันทึกอัตรา" }));

    expect(await screen.findByText("ยืนยันการเปลี่ยนอัตรา?")).toBeInTheDocument();
    expect(screen.getByText(/5 → /)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0); // nothing sent yet

    await user.click(screen.getByRole("button", { name: "ยืนยัน บันทึก" }));
    expect(await screen.findByText("บันทึกอัตราเรียบร้อยแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ interestRatePctPerMonth: "6" });
  });

  it("cancelling the confirm step sends nothing", async () => {
    const calls = mockApi({ ...account, "GET /admin/settings": { body: set } });
    render(<SettingsPage />);
    const user = userEvent.setup();
    const box = await screen.findByLabelText(/อัตราค่าปรับ/);
    await user.clear(box);
    await user.type(box, "2");
    await user.click(screen.getByRole("button", { name: "บันทึกอัตรา" }));
    await user.click(await screen.findByRole("button", { name: "ยกเลิก" }));
    expect(screen.queryByText("ยืนยันการเปลี่ยนอัตรา?")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("shows the API's message when saving fails", async () => {
    mockApi({
      "GET /admin/settings": { body: unset },
      "PATCH /admin/settings": apiError(400, "VALIDATION_ERROR", "อัตราไม่ถูกต้อง"),
    });
    render(<SettingsPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/อัตราดอกเบี้ย/), "5");
    await user.click(screen.getByRole("button", { name: "บันทึกอัตรา" }));
    expect(await screen.findByText("อัตราไม่ถูกต้อง")).toBeInTheDocument();
  });

  it("explains that a change only affects contracts paid out afterwards", async () => {
    mockApi({ ...account, "GET /admin/settings": { body: set } });
    render(<SettingsPage />);
    expect(await screen.findByText(/มีผลกับสัญญาที่จ่ายเงินหลังจากนี้เท่านั้น/)).toBeInTheDocument();
  });
});

describe("admin dashboard", () => {
  it("points to the settings page while rates are missing", async () => {
    useSession.setState({ status: "authenticated", user: admin });
    mockApi({ ...account, "GET /admin/settings": { body: unset } });
    render(<AdminDashboard />);
    expect(await screen.findByText(/ยังไม่ได้ตั้งอัตรา/)).toBeInTheDocument();
    expect(document.querySelector('a[href="/admin/settings"]')).not.toBeNull();
  });
});
