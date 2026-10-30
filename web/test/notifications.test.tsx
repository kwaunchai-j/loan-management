import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotificationsPage from "@/app/admin/notifications/page";
import { describeResult } from "@/components/notifications/TestCard";
import { LINE_USER_ID } from "@/components/notifications/LineCard";
import { readPushState, subscribeThisDevice, unsubscribeThisDevice, urlBase64ToBytes } from "@/lib/push";
import { apiError, mockApi } from "./mocks";

// ---- a fake browser: service worker, push manager, permission, iPhone / home-screen mode ------------------------

interface Browser {
  ios?: boolean;
  standalone?: boolean;
  permission?: "default" | "granted" | "denied";
  /** the answer to the permission prompt */
  answer?: "granted" | "denied";
  worker?: boolean;
  subscribed?: boolean;
  noPush?: boolean;
}

const KEYS = { p256dh: "BKey_p256dh", auth: "authKey" };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

function fakeBrowser(b: Browser = {}) {
  let subscribed = b.subscribed ?? false;
  const subscription = {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }),
    unsubscribe: vi.fn(async () => {
      subscribed = false;
      return true;
    }),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => (subscribed ? subscription : null)),
    subscribe: vi.fn(async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      void options;
      subscribed = true;
      return subscription;
    }),
  };
  const permission = { value: b.permission ?? "default" };
  vi.stubGlobal("Notification", {
    get permission() {
      return permission.value;
    },
    requestPermission: vi.fn(async () => {
      permission.value = b.answer ?? "granted";
      return permission.value;
    }),
  });
  if (b.noPush) {
    // a browser with no push support has no PushManager at all (it may have been stubbed by an earlier call)
    Reflect.deleteProperty(globalThis, "PushManager");
    Reflect.deleteProperty(window, "PushManager");
  } else {
    vi.stubGlobal("PushManager", class {});
  }
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: vi.fn(async () => (b.worker === false ? undefined : { pushManager })) },
  });
  Object.defineProperty(navigator, "standalone", { configurable: true, value: b.standalone ?? false });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(b.ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" : "Mozilla/5.0 (Windows NT 10.0) Chrome/120");
  return { pushManager, subscription };
}

afterEach(() => {
  // @ts-expect-error — remove what fakeBrowser added so the next test starts as a plain jsdom
  delete navigator.serviceWorker;
  // @ts-expect-error — same
  delete navigator.standalone;
});

const publicKey = { "GET /admin/push/public-key": { body: { publicKey: "BPublicKeyAAAA" } } };
const lineUnbound = { "GET /admin/line-binding": { body: { bound: false, lineUserId: null } } };
const baseRoutes = { ...lineUnbound };
const GOOD_LINE_ID = "U" + "0123456789abcdef0123456789abcdef";

describe("push helpers", () => {
  it("turns the VAPID key from base64url text into bytes", () => {
    expect(Array.from(urlBase64ToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes("-_8"))).toEqual([251, 255]); // - and _ are the URL-safe + and /
  });

  it("reads the state of a plain desktop browser step by step", async () => {
    fakeBrowser({ worker: false });
    expect(await readPushState()).toEqual({ kind: "no-worker" });
    fakeBrowser({});
    expect(await readPushState()).toEqual({ kind: "off" });
    fakeBrowser({ subscribed: true });
    expect(await readPushState()).toEqual({ kind: "on", endpoint: ENDPOINT });
    fakeBrowser({ permission: "denied" });
    expect(await readPushState()).toEqual({ kind: "blocked" });
  });

  it("an iPhone that is not opened from the home-screen icon must install first", async () => {
    fakeBrowser({ ios: true, standalone: false });
    expect(await readPushState()).toEqual({ kind: "needs-install" });
    fakeBrowser({ ios: true, standalone: true });
    expect(await readPushState()).toEqual({ kind: "off" });
  });

  it("a browser without push support is reported as unsupported", async () => {
    fakeBrowser({ noPush: true });
    expect(await readPushState()).toEqual({ kind: "unsupported" });
  });

  it("subscribes with the server's key and gives back exactly the endpoint and keys", async () => {
    const { pushManager } = fakeBrowser();
    const sub = await subscribeThisDevice("AQID");
    expect(sub).toEqual({ endpoint: ENDPOINT, keys: KEYS });
    const call = pushManager.subscribe.mock.calls[0]![0];
    expect(call.userVisibleOnly).toBe(true);
    expect(Array.from(call.applicationServerKey)).toEqual([1, 2, 3]);
  });

  it("does not subscribe when the user refuses the permission", async () => {
    const { pushManager } = fakeBrowser({ answer: "denied" });
    await expect(subscribeThisDevice("AQID")).rejects.toThrow(/ไม่ได้รับอนุญาต/);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribing returns the endpoint to tell the server (or null when there was none)", async () => {
    const { subscription } = fakeBrowser({ subscribed: true });
    expect(await unsubscribeThisDevice()).toBe(ENDPOINT);
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(await unsubscribeThisDevice()).toBeNull();
  });
});

