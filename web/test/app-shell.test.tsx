import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/AppShell";
import { menuFor } from "@/lib/access";
import { useSession } from "@/lib/session-store";
import { admin, borrowerUser, mockApi, pathnameMock, routerMock } from "./mocks";

const signIn = (user: typeof admin | typeof borrowerUser) => useSession.setState({ status: "authenticated", user });
const nav = () => screen.getByRole("navigation", { name: "เมนูหลัก" });

describe("AppShell: the frame of every logged-in page", () => {
  it("shows nothing when nobody is logged in", () => {
    const { container } = render(<AppShell><p>เนื้อหา</p></AppShell>);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows who is logged in with the Thai role name, and the page content", () => {
    signIn(admin);
    render(<AppShell><p>เนื้อหา</p></AppShell>);
    expect(screen.getByText("boss · ผู้ดูแลระบบ")).toBeInTheDocument();
    expect(screen.getByText("เนื้อหา")).toBeInTheDocument();
  });

  it("an admin sees the admin menu, in order, every entry a real link", () => {
    signIn(admin);
    render(<AppShell>x</AppShell>);
    const links = within(nav()).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual(menuFor("ADMIN").map((i) => [i.label, i.href]));
    expect(links.length).toBeGreaterThanOrEqual(8);
  });

  it("a borrower sees only the borrower menu and nothing of the admin pages", () => {
    signIn(borrowerUser);
    render(<AppShell>x</AppShell>);
    const hrefs = within(nav()).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/me", "/me/request", "/me/contracts"]);
    expect(hrefs.some((h) => h?.startsWith("/admin"))).toBe(false);
  });

  it("marks exactly the current page, and the home entry only on its own page", () => {
    signIn(admin);
    pathnameMock.value = "/admin/contracts/abc";
    const { unmount } = render(<AppShell>x</AppShell>);
    const current = within(nav()).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual(["สัญญา"]); // a sub-page keeps its section marked; "หน้าหลัก" is not
    unmount();

    pathnameMock.value = "/admin";
    render(<AppShell>x</AppShell>);
    const home = within(nav()).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(home.map((a) => a.textContent)).toEqual(["หน้าหลัก"]);
  });

  it("logging out calls the API, then goes to the login page", async () => {
    signIn(admin);
    const calls = mockApi({ "POST /auth/logout": { status: 204 } });
    render(<AppShell>x</AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/login"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /auth/logout"]);
    expect(useSession.getState().user).toBeNull();
  });

  it("still goes to the login page, with this browser signed out, when the server cannot be reached", async () => {
    signIn(admin);
    mockApi({ "POST /auth/logout": new Error("offline") });
    render(<AppShell>x</AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/login"));
    expect(useSession.getState()).toMatchObject({ status: "anonymous", user: null });
  });

  it("uses the wide layout only when asked", () => {
    signIn(admin);
    const { container, rerender } = render(<AppShell>x</AppShell>);
    expect(container.querySelector("main")).toHaveClass("max-w-3xl");
    rerender(<AppShell wide>x</AppShell>);
    expect(container.querySelector("main")).toHaveClass("max-w-5xl");
  });
});
