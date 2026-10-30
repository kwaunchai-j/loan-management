# plan — loan-management (ระบบขอยืมเงิน)

> เขียนโดย `project-manager` จาก `requirement.md` และ `design.md` (Data Model และ stack ยืนยันแล้วโดยผู้ใช้ PM3 เมื่อ 2026-10-27; Contract section ปิดครบแล้ว)
> ทุกแถวเริ่มที่ Status `pending`; มีเพียง `qa-engineer` ที่ตั้ง `verified`/`blocked` ได้ และ engineer ไม่แก้ตารางนี้ (`policies/documentation.md` §5)
> Acceptance criteria ในเอกสารนี้เป็นการอ้าง `DES-NNN` ใน `design.md` ไม่ใช่การคัดลอกกฎมาซ้ำ — ถ้าข้อความต่างกัน `design.md` ชนะ
> `_docs/status.md` ยังไม่มี จึงถือว่า **ยังไม่ scaffold** (Phase 0 ต้องรันก่อนทุกอย่าง)

## Plan Summary

**เป้าหมาย:** ระบบขอยืมเงินภาษาไทย ผู้ยืมยื่นคำขอ admin (คนเดียว) อนุมัติ จ่ายเงิน รับชำระ ระบบคิดดอกเบี้ยแบบ flat (% ต่อเดือน) ค่าปรับรายวันคิดซ้อน แจ้งเตือน admin ทาง LINE OA และ Web Push (PWA) มีรายงาน 4 รายงาน และนำเข้าข้อมูลเดิมจาก Excel/CSV

**Stack (ยืนยันแล้ว, `project.yaml` `current`):** Node + TypeScript + Express + Zod + Prisma + PostgreSQL + npm สำหรับ backend; Next.js + React + Tailwind + Zustand (PWA) สำหรับ frontend โครงสร้างโฟลเดอร์ที่วางแผนไว้: `api/` และ `web/`

**ขอบเขตงาน:** 11 เฟส 36 งาน (ตัวเลขนับจากตารางด้านล่าง) ครอบคลุม M1–M8 ของ `design.md` ครบทุก Design ID ที่มี contract (DES-001/002, 003, 004/005, 006, 007, 008, 010, 011, 012, 013, 014, 015, 016)

| เฟส | ชื่อ | Owner หลัก | 🔒 | Module / Design ID |
|---|---|---|---|---|
| 0 | Scaffold | `setup` | — | ทั้งหมด (Data Model) |
| 1 | Accounts, PDPA, Master data | `backend-engineer` | 🔒 | M1, M2 — DES-001/002/003 |
| 2 | Origination (คำขอ สัญญา จ่ายเงิน) | `backend-engineer` | 🔒 | M3 — DES-004/005/006/010/011 |
| 3 | Repayment & Late Fee | `backend-engineer` | 🔒 | M4 — DES-007/011/012/016 |
| 4 | Notifications | `backend-engineer` | 🔒 | M5 — DES-013 |
| 5 | Reports & Borrower API | `backend-engineer` | — | M7, M6 — DES-015/008 |
| 6 | Import | `backend-engineer` | 🔒 | M8 — DES-014 |
| 7 | Frontend: Access & Master data | `frontend-engineer` | — | M1, M2 (UI) |
| 8 | Frontend: Origination & Repayment | `frontend-engineer` | — | M3, M4, M6 (UI) |
| 9 | Frontend: Reports, Import, Notifications | `frontend-engineer` | — | M5, M7, M8 (UI) |
| 10 | Deploy & Device acceptance | `devops` | 🔒 | ทุกโมดูล |

**การตัดสินใจของ PM ที่ไม่ใช่การเปลี่ยน design** (ทุกข้อไม่แตะ Data Model; รายละเอียดใน Sequencing Notes):
- งานคำนวณเงิน (ดอกเบี้ย การตัดยอด ค่าปรับ) แยกเป็นไลบรารีบริสุทธิ์ที่ทดสอบเดี่ยวได้ ก่อนผูกกับ endpoint
- ตัวจัดเวลา (scheduler) เป็นงานโครงสร้างเดียว ใช้ร่วมกันระหว่างงานคิดค่าปรับ 00:05 และงานแจ้งเตือน 09:00/17:00
- สลิปการโอนเข้าถึงได้เฉพาะ `ADMIN` (ผู้ยืมไม่ดาวน์โหลดสลิปได้) — design เปิดทางไว้ว่า PM ตัดสินได้
- Frontend แต่ละเฟสเริ่มได้ก็ต่อเมื่อ backend contract ของเฟสที่เกี่ยวข้องมีแล้ว (ผ่านคอลัมน์ `Consumes`)

## Phase 0 — Scaffold `[setup]`

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-001 | scaffold `api/` (Express + TS + Zod + Prisma, `GET /health`) และ `web/` (Next.js + Tailwind + Zustand, PWA manifest เปล่า), `.env.example`, `.gitignore`, สคริปต์ `dev/build/start/typecheck/lint`; คัดลอก Prisma models ทั้ง 12 ตัวจาก Data Model **verbatim** เป็น `schema.prisma` + migration แรก | `setup` | — | `db:schema`, `api:skeleton`, `web:skeleton` | design Data Model | Data Model | — | pending |

- **Acceptance:** `schema.prisma` ตรงกับ Data Model ทุก model ทุก field (`node .claude/scripts/check-schema-contract.js` ผ่าน); `npm run typecheck` และ `npm run build` ผ่านทั้ง `api/` และ `web/`; `GET /health` ตอบ 200; ไม่มี model ใดนอกเหนือจาก Data Model
- **Rollback:** ลบโฟลเดอร์ `api/`, `web/` และ migration แรก (ยังไม่มีข้อมูล)

