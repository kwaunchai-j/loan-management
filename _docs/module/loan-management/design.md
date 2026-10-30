# design — loan-management (ระบบขอยืมเงิน)

> เขียนโดย `system-analyst` จาก `requirement.md` (ปิดการสัมภาษณ์ 15 รอบ เมื่อ 2026-10-27)
> **สถานะ: Data Model และ stack ยืนยันแล้วโดยผู้ใช้ (2026-10-27)** — Contract section (Calculation, Lifecycle & Access, Notification, Import, Report) ปิดครบแล้ว ไม่มีข้อเสนอที่รอยืนยัน และไม่มี Open Questions ที่ต้องให้ผู้ใช้ตัดสินใจค้างอยู่ (ความเสี่ยงด้านกฎหมายที่ผู้ใช้รับเองบันทึกไว้ในหัวข้อ Unresolved Open Questions)
> ข้อที่ผมตัดสินใจแทนเอง (ไม่มีใน requirement) จะติดป้าย `(ข้อเสนอ — รอยืนยัน)` และรวมไว้ใน `## Unresolved Open Questions` — ขณะนี้ไม่มีข้อเหลือ
> ข้อมูลด้านเทคนิคมาจากการออกแบบเท่านั้น ยังไม่ได้ตรวจกับโค้ดจริง เพราะยังไม่มี Target/`schema.prisma` ในโมดูลนี้

## Feasibility Summary

ทำได้ทั้งหมดด้วย stack ที่ทีมมีอยู่ (Node + TypeScript + Express + Zod + Prisma + PostgreSQL + Next.js/React/Tailwind/Zustand แบบ PWA) ตามที่ `project.yaml` ระบุเป็น `current` — **ผู้ใช้ยืนยันใช้ stack นี้แล้ว (2026-10-27) หลังพิจารณาทางเลือก .NET, Python, Java ซึ่ง agent ของทีมยังสร้างไม่ได้**

ความเสี่ยงหลักมี 3 เรื่อง: (1) การแจ้งเตือนไปโทรศัพท์ผ่าน LINE Official Account และ Web Push ต้องมีบัญชี LINE OA และบน iPhone ต้องติดตั้งเว็บเป็นแอปหน้าจอหลัก (PWA) จึงจะรับ Web Push ได้; (2) ค่าปรับคิดซ้อนรายวันไม่มีเพดาน ยอดโตเร็วและผู้ใช้เลือกรับความเสี่ยงทางกฎหมายเอง; (3) การนำเข้าสัญญาเก่าต้องมีคอลัมน์ดอกเบี้ยในไฟล์เพื่อให้รายงานกำไรขาดทุนนับรายได้ได้ (ผู้ใช้ตัดสินแล้ว — ต้องให้ `business-analyst` amend F10)

ผู้ใช้ที่ล็อกอินจริงใน MVP มี 2 กลุ่มเท่านั้น คือ `ADMIN` (ผู้ดูแลระบบ = เจ้าหน้าที่สินเชื่อ = ผู้อนุมัติ) และ `BORROWER`

## Feature-by-Feature Feasibility

| Feature (requirement) | ผลประเมิน | Design ID | หมายเหตุที่ design รับรอง |
|---|---|---|---|
| F1 บัญชีผู้ใช้และสิทธิ์ | ทำได้ | DES-001, DES-002 | admin สร้างบัญชีผู้ยืม; username + รหัสผ่าน; admin รีเซ็ตรหัสผ่าน; ผู้ยืมต้องกดยอมรับ PDPA ก่อนใช้งาน |
| F2 Master data | ทำได้ | DES-003 | อัตราดอกเบี้ย % ต่อเดือน และค่าปรับ % ต่อวัน เป็นค่าเดียวทั้งระบบ ไม่ฝังตัวเลขในโค้ด |
| F3 คำขอยืมเงิน | ทำได้ | DES-004 | ผู้ยืมกรอกจำนวนเงิน + วันครบกำหนดที่เลือกเอง; admin ยื่นแทนและอนุมัติเองได้ |
| F4 สัญญาและยอดที่ต้องชำระ | ทำได้ | DES-005, DES-010 | ดอกเบี้ยคิดตอนบันทึกการจ่ายเงิน; สถานะ "รอจ่ายเงิน" ไม่แสดงยอด |
| F5 จ่ายเงินและรับชำระ | ทำได้ | DES-006, DES-007, DES-011 | จ่ายเท่าที่ขอเสมอ; รับชำระก้อนเดียวหรือจ่ายเพื่อลดยอดรวมที่ติด ก่อนหรือหลังเลยกำหนดได้; ดอกเบี้ยไม่ลด |
| F6 ค่าปรับ | ทำได้ | DES-012 | คิดซ้อนรายวันจากเงินคงเหลือ + ค่าปรับสะสม ไม่มีเพดาน; รวมค่าปรับของวันที่ชำระครบ แล้วหยุดวันถัดไป |
| F7 แจ้งเตือน admin | ทำได้ (มีเงื่อนไข) | DES-013 | LINE OA + Web Push; 09:00 วันครบกำหนด, 17:00 ทุกวันจนกว่าจะชำระครบ; ต้องมีบัญชี LINE OA และ PWA บน iPhone |
| F8 ประวัติผู้ยืม | ทำได้ | DES-008 | ผู้ยืมเห็นเฉพาะของตัวเอง; admin เห็นทั้งหมด |
| F9 รายงาน 4 รายงาน | ทำได้ | DES-015 | ฐานเงินสดและฐานค้างรับในรายงานเดียว; กรองรายเดือน/รายปี/ช่วงวันเอง |
| F10 นำเข้า Excel/CSV | ทำได้ (มีข้อค้าง) | DES-014 | ไฟล์มีคอลัมน์ดอกเบี้ย ไม่คิดดอกเบี้ยเพิ่ม คิดค่าปรับย้อนหลัง; rollback ด้วย batch id |

## Data Model

> ยืนยันแล้วหรือไม่: **ยืนยันแล้วโดยผู้ใช้ PM3 เมื่อ 2026-10-27 (แก้ภายหลัง 1 จุด: `Disbursement.slipFileKey` เปลี่ยนจาก nullable เป็นบังคับ ตามคำตอบของผู้ใช้ "บังคับแนบทุกครั้ง" — ดู Change Log)** — ส่วนนี้คือสัญญาที่ `setup` และ `backend-engineer` ต้อง implement ตามตัวอักษร (`policies/architecture.md` §7); การแก้ไขภายหลังต้องผ่าน `system-analyst` และขอยืนยันใหม่

หลักการ: เงินทั้งหมดใช้ `Decimal(14,2)`; อัตราใช้ `Decimal(7,4)`; วันที่ครบกำหนด/วันจ่าย/วันรับชำระเป็น `@db.Date` ตามเขตเวลา Asia/Bangkok; สถานะ "เลยกำหนด" **ไม่เก็บเป็นสถานะ** แต่คำนวณจาก `dueDate` และยอดคงเหลือ (กันข้อมูลคลาดเคลื่อนเมื่อ job พลาด); ยอดคงเหลือที่เก็บบน `Contract` เป็นค่า denormalize ที่ต้องอัปเดตใน transaction เดียวกับ `Payment`/`LateFeeAccrual` และสร้างใหม่ได้จากสองตารางนั้น

