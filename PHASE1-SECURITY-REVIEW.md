# Phase 1 — เอกสารสำหรับตรวจด้านความปลอดภัย 🔒

> เขียนเมื่อ 2026-10-29 โดย Claude Code หลังจบ T-101 ถึง T-105 (T-202 ทำไปด้วยแล้ว)
> นี่คือ **สรุปของผู้เขียนโค้ดเอง** ไม่ใช่ผลตรวจอิสระ — ผู้เขียนโค้ดตรวจงานตัวเองไม่ครบ ควรมีคนอื่นหรือ `security` อ่านโค้ดจริงตามตาราง "ไฟล์ที่ควรอ่าน" ท้ายเอกสาร
> สถานะ: ยังไม่ commit (ไม่ใช่ git repo) · `plan.md` ทุกแถวยัง `pending` · ผมไม่ตั้ง `verified` เอง

## 1. สิ่งที่มีแล้ว

| งาน | ผลลัพธ์ | Design |
|---|---|---|
| T-101 | login/logout/me/change-password, middleware ตาม Role, จำกัดความถี่ล็อกอิน, สคริปต์สร้าง admin คนแรกจาก env | DES-001/002 |
| T-102 | ด่าน PDPA: ผู้ยืมที่ยังไม่ยอมรับเข้า endpoint ฝั่งผู้ยืมไม่ได้ | DES-002 |
| T-103 | ADMIN สร้าง/แก้/ปิด-เปิด/รีเซ็ตรหัสผ่านผู้ยืม + `lib:borrower-scope` | DES-001/002/008 |
| T-104 | บริการ AuditLog (เขียนใน transaction เดียวกับรายการที่แก้) | DES-016 |
| T-105 | ตั้งอัตราดอกเบี้ย/ค่าปรับ (ADMIN), `requireRates()` | DES-003 |
| T-202 | ไลบรารีคำนวณดอกเบี้ย (ไม่เกี่ยวด่านความปลอดภัย แต่เป็นรากของกฎเงิน) | DES-010 |

## 2. Endpoint ทั้งหมด และด่านที่คุมแต่ละตัว

| Endpoint | ใครเรียกได้ | หมายเหตุ |
|---|---|---|
| `GET /health` | ทุกคน (ไม่ต้องล็อกอิน) | ตอบ `{"status":"ok"}` อย่างเดียว |
| `POST /auth/login` | ทุกคน | จำกัดความถี่ + ข้อความผิดพลาดเหมือนกันทุกกรณี |
| `POST /auth/logout` | ทุกคน | ล้าง cookie |
| `GET /auth/me`, `POST /auth/change-password` | ผู้ล็อกอิน (แม้ยังไม่เปลี่ยนรหัสผ่านครั้งแรก) | |
| `GET /pdpa`, `POST /pdpa/accept` | BORROWER ที่เปลี่ยนรหัสผ่านแล้ว | ใช้ `borrowerId` จากเซสชันเท่านั้น |
| `/admin/borrowers` (GET, POST, GET /:id, PATCH /:id, PUT /:id/active, POST /:id/reset-password) | ADMIN | จุดเดียวที่คืนเลขบัญชีผู้ยืม |
| `/admin/settings` (GET, PATCH) | ADMIN | |

ยังไม่มี endpoint ฝั่งผู้ยืมที่คืนข้อมูลการเงิน (มาในเฟส 2 และ 5) — `authorizeBorrower` + `forbidClientBorrowerId` เตรียมไว้แล้วแต่ยังไม่มีผู้ใช้จริง

## 3. มาตรการที่ทำ พร้อมหลักฐาน

ทุกข้อด้านล่างมี test ที่ผมลองถอดโค้ดส่วนนั้นออกแล้ว test ล้มจริง (mutation check) แล้วคืนโค้ดเดิม

