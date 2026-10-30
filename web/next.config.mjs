/**
 * The browser only ever talks to THIS server: every call to /api/... is forwarded to the API
 * (server to server). So there is no cross-origin request, no CORS to open up, the session cookie
 * is a first-party cookie, and in production a reverse proxy can send /api to the API directly.
 * API_URL is read on the server only; it is never sent to the browser.
 */
const API_URL = process.env.API_URL ?? "http://localhost:4000";

export const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // no framing, no <base> or form hijacking, no plugins
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The production image is built with BUILD_STANDALONE=1 (a self-contained server, no node_modules copy).
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
  async redirects() {
    // the API's new-request notification points at /admin/loan-requests; the page is /admin/requests
    return [{ source: "/admin/loan-requests", destination: "/admin/requests", permanent: false }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // a service worker must never be served from a stale cache, or a broken one could stick
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
};

export default nextConfig;