## Phase 1 — Accounts, PDPA, Master data `[backend]` 🔒 Security gate

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-101 | Auth core: login ด้วย username + รหัสผ่าน (hash), session/token, middleware ตาม `Role`, จำกัดความถี่ล็อกอิน, บังคับเปลี่ยนรหัสผ่านเมื่อ `mustChangePassword`, สคริปต์สร้าง admin คนแรกจาก env (ห้ามฝังรหัสผ่านในโค้ด) | `backend-engineer` | T-001 | `api:auth`, `lib:authz` | `db:schema` | DES-001, DES-002 | 🔒 login | pending |
| T-102 | PDPA gate: endpoint ยอมรับเงื่อนไข (บันทึก `pdpaAcceptedAt`, `pdpaVersion`) และ middleware ที่ปฏิเสธทุก endpoint ของผู้ยืมจนกว่าจะยอมรับ | `backend-engineer` | T-101 | `api:pdpa` | `lib:authz` | DES-002 | — | pending |
| T-103 | จัดการบัญชีและผู้ยืมโดย `ADMIN`: สร้างผู้ยืม + บัญชี, แก้ข้อมูล, ปิดการใช้งาน, รีเซ็ตรหัสผ่าน; guard ฝั่งผู้ยืมที่ดึง `borrowerId` จากเซสชันเท่านั้น (ห้ามรับจาก client) | `backend-engineer` | T-101, T-104 | `api:borrowers`, `lib:borrower-scope` | `api:auth`, `lib:audit` | DES-001, DES-002, DES-008 | 🔒 reset รหัสผ่าน, เลขบัญชี | pending |
| T-104 | บริการ `AuditLog` (helper เขียนบันทึก actor/action/entity/detail ก่อน-หลัง) ที่งานอื่นเรียกใช้ | `backend-engineer` | T-001 | `lib:audit` | `db:schema` | DES-016 | — | pending |
| T-105 | Master data: อ่าน/ตั้ง `Setting` (แถวเดียว `id = 1`) อัตราดอกเบี้ย % ต่อเดือน และค่าปรับ % ต่อวัน; ค่าเป็น `null` จนกว่า admin ตั้ง; ฟังก์ชัน `requireRates()` ที่งานจ่ายเงิน/นำเข้าเรียก; ห้ามฝังตัวเลขอัตราในโค้ด | `backend-engineer` | T-101, T-104 | `api:settings`, `lib:rates` | `api:auth`, `lib:audit` | DES-003 | — | pending |

- **Acceptance:** กฎการเข้าถึงทั้งหมดใน `design.md` หัวข้อ DES-001/002/008; `ADMIN` ตั้ง master data ได้ และผู้ยืมตั้งไม่ได้; ผู้ยืมที่ยังไม่ยอมรับ PDPA เข้าข้อมูลใดๆ ไม่ได้; ไม่มี endpoint ใดรับ `borrowerId` จาก client
- **Rollback:** revert โค้ดของเฟส; ตารางไม่เปลี่ยน (migration แรกมาจาก T-001)
- **Security flag:** เฟสนี้ติด 🔒 เพราะแตะล็อกอิน การรีเซ็ตรหัสผ่าน และข้อมูลส่วนบุคคล (เลขบัญชี) — `security` ตัดสินเรื่องเข้ารหัสฟิลด์ `bankAccountNo` ที่ประตูตรวจ (design ส่งต่อประเด็นนี้ให้ `security`)

## Phase 2 — Origination `[backend]` 🔒 Security gate

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-201 | คำขอยืม: ผู้ยืมสร้างคำขอของตัวเอง (`amount` + `requestedDueDate` อนาคต), `ADMIN` สร้างแทนและอนุมัติเองได้; อนุมัติ → สร้าง `Contract` `AWAITING_DISBURSEMENT` พร้อมเลขสัญญา; ปฏิเสธพร้อมเหตุผล; ยกเลิกคำขอ; `ADMIN` ยกเลิกสัญญาที่ยังไม่มี `Disbursement` | `backend-engineer` | T-103, T-104 | `api:loan-requests`, `api:contracts` | `api:borrowers`, `lib:borrower-scope`, `lib:audit` | DES-004, DES-005 | — | pending |
| T-202 | ไลบรารีคำนวณดอกเบี้ย: `principal × rate / 100 × days / 30` ปัดขึ้นเป็นบาทเต็มเสมอ (CR-2), `days ≥ 1` มิฉะนั้นปฏิเสธ, ใช้ `Decimal` เท่านั้น พร้อมชุดทดสอบเดี่ยว | `backend-engineer` | T-001 | `lib:interest` | `db:schema` | DES-010 | — | pending |
| T-203 | ที่เก็บสลิป: endpoint อัปโหลด (จำกัดชนิดและขนาดไฟล์), ชั้น storage ที่สลับ path ได้ผ่าน env, endpoint ดาวน์โหลดเฉพาะ `ADMIN`, ชื่อไฟล์สุ่มไม่ใช้ชื่อจาก client | `backend-engineer` | T-101 | `api:slips`, `lib:slip-storage` | `api:auth` | DES-011 | 🔒 อัปโหลดไฟล์ + การเข้าถึงสลิป | pending |
| T-204 | บันทึกการจ่ายเงินให้ผู้ยืม: `ADMIN` เท่านั้น, สัญญา `AWAITING_DISBURSEMENT` เท่านั้น, `amount = principal`, **บังคับแนบสลิป**, `paidOn` ย้อนหลังได้, ปฏิเสธถ้ายังไม่ได้ตั้งอัตรา, คำนวณดอกเบี้ยและ snapshot อัตราลงสัญญาใน transaction เดียว | `backend-engineer` | T-201, T-202, T-203, T-105 | `api:disbursements` | `api:contracts`, `lib:interest`, `lib:slip-storage`, `lib:rates` | DES-006, DES-010, DES-011 | 🔒 เงิน + สลิป | pending |