describe("push card", () => {
  it("offers to turn notifications on for this device, then registers the browser with the server", async () => {
    fakeBrowser();
    const calls = mockApi({ ...baseRoutes, ...publicKey, "POST /admin/push-subscriptions": { status: 201, body: { subscribed: true } } });
    render(<NotificationsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "เปิดการแจ้งเตือนบนเครื่องนี้" }));
    expect(await screen.findByText("เปิดอยู่")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/admin/push-subscriptions")!.body).toEqual({ endpoint: ENDPOINT, keys: KEYS });
    expect(screen.getByRole("button", { name: "ปิดการแจ้งเตือนบนเครื่องนี้" })).toBeInTheDocument();
  });

  it("explains a refusal in the browser and stays off", async () => {
    fakeBrowser({ answer: "denied" });
    const calls = mockApi({ ...baseRoutes, ...publicKey, "POST /admin/push-subscriptions": { status: 201, body: { subscribed: true } } });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "เปิดการแจ้งเตือนบนเครื่องนี้" }));
    expect(await screen.findByText(/ไม่ได้รับอนุญาตให้แสดงการแจ้งเตือน/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admin/push-subscriptions")).toBe(false);
  });

  it("shows the server's message when push is not configured (no VAPID key)", async () => {
    fakeBrowser();
    mockApi({ ...baseRoutes, "GET /admin/push/public-key": apiError(503, "PUSH_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า Web Push บนเซิร์ฟเวอร์ (VAPID)") });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "เปิดการแจ้งเตือนบนเครื่องนี้" }));
    expect(await screen.findByText(/ยังไม่ได้ตั้งค่า Web Push บนเซิร์ฟเวอร์/)).toBeInTheDocument();
  });

  it("does not show the browser's own technical error text", async () => {
    const { pushManager } = fakeBrowser();
    pushManager.subscribe.mockRejectedValueOnce(new Error("AbortError: Registration failed - push service error"));
    mockApi({ ...baseRoutes, ...publicKey });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "เปิดการแจ้งเตือนบนเครื่องนี้" }));
    await screen.findByText(/เกิดข้อผิดพลาด/);
    expect(document.body.textContent).not.toContain("AbortError");
  });

  it("turns it off here and tells the server, and a server that already forgot it is fine", async () => {
    const { subscription } = fakeBrowser({ subscribed: true });
    const calls = mockApi({ ...baseRoutes, "DELETE /admin/push-subscriptions": apiError(404, "NOT_FOUND", "ไม่พบการสมัครรับแจ้งเตือนนี้") });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "ปิดการแจ้งเตือนบนเครื่องนี้" }));
    expect(await screen.findByRole("button", { name: "เปิดการแจ้งเตือนบนเครื่องนี้" })).toBeInTheDocument();
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(calls.find((c) => c.method === "DELETE" && c.path === "/admin/push-subscriptions")!.body).toEqual({ endpoint: ENDPOINT });
  });

  it("an iPhone outside the home-screen icon is told to install the app first, with no enable button", async () => {
    fakeBrowser({ ios: true, standalone: false });
    mockApi(baseRoutes);
    render(<NotificationsPage />);
    expect(await screen.findByText(/เพิ่มแอปลงหน้าจอโฮม/, { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "เปิดการแจ้งเตือนบนเครื่องนี้" })).not.toBeInTheDocument();
    expect(screen.getByText("เครื่องนี้เป็น iPhone/iPad และยังไม่ได้เปิดจากไอคอนบนหน้าจอโฮม")).toBeInTheDocument();
  });

  it("tells a blocked browser how to fix it, an unsupported one to switch, and a missing worker to reload", async () => {
    fakeBrowser({ permission: "denied" });
    mockApi(baseRoutes);
    const { unmount } = render(<NotificationsPage />);
    expect(await screen.findByText(/ถูกตั้งไว้ไม่ให้เว็บนี้แสดงการแจ้งเตือน/)).toBeInTheDocument();
    unmount();
    fakeBrowser({ noPush: true });
    const second = render(<NotificationsPage />);
    expect(await screen.findByText(/ไม่รองรับการแจ้งเตือนแบบ Web Push/)).toBeInTheDocument();
    second.unmount();
    fakeBrowser({ worker: false });
    render(<NotificationsPage />);
    expect(await screen.findByText(/ยังไม่พบ service worker/)).toBeInTheDocument();
  });

  it("the installation guide lists the iPhone steps in Thai", async () => {
    fakeBrowser();
    mockApi(baseRoutes);
    render(<NotificationsPage />);
    expect(await screen.findByText(/เพิ่มลงหน้าจอโฮม/, { selector: "strong" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/ใช้เฉพาะ iPhone\/iPad/)).toBeInTheDocument();
  });
});