| ประเด็น | ทำอย่างไร | หลักฐาน |
|---|---|---|
| รหัสผ่านเก็บ | scrypt (N=2^15, r=8, p=1, salt 16 ไบต์) ของ Node, เทียบแบบ timing-safe, ปรับ Unicode (NFKC), ยาว 10–128 ตัว | `test/auth-lib.test.ts` |
| Session | JWT HS256 ใน cookie `HttpOnly` + `SameSite=Lax` (+`Secure` เมื่อ production), อายุ 12 ชม., ปฏิเสธ `alg=none`/อัลกอริทึมอื่น/token ที่ถูกแก้ | `test/auth-lib.test.ts` |
| ยกเลิก session | โหลด user จาก DB ทุก request: ปิดบัญชีแล้วใช้ไม่ได้ทันที; token ผูกกับรอยนิ้วมือ password hash จึงตายเมื่อเปลี่ยน/รีเซ็ตรหัสผ่าน | `test/auth.test.ts`, `test/borrowers.test.ts` |
| Role มาจาก DB | ไม่เชื่อ role ใน token | `test/auth.test.ts` |
| ล็อกอิน | ข้อความเดียวกันทั้งรหัสผิด/ไม่มีผู้ใช้/บัญชีปิด; ผู้ใช้ที่ไม่มีก็ผ่าน scrypt หนึ่งรอบ (เวลาตอบใกล้เคียง); จำกัดความถี่ 3 ชั้น (คู่ username+IP 5, username รวม 50, IP รวม 20 ครั้งใน 15 นาที) → 429 (ดู D2) | `test/auth.test.ts`, `test/login-throttle.test.ts` |
| เลขบัญชีผู้ยืม | เข้ารหัส AES-256-GCM ใน DB, ปิดบังใน audit (ดู D1) | `test/field-crypto.test.ts`, `test/borrowers.test.ts`, `test/audit.test.ts` |
| บังคับเปลี่ยนรหัสผ่าน | `mustChangePassword` ปิดทุก route ธุรกิจจนกว่าจะเปลี่ยน | `test/auth.test.ts` |
| PDPA | ปิด endpoint ผู้ยืมจน `pdpaAcceptedAt` มีค่า; ยอมรับซ้ำไม่ทับเวลาเดิม | `test/pdpa.test.ts` |
| แยกข้อมูลรายผู้ยืม | `sessionBorrowerId(req)` อ่านจากเซสชัน; ถ้าคำขอส่ง `borrowerId` มา → 400 | `test/borrowers.test.ts` |
| ความลับ | `SESSION_SECRET` อยู่ใน `.env` เท่านั้น (≥32 ตัว, config ไม่ผ่านถ้าไม่มี); admin คนแรกมาจาก env ไม่ฝังในโค้ด; `.env` อยู่ใน `.gitignore` | `src/config.ts`, `src/scripts/create-admin.ts` |
| AuditLog | ทุกการแก้ผู้ยืม/ตั้งค่าเขียนใน transaction เดียวกัน; คีย์ password/token/secret ถูกแทนด้วย `[REDACTED]`; รหัสผ่านไม่เคยเข้า log | `test/audit.test.ts`, `test/borrowers.test.ts` |
| Error | 500 ไม่คืนรายละเอียด/stack ให้ client; body JSON จำกัด 100 KB | `src/http.ts`, `src/app.ts` |
| Dependency | เพิ่มเฉพาะ `jose` 6.2.13 (ดูแลอยู่) — `npm audit` 0 vulnerabilities ทั้ง `api/` และ `web/` | |

ผลรัน: `typecheck`, `lint`, `build` ผ่าน; test 116/116 (audit 13, auth-lib 15, auth 11, borrowers 20, pdpa 8, settings 11, admin-reset 5, login-throttle 7, field-crypto 8, interest 17, health 1) — test ที่ใช้ Postgres จริงจะข้ามอัตโนมัติถ้าต่อ DB ไม่ได้ ดังนั้นต้องรันตอน `docker compose up -d` เท่านั้นจึงนับเป็นหลักฐาน

## 4. ข้อที่ต้องให้คุณตัดสินใจ

