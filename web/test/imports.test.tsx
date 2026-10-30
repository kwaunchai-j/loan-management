import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ImportsPage from "@/app/admin/imports/page";
import { importBlockers } from "@/components/imports/ImportFlow";
import { importBatchListSchema, importPreviewSchema, importResultSchema, type ImportPreview } from "@/lib/schemas";
import { apiError, mockApi, valid } from "./mocks";

const row = (n: number, over: Record<string, unknown> = {}) => ({
  rowNumber: n,
  name: `ผู้ยืม ${n}`,
  amount: "1000.00",
  interest: "50.00",
  dueDate: "2026-12-01",
  valid: true,
  errors: [],
  match: { status: "NEW" },
  daysOverdue: 0,
  lateFee: "0",
  ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({
  rows: 2,
  validRows: 2,
  invalidRows: 0,
  borrowers: 2,
  newBorrowers: 1,
  existingBorrowers: 1,
  ambiguousBorrowers: 0,
  principal: "2000.00",
  interest: "100.00",
  lateFee: "0",
  lateDays: 0,
  ...over,
});
const preview = (over: Record<string, unknown> = {}): ImportPreview =>
  valid(importPreviewSchema, {
    importKey: "key1.xlsx",
    fileName: "old-loans.xlsx",
    ratesReady: true,
    summary: summary(),
    canCommit: true,
    needsChoice: [],
    hasInvalidRows: false,
    rows: [row(2), row(3, { match: { status: "EXISTING", borrowerId: "b1" } })],
    ...over,
  });
const candidates = [
  { borrowerId: "b1", fullName: "สมชาย ใจดี", phone: "0811111111", hasAccount: true, createdAt: "2026-01-01T00:00:00.000Z" },
  { borrowerId: "b2", fullName: "สมชาย ใจดี", phone: null, hasAccount: false, createdAt: "2026-02-01T00:00:00.000Z" },
];
const result = valid(importResultSchema, {
  batchId: "batch1",
  contractsCreated: 2,
  borrowersCreated: 1,
  borrowersLinked: 1,
  skippedRows: 0,
  totalPrincipal: "2000.00",
  totalInterest: "100.00",
  lateFeeBackfilled: "0",
  lateFeeRows: 0,
});
const batch = (over: Record<string, unknown> = {}) => ({
  id: "batch1",
  fileName: "old-loans.xlsx",
  rowCount: 2,
  status: "COMPLETED",
  createdAt: "2026-10-29T03:00:00.000Z",
  rolledBackAt: null,
  importedBy: { id: "u1", username: "boss" },
  contractCount: 2,
  paymentCount: 0,
  canRollback: true,
  ...over,
});
const batches = (...items: unknown[]) => ({ body: valid(importBatchListSchema, { items }) });
const xlsx = () => new File([new Uint8Array(20)], "old-loans.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

async function chooseAndCheck(file = xlsx()) {
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText(/ไฟล์ Excel/), file);
  await user.click(screen.getByRole("button", { name: /ตรวจไฟล์/ }));
  return user;
}
const commitCalls = (calls: Array<{ method: string; path: string; body?: unknown }>) => calls.filter((c) => c.path === "/admin/imports/commit");

describe("importBlockers", () => {
  const ok = preview();
  it("is empty when everything needed is done", () => {
    expect(importBlockers(ok, {}, false)).toEqual([]);
  });
  it("blocks while the rates are not set", () => {
    expect(importBlockers(preview({ ratesReady: false, canCommit: false }), {}, false).join(" ")).toMatch(/ยังไม่ได้ตั้งอัตรา/);
  });
  it("blocks a file the server says cannot be imported", () => {
    expect(importBlockers(preview({ canCommit: false }), {}, false).join(" ")).toMatch(/นำเข้าไม่ได้/);
  });
  it("blocks until every duplicate name has a chosen borrower", () => {
    const p = preview({ needsChoice: [{ name: "สมชาย ใจดี", rowNumbers: [2], candidates }, { name: "สมหญิง", rowNumbers: [3], candidates }] });
    expect(importBlockers(p, {}, false).join(" ")).toMatch(/เหลือ 2 ชื่อ/);
    expect(importBlockers(p, { "สมชาย ใจดี": "b1" }, false).join(" ")).toMatch(/เหลือ 1 ชื่อ/);
    expect(importBlockers(p, { "สมชาย ใจดี": "b1", สมหญิง: "b2" }, false)).toEqual([]);
  });
  it("blocks invalid rows until the admin agrees to skip them", () => {
    const p = preview({ hasInvalidRows: true });
    expect(importBlockers(p, {}, false).join(" ")).toMatch(/ข้ามแถว/);
    expect(importBlockers(p, {}, true)).toEqual([]);
  });
});

describe("import page", () => {
  it("offers the template download and lists past batches", async () => {
    mockApi({ "GET /admin/imports": batches(batch()) });
    render(<ImportsPage />);
    expect(await screen.findByText("old-loans.xlsx", { selector: "p" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "ดาวน์โหลดแม่แบบ" });
    expect(link).toHaveAttribute("href", "/api/admin/imports/template");
    expect(link).toHaveAttribute("download");
    expect(screen.getByText(/ผู้ดูแลระบบ|boss/)).toBeInTheDocument();
  });

  it("asks for a file before checking", async () => {
    const calls = mockApi({ "GET /admin/imports": batches() });
    render(<ImportsPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: /ตรวจไฟล์/ }));
    expect(await screen.findByText(/กรุณาเลือกไฟล์/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/preview"))).toBe(false);
  });

  it("sends the chosen file as the raw body with its name, and shows the result of the check", async () => {
    const calls = mockApi({
      "GET /admin/imports": batches(),
      "POST /admin/imports/preview": { body: preview({ summary: summary({ lateFee: "250.50", lateDays: 5 }) }) },
    });
    render(<ImportsPage />);
    await chooseAndCheck();
    expect(await screen.findByText(/ตรวจแล้วแต่ยังไม่ได้บันทึกอะไร/)).toBeInTheDocument();
    const call = calls.find((c) => c.path.startsWith("/admin/imports/preview"))!;
    expect(call.path).toBe("/admin/imports/preview?fileName=old-loans.xlsx");
    expect(call.body).toEqual({ file: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 20 } });
    expect(screen.getByText("2,000 บาท")).toBeInTheDocument();
    expect(screen.getByText("250.50 บาท")).toBeInTheDocument();
    expect(screen.getByText("5 วัน")).toBeInTheDocument();
    expect(screen.getAllByText("ผู้ยืมเดิม").length).toBeGreaterThan(0);
    expect(screen.getByText("สร้างผู้ยืมใหม่")).toBeInTheDocument();
  });

  it("shows the API's reason when the file is not accepted", async () => {
    mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": apiError(400, "INVALID_FILE", "ไฟล์ไม่ตรงแม่แบบ: แถวแรกต้องเป็น ชื่อผู้ยืม | จำนวนเงิน | ดอกเบี้ย | วันครบกำหนด") });
    render(<ImportsPage />);
    await chooseAndCheck();
    expect(await screen.findByText(/ไฟล์ไม่ตรงแม่แบบ/)).toBeInTheDocument();
    expect(screen.queryByText(/ผลการตรวจไฟล์/)).not.toBeInTheDocument();
  });

  it("shows the message for a file that is too large", async () => {
    mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": apiError(413, "PAYLOAD_TOO_LARGE", "ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป") });
    render(<ImportsPage />);
    await chooseAndCheck();
    expect(await screen.findByText("ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป")).toBeInTheDocument();
  });

  it("confirms with only the key, the file name and the answers, then shows what was imported", async () => {
    const calls = mockApi({
      "GET /admin/imports": batches(),
      "POST /admin/imports/preview": { body: preview() },
      "POST /admin/imports/commit": { status: 201, body: result },
    });
    render(<ImportsPage />);
    const user = await chooseAndCheck();
    await user.click(await screen.findByRole("button", { name: "ยืนยันนำเข้า 2 สัญญา" }));
    expect(await screen.findByText("นำเข้าเรียบร้อยแล้ว")).toBeInTheDocument();
    expect(commitCalls(calls)[0]!.body).toEqual({ importKey: "key1.xlsx", fileName: "old-loans.xlsx", choices: {}, skipInvalidRows: false });
    expect(screen.getByText(/สร้าง 2 สัญญา/)).toBeInTheDocument();
    expect(screen.queryByText(/ผลการตรวจไฟล์/)).not.toBeInTheDocument(); // the check is done with
    await waitFor(() => expect(calls.filter((c) => c.path === "/admin/imports" && c.method === "GET").length).toBeGreaterThan(1)); // list refreshed
  });

  it("blocks the button until the rates are set, and says why", async () => {
    mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: preview({ ratesReady: false, canCommit: false, summary: summary({ lateFee: null }) }) } });
    render(<ImportsPage />);
    await chooseAndCheck();
    expect(await screen.findByRole("button", { name: /ยืนยันนำเข้า/ })).toBeDisabled();
    expect(screen.getAllByText(/ยังไม่ได้ตั้งอัตรา/).length).toBeGreaterThan(0);
    expect(screen.getByText("ยังคำนวณไม่ได้")).toBeInTheDocument();
  });

  describe("duplicate names", () => {
    const withChoice = () =>
      preview({
        summary: summary({ ambiguousBorrowers: 1 }),
        needsChoice: [{ name: "สมชาย ใจดี", rowNumbers: [2, 4], candidates }],
        rows: [row(2, { name: "สมชาย ใจดี", match: { status: "AMBIGUOUS" } }), row(4, { name: "สมชาย ใจดี", match: { status: "AMBIGUOUS" } })],
      });

    it("makes the admin choose a borrower first, and never guesses", async () => {
      const calls = mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: withChoice() }, "POST /admin/imports/commit": { status: 201, body: result } });
      render(<ImportsPage />);
      await chooseAndCheck();
      const button = await screen.findByRole("button", { name: /ยืนยันนำเข้า/ });
      expect(button).toBeDisabled();
      expect(screen.getByText(/ต้องเลือกผู้ยืมให้ครบสำหรับชื่อที่ซ้ำ/)).toBeInTheDocument();
      expect(screen.getByText(/แถว 2, 4/)).toBeInTheDocument();
      expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
      expect(commitCalls(calls)).toHaveLength(0);
    });

    it("sends the chosen borrower for that name once picked", async () => {
      const calls = mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: withChoice() }, "POST /admin/imports/commit": { status: 201, body: result } });
      render(<ImportsPage />);
      const user = await chooseAndCheck();
      await user.click(await screen.findByLabelText(/0811111111/));
      const button = screen.getByRole("button", { name: /ยืนยันนำเข้า/ });
      expect(button).toBeEnabled();
      await user.click(button);
      await screen.findByText("นำเข้าเรียบร้อยแล้ว");
      expect(commitCalls(calls)[0]!.body).toMatchObject({ choices: { "สมชาย ใจดี": "b1" } });
    });

    it("shows each candidate with phone, account and when it was created", async () => {
      mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: withChoice() } });
      render(<ImportsPage />);
      await chooseAndCheck();
      expect(await screen.findByText(/0811111111 · มีบัญชีเข้าสู่ระบบ/)).toBeInTheDocument();
      expect(screen.getByText(/ไม่มีเบอร์ · ไม่มีบัญชี/)).toBeInTheDocument();
    });
  });

  describe("invalid rows", () => {
    const withInvalid = () =>
      preview({
        summary: summary({ rows: 3, validRows: 2, invalidRows: 1 }),
        hasInvalidRows: true,
        rows: [row(2), row(3), row(4, { valid: false, amount: null, errors: ["จำนวนเงินต้องมากกว่า 0"], match: { status: "NEW" } })],
      });

    it("shows the reason per row and needs a clear 'skip them' before importing", async () => {
      const calls = mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: withInvalid() }, "POST /admin/imports/commit": { status: 201, body: { ...result, skippedRows: 1 } } });
      render(<ImportsPage />);
      const user = await chooseAndCheck();
      expect(await screen.findByText("จำนวนเงินต้องมากกว่า 0")).toBeInTheDocument();
      const button = screen.getByRole("button", { name: "ยืนยันนำเข้า 2 สัญญา" });
      expect(button).toBeDisabled();
      expect(commitCalls(calls)).toHaveLength(0);
      await user.click(screen.getByLabelText(/ข้ามแถวที่ไม่ถูกต้อง 1 แถว/));
      expect(button).toBeEnabled();
      await user.click(button);
      await screen.findByText("นำเข้าเรียบร้อยแล้ว");
      expect(commitCalls(calls)[0]!.body).toMatchObject({ skipInvalidRows: true });
    });

    it("can show just the invalid rows", async () => {
      mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: withInvalid() } });
      render(<ImportsPage />);
      const user = await chooseAndCheck();
      await screen.findByText("จำนวนเงินต้องมากกว่า 0");
      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("row")).toHaveLength(4); // header + 3
      await user.click(screen.getByLabelText("แสดงเฉพาะแถวที่ไม่ถูกต้อง"));
      expect(within(table).getAllByRole("row")).toHaveLength(2); // header + 1
    });
  });

  it("shows only the first 100 rows of a long file until asked", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(i + 2));
    mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: preview({ summary: summary({ rows: 150, validRows: 150 }), rows }) } });
    render(<ImportsPage />);
    const user = await chooseAndCheck();
    await screen.findByText(/ผลการตรวจไฟล์/);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(101);
    await user.click(screen.getByRole("button", { name: "แสดงทั้งหมด 150 แถว" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(151);
  });

  it("shows the API's refusal on confirming and keeps the check on screen", async () => {
    mockApi({
      "GET /admin/imports": batches(),
      "POST /admin/imports/preview": { body: preview() },
      "POST /admin/imports/commit": apiError(404, "IMPORT_NOT_FOUND", "ไม่พบไฟล์นำเข้า (หมดอายุแล้ว หรือถูกนำเข้าไปแล้ว) กรุณาอัปโหลดใหม่"),
    });
    render(<ImportsPage />);
    const user = await chooseAndCheck();
    await user.click(await screen.findByRole("button", { name: /ยืนยันนำเข้า/ }));
    expect(await screen.findByText(/ไม่พบไฟล์นำเข้า/)).toBeInTheDocument();
    expect(screen.getByText(/ผลการตรวจไฟล์/)).toBeInTheDocument();
  });

  it("cancelling the check sends nothing to confirm", async () => {
    const calls = mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: preview() } });
    render(<ImportsPage />);
    const user = await chooseAndCheck();
    await user.click(await screen.findByRole("button", { name: "ยกเลิก" }));
    expect(screen.queryByText(/ผลการตรวจไฟล์/)).not.toBeInTheDocument();
    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("choosing a different file clears the old check", async () => {
    mockApi({ "GET /admin/imports": batches(), "POST /admin/imports/preview": { body: preview() } });
    render(<ImportsPage />);
    const user = await chooseAndCheck();
    await screen.findByText(/ผลการตรวจไฟล์/);
    await user.upload(screen.getByLabelText(/ไฟล์ Excel/), new File(["a"], "other.csv", { type: "text/csv" }));
    expect(screen.queryByText(/ผลการตรวจไฟล์/)).not.toBeInTheDocument();
  });
});

