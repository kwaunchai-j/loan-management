import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarLink } from "@/components/calendar/CalendarLink";
import { feedLinks, isPrivateHost } from "@/lib/calendar";
import { apiError, mockApi } from "./mocks";

const PATH = "/calendar/feed/user1.sig_-9.ics";
const planned = { "GET /admin/calendar/feed-link": { body: { path: PATH } } };

afterEach(() => vi.unstubAllGlobals());

describe("feedLinks", () => {
  it("builds the address a calendar app can reach, the webcal form for Apple and the Google add link", () => {
    const l = feedLinks("https://loan.example.co.th", PATH);
    expect(l.https).toBe(`https://loan.example.co.th/api${PATH}`);
    expect(l.webcal).toBe(`webcal://loan.example.co.th/api${PATH}`);
    expect(l.google).toBe(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(l.webcal)}`);
    expect(l.reachable).toBe(true);
  });

  it("knows an address only this machine can reach, which Google and iCloud cannot fetch", () => {
    for (const host of ["localhost", "127.0.0.1", "192.168.1.20", "10.0.0.5", "172.16.3.1", "172.31.0.1", "app.local", "myserver", "[::1]"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ["loan.example.co.th", "172.32.0.1", "203.0.113.9"]) expect(isPrivateHost(host), host).toBe(false);
    expect(feedLinks("http://localhost:3000", PATH).reachable).toBe(false);
  });
});

describe("CalendarLink card", () => {
  it("asks the API for the private link and offers Google, iCloud and copy", async () => {
    const calls = mockApi(planned);
    render(<CalendarLink />);
    const google = await screen.findByRole("link", { name: "เพิ่มใน Google Calendar" });
    expect(calls).toEqual([{ method: "GET", path: "/admin/calendar/feed-link", body: undefined }]);
    const origin = window.location.origin;
    expect(google).toHaveAttribute("href", `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`${origin.replace(/^https?:/, "webcal:")}/api${PATH}`)}`);
    expect(google).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "เพิ่มใน iCloud / Apple Calendar" })).toHaveAttribute("href", `${origin.replace(/^https?:/, "webcal:")}/api${PATH}`);
    expect(screen.getByRole("textbox", { name: "ลิงก์ปฏิทิน" })).toHaveValue(`${origin}/api${PATH}`);
    // jsdom runs on localhost: the card says Google and iCloud cannot reach it
    expect(screen.getByText(/Google และ iCloud จึงเข้าถึงลิงก์ไม่ได้/)).toBeInTheDocument();
  });

  it("copies the link", async () => {
    mockApi(planned);
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CalendarLink />);
    await user.click(await screen.findByRole("button", { name: "คัดลอกลิงก์" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api${PATH}`);
    expect(await screen.findByText("คัดลอกลิงก์แล้ว")).toBeInTheDocument();
  });

  it("says so when the browser refuses to copy", async () => {
    mockApi(planned);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<CalendarLink />);
    await user.click(await screen.findByRole("button", { name: "คัดลอกลิงก์" }));
    expect(await screen.findByText(/คัดลอกอัตโนมัติไม่ได้/)).toBeInTheDocument();
  });

  it("shows the API's error and offers no link when it cannot be loaded", async () => {
    mockApi({ "GET /admin/calendar/feed-link": apiError(500, "INTERNAL", "ระบบขัดข้อง") });
    render(<CalendarLink />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ระบบขัดข้อง");
    expect(screen.queryByRole("link", { name: /Google/ })).not.toBeInTheDocument();
  });
});