| # | เรื่อง | ตอนนี้เป็นอย่างไร | ตัวเลือก |
|---|---|---|---|
| D1 | ~~เลขบัญชีผู้ยืม~~ **ตัดสินใจแล้ว: เข้ารหัสฟิลด์ + ปิดบังใน audit (2026-10-29)** | `bankAccountNo` เข้ารหัส AES-256-GCM ที่ชั้นแอป (IV สุ่มทุกครั้ง, รูปแบบ `enc:v1:…`) ด้วยกุญแจ `FIELD_ENCRYPTION_KEY` ใน env; ADMIN เห็นเลขจริงผ่าน API ตามเดิม; AuditLog เก็บแค่ `****1234` (ปิดบังอัตโนมัติทุกคีย์ชื่อ `bankAccountNo` ทุกระดับ) พร้อม `changedFields` บอกว่าแก้ช่องไหน; ค่าที่ไม่ใช่ `enc:v1:` ถูกปฏิเสธ ไม่ปล่อยผ่านเป็น plaintext; ไม่แก้ Data Model | test `field-crypto.test.ts` 8, `audit.test.ts` +2, `borrowers.test.ts` +2 |
| D2 | ~~ล็อกบัญชีด้วยการเดารหัสผิด~~ **ตัดสินใจแล้ว: คู่ username+IP + เพดานรวมสูง (2026-10-29)** | ตัวนับล้มเหลว 3 ตัว/15 นาที: (1) คู่ username+IP = 5 ครั้ง (2) username ข้ามทุก IP = 50 ครั้ง (3) IP ข้ามทุก username = 20 ครั้ง; คนนอกต้องใช้หลาย IP จึงล็อก admin ได้ และการเดากระจาย IP ถูกคุมที่เพดานรวม; ล็อกอินสำเร็จล้างเฉพาะตัวนับของคู่นั้น ไม่ล้างเพดานรวม; `change-password` ใช้ตัวนับแบบ 5 ครั้งเช่นกัน; `TRUST_PROXY` ตั้งได้ (ค่าเริ่มต้น 0 = ไม่เชื่อ `X-Forwarded-For` ปลอมไม่ได้) | test `login-throttle.test.ts` 7 ข้อ |
| D3 | ~~ไม่มีทางกู้รหัสผ่าน admin~~ **แก้แล้ว (2026-10-29)** | เพิ่ม `npm run admin:reset` (`src/scripts/reset-admin-password.ts` + `admin-accounts.ts`): อ่าน `ADMIN_USERNAME`/`ADMIN_PASSWORD` จาก env, แตะเฉพาะบัญชี ADMIN ที่มีอยู่, บังคับเปลี่ยนรหัสผ่านครั้งต่อไป, session เดิมของ admin ตายทันที, เขียน AuditLog (`admin.resetPassword`, actor = ระบบ, ไม่มีรหัสผ่าน), ไม่เปิดบัญชีที่ถูกปิดให้ (แค่เตือน) — ต้องมีสิทธิ์เข้าเชลล์เซิร์ฟเวอร์จึงใช้ได้ ไม่มี endpoint ใหม่ | test `test/admin-reset.test.ts` 5 ข้อ + ลองรันจริงผ่าน CLI |
| D4 | ค่าที่ผมตั้งเอง (ไม่มีใน requirement) | รหัสผ่านขั้นต่ำ 10 ตัว · session 12 ชม. · ผิด 5/20 ครั้งใน 15 นาที · ปิดบัญชีแล้วเปิดกลับได้ · ชื่อผู้ใช้ห้ามซ้ำแม้ตัวพิมพ์ต่าง · รูปแบบเบอร์โทร (6–30 ตัว) และเลขบัญชี (6–30 ตัวเลข/ขีด) | ยืนยันหรือบอกค่าที่ต้องการ |
| D5 | PDPA | ป้ายเวอร์ชัน `"1"`; ถ้อยคำเงื่อนไขจริงยังไม่มี; เปลี่ยนเวอร์ชันแล้ว **ไม่** บังคับยอมรับใหม่ | ให้ข้อความเงื่อนไข + บอกว่าจะบังคับยอมรับใหม่หรือไม่ |
| D6 | ผู้ยืมที่นำเข้าจากไฟล์ (ไม่มีบัญชี) | แก้ข้อมูลได้ แต่สร้างบัญชีให้ภายหลังไม่ได้ (ปิด/รีเซ็ต → 409) | เพิ่ม requirement ถ้าต้องการสร้างบัญชีให้ผู้ที่นำเข้ามา |

