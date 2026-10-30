import { describe, expect, it } from "vitest";
import { destinationFor, menuFor, resolveAccess, type Need } from "@/lib/access";
import type { SessionUser } from "@/lib/schemas";

const user = (over: Partial<SessionUser>): SessionUser => ({
  id: "u",
  username: "x",
  role: "BORROWER",
  mustChangePassword: false,
  borrowerId: "b",
  pdpaAccepted: true,
  ...over,
});

describe("destinationFor", () => {
  it("sends anonymous visitors to the login page", () => {
    expect(destinationFor(null)).toBe("/login");
  });

  it("sends an admin to /admin and a consenting borrower to /me", () => {
    expect(destinationFor(user({ role: "ADMIN", borrowerId: null, pdpaAccepted: null }))).toBe("/admin");
    expect(destinationFor(user({}))).toBe("/me");
  });

  it("sends a borrower without PDPA acceptance to the PDPA page first", () => {
    expect(destinationFor(user({ pdpaAccepted: false }))).toBe("/pdpa");
    // anything that is not exactly "accepted" counts as not accepted
    expect(destinationFor(user({ pdpaAccepted: null }))).toBe("/pdpa");
  });

  it("forces a password change before everything else, for both roles", () => {
    expect(destinationFor(user({ mustChangePassword: true, pdpaAccepted: false }))).toBe("/change-password");
    expect(destinationFor(user({ role: "ADMIN", mustChangePassword: true, borrowerId: null, pdpaAccepted: null }))).toBe("/change-password");
  });
});

describe("resolveAccess (what each page lets in)", () => {
  const people: Record<string, SessionUser | null> = {
    anonymous: null,
    admin: user({ role: "ADMIN", borrowerId: null, pdpaAccepted: null }),
    borrower: user({}),
    borrowerNoPdpa: user({ pdpaAccepted: false }),
    mustChange: user({ mustChangePassword: true }),
  };
  // who may see which page; everybody else is redirected to where they belong
  const allowed: Record<Need, string[]> = {
    anonymous: ["anonymous"],
    "change-password": ["mustChange"],
    pdpa: ["borrowerNoPdpa"],
    admin: ["admin"],
    borrower: ["borrower"],
  };

  for (const need of Object.keys(allowed) as Need[]) {
    for (const [who, u] of Object.entries(people)) {
      it(`${who} on a "${need}" page`, () => {
        const result = resolveAccess(u, need);
        expect(result.allowed).toBe(allowed[need].includes(who));
        if (!result.allowed) expect(result.redirect).toBe(destinationFor(u));
      });
    }
  }

  it("never lets a borrower into an admin page", () => {
    expect(resolveAccess(people.borrower!, "admin")).toEqual({ allowed: false, redirect: "/me" });
  });

  it("never lets an admin into a borrower page", () => {
    expect(resolveAccess(people.admin!, "borrower")).toEqual({ allowed: false, redirect: "/admin" });
  });
});

describe("menuFor", () => {
  it("shows an admin the admin pages only", () => {
    expect(menuFor("ADMIN").map((m) => m.href)).toEqual([
      "/admin",
      "/admin/requests",
      "/admin/calendar",
      "/admin/contracts",
      "/admin/payments",
      "/admin/borrowers",
      "/admin/reports",
      "/admin/imports",
      "/admin/notifications",
      "/admin/settings",
    ]);
  });

  it("shows a borrower no admin page", () => {
    const hrefs = menuFor("BORROWER").map((m) => m.href);
    expect(hrefs).toEqual(["/me", "/me/request", "/me/contracts"]);
    expect(hrefs.some((h) => h.startsWith("/admin"))).toBe(false);
  });

  it("is written in Thai", () => {
    for (const role of ["ADMIN", "BORROWER"] as const) {
      for (const item of menuFor(role)) expect(item.label).toMatch(/[฀-๿]/);
    }
  });
});