```prisma
enum Role {
  ADMIN
  BORROWER
}

enum LoanRequestStatus {
  PENDING
  APPROVED
  REJECTED
  CANCELLED
}

enum ContractStatus {
  AWAITING_DISBURSEMENT
  ACTIVE
  CLOSED
  CANCELLED
}

enum NotificationType {
  NEW_REQUEST
  DUE_TODAY
  OVERDUE
}

enum NotificationChannel {
  LINE
  WEB_PUSH
}

enum NotificationStatus {
  PENDING
  SENT
  FAILED
}

enum ImportBatchStatus {
  COMPLETED
  ROLLED_BACK
}

model User {
  id                 String   @id @default(cuid())
  username           String   @unique
  passwordHash       String
  role               Role
  isActive           Boolean  @default(true)
  mustChangePassword Boolean  @default(true)
  lineUserId         String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  borrower           Borrower?
  loanRequestsCreated LoanRequest[] @relation("RequestCreatedBy")
  loanRequestsDecided LoanRequest[] @relation("RequestDecidedBy")
  disbursementsRecorded Disbursement[]
  paymentsRecorded   Payment[]
  importBatches      ImportBatch[]
  pushSubscriptions  PushSubscription[]
  auditLogs          AuditLog[]
  settingsUpdated    Setting[]
}

model Borrower {
  id             String    @id @default(cuid())
  userId         String?   @unique
  fullName       String
  phone          String?
  bankName       String?
  bankAccountNo  String?
  pdpaAcceptedAt DateTime?
  pdpaVersion    String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  user           User?     @relation(fields: [userId], references: [id])
  loanRequests   LoanRequest[]
  contracts      Contract[]

  @@index([fullName])
}

model Setting {
  id                       Int      @id @default(1)
  interestRatePctPerMonth  Decimal? @db.Decimal(7, 4)
  lateFeeRatePctPerDay     Decimal? @db.Decimal(7, 4)
  updatedById              String?
  updatedAt                DateTime @updatedAt

  updatedBy                User?    @relation(fields: [updatedById], references: [id])
}

model LoanRequest {
  id               String            @id @default(cuid())
  borrowerId       String
  amount           Decimal           @db.Decimal(14, 2)
  requestedDueDate DateTime          @db.Date
  status           LoanRequestStatus @default(PENDING)
  createdById      String
  decidedById      String?
  decidedAt        DateTime?
  rejectReason     String?
  createdAt        DateTime          @default(now())

  borrower         Borrower          @relation(fields: [borrowerId], references: [id])
  createdBy        User              @relation("RequestCreatedBy", fields: [createdById], references: [id])
  decidedBy        User?             @relation("RequestDecidedBy", fields: [decidedById], references: [id])
  contract         Contract?

  @@index([borrowerId])
  @@index([status])
}

model Contract {
  id                      String         @id @default(cuid())
  contractNo              String         @unique
  borrowerId              String
  loanRequestId           String?        @unique
  principal               Decimal        @db.Decimal(14, 2)
  dueDate                 DateTime       @db.Date
  status                  ContractStatus @default(AWAITING_DISBURSEMENT)
  disbursedOn             DateTime?      @db.Date
  interestRatePctPerMonth Decimal?       @db.Decimal(7, 4)
  lateFeeRatePctPerDay    Decimal?       @db.Decimal(7, 4)
  interestAmount          Decimal?       @db.Decimal(14, 2)
  outstandingPrincipal    Decimal        @db.Decimal(14, 2)
  outstandingInterest     Decimal        @default(0) @db.Decimal(14, 2)
  accruedLateFee          Decimal        @default(0) @db.Decimal(14, 2)
  closedOn                DateTime?      @db.Date
  isImported              Boolean        @default(false)
  importBatchId           String?
  createdAt               DateTime       @default(now())
  updatedAt               DateTime       @updatedAt

  borrower                Borrower       @relation(fields: [borrowerId], references: [id])
  loanRequest             LoanRequest?   @relation(fields: [loanRequestId], references: [id])
  importBatch             ImportBatch?   @relation(fields: [importBatchId], references: [id])
  disbursement            Disbursement?
  payments                Payment[]
  lateFeeAccruals         LateFeeAccrual[]
  notifications           NotificationLog[]

  @@index([borrowerId])
  @@index([status, dueDate])
  @@index([importBatchId])
}

model Disbursement {
  id           String   @id @default(cuid())
  contractId   String   @unique
  amount       Decimal  @db.Decimal(14, 2)
  paidOn       DateTime @db.Date
  slipFileKey  String
  note         String?
  recordedById String
  createdAt    DateTime @default(now())

  contract     Contract @relation(fields: [contractId], references: [id])
  recordedBy   User     @relation(fields: [recordedById], references: [id])
}

model Payment {
  id                 String   @id @default(cuid())
  contractId         String
  amount             Decimal  @db.Decimal(14, 2)
  paidOn             DateTime @db.Date
  allocatedLateFee   Decimal  @default(0) @db.Decimal(14, 2)
  allocatedInterest  Decimal  @default(0) @db.Decimal(14, 2)
  allocatedPrincipal Decimal  @default(0) @db.Decimal(14, 2)
  note               String?
  recordedById       String
  createdAt          DateTime @default(now())

  contract           Contract @relation(fields: [contractId], references: [id])
  recordedBy         User     @relation(fields: [recordedById], references: [id])

  @@index([contractId, paidOn])
  @@index([paidOn])
}

model LateFeeAccrual {
  id           String   @id @default(cuid())
  contractId   String
  accrualDate  DateTime @db.Date
  baseAmount   Decimal  @db.Decimal(14, 2)
  ratePctPerDay Decimal @db.Decimal(7, 4)
  amount       Decimal  @db.Decimal(14, 2)
  createdAt    DateTime @default(now())

  contract     Contract @relation(fields: [contractId], references: [id])

  @@unique([contractId, accrualDate])
}

model NotificationLog {
  id            String              @id @default(cuid())
  dedupeKey     String              @unique
  type          NotificationType
  channel       NotificationChannel
  contractId    String?
  scheduledDate DateTime            @db.Date
  status        NotificationStatus  @default(PENDING)
  attempts      Int                 @default(0)
  sentAt        DateTime?
  error         String?
  createdAt     DateTime            @default(now())

  contract      Contract?           @relation(fields: [contractId], references: [id])

  @@index([type, scheduledDate])
}

model PushSubscription {
  id        String   @id @default(cuid())
  userId    String
  endpoint  String   @unique
  p256dh    String
  auth      String
  createdAt DateTime @default(now())

  user      User     @relation(fields: [userId], references: [id])
}

model ImportBatch {
  id           String            @id @default(cuid())
  fileName     String
  importedById String
  rowCount     Int
  status       ImportBatchStatus @default(COMPLETED)
  rolledBackAt DateTime?
  createdAt    DateTime          @default(now())

  importedBy   User              @relation(fields: [importedById], references: [id])
  contracts    Contract[]
}

model AuditLog {
  id         String   @id @default(cuid())
  actorId    String?
  action     String
  entityType String
  entityId   String
  detail     Json?
  createdAt  DateTime @default(now())

  actor      User?    @relation(fields: [actorId], references: [id])

  @@index([entityType, entityId])
  @@index([createdAt])
}
```