- **Acceptance:** `design.md` DES-004/005, DES-010, DES-011 (ส่วน Disbursement); ตัวอย่างคำนวณดอกเบี้ยตรงตามสูตรและปัดขึ้น; สัญญา `AWAITING_DISBURSEMENT` ไม่มียอดที่ต้องชำระและไม่หมดอายุ; ไม่แนบสลิป = ปฏิเสธ
- **Rollback:** revert โค้ด; ข้อมูลสัญญา/จ่ายเงินที่ทดสอบลบได้ด้วยการลบแถวของข้อมูลทดสอบ (ยังไม่ขึ้น production); ไฟล์สลิปอยู่ใน storage แยกจากฐานข้อมูล
- **Security flag:** 🔒 เพราะมีอัปโหลดไฟล์และการควบคุมการเข้าถึงสลิป (design ระบุให้ gate งานการเข้าถึงสลิป)

## Phase 3 — Repayment & Late Fee `[backend]` 🔒 Security gate

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-301 | ไลบรารีตัดยอดและยอดที่ต้องชำระ: ลำดับ ค่าปรับสะสม → ดอกเบี้ย → เงินต้น, ปฏิเสธการจ่ายเกินยอดที่ติด, ปิดสัญญาเมื่อยอดเป็น 0; ชุดทดสอบจากตัวอย่างในเอกสาร (ติด 1,000 = ต้น 800 + ดอก 200 ค่าปรับ 50 จ่าย 300 → ตัด 50, 200, 50) | `backend-engineer` | T-202 | `lib:allocation` | `lib:interest` | DES-011 | — | pending |
| T-302 | เครื่องคิดค่าปรับรายวัน: สร้าง `LateFeeAccrual` ต้นวัน D จากยอดสิ้นวัน D−1 (คิดซ้อน) ปัดขึ้นเสมอ, ใช้อัตราที่ snapshot ในสัญญา, idempotent ด้วย unique `(contractId, accrualDate)`, ตามเก็บย้อนหลังได้, คิดแบบ lazy เมื่อมีการดึงยอดหรือบันทึกชำระของวันนั้นถ้างานยังไม่รัน | `backend-engineer` | T-301 | `lib:late-fee` | `lib:allocation` | DES-012 | — | pending |
| T-303 | บันทึกการรับชำระ: สัญญา `ACTIVE` เท่านั้น, `0 < amount ≤ ยอดที่ต้องชำระ ณ วันที่บันทึก`, `paidOn` ไม่ก่อน `disbursedOn` และไม่เป็นอนาคต, ทั้งก่อนและหลังเลยกำหนด (จ่ายเพื่อลดยอดรวมที่ติด), ตัดยอดและเก็บ `allocated*`, คิดค่าปรับของวันที่ชำระครบด้วยแล้วหยุดวันถัดไป | `backend-engineer` | T-302, T-204, T-104 | `api:payments` | `lib:late-fee`, `lib:allocation`, `api:disbursements`, `lib:audit` | DES-007, DES-011, DES-012 | 🔒 เงิน | pending |
| T-304 | โครงสร้าง scheduler (เวลา Asia/Bangkok, process เดียว/กันงานซ้ำเมื่อรันหลาย instance, ตามเก็บย้อนหลังเมื่อเซิร์ฟเวอร์ดับ) และงานคิดค่าปรับ 00:05 ทุกวัน | `backend-engineer` | T-302 | `job:scheduler`, `job:late-fee` | `lib:late-fee` | DES-012 | — | pending |
| T-305 | แก้ไข/ลบรายการเดิมโดย `ADMIN` (`Payment`: `amount`/`paidOn`/`note`; `Disbursement`: `paidOn`/`slipFileKey`/`note`) แล้ว **คำนวณสัญญาใหม่ทั้งสัญญาใน transaction เดียว** (ลบและสร้าง `LateFeeAccrual` ใหม่, replay รับชำระเรียงตาม `paidOn` แล้ว `createdAt`, เปิดสัญญา `CLOSED` กลับเป็น `ACTIVE` ได้), ปฏิเสธผลที่ไม่ถูกต้อง, ลบ `Disbursement` ได้เมื่อไม่เหลือ `Payment` แล้วสัญญากลับเป็น `AWAITING_DISBURSEMENT`, `AuditLog` เก็บค่าก่อน/หลังและแถวที่ลบ | `backend-engineer` | T-303, T-204, T-104 | `api:record-edit` | `api:payments`, `api:disbursements`, `lib:late-fee`, `lib:allocation`, `lib:audit` | DES-016 | 🔒 แก้/ลบรายการเงิน | pending |
| T-306 | endpoint ฝั่ง admin สำหรับสัญญา: รายการ/กรอง/รายละเอียดพร้อมยอดที่ต้องชำระ ณ วันนี้ (คำนวณ ไม่เก็บ), สถานะ "เลยกำหนด" และ "ชำระช้า" ที่คำนวณ, ประวัติจ่ายเงินและรับชำระต่อสัญญา | `backend-engineer` | T-303 | `api:contract-queries` | `api:payments`, `lib:late-fee` | DES-005, DES-012 | — | pending |

- **Acceptance:** `design.md` DES-011, DES-012, DES-016 ครบ; ชุดทดสอบเดี่ยวของ T-301/T-302 ผ่านตัวอย่าง 1,000 / 50 / 300 และกรณี: จ่ายครบวันครบกำหนด, จ่ายหลังเลยกำหนดหลายวัน, จ่ายเพื่อลดยอดรวมที่ติดแล้วฐานค่าปรับลดตั้งแต่วันถัดไป, จ่ายเกินถูกปฏิเสธ, แก้/ลบรายการแล้วผลตรงกับการคำนวณใหม่ทั้งสัญญา
- **Rollback:** revert โค้ด; ถ้ามีข้อมูลทดสอบ ลบสัญญาทดสอบพร้อม `LateFeeAccrual`/`Payment` ของมัน; `AuditLog` ไม่ลบ
- **Security flag:** 🔒 เพราะ T-305 เปลี่ยน/ลบรายการเงินย้อนหลังและเปิดสัญญาที่ปิดแล้วกลับมา — ต้องตรวจว่าทำได้เฉพาะ `ADMIN` และทุกครั้งมี `AuditLog`

