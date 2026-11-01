import { create } from "zustand";
import { ApiError, apiFetch, setProfileRequiredHandler, setUnauthorizedHandler } from "./api";
import { loginResponseSchema, meResponseSchema, pdpaStatusSchema, type SessionUser } from "./schemas";

/**
 * Who is logged in, as the API says. The browser holds no token (the cookie is httpOnly): the
 * session is learned by asking GET /auth/me, and forgotten when the API answers 401.
 */
export type SessionStatus = "loading" | "anonymous" | "authenticated" | "error";

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  /** Asks the API who this browser is. */
  load: () => Promise<void>;
  login: (username: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<SessionUser>;
  acceptPdpa: (version: string) => Promise<SessionUser>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  user: null,

  async load() {
    try {
      const { user } = await apiFetch("/auth/me", { schema: meResponseSchema });
      set({ status: "authenticated", user });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ status: "anonymous", user: null });
      else set({ status: "error", user: null });
    }
  },

  async login(username, password) {
    await apiFetch("/auth/login", { method: "POST", json: { username, password }, schema: loginResponseSchema });
    await get().load(); // the cookie is set; ask who we are now (also gives the PDPA status)
    const { user } = get();
    if (!user) throw new ApiError(0, "NETWORK", "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่");
    return user;
  },

  async logout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } finally {
      set({ status: "anonymous", user: null });
    }
  },

  async changePassword(currentPassword, newPassword) {
    await apiFetch("/auth/change-password", {
      method: "POST",
      json: { currentPassword, newPassword },
      schema: loginResponseSchema,
    });
    await get().load();
    const { user } = get();
    if (!user) throw new ApiError(0, "NETWORK", "เปลี่ยนรหัสผ่านแล้ว แต่โหลดข้อมูลผู้ใช้ไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่");
    return user;
  },

  async acceptPdpa(version) {
    await apiFetch("/pdpa/accept", { method: "POST", json: { version }, schema: pdpaStatusSchema });
    await get().load();
    const { user } = get();
    if (!user) throw new ApiError(0, "NETWORK", "บันทึกการยอมรับแล้ว แต่โหลดข้อมูลผู้ใช้ไม่สำเร็จ");
    return user;
  },
}));

// A 401 from any call means the session is gone: forget it, and the page guards send the user to /login.
setUnauthorizedHandler(() => useSession.setState({ status: "anonymous", user: null }));

// A 403 PROFILE_REQUIRED means the lender cleared this borrower's details meanwhile: ask who we are again, and the page
// guards send the borrower to the profile page.
setProfileRequiredHandler(() => void useSession.getState().load());