describe("LINE card", () => {
  it("accepts the right shape of LINE user id only", () => {
    expect(LINE_USER_ID.test(GOOD_LINE_ID)).toBe(true);
    for (const bad of ["", "U123", "u0123456789abcdef0123456789abcdef", GOOD_LINE_ID + "0", "U" + "G".repeat(32), "@myline", GOOD_LINE_ID.toUpperCase()]) {
      expect(LINE_USER_ID.test(bad)).toBe(false);
    }
  });

  it("says when nothing is bound", async () => {
    fakeBrowser({ worker: false });
    mockApi(baseRoutes);
    render(<NotificationsPage />);
    expect(await screen.findByText("ยังไม่ผูก")).toBeInTheDocument();
  });

  it("will not send a wrongly shaped id to the server", async () => {
    fakeBrowser({ worker: false });
    const calls = mockApi(baseRoutes);
    render(<NotificationsPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("LINE user id"), "mylineid");
    await user.click(screen.getByRole("button", { name: "ผูกบัญชี LINE" }));
    expect(await screen.findByText(/ต้องขึ้นต้นด้วย U/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("binds the account, then only the masked id is shown", async () => {
    fakeBrowser({ worker: false });
    let bound = false;
    const calls = mockApi({
      "GET /admin/line-binding": () => ({ body: bound ? { bound: true, lineUserId: "U0…cdef" } : { bound: false, lineUserId: null } }),
      "PUT /admin/line-binding": () => {
        bound = true;
        return { body: { bound: true, lineUserId: "U0…cdef" } };
      },
    });
    render(<NotificationsPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("LINE user id"), `  ${GOOD_LINE_ID}  `);
    await user.click(screen.getByRole("button", { name: "ผูกบัญชี LINE" }));
    expect(await screen.findByText("ผูกบัญชี LINE แล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ lineUserId: GOOD_LINE_ID });
    expect(await screen.findByText("ผูกแล้ว")).toBeInTheDocument();
    expect(screen.getByText("U0…cdef")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(GOOD_LINE_ID); // the full id is never shown again
    expect(screen.getByLabelText("เปลี่ยนเป็น LINE user id ใหม่")).toHaveValue("");
  });

  it("shows the API's refusal", async () => {
    fakeBrowser({ worker: false });
    mockApi({ ...baseRoutes, "PUT /admin/line-binding": apiError(400, "VALIDATION_ERROR", "LINE user id ไม่ถูกต้อง") });
    render(<NotificationsPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("LINE user id"), GOOD_LINE_ID);
    await user.click(screen.getByRole("button", { name: "ผูกบัญชี LINE" }));
    expect(await screen.findByText("LINE user id ไม่ถูกต้อง")).toBeInTheDocument();
  });

  it("removing the binding needs a confirmation", async () => {
    fakeBrowser({ worker: false });
    const calls = mockApi({
      "GET /admin/line-binding": { body: { bound: true, lineUserId: "U0…cdef" } },
      "DELETE /admin/line-binding": { body: { bound: false, lineUserId: null } },
    });
    render(<NotificationsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ยกเลิกการผูกบัญชี LINE" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "ยืนยันยกเลิกการผูก" }));
    expect(await screen.findByText("ยกเลิกการผูกบัญชี LINE แล้ว")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("backing out of removing sends nothing", async () => {
    fakeBrowser({ worker: false });
    const calls = mockApi({ "GET /admin/line-binding": { body: { bound: true, lineUserId: "U0…cdef" } } });
    render(<NotificationsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ยกเลิกการผูกบัญชี LINE" }));
    await user.click(screen.getByRole("button", { name: "ไม่ยกเลิก" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("test send", () => {
  it("reads what each channel answered", () => {
    expect(describeResult("sent")).toMatchObject({ tone: "green", text: "ส่งแล้ว" });
    expect(describeResult("no_recipient")).toMatchObject({ tone: "amber" });
    expect(describeResult("failed: LINE returned HTTP 401")).toEqual({ tone: "red", text: "ส่งไม่สำเร็จ", detail: "LINE returned HTTP 401" });
    expect(describeResult("failed:").detail).toBeNull();
  });

  it("shows one line per channel", async () => {
    fakeBrowser({ worker: false });
    mockApi({ ...baseRoutes, "POST /admin/notifications/test": { body: { LINE: "no_recipient", WEB_PUSH: "sent" } } });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "ส่งทดสอบ" }));
    expect(await screen.findByText("Web Push")).toBeInTheDocument();
    expect(screen.getByText("ส่งแล้ว")).toBeInTheDocument();
    expect(screen.getByText(/ยังไม่มีผู้รับ/)).toBeInTheDocument();
  });

  it("shows a failed channel with the reason", async () => {
    fakeBrowser({ worker: false });
    mockApi({ ...baseRoutes, "POST /admin/notifications/test": { body: { LINE: "failed: LINE returned HTTP 401" } } });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "ส่งทดสอบ" }));
    expect(await screen.findByText("ส่งไม่สำเร็จ")).toBeInTheDocument();
    expect(screen.getByText("(LINE returned HTTP 401)")).toBeInTheDocument();
  });

  it("says when the server has no channel at all", async () => {
    fakeBrowser({ worker: false });
    mockApi({ ...baseRoutes, "POST /admin/notifications/test": { body: {} } });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "ส่งทดสอบ" }));
    expect(await screen.findByText(/ยังไม่มีช่องทางแจ้งเตือนที่ตั้งค่าบนเซิร์ฟเวอร์/)).toBeInTheDocument();
  });

  it("shows the API's message when the test cannot be sent", async () => {
    fakeBrowser({ worker: false });
    mockApi({ ...baseRoutes, "POST /admin/notifications/test": apiError(500, "INTERNAL", "ระบบขัดข้อง") });
    render(<NotificationsPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "ส่งทดสอบ" }));
    await waitFor(() => expect(screen.getByText("ระบบขัดข้อง")).toBeInTheDocument());
  });
});
