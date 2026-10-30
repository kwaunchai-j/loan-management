import type { IncomingMessage, ServerResponse } from "node:http";
import { createServices } from "./bootstrap.js";
import { loadConfig } from "./config.js";

/**
 * The entry point on Vercel (api/index.js re-exports it): the same application as the long-running server,
 * built once per function instance on its first request. There is no listener and no in-process scheduler here:
 * the nightly jobs run through Vercel Cron on the /cron routes (see jobs/cron-routes.ts).
 */
let app: ReturnType<typeof createServices>["app"] | undefined;

function application() {
  if (!app) {
    const config = loadConfig();
    process.env.TZ = config.TZ;
    app = createServices(config).app;
  }
  return app;
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  try {
    application()(req, res);
  } catch (err) {
    // a missing or invalid setting: say so in the log (the message never contains a value), not to the caller
    console.error("startup failed:", err instanceof Error ? err.message : "unknown error");
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "เกิดข้อผิดพลาดภายในระบบ" } }));
  }
}