## 5. ช่องว่างและความเสี่ยงที่ผมรู้ (ยังไม่ได้แก้)

| # | เรื่อง | ผลกระทบ | แก้เมื่อไหร่ |
|---|---|---|---|
| G1 | **Logout ไม่ยกเลิก token ฝั่งเซิร์ฟเวอร์** (ไม่มีตาราง session และห้ามเพิ่ม) | token ที่ถูกขโมยใช้ได้จนหมด 12 ชม. หรือจนกว่าจะเปลี่ยนรหัสผ่าน/ปิดบัญชี | ข้อจำกัดของ Data Model; ลดได้ด้วยอายุที่สั้นลง |
| G2 | ~~Postgres ของ dev เปิดพอร์ตที่ `0.0.0.0:5433`~~ **แก้แล้ว (2026-10-29)** | `docker-compose.yml` ผูกเป็น `127.0.0.1:5433:5432` แล้วสร้างคอนเทนเนอร์ใหม่ (ข้อมูลใน volume คงอยู่) ตรวจแล้วว่า listen ที่ `127.0.0.1` เท่านั้น และ test ผ่านหลังเปลี่ยน | ยังเป็นค่าสำหรับ dev; production ตั้งใน T-1001 |
| G3 | ไม่มี security header (helmet), ไม่มี HSTS/บังคับ HTTPS; **`trust proxy` ตั้งผ่าน `TRUST_PROXY` ได้แล้ว** (ค่าเริ่มต้น 0) แต่ต้องตั้งค่าให้ตรงกับจำนวน proxy จริงตอน deploy | ถ้าอยู่หลัง proxy แล้วไม่ตั้ง จะเห็นทุกคนเป็น IP เดียวกัน; ถ้าตั้งทั้งที่เปิดตรงสู่อินเทอร์เน็ต `X-Forwarded-For` จะถูกปลอมได้ | T-1001 (deploy) |
| G10 | **กุญแจ `FIELD_ENCRYPTION_KEY` (ใหม่จาก D1)** | หายกุญแจ = เลขบัญชีทั้งหมดกู้ไม่ได้; กุญแจอยู่บนเซิร์ฟเวอร์เดียวกับแอป จึงกันได้เฉพาะกรณี dump DB/ไฟล์สำรองรั่ว ไม่กันกรณีเจาะเซิร์ฟเวอร์ได้ทั้งเครื่อง; ยังไม่มีขั้นตอนหมุนกุญแจ (รูปแบบ `v1` เผื่อไว้แล้ว) | สำรองกุญแจแยกจาก DB ก่อนมีข้อมูลจริง; แผนหมุนกุญแจทำเมื่อจำเป็น |
| G4 | **CSRF พึ่ง `SameSite=Lax` + รับเฉพาะ JSON** ไม่มี token แยก; ยังไม่ได้ตั้ง CORS | ใช้ได้เมื่อเว็บกับ API อยู่ site เดียวกัน; ถ้าต่าง site cookie จะไม่ถูกส่ง | ตัดสินตอน T-701 / T-1001 |
| G5 | scrypt กินหน่วยความจำ ~32 MB ต่อครั้ง; ตัวจำกัดความถี่นับเฉพาะครั้งที่ล้มเหลว | คนยิงล็อกอินพร้อมกันจำนวนมากทำ CPU/หน่วยความจำสูงได้ | พิจารณาตอน deploy (จำกัดจำนวนพร้อมกัน/rate limit ที่ proxy) |
| G6 | `SESSION_SECRET` ตรวจแค่ความยาว ≥32 ไม่ตรวจความสุ่ม; เปลี่ยนค่าแล้วทุก session ตาย | ค่าอ่อนทำให้ปลอม token ได้ | ตอน deploy สร้างด้วยตัวสุ่ม (ไฟล์ `.env` ตอนนี้สร้างด้วยตัวสุ่มแล้ว) |
| G7 | รหัสผ่านชั่วคราวที่ admin ตั้งให้ผู้ยืมต้องส่งต่อนอกระบบ | ความเสี่ยงเรื่องช่องทางส่ง | เป็นกระบวนการของคุณ; ระบบบังคับเปลี่ยนตอนเข้าครั้งแรก |
| G8 | AuditLog ไม่มีการกันแก้/ลบที่ชั้น DB | ผู้มีสิทธิ์ DB แก้ประวัติได้ (แอปไม่มี endpoint ลบ) | ตอน deploy: แยก DB user ที่ไม่มีสิทธิ์ลบ/แก้ตารางนี้ |
| G9 | ยังไม่ได้ตรวจนอกโค้ด: ไม่ได้ทดสอบเจาะ, ไม่ได้ทดสอบบน HTTPS/อุปกรณ์จริง, test ใช้ DB เดียวกับ dev (ลบข้อมูลทดสอบหลังจบ ตรวจแล้ว 0 แถวค้าง) | — | เฟส 10 |

