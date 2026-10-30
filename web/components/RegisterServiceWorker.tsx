"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) so the app can be installed to the home screen (an
 * iPhone needs that for Web Push) and shows a Thai "offline" page instead of the browser's error.
 * Only in production builds: in development a service worker just gets in the way.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* the app works without it */
    });
  }, []);
  return null;
}