**ข้อสังเกตของ Data Model**
- `Setting` เป็นแถวเดียว (`id = 1`) และ `interestRatePctPerMonth`/`lateFeeRatePctPerDay` เป็น `null` จนกว่า admin จะตั้งค่า — ระบบต้องไม่จ่ายเงิน/สร้างสัญญาใช้ยอดคำนวณจนกว่าจะตั้งค่า (ผู้ใช้ไม่ให้ตัวเลขเริ่มต้น)
- `Contract.interestRatePctPerMonth` และ `lateFeeRatePctPerDay` เป็น snapshot ณ วันบันทึกการจ่ายเงิน — สัญญาที่มีอยู่ใช้อัตราเดิมที่ล็อกไว้ (ยืนยันแล้ว); สัญญานำเข้าเก็บ `interestRatePctPerMonth` เป็น `null` และ snapshot เฉพาะอัตราค่าปรับ ณ วันนำเข้า
- `Contract.interestAmount` เป็น `null` ตอน `AWAITING_DISBURSEMENT` เพื่อบังคับ "ยังไม่แสดงยอดชำระ" ที่ชั้นข้อมูล
- `Borrower.userId` เป็น nullable เพราะผู้ยืมที่นำเข้าจากไฟล์มีเพียงชื่อ ยังไม่มีบัญชีล็อกอิน; `phone`/`bankName`/`bankAccountNo` เป็น nullable ด้วยเหตุเดียวกัน แต่การสร้างผู้ยืมผ่านหน้า admin ต้องบังคับกรอก (DES-001)
- `Disbursement.slipFileKey` เป็นฟิลด์บังคับ (ยืนยันแล้ว: ต้องแนบสลิปทุกครั้งที่บันทึกจ่ายเงิน); ไฟล์สลิปเก็บบนเซิร์ฟเวอร์ในประเทศไทย
- เพิ่ม `AuditLog` เพราะระบบเงินต้องย้อนดูได้ว่าใครบันทึกอะไร (ไม่ได้ระบุใน requirement — เป็นส่วนเสริมของ design; ถ้าผู้ใช้ไม่ต้องการ ตัดทิ้งได้โดยไม่กระทบกฎอื่น)
- การเปลี่ยนแปลง: ทุกโมเดลเป็นโมเดลใหม่ทั้งหมด (additive) ไม่มี breaking

**CR-1 (เพิ่มภายหลัง 2026-10-30 โดยผู้ใช้ยืนยัน) — ตารางใหม่ `PaymentSubmission` และค่า enum ใหม่ `NotificationType.PAYMENT_SUBMITTED`** — เพิ่มอย่างเดียว ไม่แก้ตารางหรือคอลัมน์เดิม (migration `payment_submission`):

```prisma
enum PaymentSubmissionStatus { PENDING CONFIRMED REJECTED }

model PaymentSubmission {
  id           String                  @id @default(cuid())
  contractId   String
  borrowerId   String
  amount       Decimal                 @db.Decimal(14, 2)   // ยอดที่ผู้ยืม "แจ้ง" (เป็นแค่คำแจ้ง)
  paidOn       DateTime                @db.Date
  slipFileKey  String                  @unique              // สลิปใช้ได้ครั้งเดียว; เปิดดูได้เฉพาะ ADMIN
  note         String?
  status       PaymentSubmissionStatus @default(PENDING)
  rejectReason String?                                      // ผู้ยืมเห็น
  decidedById  String?
  decidedAt    DateTime?
  paymentId    String?                 @unique              // Payment จริงที่เกิดจากการยืนยัน (ลบ Payment ภายหลัง → ล้างลิงก์ คงสถานะ CONFIRMED)
  createdAt    DateTime                @default(now())
}
```

## Calculation Rules

กฎทั้งหมดนี้เป็น normative; Design ID ใช้อ้างใน `plan.md` และ `test-plan`

**DES-010 ดอกเบี้ย (อ้าง F4)**
- Input: `principal`, `Setting.interestRatePctPerMonth`, `disbursedOn`, `dueDate`
- `days = dueDate − disbursedOn` เป็นจำนวนวันตามปฏิทิน (Asia/Bangkok); ต้อง `days ≥ 1` มิฉะนั้นปฏิเสธการบันทึกจ่ายเงิน
- `interestAmount = round_up(principal × rate / 100 × days / 30, 0)` — **ปัดขึ้นเป็นบาทเต็มเสมอ** (CR-2, ผู้ใช้ยืนยัน "ปัดขึ้นอย่างเดียวไม่ปัดลง"; ปัดขึ้นเมื่อมีเศษสตางค์ใดๆ ไม่ใช่ half-up; ค่าที่เป็นบาทเต็มอยู่แล้วไม่เปลี่ยน) — ผลรวมที่ต้องชำระจึงเป็นบาทเต็มเมื่อเงินต้นเป็นบาทเต็ม
- Output: ตั้ง `interestAmount`, `outstandingInterest = interestAmount`, `outstandingPrincipal = principal`, `status = ACTIVE`, snapshot อัตราดอกเบี้ยและอัตราค่าปรับลงสัญญา
- ดอกเบี้ย **คงที่** ไม่เปลี่ยนตามการชำระบางส่วนหรือการชำระก่อนกำหนด
- `ยอดที่ต้องชำระ ณ วัน D = outstandingPrincipal + outstandingInterest + accruedLateFee` โดย `accruedLateFee` รวมค่าปรับของวัน D แล้วเมื่อ `D > dueDate` (DES-012) (คำนวณ ไม่เก็บ)

**DES-011 การจ่ายเงินให้ผู้ยืมและการรับชำระ (อ้าง F5)**
- Disbursement: ทำได้เมื่อสัญญา `AWAITING_DISBURSEMENT` เท่านั้น; `amount` ต้องเท่ากับ `principal` เสมอ; **ต้องแนบไฟล์สลิป** (ไม่แนบ = ปฏิเสธการบันทึก); `paidOn` ย้อนหลังได้ (ยืนยันแล้ว); ผู้บันทึกต้องเป็น `ADMIN`; บันทึกสำเร็จแล้วเรียก DES-010 ใน transaction เดียวกัน
- Payment: ทำได้เมื่อสัญญา `ACTIVE`; `0 < amount ≤ ยอดที่ต้องชำระ ณ วันที่บันทึก` — **ห้ามจ่ายเกิน ระบบปฏิเสธ** (ยืนยันแล้ว); ทำได้ทั้งก่อนและหลังเลยกำหนด; `paidOn` ย้อนหลังได้ แต่ไม่ก่อน `disbursedOn` และไม่เป็นวันในอนาคต (ยืนยันแล้ว)
- **ลำดับตัดยอด:** ค่าปรับสะสม (`accruedLateFee`) → ดอกเบี้ย (`outstandingInterest`) → เงินต้น (`outstandingPrincipal`); บันทึกส่วนที่ตัดลง `allocatedLateFee/Interest/Principal` และลดยอดบนสัญญาใน transaction เดียวกัน
- เมื่อยอดที่ต้องชำระเป็น 0: `status = CLOSED`, `closedOn = paidOn`
- ตัวอย่างประกอบ (ไม่ใช่นิยาม): ติด 1,000 = ต้น 800 + ดอก 200 ค่าปรับ 50 จ่าย 300 → ตัดค่าปรับ 50, ดอก 200, ต้น 50

