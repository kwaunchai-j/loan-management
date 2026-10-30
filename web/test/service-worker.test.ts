import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Runs public/sw.js in a bare sandbox that has only what a worker has, and drives its events.
 * What matters: it never answers an /api call, a non-GET or a non-page request, never stores anything
 * but the offline page, and falls back to that page only when a navigation fails.
 */
interface FakeWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

function loadWorker(networkFails = false, windows: FakeWindow[] = []) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const store = new Map<string, unknown>();
  const added: string[] = [];
  const deleted: string[] = [];
  const cache = { add: vi.fn(async (url: string) => { added.push(url); store.set(url, "OFFLINE-PAGE"); }) };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["loan-offline-v1", "old-cache"]),
    delete: vi.fn(async (k: string) => { deleted.push(k); return true; }),
    match: vi.fn(async (url: string) => store.get(url)),
  };
  const fetchFn = vi.fn(async () => {
    if (networkFails) throw new TypeError("offline");
    return "NETWORK-RESPONSE";
  });
  const self = {
    location: { origin: "https://loan.example" },
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn<(title: string, options: { body: string; data: { url: string }; icon: string }) => Promise<undefined>>(async () => undefined) },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn<(url: string) => Promise<undefined>>(async () => undefined),
    },
  };
  runInNewContext(readFileSync(join(process.cwd(), "public", "sw.js"), "utf8"), { self, caches, fetch: fetchFn, URL, Promise });

  async function request(url: string, init: { method?: string; mode?: string } = {}) {
    let answer: Promise<unknown> | undefined;
    listeners.fetch!({
      request: { url, method: init.method ?? "GET", mode: init.mode ?? "navigate" },
      respondWith: (p: Promise<unknown>) => { answer = p; },
    });
    return answer === undefined ? "NOT-HANDLED" : await answer;
  }
  return { listeners, self, cache, caches, added, deleted, fetchFn, request };
}