## Phase 4 — Notifications `[backend]` 🔒 Security gate

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-401 | บริการส่งแจ้งเตือนกลาง: เขียน `NotificationLog`, กันส่งซ้ำด้วย `dedupeKey`, ลองใหม่สูงสุด 3 ครั้งแล้วบันทึก `FAILED` พร้อม `error`; ผู้รับคือ `ADMIN` เท่านั้น | `backend-engineer` | T-304 | `svc:notifications` | `job:scheduler` | DES-013 | — | pending |
| T-402 | ช่องทาง LINE: adapter ของ Messaging API (push ไปที่ `User.lineUserId`, token จาก env), endpoint ผูก/แก้ `lineUserId` ของ admin (กลไกการผูกรอคำตอบข้อ Q1) | `backend-engineer` | T-401 | `api:line-binding`, `ch:line` | `svc:notifications` | DES-013 | 🔒 token/ความลับ | pending |
| T-403 | ช่องทาง Web Push: สร้าง VAPID, endpoint บันทึก/ลบ `PushSubscription`, adapter ส่ง push, ลบ subscription ที่หมดอายุ | `backend-engineer` | T-401, T-101 | `api:push-subscriptions`, `ch:webpush` | `svc:notifications`, `api:auth` | DES-013 | 🔒 ความลับ VAPID | pending |
| T-404 | งานแจ้งเตือน: `NEW_REQUEST` ส่งทันทีที่คำขอใหม่ `PENDING`; `DUE_TODAY` 09:00; `OVERDUE` 17:00 ทุกวันตั้งแต่วันครบกำหนดจนชำระครบ; **ข้อความสรุปเดียวต่อรอบ** รวมทุกสัญญาที่เข้าเงื่อนไข; ส่งทั้งสองช่องทาง | `backend-engineer` | T-402, T-403, T-201, T-304, T-306 | `job:notify-due`, `job:notify-overdue`, `hook:new-request` | `ch:line`, `ch:webpush`, `api:loan-requests`, `api:contract-queries`, `job:scheduler` | DES-013 | — | pending |

- **Acceptance:** `design.md` DES-013; ไม่มีการส่งซ้ำเมื่องานรันซ้ำในวันเดียวกัน; ช่องทางหนึ่งล้มเหลวไม่ทำให้อีกช่องทางหยุด; ผู้ยืมไม่ได้รับแจ้งเตือนใดๆ; ไม่มีข้อความแจ้งล่วงหน้าก่อนวันครบกำหนด
- **Rollback:** ปิดงานแจ้งเตือนผ่านการไม่ลงทะเบียน job (config) หรือ revert โค้ด; `NotificationLog` เก็บไว้
- **Security flag:** 🔒 เพราะต้องเก็บ LINE channel token และ VAPID private key เป็นความลับใน env และต้องไม่รั่วลง log/repository

## Phase 5 — Reports & Borrower API `[backend]`

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-501 | รายงานกำไรขาดทุน: ฐานเงินสดและฐานค้างรับในรายงานเดียว (ดอกเบี้ยรับรู้เต็มในวันครบกำหนด, ค่าปรับรับรู้เมื่อรับเงินจริง), กรองรายเดือน/รายปี/ช่วงวันเอง (Asia/Bangkok), รวมสัญญานำเข้า | `backend-engineer` | T-303, T-306 | `api:report-pnl` | `api:payments`, `api:contract-queries` | DES-015 | — | pending |
| T-502 | รายงานอีก 3 รายการ: ผู้ชำระช้าสุด (นับสัญญาที่ชำระช้า รวมที่เลยกำหนดและยังไม่ชำระ), ยอดคงค้างรวมและจำนวนสัญญาที่เปิดอยู่, สรุปรายผู้ยืม (ครั้งที่ยืม/ชำระช้า/ยอดคงค้าง) | `backend-engineer` | T-306 | `api:report-late`, `api:report-outstanding`, `api:report-borrower-summary` | `api:contract-queries` | DES-015 | — | pending |
| T-503 | API ฝั่งผู้ยืม (กรอง `borrowerId` จากเซสชัน): สถานะคำขอ, สัญญา, ยอดที่ต้องชำระ/วันครบกำหนด/ค่าปรับสะสมหลังมีการจ่ายเงินแล้ว (สัญญา `AWAITING_DISBURSEMENT` ไม่แสดงยอด), ประวัติการยืมและการชำระ, เลขบัญชีของตัวเอง | `backend-engineer` | T-306, T-102 | `api:borrower-portal` | `api:contract-queries`, `api:pdpa`, `lib:borrower-scope` | DES-008, DES-005 | 🔒 การแยกข้อมูลรายผู้ยืม | pending |

- **Acceptance:** `design.md` DES-015 ทั้ง 4 รายงานและ DES-008; ผู้ยืมคนหนึ่งดึงข้อมูลผู้ยืมอีกคนไม่ได้ทุก endpoint; ผลรวมรายงานกำไรขาดทุนฐานเงินสดตรงกับผลรวม `allocatedInterest + allocatedLateFee` ของ `Payment` ในช่วง
- **Rollback:** revert โค้ด (ไม่มีการเขียนข้อมูล)
- **Security flag:** เฟสนี้ไม่ติด 🔒 ทั้งเฟส แต่ T-503 เป็นงานที่ `qa-engineer` ต้องตรวจการแยกข้อมูลรายผู้ยืมเป็นพิเศษ; ถ้าพบช่องโหว่ QA เพิ่ม 🔒 ที่หัวเฟสได้ (เพิ่มได้อย่างเดียว ไม่ลบ)

