import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch, errorMessage, setUnauthorizedHandler } from "@/lib/api";
import { apiError, mockApi } from "./mocks";

const schema = z.object({ n: z.string() });

describe("apiFetch", () => {
  it("calls the same-origin /api path with the cookie and JSON body", async () => {
    const calls = mockApi({ "POST /thing": { body: { n: "1" } } });
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await apiFetch("/thing", { method: "POST", json: { a: 1 }, schema });
    expect(calls).toEqual([{ method: "POST", path: "/thing", body: { a: 1 } }]);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/thing");
  });

  it("returns only data that matches the contract", async () => {
    mockApi({ "GET /thing": { body: { n: "ok" } } });
    await expect(apiFetch("/thing", { schema })).resolves.toEqual({ n: "ok" });
  });

  it("refuses a response that breaks the contract instead of using it", async () => {
    mockApi({ "GET /thing": { body: { n: 5 } } });
    await expect(apiFetch("/thing", { schema })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("turns an API error into ApiError with the API's Thai message", async () => {
    mockApi({ "GET /thing": apiError(409, "USERNAME_TAKEN", "ชื่อผู้ใช้นี้ถูกใช้แล้ว") });
    const err = await apiFetch("/thing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "USERNAME_TAKEN", message: "ชื่อผู้ใช้นี้ถูกใช้แล้ว" });
  });

  it("uses a Thai generic message when the error is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const err = await apiFetch("/thing").catch((e: unknown) => e);
    expect(errorMessage(err)).toMatch(/[฀-๿]/);
    expect((err as ApiError).message).not.toContain("html");
  });

  it("reports a network failure in Thai", async () => {
    mockApi({ "GET /thing": new TypeError("fetch failed") });
    const err = await apiFetch("/thing").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "NETWORK" });
    expect(errorMessage(err)).toMatch(/อินเทอร์เน็ต/);
  });

  it("never shows raw error text of unknown failures", () => {
    expect(errorMessage(new Error("ECONNREFUSED 127.0.0.1:4000 secret"))).not.toContain("ECONNREFUSED");
  });

  it("tells the session store when the session is gone (401 UNAUTHENTICATED only)", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    mockApi({
      "GET /a": apiError(401, "UNAUTHENTICATED", "x"),
      "GET /b": apiError(401, "INVALID_CREDENTIALS", "x"),
      "GET /c": apiError(403, "FORBIDDEN", "x"),
    });
    await apiFetch("/a").catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await apiFetch("/b").catch(() => undefined);
    await apiFetch("/c").catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1); // a wrong password at login is not "session lost"
    setUnauthorizedHandler(null);
  });

  it("accepts an empty 204 reply", async () => {
    mockApi({ "POST /auth/logout": { status: 204 } });
    await expect(apiFetch("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("sends a chosen file as the raw body with its own content type (a slip image)", async () => {
    const calls = mockApi({ "POST /admin/slips": { status: 201, body: { n: "k" } } });
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const file = new File([new Uint8Array(10)], "slip.png", { type: "image/png" });
    await apiFetch("/admin/slips", { method: "POST", file, schema });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(file);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("image/png");
    expect(calls[0]!.body).toEqual({ file: { type: "image/png", size: 10 } });
  });
});
