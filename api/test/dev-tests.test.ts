// DEV-TOOLS (temporary): tests of the in-app test runner. Delete this file with the dev-tools folder.
import "dotenv/config";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { AuthMiddleware } from "../src/auth/middleware.js";
import { buildApp } from "../src/app.js";
import { createDevTestsRouter } from "../src/dev-tools/routes.js";
import { isLocalDatabase, TestRunner, type ChildLike, type SpawnFn } from "../src/dev-tools/test-runner.js";
import { errorHandler } from "../src/http.js";
import { hashPassword } from "../src/lib/password.js";
import { RELAXED_LOGIN_LIMITS, TEST_FIELD_KEY, TEST_IMPORT_STORAGE, TEST_SLIP_STORAGE } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// a throw-away repository: api/test, web/test, tools/test-areas.json, and a fake vitest entry
// ---------------------------------------------------------------------------------------------
let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "devtests-"));
  for (const [p, files] of [["api", ["alpha.test.ts", "beta.test.ts", "helpers.ts", "notes.md"]], ["web", ["gamma.test.tsx", "unmapped.test.ts"]]] as const) {
    fs.mkdirSync(path.join(repo, p, "test"), { recursive: true });
    fs.mkdirSync(path.join(repo, p, "node_modules", "vitest"), { recursive: true });
    fs.writeFileSync(path.join(repo, p, "node_modules", "vitest", "vitest.mjs"), "");
    for (const f of files) fs.writeFileSync(path.join(repo, p, "test", f), "");
  }
  fs.mkdirSync(path.join(repo, "tools"));
  fs.writeFileSync(
    path.join(repo, "tools", "test-areas.json"),
    JSON.stringify({ api: { "alpha.test.ts": ["การเงิน", "F4", "lib/alpha"], "beta.test.ts": ["การเงิน", "F5", "lib/beta"] }, web: { "gamma.test.tsx": ["หน้าจอ", "F1", "หน้า gamma"] } }),
  );
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

/** A child process we control by hand. */
class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new EventEmitter() as unknown as ChildLike["stdout"];
  stderr = new EventEmitter() as unknown as ChildLike["stderr"];
  killed = 0;
  kill() {
    this.killed++;
  }
  say(text: string) {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
  /** Writes the JSON report where the runner asked for it, then exits. */
  finish(report: object | null, code: number | null) {
    const arg = this.args.find((a) => a.startsWith("--outputFile.json="))!;
    if (report) fs.writeFileSync(arg.slice("--outputFile.json=".length), JSON.stringify(report));
    this.emit("exit", code);
  }
  constructor(readonly args: string[], readonly cwd: string, readonly env: NodeJS.ProcessEnv) {
    super();
  }
}

