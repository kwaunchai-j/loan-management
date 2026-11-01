import type { SessionUser } from "./schemas";

/**
 * Where each kind of user belongs (T-701). One pure function decides it, so the same rule drives
 * the redirect after login, every page guard and the menu:
 *
 *   not logged in                       -> /login
 *   must change the first password      -> /change-password   (before anything else)
 *   ADMIN                               -> /admin
 *   BORROWER who has not accepted PDPA  -> /pdpa              (before any borrower page)
 *   BORROWER with phone, bank or account
 *     number missing                    -> /me/profile        (the only borrower page open to them, CR-6)
 *   BORROWER                            -> /me
 *
 * This only decides what the PAGES show. The real access control is in the API, which refuses
 * every request the user may not make whatever the page does.
 */
export function destinationFor(user: SessionUser | null): string {
  if (!user) return "/login";
  if (user.mustChangePassword) return "/change-password";
  if (user.role === "ADMIN") return "/admin";
  // a borrower whose PDPA status is anything but "accepted" is sent to accept it first
  if (user.pdpaAccepted !== true) return "/pdpa";
  // the lender must be able to reach the borrower and know where to send the money: until the details are in, nothing else opens
  if (user.profileComplete !== true) return "/me/profile";
  return "/me";
}

export type Need = "anonymous" | "change-password" | "pdpa" | "admin" | "borrower" | "profile";

const HOME_OF: Record<Need, string> = {
  anonymous: "/login",
  "change-password": "/change-password",
  pdpa: "/pdpa",
  admin: "/admin",
  borrower: "/me",
  profile: "/me/profile",
};

export type Access = { allowed: true } | { allowed: false; redirect: string };

/** May `user` see a page that needs `need`? If not, where must they go instead? */
export function resolveAccess(user: SessionUser | null, need: Need): Access {
  const destination = destinationFor(user);
  // the profile page is for a borrower who has to fill the details in, and stays open to one who already has
  const ok = need === "profile" ? destination === "/me" || destination === "/me/profile" : destination === HOME_OF[need];
  return ok ? { allowed: true } : { allowed: false, redirect: destination };
}

export interface NavItem {
  href: string;
  label: string;
}

/** The menu of a role. Only pages that exist are listed. */
export function menuFor(role: SessionUser["role"]): NavItem[] {
  if (role === "ADMIN") {
    return [
      { href: "/admin", label: "หน้าหลัก" },
      { href: "/admin/requests", label: "คำขอยืม" },
      { href: "/admin/calendar", label: "ปฏิทิน" },
      { href: "/admin/contracts", label: "สัญญา" },
      { href: "/admin/payments", label: "สลิปชำระ" },
      { href: "/admin/borrowers", label: "ผู้ยืม" },
      { href: "/admin/reports", label: "รายงาน" },
      { href: "/admin/imports", label: "นำเข้าข้อมูล" },
      { href: "/admin/notifications", label: "แจ้งเตือน" },
      { href: "/admin/settings", label: "ตั้งค่าอัตรา" },
    ];
  }
  return [
    { href: "/me", label: "หน้าหลัก" },
    { href: "/me/request", label: "ขอยืมเงิน" },
    { href: "/me/contracts", label: "สัญญาของฉัน" },
    { href: "/me/profile", label: "ข้อมูลของฉัน" },
  ];
}

export const ROLE_LABEL: Record<SessionUser["role"], string> = {
  ADMIN: "ผู้ดูแลระบบ",
  BORROWER: "ผู้ยืม",
};