## Phase 6 — Import `[backend]` 🔒 Security gate

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-601 | นำเข้าขั้นอัปโหลด+ตรวจ: `ADMIN` เท่านั้น, รับ Excel/CSV แม่แบบ 4 คอลัมน์ (ชื่อผู้ยืม, จำนวนเงิน = เงินต้นล้วน, ดอกเบี้ยบวกเพิ่ม ว่าง=0, วันครบกำหนด), จำกัดชนิด/ขนาดไฟล์, ตรวจรายแถวพร้อมเหตุผล, จับคู่ชื่อผู้ยืมตรงตัว (พบคนเดียว → ผูก; ไม่พบ → สร้างครั้งเดียวต่อชื่อ; พบหลายคน → ให้ admin เลือกใน preview), ส่ง preview, endpoint ดาวน์โหลดแม่แบบ | `backend-engineer` | T-103, T-105 | `api:import-preview`, `api:import-template` | `api:borrowers`, `lib:rates` | DES-014 | 🔒 อัปโหลดและ parse ไฟล์ | pending |
| T-602 | นำเข้าขั้นยืนยัน: transaction เดียวภายใต้ `ImportBatch`, สร้างสัญญา `isImported = true` `ACTIVE` ไม่มี `Disbursement`/`LoanRequest`, ไม่คิดดอกเบี้ยเอง, สร้าง `LateFeeAccrual` ย้อนหลังตั้งแต่ `dueDate + 1` ถ้าเลยกำหนดแล้ว, rollback ทั้ง batch ได้เมื่อไม่มีสัญญาในชุดที่มี `Payment` | `backend-engineer` | T-601, T-302, T-104 | `api:import-commit`, `api:import-rollback` | `api:import-preview`, `lib:late-fee`, `lib:audit` | DES-014 | 🔒 เขียนข้อมูลเป็นชุด | pending |

- **Acceptance:** `design.md` DES-014 ทั้ง 6 ข้อ; แถวที่ผิดไม่ถูกนำเข้าและมีเหตุผลรายแถว; ผู้ยืมชื่อเดียวกันหลายสัญญาในไฟล์ผูกเข้าคนเดียวกัน; rollback ทำไม่ได้เมื่อมี `Payment`
- **Rollback:** ใช้ฟังก์ชัน rollback ของ batch (T-602) เป็นกลไกหลัก; revert โค้ดสำหรับตัวฟีเจอร์
- **Security flag:** 🔒 เพราะรับไฟล์จากผู้ใช้เข้า parser และเขียนข้อมูลการเงินเป็นชุด (ความเสี่ยงไฟล์ผิดรูปแบบ/ขนาดใหญ่)
- **การเพิ่ม dependency:** ต้องใช้ไลบรารีอ่าน Excel/CSV — เป็นการเพิ่ม package ใน stack เดิม ไม่ใช่การเปลี่ยน stack; `backend-engineer` เลือกไลบรารีที่ดูแลอยู่และรายงานเหตุผลใน handoff

## Phase 7 — Frontend: Access & Master data `[frontend]`

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-701 | โครงแอป: layout ภาษาไทย, หน้าล็อกอิน, เปลี่ยนรหัสผ่านครั้งแรก, หน้ายอมรับ PDPA ของผู้ยืม, routing/เมนูตามบทบาท, PWA manifest + service worker พื้นฐาน, Zustand store เซสชัน | `frontend-engineer` | T-001, T-101, T-102 | `web:shell`, `web:auth` | `web:skeleton`, `api:auth`, `api:pdpa` | DES-001, DES-002 | — | pending |
| T-702 | หน้า admin: ตั้ง master data (อัตราดอกเบี้ย/ค่าปรับ พร้อมเตือนว่ายังไม่ตั้งค่าจะจ่ายเงินไม่ได้), จัดการผู้ยืม (สร้าง/แก้/ปิด/รีเซ็ตรหัสผ่าน), แสดงเลขบัญชีเฉพาะ admin | `frontend-engineer` | T-701, T-103, T-105 | `web:admin-settings`, `web:admin-borrowers` | `web:shell`, `api:borrowers`, `api:settings` | DES-001, DES-003 | — | pending |

- **Acceptance:** ผู้ใช้เห็นเมนูตามบทบาทเท่านั้น; ผู้ยืมที่ยังไม่ยอมรับ PDPA ถูกพาไปหน้ายอมรับก่อน; ข้อความทั้งหมดเป็นภาษาไทย; ชนิดข้อมูล (type) ได้มาจาก `schema.prisma`/contract ของ API ไม่เดาเอง
- **Rollback:** revert โค้ด `web/`

## Phase 8 — Frontend: Origination & Repayment `[frontend]`

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-801 | หน้าผู้ยืม: ยื่นคำขอ (จำนวนเงิน + วันครบกำหนดที่เลือก), ดูสถานะคำขอ, ดูสัญญา (สัญญา "รอจ่ายเงิน" ไม่แสดงยอด), ยอดที่ต้องชำระ/ค่าปรับสะสม, ประวัติการยืมและการชำระ | `frontend-engineer` | T-701, T-201, T-503 | `web:borrower-portal` | `web:shell`, `api:loan-requests`, `api:borrower-portal` | DES-004, DES-005, DES-008 | — | pending |
| T-802 | หน้า admin: กล่องคำขอ (อนุมัติ/ปฏิเสธพร้อมเหตุผล), สร้างคำขอแทนผู้ยืม, ยกเลิกสัญญา "รอจ่ายเงิน" | `frontend-engineer` | T-701, T-201 | `web:admin-requests` | `web:shell`, `api:loan-requests`, `api:contracts` | DES-004, DES-005 | — | pending |
| T-803 | หน้า admin: รายการสัญญา/รายละเอียด (ยอดที่ต้องชำระ, เลยกำหนด), ฟอร์มบันทึกการจ่ายเงิน (บังคับแนบสลิป), ดูสลิป | `frontend-engineer` | T-802, T-204, T-203, T-306 | `web:admin-contracts`, `web:admin-disbursement` | `web:admin-requests`, `api:disbursements`, `api:slips`, `api:contract-queries` | DES-006, DES-011 | — | pending |
| T-804 | หน้า admin: ฟอร์มบันทึกรับชำระ ("จ่ายเพื่อลดยอดรวมที่ติด" / ชำระครบ), แสดงการตัดยอด, แก้/ลบรายการเดิมพร้อมคำเตือนผลต่อรายงานและการแจ้งเตือนที่ส่งไปแล้ว | `frontend-engineer` | T-803, T-303, T-305 | `web:admin-payments` | `web:admin-contracts`, `api:payments`, `api:record-edit` | DES-007, DES-011, DES-016 | — | pending |