**DES-012 ค่าปรับ (อ้าง F6)**
- ค่าปรับของวัน `D` (เมื่อ `D > dueDate`) สร้างเป็น `LateFeeAccrual` **ต้นวัน D** (งาน 00:05 Asia/Bangkok และคิดเมื่อจำเป็นตอนมีการดึงยอดหรือบันทึกรับชำระของวัน D ถ้างานยังไม่ได้รัน) สำหรับทุกสัญญา `ACTIVE` ที่ยังมียอดค้างเมื่อสิ้นวัน D−1
- `baseAmount = outstandingPrincipal + outstandingInterest + accruedLateFee` ณ สิ้นวัน D−1 (คิดซ้อน); `amount = round_up(baseAmount × ratePctPerDay / 100, 0)` (**ปัดขึ้นเป็นบาทเต็มเสมอ** — CR-2; ค่าปรับแต่ละวันเป็นบาทเต็ม ฐานของวันถัดไปจึงรวมค่าปรับที่ปัดแล้ว); ใช้อัตราที่ snapshot ในสัญญา; หลังสร้างแถวแล้วเพิ่ม `accruedLateFee`
- ผลที่ตามมา: (ก) **ค่าปรับของวันที่บันทึกชำระครบทั้งก้อนยังคิดด้วย** (ยืนยันแล้ว) เพราะยอดที่ต้องชำระของวันนั้นรวมค่าปรับของวันนั้นแล้ว และหยุดคิดตั้งแต่วันถัดไป; (ข) การจ่ายเพื่อลดยอดรวมที่ติดที่บันทึกในวัน D ลดฐานที่ใช้คิดค่าปรับของวัน D+1 เป็นต้นไป ตามหลักการที่ผู้ใช้ยืนยัน "ค่าปรับคิดจากหนี้คงเหลือ ณ ปัจจุบัน" (ค่าปรับแต่ละวันคิดจากหนี้คงเหลือ ณ เวลาที่คิดของวันนั้น)
- งานต้อง idempotent (`@@unique([contractId, accrualDate])`) และตามเก็บวันที่ตกหล่นย้อนหลังได้
- ไม่มีเพดาน ไม่มีการตรวจเพดานดอกเบี้ย (ผู้ใช้รับผิดชอบเอง)

**สถานะที่คำนวณ:** `เลยกำหนด = status ACTIVE และ dueDate < วันนี้`; `ชำระช้า (ใช้ในรายงาน) = (closedOn > dueDate) หรือ เลยกำหนด`

**DES-016 การแก้ไขและลบรายการเดิม (อ้าง F5)** — ผู้ใช้ยืนยัน: แก้ไขรายการจ่ายเงิน/รับชำระเดิมได้โดยตรง และ `ADMIN` ลบรายการได้ โดยระบบคำนวณสัญญาใหม่
- ผู้ทำ: `ADMIN` เท่านั้น; ฟิลด์ที่แก้ได้: `Payment` (`amount`, `paidOn`, `note`), `Disbursement` (`paidOn`, `slipFileKey`, `note`; `amount` ต้องเท่ากับ `principal` เสมอจึงแก้ไม่ได้)
- หลังแก้หรือลบ ระบบ **คำนวณสัญญาใหม่ทั้งสัญญาใน transaction เดียว**: (1) ถ้า `disbursedOn` เปลี่ยน คำนวณดอกเบี้ยใหม่ตาม DES-010 (สัญญานำเข้าไม่คำนวณดอกเบี้ย); (2) ลบ `LateFeeAccrual` ทั้งหมดของสัญญาแล้วสร้างใหม่ตั้งแต่ `dueDate + 1` ถึงวันนี้ (หรือถึงวันที่ชำระครบ) ตามกฎ DES-012 โดย replay `Payment` ทั้งหมดเรียงตาม `paidOn` แล้ว `createdAt`; (3) คำนวณ `allocatedLateFee/Interest/Principal` ของทุกรายการ, `outstanding*`, `accruedLateFee`, `status`, `closedOn` ใหม่ (สัญญา `CLOSED` เปิดกลับเป็น `ACTIVE` ได้ถ้าผลคำนวณมียอดค้าง)
- ปฏิเสธการแก้หรือลบที่ทำให้ผลไม่ถูกต้อง เช่น การรับชำระรายการใดเกินยอดที่ติดตอน replay หรือ `paidOn` ก่อน `disbursedOn`
- บันทึก `AuditLog` ทุกครั้ง พร้อมค่าก่อน/หลัง (JSON) ของรายการและผลต่อยอดสัญญา — Data Model ไม่มี `updatedAt` ของรายการ ประวัติการแก้อยู่ใน `AuditLog` เท่านั้น
- ผลข้างเคียงที่ผู้ใช้ต้องรู้: รายงานของช่วงเวลาที่ผ่านมาแล้วเปลี่ยนตามการแก้; การแจ้งเตือนที่ส่งไปแล้วไม่ถูกเรียกคืน
- **การลบ (ยืนยันแล้ว: ลบได้โดย `ADMIN` และคำนวณสัญญาใหม่):** ลบ `Payment` ได้ → hard delete แล้วคำนวณสัญญาใหม่ตามขั้นตอนข้างบน (สัญญา `CLOSED` เปิดกลับเป็น `ACTIVE` ได้ถ้ามียอดค้าง); `AuditLog` เก็บสำเนาทั้งแถวของรายการที่ลบไว้ใน `detail.before` — **ไม่ต้องเพิ่มฟิลด์ soft-delete ใน Data Model**
- ลบ `Disbursement` (ผู้ใช้สั่งให้ปิดข้อค้างตามร่าง — 2026-10-27): ทำได้เมื่อสัญญาไม่เหลือ `Payment` เท่านั้น (ต้องลบรายการรับชำระก่อน) ผลคือสัญญากลับเป็น `AWAITING_DISBURSEMENT` ล้าง `disbursedOn`, `interestAmount`, snapshot อัตรา, `outstandingInterest`, `accruedLateFee`, `closedOn` และลบ `LateFeeAccrual` ทั้งหมด; สัญญานำเข้า (`isImported`) ไม่มี `Disbursement` จึงไม่ใช้กฎนี้

## Contract Lifecycle & Access Rules

**DES-004/005 วงจรคำขอและสัญญา**
- `LoanRequest.PENDING` → `APPROVED` (สร้าง `Contract` สถานะ `AWAITING_DISBURSEMENT` โดย `principal = amount`, `dueDate = requestedDueDate`) หรือ `REJECTED` (พร้อมเหตุผล) หรือ `CANCELLED`
- ผู้ยืมสร้างคำขอได้เฉพาะของตัวเอง: กรอก `amount` และ `requestedDueDate` เท่านั้น (`requestedDueDate` ต้องเป็นวันอนาคต); `ADMIN` สร้างแทนผู้ยืมและอนุมัติเองได้ (ไม่มีกฎแยกหน้าที่)
- สัญญา `AWAITING_DISBURSEMENT` ไม่หมดอายุ; `ADMIN` ยกเลิกได้ (`CANCELLED`) ตราบที่ยังไม่มี `Disbursement`; ไม่แสดงยอดชำระแก่ผู้ยืม