describe("service worker", () => {
  it("on install keeps only the offline page", async () => {
    const w = loadWorker();
    let wait: Promise<unknown> | undefined;
    w.listeners.install!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    expect(w.added).toEqual(["/offline.html"]);
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it("on activate removes other caches and takes control", async () => {
    const w = loadWorker();
    let wait: Promise<unknown> | undefined;
    w.listeners.activate!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    expect(w.deleted).toEqual(["old-cache"]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it("lets a page load through the network when online", async () => {
    const w = loadWorker();
    expect(await w.request("https://loan.example/me")).toBe("NETWORK-RESPONSE");
  });

  it("shows the offline page when a page cannot be loaded", async () => {
    const w = loadWorker(true);
    let wait: Promise<unknown> | undefined;
    w.listeners.install!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    expect(await w.request("https://loan.example/me")).toBe("OFFLINE-PAGE");
  });

  it("never touches API calls, even page-like ones", async () => {
    const w = loadWorker(true);
    expect(await w.request("https://loan.example/api/me/contracts")).toBe("NOT-HANDLED");
    expect(await w.request("https://loan.example/api/auth/me", { mode: "cors" })).toBe("NOT-HANDLED");
  });

  it("never touches non-GET requests, assets or other origins", async () => {
    const w = loadWorker(true);
    expect(await w.request("https://loan.example/me", { method: "POST" })).toBe("NOT-HANDLED");
    expect(await w.request("https://loan.example/_next/static/a.js", { mode: "no-cors" })).toBe("NOT-HANDLED");
    expect(await w.request("https://other.example/me")).toBe("NOT-HANDLED");
  });

  it("stores nothing but the offline page", async () => {
    const w = loadWorker();
    await w.request("https://loan.example/me");
    await w.request("https://loan.example/api/me");
    expect(w.cache.add).not.toHaveBeenCalled();
    expect(w.added).toEqual([]);
  });
});

describe("service worker: Web Push", () => {
  const pushEvent = (payload: unknown, broken = false) => {
    let wait: Promise<unknown> | undefined;
    return {
      event: {
        data: payload === undefined ? null : { json: () => { if (broken) throw new SyntaxError("bad json"); return payload; } },
        waitUntil: (p: Promise<unknown>) => { wait = p; },
      },
      done: async () => { await wait; },
    };
  };
  const shown = (w: ReturnType<typeof loadWorker>) => w.self.registration.showNotification.mock.calls[0]!;

  it("shows the notification the server sent, as plain text", async () => {
    const w = loadWorker();
    const p = pushEvent({ title: "มีคำขอยืมเงินใหม่", body: "สมชาย ขอยืม 5,000.00 บาท", url: "/admin/loan-requests" });
    w.listeners.push!(p.event);
    await p.done();
    const [title, options] = shown(w);
    expect(title).toBe("มีคำขอยืมเงินใหม่");
    expect(options.body).toBe("สมชาย ขอยืม 5,000.00 บาท");
    expect(options.data.url).toBe("/admin/loan-requests");
    expect(options.icon).toBe("/icon-192.png");
  });

  it("always shows something, even when the payload is empty or unreadable (browsers demand it)", async () => {
    for (const make of [() => pushEvent(undefined), () => pushEvent("{", true), () => pushEvent({ title: 42, body: {} })]) {
      const w = loadWorker();
      const p = make();
      w.listeners.push!(p.event);
      await p.done();
      expect(w.self.registration.showNotification).toHaveBeenCalledTimes(1);
      const [title, options] = shown(w);
      expect(title).toBe("ระบบขอยืมเงิน");
      expect(options.body).toBe("");
      expect(options.data.url).toBe("/");
    }
  });

  it("cuts an over-long title and body", async () => {
    const w = loadWorker();
    const p = pushEvent({ title: "ก".repeat(500), body: "ข".repeat(2000) });
    w.listeners.push!(p.event);
    await p.done();
    const [title, options] = shown(w);
    expect(title).toHaveLength(100);
    expect(options.body).toHaveLength(300);
  });

  it("a notification only ever points at a page of this site", async () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/\\evil.example", "admin/contracts", 7, null]) {
      const w = loadWorker();
      const p = pushEvent({ title: "t", body: "b", url: bad });
      w.listeners.push!(p.event);
      await p.done();
      expect(shown(w)[1].data.url, String(bad)).toBe("/");
    }
  });

  const click = async (w: ReturnType<typeof loadWorker>, url: unknown) => {
    let wait: Promise<unknown> | undefined;
    const close = vi.fn();
    w.listeners.notificationclick!({ notification: { close, data: url === undefined ? undefined : { url } }, waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    return close;
  };

  it("clicking opens the page in a new window when the app is not open", async () => {
    const w = loadWorker();
    const close = await click(w, "/admin/contracts");
    expect(close).toHaveBeenCalled();
    expect(w.self.clients.openWindow).toHaveBeenCalledWith("https://loan.example/admin/contracts");
  });

  it("clicking brings an open window of the app forward and goes to the page", async () => {
    const mine: FakeWindow = { url: "https://loan.example/admin", focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
    const other: FakeWindow = { url: "https://other.example/", focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
    const w = loadWorker(false, [other, mine]);
    await click(w, "/admin/requests");
    expect(mine.focus).toHaveBeenCalled();
    expect(mine.navigate).toHaveBeenCalledWith("https://loan.example/admin/requests");
    expect(other.focus).not.toHaveBeenCalled(); // a window of another site is never touched
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("clicking can never be turned into leaving the site", async () => {
    for (const bad of ["https://evil.example", "//evil.example/a", undefined]) {
      const w = loadWorker();
      await click(w, bad);
      const url = w.self.clients.openWindow.mock.calls[0]![0];
      expect(new URL(url).origin, String(bad)).toBe("https://loan.example");
    }
  });
});
