// DEV-TOOLS (temporary) — lets the admin press a button in the web app to run the automated tests.
// Remove this whole folder before the real deploy: see DEV-TOOLS-REMOVAL.md.
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError } from "../http.js";

/**
 * Runs the project's own vitest suites as a child process. It can only ever start the fixed command
 * `node vitest.mjs run ...` with test files that exist in the project's `test` folder, so nothing a
 * caller sends becomes part of a command line. No shell is involved.
 */
export type Project = "api" | "web";
export type RunStatus = "running" | "passed" | "failed" | "error" | "timeout" | "cancelled";

export interface Suite {
  project: Project;
  file: string;
  area: string;
  refs: string;
  title: string;
}

export interface TestOutcome {
  ancestors: string[];
  title: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  message?: string;
}

export interface FileOutcome {
  file: string;
  status: "passed" | "failed";
  tests: TestOutcome[];
}

export interface Run {
  id: string;
  project: Project;
  files: string[];
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  counts: { passed: number; failed: number; skipped: number } | null;
  results: FileOutcome[];
  outputTail: string[];
  error: string | null;
}

/** The little we need from a child process, so tests can supply a fake one. */
export interface ChildLike {
  pid?: number;
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(): unknown;
}
export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;

export interface RunnerOptions {
  /** The folder that holds `api/`, `web/` and `tools/`. */
  repoRoot: string;
  /** Postgres URL the API tests would use; API tests are refused unless it points at this machine. */
  databaseUrl?: string;
  spawn?: SpawnFn;
  killTree?: (child: ChildLike) => void;
  timeoutMs?: number;
  now?: () => Date;
}

