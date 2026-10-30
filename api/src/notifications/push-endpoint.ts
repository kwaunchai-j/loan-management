/**
 * A push subscription's endpoint is a URL the SERVER will later POST to. If any URL were accepted,
 * a stored endpoint could make the server call internal addresses (SSRF). So only the real push
 * services of the major browsers are accepted: HTTPS, default port, no credentials, host on the
 * list below. IP addresses and "localhost" can never match.
 */
const PUSH_SERVICE_DOMAINS = [
  "fcm.googleapis.com", // Chrome, Edge, Android browsers
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari / iPhone web apps
  "notify.windows.com", // Edge / Windows
];

export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** p256dh is a 65-byte P-256 point and auth a 16-byte secret, both base64url. */
export function isValidSubscriptionKeys(p256dh: string, auth: string): boolean {
  const ok = /^[A-Za-z0-9_-]+$/;
  return ok.test(p256dh) && ok.test(auth) && Buffer.from(p256dh, "base64url").length === 65 && Buffer.from(auth, "base64url").length === 16;
}
