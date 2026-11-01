"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { menuFor, ROLE_LABEL } from "@/lib/access";
import { useSession } from "@/lib/session-store";
import { Icon, type IconName } from "./ui";

/** One small icon per menu entry (decorative; the label is the real name). */
const MENU_ICON: Record<string, IconName> = {
  "/admin": "home",
  "/admin/requests": "inbox",
  "/admin/calendar": "calendar",
  "/admin/contracts": "document",
  "/admin/payments": "receipt",
  "/admin/borrowers": "users",
  "/admin/reports": "chart",
  "/admin/imports": "upload",
  "/admin/notifications": "bell",
  "/admin/settings": "sliders",
  "/me": "home",
  "/me/request": "plus",
  "/me/contracts": "document",
  "/me/profile": "users",
};

/** The brand mark: a rounded square with the baht sign. */
export function BrandMark({ className = "h-10 w-10 text-xl" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-300 to-emerald-500 font-bold text-teal-950 shadow-lift ${className}`}
    >
      ฿
    </span>
  );
}

/** The frame of every logged-in page: title bar, who is logged in, logout, and the menu of that role. */
export function AppShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useSession();
  const [leaving, setLeaving] = useState(false);
  if (!user) return null;

  const all = menuFor(user.role);
  // a borrower who still has to fill in their details can open nothing else (CR-6): do not offer what would only bounce back
  const items = user.role === "BORROWER" && user.profileComplete !== true ? all.filter((i) => i.href === "/me/profile") : all;
  const active = (href: string) => (href === "/admin" || href === "/me" ? pathname === href : pathname.startsWith(href));
  const width = wide ? "max-w-5xl" : "max-w-3xl";

  async function leave() {
    setLeaving(true);
    try {
      await logout();
    } catch {
      // the server could not be reached: this browser has still forgotten the user (see the session store)
    } finally {
      router.replace("/login");
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 shadow-card">
        <div className="bg-gradient-to-r from-teal-800 via-teal-700 to-emerald-700 text-white">
          <div className={`mx-auto flex items-center justify-between gap-3 px-4 py-3 ${width}`}>
            <div className="flex min-w-0 items-center gap-3">
              <BrandMark />
              <div className="min-w-0">
                <p className="truncate text-lg font-bold leading-tight">ระบบขอยืมเงิน</p>
                <p className="truncate text-sm text-teal-50/90">
                  {user.username} · {ROLE_LABEL[user.role]}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void leave()}
              disabled={leaving}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/30 bg-white/10 px-4 text-base font-medium text-white transition hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-teal-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="logout" className="h-5 w-5" />
              ออกจากระบบ
            </button>
          </div>
        </div>
        <nav aria-label="เมนูหลัก" className="border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className={`mx-auto flex gap-1 overflow-x-auto px-3 py-2 ${width}`}>
            {items.map((item) => {
              const on = active(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={on ? "page" : undefined}
                  className={`inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 text-base font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
                    on ? "bg-teal-700 text-white shadow-sm" : "text-slate-700 hover:bg-teal-50 hover:text-teal-900"
                  }`}
                >
                  {MENU_ICON[item.href] && <Icon name={MENU_ICON[item.href]!} className="h-4 w-4" />}
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>
      <main className={`mx-auto animate-rise space-y-4 px-4 py-6 ${width}`}>{children}</main>
    </div>
  );
}