const MAX_RUNS = 20;
const MAX_MESSAGE = 1500;
const MAX_TAIL = 25;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;?]*[ -/]*[@-~]`, "g"); // colour and cursor codes

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as unknown as ChildLike;

/** Stops the child and everything it started (vitest workers). */
function defaultKillTree(child: ChildLike) {
  if (child.pid && process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill();
  }
}

export function isLocalDatabase(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  try {
    return LOCAL_HOSTS.has(new URL(databaseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export class TestRunner {
  private readonly runs: Run[] = [];
  private active: { run: Run; child: ChildLike; timer: NodeJS.Timeout; cancelled: boolean } | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly killTree: (c: ChildLike) => void;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: RunnerOptions) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.killTree = opts.killTree ?? defaultKillTree;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Every test file that exists, with what it protects (from tools/test-areas.json). */
  suites(): Suite[] {
    let areas: Record<Project, Record<string, [string, string, string]>> = { api: {}, web: {} };
    try {
      areas = JSON.parse(fs.readFileSync(path.join(this.opts.repoRoot, "tools", "test-areas.json"), "utf8"));
    } catch {
      /* no map: the files are still listed, under "อื่นๆ" */
    }
    const out: Suite[] = [];
    for (const project of ["api", "web"] as const) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(this.opts.repoRoot, project, "test")).filter((n) => /\.test\.tsx?$/.test(n));
      } catch {
        /* folder missing */
      }
      for (const file of names.sort()) {
        const [area, refs, title] = areas[project]?.[file] ?? ["อื่นๆ", "—", file];
        out.push({ project, file, area, refs, title });
      }
    }
    return out;
  }

  list(): { running: string | null; runs: Run[] } {
    return { running: this.active?.run.id ?? null, runs: [...this.runs].reverse().slice(0, 10).map(summary) };
  }

  get(id: string): Run | null {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  start(project: Project, files: string[] | undefined): Run {
    if (this.active) throw new DomainError(409, "RUN_IN_PROGRESS", "มีการรันเทสต์อยู่แล้ว กรุณารอให้เสร็จหรือยกเลิกก่อน");
    if (project === "api" && !isLocalDatabase(this.opts.databaseUrl)) {
      throw new DomainError(403, "NOT_LOCAL_DATABASE", "เทสต์ฝั่ง API จะรันได้เฉพาะเมื่อฐานข้อมูลอยู่ในเครื่องนี้ (localhost) เท่านั้น เพราะเทสต์เขียนข้อมูลทดสอบลงฐานข้อมูล");
    }
    const known = new Set(this.suites().filter((s) => s.project === project).map((s) => s.file));
    const wanted = files && files.length > 0 ? [...new Set(files)] : [...known];
    if (wanted.length === 0) throw new DomainError(404, "NO_TESTS", "ไม่พบไฟล์เทสต์");
    const unknown = wanted.filter((f) => !known.has(f));
    if (unknown.length > 0) throw new DomainError(400, "UNKNOWN_TEST_FILE", "มีไฟล์เทสต์ที่ไม่มีอยู่ในโปรเจกต์");

    const cwd = path.join(this.opts.repoRoot, project);
    const entry = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
    if (!fs.existsSync(entry)) throw new DomainError(500, "VITEST_MISSING", `ไม่พบ vitest ใน ${project}/node_modules (ต้องรัน npm install ก่อน)`);
    const id = randomUUID();
    const outFile = path.join(os.tmpdir(), `loan-tests-${id}.json`);
    // everything in `args` is fixed text or a file name that was checked against the folder listing above
    const args = [entry, "run", "--reporter=json", `--outputFile.json=${outFile}`, "--reporter=default", ...wanted.map((f) => `test/${f}`)];

    const run: Run = {
      id,
      project,
      files: wanted,
      status: "running",
      startedAt: this.now().toISOString(),
      finishedAt: null,
      counts: null,
      results: [],
      outputTail: [],
      error: null,
    };
    this.runs.push(run);
    while (this.runs.length > MAX_RUNS) this.runs.shift();

    const child = this.spawnFn(process.execPath, args, { cwd, env: { ...process.env, NODE_ENV: "test", FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" } });
    const timer = setTimeout(() => this.finish(run, outFile, "timeout", "ใช้เวลานานเกินกำหนด จึงหยุดการรัน"), this.timeoutMs);
    timer.unref();
    this.active = { run, child, timer, cancelled: false };

    let partial = "";
    const onData = (chunk: Buffer | string) => {
      partial += chunk.toString();
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(ANSI, "").trimEnd();
        if (clean) run.outputTail.push(clean.slice(0, 300));
      }
      while (run.outputTail.length > MAX_TAIL) run.outputTail.shift();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => this.finish(run, outFile, "error", `เริ่มรันเทสต์ไม่ได้: ${err.message}`));
    child.on("exit", (code) => this.finish(run, outFile, code === 0 ? "passed" : "failed", null));
    return run;
  }

  cancel(id: string): Run {
    const run = this.get(id);
    if (!run) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการรัน");
    if (!this.active || this.active.run !== run) throw new DomainError(409, "NOT_RUNNING", "รายการนี้ไม่ได้กำลังรันอยู่");
    this.active.cancelled = true;
    this.killTree(this.active.child);
    return run;
  }

  /** Called by the child's exit, its error, the timeout or a cancel — only the first one counts. */
  private finish(run: Run, outFile: string, outcome: RunStatus, error: string | null) {
    if (run.status !== "running") return;
    const active = this.active?.run === run ? this.active : null;
    if (active) {
      clearTimeout(active.timer);
      if (outcome === "timeout") this.killTree(active.child);
      if (active.cancelled) {
        outcome = "cancelled";
        error = "ยกเลิกการรันแล้ว";
      }
    }
    if (this.active?.run === run) this.active = null;
    run.finishedAt = this.now().toISOString();
    try {
      if (fs.existsSync(outFile)) {
        const parsed = parseReport(fs.readFileSync(outFile, "utf8"));
        run.results = parsed.results;
        run.counts = parsed.counts;
        // the exit code says "failed" for a crash too; the report says what really happened
        if (outcome === "passed" || outcome === "failed") outcome = parsed.counts.failed > 0 || parsed.suiteFailures ? "failed" : "passed";
        if (parsed.suiteFailures && !error) error = "มีไฟล์เทสต์ที่รันไม่ขึ้น (ดูรายละเอียดด้านล่าง)";
      } else if (outcome === "passed" || outcome === "failed") {
        outcome = "error";
        error = "เทสต์จบแล้วแต่ไม่มีไฟล์ผลลัพธ์ (ดูบรรทัดสุดท้ายของข้อความด้านล่าง)";
      }
    } catch {
      outcome = outcome === "cancelled" || outcome === "timeout" ? outcome : "error";
      error = error ?? "อ่านผลลัพธ์ของเทสต์ไม่ได้";
    } finally {
      fs.rm(outFile, { force: true }, () => undefined);
    }
    run.status = outcome;
    run.error = error;
  }
}

function summary(run: Run): Run {
  // the list view leaves out the (large) per-test detail
  return { ...run, results: [], outputTail: [] };
}

interface JsonAssertion {
  ancestorTitles?: string[];
  title: string;
  status: string;
  duration?: number | null;
  failureMessages?: string[];
}
interface JsonFile {
  name: string;
  status: string;
  message?: string;
  assertionResults: JsonAssertion[];
}

function parseReport(text: string) {
  const json = JSON.parse(text) as { testResults: JsonFile[] };
  const results: FileOutcome[] = [];
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let suiteFailures = 0;
  for (const f of json.testResults) {
    const tests: TestOutcome[] = f.assertionResults.map((t) => {
      const status = t.status === "passed" ? "passed" : t.status === "failed" ? "failed" : "skipped";
      counts[status]++;
      return {
        ancestors: t.ancestorTitles ?? [],
        title: t.title,
        status,
        durationMs: Math.round(t.duration ?? 0),
        ...(status === "failed" ? { message: clean((t.failureMessages ?? []).join("\n")) } : {}),
      };
    });
    // a file that could not even load has no tests, only a message
    if (f.status === "failed" && tests.every((t) => t.status !== "failed")) {
      suiteFailures++;
      tests.push({ ancestors: [], title: "(ไฟล์เทสต์รันไม่ขึ้น)", status: "failed", durationMs: 0, message: clean(f.message ?? "") });
      counts.failed++;
    }
    results.push({ file: path.basename(f.name), status: tests.some((t) => t.status === "failed") ? "failed" : "passed", tests });
  }
  results.sort((a, b) => a.file.localeCompare(b.file));
  return { results, counts, suiteFailures };
}

const clean = (s: string) => s.replace(ANSI, "").slice(0, MAX_MESSAGE);
