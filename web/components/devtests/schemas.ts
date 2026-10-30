// DEV-TOOLS (temporary) — remove with the rest of the dev-tools files (DEV-TOOLS-REMOVAL.md).
import { z } from "zod";

export const suiteSchema = z.object({
  project: z.enum(["api", "web"]),
  file: z.string(),
  area: z.string(),
  refs: z.string(),
  title: z.string(),
});

const testSchema = z.object({
  ancestors: z.array(z.string()),
  title: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  message: z.string().optional(),
});

export const runSchema = z.object({
  id: z.string(),
  project: z.enum(["api", "web"]),
  files: z.array(z.string()),
  status: z.enum(["running", "passed", "failed", "error", "timeout", "cancelled"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: z.object({ passed: z.number(), failed: z.number(), skipped: z.number() }).nullable(),
  results: z.array(z.object({ file: z.string(), status: z.enum(["passed", "failed"]), tests: z.array(testSchema) })),
  outputTail: z.array(z.string()),
  error: z.string().nullable(),
});

export const overviewSchema = z.object({ suites: z.array(suiteSchema), running: z.string().nullable(), runs: z.array(runSchema) });
export const runResponseSchema = z.object({ run: runSchema });

export type Suite = z.infer<typeof suiteSchema>;
export type Run = z.infer<typeof runSchema>;