function setup(over: { databaseUrl?: string; timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const spawn: SpawnFn = vi.fn((_cmd, args, o) => {
    const c = new FakeChild(args, o.cwd, o.env);
    children.push(c);
    return c;
  });
  const killTree = vi.fn();
  const runner = new TestRunner({ repoRoot: repo, databaseUrl: "postgresql://u:p@localhost:5433/db", spawn, killTree, ...over });
  return { runner, spawn, children, killTree };
}

const report = (files: Array<{ name: string; status?: string; message?: string; tests: Array<[string, string, string?]> }>) => ({
  testResults: files.map((f) => ({
    name: path.join(repo, "api", "test", f.name),
    status: f.status ?? (f.tests.some((t) => t[1] === "failed") ? "failed" : "passed"),
    message: f.message,
    assertionResults: f.tests.map(([title, status, msg]) => ({ ancestorTitles: ["กลุ่ม"], title, status, duration: 12.4, failureMessages: msg ? [msg] : [] })),
  })),
});

// ---------------------------------------------------------------------------------------------
describe("TestRunner.suites", () => {
  it("lists the real test files with what each protects, in order, and nothing else", () => {
    const { runner } = setup();
    expect(runner.suites()).toEqual([
      { project: "api", file: "alpha.test.ts", area: "การเงิน", refs: "F4", title: "lib/alpha" },
      { project: "api", file: "beta.test.ts", area: "การเงิน", refs: "F5", title: "lib/beta" },
      { project: "web", file: "gamma.test.tsx", area: "หน้าจอ", refs: "F1", title: "หน้า gamma" },
      { project: "web", file: "unmapped.test.ts", area: "อื่นๆ", refs: "—", title: "unmapped.test.ts" },
    ]);
  });

  it("still works when the map file or a test folder is missing", () => {
    fs.rmSync(path.join(repo, "tools"), { recursive: true });
    fs.rmSync(path.join(repo, "web", "test"), { recursive: true });
    const s = setup().runner.suites();
    expect(s.map((x) => [x.project, x.file, x.area])).toEqual([["api", "alpha.test.ts", "อื่นๆ"], ["api", "beta.test.ts", "อื่นๆ"]]);
  });
});

describe("isLocalDatabase", () => {
  it.each([
    ["postgresql://u:p@localhost:5433/db", true],
    ["postgresql://u:p@127.0.0.1:5433/db", true],
    ["postgresql://u:p@[::1]:5433/db", true],
    ["postgresql://u:p@LOCALHOST/db", true],
    ["postgresql://u:p@db.example.com:5432/db", false],
    ["postgresql://u:p@10.0.0.5:5432/db", false],
    ["postgresql://u:p@localhost.evil.com/db", false],
    ["not a url", false],
    ["", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalDatabase(url)).toBe(expected);
  });
});

describe("TestRunner.start: what is run", () => {
  it("runs vitest through node with fixed arguments and the chosen files, in that project's folder", () => {
    const { runner, spawn, children } = setup();
    const run = runner.start("api", ["beta.test.ts"]);
    expect(run).toMatchObject({ project: "api", files: ["beta.test.ts"], status: "running", finishedAt: null });
    const [command, args, opts] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(path.join(repo, "api", "node_modules", "vitest", "vitest.mjs"));
    expect(args.slice(1, 3)).toEqual(["run", "--reporter=json"]);
    expect(args.at(-1)).toBe("test/beta.test.ts");
    expect(args).toContain("--reporter=default");
    expect(opts.cwd).toBe(path.join(repo, "api"));
    expect(opts.env).toMatchObject({ NODE_ENV: "test", CI: "1", NO_COLOR: "1" });
    expect(children).toHaveLength(1);
  });

  it("runs every file of the project when none are named, and removes duplicates", () => {
    const { runner, spawn, children } = setup();
    expect(runner.start("web", undefined).files).toEqual(["gamma.test.tsx", "unmapped.test.ts"]);
    children[0]!.finish(report([{ name: "gamma.test.tsx", tests: [["a", "passed"]] }]), 0);
    expect(runner.start("api", ["alpha.test.ts", "alpha.test.ts"]).files).toEqual(["alpha.test.ts"]);
    expect(vi.mocked(spawn).mock.calls[1]![1].filter((a) => a.startsWith("test/"))).toEqual(["test/alpha.test.ts"]);
  });

  it.each([
    ["a file that does not exist", ["nope.test.ts"]],
    ["a path out of the folder", ["../../etc/passwd"]],
    ["a path with a separator", ["../test/alpha.test.ts"]],
    ["something that looks like a shell command", ["alpha.test.ts; rm -rf /"]],
    ["a flag", ["--config=evil.js"]],
    ["a file of the other project", ["gamma.test.tsx"]],
    ["a helper that is not a test", ["helpers.ts"]],
  ])("refuses %s and starts nothing", (_name, files) => {
    const { runner, spawn } = setup();
    expect(() => runner.start("api", files)).toThrow(expect.objectContaining({ status: 400, code: "UNKNOWN_TEST_FILE" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("says so when the project has no tests, or vitest is not installed", () => {
    fs.rmSync(path.join(repo, "web", "test"), { recursive: true });
    const { runner } = setup();
    expect(() => runner.start("web", undefined)).toThrow(expect.objectContaining({ code: "NO_TESTS" }));
    fs.rmSync(path.join(repo, "api", "node_modules"), { recursive: true });
    expect(() => runner.start("api", undefined)).toThrow(expect.objectContaining({ code: "VITEST_MISSING" }));
  });
});

describe("TestRunner.start: where the API tests may run", () => {
  it("refuses the API tests unless the database is on this machine, and says why", () => {
    const { runner, spawn } = setup({ databaseUrl: "postgresql://u:p@db.example.com:5432/prod" });
    expect(() => runner.start("api", undefined)).toThrow(expect.objectContaining({ status: 403, code: "NOT_LOCAL_DATABASE" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses the API tests when there is no database URL at all", () => {
    const spawn = vi.fn();
    const noUrl = new TestRunner({ repoRoot: repo, spawn: spawn as never });
    expect(() => noUrl.start("api", undefined)).toThrow(expect.objectContaining({ code: "NOT_LOCAL_DATABASE" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("the web tests need no database, so they run whatever it is", () => {
    const { runner } = setup({ databaseUrl: "postgresql://u:p@db.example.com:5432/prod" });
    expect(runner.start("web", undefined).status).toBe("running");
  });
});

describe("TestRunner: one run at a time", () => {
  it("refuses a second run while one is going, and accepts one after it ends", () => {
    const { runner, children } = setup();
    runner.start("web", undefined);
    expect(() => runner.start("web", undefined)).toThrow(expect.objectContaining({ status: 409, code: "RUN_IN_PROGRESS" }));
    expect(runner.list().running).not.toBeNull();
    children[0]!.finish(report([{ name: "gamma.test.tsx", tests: [["ok", "passed"]] }]), 0);
    expect(runner.list().running).toBeNull();
    expect(runner.start("web", undefined).status).toBe("running");
  });
});

describe("TestRunner: reading the result", () => {
  it("counts passed, failed and skipped tests and marks the run", () => {
    const { runner, children } = setup();
    const run = runner.start("api", undefined);
    children[0]!.finish(
      report([
        { name: "alpha.test.ts", tests: [["a", "passed"], ["b", "failed", "AssertionError: expected 1 to be 2"], ["c", "skipped"]] },
        { name: "beta.test.ts", tests: [["d", "passed"]] },
      ]),
      1,
    );
    expect(run.status).toBe("failed");
    expect(run.counts).toEqual({ passed: 2, failed: 1, skipped: 1 });
    expect(run.finishedAt).not.toBeNull();
    expect(run.results.map((f) => [f.file, f.status])).toEqual([["alpha.test.ts", "failed"], ["beta.test.ts", "passed"]]);
    const failed = run.results[0]!.tests.find((t) => t.status === "failed")!;
    expect(failed).toMatchObject({ title: "b", ancestors: ["กลุ่ม"], message: "AssertionError: expected 1 to be 2", durationMs: 12 });
  });

  it("an all-green run is 'passed'", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.finish(report([{ name: "alpha.test.ts", tests: [["a", "passed"]] }]), 0);
    expect(run).toMatchObject({ status: "passed", counts: { passed: 1, failed: 0, skipped: 0 }, error: null });
  });

  it("trusts the report over the exit code: exit 0 with a failed test is 'failed'", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.finish(report([{ name: "alpha.test.ts", tests: [["a", "failed", "boom"]] }]), 0);
    expect(run.status).toBe("failed");
  });

  it("strips colour codes from failure messages and cuts very long ones", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.finish(report([{ name: "alpha.test.ts", tests: [["a", "failed", `\u001b[31mred\u001b[39m ${"x".repeat(5000)}`]] }]), 1);
    const msg = run.results[0]!.tests[0]!.message!;
    expect(msg.startsWith("red xxx")).toBe(true);
    expect(msg).not.toContain("\u001b");
    expect(msg.length).toBeLessThanOrEqual(1500);
  });

  it("a test file that cannot even load is reported as a failure with its message", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.finish(report([{ name: "alpha.test.ts", status: "failed", message: "Error: Cannot find module './nope'", tests: [] }]), 1);
    expect(run.status).toBe("failed");
    expect(run.counts).toEqual({ passed: 0, failed: 1, skipped: 0 });
    expect(run.results[0]!.tests[0]).toMatchObject({ title: "(ไฟล์เทสต์รันไม่ขึ้น)", status: "failed", message: "Error: Cannot find module './nope'" });
    expect(run.error).toContain("รันไม่ขึ้น");
  });

  it("a crash with no report is an 'error' that points at the output, never a silent pass", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.say("Error: something broke\n");
    children[0]!.finish(null, 1);
    expect(run.status).toBe("error");
    expect(run.error).toContain("ไม่มีไฟล์ผลลัพธ์");
    expect(run.outputTail).toEqual(["Error: something broke"]);
  });

  it("exit code 0 with no report is also an error, not a pass", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.finish(null, 0);
    expect(run.status).toBe("error");
  });

  it("an unreadable report is an error", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    const arg = children[0]!.args.find((a) => a.startsWith("--outputFile.json="))!;
    fs.writeFileSync(arg.slice("--outputFile.json=".length), "{ not json");
    children[0]!.emit("exit", 0);
    expect(run.status).toBe("error");
    expect(run.error).toBe("อ่านผลลัพธ์ของเทสต์ไม่ได้");
  });

  it("deletes the report file once it has been read", async () => {
    const { runner, children } = setup();
    runner.start("api", ["alpha.test.ts"]);
    const file = children[0]!.args.find((a) => a.startsWith("--outputFile.json="))!.slice("--outputFile.json=".length);
    children[0]!.finish(report([{ name: "alpha.test.ts", tests: [["a", "passed"]] }]), 0);
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
  });

  it("only the first ending counts (exit after a timeout changes nothing)", () => {
    const { runner, children } = setup();
    const run = runner.start("api", ["alpha.test.ts"]);
    children[0]!.emit("error", new Error("spawn failed"));
    const when = run.finishedAt;
    children[0]!.finish(report([{ name: "alpha.test.ts", tests: [["a", "passed"]] }]), 0);
    expect(run.status).toBe("error");
    expect(run.error).toContain("spawn failed");
    expect(run.finishedAt).toBe(when);
  });
});

describe("TestRunner: live output", () => {
  it("keeps the last 25 lines, without colour codes, and joins lines split across chunks", () => {
    const { runner, children } = setup();
    const run = runner.start("web", undefined);
    children[0]!.say("\u001b[32m ✓ first\u001b[39m\nsecond li");
    children[0]!.say("ne\r\n");
    expect(run.outputTail).toEqual([" ✓ first", "second line"]);
    for (let i = 0; i < 40; i++) children[0]!.say(`line ${i}\n`);
    expect(run.outputTail).toHaveLength(25);
    expect(run.outputTail.at(-1)).toBe("line 39");
    expect(run.outputTail[0]).toBe("line 15");
  });

  it("reads the error stream too", () => {
    const { runner, children } = setup();
    const run = runner.start("web", undefined);
    (children[0]!.stderr as unknown as EventEmitter).emit("data", "warning text\n");
    expect(run.outputTail).toEqual(["warning text"]);
  });
});

describe("TestRunner: cancel and timeout", () => {
  it("cancel stops the whole process tree and the run ends as 'cancelled'", () => {
    const { runner, children, killTree } = setup();
    const run = runner.start("api", undefined);
    runner.cancel(run.id);
    expect(killTree).toHaveBeenCalledWith(children[0]);
    children[0]!.emit("exit", 1); // what the operating system then reports
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("ยกเลิกการรันแล้ว");
    expect(runner.list().running).toBeNull();
  });

  it("cancel of an unknown or finished run is refused", () => {
    const { runner, children } = setup();
    expect(() => runner.cancel("nope")).toThrow(expect.objectContaining({ status: 404 }));
    const run = runner.start("web", undefined);
    children[0]!.finish(report([{ name: "gamma.test.tsx", tests: [["a", "passed"]] }]), 0);
    expect(() => runner.cancel(run.id)).toThrow(expect.objectContaining({ status: 409, code: "NOT_RUNNING" }));
  });

  it("a run that takes too long is stopped and marked 'timeout'", () => {
    vi.useFakeTimers();
    try {
      const { runner, children, killTree } = setup({ timeoutMs: 1000 });
      const run = runner.start("api", undefined);
      vi.advanceTimersByTime(999);
      expect(run.status).toBe("running");
      vi.advanceTimersByTime(2);
      expect(run.status).toBe("timeout");
      expect(killTree).toHaveBeenCalledWith(children[0]);
      expect(runner.list().running).toBeNull();
      children[0]!.emit("exit", 1);
      expect(run.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TestRunner.list / get", () => {
  it("lists newest first, without the bulky detail, and keeps only the latest 20", () => {
    const { runner, children } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      ids.push(runner.start("web", undefined).id);
      children[i]!.finish(report([{ name: "gamma.test.tsx", tests: [["a", "passed"]] }]), 0);
    }
    const { runs } = runner.list();
    expect(runs).toHaveLength(10);
    expect(runs[0]!.id).toBe(ids[22]);
    expect(runs.every((r) => r.results.length === 0 && r.outputTail.length === 0)).toBe(true);
    expect(runner.get(ids[22]!)!.results.length).toBeGreaterThan(0); // the full run still has its detail
    expect(runner.get(ids[0]!)).toBeNull(); // older than 20: forgotten
    expect(runner.get(ids[3]!)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the routes (fake login)", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  let runner: TestRunner;
  let children: FakeChild[];
  let killTree: ReturnType<typeof vi.fn>;
  const authorize = vi.fn();

  beforeEach(async () => {
    const s = setup();
    runner = s.runner;
    children = s.children;
    killTree = s.killTree;
    authorize.mockReset();
    authorize.mockImplementation(() => (_req: unknown, _res: unknown, next: () => void) => next());
    const app = express();
    app.use(express.json());
    app.use("/admin/dev-tests", createDevTestsRouter({ auth: { authorize } as unknown as AuthMiddleware, runner }));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/dev-tests`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const send = (method: string, p: string, body?: unknown) =>
    fetch(`${base}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("asks for an ADMIN on every route", () => {
    expect(authorize).toHaveBeenCalledWith("ADMIN");
  });

  it("GET / lists the suites and the recent runs", async () => {
    const body = await (await send("GET", "/")).json();
    expect(body.suites).toHaveLength(4);
    expect(body).toMatchObject({ running: null, runs: [] });
  });

  it("POST /runs starts a run (202) and GET /runs/:id follows it", async () => {
    const res = await send("POST", "/runs", { project: "web", files: ["gamma.test.tsx"] });
    expect(res.status).toBe(202);
    const { run } = await res.json();
    expect(run).toMatchObject({ project: "web", files: ["gamma.test.tsx"], status: "running" });
    children[0]!.finish(report([{ name: "gamma.test.tsx", tests: [["a", "passed"]] }]), 0);
    const got = await (await send("GET", `/runs/${run.id}`)).json();
    expect(got.run).toMatchObject({ status: "passed", counts: { passed: 1, failed: 0, skipped: 0 } });
  });

  it("rejects a bad body, an unknown file, a second run and an unknown run id", async () => {
    expect((await send("POST", "/runs", { project: "mobile" })).status).toBe(400);
    expect((await send("POST", "/runs", {})).status).toBe(400);
    expect((await send("POST", "/runs", { project: "web", files: [42] })).status).toBe(400);
    const unknown = await send("POST", "/runs", { project: "web", files: ["nope.test.ts"] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("UNKNOWN_TEST_FILE");
    expect((await send("POST", "/runs", { project: "web" })).status).toBe(202);
    const second = await send("POST", "/runs", { project: "web" });
    expect(second.status).toBe(409);
    expect((await send("GET", "/runs/nope")).status).toBe(404);
  });

  it("DELETE /runs/:id cancels the run that is going", async () => {
    const { run } = await (await send("POST", "/runs", { project: "web" })).json();
    const res = await send("DELETE", `/runs/${run.id}`);
    expect(res.status).toBe(200);
    expect(killTree).toHaveBeenCalledWith(children[0]);
    expect((await send("DELETE", "/runs/nope")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
const prisma = new PrismaClient();
const dbUp = await prisma.$queryRaw`select 1`.then(() => true).catch(() => false);

describe.skipIf(!dbUp)("access control with the real login (PostgreSQL)", () => {
  const marker = `dvt${Date.now()}`;
  const userIds: string[] = [];
  const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
  const cookies: Record<string, string> = {};
  let withRunner: string;
  let withoutRunner: string;

  const start = async (devTestRunner?: TestRunner) => {
    const server = buildApp({
      prisma,
      sessionSecret: "test-secret-".padEnd(48, "s"),
      fieldEncryptionKey: TEST_FIELD_KEY,
      slipStorage: TEST_SLIP_STORAGE,
      importStorage: TEST_IMPORT_STORAGE,
      loginRateLimit: RELAXED_LOGIN_LIMITS,
      devTestRunner,
    }).app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    const passwordHash = await hashPassword("first-password-1");
    for (const [u, role] of [["admin", "ADMIN"], ["borrower", "BORROWER"]] as const) {
      userIds.push((await prisma.user.create({ data: { username: `${marker}-${u}`, role, passwordHash, mustChangePassword: false } })).id);
    }
    withRunner = await start(new TestRunner({ repoRoot: path.resolve(process.cwd(), "..") })); // the real folders
    withoutRunner = await start();
    for (const u of ["admin", "borrower"]) {
      const res = await fetch(`${withRunner}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: `${marker}-${u}`, password: "first-password-1" }),
      });
      cookies[u] = res.headers.getSetCookie().find((c) => c.startsWith("loan_session="))!.split(";")[0]!;
    }
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("does not exist at all when the runner is switched off", async () => {
    for (const as of ["admin", "borrower"]) {
      expect((await fetch(`${withoutRunner}/admin/dev-tests`, { headers: { cookie: cookies[as]! } })).status).toBe(404);
    }
  });

  it("when on: a visitor gets 401, a borrower 403, only the admin gets in", async () => {
    expect((await fetch(`${withRunner}/admin/dev-tests`)).status).toBe(401);
    expect((await fetch(`${withRunner}/admin/dev-tests`, { headers: { cookie: cookies.borrower! } })).status).toBe(403);
    const ok = await fetch(`${withRunner}/admin/dev-tests`, { headers: { cookie: cookies.admin! } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).suites.length).toBeGreaterThan(50);
  });

  it("a borrower and a visitor cannot start or cancel a run either", async () => {
    const post = (cookie?: string) =>
      fetch(`${withRunner}/admin/dev-tests/runs`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ project: "web" }) });
    expect((await post()).status).toBe(401);
    expect((await post(cookies.borrower)).status).toBe(403);
    expect((await fetch(`${withRunner}/admin/dev-tests/runs/x`, { method: "DELETE", headers: { cookie: cookies.borrower! } })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the real thing: runs one real test file through real vitest", () => {
  it("runs web/test/money.test.ts and reports it as passed", async () => {
    const root = path.resolve(process.cwd(), "..");
    const runner = new TestRunner({ repoRoot: root });
    const run = runner.start("web", ["money.test.ts"]);
    await vi.waitFor(() => expect(run.status).not.toBe("running"), { timeout: 90_000, interval: 250 });
    expect(run.error).toBeNull();
    expect(run.status).toBe("passed");
    expect(run.counts!.failed).toBe(0);
    expect(run.counts!.passed).toBeGreaterThan(5);
    expect(run.results.map((f) => f.file)).toEqual(["money.test.ts"]);
  }, 100_000);
});