**DES-001/002/008 การเข้าถึง**
- `ADMIN`: ทำได้ทุกอย่าง รวมสร้างบัญชีผู้ยืม ตั้ง master data บันทึกจ่ายเงิน/รับชำระ นำเข้า รายงาน ดูเลขบัญชีผู้ยืม รีเซ็ตรหัสผ่านผู้ยืม
- `BORROWER`: ล็อกอินด้วย username; **ต้องยอมรับเงื่อนไข PDPA (บันทึก `pdpaAcceptedAt`, `pdpaVersion`) ก่อนเข้าถึงข้อมูลใดๆ**; เห็นเฉพาะข้อมูลของตัวเอง ได้แก่ สถานะคำขอ, ยอดที่ต้องชำระ/วันครบกำหนด/ค่าปรับสะสม (หลังมีการจ่ายเงินแล้ว), ประวัติการยืมและการชำระ; เห็นเลขบัญชีของตัวเองได้
- ทุก endpoint ฝั่งผู้ยืมต้องกรอง `borrowerId` จากเซสชัน ห้ามรับ `borrowerId` จาก client
- ไม่มีช่องทางขอแก้/ลบข้อมูลส่วนบุคคลในระบบ; เก็บข้อมูลถาวร; เซิร์ฟเวอร์ในประเทศไทย

**DES-017 ผู้ยืมแจ้งชำระพร้อมสลิป (CR-1; อ้าง F5-CR1)**
- ผู้ยืมส่งได้เฉพาะสัญญาของตนที่ `ACTIVE`: `amount` (>0, ทศนิยม ≤ 2), `paidOn` (ไม่ใช่อนาคต, ไม่ก่อน `disbursedOn`), ไฟล์สลิป JPEG/PNG (ตัดสินจากไบต์, ≤ 5 MB), `note` ไม่บังคับ; `borrowerId` มาจากเซสชันเท่านั้น; สัญญาของคนอื่นตอบ "ไม่พบ"
- คำแจ้ง **ไม่เปลี่ยนยอดใดๆ** (ไม่มี `Payment`, ไม่คำนวณสัญญาใหม่) สถานะเริ่มต้น `PENDING`; รอตรวจพร้อมกันได้ ≤ 5 รายการต่อผู้ยืม (กันดันที่เก็บไฟล์) บังคับด้วย lock แถวผู้ยืม
- admin **ยืนยัน**: ใน transaction เดียว — lock สัญญา → เปลี่ยน `PENDING→CONFIRMED` (ครั้งเดียว) → บันทึก `Payment` ด้วยโค้ดชุดเดียวกับ DES-011 (admin แก้ `amount`/`paidOn`/`note` ก่อนได้) → ผูก `paymentId` → `AuditLog`; ถ้า ledger ปฏิเสธ (เกินยอดที่ติด, ก่อนวันจ่ายเงิน, สัญญาปิดแล้ว) ทั้ง transaction ย้อนกลับและคำแจ้งยังเป็น `PENDING`
- admin **ปฏิเสธ**: ต้องมีเหตุผล (ผู้ยืมเห็น) `PENDING→REJECTED`; คำแจ้งที่ตัดสินแล้วตัดสินซ้ำไม่ได้ (409); ผู้ยืมส่งคำแจ้งใหม่ได้
- สลิปที่ผู้ยืมส่งเปิดดูได้เฉพาะ `ADMIN` (endpoint เดิม `/admin/slips/:key`); ผู้ยืมไม่ได้รับ key กลับมา; ถ้าบันทึกคำแจ้งไม่สำเร็จ ไฟล์ที่เพิ่งเก็บถูกลบ
- ผู้ยืมดูสถานะคำแจ้งของตนได้ (`GET /me/payment-submissions`); admin ดูคิวที่ `GET /admin/payment-submissions` (รอตรวจเรียงเก่าสุดก่อน)

**DES-018 ปฏิทิน admin (CR-1; อ้าง F11)**
- `GET /admin/calendar?month=YYYY-MM` (ADMIN เท่านั้น): ต่อวัน — `due` = สัญญา `ACTIVE`/`CLOSED` ที่ `dueDate` ตรงวันนั้น (สัญญาที่ยังไม่จ่ายเงินหรือยกเลิกไม่อยู่ในปฏิทิน) พร้อมยอดที่ค้าง ณ วันนี้ (คำนวณจาก ledger เดียวกับหน้าสัญญา) และ `isOverdue/daysOverdue`; `paid` = `Payment` ที่ `paidOn` ตรงวันนั้น; ผลรวมต่อวันคำนวณฝั่ง API (หน้าเว็บไม่บวกเลขเอง); เกินเพดาน 2,000 สัญญา/5,000 รายการต่อเดือนจะแจ้ง `truncated`

**DES-019 ผู้ยืมดูดอกเบี้ยโดยประมาณ (CR-3; อ้าง F3)**
- `GET /loan-requests/interest-estimate?amount=<บาท>[&dueDate=YYYY-MM-DD]` — เฉพาะผู้ยืมที่ยอมรับ PDPA แล้ว (เหมือนทุก endpoint ฝั่งผู้ยืม: ผู้เยี่ยมชม 401, admin 403); เป็นการคำนวณล้วน **ไม่บันทึกข้อมูล ไม่เขียน AuditLog ไม่แจ้งเตือน**
- ใช้สูตรและฟังก์ชันเดียวกับสัญญาจริง (DES-010: `computeInterestForDays`, ปัดขึ้นเป็นบาทเต็ม) กับอัตราใน `Setting` (ไม่ hard-code); วันเริ่มนับสมมติเป็น **วันนี้ (Asia/Bangkok)** เพราะวันโอนจริงยังไม่รู้ — จึงเป็น **ประมาณการ** (`isEstimate: true`) ดอกเบี้ยจริงนับจากวันที่ผู้ให้กู้โอนเงินจริง
- ไม่ส่ง `dueDate` = คิดตามมาตรฐาน 30 วัน (`daysAssumed: true`); ส่ง `dueDate` = วันนี้ถึงวันครบกำหนด (ต้องเป็นอนาคต มิฉะนั้น 400 `DUE_DATE_NOT_FUTURE`); ช่อง `dueDate` ว่างถือเป็นไม่ส่ง
- ตอบ `interestAmount`, `totalToRepay` (= เงินต้น + ดอกเบี้ย), `days`, `interestRatePctPerMonth`; ค่าปรับไม่รวม (เกิดเมื่อชำระช้าเท่านั้น)
- ยังไม่ตั้งอัตรา → 409 `RATES_NOT_SET` ด้วยข้อความที่ผู้ยืมทำตามได้ ("กรุณาติดต่อผู้ให้กู้"); ยอดที่ผลลัพธ์เกิน Decimal(14,2) → 400 `LIMIT_EXCEEDED`
- หน้า `/me/request` แสดงกล่อง "ดอกเบี้ยโดยประมาณ" ใต้ช่องจำนวนเงินทันทีที่กรอกจำนวนเงินถูกต้อง (หน่วงเวลาพิมพ์ 400 มิลลิวินาที); Data Model ไม่เปลี่ยน

## Notification Rules

