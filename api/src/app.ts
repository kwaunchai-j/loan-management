import express from "express";
import type { Db } from "./db.js";
import { createAuthMiddleware, type AuthMiddleware } from "./auth/middleware.js";
import { createAuthRouter, type LoginRateLimitOptions } from "./auth/routes.js";
import { createPdpaRouter } from "./auth/pdpa.js";
import { createAdminBorrowersRouter } from "./admin/borrowers.js";
import { createAdminSettingsRouter } from "./admin/settings.js";
import { createBorrowerPortalRouter } from "./borrower/portal.js";
import { createAdminReportsRouter } from "./reports/routes.js";
import {
  createAdminContractsRouter,
  createAdminLoanRequestsRouter,
  createBorrowerLoanRequestsRouter,
} from "./loans/routes.js";
import { errorHandler } from "./http.js";
import { FieldCipher } from "./lib/field-crypto.js";
import type { SlipStorage } from "./lib/slip-storage.js";
import { createAdminSlipsRouter, DEFAULT_SLIP_MAX_BYTES } from "./loans/slips.js";
import { createAdminLedgerRouter } from "./loans/ledger-routes.js";
import { createAdminCalendarRouter, createAdminSubmissionsRouter } from "./loans/submission-routes.js";
import { createAdminImportsRouter, DEFAULT_IMPORT_MAX_BYTES } from "./imports/routes.js";
import type { ImportStorage } from "./imports/storage.js";
import type { Notifier } from "./notifications/service.js";
import { createNotificationSetupRouter } from "./notifications/routes.js";
import { createDevTestsRouter } from "./dev-tools/routes.js"; // DEV-TOOLS (temporary)
import type { TestRunner } from "./dev-tools/test-runner.js"; // DEV-TOOLS (temporary)

export interface AppDeps {
  prisma: Db;
  sessionSecret: string;
  /** Cookie `Secure` flag; true in production (HTTPS). */
  secureCookie?: boolean;
  loginRateLimit?: LoginRateLimitOptions;
  /** Base64 32-byte key for encrypting sensitive columns (bank account numbers). */
  fieldEncryptionKey: string;
  /**
   * Reverse proxies in front of the API (Express "trust proxy" hop count). 0 = none: the socket
   * address is the client IP and X-Forwarded-For is ignored, so it cannot be spoofed to dodge
   * login throttling. Only raise it when a proxy you control sets that header.
   */
  trustProxy?: number;
  /** Where transfer slips are kept (ADMIN-only access, see loans/slips.ts). */
  slipStorage: SlipStorage;
  slipMaxBytes?: number;
  /** Where uploaded import files wait for the admin to confirm them. */
  importStorage: ImportStorage;
  importMaxBytes?: number;
  /** Admin notifications (LINE, Web Push). Optional: without it nothing is sent. */
  notifier?: Notifier;
  /** Public VAPID key served to the browser so it can subscribe to Web Push. */
  vapidPublicKey?: string;
  /** DEV-TOOLS (temporary): the in-app test runner. Absent = the /admin/dev-tests routes do not exist. */
  devTestRunner?: TestRunner;
}

export interface CreatedApp {
  app: express.Express;
  /** Present only when deps were supplied; later routers import these. */
  auth?: AuthMiddleware;
}

export function buildApp(deps?: AppDeps): CreatedApp {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps?.trustProxy ?? 0);
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  let auth: AuthMiddleware | undefined;
  if (deps) {
    const cipher = new FieldCipher(deps.fieldEncryptionKey);
    auth = createAuthMiddleware({ prisma: deps.prisma, sessionSecret: deps.sessionSecret });
    app.use(
      "/auth",
      createAuthRouter({
        prisma: deps.prisma,
        auth,
        sessionSecret: deps.sessionSecret,
        secureCookie: deps.secureCookie ?? false,
        rateLimit: deps.loginRateLimit,
      }),
    );
    app.use(
      "/me",
      createBorrowerPortalRouter({
        prisma: deps.prisma,
        auth,
        cipher,
        storage: deps.slipStorage,
        slipMaxBytes: deps.slipMaxBytes ?? DEFAULT_SLIP_MAX_BYTES,
        // the admin is told right away; a failing channel never fails or delays the borrower
        onPaymentSubmitted: (id) => deps.notifier?.dispatch(() => deps.notifier!.paymentSubmitted(id)),
      }),
    );
    app.use("/admin/payment-submissions", createAdminSubmissionsRouter({ prisma: deps.prisma, auth }));
    app.use("/admin/calendar", createAdminCalendarRouter({ prisma: deps.prisma, auth }));
    app.use("/admin/reports", createAdminReportsRouter({ prisma: deps.prisma, auth }));
    app.use("/pdpa", createPdpaRouter({ prisma: deps.prisma, auth }));
    app.use(
      "/admin/borrowers",
      createAdminBorrowersRouter({
        prisma: deps.prisma,
        auth,
        cipher,
      }),
    );
    app.use("/admin/settings", createAdminSettingsRouter({ prisma: deps.prisma, auth }));
    app.use(
      "/loan-requests",
      createBorrowerLoanRequestsRouter({
        prisma: deps.prisma,
        auth,
        // the admin is told right away; a failing channel never fails or delays the borrower
        onRequestCreated: (id) => deps.notifier?.dispatch(() => deps.notifier!.newRequest(id)),
      }),
    );
    app.use("/admin/loan-requests", createAdminLoanRequestsRouter({ prisma: deps.prisma, auth }));
    app.use("/admin/contracts", createAdminContractsRouter({ prisma: deps.prisma, auth, storage: deps.slipStorage }));
    app.use(
      "/admin",
      createNotificationSetupRouter({
        prisma: deps.prisma,
        auth,
        adapters: deps.notifier?.channels ?? [],
        vapidPublicKey: deps.vapidPublicKey,
      }),
    );
    app.use(
      "/admin/imports",
      createAdminImportsRouter({
        prisma: deps.prisma,
        auth,
        storage: deps.importStorage,
        maxBytes: deps.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES,
      }),
    );
    // DEV-TOOLS (temporary): test runner button; only when DEV_TEST_RUNNER is on
    if (deps.devTestRunner) app.use("/admin/dev-tests", createDevTestsRouter({ auth, runner: deps.devTestRunner }));
    app.use("/admin", createAdminLedgerRouter({ prisma: deps.prisma, auth, storage: deps.slipStorage }));
    app.use(
      "/admin/slips",
      createAdminSlipsRouter({
        auth,
        storage: deps.slipStorage,
        maxBytes: deps.slipMaxBytes ?? DEFAULT_SLIP_MAX_BYTES,
      }),
    );
  }

  app.use(errorHandler);
  return { app, auth };
}

export function createApp(deps?: AppDeps) {
  return buildApp(deps).app;
}
