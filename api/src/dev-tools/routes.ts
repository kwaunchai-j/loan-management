// DEV-TOOLS (temporary): remove with the rest of this folder before the real deploy (DEV-TOOLS-REMOVAL.md).
import { Router } from "express";
import { z } from "zod";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, DomainError } from "../http.js";
import type { TestRunner } from "./test-runner.js";

const startBody = z.object({
  project: z.enum(["api", "web"]),
  // empty or missing = every test file of the project; names are checked against the real folder listing
  files: z.array(z.string().min(1).max(100)).max(100).optional(),
});

/** Mounted at /admin/dev-tests, and only when DEV_TEST_RUNNER is on. ADMIN only. */
export function createDevTestsRouter(deps: { auth: AuthMiddleware; runner: TestRunner }): Router {
  const router = Router();
  router.use(deps.auth.authorize("ADMIN"));

  router.get("/", (_req, res) => {
    res.json({ suites: deps.runner.suites(), ...deps.runner.list() });
  });

  router.post(
    "/runs",
    asyncHandler(async (req, res) => {
      const body = startBody.safeParse(req.body);
      if (!body.success) throw new DomainError(400, "INVALID_INPUT", "ข้อมูลที่ส่งมาไม่ถูกต้อง");
      const run = deps.runner.start(body.data.project, body.data.files);
      console.log(`dev-tests: started ${run.project} run ${run.id} (${run.files.length} file(s))`);
      res.status(202).json({ run });
    }),
  );

  router.get("/runs/:id", (req, res) => {
    const run = deps.runner.get(String(req.params.id));
    if (!run) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการรัน");
    res.json({ run });
  });

  router.delete("/runs/:id", (req, res) => {
    res.json({ run: deps.runner.cancel(String(req.params.id)) });
  });

  return router;
}