**DES-013 (อ้าง F7)** ผู้รับคือ `ADMIN` เพียงคนเดียว ผ่าน LINE (Messaging API push ไปที่ `User.lineUserId`) และ Web Push (`PushSubscription`) ทั้งสองช่องทาง; ผู้ยืมไม่ได้รับแจ้งเตือนใดๆ
- `NEW_REQUEST`: ส่งทันทีที่มีคำขอใหม่สถานะ `PENDING` (ยืนยันแล้ว)
- `PAYMENT_SUBMITTED` (CR-1): ส่งทันทีที่ผู้ยืมส่งสลิปแจ้งชำระ (ชื่อผู้ยืม, เลขสัญญา, ยอดที่แจ้ง, วันที่โอน); push ชี้ไปหน้า `/admin/payments`; ไม่ส่งสำหรับคำแจ้งที่ตัดสินแล้ว
- `DUE_TODAY`: งานเวลา **09:00** Asia/Bangkok — สัญญา `ACTIVE` ที่ `dueDate = วันนี้` และยังมียอดค้าง
- `OVERDUE`: งานเวลา **17:00** Asia/Bangkok **ทุกวัน** — สัญญา `ACTIVE` ที่ `dueDate ≤ วันนี้` และยังมียอดค้าง ณ 17:00 ส่งซ้ำทุกวันจนกว่าจะชำระครบ; **เริ่มตั้งแต่ 17:00 ของวันครบกำหนดถ้ายังไม่จ่าย** (ยืนยันแล้ว) — ค่าปรับเริ่มคิดวันถัดไป จึงเป็นการเตือนก่อนเริ่มคิดค่าปรับ
- ส่งเป็นข้อความสรุปหนึ่งข้อความต่อประเภทต่อรอบ รวมทุกสัญญาที่เข้าเงื่อนไขในข้อความเดียว (ยืนยันแล้ว); ไม่มีแจ้งล่วงหน้าก่อนวันครบกำหนด
- กันส่งซ้ำด้วย `NotificationLog.dedupeKey` (เช่น `type:contractId:channel:date`); ล้มเหลวลองใหม่สูงสุด 3 ครั้ง แล้วบันทึก `FAILED` พร้อม `error`

## Import Rules

**DES-014 (อ้าง F10)** เฉพาะ `ADMIN`; ไฟล์ Excel/CSV ตามแม่แบบของระบบ 4 คอลัมน์ ได้แก่ ชื่อผู้ยืม, จำนวนเงิน (**เงินต้นล้วน** — ยืนยันแล้ว), ดอกเบี้ย (**บวกเพิ่มจากเงินต้น**; ว่าง = 0 — ยืนยันแล้ว), วันครบกำหนด
1. ขั้นตอน: อัปโหลด → ตรวจสอบและแสดงตัวอย่าง (preview) → ผู้ใช้ยืนยัน → บันทึกใน transaction เดียวภายใต้ `ImportBatch`
2. แต่ละแถวสร้าง `Contract` ด้วย `isImported = true`, `status = ACTIVE`, `interestAmount = ดอกเบี้ยในไฟล์`, `outstandingInterest = ดอกเบี้ยในไฟล์`, `principal = outstandingPrincipal = จำนวนเงิน` (เงินต้นล้วน), ยอดที่ต้องชำระเริ่มต้น = จำนวนเงิน + ดอกเบี้ย, ระบบไม่คำนวณดอกเบี้ยเองจากอัตรา, ไม่มี `Disbursement`, ไม่มี `LoanRequest`; แถวที่ดอกเบี้ยติดลบถือว่าผิด
3. ผู้ยืม: ผู้ยืมคนเดียวยืมได้หลายครั้ง ชื่อซ้ำในไฟล์จึงเป็นเรื่องปกติ (ยืนยันแล้ว) — จับคู่ด้วยชื่อเต็มตรงตัว: พบผู้ยืมเดียวในระบบ → ผูกสัญญาเข้าผู้ยืมนั้น; ไม่พบ → สร้าง `Borrower` ใหม่ครั้งเดียวต่อชื่อ (ไม่มีบัญชีล็อกอิน) แล้วแถวถัดไปชื่อเดียวกันผูกเข้าคนนั้น; พบหลายคนชื่อเดียวกันในระบบ → ให้ admin เลือกผู้ยืมใน preview ก่อนยืนยันนำเข้า (ยืนยันแล้ว)
4. อัตราค่าปรับของสัญญานำเข้าใช้อัตราใน `Setting` ณ วันนำเข้า; ถ้าวันครบกำหนดผ่านไปแล้ว ให้สร้าง `LateFeeAccrual` ย้อนหลังตั้งแต่ `dueDate + 1` ถึงวันนี้ตามกฎ DES-012 ใน transaction เดียวกัน
5. แถวที่ผิด (ว่าง, จำนวนเงินไม่เป็นบวก, วันที่ไม่ถูกต้อง) ไม่ถูกนำเข้า และแสดงเหตุผลรายแถว; ทั้งไฟล์ล้มเหลวทั้งหมดหากผู้ใช้ไม่ยืนยัน
6. Rollback: `ADMIN` ย้อนทั้ง batch ได้ ก็ต่อเมื่อไม่มีสัญญาในชุดนั้นที่มี `Payment`; ผลคือลบสัญญา/`LateFeeAccrual` ของชุด และตั้ง `ImportBatch.status = ROLLED_BACK`

## Report Rules

**DES-015 (อ้าง F9)** `ADMIN` ดูได้ทุกรายงาน; ทุกรายงานกรองได้รายเดือน รายปี หรือช่วงวันที่กำหนดเอง (Asia/Bangkok)
1. **กำไรขาดทุน** แสดงสองฐานในรายงานเดียว; รายการมีเฉพาะรายได้ดอกเบี้ยและค่าปรับ
   - ฐานเงินสด: รวม `allocatedInterest` และ `allocatedLateFee` ของ `Payment` ที่ `paidOn` อยู่ในช่วง
   - ฐานค้างรับ: ดอกเบี้ย = `interestAmount` ของสัญญาที่ `dueDate` อยู่ในช่วง (รับรู้เต็มจำนวนในวันครบกำหนด); ค่าปรับ = รับรู้เมื่อรับเงินจริงเท่านั้น (เท่ากับฐานเงินสด)
   - สัญญานำเข้า: ใช้ `interestAmount` จากคอลัมน์ดอกเบี้ยในไฟล์ เหมือนสัญญาปกติ (ฐานค้างรับนับตามวันครบกำหนด ฐานเงินสดนับตอนรับเงินตามลำดับตัดยอด)
2. **ผู้ชำระช้าสุด:** จัดอันดับตาม `จำนวนครั้งที่ชำระช้า` = จำนวนสัญญาของผู้ยืมที่ "ชำระช้า" (นิยามใน DES-012 รวมสัญญาที่เลยกำหนดและยังไม่ชำระ); เรียงมากไปน้อย
3. **ยอดเงินคงค้างรวมและจำนวนสัญญาที่เปิดอยู่:** ผลรวมยอดที่ต้องชำระของสัญญา `ACTIVE`; จำนวนสัญญา `ACTIVE`
4. **สรุปรายผู้ยืม:** จำนวนครั้งที่ยืม (สัญญาที่มีการจ่ายเงินหรือนำเข้า), จำนวนครั้งที่ชำระช้า, ยอดคงค้าง