## 6. ไฟล์ที่ควรอ่าน (เรียงตามความสำคัญ)

| ไฟล์ | เหตุผล |
|---|---|
| `api/src/auth/middleware.ts` | ด่านทุกอย่างอยู่ที่นี่ (session, role, mustChangePassword, PDPA) |
| `api/src/auth/routes.ts` | login / เปลี่ยนรหัสผ่าน / ตัวจำกัดความถี่ |
| `api/src/lib/session.ts`, `lib/password.ts`, `lib/cookie.ts` | การเข้ารหัส/token/cookie |
| `api/src/admin/borrowers.ts` | จัดการบัญชี คืนเลขบัญชี |
| `api/src/auth/pdpa.ts`, `auth/borrower-scope.ts` | ด่าน PDPA และการแยกข้อมูลรายผู้ยืม |
| `api/src/lib/audit.ts` | รายการคีย์ที่ถูก redact และการปิดบังเลขบัญชี |
| `api/src/lib/field-crypto.ts` | การเข้ารหัสเลขบัญชี (D1) |
| `api/src/scripts/create-admin.ts` | การสร้าง admin คนแรก |
| `api/src/scripts/admin-accounts.ts`, `reset-admin-password.ts` | ทางกู้รหัสผ่าน admin (D3) |
| `api/src/config.ts`, `api/.env.example` | ตัวแปรลับ |

## 7. รันซ้ำเพื่อตรวจเอง

```powershell
cd C:\loan-manage
docker compose up -d
cd api
npm run typecheck; npm run lint; npm test; npm audit
```

## 8. สิ่งที่ต้องทำก่อนใช้งานจริง (นอกเหนือการตรวจโค้ด)

1. รัน `npm run admin:create` ด้วย `ADMIN_USERNAME` / `ADMIN_PASSWORD` ที่คุณตั้งเอง แล้วลบ `ADMIN_PASSWORD` ออกจาก environment/ประวัติเชลล์ (ถ้าลืมรหัสผ่าน admin ภายหลัง ใช้ `npm run admin:reset` ด้วยวิธีเดียวกัน)
2. **สร้างกุญแจเข้ารหัสและสำรองไว้แยกจากฐานข้อมูล:** `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` แล้วใส่เป็น `FIELD_ENCRYPTION_KEY` ใน `.env` ของเซิร์ฟเวอร์ (ไฟล์ `.env` ของเครื่อง dev สร้างให้แล้วด้วยตัวสุ่ม) — ระบบไม่ยอมสตาร์ตถ้าไม่มีกุญแจหรือกุญแจไม่ใช่ 32 ไบต์; และตั้ง `TRUST_PROXY` ให้ตรงกับจำนวน reverse proxy จริง
3. ตั้งค่าอัตราดอกเบี้ยและค่าปรับผ่าน `PATCH /admin/settings` (จนกว่าจะตั้ง ระบบปฏิเสธการจ่ายเงิน/นำเข้า)
4. commit โฟลเดอร์ `api/prisma/migrations/` และไฟล์ทั้งหมดด้วยตัวคุณเอง