- **Acceptance:** การปฏิเสธจาก backend (จ่ายเกิน ไม่แนบสลิป ยังไม่ตั้งอัตรา) แสดงเป็นข้อความไทยที่เข้าใจได้; ผู้ยืมไม่เห็นข้อมูลผู้ยืมอื่น; ใช้คำ "จ่ายเพื่อลดยอดรวมที่ติด" ตามที่ผู้ใช้เลือก
- **Rollback:** revert โค้ด `web/`

## Phase 9 — Frontend: Reports, Import, Notifications `[frontend]`

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-901 | หน้ารายงาน 4 รายงาน พร้อมตัวกรองรายเดือน/รายปี/ช่วงวันเอง (กำไรขาดทุนแสดงสองฐานข้างกัน) | `frontend-engineer` | T-701, T-501, T-502 | `web:reports` | `web:shell`, `api:report-pnl`, `api:report-late`, `api:report-outstanding`, `api:report-borrower-summary` | DES-015 | — | pending |
| T-902 | หน้านำเข้า: ดาวน์โหลดแม่แบบ, อัปโหลด, preview พร้อมเหตุผลรายแถวและตัวเลือกผู้ยืมเมื่อชื่อซ้ำหลายคน, ยืนยัน, รายการ batch และปุ่ม rollback | `frontend-engineer` | T-701, T-601, T-602 | `web:import` | `web:shell`, `api:import-preview`, `api:import-template`, `api:import-commit`, `api:import-rollback` | DES-014 | — | pending |
| T-903 | หน้าตั้งค่าแจ้งเตือนของ admin: เปิด Web Push (ขอ permission, บันทึก subscription, push handler ใน service worker), ผูก LINE, หน้าแนะนำติดตั้ง PWA บน iPhone (เพิ่มลงหน้าจอหลัก), ปุ่มทดสอบส่ง | `frontend-engineer` | T-701, T-402, T-403 | `web:notification-setup` | `web:shell`, `api:line-binding`, `api:push-subscriptions` | DES-013 | — | pending |

- **Acceptance:** ตัวเลขรายงานในหน้าจอตรงกับค่าที่ API ส่ง (ไม่คำนวณซ้ำฝั่ง client); preview นำเข้าบังคับให้เลือกผู้ยืมก่อนยืนยันเมื่อพบชื่อซ้ำหลายคนในระบบ
- **Rollback:** revert โค้ด `web/`

## Phase 10 — Deploy & Device acceptance `[devops]` 🔒 Security gate

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-1001 | Deploy บนเซิร์ฟเวอร์ในประเทศไทย: HTTPS, PostgreSQL + สำรองข้อมูลและขั้นตอนกู้คืน, ตัวแปรลับ (LINE token, VAPID, ที่เก็บสลิป) นอก repository, process เดียวสำหรับ scheduler (กันงานซ้ำ), runbook migration, ที่เก็บสลิปอยู่ในประเทศไทย | `devops` | T-404, T-602, T-804, T-901, T-902, T-903 | `deploy:runbook`, `env:production` | ทั้งหมด | Risks & Dependencies | 🔒 secrets, ข้อมูลส่วนบุคคล | pending |
| T-1002 | ทดสอบบนอุปกรณ์จริงร่วมกับผู้ใช้: ติดตั้ง PWA บน iPhone แล้วรับ Web Push, รับ LINE จริง, เวลาแจ้งเตือน 09:00/17:00 ตามเวลาไทย, ลำดับ end-to-end (คำขอ → อนุมัติ → จ่ายเงิน → ชำระ → ปิดสัญญา) | `devops` | T-1001, T-903, T-404 | `deploy:acceptance-record` | `env:production`, `web:notification-setup` | DES-013 | — | pending |

- **Acceptance:** `design.md` Risks & Dependencies (Web Push บน iPhone, LINE OA, scheduler, ที่เก็บสลิป, ข้อมูลอ่อนไหว) ได้รับการจัดการครบ; บันทึกผลทดสอบบนอุปกรณ์จริง
- **Rollback:** กลับไปใช้ release ก่อนหน้าและกู้ฐานข้อมูลจากข้อมูลสำรองก่อน deploy; ปิดงาน scheduler ถ้างานคิดค่าปรับทำงานผิด แล้วใช้การตามเก็บย้อนหลังหลังแก้ (idempotent)
- **Security flag:** 🔒 เพราะเป็นข้อมูลส่วนบุคคลและเลขบัญชีถาวร ความลับ และการเปิดสู่อินเทอร์เน็ต

## Phase 11 — Change request CR-1: ผู้ยืมส่งสลิปแจ้งชำระ + ปฏิทิน admin `[backend + frontend]` 🔒

| ID | งาน | Owner | Depends on | Produces | Consumes | Design | Sec | Status |
|---|---|---|---|---|---|---|---|---|
| T-1101 | Backend: ตาราง `PaymentSubmission` (migration เพิ่มอย่างเดียว), ผู้ยืมส่งสลิป (`POST /me/contracts/:id/payment-submissions`, `GET /me/payment-submissions`), คิว admin (`GET /admin/payment-submissions`, `/:id/confirm`, `/:id/reject`) โดย confirm = บันทึกรับชำระจริงใน transaction เดียวกับการยืนยัน, แจ้งเตือน `PAYMENT_SUBMITTED`, `GET /admin/calendar` | `backend-engineer` | T-303, T-403, T-503 | `api:payment-submissions`, `api:calendar` | `api:payments`, `api:slips`, `api:notifier` | DES-017, DES-018 | 🔒 ไฟล์จากผู้ใช้ + แตะบัญชีเงิน | pending |
| T-1102 | Frontend: การ์ด "แจ้งชำระเงิน (ส่งสลิป)" หน้าสัญญาของผู้ยืม, หน้า admin `/admin/payments` (ดูสลิป ยืนยัน/ปฏิเสธ), เตือนในหน้าสัญญา, หน้า admin `/admin/calendar`, เมนู | `frontend-engineer` | T-1101 | `web:payment-submissions`, `web:calendar` | `api:payment-submissions`, `api:calendar` | DES-017, DES-018 | — | pending |