## Modules

ทั้งหมดอยู่ใน delivery unit เดียว (`loan-management`) แบ่งกลุ่มฟีเจอร์ดังนี้

| Module | ขอบเขต | Feature | Design ID |
|---|---|---|---|
| M1 Accounts & Access | ผู้ใช้ ผู้ยืม PDPA เข้าสู่ระบบ รีเซ็ตรหัสผ่าน | F1 | DES-001, DES-002 |
| M2 Master Data | ตั้งอัตราดอกเบี้ยและค่าปรับ | F2 | DES-003 |
| M3 Origination | คำขอ อนุมัติ สัญญา บันทึกจ่ายเงิน ดอกเบี้ย | F3, F4, F5(ก) | DES-004, DES-005, DES-006, DES-010 |
| M4 Repayment & Late Fee | รับชำระ ตัดยอด ค่าปรับรายวัน ปิดสัญญา | F5(ข), F6 | DES-007, DES-011, DES-012, DES-016 |
| M5 Notifications | LINE OA, Web Push, งาน 09:00/17:00 | F7 | DES-013 |
| M6 Borrower Portal | หน้าผู้ยืม ประวัติ | F8 | DES-008 |
| M7 Reports | 4 รายงาน | F9 | DES-015 |
| M8 Import | นำเข้า/ rollback | F10 | DES-014 |

## Risks & Dependencies

- **ค่าปรับคิดซ้อนไม่มีเพดาน:** ยอดโตแบบทวีคูณ; ระบบต้องใช้ `Decimal` ทุกที่และไม่มีเพดาน/การตรวจกฎหมายตามที่ผู้ใช้เลือก (ความเสี่ยงทางกฎหมายผู้ใช้รับเอง; เพดาน 15% ต่อปียังไม่ได้รับการยืนยันจากทนาย — ดู `requirement.md` References)
- **Web Push บน iPhone:** ใช้ได้เมื่อผู้ใช้ติดตั้งเว็บเป็น PWA ลงหน้าจอหลักและอนุญาตการแจ้งเตือน; ต้องมีหน้าแนะนำการติดตั้งและต้องให้ HTTPS; ต้องทดสอบบนอุปกรณ์จริง
- **LINE Official Account:** ต้องมีบัญชี LINE OA และ channel Messaging API ของผู้ให้กู้ (สมมติฐานใน requirement ยังไม่ยืนยัน); ต้องตรวจโควตาข้อความตามแพ็กเกจ LINE ที่ใช้; `lineUserId` ของ admin ต้องเก็บหลังผูกบัญชี
- **ตัวจัดเวลา (scheduler):** งาน 09:00, 17:00 และงานคิดค่าปรับสิ้นวันต้องรันตามเวลา Asia/Bangkok, idempotent และตามเก็บย้อนหลังได้เมื่อเซิร์ฟเวอร์ดับ; ต้องมี process/cron เดียวเท่านั้นเพื่อกันงานซ้ำเมื่อรันหลาย instance
- **ที่เก็บไฟล์สลิป:** ต้องเป็นที่เก็บในประเทศไทย เข้าถึงได้เฉพาะ `ADMIN` (และเจ้าของสัญญา ถ้า `project-manager` เห็นว่าจำเป็น); ต้องจำกัดชนิดและขนาดไฟล์
- **ข้อมูลอ่อนไหว:** เลขบัญชี ชื่อ เบอร์โทร เก็บถาวร ต้องเข้ารหัสระหว่างส่ง (HTTPS) และพิจารณาเข้ารหัสฟิลด์ `bankAccountNo` ที่ชั้นแอป — ให้ `security` ตัดสินที่ประตูตรวจ; ต้องมีการ gate ด้านความปลอดภัยสำหรับงานล็อกอิน, รีเซ็ตรหัสผ่าน, การเข้าถึงสลิป
- **ความถูกต้องของเงิน:** การตัดยอด การคิดดอกเบี้ย และค่าปรับต้องมีชุดทดสอบจากตัวอย่างในเอกสาร (เช่น 1,000 / 50 / 300 → 50, 200, 50)
- **Dependencies ระหว่างโมดูล:** M2 → M3 → M4 → M5/M7; M8 ใช้กฎของ M4; `backend-engineer` ต้องทำ contract ก่อน `frontend-engineer`

## Unresolved Open Questions

**ข้อที่ต้องตัดสินใจโดยผู้ใช้ (เป็นเรื่องธุรกิจ — `system-analyst` ไม่ตัดสินแทน และรอ `business-analyst` amend `requirement.md` เมื่อได้คำตอบ)**

ปิดแล้ว (2026-10-27): ห้ามจ่ายเกินยอดที่ติด (ระบบปฏิเสธ); ปัดเศษขึ้นเสมอสำหรับดอกเบี้ยและค่าปรับรายวัน; admin ลบรายการรับชำระ/จ่ายเงินได้ พร้อมคำนวณสัญญาใหม่; แจ้งเลยกำหนดเป็นสรุปเดียวต่อรอบ; ชื่อผู้ยืมซ้ำคนละคนให้ admin เลือกใน preview; วันที่บันทึกย้อนหลังได้แต่ไม่ก่อนวันจ่ายเงินและไม่ใช่อนาคต; แจ้งคำขอใหม่ส่งทันที; อัตราเปลี่ยนภายหลัง = สัญญาเดิมใช้อัตราที่ล็อก; แจ้งเลยกำหนด = เริ่ม 17:00 ของวันครบกำหนดถ้ายังไม่จ่าย แล้วส่งทุกวันจนชำระครบ; ไฟล์นำเข้า = จำนวนเงินเป็นเงินต้นล้วน ดอกเบี้ยจากคอลัมน์บวกเพิ่ม; ค่าปรับของวันที่ชำระครบยังคิด; หลักการค่าปรับ = หนี้คงเหลือ ณ ปัจจุบัน; สลิปบังคับแนบ; บันทึกย้อนหลังวันได้; แก้ไขรายการเดิมได้โดยตรง; ชื่อผู้ยืมซ้ำในไฟล์ผูกเข้าผู้ยืมเดิม; ค่าตั้งต้นอัตรา admin ตั้งเอง ไม่ฝังค่าในระบบ

ไม่มีข้อที่ต้องตัดสินใจโดยผู้ใช้ค้างอยู่ — ข้อลบรายการจ่ายเงินให้ผู้ยืม (Disbursement) ปิดตามร่าง: ลบได้เมื่อไม่เหลือรายการรับชำระ แล้วสัญญากลับเป็น `AWAITING_DISBURSEMENT` (DES-016)

**ความเสี่ยงที่ผู้ใช้รับเอง (ไม่ใช่ข้อรอตัดสินใจ):** ไม่มีเพดานดอกเบี้ย/ค่าปรับ และค่าปรับคิดซ้อน — เพดาน 15% ต่อปีที่อ้างใน `requirement.md` ยังไม่ได้รับการยืนยันจากทนาย ควรปรึกษาทนายก่อนใช้งานจริง ไม่ขวางการพัฒนา

