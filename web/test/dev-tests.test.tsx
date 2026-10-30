// DEV-TOOLS (temporary): tests of the in-app test runner page. Delete with the dev-tools files.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestRunnerPanel } from "@/components/devtests/TestRunnerPanel";
import { overviewSchema, runResponseSchema, type Run, type Suite } from "@/components/devtests/schemas";
import { menuFor } from "@/lib/access";
import { apiError, mockApi, valid } from "./mocks";

const suites: Suite[] = [
  { project: "web", file: "money.test.ts", area: "การแสดงผลเงิน", refs: "F4", title: "lib/money" },
  { project: "web", file: "ui.test.tsx", area: "คอมโพเนนต์กลาง", refs: "A11y", title: "components/ui" },
  { project: "api", file: "interest.test.ts", area: "การคำนวณเงิน", refs: "F4 · DES-010", title: "lib/interest" },
  { project: "api", file: "late-fee.test.ts", area: "การคำนวณเงิน", refs: "F6 · DES-012", title: "lib/late-fee" },
];

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  project: "web",
  files: ["money.test.ts", "ui.test.tsx"],
  status: "running",
  startedAt: "2026-10-30T05:00:00.000Z",
  finishedAt: null,
  counts: null,
  results: [],
  outputTail: [],
  error: null,
  ...over,
});
const passedRun = (over: Partial<Run> = {}) =>
  run({
    status: "passed",
    finishedAt: "2026-10-30T05:00:07.000Z",
    counts: { passed: 3, failed: 0, skipped: 0 },
    results: [
      { file: "money.test.ts", status: "passed", tests: [{ ancestors: ["formatBaht"], title: "groups thousands", status: "passed", durationMs: 1 }, { ancestors: [], title: "b", status: "passed", durationMs: 1 }] },
      { file: "ui.test.tsx", status: "passed", tests: [{ ancestors: [], title: "c", status: "passed", durationMs: 1 }] },
    ],
    ...over,
  });
const failedRun = () =>
  run({
    status: "failed",
    finishedAt: "2026-10-30T05:00:07.000Z",
    counts: { passed: 1, failed: 1, skipped: 0 },
    results: [
      { file: "money.test.ts", status: "passed", tests: [{ ancestors: [], title: "ok", status: "passed", durationMs: 1 }] },
      { file: "ui.test.tsx", status: "failed", tests: [{ ancestors: ["Badge"], title: "shows its words", status: "failed", durationMs: 3, message: "AssertionError: expected 1 to be 2" }] },
    ],
  });

const overview = (over: { running?: string | null; runs?: Run[] } = {}) => ({
  body: valid(overviewSchema, { suites, running: over.running ?? null, runs: over.runs ?? [] }),
});
const runBody = (r: Run) => ({ body: valid(runResponseSchema, { run: r }) });

afterEach(() => vi.unstubAllEnvs());

const fast = <TestRunnerPanel pollMs={5} />;