- **Acceptance:** คำแจ้งไม่เปลี่ยนยอดจนกว่า admin ยืนยัน; ยืนยันที่ ledger ปฏิเสธไม่ทิ้งผลค้าง (คำแจ้งยัง `PENDING`); ยืนยัน/ปฏิเสธซ้ำและพร้อมกันได้ผลครั้งเดียว; ผู้ยืมไม่เห็นสลิป/ข้อมูลผู้ยืมอื่น; ปฏิเสธต้องมีเหตุผลที่ผู้ยืมเห็น; ปฏิทินวางสัญญาในวันครบกำหนดและรายการรับชำระในวันรับเงิน โดยตัวเลขมาจาก API
- **Rollback:** revert โค้ด; migration เพิ่มอย่างเดียว (ตาราง/ค่า enum ที่ไม่ใช้ไม่กระทบระบบเดิม)

## Sequencing Notes

**ลำดับหลัก:** Phase 0 → 1 → 2 → 3 → (4, 5, 6 ทำคู่กันได้เมื่อ Phase 3 เสร็จ) → frontend ตามเฟส backend ที่เกี่ยวข้อง → Phase 10 ท้ายสุด ลำดับจริงให้ orchestrator คำนวณจากคอลัมน์ `Depends on` (ไม่เขียนเลข wave ในเอกสารนี้)

**สายที่ขนานได้:** `T-202`, `T-104`, `T-203` เริ่มได้เมื่อ `T-001`/`T-101` เสร็จ ไม่ต้องรอกัน; หลัง Phase 3 เสร็จ Phase 4 (แจ้งเตือน), Phase 5 (รายงาน) และ Phase 6 (นำเข้า) ไม่พึ่งกัน; Phase 7 เริ่มได้ทันทีที่ Phase 1 เสร็จ

**เส้นวิกฤต:** T-001 → T-101 → T-103 → T-201 → T-204 → T-303 → T-306 → T-404 → T-1001 → T-1002

**backend ก่อน frontend:** ทุกงาน frontend มี `Consumes` ที่ชี้ไปยัง `api:*` ของ backend และ `Depends on` ชี้ไปยังงาน backend ที่ผลิต contract นั้น — `frontend-engineer` ห้ามเริ่มงานจนกว่าคอลัมน์ `Produces` ของ backend จะมีอยู่จริงในโค้ด

**Schema:** Data Model ยืนยันแล้วและไม่มีงานใดแก้ schema; ถ้า engineer พบว่าต้องการฟิลด์ที่ไม่มี ให้หยุดและส่งกลับ `system-analyst` ห้ามเพิ่มเอง (`policies/architecture.md` §7)

**ความถูกต้องของเงิน:** `T-202`, `T-301`, `T-302` เป็นไลบรารีบริสุทธิ์ที่มีชุดทดสอบเดี่ยว — เป็นหลักฐานที่ `qa-engineer` ใช้ตรวจ; ตัวอย่างบังคับ: ติด 1,000 = ต้น 800 + ดอก 200 ค่าปรับ 50 จ่าย 300 → ตัด 50, 200, 50; ทุกการคำนวณใช้ `Decimal` ไม่ใช้ `number` และปัดขึ้นเสมอ

**scheduler:** `T-304` สร้างโครงสร้างงานจัดเวลาครั้งเดียว งานแจ้งเตือน (`T-404`) ใช้โครงสร้างเดียวกัน ห้ามสร้างตัวจัดเวลาที่สอง; ต้องกันงานซ้ำเมื่อรันหลาย instance และตามเก็บย้อนหลังได้

**ข้อมูลอ่อนไหวและความลับ:** token, VAPID private key และ credential ของฐานข้อมูลอยู่ใน env เท่านั้น ห้ามอยู่ใน repository หรือ log; รหัสผ่านผู้ใช้แรกของระบบมาจากการตั้งค่าตอน deploy ไม่ฝังในโค้ด

**การเปลี่ยนแปลงภายหลัง (re-plan trigger):** ถ้า `design.md` เปลี่ยน contract/ขอบเขต หรือมีงานใหม่แทรก ให้ `project-manager` amend ด้วย `Edit` และเติม Change Log; ห้าม renumber ID

**ผู้รับช่วงถัดไป:** `setup` (T-001) → `backend-engineer` เฟส 1–6 → `frontend-engineer` เฟส 7–9 → `devops` เฟส 10; `qa-engineer` ตรวจทีละเฟสและเป็นผู้เดียวที่ตั้ง `verified`/`blocked`; `security` ตรวจทุกเฟสที่ติด 🔒; แนะนำให้ผู้ใช้เรียก `test-planner` สำหรับ `test-plan.md` ก่อนเริ่ม Phase 3

## Unresolved Open Questions

**ข้อที่ส่งกลับ `system-analyst` (ช่องว่างของ design — PM ไม่ตัดสินแทน):**

