import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Gate } from "@/components/Gate";
import { useSession } from "@/lib/session-store";
import { admin, apiError, borrowerUser, mockApi, routerMock } from "./mocks";

describe("Gate", () => {
  it("shows a spinner and none of the page while it learns who is there", () => {
    mockApi({ "GET /auth/me": { body: { user: admin } } });
    render(<Gate need="admin"><p>ลับ</p></Gate>);
    expect(screen.getByRole("status")).toHaveTextContent("กำลังโหลด");
    expect(screen.queryByText("ลับ")).not.toBeInTheDocument();
  });

  it("shows the page to the right kind of user", async () => {
    mockApi({ "GET /auth/me": { body: { user: admin } } });
    render(<Gate need="admin"><p>ลับ</p></Gate>);
    expect(await screen.findByText("ลับ")).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("an admin on a borrower page is sent to /admin and sees nothing of the page", async () => {
    mockApi({ "GET /auth/me": { body: { user: admin } } });
    render(<Gate need="borrower"><p>ของผู้ยืม</p></Gate>);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/admin"));
    expect(screen.queryByText("ของผู้ยืม")).not.toBeInTheDocument();
  });

  it("a logged-in user on the login page is sent to the page they belong to", async () => {
    mockApi({ "GET /auth/me": { body: { user: borrowerUser } } });
    render(<Gate need="anonymous"><p>ฟอร์มเข้าสู่ระบบ</p></Gate>);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/me"));
    expect(screen.queryByText("ฟอร์มเข้าสู่ระบบ")).not.toBeInTheDocument();
  });

  it("when the server cannot be reached it says so, and 'try again' asks again and then shows the page", async () => {
    let up = false;
    const calls = mockApi({ "GET /auth/me": () => (up ? { body: { user: admin } } : new Error("offline")) });
    render(<Gate need="admin"><p>ลับ</p></Gate>);
    const retry = await screen.findByRole("button", { name: "ลองใหม่" });
    expect(screen.getByText(/เชื่อมต่อเซิร์ฟเวอร์ไม่ได้/)).toBeInTheDocument();
    expect(screen.queryByText("ลับ")).not.toBeInTheDocument();
    up = true;
    await userEvent.click(retry);
    expect(await screen.findByText("ลับ")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/auth/me")).toHaveLength(2);
    expect(useSession.getState().status).toBe("authenticated");
  });

  it("an expired session (401) sends the visitor to the login page", async () => {
    mockApi({ "GET /auth/me": apiError(401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบ") });
    render(<Gate need="admin"><p>ลับ</p></Gate>);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("ลับ")).not.toBeInTheDocument();
  });
});
