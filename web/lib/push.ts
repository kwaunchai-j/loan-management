/**
 * Web Push in the browser (T-903). Every function takes what it reads from the browser as a normal
 * call (navigator / Notification), so the page logic can be tested without a real push service.
 *
 * Why the extra steps: an iPhone only allows Web Push for a web app that was ADDED TO THE HOME
 * SCREEN and opened from that icon (iOS 16.4+), and a push subscription needs the service worker
 * (public/sw.js), which is only registered in production builds.
 */
export type PushState =
  | { kind: "unsupported" }
  | { kind: "needs-install" } // iPhone/iPad, not opened from the home-screen icon
  | { kind: "no-worker" } // the service worker is not registered (development build, or first visit)
  | { kind: "blocked" } // the user refused notifications in the browser
  | { kind: "off" }
  | { kind: "on"; endpoint: string };

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ says "Macintosh" but has a touch screen
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Where this device stands: can it take push, is it on already, or what is in the way. */
export async function readPushState(): Promise<PushState> {
  if (isIos() && !isStandalone()) return { kind: "needs-install" };
  if (!pushSupported()) return { kind: "unsupported" };
  if (Notification.permission === "denied") return { kind: "blocked" };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { kind: "no-worker" };
  const sub = await reg.pushManager.getSubscription();
  return sub ? { kind: "on", endpoint: sub.endpoint } : { kind: "off" };
}

/** The VAPID public key is base64url text; the browser wants bytes. */
export function urlBase64ToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A problem with a Thai message that is meant to be shown as it is (anything else is shown as a generic error). */
export class PushError extends Error {}
export class PushPermissionError extends PushError {}

/** Asks for permission and subscribes this browser. Returns exactly what the API needs: endpoint + keys. */
export async function subscribeThisDevice(publicKey: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new PushError("ยังไม่มี service worker ใช้ได้เฉพาะเวอร์ชันที่เปิดใช้งานจริง");
  if ((await Notification.requestPermission()) !== "granted") {
    throw new PushPermissionError("ไม่ได้รับอนุญาตให้แสดงการแจ้งเตือน กรุณาอนุญาตในการตั้งค่าของเบราว์เซอร์");
  }
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new PushError("เบราว์เซอร์ไม่ได้ส่งกุญแจการสมัครรับแจ้งเตือนมา");
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** Turns push off in this browser; returns the endpoint that was subscribed (to tell the server), if any. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
