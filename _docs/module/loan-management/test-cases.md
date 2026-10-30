# ชุดทดสอบ (Test Cases) — ระบบขอยืมเงิน

> เอกสารนี้ **สร้างจากการรันเทสต์จริง** ด้วย `tools/gen-test-catalog.mjs` — ทุกแถวคือเทสต์อัตโนมัติที่มีอยู่และรันได้ ไม่มีเคสที่เป็นแค่คำอธิบาย
> สร้างเมื่อ 2026-10-30 · ผลรัน: API 563 เคส, Web 421 เคส · ผ่านทั้งหมด

## 1. วิธีรัน

| สิ่งที่ต้องการ | คำสั่ง |
|---|---|
| เทสต์ API ทั้งหมด (ต้องมี PostgreSQL ของโปรเจกต์รันอยู่) | `cd api && npm test` |
| เทสต์เว็บทั้งหมด (ไม่ต้องใช้ฐานข้อมูล) | `cd web && npm test` |
| ไฟล์เดียว | `npx vitest run test/ledger.test.ts` |
| ดู coverage (รายงาน HTML อยู่ใน `coverage/`) | `npm run test:coverage` |
| สร้างเอกสารนี้ใหม่ | ดูหัวไฟล์ `tools/gen-test-catalog.mjs` |

เทสต์ API ใช้ฐานข้อมูลเดียวกันและต้องรันทีละไฟล์ (ตั้งค่าไว้แล้วใน `vitest.config.ts`) ถ้าไม่มีฐานข้อมูล เทสต์ที่ต้องใช้จะถูกข้าม **ไม่ใช่ผ่าน** — ให้ตรวจว่าจำนวนที่ข้ามเป็น 0 เสมอ

## 2. ระดับของเทสต์

| ระดับ | ทำอะไร | ตัวอย่าง |
|---|---|---|
| Unit | ฟังก์ชันบริสุทธิ์ ไม่มี I/O; ตัวเลขเงินเทียบกับ oracle อิสระที่คำนวณด้วย BigInt | `interest`, `late-fee`, `money`, `allocation`, `dates`, `config`, `scheduler-unit` |
| Integration | เรียก HTTP จริงของ Express กับ PostgreSQL จริง ตรวจทั้งสิทธิ์ ข้อมูลที่บันทึก AuditLog และค่าที่ตอบกลับ | `ledger`, `submissions`, `imports`, `reports`, `auth` |
| Component | หน้า/คอมโพเนนต์ React จริงใน jsdom กับ API จำลองที่ตอบตาม schema จริง | `admin-ledger`, `payment-submissions`, `calendar`, `ui` |
| Mutation | ไม่ใช่ไฟล์เทสต์: แก้โค้ดจริงทีละจุด (ปัดลง, ตัดเงื่อนไข ฯลฯ) แล้วรันเทสต์ — ต้องมีเทสต์พัง; ผลอยู่ในไฟล์ `PHASE*-SECURITY-REVIEW.md`, `CR*-REVIEW.md` | `roundUpBaht`, การยืนยันสลิป |

ไม่มี E2E บนเบราว์เซอร์จริงในชุดนี้ (ยังไม่ได้ทดสอบบน iPhone — งาน T-1002) การตรวจหน้าจอจริงทำด้วยมือผ่านเบราว์เซอร์

## 3. เทสต์ API (`api/test`)

### สรุปตามส่วนงาน