describe("the test runner page", () => {
  it("says the runner is off, and how to turn it on, when the server has no such routes", async () => {
    mockApi({ "GET /admin/dev-tests": apiError(404, "NOT_FOUND", "ไม่พบ") });
    render(fast);
    expect(await screen.findByText("เครื่องมือรันเทสต์ปิดอยู่")).toBeInTheDocument();
    expect(screen.getByText("DEV_TEST_RUNNER=true")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /รัน/ })).not.toBeInTheDocument();
  });

  it("warns that it is temporary and writes test data, and lists every test file by group with what it protects", async () => {
    mockApi({ "GET /admin/dev-tests": overview() });
    render(fast);
    expect(await screen.findByText(/จะถูกเอาออกก่อน deploy จริง/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "เทสต์หน้าเว็บ" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "เทสต์ API (ใช้ฐานข้อมูลในเครื่อง)" })).toBeInTheDocument();
    const calc = screen.getByRole("region", { name: "เทสต์ API (ใช้ฐานข้อมูลในเครื่อง) · การคำนวณเงิน" });
    expect(within(calc).getByText("interest.test.ts")).toBeInTheDocument();
    expect(within(calc).getByText("lib/interest · F4 · DES-010")).toBeInTheDocument();
    expect(within(calc).getByRole("button", { name: "รัน late-fee.test.ts" })).toBeInTheDocument();
    expect(within(calc).getByRole("button", { name: /รันกลุ่ม การคำนวณเงิน/ })).toHaveTextContent("รันทั้งกลุ่ม (2)");
  });

  it("shows an error from the server instead of a blank page", async () => {
    mockApi({ "GET /admin/dev-tests": apiError(500, "INTERNAL_ERROR", "พัง") });
    render(fast);
    expect(await screen.findByRole("alert")).toHaveTextContent("พัง");
  });

  it("'run all web tests' asks for the web project only, follows the run, and shows the outcome", async () => {
    let polls = 0;
    const calls = mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": runBody(run()),
      "GET /admin/dev-tests/runs/r1": () => {
        polls++;
        return runBody(polls < 3 ? run({ outputTail: [" ✓ test/money.test.ts (24 tests)"] }) : passedRun());
      },
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" }));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ project: "web" });
    // while it runs: the live lines, a stop button, and nothing else can be started
    expect(await screen.findByText("กำลังรัน")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ยกเลิกการรัน" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "รันเทสต์ API ทั้งหมด" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "รัน money.test.ts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" })).toBeDisabled(); // not twice
    // then the result
    expect(await screen.findByText("ผ่านทั้งหมด")).toBeInTheDocument();
    expect(screen.getByText("ผ่าน 3 · ไม่ผ่าน 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ยกเลิกการรัน" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "รัน money.test.ts" })).toBeEnabled();
    // each file's row now carries its result
    const row = screen.getByText("money.test.ts", { selector: "p" }).closest("li")!;
    expect(within(row).getByText("ผ่าน")).toBeInTheDocument();
    // the list of runs was refreshed when it ended
    expect(calls.filter((c) => c.method === "GET" && c.path === "/admin/dev-tests").length).toBeGreaterThanOrEqual(2);
  });

  it("one file, and a whole group, ask for exactly those files", async () => {
    const calls = mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": runBody(passedRun()),
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รัน late-fee.test.ts" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.filter((c) => c.method === "POST")[0]!.body).toEqual({ project: "api", files: ["late-fee.test.ts"] });
    await userEvent.click(screen.getByRole("button", { name: /รันกลุ่ม การคำนวณเงิน/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST")[1]!.body).toEqual({ project: "api", files: ["interest.test.ts", "late-fee.test.ts"] });
  });

  it("shows which test failed and why, and 'run again' re-runs only the files that failed", async () => {
    const calls = mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": runBody(failedRun()),
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" }));
    expect(await screen.findByText("มีเคสไม่ผ่าน")).toBeInTheDocument();
    expect(screen.getByText("ผ่าน 1 · ไม่ผ่าน 1")).toBeInTheDocument();
    expect(screen.getByText("Badge › shows its words")).toBeInTheDocument();
    expect(screen.getByText("AssertionError: expected 1 to be 2")).toBeInTheDocument();
    // the failing file's row says so
    const row = screen.getByText("ui.test.tsx", { selector: "p" }).closest("li")!;
    expect(within(row).getByText("ไม่ผ่าน")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "รันซ้ำเฉพาะไฟล์ที่ไม่ผ่าน" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST")[1]!.body).toEqual({ project: "web", files: ["ui.test.tsx"] });
  });

  it("offers no 're-run failed' button when everything passed", async () => {
    mockApi({ "GET /admin/dev-tests": overview(), "POST /admin/dev-tests/runs": runBody(passedRun()) });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" }));
    await screen.findByText("ผ่านทั้งหมด");
    expect(screen.queryByRole("button", { name: "รันซ้ำเฉพาะไฟล์ที่ไม่ผ่าน" })).not.toBeInTheDocument();
  });

  it("tells the user when a run could not be started (another is going, or not allowed)", async () => {
    mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": apiError(403, "NOT_LOCAL_DATABASE", "เทสต์ฝั่ง API จะรันได้เฉพาะเมื่อฐานข้อมูลอยู่ในเครื่องนี้"),
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์ API ทั้งหมด" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ฐานข้อมูลอยู่ในเครื่องนี้");
    expect(screen.getByRole("button", { name: "รันเทสต์ API ทั้งหมด" })).toBeEnabled();
  });

  it("the stop button cancels the run on the server", async () => {
    const calls = mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": runBody(run()),
      "GET /admin/dev-tests/runs/r1": () => runBody(run()),
      "DELETE /admin/dev-tests/runs/r1": runBody(run({ status: "cancelled" })),
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" }));
    await userEvent.click(await screen.findByRole("button", { name: "ยกเลิกการรัน" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/admin/dev-tests/runs/r1")).toBe(true));
  });

  it("a cancelled, timed-out or crashed run says so in words and keeps the program's last lines", async () => {
    mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": runBody(run({ status: "error", finishedAt: "2026-10-30T05:00:02.000Z", error: "เทสต์จบแล้วแต่ไม่มีไฟล์ผลลัพธ์", outputTail: ["Error: something broke"] })),
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" }));
    expect(await screen.findByText("รันไม่สำเร็จ")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ไม่มีไฟล์ผลลัพธ์");
    expect(screen.getByLabelText("ข้อความจากการรัน")).toHaveTextContent("Error: something broke");
  });

  it("picks up a run that was already going when the page was opened", async () => {
    mockApi({
      "GET /admin/dev-tests": overview({ running: "r1", runs: [run()] }),
      "GET /admin/dev-tests/runs/r1": () => runBody(passedRun()),
    });
    render(fast);
    expect(await screen.findByText("ผ่านทั้งหมด")).toBeInTheDocument();
  });

  it("recent runs are listed, and 'ดูผล' opens one", async () => {
    mockApi({
      "GET /admin/dev-tests": overview({ runs: [failedRun()] }),
      "GET /admin/dev-tests/runs/r1": () => runBody(failedRun()),
    });
    render(fast);
    const history = (await screen.findByRole("heading", { name: "การรันล่าสุด" })).closest("section")!;
    expect(within(history).getByText("มีเคสไม่ผ่าน")).toBeInTheDocument();
    await userEvent.click(within(history).getByRole("button", { name: /ดูผลการรัน web/ }));
    expect(await screen.findByText("AssertionError: expected 1 to be 2")).toBeInTheDocument();
  });

  it("stops following when it cannot reach the server, and says so", async () => {
    mockApi({
      "GET /admin/dev-tests": overview(),
      "POST /admin/dev-tests/runs": runBody(run()),
      "GET /admin/dev-tests/runs/r1": new Error("offline"),
    });
    render(fast);
    await userEvent.click(await screen.findByRole("button", { name: "รันเทสต์หน้าเว็บทั้งหมด" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  });
});

describe("the menu entry", () => {
  it("is not in the admin menu unless the build asks for it", () => {
    expect(menuFor("ADMIN").some((i) => i.href === "/admin/dev-tests")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_DEV_TOOLS", "0");
    expect(menuFor("ADMIN").some((i) => i.href === "/admin/dev-tests")).toBe(false);
  });

  it("is added to the admin menu, last, when NEXT_PUBLIC_DEV_TOOLS=1, and never for a borrower", () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_TOOLS", "1");
    const admin = menuFor("ADMIN");
    expect(admin.at(-1)).toEqual({ href: "/admin/dev-tests", label: "รันเทสต์" });
    expect(menuFor("BORROWER").some((i) => i.href.includes("dev-tests"))).toBe(false);
  });
});
