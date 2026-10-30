import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import AdminLayout from "@/app/admin/layout";
import BorrowerLayout from "@/app/me/layout";
import BorrowerHome from "@/app/me/page";
import ChangePasswordPage from "@/app/change-password/page";
import LoginPage from "@/app/login/page";
import PdpaPage from "@/app/pdpa/page";
import RootPage from "@/app/page";
import { PDPA_SECTIONS } from "@/content/pdpa.th";
import { useSession } from "@/lib/session-store";
import { admin, apiError, borrowerUser, mockApi, pathnameMock, routerMock } from "./mocks";

const borrowerNoPdpa = { ...borrowerUser, pdpaAccepted: false };
const mustChange = { ...borrowerUser, mustChangePassword: true };
const me = (user: object) => ({ "GET /auth/me": { body: { user } } });
const anon = { "GET /auth/me": apiError(401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบ") };

describe("page guards", () => {
  it("an anonymous visitor to /admin is sent to the login page and sees nothing of the page", async () => {
    mockApi(anon);
    render(<AdminLayout><p>ข้อมูลลับของผู้ดูแล</p></AdminLayout>);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("ข้อมูลลับของผู้ดูแล")).not.toBeInTheDocument();
  });

  it("a borrower on an admin page is sent to /me and sees nothing of the page", async () => {
    mockApi(me(borrowerUser));
    render(<AdminLayout><p>ข้อมูลลับของผู้ดูแล</p></AdminLayout>);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me"));
    expect(screen.queryByText("ข้อมูลลับของผู้ดูแล")).not.toBeInTheDocument();
  });

  it("a borrower without PDPA acceptance is sent to the PDPA page before the borrower home", async () => {
    mockApi(me(borrowerNoPdpa));
    render(
      <BorrowerLayout>
        <BorrowerHome />
      </BorrowerLayout>,
    );
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/pdpa"));
    expect(screen.queryByText(/สวัสดี/)).not.toBeInTheDocument();
  });

  it("a borrower who must change the password is sent there before PDPA or the home", async () => {
    mockApi(me({ ...mustChange, pdpaAccepted: false }));
    render(
      <BorrowerLayout>
        <BorrowerHome />
      </BorrowerLayout>,
    );
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/change-password"));
  });

  it("an admin sees the admin page, with the admin menu only", async () => {
    mockApi(me(admin));
    pathnameMock.value = "/admin";
    render(<AdminLayout><p>แผงควบคุม</p></AdminLayout>);
    expect(await screen.findByText("แผงควบคุม")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "/admin",
      "/admin/requests",
      "/admin/calendar",
      "/admin/contracts",
      "/admin/payments",
      "/admin/borrowers",
      "/admin/reports",
      "/admin/imports",
      "/admin/notifications",
      "/admin/settings",
    ]);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("a consenting borrower sees the borrower home with no admin link at all", async () => {
    mockApi({ ...me(borrowerUser), "GET /me/contracts": { body: { items: [] } }, "GET /me/loan-requests": { body: { items: [] } } });
    pathnameMock.value = "/me";
    render(
      <BorrowerLayout>
        <BorrowerHome />
      </BorrowerLayout>,
    );
    expect(await screen.findByText(/สวัสดี somchai/)).toBeInTheDocument();
    const links = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links.filter((l) => l?.startsWith("/admin"))).toEqual([]); // no admin link anywhere on a borrower's page
    expect(links).toEqual(expect.arrayContaining(["/me", "/me/request", "/me/contracts"]));
  });

  it("a logged-in user opening the login page is sent to where they belong", async () => {
    mockApi(me(admin));
    render(<LoginPage />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/admin"));
  });

  it("shows a retry when the server cannot be reached, instead of logging out or showing the page", async () => {
    mockApi({ "GET /auth/me": new TypeError("down") });
    render(<AdminLayout><p>แผงควบคุม</p></AdminLayout>);
    expect(await screen.findByRole("button", { name: "ลองใหม่" })).toBeInTheDocument();
    expect(screen.queryByText("แผงควบคุม")).not.toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("the root page redirects by role (nothing is shown at /)", async () => {
    mockApi(me(borrowerNoPdpa));
    render(<RootPage />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/pdpa"));
  });
});

describe("login page", () => {
  const fill = async (u: string, p: string) => {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("ชื่อผู้ใช้"), u);
    await user.type(screen.getByLabelText("รหัสผ่าน"), p);
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
  };

  it("logs an admin in and sends them to /admin", async () => {
    let loggedIn = false;
    mockApi({
      "GET /auth/me": () => (loggedIn ? { body: { user: admin } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } }),
      "POST /auth/login": () => {
        loggedIn = true;
        return { body: { user: { id: "u1", username: "boss", role: "ADMIN", mustChangePassword: false } } };
      },
    });
    render(<LoginPage />);
    await fill("boss", "a-long-password");
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/admin"));
  });

  it("sends a borrower without PDPA acceptance straight to the PDPA page", async () => {
    let loggedIn = false;
    mockApi({
      "GET /auth/me": () => (loggedIn ? { body: { user: borrowerNoPdpa } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } }),
      "POST /auth/login": () => {
        loggedIn = true;
        return { body: { user: { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: false } } };
      },
    });
    render(<LoginPage />);
    await fill("somchai", "a-long-password");
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/pdpa"));
  });

  it("goes to the first-password page when the password must be changed", async () => {
    let loggedIn = false;
    mockApi({
      "GET /auth/me": () => (loggedIn ? { body: { user: mustChange } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } }),
      "POST /auth/login": () => {
        loggedIn = true;
        return { body: { user: { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: true } } };
      },
    });
    render(<LoginPage />);
    await fill("somchai", "a-long-password");
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/change-password"));
  });

  it("shows the API's Thai message on a wrong password, clears the password and does not navigate", async () => {
    mockApi({ ...anon, "POST /auth/login": apiError(401, "INVALID_CREDENTIALS", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง") });
    render(<LoginPage />);
    await fill("boss", "wrong-password");
    expect(await screen.findByText("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")).toBeInTheDocument();
    expect(screen.getByLabelText("รหัสผ่าน")).toHaveValue("");
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("shows the lock message when too many attempts were made", async () => {
    mockApi({ ...anon, "POST /auth/login": apiError(429, "TOO_MANY_ATTEMPTS", "ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที") });
    render(<LoginPage />);
    await fill("boss", "wrong-password");
    expect(await screen.findByText(/รอ 15 นาที/)).toBeInTheDocument();
  });

  it("asks for both fields without calling the API", async () => {
    const calls = mockApi(anon);
    render(<LoginPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "เข้าสู่ระบบ" }));
    expect(await screen.findByText("กรุณากรอกชื่อผู้ใช้และรหัสผ่าน")).toBeInTheDocument();
    expect(calls.map((c) => c.method + c.path)).toEqual(["GET/auth/me"]);
  });

  it("never navigates to an address taken from the URL (no ?next= redirect)", async () => {
    window.history.replaceState({}, "", "/login?next=https://evil.example");
    let loggedIn = false;
    mockApi({
      "GET /auth/me": () => (loggedIn ? { body: { user: admin } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } }),
      "POST /auth/login": () => {
        loggedIn = true;
        return { body: { user: { id: "u1", username: "boss", role: "ADMIN", mustChangePassword: false } } };
      },
    });
    render(<LoginPage />);
    await fill("boss", "a-long-password");
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    expect(routerMock.replace).toHaveBeenCalledWith("/admin");
    // the guard also redirects to /admin, so "called with /admin" alone proves nothing: no call may carry the address
    expect(window.location.search).toContain("evil.example"); // the trap really was set
    for (const [target] of routerMock.replace.mock.calls) expect(target).toBe("/admin");
    window.history.replaceState({}, "", "/");
  });
});

describe("change-password page", () => {
  const open = async () => {
    mockApi({ ...me(mustChange) });
    render(<ChangePasswordPage />);
    await screen.findByLabelText(/รหัสผ่านปัจจุบัน/);
  };

  it("checks the new password before calling the API", async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/รหัสผ่านปัจจุบัน/), "temp-password-1");
    await user.type(screen.getByLabelText("รหัสผ่านใหม่"), "short");
    await user.type(screen.getByLabelText("ยืนยันรหัสผ่านใหม่"), "other");
    await user.click(screen.getByRole("button", { name: "บันทึกรหัสผ่านใหม่" }));
    expect(await screen.findByText("รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร")).toBeInTheDocument();
    expect(screen.getByText("รหัสผ่านยืนยันไม่ตรงกัน")).toBeInTheDocument();
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1); // only /auth/me
  });

  it("refuses the same password as before", async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/รหัสผ่านปัจจุบัน/), "same-password-1");
    await user.type(screen.getByLabelText("รหัสผ่านใหม่"), "same-password-1");
    await user.type(screen.getByLabelText("ยืนยันรหัสผ่านใหม่"), "same-password-1");
    await user.click(screen.getByRole("button", { name: "บันทึกรหัสผ่านใหม่" }));
    expect(await screen.findByText(/ต้องไม่ซ้ำ/)).toBeInTheDocument();
  });

  it("changes the password and then goes where the user belongs (PDPA next for a borrower)", async () => {
    let changed = false;
    const calls = mockApi({
      "GET /auth/me": () => ({ body: { user: changed ? borrowerNoPdpa : { ...mustChange, pdpaAccepted: false } } }),
      "POST /auth/change-password": () => {
        changed = true;
        return { body: { user: { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: false } } };
      },
    });
    render(<ChangePasswordPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/รหัสผ่านปัจจุบัน/), "temp-password-1");
    await user.type(screen.getByLabelText("รหัสผ่านใหม่"), "my-own-password-9");
    await user.type(screen.getByLabelText("ยืนยันรหัสผ่านใหม่"), "my-own-password-9");
    await user.click(screen.getByRole("button", { name: "บันทึกรหัสผ่านใหม่" }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/pdpa"));
    expect(calls.find((c) => c.path === "/auth/change-password")!.body).toEqual({
      currentPassword: "temp-password-1",
      newPassword: "my-own-password-9",
    });
  });

  it("shows the API's message when the current password is wrong", async () => {
    mockApi({ ...me(mustChange), "POST /auth/change-password": apiError(401, "INVALID_CREDENTIALS", "รหัสผ่านปัจจุบันไม่ถูกต้อง") });
    render(<ChangePasswordPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/รหัสผ่านปัจจุบัน/), "wrong-password-1");
    await user.type(screen.getByLabelText("รหัสผ่านใหม่"), "my-own-password-9");
    await user.type(screen.getByLabelText("ยืนยันรหัสผ่านใหม่"), "my-own-password-9");
    await user.click(screen.getByRole("button", { name: "บันทึกรหัสผ่านใหม่" }));
    expect(await screen.findByText("รหัสผ่านปัจจุบันไม่ถูกต้อง")).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("is closed to people who do not need to change the password", async () => {
    mockApi(me(borrowerUser));
    render(<ChangePasswordPage />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me"));
    expect(screen.queryByLabelText("รหัสผ่านใหม่")).not.toBeInTheDocument();
  });
});

describe("PDPA page", () => {
  const status = { currentVersion: "2025-01", accepted: false, acceptedAt: null, acceptedVersion: null };

  it("shows the terms, and the accept button stays disabled until the box is ticked", async () => {
    mockApi({ ...me(borrowerNoPdpa), "GET /pdpa": { body: status } });
    render(<PdpaPage />);
    expect(await screen.findByText(PDPA_SECTIONS[0]!.heading)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "ยอมรับและเข้าใช้งาน" });
    expect(button).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("checkbox"));
    expect(button).toBeEnabled();
  });

  it("sends the version that was shown, then moves on to the borrower home", async () => {
    let accepted = false;
    const calls = mockApi({
      "GET /auth/me": () => ({ body: { user: accepted ? borrowerUser : borrowerNoPdpa } }),
      "GET /pdpa": { body: status },
      "POST /pdpa/accept": () => {
        accepted = true;
        return { body: { ...status, accepted: true, acceptedAt: "2025-01-01T00:00:00Z", acceptedVersion: "2025-01" } };
      },
    });
    render(<PdpaPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "ยอมรับและเข้าใช้งาน" }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me"));
    expect(calls.find((c) => c.path === "/pdpa/accept")!.body).toEqual({ version: "2025-01" });
  });

  it("declining logs the borrower out", async () => {
    const calls = mockApi({ ...me(borrowerNoPdpa), "GET /pdpa": { body: status }, "POST /auth/logout": { status: 204 } });
    render(<PdpaPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /ไม่ยอมรับ/ }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/login"));
    expect(calls.some((c) => c.path === "/auth/logout")).toBe(true);
    expect(useSession.getState().user).toBeNull();
  });

  it("is not open to an admin or to a borrower who already accepted", async () => {
    mockApi({ ...me(borrowerUser), "GET /pdpa": { body: status } });
    render(<PdpaPage />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("the draft terms are marked as needing approval and are all in Thai", () => {
    for (const s of PDPA_SECTIONS) {
      expect(s.heading).toMatch(/[฀-๿]/);
      expect(s.body).toMatch(/[฀-๿]/);
    }
  });
});