**ตัดออกจากขอบเขต ห้าม implement ถ้ายังไม่ amend requirement ก่อน:** ผ่อนชำระเป็นงวดตามตารางล่วงหน้า, ต่ออายุสัญญา, ปิดก่อนกำหนดแบบลดดอกเบี้ย, ยกเว้นค่าปรับด้วยมือ, แจ้งเตือนผู้ยืม, ช่องทาง SMS, ผู้ยืมสมัครบัญชีเอง, เพดานดอกเบี้ยในระบบ, ผลิตภัณฑ์เงินกู้ระยะคงที่, ช่องทางขอแก้/ลบข้อมูลส่วนบุคคลในระบบ, บัญชีเจ้าหน้าที่สินเชื่อ/ผู้อนุมัติแยก, การลบข้อมูลอัตโนมัติ

**ประตูมนุษย์:** (ก) Data Model — ยืนยันแล้ว; (ข) stack ตาม `project.yaml` `current` — ยืนยันแล้ว; (ค) Contract section — ปิดครบแล้ว ไม่มีข้อเสนอที่รอยืนยัน พร้อมส่งต่อ `project-manager`

## Change Log

| วันที่ | การเปลี่ยนแปลง | โดย |
|---|---|---|
| 2026-10-27 | สร้างเอกสารครั้งแรกจาก `requirement.md` (15 รอบสัมภาษณ์): Feasibility, Data Model (additive ทั้งหมด), Contract: Calculation, Lifecycle & Access, Notification, Import, Report; Modules M1–M8; ข้อค้างรอยืนยัน 9 ข้อ — สถานะร่างรอผู้ใช้ยืนยัน schema | system-analyst |
| 2026-10-27 | amend หลังผู้ใช้ตอบรอบยืนยัน: แจ้งเลยกำหนดทุกวัน 17:00 จนชำระครบ; สัญญาเดิมใช้อัตราที่ล็อก; ไฟล์นำเข้าเพิ่มคอลัมน์ดอกเบี้ย (แก้ DES-014, DES-015); Open Questions ปิด 3 ข้อ; ผู้ใช้ขอทบทวน stack จึงยังไม่ยืนยัน Data Model | system-analyst |
| 2026-10-27 | ผู้ใช้ยืนยัน Data Model 12 ตาราง (additive ทั้งหมด) และยืนยัน stack ปัจจุบัน Node + Prisma + Next.js; ปรับสถานะเอกสารจากร่างเป็นยืนยันแล้ว Data Model/stack; Contract section ยังมีข้อเสนอรอยืนยัน | system-analyst |
| 2026-10-27 | amend ตามคำตอบผู้ใช้: ไฟล์นำเข้า จำนวนเงิน = เงินต้นล้วน + ดอกเบี้ยบวกเพิ่ม (DES-014); แจ้งเลยกำหนดเริ่ม 17:00 ของวันครบกำหนด (DES-013); ค่าปรับรวมวันที่ชำระครบ ปรับเวลาคิดเป็นต้นวันจากยอดสิ้นวันก่อน (DES-012); **แก้ Data Model 1 จุด: `Disbursement.slipFileKey` `String?` → `String` (บังคับแนบสลิป) — เป็นการเปลี่ยน additive-compatible เพราะยังไม่มีตารางจริง; แจ้งผู้ใช้เพื่อคัดค้านได้**; Open Questions เหลือ 6 ข้อ | system-analyst |
| 2026-10-27 | amend ตามคำตอบผู้ใช้: หลักการค่าปรับ = หนี้คงเหลือ ณ ปัจจุบัน (DES-012 ตัดข้อเสนอเดิมเรื่องการตีความออก); บันทึกจ่ายเงิน/รับชำระย้อนหลังวันได้ (DES-011); เพิ่ม DES-016 แก้ไขรายการเดิมโดยตรง พร้อมคำนวณสัญญาใหม่และ AuditLog; ชื่อซ้ำตอนนำเข้าผูกผู้ยืมเดิม (DES-014); Data Model ไม่เปลี่ยน; Open Questions เหลือ 4 ข้อ | system-analyst |
| 2026-10-27 | amend ตามคำตอบผู้ใช้: ห้ามจ่ายเกิน (DES-011); ปัดขึ้นเสมอ (DES-010, DES-012); admin ลบรายการรับชำระ/จ่ายเงินได้พร้อมคำนวณสัญญาใหม่ (DES-016 — ข้อเสนอเฉพาะกรณีลบ Disbursement); แจ้งเลยกำหนดสรุปเดียวต่อรอบและแจ้งคำขอใหม่ส่งทันที (DES-013); ชื่อซ้ำคนละคนให้ admin เลือกใน preview (DES-014); ขอบเขตวันที่ย้อนหลัง (DES-011); Data Model ไม่เปลี่ยน; Open Questions เหลือ 1 ข้อ | system-analyst |
| 2026-10-27 | ปิดข้อค้างสุดท้ายตามที่ผู้ใช้สั่ง "เอาที่ค้างอยู่ให้ครบ": ลบ Disbursement ใช้ตามร่างใน DES-016; Unresolved Open Questions เหลือเฉพาะความเสี่ยงกฎหมายที่ผู้ใช้รับเอง; Data Model ไม่เปลี่ยน | system-analyst |
| 2026-10-30 | change request CR-1 ตามที่ผู้ใช้สั่งและยืนยัน 3 ข้อ (admin ตรวจแล้วยืนยัน / อนุญาตตารางใหม่ / แจ้งทันที): เพิ่มตาราง `PaymentSubmission` + enum `PaymentSubmissionStatus` + `NotificationType.PAYMENT_SUBMITTED` (เพิ่มอย่างเดียว, migration `payment_submission`), กฎ DES-017 (ผู้ยืมแจ้งชำระพร้อมสลิป) และ DES-018 (ปฏิทิน admin); ตารางเดิมไม่เปลี่ยน | Claude Code (ผู้พัฒนา) ตามคำสั่งผู้ใช้ PM3 |
| 2026-10-30 | change request CR-2 ตามที่ผู้ใช้สั่ง "จำนวนรวมปัดเศษให้เต็มบาท" และยืนยัน "ปัดขึ้นอย่างเดียวไม่ปัดลง": ดอกเบี้ย (DES-010) และค่าปรับรายวัน (DES-012) ปัดขึ้นเป็นบาทเต็มแทนปัดขึ้น 2 ตำแหน่ง; Data Model ไม่เปลี่ยน (คอลัมน์ Decimal(14,2) เก็บค่าบาทเต็มได้); สัญญาเดิมที่ยังเปิดอยู่จะคำนวณค่าปรับใหม่ตามกฎนี้ตอนคำนวณซ้ำครั้งถัดไป; ยอดที่ผู้ยืมโอนเป็นสตางค์ยังบันทึกได้ (ห้ามจ่ายเกินยังคงเดิม) | system-analyst |
| 2026-10-31 | change request CR-3 ตามที่ผู้ใช้สั่ง "ผู้ยืมเช็คดูดอกเบี้ยได้ด้วยการกรอกยอดที่ต้องการยืมที่หน้าขอยืม": เพิ่ม DES-019 endpoint ประมาณดอกเบี้ย (ใช้สูตร DES-010 เดิม ไม่บันทึกข้อมูล) และกล่องประมาณการที่หน้า /me/request; Data Model ไม่เปลี่ยน | system-analyst |