- **Q1 กลไกผูก `lineUserId` ของ admin:** `design.md` ระบุว่าต้องเก็บ `lineUserId` หลังผูกบัญชี แต่ไม่ระบุวิธีผูก (รับ webhook เหตุการณ์ follow จาก LINE OA, หรือ admin กรอก userId เอง) ผลต่อแผน: เฉพาะ `T-402` และ `T-903` — งานอื่นไม่ถูกบล็อก; ข้อเสนอของ PM เพื่อให้ `system-analyst` พิจารณา: ใช้ webhook follow เพราะ admin ไม่ต้องหา userId เอง (ไม่ต้องแก้ Data Model เพราะมี `User.lineUserId` อยู่แล้ว)
- **Q2 DES-003, DES-006, DES-007 ไม่มี contract section แยก:** กฎของ DES-003 (master data) อยู่ในหมายเหตุของ Data Model (`Setting` เป็น `null` จนกว่า admin ตั้ง ห้ามจ่ายเงิน/นำเข้า) และกฎของ DES-006/007 อยู่ใน DES-011 — แผนนี้อ้างตามนั้น ไม่ขวางงาน แต่ `system-analyst` อาจเพิ่มหัวข้อให้ตรวจย้อนได้ง่ายขึ้น

**ข้อที่ต้องให้ผู้ใช้เตรียม/ตัดสินใจก่อนถึงเฟสที่ระบุ (ไม่ขวางเฟส 0–3):**

- **Q3 บัญชี LINE Official Account และ Messaging API:** ผู้ใช้ต้องมี channel และ access token พร้อมตรวจโควตาข้อความตามแพ็กเกจก่อน `T-402`/`T-1002` (สมมติฐานใน requirement ยังไม่ยืนยัน)
- **Q4 เซิร์ฟเวอร์ในประเทศไทย:** ต้องเลือกผู้ให้บริการ/เครื่องที่ deploy ได้ และมีโดเมนพร้อม HTTPS ก่อน `T-1001` (Web Push บน iPhone ต้องใช้ HTTPS)
- **Q5 ที่เก็บไฟล์สลิป:** ค่าเริ่มต้นของแผนคือดิสก์/volume บนเซิร์ฟเวอร์ไทยเดียวกัน เข้าถึงผ่าน API เฉพาะ `ADMIN`; ถ้าผู้ใช้ต้องการที่เก็บอื่น (เช่น object storage ในไทย) ให้บอกก่อน `T-203` — ชั้น storage ถูกออกแบบให้สลับผ่าน env ได้

**ข้อที่ตัดสินที่ประตูตรวจ (ไม่ใช่คำถามถึงผู้ใช้):** การเข้ารหัสฟิลด์ `bankAccountNo` ที่ชั้นแอป — `security` ตัดสินที่ Phase 1 (design มอบให้ประตูตรวจ)

**ตัดออกจากขอบเขต (ห้าม implement ถ้ายังไม่ amend requirement/design):** ผ่อนชำระเป็นงวด, ต่ออายุสัญญา, ปิดก่อนกำหนดแบบลดดอกเบี้ย, ยกเว้นค่าปรับด้วยมือ, แจ้งเตือนผู้ยืม, SMS, ผู้ยืมสมัครบัญชีเอง, เพดานดอกเบี้ยในระบบ, ผลิตภัณฑ์เงินกู้ระยะคงที่, ช่องทางขอแก้/ลบข้อมูลส่วนบุคคลในระบบ, บัญชีเจ้าหน้าที่สินเชื่อ/ผู้อนุมัติแยก, การลบข้อมูลอัตโนมัติ

**ความเสี่ยงที่ผู้ใช้รับเอง (ไม่ขวางแผน):** ไม่มีเพดานดอกเบี้ย/ค่าปรับและคิดค่าปรับซ้อน — เพดาน 15% ต่อปีที่อ้างใน `requirement.md` ยังไม่มีทนายยืนยัน

## Change Log

| วันที่ | การเปลี่ยนแปลง | โดย |
|---|---|---|
| 2026-10-28 | สร้างแผนครั้งแรกจาก `design.md` (Data Model/stack ยืนยันแล้ว, Contract section ปิดครบ): 11 เฟส, `Depends on` และ `Produces`/`Consumes` ครบทุกงาน, ติด 🔒 Security gate ที่เฟส 1, 2, 3, 4, 6, 10; เปิดคำถามส่งกลับ `system-analyst` 2 ข้อ (Q1 ผูก LINE, Q2 contract section ของ DES-003/006/007) และข้อที่ผู้ใช้ต้องเตรียม 3 ข้อ (Q3–Q5) | project-manager |
| 2026-10-30 | เพิ่ม Phase 11 (CR-1) ตามคำสั่งผู้ใช้: T-1101 (backend: ผู้ยืมส่งสลิป, คิวยืนยัน admin, แจ้งเตือน, ปฏิทิน) และ T-1102 (frontend) — Status `pending` (ผู้พัฒนาไม่ตั้ง `verified`) | Claude Code (ผู้พัฒนา) ตามคำสั่งผู้ใช้ PM3 |
| 2026-10-30 | ปรับกฎปัดเศษตาม CR-2 (ปัดขึ้นเป็นบาทเต็ม ไม่ปัดลง) ใน T-202 และไลบรารีค่าปรับ T-302; ไม่เพิ่มงานใหม่ ไม่เปลี่ยนสถานะ (ยังเป็น `pending`) | project-manager |
| 2026-10-30 | เพิ่มเครื่องมือชั่วคราวตามที่ผู้ใช้สั่ง: หน้า `/admin/dev-tests` ปุ่มรันเทสต์อัตโนมัติในเว็บ (เปิดด้วย `DEV_TEST_RUNNER` ตอนพัฒนาเท่านั้น, ห้ามเปิดใน production) — ไม่ใช่ฟีเจอร์ของระบบ ต้องเอาออกก่อน deploy จริง ขั้นตอนใน `DEV-TOOLS-REMOVAL.md`; ไม่เปลี่ยนสถานะงานใดๆ | project-manager |
| 2026-10-31 | เพิ่มงานตาม CR-3 (ผู้ยืมประมาณดอกเบี้ยที่หน้าขอยืม: endpoint `GET /loan-requests/interest-estimate` + กล่องประมาณการใน /me/request) ทำเสร็จและตรวจแล้ว แต่ไม่เปลี่ยนสถานะงานใดๆ (ยังเป็น `pending`) | project-manager |
