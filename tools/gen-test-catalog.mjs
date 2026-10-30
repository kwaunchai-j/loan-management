// Builds _docs/module/loan-management/test-cases.md from the real test runs, so the catalog can
// never list a test that does not exist or miss one that does.
//
//   cd api && npx vitest run --reporter=json --outputFile=../tools/.api-report.json
//   cd web && npx vitest run --reporter=json --outputFile=../tools/.web-report.json
//   node tools/gen-test-catalog.mjs
//
// Every test file must have an entry in AREAS below (the script stops if one is missing), so a new test
// file cannot be added without saying which requirement / design item / source module it protects.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "_docs/module/loan-management/test-cases.md");

/** { api: { "file.test.ts": [area, requirement/design items, what is under test] }, web: {...} } — shared with the in-app test runner */
const { api: API, web: WEB } = JSON.parse(fs.readFileSync(path.join(root, "tools/test-areas.json"), "utf8"));

function load(file) {
  const p = path.join(root, "tools", file);
  if (!fs.existsSync(p)) throw new Error(`missing ${p} — run the tests with --reporter=json first (see the top of this file)`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function collect(report, map, prefix) {
  const files = [];
  const missing = [];
  for (const f of report.testResults) {
    const name = path.basename(f.name);
    const info = map[name];
    if (!info) {
      missing.push(name);
      continue;
    }
    const tests = f.assertionResults.map((t) => ({ path: t.ancestorTitles, title: t.title, status: t.status }));
    files.push({ name, info, tests });
  }
  if (missing.length) throw new Error(`${prefix}: no catalog entry for ${missing.join(", ")} — add it to tools/test-areas.json`);
  const unseen = Object.keys(map).filter((n) => !report.testResults.some((f) => path.basename(f.name) === n));
  if (unseen.length) throw new Error(`${prefix}: catalog entries without a test file: ${unseen.join(", ")}`);
  files.sort((a, b) => a.info[0].localeCompare(b.info[0], "th") || a.name.localeCompare(b.name));
  return files;
}

const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const api = collect(load(".api-report.json"), API, "api");
const web = collect(load(".web-report.json"), WEB, "web");
const count = (files) => files.reduce((n, f) => n + f.tests.length, 0);
const failing = [...api, ...web].flatMap((f) => f.tests.filter((t) => t.status !== "passed").map((t) => `${f.name} › ${t.title} (${t.status})`));

const lines = [];
const out = (s = "") => lines.push(s);

out("# ชุดทดสอบ (Test Cases) — ระบบขอยืมเงิน");
out();
out("> เอกสารนี้ **สร้างจากการรันเทสต์จริง** ด้วย `tools/gen-test-catalog.mjs` — ทุกแถวคือเทสต์อัตโนมัติที่มีอยู่และรันได้ ไม่มีเคสที่เป็นแค่คำอธิบาย");
out(`> สร้างเมื่อ ${new Date().toISOString().slice(0, 10)} · ผลรัน: API ${count(api)} เคส, Web ${count(web)} เคส${failing.length ? ` · **ไม่ผ่าน ${failing.length}**` : " · ผ่านทั้งหมด"}`);
out();
out("## 1. วิธีรัน");
out();
out("| สิ่งที่ต้องการ | คำสั่ง |");
out("|---|---|");
out("| เทสต์ API ทั้งหมด (ต้องมี PostgreSQL ของโปรเจกต์รันอยู่) | `cd api && npm test` |");
out("| เทสต์เว็บทั้งหมด (ไม่ต้องใช้ฐานข้อมูล) | `cd web && npm test` |");
out("| ไฟล์เดียว | `npx vitest run test/ledger.test.ts` |");
out("| ดู coverage (รายงาน HTML อยู่ใน `coverage/`) | `npm run test:coverage` |");
out("| สร้างเอกสารนี้ใหม่ | ดูหัวไฟล์ `tools/gen-test-catalog.mjs` |");
out();
out("เทสต์ API ใช้ฐานข้อมูลเดียวกันและต้องรันทีละไฟล์ (ตั้งค่าไว้แล้วใน `vitest.config.ts`) ถ้าไม่มีฐานข้อมูล เทสต์ที่ต้องใช้จะถูกข้าม **ไม่ใช่ผ่าน** — ให้ตรวจว่าจำนวนที่ข้ามเป็น 0 เสมอ");
out();
out("## 2. ระดับของเทสต์");
out();
out("| ระดับ | ทำอะไร | ตัวอย่าง |");
out("|---|---|---|");
out("| Unit | ฟังก์ชันบริสุทธิ์ ไม่มี I/O; ตัวเลขเงินเทียบกับ oracle อิสระที่คำนวณด้วย BigInt | `interest`, `late-fee`, `money`, `allocation`, `dates`, `config`, `scheduler-unit` |");
out("| Integration | เรียก HTTP จริงของ Express กับ PostgreSQL จริง ตรวจทั้งสิทธิ์ ข้อมูลที่บันทึก AuditLog และค่าที่ตอบกลับ | `ledger`, `submissions`, `imports`, `reports`, `auth` |");
out("| Component | หน้า/คอมโพเนนต์ React จริงใน jsdom กับ API จำลองที่ตอบตาม schema จริง | `admin-ledger`, `payment-submissions`, `calendar`, `ui` |");
out("| Mutation | ไม่ใช่ไฟล์เทสต์: แก้โค้ดจริงทีละจุด (ปัดลง, ตัดเงื่อนไข ฯลฯ) แล้วรันเทสต์ — ต้องมีเทสต์พัง; ผลอยู่ในไฟล์ `PHASE*-SECURITY-REVIEW.md`, `CR*-REVIEW.md` | `roundUpBaht`, การยืนยันสลิป |");
out();
out("ไม่มี E2E บนเบราว์เซอร์จริงในชุดนี้ (ยังไม่ได้ทดสอบบน iPhone — งาน T-1002) การตรวจหน้าจอจริงทำด้วยมือผ่านเบราว์เซอร์");
out();

for (const [title, files, id] of [["3. เทสต์ API (`api/test`)", api, "API"], ["4. เทสต์เว็บ (`web/test`)", web, "WEB"]]) {
  out(`## ${title}`);
  out();
  out("### สรุปตามส่วนงาน");
  out();
  out("| ส่วนงาน | ไฟล์เทสต์ | อ้างอิง | สิ่งที่ถูกทดสอบ | จำนวนเคส |");
  out("|---|---|---|---|---|");
  for (const f of files) out(`| ${f.info[0]} | \`${f.name}\` | ${f.info[1]} | ${f.info[2]} | ${f.tests.length} |`);
  out(`| **รวม** | ${files.length} ไฟล์ | | | **${count(files)}** |`);
  out();
  out("### รายการเคสทั้งหมด");
  out();
  files.forEach((f, fi) => {
    const fid = `${id}-${String(fi + 1).padStart(2, "0")}`;
    out(`#### ${fid} · \`${f.name}\` — ${f.info[2]}`);
    out();
    out(`อ้างอิง: ${f.info[1]}`);
    out();
    out("| รหัส | กลุ่ม | เคส | ผล |");
    out("|---|---|---|---|");
    f.tests.forEach((t, i) => {
      const group = t.path.join(" › ");
      out(`| ${fid}-${String(i + 1).padStart(3, "0")} | ${esc(group)} | ${esc(t.title)} | ${t.status === "passed" ? "✓" : t.status} |`);
    });
    out();
  });
}

out("## 5. ความครอบคลุมที่วัดได้");
out();
out("วัดด้วย v8 (`npm run test:coverage`) — ตัวเลขล่าสุดอยู่ในไฟล์ `coverage/coverage-summary.json` หลังรันคำสั่งนั้น; ไฟล์ที่ตั้งใจไม่ทดสอบ: จุดเริ่มโปรแกรม (`index.ts`, `db.ts`), สคริปต์ CLI บางๆ (`create-admin`, `reset-admin-password`, `generate-vapid-keys` — ตรรกะอยู่ใน `admin-accounts.ts` ซึ่งมีเทสต์), `app/layout.tsx`");
out();
if (failing.length) {
  out("## เคสที่ไม่ผ่านตอนสร้างเอกสาร");
  out();
  for (const f of failing) out(`- ${f}`);
  out();
}
fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${path.relative(root, OUT)}: API ${count(api)} + Web ${count(web)} cases${failing.length ? `, ${failing.length} NOT passing` : ""}`);