describe("batches and rollback", () => {
  it("offers to undo a batch with no payments, after a confirmation that says what is deleted", async () => {
    const calls = mockApi({
      "GET /admin/imports": batches(batch()),
      "POST /admin/imports/batch1/rollback": { body: { id: "batch1", status: "ROLLED_BACK", rolledBackAt: "2026-10-30T05:00:00.000Z", contractsDeleted: 2, lateFeeRowsDeleted: 7 } },
    });
    render(<ImportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ย้อนกลับทั้งชุด" }));
    expect(calls.filter((c) => c.path.endsWith("/rollback"))).toHaveLength(0);
    expect(screen.getByText(/จะลบ 2 สัญญาและค่าปรับย้อนหลังของชุดนี้/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ยืนยันย้อนกลับ" }));
    expect(await screen.findByText(/ย้อนกลับแล้ว ลบ 2 สัญญาและค่าปรับย้อนหลัง 7 รายการ/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/rollback"))).toHaveLength(1);
  });

  it("does not offer rollback once payments exist, and says why", async () => {
    mockApi({ "GET /admin/imports": batches(batch({ canRollback: false, paymentCount: 3 })) });
    render(<ImportsPage />);
    expect(await screen.findByText(/ย้อนกลับไม่ได้ เพราะมีรายการรับชำระในสัญญาของชุดนี้แล้ว \(3 รายการ\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ย้อนกลับทั้งชุด" })).not.toBeInTheDocument();
  });

  it("a batch already rolled back has no button and shows when", async () => {
    mockApi({ "GET /admin/imports": batches(batch({ status: "ROLLED_BACK", canRollback: false, rolledBackAt: "2026-10-30T05:00:00.000Z" })) });
    render(<ImportsPage />);
    expect(await screen.findByText("ย้อนกลับแล้ว")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ย้อนกลับทั้งชุด" })).not.toBeInTheDocument();
    expect(screen.queryByText(/ย้อนกลับไม่ได้ เพราะ/)).not.toBeInTheDocument();
  });

  it("backing out of the rollback sends nothing", async () => {
    const calls = mockApi({ "GET /admin/imports": batches(batch()) });
    render(<ImportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ย้อนกลับทั้งชุด" }));
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows the API's refusal when a payment appeared meanwhile", async () => {
    mockApi({
      "GET /admin/imports": batches(batch()),
      "POST /admin/imports/batch1/rollback": apiError(409, "HAS_PAYMENTS", "ย้อนกลับไม่ได้ เพราะมีรายการรับชำระแล้วในสัญญา: LN-0001"),
    });
    render(<ImportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "ย้อนกลับทั้งชุด" }));
    await user.click(screen.getByRole("button", { name: "ยืนยันย้อนกลับ" }));
    expect(await screen.findByText(/ย้อนกลับไม่ได้ เพราะมีรายการรับชำระแล้วในสัญญา: LN-0001/)).toBeInTheDocument();
  });

  it("says so when nothing was ever imported", async () => {
    mockApi({ "GET /admin/imports": batches() });
    render(<ImportsPage />);
    expect(await screen.findByText("ยังไม่เคยนำเข้า")).toBeInTheDocument();
  });
});
