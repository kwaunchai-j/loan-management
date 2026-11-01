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
  profileComplete: true,
  ...over,
});

describe("destinationFor", () => {
  it("sends anonymous visitors to the login page", () => {
    expect(destinationFor(null)).toBe("/login");
  });

  it("sends an admin to /admin and a consenting borrower to /me", () => {
    expect(destinationFor(user({ role: "ADMIN", borrowerId: null, pdpaAccepted: null, profileComplete: null }))).toBe("/admin");
    expect(destinationFor(user({}))).toBe("/me");
  });

  it("sends a borrower without PDPA acceptance to the PDPA page first", () => {
    expect(destinationFor(user({ pdpaAccepted: false }))).toBe("/pdpa");
    // anything that is not exactly "accepted" counts as not accepted
    expect(destinationFor(user({ pdpaAccepted: null }))).toBe("/pdpa");
  });

  it("holds a borrower whose phone, bank or account number is missing on the profile page (CR-6)", () => {
    expect(destinationFor(user({ profileComplete: false }))).toBe("/me/profile");
    // anything that is not exactly "complete" counts as incomplete
    expect(destinationFor(user({ profileComplete: null }))).toBe("/me/profile");
  });

  it("asks for consent first, then for the details", () => {
    expect(destinationFor(user({ pdpaAccepted: false, profileComplete: false }))).toBe("/pdpa");
    expect(destinationFor(user({ pdpaAccepted: true, profileComplete: false }))).toBe("/me/profile");
  });

  it("does not hold an admin on the profile page", () => {
    expect(destinationFor(user({ role: "ADMIN", borrowerId: null, pdpaAccepted: null, profileComplete: null }))).toBe("/admin");
  });

  it("forces a password change before everything else, for both roles", () => {
    expect(destinationFor(user({ mustChangePassword: true, pdpaAccepted: false }))).toBe("/change-password");
    expect(destinationFor(user({ role: "ADMIN", mustChangePassword: true, borrowerId: null, pdpaAccepted: null, profileComplete: null }))).toBe("/change-password");
  });
});

describe("resolveAccess (what each page lets in)", () => {
  const people: Record<string, SessionUser | null> = {
    anonymous: null,
    admin: user({ role: "ADMIN", borrowerId: null, pdpaAccepted: null, profileComplete: null }),
    borrower: user({}),
    borrowerNoPdpa: user({ pdpaAccepted: false }),
    mustChange: user({ mustChangePassword: true }),
    borrowerNoDetails: user({ profileComplete: false }), // the lender cleared the phone / account number (CR-6)
  };
  // who may see which page; everybody else is redirected to where they belong
  const allowed: Record<Need, string[]> = {
    anonymous: ["anonymous"],
    "change-password": ["mustChange"],
    pdpa: ["borrowerNoPdpa"],
    admin: ["admin"],
    borrower: ["borrower"],
    // the profile page: open to the borrower who must fill the details in, and to one who already has
    profile: ["borrower", "borrowerNoDetails"],
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

  it("sends a borrower with missing details from any borrower page to the profile page, and never lets an admin onto it", () => {
    expect(resolveAccess(people.borrowerNoDetails!, "borrower")).toEqual({ allowed: false, redirect: "/me/profile" });
    expect(resolveAccess(people.admin!, "profile")).toEqual({ allowed: false, redirect: "/admin" });
    expect(resolveAccess(people.borrowerNoPdpa!, "profile")).toEqual({ allowed: false, redirect: "/pdpa" });
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
    expect(hrefs).toEqual(["/me", "/me/request", "/me/contracts", "/me/profile"]);
    expect(hrefs.some((h) => h.startsWith("/admin"))).toBe(false);
  });

  it("is written in Thai", () => {
    for (const role of ["ADMIN", "BORROWER"] as const) {
      for (const item of menuFor(role)) expect(item.label).toMatch(/[฀-๿]/);
    }
  });
});
