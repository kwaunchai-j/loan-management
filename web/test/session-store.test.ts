import { describe, expect, it } from "vitest";
import { useSession } from "@/lib/session-store";
import { admin, apiError, borrowerUser, mockApi } from "./mocks";

describe("session store", () => {
  it("learns who is logged in from GET /auth/me", async () => {
    mockApi({ "GET /auth/me": { body: { user: admin } } });
    await useSession.getState().load();
    expect(useSession.getState()).toMatchObject({ status: "authenticated", user: { username: "boss", role: "ADMIN" } });
  });

  it("is anonymous on 401, but 'error' (not logged out) when the server cannot be reached", async () => {
    mockApi({ "GET /auth/me": apiError(401, "UNAUTHENTICATED", "x") });
    await useSession.getState().load();
    expect(useSession.getState().status).toBe("anonymous");

    mockApi({ "GET /auth/me": new TypeError("down") });
    await useSession.getState().load();
    expect(useSession.getState()).toMatchObject({ status: "error", user: null });
  });

  it("treats a malformed /auth/me answer as an error, never as a user", async () => {
    mockApi({ "GET /auth/me": { body: { user: { username: "x", role: "SUPERUSER" } } } });
    await useSession.getState().load();
    expect(useSession.getState()).toMatchObject({ status: "error", user: null });
  });

  it("login posts the credentials, then reloads the user (including PDPA status)", async () => {
    const calls = mockApi({
      "POST /auth/login": { body: { user: { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: false } } },
      "GET /auth/me": { body: { user: { ...borrowerUser, pdpaAccepted: false } } },
    });
    const user = await useSession.getState().login("somchai", "pw-1234567890");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /auth/login", "GET /auth/me"]);
    expect(calls[0]!.body).toEqual({ username: "somchai", password: "pw-1234567890" });
    expect(user.pdpaAccepted).toBe(false);
  });

  it("a failed login leaves the store anonymous and shows the API's message", async () => {
    mockApi({ "POST /auth/login": apiError(401, "INVALID_CREDENTIALS", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง") });
    useSession.setState({ status: "anonymous", user: null });
    await expect(useSession.getState().login("a", "b")).rejects.toMatchObject({ message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    expect(useSession.getState().user).toBeNull();
  });

  it("logout forgets the user even if the server call fails", async () => {
    mockApi({ "POST /auth/logout": new TypeError("down") });
    useSession.setState({ status: "authenticated", user: admin });
    await useSession.getState().logout().catch(() => undefined);
    expect(useSession.getState()).toMatchObject({ status: "anonymous", user: null });
  });

  it("a 401 on any call logs the page out", async () => {
    mockApi({ "GET /admin/settings": apiError(401, "UNAUTHENTICATED", "x") });
    useSession.setState({ status: "authenticated", user: admin });
    const { apiFetch } = await import("@/lib/api");
    await apiFetch("/admin/settings").catch(() => undefined);
    expect(useSession.getState()).toMatchObject({ status: "anonymous", user: null });
  });

  it("acceptPdpa sends the version it was given and reloads the user", async () => {
    const calls = mockApi({
      "POST /pdpa/accept": { body: { currentVersion: "2025-01", accepted: true, acceptedAt: "2025-01-01T00:00:00Z", acceptedVersion: "2025-01" } },
      "GET /auth/me": { body: { user: borrowerUser } },
    });
    const user = await useSession.getState().acceptPdpa("2025-01");
    expect(calls[0]!.body).toEqual({ version: "2025-01" });
    expect(user.pdpaAccepted).toBe(true);
  });

  it("changePassword sends both passwords and reloads the user", async () => {
    const calls = mockApi({
      "POST /auth/change-password": { body: { user: { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: false } } },
      "GET /auth/me": { body: { user: borrowerUser } },
    });
    await useSession.getState().changePassword("old-password-1", "new-password-2");
    expect(calls[0]!.body).toEqual({ currentPassword: "old-password-1", newPassword: "new-password-2" });
  });
});