| ส่วนงาน | ไฟล์เทสต์ | อ้างอิง | สิ่งที่ถูกทดสอบ | จำนวนเคส |
|---|---|---|---|---|
| การคำนวณเงิน | `allocation.test.ts` | F5 · DES-011 | lib/allocation — ตัดยอด ค่าปรับ → ดอกเบี้ย → เงินต้น | 8 |
| การคำนวณเงิน | `dates.test.ts` | F6 · DES-012 | lib/dates — วันที่ Asia/Bangkok, parse/format | 4 |
| การคำนวณเงิน | `interest.test.ts` | F4 · DES-010 | lib/interest — ดอกเบี้ย ปัดขึ้นเป็นบาทเต็ม | 18 |
| การคำนวณเงิน | `late-fee.test.ts` | F6 · DES-012 | lib/late-fee — ค่าปรับรายวันคิดซ้อน ปัดขึ้นเป็นบาทเต็ม | 15 |
| การคำนวณเงิน | `money.test.ts` | F4 · F6 · DES-010 · DES-012 | lib/money — Decimal, roundUpBaht, ห้ามใช้ number | 21 |
| ค่าตั้งต้น | `config.test.ts` | F2 · Security | config — ตรวจ environment, ค่าลับ, VAPID ครบหรือไม่มีเลย | 33 |
| ค่าตั้งต้น | `health.test.ts` | Operations | health — ตรวจสุขภาพระบบ | 1 |
| ค่าตั้งต้น | `settings.test.ts` | F2 | settings/* — อัตราดอกเบี้ยและค่าปรับ (ไม่ hard-code) | 11 |
| เครื่องมือชั่วคราว (dev-tools) | `dev-tests.test.ts` | DEV-TOOLS | dev-tools/* — ปุ่มรันเทสต์ในเว็บ (จะเอาออกก่อน deploy จริง) | 51 |
| งานเบื้องหลัง | `scheduler.test.ts` | F6 · T-304 | jobs/scheduler + late-fee-job กับ PostgreSQL จริง (advisory lock, ตามเก็บย้อนหลัง) | 16 |
| งานเบื้องหลัง | `scheduler-unit.test.ts` | F6 · F7 · T-304 | jobs/scheduler, late-fee-job, notify-jobs — ตรรกะเวลา/ล็อก/ตัวจับเวลา ไม่ใช้ฐานข้อมูล | 15 |
| แจ้งเตือน | `notifier.test.ts` | F7 · DES-013 | notifications/service — dedupe, retry, หลายช่องทาง | 14 |
| แจ้งเตือน | `notify-channels.test.ts` | F7 | notifications/line, webpush — adapter ช่องทาง | 10 |
| แจ้งเตือน | `notify-jobs.test.ts` | F7 · DES-013 | jobs/notify-jobs — รอบ 09:00 ครบกำหนด / 17:00 เลยกำหนด | 10 |
| แจ้งเตือน | `notify-messages.test.ts` | F7 · DES-013 | notifications/messages, format — ข้อความ ไทย จำนวนเงิน | 12 |
| แจ้งเตือน | `notify-routes.test.ts` | F7 | notifications/routes — ตั้งค่า LINE/Push, ประวัติ | 14 |
| แจ้งเตือน | `webpush-sender.test.ts` | F7 | notifications/webpush — createVapidSender | 2 |
| นำเข้าข้อมูล | `import-file.test.ts` | F10 · DES-014 | imports/file — อ่าน CSV/XLSX | 25 |
| นำเข้าข้อมูล | `imports.test.ts` | F10 · DES-014 | imports/* — preview, confirm, rollback, ชื่อซ้ำ | 25 |
| นำเข้าข้อมูล | `import-storage.test.ts` | F10 · DES-014 | imports/storage — ไฟล์รอยืนยัน | 4 |
| ผู้ใช้และสิทธิ์ | `admin-reset.test.ts` | F1 | scripts/admin-accounts — รีเซ็ตรหัสผ่านผู้ดูแล | 5 |
| ผู้ใช้และสิทธิ์ | `audit.test.ts` | F1 · F5 | lib/audit — AuditLog ใน transaction เดียวกับการเปลี่ยนข้อมูล | 13 |
| ผู้ใช้และสิทธิ์ | `auth-lib.test.ts` | F1 | lib/password, session — scrypt, นโยบายรหัสผ่าน, token | 15 |
| ผู้ใช้และสิทธิ์ | `auth.test.ts` | F1 | auth/routes — login/logout/me/เปลี่ยนรหัส, cookie, สิทธิ์ | 11 |
| ผู้ใช้และสิทธิ์ | `borrowers.test.ts` | F1 · F8 | borrowers/* — สร้าง/แก้ผู้ยืม, บัญชี, ข้อมูลส่วนบุคคลเข้ารหัส | 20 |
| ผู้ใช้และสิทธิ์ | `field-crypto.test.ts` | F1 · PDPA | lib/field-crypto — AES-GCM เข้ารหัสฟิลด์ | 8 |
| ผู้ใช้และสิทธิ์ | `login-throttle.test.ts` | F1 | auth/throttle — จำกัดการเดารหัสผ่าน | 7 |
| ผู้ใช้และสิทธิ์ | `pdpa.test.ts` | F1 · PDPA | pdpa/* — ความยินยอม, เวอร์ชันข้อความ | 8 |
| ผู้ยืมแจ้งชำระ + ปฏิทิน | `submissions.test.ts` | F5-CR1 · F11 · DES-017 · DES-018 | loans/submissions, calendar — ผู้ยืมส่งสลิป admin ยืนยัน, ปฏิทิน | 29 |
| พอร์ทัลผู้ยืม | `borrower-portal.test.ts` | F8 | borrower/portal — ผู้ยืมเห็นเฉพาะของตน | 13 |
| รายงาน | `reports.test.ts` | F9 · DES-015 | reports/* — กำไรขาดทุน, ยอดค้าง, ผู้ชำระช้า | 28 |
| สัญญาและการจ่ายเงิน | `disbursement.test.ts` | F4 · F5 · DES-010 · DES-011 | loans/disbursement — บันทึกจ่ายเงิน, สลิปบังคับ, snapshot อัตรา | 16 |
| สัญญาและการจ่ายเงิน | `ledger.test.ts` | F5 · F6 · DES-011 · DES-012 · DES-016 | loans/ledger, payments — รับชำระ แก้ ลบ replay สัญญา | 36 |
| สัญญาและการจ่ายเงิน | `loans.test.ts` | F3 · F4 · DES-004–006 | loans/* — คำขอยืม, อนุมัติ, สัญญา, สิทธิ์ | 31 |
| สัญญาและการจ่ายเงิน | `slips.test.ts` | F5 · DES-011 | lib/slip-storage + route — เก็บ/เปิดสลิป เฉพาะ ADMIN | 14 |
| **รวม** | 35 ไฟล์ | | | **563** |

### รายการเคสทั้งหมด

#### API-01 · `allocation.test.ts` — lib/allocation — ตัดยอด ค่าปรับ → ดอกเบี้ย → เงินต้น

อ้างอิง: F5 · DES-011

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-01-001 | allocatePayment (DES-011: late fee -> interest -> principal) | matches the worked example: owed 1,050, pays 300 -> 50 / 200 / 50 | ✓ |
| API-01-002 | allocatePayment (DES-011: late fee -> interest -> principal) | pays the late fee first, even when the payment is smaller than the fee | ✓ |
| API-01-003 | allocatePayment (DES-011: late fee -> interest -> principal) | moves on to interest only after the fee is covered, and to principal after the interest | ✓ |
| API-01-004 | allocatePayment (DES-011: late fee -> interest -> principal) | can settle everything exactly | ✓ |
| API-01-005 | allocatePayment (DES-011: late fee -> interest -> principal) | refuses a payment above what is owed, and says how much is owed | ✓ |
| API-01-006 | allocatePayment (DES-011: late fee -> interest -> principal) | refuses zero and negative payments | ✓ |
| API-01-007 | allocatePayment (DES-011: late fee -> interest -> principal) | refuses any payment when nothing is owed | ✓ |
| API-01-008 | allocatePayment (DES-011: late fee -> interest -> principal) | always splits the amount exactly and respects the order (random cases) | ✓ |

#### API-02 · `dates.test.ts` — lib/dates — วันที่ Asia/Bangkok, parse/format

อ้างอิง: F6 · DES-012

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-02-001 | bangkokToday | uses the Asia/Bangkok calendar date, not UTC | ✓ |
| API-02-002 | bangkokToday | returns a date-only value (UTC midnight) | ✓ |
| API-02-003 | parseDateOnly | accepts real calendar dates | ✓ |
| API-02-004 | parseDateOnly | rejects malformed and impossible dates | ✓ |

#### API-03 · `interest.test.ts` — lib/interest — ดอกเบี้ย ปัดขึ้นเป็นบาทเต็ม

อ้างอิง: F4 · DES-010

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-03-001 | calendarDaysBetween | counts calendar days | ✓ |
| API-03-002 | calendarDaysBetween | handles month, year and leap-year boundaries | ✓ |
| API-03-003 | calendarDaysBetween | rejects values that are not date-only | ✓ |
| API-03-004 | computeInterestForDays (DES-010) | matches hand-computed exact amounts (already whole baht, so nothing is added) | ✓ |
| API-03-005 | computeInterestForDays (DES-010) | rounds UP to a whole baht whenever there is any remainder, never down and never to nearest | ✓ |
| API-03-006 | computeInterestForDays (DES-010) | does not bump an amount that is already a whole number of baht | ✓ |
| API-03-007 | computeInterestForDays (DES-010) | allows a 0% rate and returns 0 | ✓ |
| API-03-008 | computeInterestForDays (DES-010) | returns a Prisma Decimal | ✓ |
| API-03-009 | computeInterestForDays (DES-010) | accepts Decimal inputs | ✓ |
| API-03-010 | computeInterestForDays (DES-010) | rejects number inputs (floats are not allowed for money) | ✓ |
| API-03-011 | computeInterestForDays (DES-010) | rejects invalid days | ✓ |
| API-03-012 | computeInterestForDays (DES-010) | rejects non-positive principal and negative rate | ✓ |
| API-03-013 | computeInterestForDays (DES-010) | agrees with an independent BigInt oracle across many random cases | ✓ |
| API-03-014 | computeInterestForDays (DES-010) | stays exact when principal, rate and days are all large (products over 20 digits) | ✓ |
| API-03-015 | computeInterestForDays (DES-010) | stays exact at the Decimal(14,2) maximum | ✓ |
| API-03-016 | computeInterest (DES-010 with dates) | uses days from disbursedOn to dueDate | ✓ |
| API-03-017 | computeInterest (DES-010 with dates) | charges the full amount for a 1-day loan | ✓ |
| API-03-018 | computeInterest (DES-010 with dates) | rejects dueDate on or before disbursedOn | ✓ |

#### API-04 · `late-fee.test.ts` — lib/late-fee — ค่าปรับรายวันคิดซ้อน ปัดขึ้นเป็นบาทเต็ม

อ้างอิง: F6 · DES-012

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-04-001 | lateFeeForDay | is rate % of the base, rounded UP to a whole baht (never down, never to nearest) | ✓ |
| API-04-002 | simulateContract: fees (DES-012) | charges nothing up to and including the due date | ✓ |
| API-04-003 | simulateContract: fees (DES-012) | starts the day after the due date and compounds on principal + interest + earlier fees | ✓ |
| API-04-004 | simulateContract: fees (DES-012) | charges a row for every day even when the rate is 0 | ✓ |
| API-04-005 | simulateContract: payments (DES-011, DES-012) | a part payment lowers the base from the next day on, never the interest | ✓ |
| API-04-006 | simulateContract: payments (DES-011, DES-012) | a part payment before the due date lowers the base the first fee is charged on | ✓ |
| API-04-007 | simulateContract: payments (DES-011, DES-012) | paying everything on the due date closes the contract with no fee at all | ✓ |
| API-04-008 | simulateContract: payments (DES-011, DES-012) | the fee of the day the contract is paid off is still charged, then fees stop | ✓ |
| API-04-009 | simulateContract: payments (DES-011, DES-012) | refuses a payment above what is owed on its day | ✓ |
| API-04-010 | simulateContract: payments (DES-011, DES-012) | refuses anything paid after the contract is already settled, including later the same day | ✓ |
| API-04-011 | simulateContract: payments (DES-011, DES-012) | applies payments in paidOn then createdAt order regardless of the order given | ✓ |
| API-04-012 | simulateContract: payments (DES-011, DES-012) | rejects non-positive amounts, future dates and dates before the payout | ✓ |
| API-04-013 | simulateContract: payments (DES-011, DES-012) | has no lower date bound for imported contracts (no payout date) | ✓ |
| API-04-014 | simulateContract: payments (DES-011, DES-012) | stops with LIMIT_EXCEEDED instead of overflowing the column | ✓ |
| API-04-015 | simulateContract agrees with an independent integer oracle (random cases) | matches final balances, status, fees per day and every allocation | ✓ |

#### API-05 · `money.test.ts` — lib/money — Decimal, roundUpBaht, ห้ามใช้ number

อ้างอิง: F4 · F6 · DES-010 · DES-012

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-05-001 | toDecimal | accepts a Decimal and a string, and keeps every digit | ✓ |
| API-05-002 | toDecimal | refuses a JavaScript number, so a float can never become money | ✓ |
| API-05-003 | toDecimal | refuses values that are not finite | ✓ |
| API-05-004 | multiply and divide are exact at high precision | multiplies without losing digits (a float would) | ✓ |
| API-05-005 | multiply and divide are exact at high precision | divides to far more digits than 2, so the later round-up decides | ✓ |
| API-05-006 | multiply and divide are exact at high precision | rounds the 60th digit up, never down | ✓ |
| API-05-007 | roundUpBaht: always UP to a whole baht, never down | 0 -> 0 | ✓ |
| API-05-008 | roundUpBaht: always UP to a whole baht, never down | 1 -> 1 | ✓ |
| API-05-009 | roundUpBaht: always UP to a whole baht, never down | 258 -> 258 | ✓ |
| API-05-010 | roundUpBaht: always UP to a whole baht, never down | 258.00 -> 258 | ✓ |
| API-05-011 | roundUpBaht: always UP to a whole baht, never down | 258.01 -> 259 | ✓ |
| API-05-012 | roundUpBaht: always UP to a whole baht, never down | 258.1 -> 259 | ✓ |
| API-05-013 | roundUpBaht: always UP to a whole baht, never down | 258.49 -> 259 | ✓ |
| API-05-014 | roundUpBaht: always UP to a whole baht, never down | 258.50 -> 259 | ✓ |
| API-05-015 | roundUpBaht: always UP to a whole baht, never down | 258.99 -> 259 | ✓ |
| API-05-016 | roundUpBaht: always UP to a whole baht, never down | 0.01 -> 1 | ✓ |
| API-05-017 | roundUpBaht: always UP to a whole baht, never down | 0.0000001 -> 1 | ✓ |
| API-05-018 | roundUpBaht: always UP to a whole baht, never down | 1000.000000000000000000000000000001 -> 1001 | ✓ |
| API-05-019 | roundUpBaht: always UP to a whole baht, never down | 999999999999.01 -> 1000000000000 | ✓ |
| API-05-020 | roundUpBaht: always UP to a whole baht, never down | is never below the input and less than 1 above it (a property check over many values) | ✓ |
| API-05-021 | roundUpBaht: always UP to a whole baht, never down | leaves a result that is already whole exactly as it was (idempotent) | ✓ |

#### API-06 · `config.test.ts` — config — ตรวจ environment, ค่าลับ, VAPID ครบหรือไม่มีเลย

อ้างอิง: F2 · Security

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-06-001 | loadConfig (environment validation) | accepts the minimum environment and fills in the defaults | ✓ |
| API-06-002 | loadConfig (environment validation) | turns numeric text into numbers | ✓ |
| API-06-003 | loadConfig (environment validation) | rejects DATABASE_URL = undefined | ✓ |
| API-06-004 | loadConfig (environment validation) | rejects DATABASE_URL = "" | ✓ |
| API-06-005 | loadConfig (environment validation) | rejects SESSION_SECRET = undefined | ✓ |
| API-06-006 | loadConfig (environment validation) | rejects SESSION_SECRET = "sssssssssssssssssssssssssssssss" | ✓ |
| API-06-007 | loadConfig (environment validation) | rejects FIELD_ENCRYPTION_KEY = undefined | ✓ |
| API-06-008 | loadConfig (environment validation) | rejects FIELD_ENCRYPTION_KEY = "AQEBAQEBAQEBAQEBAQEBAQ==" | ✓ |
| API-06-009 | loadConfig (environment validation) | rejects FIELD_ENCRYPTION_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" | ✓ |
| API-06-010 | loadConfig (environment validation) | rejects PORT = "0" | ✓ |
| API-06-011 | loadConfig (environment validation) | rejects PORT = "abc" | ✓ |
| API-06-012 | loadConfig (environment validation) | rejects TRUST_PROXY = "-1" | ✓ |
| API-06-013 | loadConfig (environment validation) | rejects TRUST_PROXY = "11" | ✓ |
| API-06-014 | loadConfig (environment validation) | rejects SLIP_MAX_BYTES = "100" | ✓ |
| API-06-015 | loadConfig (environment validation) | rejects SLIP_MAX_BYTES = "53477376" | ✓ |
| API-06-016 | loadConfig (environment validation) | rejects IMPORT_MAX_BYTES = "22020096" | ✓ |
| API-06-017 | loadConfig (environment validation) | rejects NODE_ENV = "staging" | ✓ |
| API-06-018 | loadConfig (environment validation) | rejects LINE_CHANNEL_ACCESS_TOKEN = "short" | ✓ |
| API-06-019 | loadConfig (environment validation) | rejects SCHEDULER_ENABLED = "yes" | ✓ |
| API-06-020 | loadConfig (environment validation) | names every problem in one message, and never prints the value that was wrong | ✓ |
| API-06-021 | loadConfig (environment validation) | reads SCHEDULER_ENABLED as a real boolean | ✓ |
| API-06-022 | loadConfig (environment validation) › DEV_TEST_RUNNER (temporary in-app test runner) | is off unless asked for | ✓ |
| API-06-023 | loadConfig (environment validation) › DEV_TEST_RUNNER (temporary in-app test runner) | can be turned on in development and test | ✓ |
| API-06-024 | loadConfig (environment validation) › DEV_TEST_RUNNER (temporary in-app test runner) | is refused in production, so the server will not even start with it on | ✓ |
| API-06-025 | loadConfig (environment validation) › DEV_TEST_RUNNER (temporary in-app test runner) | accepts only true or false | ✓ |
| API-06-026 | loadConfig (environment validation) › Web Push keys: all three or none | accepts none and accepts all three (mailto or https subject) | ✓ |
| API-06-027 | loadConfig (environment validation) › Web Push keys: all three or none | refuses a partial set when VAPID_PUBLIC_KEY is missing and says which one | ✓ |
| API-06-028 | loadConfig (environment validation) › Web Push keys: all three or none | refuses a partial set when VAPID_PRIVATE_KEY is missing and says which one | ✓ |
| API-06-029 | loadConfig (environment validation) › Web Push keys: all three or none | refuses a partial set when VAPID_SUBJECT is missing and says which one | ✓ |
| API-06-030 | loadConfig (environment validation) › Web Push keys: all three or none | refuses the subject "admin@example.com" | ✓ |
| API-06-031 | loadConfig (environment validation) › Web Push keys: all three or none | refuses the subject "http://insecure.example.com" | ✓ |
| API-06-032 | loadConfig (environment validation) › Web Push keys: all three or none | refuses the subject "mailto:" | ✓ |
| API-06-033 | loadConfig (environment validation) › Web Push keys: all three or none | refuses the subject "ftp://x.example.com" | ✓ |

#### API-07 · `health.test.ts` — health — ตรวจสุขภาพระบบ

อ้างอิง: Operations

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-07-001 | GET /health | responds 200 with status ok | ✓ |

#### API-08 · `settings.test.ts` — settings/* — อัตราดอกเบี้ยและค่าปรับ (ไม่ hard-code)

อ้างอิง: F2

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-08-001 | requireRates (no database) | throws when there is no row or either rate is null | ✓ |
| API-08-002 | requireRates (no database) | returns both rates, treating 0 as set | ✓ |
| API-08-003 | requireRates (no database) | getRates reports nulls for a missing row | ✓ |
| API-08-004 | admin settings (PostgreSQL) | is for ADMIN only | ✓ |
| API-08-005 | admin settings (PostgreSQL) | reports both rates as null until an admin sets them | ✓ |
| API-08-006 | admin settings (PostgreSQL) | refuses money operations (409 RATES_NOT_SET) until both rates exist | ✓ |
| API-08-007 | admin settings (PostgreSQL) | sets both rates, stores them exactly and records who and when | ✓ |
| API-08-008 | admin settings (PostgreSQL) | lets requireRates read the stored rates as exact Decimals | ✓ |
| API-08-009 | admin settings (PostgreSQL) | changes one rate and leaves the other, with a before/after audit row | ✓ |
| API-08-010 | admin settings (PostgreSQL) | accepts 0 as a real rate and the largest value the column holds | ✓ |
| API-08-011 | admin settings (PostgreSQL) | rejects invalid rates and changes nothing | ✓ |

#### API-09 · `dev-tests.test.ts` — dev-tools/* — ปุ่มรันเทสต์ในเว็บ (จะเอาออกก่อน deploy จริง)

อ้างอิง: DEV-TOOLS

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-09-001 | TestRunner.suites | lists the real test files with what each protects, in order, and nothing else | ✓ |
| API-09-002 | TestRunner.suites | still works when the map file or a test folder is missing | ✓ |
| API-09-003 | isLocalDatabase | postgresql://u:p@localhost:5433/db -> true | ✓ |
| API-09-004 | isLocalDatabase | postgresql://u:p@127.0.0.1:5433/db -> true | ✓ |
| API-09-005 | isLocalDatabase | postgresql://u:p@[::1]:5433/db -> true | ✓ |
| API-09-006 | isLocalDatabase | postgresql://u:p@LOCALHOST/db -> true | ✓ |
| API-09-007 | isLocalDatabase | postgresql://u:p@db.example.com:5432/db -> false | ✓ |
| API-09-008 | isLocalDatabase | postgresql://u:p@10.0.0.5:5432/db -> false | ✓ |
| API-09-009 | isLocalDatabase | postgresql://u:p@localhost.evil.com/db -> false | ✓ |
| API-09-010 | isLocalDatabase | not a url -> false | ✓ |
| API-09-011 | isLocalDatabase |  -> false | ✓ |
| API-09-012 | isLocalDatabase | undefined -> false | ✓ |
| API-09-013 | TestRunner.start: what is run | runs vitest through node with fixed arguments and the chosen files, in that project's folder | ✓ |
| API-09-014 | TestRunner.start: what is run | runs every file of the project when none are named, and removes duplicates | ✓ |
| API-09-015 | TestRunner.start: what is run | refuses a file that does not exist and starts nothing | ✓ |
| API-09-016 | TestRunner.start: what is run | refuses a path out of the folder and starts nothing | ✓ |
| API-09-017 | TestRunner.start: what is run | refuses a path with a separator and starts nothing | ✓ |
| API-09-018 | TestRunner.start: what is run | refuses something that looks like a shell command and starts nothing | ✓ |
| API-09-019 | TestRunner.start: what is run | refuses a flag and starts nothing | ✓ |
| API-09-020 | TestRunner.start: what is run | refuses a file of the other project and starts nothing | ✓ |
| API-09-021 | TestRunner.start: what is run | refuses a helper that is not a test and starts nothing | ✓ |
| API-09-022 | TestRunner.start: what is run | says so when the project has no tests, or vitest is not installed | ✓ |
| API-09-023 | TestRunner.start: where the API tests may run | refuses the API tests unless the database is on this machine, and says why | ✓ |
| API-09-024 | TestRunner.start: where the API tests may run | refuses the API tests when there is no database URL at all | ✓ |
| API-09-025 | TestRunner.start: where the API tests may run | the web tests need no database, so they run whatever it is | ✓ |
| API-09-026 | TestRunner: one run at a time | refuses a second run while one is going, and accepts one after it ends | ✓ |
| API-09-027 | TestRunner: reading the result | counts passed, failed and skipped tests and marks the run | ✓ |
| API-09-028 | TestRunner: reading the result | an all-green run is 'passed' | ✓ |
| API-09-029 | TestRunner: reading the result | trusts the report over the exit code: exit 0 with a failed test is 'failed' | ✓ |
| API-09-030 | TestRunner: reading the result | strips colour codes from failure messages and cuts very long ones | ✓ |
| API-09-031 | TestRunner: reading the result | a test file that cannot even load is reported as a failure with its message | ✓ |
| API-09-032 | TestRunner: reading the result | a crash with no report is an 'error' that points at the output, never a silent pass | ✓ |
| API-09-033 | TestRunner: reading the result | exit code 0 with no report is also an error, not a pass | ✓ |
| API-09-034 | TestRunner: reading the result | an unreadable report is an error | ✓ |
| API-09-035 | TestRunner: reading the result | deletes the report file once it has been read | ✓ |
| API-09-036 | TestRunner: reading the result | only the first ending counts (exit after a timeout changes nothing) | ✓ |
| API-09-037 | TestRunner: live output | keeps the last 25 lines, without colour codes, and joins lines split across chunks | ✓ |
| API-09-038 | TestRunner: live output | reads the error stream too | ✓ |
| API-09-039 | TestRunner: cancel and timeout | cancel stops the whole process tree and the run ends as 'cancelled' | ✓ |
| API-09-040 | TestRunner: cancel and timeout | cancel of an unknown or finished run is refused | ✓ |
| API-09-041 | TestRunner: cancel and timeout | a run that takes too long is stopped and marked 'timeout' | ✓ |
| API-09-042 | TestRunner.list / get | lists newest first, without the bulky detail, and keeps only the latest 20 | ✓ |
| API-09-043 | the routes (fake login) | asks for an ADMIN on every route | ✓ |
| API-09-044 | the routes (fake login) | GET / lists the suites and the recent runs | ✓ |
| API-09-045 | the routes (fake login) | POST /runs starts a run (202) and GET /runs/:id follows it | ✓ |
| API-09-046 | the routes (fake login) | rejects a bad body, an unknown file, a second run and an unknown run id | ✓ |
| API-09-047 | the routes (fake login) | DELETE /runs/:id cancels the run that is going | ✓ |
| API-09-048 | access control with the real login (PostgreSQL) | does not exist at all when the runner is switched off | ✓ |
| API-09-049 | access control with the real login (PostgreSQL) | when on: a visitor gets 401, a borrower 403, only the admin gets in | ✓ |
| API-09-050 | access control with the real login (PostgreSQL) | a borrower and a visitor cannot start or cancel a run either | ✓ |
| API-09-051 | the real thing: runs one real test file through real vitest | runs web/test/money.test.ts and reports it as passed | ✓ |

#### API-10 · `scheduler.test.ts` — jobs/scheduler + late-fee-job กับ PostgreSQL จริง (advisory lock, ตามเก็บย้อนหลัง)

อ้างอิง: F6 · T-304

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-10-001 | Bangkok clock helpers | reads the Asia/Bangkok time (UTC+7), not UTC | ✓ |
| API-10-002 | Bangkok clock helpers | parses HH:MM and rejects anything else | ✓ |
| API-10-003 | Bangkok clock helpers | gives every job its own stable lock key | ✓ |
| API-10-004 | scheduler (PostgreSQL advisory lock) | does not run before its time, runs once at the first tick after it, and not again that day | ✓ |
| API-10-005 | scheduler (PostgreSQL advisory lock) | runs again on the next Bangkok day, using Bangkok midnight not UTC midnight | ✓ |
| API-10-006 | scheduler (PostgreSQL advisory lock) | catches up when the process starts late: a job whose time has passed runs at the first tick | ✓ |
| API-10-007 | scheduler (PostgreSQL advisory lock) | runOnStart runs a job at the first tick even before its time, then waits for the next day | ✓ |
| API-10-008 | scheduler (PostgreSQL advisory lock) | a failing job does not stop the others and is not retried the same day | ✓ |
| API-10-009 | scheduler (PostgreSQL advisory lock) | rejects a bad time at construction | ✓ |
| API-10-010 | scheduler (PostgreSQL advisory lock) | lets only one process run a job at a time (advisory lock) | ✓ |
| API-10-011 | scheduler (PostgreSQL advisory lock) | does not overlap its own ticks | ✓ |
| API-10-012 | nightly late-fee job (PostgreSQL) | writes every missing day for an overdue contract and updates its balances | ✓ |
| API-10-013 | nightly late-fee job (PostgreSQL) | is idempotent: a second run changes nothing and rewrites no rows | ✓ |
| API-10-014 | nightly late-fee job (PostgreSQL) | ignores contracts that are not overdue, not paid out, or already closed | ✓ |
| API-10-015 | nightly late-fee job (PostgreSQL) | catches up several missed days in one run, even after partial progress | ✓ |
| API-10-016 | nightly late-fee job (PostgreSQL) | a contract that cannot be reconciled is reported and does not stop the others | ✓ |

#### API-11 · `scheduler-unit.test.ts` — jobs/scheduler, late-fee-job, notify-jobs — ตรรกะเวลา/ล็อก/ตัวจับเวลา ไม่ใช้ฐานข้อมูล

อ้างอิง: F6 · F7 · T-304

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-11-001 | advisoryKey | is stable for a name, different between names, and a positive 63-bit number | ✓ |
| API-11-002 | Scheduler.tick (no database) | does not run a job before its time, and runs it at/after its time | ✓ |
| API-11-003 | Scheduler.tick (no database) | runs a job once per Bangkok day, and again the next Bangkok day | ✓ |
| API-11-004 | Scheduler.tick (no database) | changes day at midnight in Bangkok, not at midnight UTC | ✓ |
| API-11-005 | Scheduler.tick (no database) | runOnStart runs a job at the first tick even before its time, but only that once | ✓ |
| API-11-006 | Scheduler.tick (no database) | hands the job the clock it was given | ✓ |
| API-11-007 | Scheduler.tick (no database) | skips a job whose lock another process holds, and says so | ✓ |
| API-11-008 | Scheduler.tick (no database) | a failing job is logged without its details, does not stop the others, and is not retried the same day | ✓ |
| API-11-009 | Scheduler.tick (no database) | reports an unknown (non-Error) failure with a generic text | ✓ |
| API-11-010 | Scheduler.tick (no database) | a slow tick is never overlapped by the next one | ✓ |
| API-11-011 | Scheduler.tick (no database) | refuses a bad time at construction (fail fast), not at 09:00 on some night | ✓ |
| API-11-012 | Scheduler.start / stop (timers) | ticks at once and then every tickMs; start() twice adds no second timer; stop() ends it | ✓ |
| API-11-013 | Scheduler.start / stop (timers) | can be started again after it was stopped | ✓ |
| API-11-014 | the jobs the server registers | late-fee: 00:05 every night and also at start-up, and its run() works through runLateFeeJob | ✓ |
| API-11-015 | the jobs the server registers | notifications: 09:00 due-today and 17:00 overdue, each sending nothing when no contract qualifies | ✓ |

#### API-12 · `notifier.test.ts` — notifications/service — dedupe, retry, หลายช่องทาง

อ้างอิง: F7 · DES-013

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-12-001 | Notifier (PostgreSQL) | delivers on every channel and records each one | ✓ |
| API-12-002 | Notifier (PostgreSQL) | never sends the same notification twice (dedupeKey), but sends a different one | ✓ |
| API-12-003 | Notifier (PostgreSQL) | sends only once when the same notification is requested at the same moment | ✓ |
| API-12-004 | Notifier (PostgreSQL) | retries a failing channel and succeeds on the third attempt | ✓ |
| API-12-005 | Notifier (PostgreSQL) | gives up after 3 attempts, records FAILED with the error, and the other channel is unaffected | ✓ |
| API-12-006 | Notifier (PostgreSQL) | a channel that breaks before it can even try (e.g. its recipient lookup errors) does not stop the other | ✓ |
| API-12-007 | Notifier (PostgreSQL) | does not keep retrying a FAILED notification later | ✓ |
| API-12-008 | Notifier (PostgreSQL) | skips a channel with no recipient: nothing is sent and nothing is logged | ✓ |
| API-12-009 | Notifier (PostgreSQL) | truncates long error text and tolerates non-Error failures | ✓ |
| API-12-010 | Notifier (PostgreSQL) | takes over a notification abandoned mid-send, but leaves one that is still in progress | ✓ |
| API-12-011 | Notifier (PostgreSQL) | keeps message content out of the log | ✓ |
| API-12-012 | Notifier (PostgreSQL) | background dispatch never throws into the caller, and drain waits for it | ✓ |
| API-12-013 | Notifier (PostgreSQL) › NEW_REQUEST | tells the admin about a pending request with its details, once | ✓ |
| API-12-014 | Notifier (PostgreSQL) › NEW_REQUEST | says nothing for a request that is no longer pending or does not exist | ✓ |

#### API-13 · `notify-channels.test.ts` — notifications/line, webpush — adapter ช่องทาง

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-13-001 | LINE and Web Push channels (PostgreSQL) › LINE | pushes the long text to the admin's LINE user id with the bearer token | ✓ |
| API-13-002 | LINE and Web Push channels (PostgreSQL) › LINE | sends only to active ADMINs that are bound, never to borrowers or unbound/inactive accounts | ✓ |
| API-13-003 | LINE and Web Push channels (PostgreSQL) › LINE | has a recipient only when an ADMIN has bound a LINE id | ✓ |
| API-13-004 | LINE and Web Push channels (PostgreSQL) › LINE | fails on an HTTP error with LINE's reason, and never leaks the token | ✓ |
| API-13-005 | LINE and Web Push channels (PostgreSQL) › LINE | fails when the network fails, and cuts the text to LINE's limit | ✓ |
| API-13-006 | LINE and Web Push channels (PostgreSQL) › Web Push | sends the short JSON payload to every ADMIN subscription | ✓ |
| API-13-007 | LINE and Web Push channels (PostgreSQL) › Web Push | never sends to a borrower's or an inactive account's subscription | ✓ |
| API-13-008 | LINE and Web Push channels (PostgreSQL) › Web Push | removes a subscription the push service says is gone (410), and keeps delivering to the rest | ✓ |
| API-13-009 | LINE and Web Push channels (PostgreSQL) › Web Push | fails when nobody could be reached, keeping the subscription after a temporary error | ✓ |
| API-13-010 | LINE and Web Push channels (PostgreSQL) › Web Push | has a recipient only when an ADMIN has a subscription | ✓ |

#### API-14 · `notify-jobs.test.ts` — jobs/notify-jobs — รอบ 09:00 ครบกำหนด / 17:00 เลยกำหนด

อ้างอิง: F7 · DES-013

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-14-001 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | sends ONE due-today summary listing every contract due today that still owes money | ✓ |
| API-14-002 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | sends ONE overdue summary from the due date on, with how many days late and what is owed incl. today's fee | ✓ |
| API-14-003 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | uses what is owed after payments, and leaves out a contract that has been paid off | ✓ |
| API-14-004 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | sends nothing at all when no contract qualifies | ✓ |
| API-14-005 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | runs a round again on the same day without sending a second time | ✓ |
| API-14-006 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | delivers on both channels, and one failing channel does not stop the other | ✓ |
| API-14-007 | notification rounds and the new-request hook (PostgreSQL) › 09:00 due-today and 17:00 overdue rounds (DES-013) | registers the jobs at 09:00 and 17:00 on the shared scheduler | ✓ |
| API-14-008 | notification rounds and the new-request hook (PostgreSQL) › NEW_REQUEST is sent as soon as a borrower files a request (DES-013) | notifies the admin with the borrower, amount and due date, once | ✓ |
| API-14-009 | notification rounds and the new-request hook (PostgreSQL) › NEW_REQUEST is sent as soon as a borrower files a request (DES-013) | never fails or waits for the borrower when a channel is down or slow | ✓ |
| API-14-010 | notification rounds and the new-request hook (PostgreSQL) › NEW_REQUEST is sent as soon as a borrower files a request (DES-013) | says nothing for a request the borrower could not file, or one the admin filed on their behalf | ✓ |

#### API-15 · `notify-messages.test.ts` — notifications/messages, format — ข้อความ ไทย จำนวนเงิน

อ้างอิง: F7 · DES-013

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-15-001 | formatBaht | adds thousands separators and always shows 2 decimals, exactly | ✓ |
| API-15-002 | formatBaht | rounds only for display at 2 places and keeps the sign | ✓ |
| API-15-003 | formatThaiDate | writes day/month/year in the Buddhist Era | ✓ |
| API-15-004 | rendered messages | new request names the borrower, amount and requested due date | ✓ |
| API-15-005 | rendered messages | due-today is ONE message listing every contract with the total | ✓ |
| API-15-006 | rendered messages | overdue shows how many days late, and 'due today' for contracts due today | ✓ |
| API-15-007 | rendered messages | cuts a long list and says how many were left out | ✓ |
| API-15-008 | rendered messages | never exceeds LINE's text limit, even with very long names | ✓ |
| API-15-009 | rendered messages | keeps the push payload small | ✓ |
| API-15-010 | push endpoint allow-list (SSRF guard) | accepts the real browser push services | ✓ |
| API-15-011 | push endpoint allow-list (SSRF guard) | rejects anything that could make the server call somewhere else | ✓ |
| API-15-012 | push endpoint allow-list (SSRF guard) | checks the subscription keys' real sizes | ✓ |

#### API-16 · `notify-routes.test.ts` — notifications/routes — ตั้งค่า LINE/Push, ประวัติ

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-16-001 | notification setup endpoints (PostgreSQL) › LINE binding (T-402) | starts unbound, binds a valid LINE user id, and only shows it masked | ✓ |
| API-16-002 | notification setup endpoints (PostgreSQL) › LINE binding (T-402) | only changes the caller's own binding | ✓ |
| API-16-003 | notification setup endpoints (PostgreSQL) › LINE binding (T-402) | rejects ids that are not LINE user ids and changes nothing | ✓ |
| API-16-004 | notification setup endpoints (PostgreSQL) › LINE binding (T-402) | audits changes with the id masked | ✓ |
| API-16-005 | notification setup endpoints (PostgreSQL) › LINE binding (T-402) | can be removed | ✓ |
| API-16-006 | notification setup endpoints (PostgreSQL) › LINE binding (T-402) | is ADMIN only | ✓ |
| API-16-007 | notification setup endpoints (PostgreSQL) › Web Push subscriptions (T-403) | serves the VAPID public key, or 503 when push is not configured | ✓ |
| API-16-008 | notification setup endpoints (PostgreSQL) › Web Push subscriptions (T-403) | registers a subscription for the logged-in admin, and re-registering updates it | ✓ |
| API-16-009 | notification setup endpoints (PostgreSQL) › Web Push subscriptions (T-403) | refuses endpoints that are not a real push service (SSRF guard) and bad keys | ✓ |
| API-16-010 | notification setup endpoints (PostgreSQL) › Web Push subscriptions (T-403) | removes only the caller's own subscription | ✓ |
| API-16-011 | notification setup endpoints (PostgreSQL) › Web Push subscriptions (T-403) | is ADMIN only | ✓ |
| API-16-012 | notification setup endpoints (PostgreSQL) › test button | reports what happened on each channel | ✓ |
| API-16-013 | notification setup endpoints (PostgreSQL) › test button | reports a failing channel without leaking more than a short reason | ✓ |
| API-16-014 | notification setup endpoints (PostgreSQL) › test button | is ADMIN only | ✓ |

#### API-17 · `webpush-sender.test.ts` — notifications/webpush — createVapidSender

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-17-001 | createVapidSender | sends the payload to the subscription signed with the VAPID keys, short-lived and high priority | ✓ |
| API-17-002 | createVapidSender | lets the push service's error through so the caller can tell 'gone' (404/410) from a real failure | ✓ |

#### API-18 · `import-file.test.ts` — imports/file — อ่าน CSV/XLSX

อ้างอิง: F10 · DES-014

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-18-001 | reading an uploaded file | decides the type from the bytes, not the name | ✓ |
| API-18-002 | reading an uploaded file | reads a CSV (UTF-8, with and without BOM) with quoted commas and Windows line ends | ✓ |
| API-18-003 | reading an uploaded file | reads semicolon- and tab-separated files too | ✓ |
| API-18-004 | reading an uploaded file | reads Thai Excel's plain 'CSV' (Windows-874) instead of showing garbage | ✓ |
| API-18-005 | reading an uploaded file | reads an .xlsx: text, numbers and real date cells, in an isolated worker | ✓ |
| API-18-006 | reading an uploaded file | refuses the old .xls format, with advice | ✓ |
| API-18-007 | reading an uploaded file | refuses a corrupt .xlsx without crashing | ✓ |
| API-18-008 | reading an uploaded file | refuses a decompression bomb before inflating it | ✓ |
| API-18-009 | reading an uploaded file | refuses a zip with far too many parts | ✓ |
| API-18-010 | reading an uploaded file › a misbehaving parser is contained | an uncaught error inside the worker rejects the upload instead of crashing the server | ✓ |
| API-18-011 | reading an uploaded file › a misbehaving parser is contained | a worker that eats memory is stopped at its ceiling | ✓ |
| API-18-012 | reading an uploaded file › a misbehaving parser is contained | a worker that never answers is cut off after the time limit | ✓ |
| API-18-013 | reading an uploaded file › a misbehaving parser is contained | a worker that exits without an answer is reported, not awaited forever | ✓ |
| API-18-014 | reading an uploaded file | caps the number of rows | ✓ |
| API-18-015 | reading an uploaded file | treats garbage text as a CSV whose header will not match, never as a crash | ✓ |
| API-18-016 | checking the rows of the template (DES-014) | insists on the template header, in order, and nothing extra | ✓ |
| API-18-017 | checking the rows of the template (DES-014) | skips blank lines and reports spreadsheet row numbers (the header is row 1) | ✓ |
| API-18-018 | checking the rows of the template (DES-014) | tidies names: spaces collapsed and trimmed, composed Unicode | ✓ |
| API-18-019 | checking the rows of the template (DES-014) | accepts amounts as numbers, with thousands separators, currency marks | ✓ |
| API-18-020 | checking the rows of the template (DES-014) | refuses bad amounts with a reason | ✓ |
| API-18-021 | checking the rows of the template (DES-014) | treats a blank interest as 0, allows 0, refuses negatives and junk | ✓ |
| API-18-022 | checking the rows of the template (DES-014) | reads due dates written the ways people write them | ✓ |
| API-18-023 | checking the rows of the template (DES-014) | refuses dates that are impossible, out of range or not dates | ✓ |
| API-18-024 | checking the rows of the template (DES-014) | collects every problem of a row, and keeps good rows apart from bad ones | ✓ |
| API-18-025 | checking the rows of the template (DES-014) | rejects an over-long name | ✓ |

#### API-19 · `imports.test.ts` — imports/* — preview, confirm, rollback, ชื่อซ้ำ

อ้างอิง: F10 · DES-014

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-19-001 | importing contracts from a file (PostgreSQL) › template and access | serves the template: the header only, UTF-8 with a BOM | ✓ |
| API-19-002 | importing contracts from a file (PostgreSQL) › template and access | is ADMIN only on every endpoint | ✓ |
| API-19-003 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | checks every row, matches borrowers, and shows the late fee that would be back-dated | ✓ |
| API-19-004 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | lists invalid rows with their reasons and does not count them | ✓ |
| API-19-005 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | matches names exactly after tidying spaces, and the same name on many rows is one borrower | ✓ |
| API-19-006 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | reads an .xlsx with real date cells just like a CSV | ✓ |
| API-19-007 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | reads a Thai Windows 'CSV' (Windows-874) correctly | ✓ |
| API-19-008 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | cannot compute late fees until the rates are set, and says so | ✓ |
| API-19-009 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | flags a row whose back-dated late fee would overflow the system, instead of failing later | ✓ |
| API-19-010 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | refuses a file that is not the template, empty, not a file, too big, or the old .xls | ✓ |
| API-19-011 | importing contracts from a file (PostgreSQL) › preview (T-601): nothing is saved | refuses a decompression bomb disguised as .xlsx | ✓ |
| API-19-012 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | imports the rows as ACTIVE imported contracts and saves the late fee of the overdue one | ✓ |
| API-19-013 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | keeps the late-fee rate it saw at import: changing the Setting later changes nothing | ✓ |
| API-19-014 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | will not guess between several borrowers with the same name, and keeps the file so you can choose | ✓ |
| API-19-015 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | refuses to skip invalid rows silently, and imports only the valid ones when told to | ✓ |
| API-19-016 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | refuses a file with no valid row | ✓ |
| API-19-017 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | refuses while the rates are not set, saving nothing | ✓ |
| API-19-018 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | an unknown, malformed or already-used key imports nothing, and a second confirm cannot duplicate | ✓ |
| API-19-019 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | two confirms at the same moment import the file once | ✓ |
| API-19-020 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | is all or nothing: a failure part-way saves no borrower, no batch, no contract — and the file stays | ✓ |
| API-19-021 | importing contracts from a file (PostgreSQL) › confirming (T-602): one transaction, nothing trusted from the browser | numbers contracts continuously after the ones that already exist | ✓ |
| API-19-022 | importing contracts from a file (PostgreSQL) › batches and rollback (DES-014 §6) | lists the batches and whether each can still be undone | ✓ |
| API-19-023 | importing contracts from a file (PostgreSQL) › batches and rollback (DES-014 §6) | undoes a whole batch: contracts and late fees go, the batch is marked, the borrowers stay | ✓ |
| API-19-024 | importing contracts from a file (PostgreSQL) › batches and rollback (DES-014 §6) | refuses to undo once any contract of the batch has a payment, and deletes nothing | ✓ |
| API-19-025 | importing contracts from a file (PostgreSQL) › batches and rollback (DES-014 §6) | 404s for an unknown batch | ✓ |

#### API-20 · `import-storage.test.ts` — imports/storage — ไฟล์รอยืนยัน

อ้างอิง: F10 · DES-014

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-20-001 | import staging storage | accepts only keys it generates | ✓ |
| API-20-002 | import staging storage | stores, returns and deletes a file, creating the folder on demand | ✓ |
| API-20-003 | import staging storage | never overwrites, and never touches the disk for an invalid key | ✓ |
| API-20-004 | import staging storage | purges only old files that it created itself | ✓ |

#### API-21 · `admin-reset.test.ts` — scripts/admin-accounts — รีเซ็ตรหัสผ่านผู้ดูแล

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-21-001 | reset admin password script (PostgreSQL) | sets the new password, forces a change, and ends the admin's old sessions | ✓ |
| API-21-002 | reset admin password script (PostgreSQL) | writes a system audit row that never contains the password | ✓ |
| API-21-003 | reset admin password script (PostgreSQL) | only touches ADMIN accounts that exist, and changes nothing otherwise | ✓ |
| API-21-004 | reset admin password script (PostgreSQL) | enforces the password policy | ✓ |
| API-21-005 | reset admin password script (PostgreSQL) | reports an inactive admin without switching it on | ✓ |

#### API-22 · `audit.test.ts` — lib/audit — AuditLog ใน transaction เดียวกับการเปลี่ยนข้อมูล

อ้างอิง: F1 · F5

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-22-001 | toAuditJson | keeps Decimal exact as a string and Date as ISO | ✓ |
| API-22-002 | toAuditJson | drops undefined and returns null for null/undefined input | ✓ |
| API-22-003 | toAuditJson | redacts secrets at any depth but keeps harmless flags | ✓ |
| API-22-004 | bank account numbers in audit (decision D1) | keeps only the last 4 digits at any depth | ✓ |
| API-22-005 | bank account numbers in audit (decision D1) | leaves a null account number alone | ✓ |
| API-22-006 | buildAuditDetail | combines before, after and extra | ✓ |
| API-22-007 | buildAuditDetail | has only `before` for deletes and only `after` for creates | ✓ |
| API-22-008 | buildAuditDetail | is undefined when there is nothing to record | ✓ |
| API-22-009 | writeAuditLog (fake db) | writes one row with actor, action, entity and detail | ✓ |
| API-22-010 | writeAuditLog (fake db) | allows a system actor (null) | ✓ |
| API-22-011 | writeAuditLog (fake db) | rejects empty identifiers and reserved extra keys | ✓ |
| API-22-012 | writeAuditLog (PostgreSQL) | persists before/after JSON with a real actor and system actor | ✓ |
| API-22-013 | writeAuditLog (PostgreSQL) | rolls back with the surrounding transaction | ✓ |

#### API-23 · `auth-lib.test.ts` — lib/password, session — scrypt, นโยบายรหัสผ่าน, token

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-23-001 | password hashing | verifies the right password and rejects the wrong one | ✓ |
| API-23-002 | password hashing | salts every hash and never stores the plain password | ✓ |
| API-23-003 | password hashing | treats malformed stored hashes as a mismatch instead of throwing | ✓ |
| API-23-004 | password hashing | normalises Unicode so equivalent Thai/Latin input matches | ✓ |
| API-23-005 | password hashing | enforces the length policy | ✓ |
| API-23-006 | session tokens | round-trips the claims | ✓ |
| API-23-007 | session tokens | rejects a token signed with another secret or tampered with | ✓ |
| API-23-008 | session tokens | rejects alg=none and other algorithms | ✓ |
| API-23-009 | session tokens | expires after the session lifetime | ✓ |
| API-23-010 | session tokens | fingerprint changes when the password hash changes | ✓ |
| API-23-011 | cookies | parses a cookie header and ignores junk | ✓ |
| API-23-012 | cookies | keeps the first value when a name repeats | ✓ |
| API-23-013 | cookies | builds an HttpOnly, SameSite=Lax cookie, Secure only when asked | ✓ |
| API-23-014 | FailureLimiter | blocks after the maximum failures and frees after the window | ✓ |
| API-23-015 | FailureLimiter | keeps keys independent and reset clears a key | ✓ |

#### API-24 · `auth.test.ts` — auth/routes — login/logout/me/เปลี่ยนรหัส, cookie, สิทธิ์

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-24-001 | auth (PostgreSQL) › login | logs in, sets an HttpOnly session cookie and never returns the hash | ✓ |
| API-24-002 | auth (PostgreSQL) › login | gives the same answer for wrong password, unknown user and inactive user | ✓ |
| API-24-003 | auth (PostgreSQL) › login | rejects malformed bodies without touching credentials | ✓ |
| API-24-004 | auth (PostgreSQL) › login | locks a username after repeated failures, even for the right password | ✓ |
| API-24-005 | auth (PostgreSQL) › session | requires a valid cookie | ✓ |
| API-24-006 | auth (PostgreSQL) › session | stops working as soon as the user is deactivated | ✓ |
| API-24-007 | auth (PostgreSQL) › session | logout clears the cookie | ✓ |
| API-24-008 | auth (PostgreSQL) › roles (lib:authz) | lets a role in and keeps the others out | ✓ |
| API-24-009 | auth (PostgreSQL) › roles (lib:authz) | exposes the borrowerId from the session user, never from the client | ✓ |
| API-24-010 | auth (PostgreSQL) › mustChangePassword and change-password | blocks business routes until the password is changed | ✓ |
| API-24-011 | auth (PostgreSQL) › mustChangePassword and change-password | rejects weak, wrong-current and unchanged passwords | ✓ |

#### API-25 · `borrowers.test.ts` — borrowers/* — สร้าง/แก้ผู้ยืม, บัญชี, ข้อมูลส่วนบุคคลเข้ารหัส

อ้างอิง: F1 · F8

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-25-001 | admin borrower management (PostgreSQL) › access | is for ADMIN only | ✓ |
| API-25-002 | admin borrower management (PostgreSQL) › create | creates the login and the borrower, returns the bank account to the admin only | ✓ |
| API-25-003 | admin borrower management (PostgreSQL) › create | stores the account number encrypted, never in plain text (decision D1) | ✓ |
| API-25-004 | admin borrower management (PostgreSQL) › create | keeps only the last 4 digits in the audit log, and says which fields changed | ✓ |
| API-25-005 | admin borrower management (PostgreSQL) › create | lets the new borrower log in and forces a password change | ✓ |
| API-25-006 | admin borrower management (PostgreSQL) › create | writes an audit row without any password | ✓ |
| API-25-007 | admin borrower management (PostgreSQL) › create | requires every field the admin page must collect | ✓ |
| API-25-008 | admin borrower management (PostgreSQL) › create | rejects weak passwords and malformed phone, account number and username | ✓ |
| API-25-009 | admin borrower management (PostgreSQL) › create | rejects a username that exists, ignoring case, and creates nothing | ✓ |
| API-25-010 | admin borrower management (PostgreSQL) › create | allows two different borrowers with the same full name | ✓ |
| API-25-011 | admin borrower management (PostgreSQL) › list and get | lists, searches by name, paginates, and shows imported borrowers without an account | ✓ |
| API-25-012 | admin borrower management (PostgreSQL) › list and get | returns one borrower or 404 | ✓ |
| API-25-013 | admin borrower management (PostgreSQL) › update | changes only the given fields and audits before/after | ✓ |
| API-25-014 | admin borrower management (PostgreSQL) › update | rejects empty updates, nulls and bad values without writing anything | ✓ |
| API-25-015 | admin borrower management (PostgreSQL) › update | can fill in the details of an imported borrower | ✓ |
| API-25-016 | admin borrower management (PostgreSQL) › deactivate and reactivate | blocks login and kills the live session, and can be undone | ✓ |
| API-25-017 | admin borrower management (PostgreSQL) › deactivate and reactivate | rejects bad input and borrowers with no account | ✓ |
| API-25-018 | admin borrower management (PostgreSQL) › reset password | sets a temporary password, forces a change and ends old sessions | ✓ |
| API-25-019 | admin borrower management (PostgreSQL) › reset password | rejects weak passwords and borrowers with no account | ✓ |
| API-25-020 | admin borrower management (PostgreSQL) › borrower scope (lib:borrower-scope) | uses the session borrower and refuses a borrowerId sent by the client | ✓ |

#### API-26 · `field-crypto.test.ts` — lib/field-crypto — AES-GCM เข้ารหัสฟิลด์

อ้างอิง: F1 · PDPA

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-26-001 | FieldCipher | round-trips values, including Thai text and digits with dashes | ✓ |
| API-26-002 | FieldCipher | never stores the plaintext and uses a fresh IV every time | ✓ |
| API-26-003 | FieldCipher | rejects tampered ciphertext, tag or IV | ✓ |
| API-26-004 | FieldCipher | cannot be read with another key | ✓ |
| API-26-005 | FieldCipher | refuses to treat a plain or malformed value as encrypted | ✓ |
| API-26-006 | FieldCipher | requires a 32-byte key | ✓ |
| API-26-007 | maskAccountNumber | keeps only the last 4 digits | ✓ |
| API-26-008 | maskAccountNumber | hides short values entirely | ✓ |

#### API-27 · `login-throttle.test.ts` — auth/throttle — จำกัดการเดารหัสผ่าน

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-27-001 | login throttling (PostgreSQL) | stops a guesser on their own IP without locking the real owner out | ✓ |
| API-27-002 | login throttling (PostgreSQL) | still bounds a guess spread over many IPs with a higher per-username ceiling | ✓ |
| API-27-003 | login throttling (PostgreSQL) | does not let a successful login wipe the per-username ceiling | ✓ |
| API-27-004 | login throttling (PostgreSQL) | a success clears the counter of that username and IP only | ✓ |
| API-27-005 | login throttling (PostgreSQL) | ignores X-Forwarded-For when no proxy is trusted, so it cannot be spoofed to dodge the limit | ✓ |
| API-27-006 | login throttling (PostgreSQL) | limits password spraying from one IP across different usernames | ✓ |
| API-27-007 | login throttling (PostgreSQL) | throttles wrong current-password guesses on change-password | ✓ |

#### API-28 · `pdpa.test.ts` — pdpa/* — ความยินยอม, เวอร์ชันข้อความ

อ้างอิง: F1 · PDPA

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-28-001 | PDPA gate (PostgreSQL) | keeps a borrower who has not accepted out of every borrower endpoint | ✓ |
| API-28-002 | PDPA gate (PostgreSQL) | reports the status on /pdpa and /auth/me | ✓ |
| API-28-003 | PDPA gate (PostgreSQL) | records time and version on acceptance and then opens the borrower endpoints | ✓ |
| API-28-004 | PDPA gate (PostgreSQL) | accepting again does not overwrite the original time or version | ✓ |
| API-28-005 | PDPA gate (PostgreSQL) | rejects a missing or stale version and does not record anything | ✓ |
| API-28-006 | PDPA gate (PostgreSQL) | only ever changes the logged-in borrower, ignoring ids from the client | ✓ |
| API-28-007 | PDPA gate (PostgreSQL) | requires login and a BORROWER account with a borrower profile | ✓ |
| API-28-008 | PDPA gate (PostgreSQL) | still requires the first password change before the PDPA step | ✓ |

#### API-29 · `submissions.test.ts` — loans/submissions, calendar — ผู้ยืมส่งสลิป admin ยืนยัน, ปฏิทิน

อ้างอิง: F5-CR1 · F11 · DES-017 · DES-018

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-29-001 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | records a CLAIM with the slip, answers with the status only, and changes no balance | ✓ |
| API-29-002 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | decides the file type from its bytes: a JPEG is accepted whatever the client calls it | ✓ |
| API-29-003 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | refuses anything that is not a JPEG or PNG image, and writes nothing | ✓ |
| API-29-004 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | refuses a file over the size limit | ✓ |
| API-29-005 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | checks the amount, the date and the note | ✓ |
| API-29-006 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | works only on an open contract that belongs to the borrower | ✓ |
| API-29-007 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | needs a logged-in borrower who accepted the PDPA terms, and the borrower is never named by the client | ✓ |
| API-29-008 | borrower payment slips (CR-1, PostgreSQL) › sending a slip | caps the claims waiting at once, even when they arrive in parallel | ✓ |
| API-29-009 | borrower payment slips (CR-1, PostgreSQL) › what the borrower can see | lists only their own claims, with no slip key and no one else's data | ✓ |
| API-29-010 | borrower payment slips (CR-1, PostgreSQL) › what the borrower can see | a borrower can never open the slip (slips are ADMIN-only), not even their own | ✓ |
| API-29-011 | borrower payment slips (CR-1, PostgreSQL) › the admin's queue | lists claims oldest first with the slip key, filtered by status or contract, for ADMIN only | ✓ |
| API-29-012 | borrower payment slips (CR-1, PostgreSQL) › confirming | records a REAL payment through the ledger and marks the claim confirmed, together | ✓ |
| API-29-013 | borrower payment slips (CR-1, PostgreSQL) › confirming | lets the admin correct the amount, date and note before confirming (the claim is only a claim) | ✓ |
| API-29-014 | borrower payment slips (CR-1, PostgreSQL) › confirming | if the ledger refuses (more than is owed) NOTHING changes and the claim keeps waiting | ✓ |
| API-29-015 | borrower payment slips (CR-1, PostgreSQL) › confirming | refuses a date before the payout, and a contract that closed in the meantime, leaving the claim waiting | ✓ |
| API-29-016 | borrower payment slips (CR-1, PostgreSQL) › confirming | a claim is decided exactly once, even when two admins press the button together | ✓ |
| API-29-017 | borrower payment slips (CR-1, PostgreSQL) › confirming | validates the corrections and the id, and is ADMIN only | ✓ |
| API-29-018 | borrower payment slips (CR-1, PostgreSQL) › confirming | deleting the payment later keeps the claim as confirmed history (the link is just cleared) | ✓ |
| API-29-019 | borrower payment slips (CR-1, PostgreSQL) › rejecting | needs a reason, records it, and shows it to the borrower | ✓ |
| API-29-020 | borrower payment slips (CR-1, PostgreSQL) › rejecting | a decided claim cannot be decided again, and a rejected one frees a place under the limit | ✓ |
| API-29-021 | borrower payment slips (CR-1, PostgreSQL) › rejecting | is ADMIN only and answers 404 for an unknown id | ✓ |
| API-29-022 | borrower payment slips (CR-1, PostgreSQL) › telling the admin | sends one message when a slip arrives, naming the borrower, the contract and the amount | ✓ |
| API-29-023 | borrower payment slips (CR-1, PostgreSQL) › telling the admin | sends nothing for a refused upload, and nothing about a claim that is no longer waiting | ✓ |
| API-29-024 | borrower payment slips (CR-1, PostgreSQL) › the admin calendar | puts each contract on its due date and each payment on the day it was paid | ✓ |
| API-29-025 | borrower payment slips (CR-1, PostgreSQL) › the admin calendar | shows what is still owed on an open contract and nothing owed on a settled one, and sums them with the ledger's own numbers | ✓ |
| API-29-026 | borrower payment slips (CR-1, PostgreSQL) › the admin calendar | flags a contract past its due date, in the month of its due date | ✓ |
| API-29-027 | borrower payment slips (CR-1, PostgreSQL) › the admin calendar | does not list contracts that were never paid out, or cancelled | ✓ |
| API-29-028 | borrower payment slips (CR-1, PostgreSQL) › the admin calendar | defaults to the current month, validates the month, and is ADMIN only | ✓ |
| API-29-029 | borrower payment slips (CR-1, PostgreSQL) › the admin calendar | a month with nothing in it is simply empty | ✓ |

#### API-30 · `borrower-portal.test.ts` — borrower/portal — ผู้ยืมเห็นเฉพาะของตน

อ้างอิง: F8

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-30-001 | borrower portal (PostgreSQL) | shows the borrower their own profile, including their own account number (decrypted) | ✓ |
| API-30-002 | borrower portal (PostgreSQL) | lists only the borrower's own requests with their status, and never the internal reject reason | ✓ |
| API-30-003 | borrower portal (PostgreSQL) › contracts | lists only the borrower's own contracts | ✓ |
| API-30-004 | borrower portal (PostgreSQL) › contracts | shows NO amount owed before the money is paid out, nor for a cancelled contract | ✓ |
| API-30-005 | borrower portal (PostgreSQL) › contracts | shows what is owed today, the due date and the accrued late fee once it is paid out | ✓ |
| API-30-006 | borrower portal (PostgreSQL) › contracts | returns the history of one contract: the payout and every payment | ✓ |
| API-30-007 | borrower portal (PostgreSQL) › contracts | has no history to show for a contract that has not been paid out | ✓ |
| API-30-008 | borrower portal (PostgreSQL) › contracts | never exposes slips, who recorded what, admin notes, rates or import details | ✓ |
| API-30-009 | borrower portal (PostgreSQL) › contracts | answers 'not found' for another borrower's contract, exactly as for one that does not exist | ✓ |
| API-30-010 | borrower portal (PostgreSQL) › access | each borrower sees only their own data | ✓ |
| API-30-011 | borrower portal (PostgreSQL) › access | refuses anyone who is not logged in, an admin, or a borrower who has not accepted the PDPA terms | ✓ |
| API-30-012 | borrower portal (PostgreSQL) › access | refuses a borrowerId sent by the client, so the session is the only source | ✓ |
| API-30-013 | borrower portal (PostgreSQL) › access | stops working as soon as the account is switched off | ✓ |

#### API-31 · `reports.test.ts` — reports/* — กำไรขาดทุน, ยอดค้าง, ผู้ชำระช้า

อ้างอิง: F9 · DES-015

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-31-001 | parsePeriod | understands a month, a year and a custom range, both ends included | ✓ |
| API-31-002 | parsePeriod | means all time when nothing is given | ✓ |
| API-31-003 | parsePeriod | rejects malformed, impossible, mixed or oversized periods | ✓ |
| API-31-004 | reports (PostgreSQL) › profit and loss (T-501) | shows the cash and accrual bases side by side for a year | ✓ |
| API-31-005 | reports (PostgreSQL) › profit and loss (T-501) | matches the payments in the database exactly (cash basis = allocated interest + late fee) | ✓ |
| API-31-006 | reports (PostgreSQL) › profit and loss (T-501) | recognises interest in full on the due date even if only part was paid (accrual vs cash differ) | ✓ |
| API-31-007 | reports (PostgreSQL) › profit and loss (T-501) | filters by month | ✓ |
| API-31-008 | reports (PostgreSQL) › profit and loss (T-501) | counts a payment made on the last day of the period and on the first | ✓ |
| API-31-009 | reports (PostgreSQL) › profit and loss (T-501) | never counts contracts that were not paid out or were cancelled | ✓ |
| API-31-010 | reports (PostgreSQL) › profit and loss (T-501) | does not recognise interest before its due date has arrived | ✓ |
| API-31-011 | reports (PostgreSQL) › profit and loss (T-501) | is zero for a period with no activity, and works for all time | ✓ |
| API-31-012 | reports (PostgreSQL) › late payers (T-502) | ranks borrowers by how many contracts were late, counting unpaid overdue ones | ✓ |
| API-31-013 | reports (PostgreSQL) › late payers (T-502) | counts per contract: two late contracts of one borrower count twice | ✓ |
| API-31-014 | reports (PostgreSQL) › late payers (T-502) | filters by the period the contracts fall due in | ✓ |
| API-31-015 | reports (PostgreSQL) › late payers (T-502) | breaks ties by name, and pages | ✓ |
| API-31-016 | reports (PostgreSQL) › late payers (T-502) | rejects a bad period or page | ✓ |
| API-31-017 | reports (PostgreSQL) › outstanding balance (T-502) | is what is owed on the contracts open on that day, replayed from their own history | ✓ |
| API-31-018 | reports (PostgreSQL) › outstanding balance (T-502) | uses only the payments made up to that day | ✓ |
| API-31-019 | reports (PostgreSQL) › outstanding balance (T-502) | counts an imported contract only from the day it was imported | ✓ |
| API-31-020 | reports (PostgreSQL) › outstanding balance (T-502) | reports a contract whose history breaks a rule instead of hiding it | ✓ |
| API-31-021 | reports (PostgreSQL) › outstanding balance (T-502) | rejects a future or malformed date | ✓ |
| API-31-022 | reports (PostgreSQL) › borrower summary (T-502) | counts loans, late contracts, on-time payments, the on-time rate and what is owed | ✓ |
| API-31-023 | reports (PostgreSQL) › borrower summary (T-502) | leaves out contracts that were never paid out or were cancelled | ✓ |
| API-31-024 | reports (PostgreSQL) › borrower summary (T-502) | filters by period | ✓ |
| API-31-025 | reports (PostgreSQL) › borrower summary (T-502) | has no verdict yet for a contract that is not due: neither on time nor late | ✓ |
| API-31-026 | reports (PostgreSQL) › borrower summary (T-502) | pages and rejects bad input | ✓ |
| API-31-027 | reports (PostgreSQL) › access | is ADMIN only on every report | ✓ |
| API-31-028 | reports (PostgreSQL) › access | returns 400 with a reason for an invalid period | ✓ |

#### API-32 · `disbursement.test.ts` — loans/disbursement — บันทึกจ่ายเงิน, สลิปบังคับ, snapshot อัตรา

อ้างอิง: F4 · F5 · DES-010 · DES-011

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-32-001 | disbursement (PostgreSQL) | pays out in full, computes the interest and makes the contract ACTIVE | ✓ |
| API-32-002 | disbursement (PostgreSQL) | rounds interest UP to a whole baht, never down or to nearest | ✓ |
| API-32-003 | disbursement (PostgreSQL) | counts days from the payout date, so a backdated payout earns more interest | ✓ |
| API-32-004 | disbursement (PostgreSQL) | snapshots the rates: changing them later never touches an existing contract | ✓ |
| API-32-005 | disbursement (PostgreSQL) | refuses to pay out while either rate is not set | ✓ |
| API-32-006 | disbursement (PostgreSQL) | requires a slip that we stored | ✓ |
| API-32-007 | disbursement (PostgreSQL) | does not let one slip justify two payouts | ✓ |
| API-32-008 | disbursement (PostgreSQL) | pays out exactly what was asked: an amount that differs is refused, a matching one is fine | ✓ |
| API-32-009 | disbursement (PostgreSQL) | rejects a payout date in the future and a due date that is not after the payout date | ✓ |
| API-32-010 | disbursement (PostgreSQL) | allows only one payout per contract, even when two arrive at the same moment | ✓ |
| API-32-011 | disbursement (PostgreSQL) | only works on contracts waiting for disbursement | ✓ |
| API-32-012 | disbursement (PostgreSQL) | cannot cancel a contract once it has been paid out | ✓ |
| API-32-013 | disbursement (PostgreSQL) | refuses a payout on or after the due date (the interest would have no days) and changes nothing | ✓ |
| API-32-014 | disbursement (PostgreSQL) | is ADMIN only | ✓ |
| API-32-015 | disbursement (PostgreSQL) | validates the body | ✓ |
| API-32-016 | disbursement (PostgreSQL) | writes an audit row with the interest, days and rates used | ✓ |

#### API-33 · `ledger.test.ts` — loans/ledger, payments — รับชำระ แก้ ลบ replay สัญญา

อ้างอิง: F5 · F6 · DES-011 · DES-012 · DES-016

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-33-001 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | takes a part payment before the due date: interest first, the interest never shrinks | ✓ |
| API-33-002 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | pays off a contract on its due date with no late fee at all | ✓ |
| API-33-003 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | catches up the days the nightly job has not run: 1 % a day compounding, rounded up | ✓ |
| API-33-004 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | a payment dated earlier lowers the base of every later day (back-dated, 'owed now') | ✓ |
| API-33-005 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | removes the fee rows of days that no longer apply when a back-dated payment closes the contract earlier | ✓ |
| API-33-006 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | settling an overdue contract counts today's fee, then closes it | ✓ |
| API-33-007 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | refuses to pay more than is owed and saves nothing | ✓ |
| API-33-008 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | rejects dates in the future and before the payout | ✓ |
| API-33-009 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | validates the body | ✓ |
| API-33-010 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | only takes payments for contracts that are paid out and not yet closed | ✓ |
| API-33-011 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | is ADMIN only | ✓ |
| API-33-012 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | records who did it and the contract before/after in the audit log | ✓ |
| API-33-013 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | lets only one of several simultaneous full payments through | ✓ |
| API-33-014 | payments, late fees, edits, deletes and queries (PostgreSQL) › recording a payment (T-303) | refuses a back-dated payment that would make a later payment exceed what is owed | ✓ |
| API-33-015 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | edits the amount and the whole contract is replayed | ✓ |
| API-33-016 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | moves a payment to another day and fees follow | ✓ |
| API-33-017 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | changing only the note leaves every number alone | ✓ |
| API-33-018 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | refuses an edit that overpays, and an edit that breaks another payment, saving nothing | ✓ |
| API-33-019 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | refuses a date in the future or before the payout | ✓ |
| API-33-020 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | deletes a payment, restoring the balances a fresh replay gives | ✓ |
| API-33-021 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | reopens a closed contract when the closing payment is deleted, and fees run again | ✓ |
| API-33-022 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | deleting an earlier payment can reopen a contract that a later payment had closed | ✓ |
| API-33-023 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | 404s for unknown payments and is ADMIN only | ✓ |
| API-33-024 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payment (T-305) | rejects an empty or invalid patch | ✓ |
| API-33-025 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payout (T-305) | moving the payout date recomputes the interest with the contract's own rate, not today's | ✓ |
| API-33-026 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payout (T-305) | refuses a payout date after an existing payment, a date too close to the due date or in the future | ✓ |
| API-33-027 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payout (T-305) | refuses to move the payout date onto or after the due date, and keeps the interest as it was | ✓ |
| API-33-028 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payout (T-305) | replaces the slip with another stored, unused slip, and refuses others | ✓ |
| API-33-029 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payout (T-305) | deletes a payout only when there are no payments, and the contract goes back to waiting | ✓ |
| API-33-030 | payments, late fees, edits, deletes and queries (PostgreSQL) › editing and deleting a payout (T-305) | 404s for unknown payouts and is ADMIN only | ✓ |
| API-33-031 | payments, late fees, edits, deletes and queries (PostgreSQL) › admin contract queries (T-306) | shows what is owed TODAY even when the nightly job has not run | ✓ |
| API-33-032 | payments, late fees, edits, deletes and queries (PostgreSQL) › admin contract queries (T-306) | lists the payout and every payment of a contract | ✓ |
| API-33-033 | payments, late fees, edits, deletes and queries (PostgreSQL) › admin contract queries (T-306) | computes overdue and late flags and never stores them | ✓ |
| API-33-034 | payments, late fees, edits, deletes and queries (PostgreSQL) › admin contract queries (T-306) | lists with filters, search, sorting and paging | ✓ |
| API-33-035 | payments, late fees, edits, deletes and queries (PostgreSQL) › admin contract queries (T-306) | shows no amount owed for a contract still waiting for its payout | ✓ |
| API-33-036 | payments, late fees, edits, deletes and queries (PostgreSQL) › admin contract queries (T-306) | 404s for unknown contracts and is ADMIN only | ✓ |

#### API-34 · `loans.test.ts` — loans/* — คำขอยืม, อนุมัติ, สัญญา, สิทธิ์

อ้างอิง: F3 · F4 · DES-004–006

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-34-001 | loan requests and contracts (PostgreSQL) › borrower files a request | creates a PENDING request for the session's own borrower | ✓ |
| API-34-002 | loan requests and contracts (PostgreSQL) › borrower files a request | never takes the borrower from the client | ✓ |
| API-34-003 | loan requests and contracts (PostgreSQL) › borrower files a request | requires a due date after today (Asia/Bangkok) | ✓ |
| API-34-004 | loan requests and contracts (PostgreSQL) › borrower files a request | rejects bad amounts and dates | ✓ |
| API-34-005 | loan requests and contracts (PostgreSQL) › borrower files a request | accepts the largest amount the column holds | ✓ |
| API-34-006 | loan requests and contracts (PostgreSQL) › borrower files a request | is closed to anyone who is not a borrower who accepted the PDPA terms | ✓ |
| API-34-007 | loan requests and contracts (PostgreSQL) › admin files a request on behalf of a borrower | works, including for a borrower who has no login | ✓ |
| API-34-008 | loan requests and contracts (PostgreSQL) › admin files a request on behalf of a borrower | rejects an unknown borrower and a past due date | ✓ |
| API-34-009 | loan requests and contracts (PostgreSQL) › admin files a request on behalf of a borrower | is closed to borrowers and anonymous callers | ✓ |
| API-34-010 | loan requests and contracts (PostgreSQL) › list and get | filters by borrower and status and paginates | ✓ |
| API-34-011 | loan requests and contracts (PostgreSQL) › list and get | returns one request or 404 | ✓ |
| API-34-012 | loan requests and contracts (PostgreSQL) › approve | creates a contract waiting for disbursement, with no amount owed shown yet | ✓ |
| API-34-013 | loan requests and contracts (PostgreSQL) › approve | lets the admin approve a request the admin filed (no separation of duties) | ✓ |
| API-34-014 | loan requests and contracts (PostgreSQL) › approve | approves a request once only | ✓ |
| API-34-015 | loan requests and contracts (PostgreSQL) › approve | creates exactly one contract when the same request is approved twice at once | ✓ |
| API-34-016 | loan requests and contracts (PostgreSQL) › approve | gives distinct contract numbers when different requests are approved at once | ✓ |
| API-34-017 | loan requests and contracts (PostgreSQL) › approve | is closed to borrowers | ✓ |
| API-34-018 | loan requests and contracts (PostgreSQL) › reject and cancel a request | rejects with a reason and creates no contract | ✓ |
| API-34-019 | loan requests and contracts (PostgreSQL) › reject and cancel a request | cannot reject or cancel what is already decided | ✓ |
| API-34-020 | loan requests and contracts (PostgreSQL) › reject and cancel a request | cancels a pending request | ✓ |
| API-34-021 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | cancels a pending request and records who did it | ✓ |
| API-34-022 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | also covers a request the admin filed for that borrower | ✓ |
| API-34-023 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | cannot touch another borrower's request, and does not reveal that it exists | ✓ |
| API-34-024 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | works only while the request is pending | ✓ |
| API-34-025 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | leaves the admin unable to approve it afterwards | ✓ |
| API-34-026 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | ends consistent when the borrower cancels while the admin approves | ✓ |
| API-34-027 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | is closed to anyone who is not a borrower who accepted the PDPA terms | ✓ |
| API-34-028 | loan requests and contracts (PostgreSQL) › borrower cancels their own request (P2) | refuses a borrowerId in the request | ✓ |
| API-34-029 | loan requests and contracts (PostgreSQL) › cancel a contract (DES-005) | cancels a contract that is still waiting for disbursement | ✓ |
| API-34-030 | loan requests and contracts (PostgreSQL) › cancel a contract (DES-005) | refuses once a Disbursement exists, leaving the contract untouched | ✓ |
| API-34-031 | loan requests and contracts (PostgreSQL) › cancel a contract (DES-005) | is for ADMIN only and 404s on unknown ids | ✓ |

#### API-35 · `slips.test.ts` — lib/slip-storage + route — เก็บ/เปิดสลิป เฉพาะ ADMIN

อ้างอิง: F5 · DES-011

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| API-35-001 | detectSlipType | recognises JPEG and PNG by their bytes | ✓ |
| API-35-002 | detectSlipType | rejects everything else, whatever it is called | ✓ |
| API-35-003 | slip keys | accepts only keys we generate | ✓ |
| API-35-004 | slip keys | are random and never repeat | ✓ |
| API-35-005 | LocalDiskSlipStorage | stores and returns bytes, creating the folder on demand | ✓ |
| API-35-006 | LocalDiskSlipStorage | never overwrites an existing slip | ✓ |
| API-35-007 | LocalDiskSlipStorage | answers null/false for unknown keys and refuses to touch the disk for invalid ones | ✓ |
| API-35-008 | slip upload and download (PostgreSQL) | stores an uploaded JPEG under a server-chosen key and serves the same bytes back | ✓ |
| API-35-009 | slip upload and download (PostgreSQL) | accepts PNG too, and the same bytes never get the same key twice | ✓ |
| API-35-010 | slip upload and download (PostgreSQL) | decides the type from the bytes, not from what the client claims | ✓ |
| API-35-011 | slip upload and download (PostgreSQL) | rejects empty bodies and JSON bodies as 'no file' | ✓ |
| API-35-012 | slip upload and download (PostgreSQL) | refuses files over the size limit (413) | ✓ |
| API-35-013 | slip upload and download (PostgreSQL) | is ADMIN only for both upload and download | ✓ |
| API-35-014 | slip upload and download (PostgreSQL) | answers 404 for unknown keys and path-traversal attempts | ✓ |

## 4. เทสต์เว็บ (`web/test`)

### สรุปตามส่วนงาน

| ส่วนงาน | ไฟล์เทสต์ | อ้างอิง | สิ่งที่ถูกทดสอบ | จำนวนเคส |
|---|---|---|---|---|
| การตรวจข้อมูลฟอร์ม | `report-period.test.ts` | F9 | lib/report-period — เลือกช่วงรายงาน | 8 |
| การตรวจข้อมูลฟอร์ม | `validation.test.ts` | F1 · F3 | lib/validation — กฎเดียวกับ API | 11 |
| การเรียก API | `api.test.ts` | — | lib/api — fetch, ตรวจ schema, ข้อความผิดพลาดไทย | 10 |
| การแสดงผลเงิน/วันที่ | `money.test.ts` | F4 · F6 | lib/money — formatBaht, checkMoney, วันที่ไทย | 10 |
| คอมโพเนนต์กลาง | `ui.test.tsx` | A11y | components/ui — ปุ่ม ช่องกรอก Alert Badge Card Icon | 22 |
| เครื่องมือชั่วคราว (dev-tools) | `dev-tests.test.tsx` | DEV-TOOLS | components/devtests — หน้ารันเทสต์ในเว็บ (จะเอาออกก่อน deploy จริง) | 15 |
| แจ้งเตือน | `notifications.test.tsx` | F7 | หน้าตั้งค่าแจ้งเตือน LINE/Push | 27 |
| นำเข้าข้อมูล | `imports.test.tsx` | F10 | หน้านำเข้าข้อมูล | 27 |
| ผู้ยืมแจ้งชำระ | `payment-submissions.test.tsx` | F5-CR1 · DES-017 | ผู้ยืมส่งสลิป / admin ตรวจและยืนยัน | 24 |
| พอร์ทัลผู้ยืม | `borrower-portal.test.tsx` | F3 · F8 | หน้าผู้ยืม: สัญญา ขอยืม | 21 |
| รายงาน | `period-picker.test.tsx` | F9 | components/reports/PeriodPicker | 6 |
| รายงาน | `reports.test.tsx` | F9 · DES-015 | หน้ารายงาน — แสดงตัวเลขจาก API ตามที่ได้รับ | 19 |
| สิทธิ์และเมนู | `access.test.ts` | F1 | lib/access — หน้าที่แต่ละบทบาทเข้าได้ | 34 |
| สิทธิ์และเมนู | `app-shell.test.tsx` | F1 | components/AppShell — เมนูตามบทบาท, ออกจากระบบ | 8 |
| สิทธิ์และเมนู | `gate-and-pages.test.tsx` | F1 | layouts, login, PDPA, เปลี่ยนรหัสผ่าน, หน้าแรก | 26 |
| สิทธิ์และเมนู | `gate.test.tsx` | F1 | components/Gate — ป้องกันหน้า, ลองใหม่เมื่อเชื่อมต่อไม่ได้ | 6 |
| สิทธิ์และเมนู | `session-store.test.ts` | F1 | lib/session-store — สถานะผู้ใช้ | 9 |
| หน้า admin | `admin-borrowers.test.tsx` | F1 · F8 | หน้าผู้ยืม | 23 |
| หน้า admin | `admin-contracts.test.tsx` | F4 | หน้ารายการสัญญา | 6 |
| หน้า admin | `admin-ledger.test.tsx` | F4 · F5 · DES-016 | หน้าสัญญา: จ่ายเงิน รับชำระ แก้/ลบ | 38 |
| หน้า admin | `admin-requests.test.tsx` | F3 | หน้าคำขอยืม | 17 |
| หน้า admin | `admin-settings.test.tsx` | F2 | หน้าตั้งอัตรา | 12 |
| หน้า admin | `calendar.test.tsx` | F11 · DES-018 | ปฏิทิน admin | 14 |
| PWA | `manifest.test.ts` | F7 | manifest.webmanifest + ไอคอน | 4 |
| PWA | `next-config.test.ts` | Security | next.config — header ความปลอดภัย, proxy | 5 |
| PWA | `register-sw.test.tsx` | F7 | components/RegisterServiceWorker | 5 |
| PWA | `service-worker.test.ts` | F7 | public/sw.js — offline, push, notificationclick | 14 |
| **รวม** | 27 ไฟล์ | | | **421** |

### รายการเคสทั้งหมด

#### WEB-01 · `report-period.test.ts` — lib/report-period — เลือกช่วงรายงาน

อ้างอิง: F9

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-01-001 | buildPeriodQuery | all time has no filter | ✓ |
| WEB-01-002 | buildPeriodQuery | a month, a year, or a range becomes the query the API reads | ✓ |
| WEB-01-003 | buildPeriodQuery | a range may be a single day (both ends included) | ✓ |
| WEB-01-004 | buildPeriodQuery | explains a month or year that is not valid | ✓ |
| WEB-01-005 | buildPeriodQuery | explains a range that is incomplete, backwards, not a real day, or far too long | ✓ |
| WEB-01-006 | buildPeriodQuery | every message is Thai | ✓ |
| WEB-01-007 | defaultSelection | starts on the current month in Thailand | ✓ |
| WEB-01-008 | periodLabel | writes the period in Thai Buddhist Era | ✓ |

#### WEB-02 · `validation.test.ts` — lib/validation — กฎเดียวกับ API

อ้างอิง: F1 · F3

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-02-001 | checkPassword | accepts 10 to 128 characters | ✓ |
| WEB-02-002 | checkPassword | rejects shorter and longer | ✓ |
| WEB-02-003 | checkUsername | rejects empty, spaces inside and over 64 characters | ✓ |
| WEB-02-004 | phone and account | matches the API patterns | ✓ |
| WEB-02-005 | rates | accepts up to 3 integer and 4 decimal digits, never negative | ✓ |
| WEB-02-006 | rates | normalises equal numbers to one spelling | ✓ |
| WEB-02-007 | maskAccount | keeps only the last four digits | ✓ |
| WEB-02-008 | maskAccount | hides short numbers entirely and handles null | ✓ |
| WEB-02-009 | generatePassword | makes passwords the API accepts, from an alphabet without look-alike characters | ✓ |
| WEB-02-010 | generatePassword | is random | ✓ |
| WEB-02-011 | generatePassword | does not use biased bytes (values at or above the cut-off are skipped) | ✓ |

#### WEB-03 · `api.test.ts` — lib/api — fetch, ตรวจ schema, ข้อความผิดพลาดไทย

อ้างอิง: —

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-03-001 | apiFetch | calls the same-origin /api path with the cookie and JSON body | ✓ |
| WEB-03-002 | apiFetch | returns only data that matches the contract | ✓ |
| WEB-03-003 | apiFetch | refuses a response that breaks the contract instead of using it | ✓ |
| WEB-03-004 | apiFetch | turns an API error into ApiError with the API's Thai message | ✓ |
| WEB-03-005 | apiFetch | uses a Thai generic message when the error is not JSON | ✓ |
| WEB-03-006 | apiFetch | reports a network failure in Thai | ✓ |
| WEB-03-007 | apiFetch | never shows raw error text of unknown failures | ✓ |
| WEB-03-008 | apiFetch | tells the session store when the session is gone (401 UNAUTHENTICATED only) | ✓ |
| WEB-03-009 | apiFetch | accepts an empty 204 reply | ✓ |
| WEB-03-010 | apiFetch | sends a chosen file as the raw body with its own content type (a slip image) | ✓ |

#### WEB-04 · `money.test.ts` — lib/money — formatBaht, checkMoney, วันที่ไทย

อ้างอิง: F4 · F6

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-04-001 | formatBaht (text only, never a float) | groups thousands, shows whole baht without decimals and satang with two | ✓ |
| WEB-04-002 | formatBaht (text only, never a float) | is exact for amounts a float would corrupt | ✓ |
| WEB-04-003 | formatBaht (text only, never a float) | handles missing and odd values without inventing a number | ✓ |
| WEB-04-004 | isZeroMoney | is true only when every digit is zero | ✓ |
| WEB-04-005 | checkMoney | accepts positive amounts with up to two decimals | ✓ |
| WEB-04-006 | checkMoney | rejects empty, zero, negative, too many decimals, too many digits, text | ✓ |
| WEB-04-007 | checkMoney | names the field in Thai | ✓ |
| WEB-04-008 | dates | knows real calendar days | ✓ |
| WEB-04-009 | dates | today is the day in Thailand, whatever the phone's time zone | ✓ |
| WEB-04-010 | dates | shows a day in Thai Buddhist Era without time-zone drift | ✓ |

#### WEB-05 · `ui.test.tsx` — components/ui — ปุ่ม ช่องกรอก Alert Badge Card Icon

อ้างอิง: A11y

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-05-001 | Button | is a button that does not submit a form unless told to, and runs onClick | ✓ |
| WEB-05-002 | Button | submits a form when it is type=submit | ✓ |
| WEB-05-003 | Button | does nothing while disabled | ✓ |
| WEB-05-004 | Button | has a primary, secondary and danger look that differ, and keeps a 44 px touch target | ✓ |
| WEB-05-005 | TextField | ties the label to the box so a screen reader and getByLabelText find it | ✓ |
| WEB-05-006 | TextField | shows the hint, and an error as an alert with the box marked invalid and described by it | ✓ |
| WEB-05-007 | TextField | has no alert and is not invalid when there is no error | ✓ |
| WEB-05-008 | PasswordField | hides the password, and the show/hide button reveals and hides it again | ✓ |
| WEB-05-009 | PasswordField | never submits the form when the toggle is pressed | ✓ |
| WEB-05-010 | SelectField and TextAreaField | SelectField: choosing an option reports it; an error is an alert | ✓ |
| WEB-05-011 | SelectField and TextAreaField | TextAreaField: label, hint and error all work | ✓ |
| WEB-05-012 | Alert | a error message is announced as role=alert | ✓ |
| WEB-05-013 | Alert | a warning message is announced as role=status | ✓ |
| WEB-05-014 | Alert | a success message is announced as role=status | ✓ |
| WEB-05-015 | Alert | a info message is announced as role=status | ✓ |
| WEB-05-016 | Alert | defaults to info, and its icon is hidden from screen readers (the words carry the meaning) | ✓ |
| WEB-05-017 | Badge, Card, Item, PageTitle, Spinner, Icon | Badge shows its words in each tone | ✓ |
| WEB-05-018 | Badge, Card, Item, PageTitle, Spinner, Icon | Card has a heading only when it has a title | ✓ |
| WEB-05-019 | Badge, Card, Item, PageTitle, Spinner, Icon | Item pairs a label with its value in a description list | ✓ |
| WEB-05-020 | Badge, Card, Item, PageTitle, Spinner, Icon | PageTitle is the page's one h1 | ✓ |
| WEB-05-021 | Badge, Card, Item, PageTitle, Spinner, Icon | Spinner says it is loading, or says what it was told to | ✓ |
| WEB-05-022 | Badge, Card, Item, PageTitle, Spinner, Icon | Icon is decorative: hidden from screen readers, not focusable, sized by the class it is given | ✓ |

#### WEB-06 · `dev-tests.test.tsx` — components/devtests — หน้ารันเทสต์ในเว็บ (จะเอาออกก่อน deploy จริง)

อ้างอิง: DEV-TOOLS

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-06-001 | the test runner page | says the runner is off, and how to turn it on, when the server has no such routes | ✓ |
| WEB-06-002 | the test runner page | warns that it is temporary and writes test data, and lists every test file by group with what it protects | ✓ |
| WEB-06-003 | the test runner page | shows an error from the server instead of a blank page | ✓ |
| WEB-06-004 | the test runner page | 'run all web tests' asks for the web project only, follows the run, and shows the outcome | ✓ |
| WEB-06-005 | the test runner page | one file, and a whole group, ask for exactly those files | ✓ |
| WEB-06-006 | the test runner page | shows which test failed and why, and 'run again' re-runs only the files that failed | ✓ |
| WEB-06-007 | the test runner page | offers no 're-run failed' button when everything passed | ✓ |
| WEB-06-008 | the test runner page | tells the user when a run could not be started (another is going, or not allowed) | ✓ |
| WEB-06-009 | the test runner page | the stop button cancels the run on the server | ✓ |
| WEB-06-010 | the test runner page | a cancelled, timed-out or crashed run says so in words and keeps the program's last lines | ✓ |
| WEB-06-011 | the test runner page | picks up a run that was already going when the page was opened | ✓ |
| WEB-06-012 | the test runner page | recent runs are listed, and 'ดูผล' opens one | ✓ |
| WEB-06-013 | the test runner page | stops following when it cannot reach the server, and says so | ✓ |
| WEB-06-014 | the menu entry | is not in the admin menu unless the build asks for it | ✓ |
| WEB-06-015 | the menu entry | is added to the admin menu, last, when NEXT_PUBLIC_DEV_TOOLS=1, and never for a borrower | ✓ |

#### WEB-07 · `notifications.test.tsx` — หน้าตั้งค่าแจ้งเตือน LINE/Push

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-07-001 | push helpers | turns the VAPID key from base64url text into bytes | ✓ |
| WEB-07-002 | push helpers | reads the state of a plain desktop browser step by step | ✓ |
| WEB-07-003 | push helpers | an iPhone that is not opened from the home-screen icon must install first | ✓ |
| WEB-07-004 | push helpers | a browser without push support is reported as unsupported | ✓ |
| WEB-07-005 | push helpers | subscribes with the server's key and gives back exactly the endpoint and keys | ✓ |
| WEB-07-006 | push helpers | does not subscribe when the user refuses the permission | ✓ |
| WEB-07-007 | push helpers | unsubscribing returns the endpoint to tell the server (or null when there was none) | ✓ |
| WEB-07-008 | push card | offers to turn notifications on for this device, then registers the browser with the server | ✓ |
| WEB-07-009 | push card | explains a refusal in the browser and stays off | ✓ |
| WEB-07-010 | push card | shows the server's message when push is not configured (no VAPID key) | ✓ |
| WEB-07-011 | push card | does not show the browser's own technical error text | ✓ |
| WEB-07-012 | push card | turns it off here and tells the server, and a server that already forgot it is fine | ✓ |
| WEB-07-013 | push card | an iPhone outside the home-screen icon is told to install the app first, with no enable button | ✓ |
| WEB-07-014 | push card | tells a blocked browser how to fix it, an unsupported one to switch, and a missing worker to reload | ✓ |
| WEB-07-015 | push card | the installation guide lists the iPhone steps in Thai | ✓ |
| WEB-07-016 | LINE card | accepts the right shape of LINE user id only | ✓ |
| WEB-07-017 | LINE card | says when nothing is bound | ✓ |
| WEB-07-018 | LINE card | will not send a wrongly shaped id to the server | ✓ |
| WEB-07-019 | LINE card | binds the account, then only the masked id is shown | ✓ |
| WEB-07-020 | LINE card | shows the API's refusal | ✓ |
| WEB-07-021 | LINE card | removing the binding needs a confirmation | ✓ |
| WEB-07-022 | LINE card | backing out of removing sends nothing | ✓ |
| WEB-07-023 | test send | reads what each channel answered | ✓ |
| WEB-07-024 | test send | shows one line per channel | ✓ |
| WEB-07-025 | test send | shows a failed channel with the reason | ✓ |
| WEB-07-026 | test send | says when the server has no channel at all | ✓ |
| WEB-07-027 | test send | shows the API's message when the test cannot be sent | ✓ |

#### WEB-08 · `imports.test.tsx` — หน้านำเข้าข้อมูล

อ้างอิง: F10

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-08-001 | importBlockers | is empty when everything needed is done | ✓ |
| WEB-08-002 | importBlockers | blocks while the rates are not set | ✓ |
| WEB-08-003 | importBlockers | blocks a file the server says cannot be imported | ✓ |
| WEB-08-004 | importBlockers | blocks until every duplicate name has a chosen borrower | ✓ |
| WEB-08-005 | importBlockers | blocks invalid rows until the admin agrees to skip them | ✓ |
| WEB-08-006 | import page | offers the template download and lists past batches | ✓ |
| WEB-08-007 | import page | asks for a file before checking | ✓ |
| WEB-08-008 | import page | sends the chosen file as the raw body with its name, and shows the result of the check | ✓ |
| WEB-08-009 | import page | shows the API's reason when the file is not accepted | ✓ |
| WEB-08-010 | import page | shows the message for a file that is too large | ✓ |
| WEB-08-011 | import page | confirms with only the key, the file name and the answers, then shows what was imported | ✓ |
| WEB-08-012 | import page | blocks the button until the rates are set, and says why | ✓ |
| WEB-08-013 | import page › duplicate names | makes the admin choose a borrower first, and never guesses | ✓ |
| WEB-08-014 | import page › duplicate names | sends the chosen borrower for that name once picked | ✓ |
| WEB-08-015 | import page › duplicate names | shows each candidate with phone, account and when it was created | ✓ |
| WEB-08-016 | import page › invalid rows | shows the reason per row and needs a clear 'skip them' before importing | ✓ |
| WEB-08-017 | import page › invalid rows | can show just the invalid rows | ✓ |
| WEB-08-018 | import page | shows only the first 100 rows of a long file until asked | ✓ |
| WEB-08-019 | import page | shows the API's refusal on confirming and keeps the check on screen | ✓ |
| WEB-08-020 | import page | cancelling the check sends nothing to confirm | ✓ |
| WEB-08-021 | import page | choosing a different file clears the old check | ✓ |
| WEB-08-022 | batches and rollback | offers to undo a batch with no payments, after a confirmation that says what is deleted | ✓ |
| WEB-08-023 | batches and rollback | does not offer rollback once payments exist, and says why | ✓ |
| WEB-08-024 | batches and rollback | a batch already rolled back has no button and shows when | ✓ |
| WEB-08-025 | batches and rollback | backing out of the rollback sends nothing | ✓ |
| WEB-08-026 | batches and rollback | shows the API's refusal when a payment appeared meanwhile | ✓ |
| WEB-08-027 | batches and rollback | says so when nothing was ever imported | ✓ |

#### WEB-09 · `payment-submissions.test.tsx` — ผู้ยืมส่งสลิป / admin ตรวจและยืนยัน

อ้างอิง: F5-CR1 · DES-017

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-09-001 | borrower: sending a slip | is offered only on a contract that is paid out and still open | ✓ |
| WEB-09-002 | borrower: sending a slip | says plainly that sending a slip does not lower the balance yet | ✓ |
| WEB-09-003 | borrower: sending a slip | sends the slip itself with the amount and date in the address, and shows the confirmation | ✓ |
| WEB-09-004 | borrower: sending a slip | will not send without a slip, or with a file that is not a JPEG/PNG, or one over 5 MB | ✓ |
| WEB-09-005 | borrower: sending a slip | checks the amount and the date before sending | ✓ |
| WEB-09-006 | borrower: sending a slip | shows the API's refusal (such as too many waiting) and keeps what was typed | ✓ |
| WEB-09-007 | borrower: sending a slip | lists the claims of THIS contract with their status, and the reason when one was refused | ✓ |
| WEB-09-008 | admin: the slips queue | opens on the claims waiting for a check, showing who, how much, which contract and the borrower's note | ✓ |
| WEB-09-009 | admin: the slips queue | says so when nothing is waiting | ✓ |
| WEB-09-010 | admin: the slips queue | keeps the slip hidden until asked, then shows it from the API with the session cookie | ✓ |
| WEB-09-011 | admin: the slips queue | filters by status, and a decided claim has no decision buttons | ✓ |
| WEB-09-012 | admin: the slips queue | shows a refused claim with its reason, and a confirmed one as recorded — neither can be decided again | ✓ |
| WEB-09-013 | admin: the slips queue › confirming | explains that this records a real payment, pre-filled from the claim | ✓ |
| WEB-09-014 | admin: the slips queue › confirming | confirms as sent (nothing corrected → nothing but an empty body) and shows how it was settled | ✓ |
| WEB-09-015 | admin: the slips queue › confirming | sends only what the admin corrected (amount, date, note) | ✓ |
| WEB-09-016 | admin: the slips queue › confirming | an amount typed as 300 is not a correction of 300.00 | ✓ |
| WEB-09-017 | admin: the slips queue › confirming | shows the ledger's refusal in Thai and leaves the claim waiting so the amount can be fixed | ✓ |
| WEB-09-018 | admin: the slips queue › confirming | checks the corrected amount and date itself before calling the API | ✓ |
| WEB-09-019 | admin: the slips queue › confirming | backing out sends nothing | ✓ |
| WEB-09-020 | admin: the slips queue › refusing | needs a reason that the borrower will see, and sends it trimmed | ✓ |
| WEB-09-021 | admin: the slips queue › refusing | shows the API's message when the claim was already decided by someone else | ✓ |
| WEB-09-022 | admin: the slips queue | pages through the queue 20 at a time | ✓ |
| WEB-09-023 | admin: reminder on the contract page | tells the admin when the borrower has slips nobody has checked, with a link to the queue | ✓ |
| WEB-09-024 | admin: reminder on the contract page | says nothing when there is none, and not at all on a contract that is not open | ✓ |

#### WEB-10 · `borrower-portal.test.tsx` — หน้าผู้ยืม: สัญญา ขอยืม

อ้างอิง: F3 · F8

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-10-001 | borrower home | shows what is owed today on an active contract, with the due date | ✓ |
| WEB-10-002 | borrower home | shows an overdue contract with the days overdue and the accrued late fee | ✓ |
| WEB-10-003 | borrower home | a contract waiting for the payout shows NO amount owed | ✓ |
| WEB-10-004 | borrower home | tells the borrower about requests still waiting, and offers a new request | ✓ |
| WEB-10-005 | borrower home | does not list closed or cancelled contracts as things to pay | ✓ |
| WEB-10-006 | borrower home | shows the API's message when the data cannot be loaded | ✓ |
| WEB-10-007 | request page | sends only the amount and the due date, as text | ✓ |
| WEB-10-008 | request page | refuses a missing, zero or over-precise amount without calling the API | ✓ |
| WEB-10-009 | request page | refuses a due date that is not in the future | ✓ |
| WEB-10-010 | request page | asks for both fields | ✓ |
| WEB-10-011 | request page | shows the API's refusal in Thai and keeps what was typed | ✓ |
| WEB-10-012 | request page | lists my requests with their status in words, and the contract number once approved | ✓ |
| WEB-10-013 | request page | cancelling a pending request needs a second click | ✓ |
| WEB-10-014 | request page | backing out of the cancellation sends nothing | ✓ |
| WEB-10-015 | my contracts | lists every contract | ✓ |
| WEB-10-016 | my contracts | explains an empty list | ✓ |
| WEB-10-017 | my contract detail | shows the breakdown, the amount owed and the payment history | ✓ |
| WEB-10-018 | my contract detail | a contract waiting for the payout shows no amount owed, no interest and no history | ✓ |
| WEB-10-019 | my contract detail | shows another borrower's contract as not found (the API answers 404) | ✓ |
| WEB-10-020 | my contract detail | never shows the lender's slips, rates, who recorded a payment, admin notes or import flags | ✓ |
| WEB-10-021 | my contract detail | a closed contract says it is fully paid | ✓ |

#### WEB-11 · `period-picker.test.tsx` — components/reports/PeriodPicker

อ้างอิง: F9

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-11-001 | PeriodPicker | offers the four kinds of period, and starts on the current month | ✓ |
| WEB-11-002 | PeriodPicker | does not ask the API until the button is pressed, then asks once with the chosen month | ✓ |
| WEB-11-003 | PeriodPicker | year: shows only the year box, and sends the year | ✓ |
| WEB-11-004 | PeriodPicker | a bad year is explained and nothing is sent | ✓ |
| WEB-11-005 | PeriodPicker | range: two day boxes; an end before the start is refused, a good range is sent, and the error goes away | ✓ |
| WEB-11-006 | PeriodPicker | all time: no date box and an empty query | ✓ |

#### WEB-12 · `reports.test.tsx` — หน้ารายงาน — แสดงตัวเลขจาก API ตามที่ได้รับ

อ้างอิง: F9 · DES-015

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-12-001 | profit & loss | opens on the current month and shows the cash and accrual bases side by side | ✓ |
| WEB-12-002 | profit & loss | shows the API's totals as they are and never adds up the parts itself | ✓ |
| WEB-12-003 | profit & loss | explains that income is only interest and late fees | ✓ |
| WEB-12-004 | profit & loss | asks for a year, a custom range or all time only when the button is pressed | ✓ |
| WEB-12-005 | profit & loss | does not call the API for a period it would refuse | ✓ |
| WEB-12-006 | profit & loss | shows the API's message when the report cannot be produced | ✓ |
| WEB-12-007 | late payers | lists borrowers in the API's order with their late contracts | ✓ |
| WEB-12-008 | late payers | says so when nobody was late | ✓ |
| WEB-12-009 | late payers | pages 20 at a time | ✓ |
| WEB-12-010 | late payers | goes back to the first page when the period changes | ✓ |
| WEB-12-011 | outstanding | shows the balance as of today, as the API reports it | ✓ |
| WEB-12-012 | outstanding | asks for another day, but not a day in the future | ✓ |
| WEB-12-013 | outstanding | warns when contracts had to be left out because their history is inconsistent | ✓ |
| WEB-12-014 | outstanding | does not call a past day 'today' | ✓ |
| WEB-12-015 | borrower summary | shows the counts, the on-time rate and what is owed, from the API | ✓ |
| WEB-12-016 | borrower summary | a borrower with no verdict yet has no percentage, not 0% | ✓ |
| WEB-12-017 | borrower summary | says so when there is nothing in the period | ✓ |
| WEB-12-018 | borrower summary | links each borrower to the borrower's page | ✓ |
| WEB-12-019 | tabs | shows one report at a time and keeps the period picker for all but the outstanding balance | ✓ |

#### WEB-13 · `access.test.ts` — lib/access — หน้าที่แต่ละบทบาทเข้าได้

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-13-001 | destinationFor | sends anonymous visitors to the login page | ✓ |
| WEB-13-002 | destinationFor | sends an admin to /admin and a consenting borrower to /me | ✓ |
| WEB-13-003 | destinationFor | sends a borrower without PDPA acceptance to the PDPA page first | ✓ |
| WEB-13-004 | destinationFor | forces a password change before everything else, for both roles | ✓ |
| WEB-13-005 | resolveAccess (what each page lets in) | anonymous on a "anonymous" page | ✓ |
| WEB-13-006 | resolveAccess (what each page lets in) | admin on a "anonymous" page | ✓ |
| WEB-13-007 | resolveAccess (what each page lets in) | borrower on a "anonymous" page | ✓ |
| WEB-13-008 | resolveAccess (what each page lets in) | borrowerNoPdpa on a "anonymous" page | ✓ |
| WEB-13-009 | resolveAccess (what each page lets in) | mustChange on a "anonymous" page | ✓ |
| WEB-13-010 | resolveAccess (what each page lets in) | anonymous on a "change-password" page | ✓ |
| WEB-13-011 | resolveAccess (what each page lets in) | admin on a "change-password" page | ✓ |
| WEB-13-012 | resolveAccess (what each page lets in) | borrower on a "change-password" page | ✓ |
| WEB-13-013 | resolveAccess (what each page lets in) | borrowerNoPdpa on a "change-password" page | ✓ |
| WEB-13-014 | resolveAccess (what each page lets in) | mustChange on a "change-password" page | ✓ |
| WEB-13-015 | resolveAccess (what each page lets in) | anonymous on a "pdpa" page | ✓ |
| WEB-13-016 | resolveAccess (what each page lets in) | admin on a "pdpa" page | ✓ |
| WEB-13-017 | resolveAccess (what each page lets in) | borrower on a "pdpa" page | ✓ |
| WEB-13-018 | resolveAccess (what each page lets in) | borrowerNoPdpa on a "pdpa" page | ✓ |
| WEB-13-019 | resolveAccess (what each page lets in) | mustChange on a "pdpa" page | ✓ |
| WEB-13-020 | resolveAccess (what each page lets in) | anonymous on a "admin" page | ✓ |
| WEB-13-021 | resolveAccess (what each page lets in) | admin on a "admin" page | ✓ |
| WEB-13-022 | resolveAccess (what each page lets in) | borrower on a "admin" page | ✓ |
| WEB-13-023 | resolveAccess (what each page lets in) | borrowerNoPdpa on a "admin" page | ✓ |
| WEB-13-024 | resolveAccess (what each page lets in) | mustChange on a "admin" page | ✓ |
| WEB-13-025 | resolveAccess (what each page lets in) | anonymous on a "borrower" page | ✓ |
| WEB-13-026 | resolveAccess (what each page lets in) | admin on a "borrower" page | ✓ |
| WEB-13-027 | resolveAccess (what each page lets in) | borrower on a "borrower" page | ✓ |
| WEB-13-028 | resolveAccess (what each page lets in) | borrowerNoPdpa on a "borrower" page | ✓ |
| WEB-13-029 | resolveAccess (what each page lets in) | mustChange on a "borrower" page | ✓ |
| WEB-13-030 | resolveAccess (what each page lets in) | never lets a borrower into an admin page | ✓ |
| WEB-13-031 | resolveAccess (what each page lets in) | never lets an admin into a borrower page | ✓ |
| WEB-13-032 | menuFor | shows an admin the admin pages only | ✓ |
| WEB-13-033 | menuFor | shows a borrower no admin page | ✓ |
| WEB-13-034 | menuFor | is written in Thai | ✓ |

#### WEB-14 · `app-shell.test.tsx` — components/AppShell — เมนูตามบทบาท, ออกจากระบบ

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-14-001 | AppShell: the frame of every logged-in page | shows nothing when nobody is logged in | ✓ |
| WEB-14-002 | AppShell: the frame of every logged-in page | shows who is logged in with the Thai role name, and the page content | ✓ |
| WEB-14-003 | AppShell: the frame of every logged-in page | an admin sees the admin menu, in order, every entry a real link | ✓ |
| WEB-14-004 | AppShell: the frame of every logged-in page | a borrower sees only the borrower menu and nothing of the admin pages | ✓ |
| WEB-14-005 | AppShell: the frame of every logged-in page | marks exactly the current page, and the home entry only on its own page | ✓ |
| WEB-14-006 | AppShell: the frame of every logged-in page | logging out calls the API, then goes to the login page | ✓ |
| WEB-14-007 | AppShell: the frame of every logged-in page | still goes to the login page, with this browser signed out, when the server cannot be reached | ✓ |
| WEB-14-008 | AppShell: the frame of every logged-in page | uses the wide layout only when asked | ✓ |

#### WEB-15 · `gate-and-pages.test.tsx` — layouts, login, PDPA, เปลี่ยนรหัสผ่าน, หน้าแรก

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-15-001 | page guards | an anonymous visitor to /admin is sent to the login page and sees nothing of the page | ✓ |
| WEB-15-002 | page guards | a borrower on an admin page is sent to /me and sees nothing of the page | ✓ |
| WEB-15-003 | page guards | a borrower without PDPA acceptance is sent to the PDPA page before the borrower home | ✓ |
| WEB-15-004 | page guards | a borrower who must change the password is sent there before PDPA or the home | ✓ |
| WEB-15-005 | page guards | an admin sees the admin page, with the admin menu only | ✓ |
| WEB-15-006 | page guards | a consenting borrower sees the borrower home with no admin link at all | ✓ |
| WEB-15-007 | page guards | a logged-in user opening the login page is sent to where they belong | ✓ |
| WEB-15-008 | page guards | shows a retry when the server cannot be reached, instead of logging out or showing the page | ✓ |
| WEB-15-009 | page guards | the root page redirects by role (nothing is shown at /) | ✓ |
| WEB-15-010 | login page | logs an admin in and sends them to /admin | ✓ |
| WEB-15-011 | login page | sends a borrower without PDPA acceptance straight to the PDPA page | ✓ |
| WEB-15-012 | login page | goes to the first-password page when the password must be changed | ✓ |
| WEB-15-013 | login page | shows the API's Thai message on a wrong password, clears the password and does not navigate | ✓ |
| WEB-15-014 | login page | shows the lock message when too many attempts were made | ✓ |
| WEB-15-015 | login page | asks for both fields without calling the API | ✓ |
| WEB-15-016 | login page | never navigates to an address taken from the URL (no ?next= redirect) | ✓ |
| WEB-15-017 | change-password page | checks the new password before calling the API | ✓ |
| WEB-15-018 | change-password page | refuses the same password as before | ✓ |
| WEB-15-019 | change-password page | changes the password and then goes where the user belongs (PDPA next for a borrower) | ✓ |
| WEB-15-020 | change-password page | shows the API's message when the current password is wrong | ✓ |
| WEB-15-021 | change-password page | is closed to people who do not need to change the password | ✓ |
| WEB-15-022 | PDPA page | shows the terms, and the accept button stays disabled until the box is ticked | ✓ |
| WEB-15-023 | PDPA page | sends the version that was shown, then moves on to the borrower home | ✓ |
| WEB-15-024 | PDPA page | declining logs the borrower out | ✓ |
| WEB-15-025 | PDPA page | is not open to an admin or to a borrower who already accepted | ✓ |
| WEB-15-026 | PDPA page | the draft terms are marked as needing approval and are all in Thai | ✓ |

#### WEB-16 · `gate.test.tsx` — components/Gate — ป้องกันหน้า, ลองใหม่เมื่อเชื่อมต่อไม่ได้

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-16-001 | Gate | shows a spinner and none of the page while it learns who is there | ✓ |
| WEB-16-002 | Gate | shows the page to the right kind of user | ✓ |
| WEB-16-003 | Gate | an admin on a borrower page is sent to /admin and sees nothing of the page | ✓ |
| WEB-16-004 | Gate | a logged-in user on the login page is sent to the page they belong to | ✓ |
| WEB-16-005 | Gate | when the server cannot be reached it says so, and 'try again' asks again and then shows the page | ✓ |
| WEB-16-006 | Gate | an expired session (401) sends the visitor to the login page | ✓ |

#### WEB-17 · `session-store.test.ts` — lib/session-store — สถานะผู้ใช้

อ้างอิง: F1

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-17-001 | session store | learns who is logged in from GET /auth/me | ✓ |
| WEB-17-002 | session store | is anonymous on 401, but 'error' (not logged out) when the server cannot be reached | ✓ |
| WEB-17-003 | session store | treats a malformed /auth/me answer as an error, never as a user | ✓ |
| WEB-17-004 | session store | login posts the credentials, then reloads the user (including PDPA status) | ✓ |
| WEB-17-005 | session store | a failed login leaves the store anonymous and shows the API's message | ✓ |
| WEB-17-006 | session store | logout forgets the user even if the server call fails | ✓ |
| WEB-17-007 | session store | a 401 on any call logs the page out | ✓ |
| WEB-17-008 | session store | acceptPdpa sends the version it was given and reloads the user | ✓ |
| WEB-17-009 | session store | changePassword sends both passwords and reloads the user | ✓ |

#### WEB-18 · `admin-borrowers.test.tsx` — หน้าผู้ยืม

อ้างอิง: F1 · F8

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-18-001 | borrower list | lists borrowers with the account number masked and the status in words | ✓ |
| WEB-18-002 | borrower list | explains an empty list and offers to add the first borrower | ✓ |
| WEB-18-003 | borrower list | searches by name after a short pause and goes back to the first page | ✓ |
| WEB-18-004 | borrower list | pages through the list 20 at a time | ✓ |
| WEB-18-005 | borrower list | a click on next right after the page opens is not undone by the search timer | ✓ |
| WEB-18-006 | borrower list | shows the API's message on failure | ✓ |
| WEB-18-007 | create borrower | creates the borrower and shows the temporary password once | ✓ |
| WEB-18-008 | create borrower | requires every field and calls nothing while any is wrong | ✓ |
| WEB-18-009 | create borrower | checks the password length of the account | ✓ |
| WEB-18-010 | create borrower | the generator fills a password that passes the length check | ✓ |
| WEB-18-011 | create borrower | shows 'username taken' from the API and keeps the form | ✓ |
| WEB-18-012 | borrower detail | masks the account number until the admin chooses to show it | ✓ |
| WEB-18-013 | borrower detail | edits only the fields that changed | ✓ |
| WEB-18-014 | borrower detail | says nothing changed instead of sending an empty edit | ✓ |
| WEB-18-015 | borrower detail | refuses an invalid phone number before calling the API | ✓ |
| WEB-18-016 | borrower detail | deactivating needs a confirmation, then sends isActive=false | ✓ |
| WEB-18-017 | borrower detail | a deactivated account can be activated again | ✓ |
| WEB-18-018 | borrower detail | cancelling the deactivation sends nothing | ✓ |
| WEB-18-019 | borrower detail | resets the password, shows the new one once and can hide it | ✓ |
| WEB-18-020 | borrower detail | refuses a short new password without calling the API | ✓ |
| WEB-18-021 | borrower detail | an imported borrower has no account: the account controls are not offered | ✓ |
| WEB-18-022 | borrower detail | shows 'not found' from the API | ✓ |
| WEB-18-023 | borrower detail | shows when the borrower accepted the PDPA terms | ✓ |

#### WEB-19 · `admin-contracts.test.tsx` — หน้ารายการสัญญา

อ้างอิง: F4

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-19-001 | contract list | shows each contract with its status, due date and what is owed | ✓ |
| WEB-19-002 | contract list | says so when nothing matches | ✓ |
| WEB-19-003 | contract list | passes the filters to the API | ✓ |
| WEB-19-004 | contract list | returns to the first page whenever the filter changes | ✓ |
| WEB-19-005 | contract list | a click on next right after the page opens is not undone by the search timer | ✓ |
| WEB-19-006 | contract list | shows the API's message on failure | ✓ |

#### WEB-20 · `admin-ledger.test.tsx` — หน้าสัญญา: จ่ายเงิน รับชำระ แก้/ลบ

อ้างอิง: F4 · F5 · DES-016

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-20-001 | contract waiting for the payout | shows no amount owed before the payout | ✓ |
| WEB-20-002 | contract waiting for the payout | warns when the rates are not set (a payout is impossible) | ✓ |
| WEB-20-003 | contract waiting for the payout | will not record a payout without a slip | ✓ |
| WEB-20-004 | contract waiting for the payout | uploads the slip, then records the payout with its key (the amount is never sent) | ✓ |
| WEB-20-005 | contract waiting for the payout | refuses a payout date in the future | ✓ |
| WEB-20-006 | contract waiting for the payout | refuses a payout on or after the due date (interest needs at least one day) | ✓ |
| WEB-20-007 | contract waiting for the payout | shows the API's refusal (rates not set) and keeps the slip | ✓ |
| WEB-20-008 | contract waiting for the payout | does not upload a file that is not a JPEG or PNG | ✓ |
| WEB-20-009 | contract waiting for the payout | does not upload a file over 5 MB | ✓ |
| WEB-20-010 | contract waiting for the payout | shows the server's message when the upload fails and keeps the payout blocked | ✓ |
| WEB-20-011 | contract waiting for the payout | choosing another file clears the previous slip | ✓ |
| WEB-20-012 | contract waiting for the payout | cancelling the contract needs a confirmation and may carry a reason | ✓ |
| WEB-20-013 | contract waiting for the payout | shows the API's refusal when the contract can no longer be cancelled | ✓ |
| WEB-20-014 | active contract: payments | shows what is owed, how it is made up and the locked rates | ✓ |
| WEB-20-015 | active contract: payments | uses the owner's wording: จ่ายเพื่อลดยอดรวมที่ติด | ✓ |
| WEB-20-016 | active contract: payments | the full-payment button fills in what is owed today, as text | ✓ |
| WEB-20-017 | active contract: payments | offers the full-payment shortcut only for today's date | ✓ |
| WEB-20-018 | active contract: payments | records a payment and tells how it was settled (late fee, interest, principal) | ✓ |
| WEB-20-019 | active contract: payments | says the contract is closed when the last payment settles it | ✓ |
| WEB-20-020 | active contract: payments | refuses an invalid amount or date before calling the API | ✓ |
| WEB-20-021 | active contract: payments | shows the API's refusal when the payment is more than is owed | ✓ |
| WEB-20-022 | active contract: payments | a closed contract offers no payment form | ✓ |
| WEB-20-023 | active contract: payments | shows overdue days, the daily late-fee table, the imported flag and an inconsistency warning | ✓ |
| WEB-20-024 | active contract: payments | shows the API's message when the contract is not found | ✓ |
| WEB-20-025 | editing and deleting recorded payments | shows the recorded payments with how each was settled | ✓ |
| WEB-20-026 | editing and deleting recorded payments | warns what an edit does to the contract, reports and sent notifications, and sends only the change | ✓ |
| WEB-20-027 | editing and deleting recorded payments | an amount typed as 300 or 300.0 is not a change from 300.00 | ✓ |
| WEB-20-028 | editing and deleting recorded payments | emptying the note sends null (clears it) | ✓ |
| WEB-20-029 | editing and deleting recorded payments | shows the API's refusal when an edit would make the history invalid | ✓ |
| WEB-20-030 | editing and deleting recorded payments | deleting a payment shows the warning, needs a confirmation, then deletes | ✓ |
| WEB-20-031 | editing and deleting recorded payments | backing out of an edit or a delete sends nothing | ✓ |
| WEB-20-032 | the payout record | keeps the slip hidden until asked, then shows it from the API with the session cookie | ✓ |
| WEB-20-033 | the payout record | edits only the changed fields and warns about the recalculation | ✓ |
| WEB-20-034 | the payout record | can replace the slip | ✓ |
| WEB-20-035 | the payout record | an edit with nothing changed is not sent | ✓ |
| WEB-20-036 | the payout record | deleting the payout explains it and needs a confirmation | ✓ |
| WEB-20-037 | the payout record | shows the API's refusal when payments still exist | ✓ |
| WEB-20-038 | the payout record | an imported contract has no payout record to show | ✓ |

#### WEB-21 · `admin-requests.test.tsx` — หน้าคำขอยืม

อ้างอิง: F3

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-21-001 | request inbox | opens on the requests waiting for a decision | ✓ |
| WEB-21-002 | request inbox | says so when nothing is waiting | ✓ |
| WEB-21-003 | request inbox | switches the filter and asks the API for that status (or all) | ✓ |
| WEB-21-004 | request inbox | approving needs a confirmation and then creates the contract | ✓ |
| WEB-21-005 | request inbox | rejecting needs a reason and sends it | ✓ |
| WEB-21-006 | request inbox | a whitespace-only reason does not count | ✓ |
| WEB-21-007 | request inbox | cancelling a request also needs a confirmation | ✓ |
| WEB-21-008 | request inbox | backing out of a decision sends nothing | ✓ |
| WEB-21-009 | request inbox | shows the API's refusal when the request is no longer pending | ✓ |
| WEB-21-010 | request inbox | decided requests have no decision buttons, but show the reason and the contract link | ✓ |
| WEB-21-011 | request inbox | pages through the inbox 20 at a time | ✓ |
| WEB-21-012 | create a request for a borrower | needs a borrower, an amount and a future due date | ✓ |
| WEB-21-013 | create a request for a borrower | creates the request for the chosen borrower | ✓ |
| WEB-21-014 | create a request for a borrower | can approve straight away | ✓ |
| WEB-21-015 | create a request for a borrower | if approving fails the request still exists and the page says so | ✓ |
| WEB-21-016 | create a request for a borrower | shows the API's refusal and keeps the form | ✓ |
| WEB-21-017 | create a request for a borrower | refuses today as the due date | ✓ |

#### WEB-22 · `admin-settings.test.tsx` — หน้าตั้งอัตรา

อ้างอิง: F2

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-22-001 | settings page (rates) | warns that payouts and imports are impossible until both rates are set | ✓ |
| WEB-22-002 | settings page (rates) | warns when only one of the two rates is set | ✓ |
| WEB-22-003 | settings page (rates) | shows no warning once both are set, and who changed them last | ✓ |
| WEB-22-004 | settings page (rates) | saves the first values without a confirm step, sending both as normalised strings | ✓ |
| WEB-22-005 | settings page (rates) | rejects an invalid rate before calling the API | ✓ |
| WEB-22-006 | settings page (rates) | does not call the API when nothing changed | ✓ |
| WEB-22-007 | settings page (rates) | treats a re-typed identical number as no change | ✓ |
| WEB-22-008 | settings page (rates) | asks for confirmation before replacing a rate that is in use, and sends only the changed field | ✓ |
| WEB-22-009 | settings page (rates) | cancelling the confirm step sends nothing | ✓ |
| WEB-22-010 | settings page (rates) | shows the API's message when saving fails | ✓ |
| WEB-22-011 | settings page (rates) | explains that a change only affects contracts paid out afterwards | ✓ |
| WEB-22-012 | admin dashboard | points to the settings page while rates are missing | ✓ |

#### WEB-23 · `calendar.test.tsx` — ปฏิทิน admin

อ้างอิง: F11 · DES-018

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-23-001 | calendar layout helpers | reads and writes months, and moves across year ends | ✓ |
| WEB-23-002 | calendar layout helpers | knows how long a month is (including leap years) | ✓ |
| WEB-23-003 | calendar layout helpers | starts the first day on the right weekday (weeks begin on Sunday) | ✓ |
| WEB-23-004 | calendar layout helpers | writes months and days in Thai Buddhist Era | ✓ |
| WEB-23-005 | calendar page | opens on the current month with today selected, asking the API for that month | ✓ |
| WEB-23-006 | calendar page | puts what is due on its day and what was paid on its day, with a plain-words label for each cell | ✓ |
| WEB-23-007 | calendar page | shows the contracts due on the chosen day with what is still owed, taken from the API as it is | ✓ |
| WEB-23-008 | calendar page | opens another day when it is pressed, and flags a day that is overdue | ✓ |
| WEB-23-009 | calendar page | colours a day red when something due is overdue, amber when open, green when settled | ✓ |
| WEB-23-010 | calendar page | says so when the chosen day has nothing on it | ✓ |
| WEB-23-011 | calendar page | moves to the next and previous month (also across the year), asking the API each time | ✓ |
| WEB-23-012 | calendar page | another month starts with no day chosen, and 'back to this month' returns with today chosen | ✓ |
| WEB-23-013 | calendar page | starts the first of the month on the right weekday column | ✓ |
| WEB-23-014 | calendar page | warns when the month had too much to show, and shows the API's message on failure | ✓ |

#### WEB-24 · `manifest.test.ts` — manifest.webmanifest + ไอคอน

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-24-001 | PWA manifest | declares an installable standalone Thai app that starts at / | ✓ |
| WEB-24-002 | PWA manifest | has a 192, a 512 and a maskable icon, and every icon file exists at its stated size | ✓ |
| WEB-24-003 | PWA manifest | has the iOS home-screen icon the layout links to | ✓ |
| WEB-24-004 | PWA manifest | has an offline page in Thai | ✓ |

#### WEB-25 · `next-config.test.ts` — next.config — header ความปลอดภัย, proxy

อ้างอิง: Security

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-25-001 | next.config | forwards /api/* to the API server side, so the browser stays on one origin | ✓ |
| WEB-25-002 | next.config | sends the security headers on every page | ✓ |
| WEB-25-003 | next.config | never lets the service worker file be cached | ✓ |
| WEB-25-004 | next.config | sends the old new-request notification address to the page that exists | ✓ |
| WEB-25-005 | next.config | does not advertise the framework | ✓ |

#### WEB-26 · `register-sw.test.tsx` — components/RegisterServiceWorker

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-26-001 | RegisterServiceWorker | registers /sw.js for the whole site in a production build | ✓ |
| WEB-26-002 | RegisterServiceWorker | does nothing in development (a service worker would only get in the way) | ✓ |
| WEB-26-003 | RegisterServiceWorker | does nothing, and does not crash, in a browser without service workers | ✓ |
| WEB-26-004 | RegisterServiceWorker | the app keeps working when registration is refused | ✓ |
| WEB-26-005 | RegisterServiceWorker | renders nothing visible | ✓ |

#### WEB-27 · `service-worker.test.ts` — public/sw.js — offline, push, notificationclick

อ้างอิง: F7

| รหัส | กลุ่ม | เคส | ผล |
|---|---|---|---|
| WEB-27-001 | service worker | on install keeps only the offline page | ✓ |
| WEB-27-002 | service worker | on activate removes other caches and takes control | ✓ |
| WEB-27-003 | service worker | lets a page load through the network when online | ✓ |
| WEB-27-004 | service worker | shows the offline page when a page cannot be loaded | ✓ |
| WEB-27-005 | service worker | never touches API calls, even page-like ones | ✓ |
| WEB-27-006 | service worker | never touches non-GET requests, assets or other origins | ✓ |
| WEB-27-007 | service worker | stores nothing but the offline page | ✓ |
| WEB-27-008 | service worker: Web Push | shows the notification the server sent, as plain text | ✓ |
| WEB-27-009 | service worker: Web Push | always shows something, even when the payload is empty or unreadable (browsers demand it) | ✓ |
| WEB-27-010 | service worker: Web Push | cuts an over-long title and body | ✓ |
| WEB-27-011 | service worker: Web Push | a notification only ever points at a page of this site | ✓ |
| WEB-27-012 | service worker: Web Push | clicking opens the page in a new window when the app is not open | ✓ |
| WEB-27-013 | service worker: Web Push | clicking brings an open window of the app forward and goes to the page | ✓ |
| WEB-27-014 | service worker: Web Push | clicking can never be turned into leaving the site | ✓ |

## 5. ความครอบคลุมที่วัดได้

วัดด้วย v8 (`npm run test:coverage`) — ตัวเลขล่าสุดอยู่ในไฟล์ `coverage/coverage-summary.json` หลังรันคำสั่งนั้น; ไฟล์ที่ตั้งใจไม่ทดสอบ: จุดเริ่มโปรแกรม (`index.ts`, `db.ts`), สคริปต์ CLI บางๆ (`create-admin`, `reset-admin-password`, `generate-vapid-keys` — ตรรกะอยู่ใน `admin-accounts.ts` ซึ่งมีเทสต์), `app/layout.tsx`

