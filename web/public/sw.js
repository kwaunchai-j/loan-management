// Minimal service worker: it makes the app installable, shows a Thai "you are offline" page when a
// page cannot be loaded, and shows Web Push notifications for the admin. It deliberately caches
// NOTHING else — loan balances, contracts and slips are personal data and must never be served from
// a device cache, and /api is never touched.
const CACHE = "loan-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// A notification may only open a page of THIS site: "/admin/contracts" yes, "https://evil.example" or
// "//evil.example" no (a push payload comes from the server, but it is still never trusted as an address).
function safePath(value) {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/";
}

// Web Push (T-903). The payload is {title, body, url}. Whatever arrives, a notification is always shown
// (browsers require that for a push), with plain text only.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 100) : "ระบบขอยืมเงิน";
  const body = typeof data.body === "string" ? data.body.slice(0, 300) : "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      lang: "th",
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Only page navigations get the offline fallback; everything else (API calls, POSTs, assets) goes
  // straight to the network exactly as if there were no service worker.
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
});
