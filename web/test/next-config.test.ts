import { describe, expect, it } from "vitest";
import config, { securityHeaders } from "../next.config.mjs";

describe("next.config", () => {
  it("forwards /api/* to the API server side, so the browser stays on one origin", async () => {
    const rewrites = await config.rewrites!();
    expect(rewrites).toEqual([{ source: "/api/:path*", destination: expect.stringMatching(/^https?:\/\/.+\/:path\*$/) }]);
  });

  it("sends the security headers on every page", async () => {
    const headers = await config.headers!();
    const all = headers.find((h) => h.source === "/:path*");
    const byKey = Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
    expect(securityHeaders.length).toBeGreaterThanOrEqual(5);
  });

  it("never lets the service worker file be cached", async () => {
    const headers = await config.headers!();
    const sw = headers.find((h) => h.source === "/sw.js");
    expect(sw?.headers[0]?.value).toContain("no-store");
  });

  it("sends the old new-request notification address to the page that exists", async () => {
    // the API's push message links to /admin/loan-requests; the page is /admin/requests
    const redirects = await config.redirects!();
    expect(redirects).toEqual([{ source: "/admin/loan-requests", destination: "/admin/requests", permanent: false }]);
  });

  it("does not advertise the framework", () => {
    expect(config.poweredByHeader).toBe(false);
  });
});
