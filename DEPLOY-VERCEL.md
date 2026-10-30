# Deploy บน Vercel แยกหน้าเว็บ (FE) กับ API (BE)

โปรเจกต์ Vercel 2 ตัวจาก repo เดียวกัน:

| โปรเจกต์ | Root Directory | คืออะไร |
|---|---|---|
| `loan-web` | `web` | Next.js (หน้าเว็บ/PWA) — ส่งต่อ `/api/*` ไปที่ API (เบราว์เซอร์คุยกับโดเมนเดียว คุกกี้ล็อกอินจึงเป็น first-party) |
| `loan-api` | `api` | Express เป็น Vercel Function เดียว (`api/api/index.js` → `dist/vercel.js`) |

**สถานะ:** deploy แล้วเมื่อ 2026-10-31 — เว็บ https://loan-web-phi.vercel.app · API https://loan-api-pi.vercel.app (ฐานข้อมูล Neon `loan-db` และ Blob private `loan-files` ภูมิภาคสิงคโปร์ `sin1`, บัญชี Vercel `kwaunchai-j` แพ็กเกจ Hobby)

บริการที่ต้องมีเพิ่ม: **Postgres** (แนะนำ Neon ผ่าน Vercel Marketplace) และ **Vercel Blob แบบ private** (เก็บสลิป/ไฟล์นำเข้า)

> **แพ็กเกจ:** Hobby ของ Vercel ใช้ได้เฉพาะงานที่ไม่ใช่เชิงพาณิชย์ และ cron จะรันได้วันละครั้งเวลาคลาดเคลื่อนได้ถึง ~1 ชั่วโมง (แจ้งเตือน 09:00/17:00 จะไม่ตรงเวลา) — ระบบปล่อยกู้ของธุรกิจควรใช้ **Pro**

## สิ่งที่ต่างจากการรันบนเครื่องเอง (และเหตุผล)

| เรื่อง | บนเครื่อง/Docker | บน Vercel |
|---|---|---|
| งานกลางคืน (ค่าปรับ 00:05, แจ้งเตือน 09:00/17:00) | scheduler ในโปรเซส | **Vercel Cron** เรียก `GET /cron/late-fee`, `/cron/notify-due-today`, `/cron/notify-overdue` ด้วย `Authorization: Bearer $CRON_SECRET` (ค่าปรับยังถูกคำนวณทันทีเมื่อเปิดดูยอดหรือบันทึกรับชำระ จึงไม่พึ่ง cron อย่างเดียว) |
| ไฟล์สลิป/ไฟล์นำเข้า | โฟลเดอร์ในดิสก์ | **Blob private** (`STORAGE_BACKEND=blob`) — ดิสก์ของ function เป็น read-only และหายทุกครั้ง |
| ขนาดสลิป | 5 MB | **4 MB** (Vercel จำกัด request body 4.5 MB): API `SLIP_MAX_BYTES=4194304`, เว็บ `NEXT_PUBLIC_SLIP_MAX_MB=4` |
| จำกัดการเดารหัสผ่านตอน login | ในหน่วยความจำของโปรเซส | ในหน่วยความจำของ **แต่ละ instance** จึงไม่พอ → **ตั้ง Vercel Firewall rate limit** (ด้านล่าง) |
| Prisma | ต่อ DB ตรง | ใช้ connection แบบ **pooled** (`pgbouncer=true`); migration ใช้ URL แบบ direct |

## ขั้นตอน

### 1) เตรียมบัญชีและเครื่องมือ
```bash
npx vercel login          # ล็อกอินด้วยบัญชี Vercel ของคุณเอง (ทำเองเท่านั้น)
```

### 2) สร้างโปรเจกต์ (ครั้งเดียว)
```bash
cd api && npx vercel link --yes --project loan-api
cd ../web && npx vercel link --yes --project loan-web
```
Deploy ด้วย CLI จากโฟลเดอร์ `api` / `web` โดยตรง **ต้องปล่อย Root Directory ว่าง**; ตั้งเป็น `api` / `web` เฉพาะเมื่อเชื่อมโปรเจกต์กับ GitHub repo (Settings → Build & Deployment → Root Directory) — มิฉะนั้น CLI จะหา `api/api` ไม่เจอ

### 3) ฐานข้อมูลและ Blob
- **Postgres:** Dashboard → Storage → Create → Neon (เชื่อมกับ `loan-api`) จะได้ `DATABASE_URL` (pooled) และ `DATABASE_URL_UNPOOLED` ให้เอง
  - `DATABASE_URL` ที่ใช้รันต้องลงท้ายด้วย `&pgbouncer=true&connection_limit=1` (ถ้ายังไม่มี ให้เพิ่ม)
- **Blob:** `npx vercel blob create-store loan-files --access private --yes` (จากโฟลเดอร์ `api` ที่ link แล้ว) — จะเพิ่ม `BLOB_STORE_ID` ให้โปรเจกต์เอง **ต้องเป็น private เท่านั้น (เปลี่ยนภายหลังไม่ได้)**

### 4) ตั้งค่า environment ของ `loan-api` (Production)

| ชื่อ | ค่า |
|---|---|
| `SESSION_SECRET` | สุ่มยาว ≥ 32 ตัวอักษร |
| `FIELD_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — **สำรองไว้นอกระบบด้วย** ถ้าหายจะถอดรหัสเลขบัญชีไม่ได้ |
| `CRON_SECRET` | สุ่มยาว ≥ 16 ตัวอักษร (Vercel ส่งค่านี้ให้ cron เองอัตโนมัติ) |
| `STORAGE_BACKEND` | `blob` |
| `SLIP_MAX_BYTES` | `4194304` |
| `IMPORT_MAX_BYTES` | `2097152` (ค่าเริ่มต้น ไม่ต้องตั้ง) |
| `TRUST_PROXY` | `1` |
| `LINE_CHANNEL_ACCESS_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | ถ้าใช้ LINE / Web Push (VAPID ต้องครบ 3 ตัวหรือไม่ใส่เลย) |

อย่าตั้ง `SCHEDULER_ENABLED` (บน Vercel ไม่มีโปรเซสยาว งานกลางคืนใช้ cron) และห้ามเอาค่าลับใส่ในแชทหรือในโค้ด — ใส่ผ่าน `npx vercel env add NAME production` หรือ Dashboard เท่านั้น

### 5) สร้างตารางและผู้ดูแลคนแรก (ใช้ URL แบบ direct)
```bash
cd api
# ดึงค่า env ของโปรเจกต์ลงไฟล์ชั่วคราว (ไฟล์ .env* ถูก git ignore) แล้วใช้ URL แบบ direct รันคำสั่ง
npx vercel env pull .env.vercel --environment production
set -a; . ./.env.vercel; set +a        # โหลดค่าเข้า shell นี้ (ไม่แสดงบนจอ)
DATABASE_URL="$DATABASE_URL_UNPOOLED" npx prisma migrate deploy
ADMIN_USERNAME=<ชื่อ> ADMIN_PASSWORD=<รหัสผ่านชั่วคราว> DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run admin:create
rm .env.vercel
```
(บัญชีแรกจะถูกบังคับเปลี่ยนรหัสผ่านตอนเข้าครั้งแรก)

### 6) Deploy API แล้วค่อย deploy เว็บ
```bash
cd api && npx vercel deploy --prod          # ได้โดเมน เช่น https://loan-api.vercel.app
cd ../web
npx vercel env add API_URL production        # ใส่โดเมนของ API ข้างบน (https://...)
npx vercel env add NEXT_PUBLIC_SLIP_MAX_MB production   # 4
npx vercel deploy --prod
```
`API_URL` ถูกอ่านตอน **build** ของเว็บ — ถ้าเปลี่ยนต้อง deploy เว็บใหม่

### 7) ตั้ง Firewall rate limit (แทนตัวจำกัดในหน่วยความจำ)
Vercel Dashboard → โปรเจกต์ `loan-api` → **Firewall → Rules → New rule**
- เงื่อนไข: Request Path **equals** `/auth/login` AND Method **equals** `POST`
- Action: **Rate limit** (เช่น 10 คำขอ ต่อ 1 นาที ต่อ IP) แล้ว Publish
- ทำซ้ำกับโปรเจกต์ `loan-web` สำหรับ path `/api/auth/login` (ผู้ใช้เข้าผ่านเว็บ)
- ความสามารถของ rate limit ขึ้นกับแพ็กเกจ — ตรวจใน Dashboard

### 8) ตรวจหลัง deploy
```bash
curl -s https://<api-domain>/health                                   # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" https://<api-domain>/auth/me # 401
curl -s -o /dev/null -w "%{http_code}\n" https://<api-domain>/cron/late-fee                              # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<api-domain>/cron/late-fee                       # {"job":"late-fee","ran":true,...}
```
แล้วลองในเบราว์เซอร์: เข้าเว็บ → ล็อกอิน → ตั้งอัตราดอกเบี้ย/ค่าปรับ → สร้างผู้ยืม → แนบสลิป (ต้องผ่านและเปิดดูได้เฉพาะแอดมิน)

## สิ่งที่พบตอน deploy จริง
- Vercel เดา framework ของ `api` เป็น Express แล้วหา entrypoint ผิดที่ → `api/vercel.json` จึงตั้ง `"framework": null` ให้ใช้ function ของเราเอง (`api/api/index.js`)
- function ต้องอยู่ภูมิภาคเดียวกับฐานข้อมูล: `"regions": ["sin1"]` ใน `api/vercel.json` (ก่อนตั้ง function รันที่สหรัฐ แล้วคำขอช้าเป็นวินาที)
- Neon pooled URL ที่ Vercel ให้มาไม่มี `pgbouncer=true` — โค้ด (`src/db.ts`) เติมให้เองเมื่อโฮสต์เป็น `-pooler`
- `vercel integration add neon` เพิ่มไฟล์ skill ของบุคคลที่สามเข้ามาในโฟลเดอร์โปรเจกต์ (`.agents/`, `.claude/`, `skills-lock.json`) — ลบทิ้งแล้ว ไม่ต้อง commit
- ค่า environment ที่ตั้งผ่าน CLI บัญชีนี้ถูกเก็บเป็นแบบ **Secret (Hidden)** อ่านกลับไม่ได้ — ระวังกับ `FIELD_ENCRYPTION_KEY` ดูหัวข้อด้านล่าง
- หน้าสิทธิ์: โดเมน production (`*.vercel.app` ของโปรเจกต์) เปิดสาธารณะ ใช้งานได้; ตรวจที่ Settings → Deployment Protection ถ้าต้องการเปลี่ยน

## ต้องทำเอง (ผมทำแทนไม่ได้)
1. **Firewall rate limit** ของ login (ขั้นตอน 7) — เป็นการตั้งค่าความปลอดภัย
2. **สำรอง `FIELD_ENCRYPTION_KEY`** — ค่าที่ตั้งไว้อ่านกลับไม่ได้ ถ้าจะมีสำเนา ให้สร้างคีย์ใหม่เองแล้วตั้งทับ (`npx vercel env add FIELD_ENCRYPTION_KEY production`) **ก่อนมีข้อมูลเลขบัญชีจริง** เพราะเปลี่ยนคีย์ทีหลังจะถอดรหัสข้อมูลเก่าไม่ได้
3. เปลี่ยนรหัสผ่านแอดมินตอนเข้าครั้งแรก แล้วลบไฟล์ `api/.env.admin-login`
4. พิจารณาอัปเกรดเป็น Pro (Hobby = ไม่ใช่เชิงพาณิชย์ และ cron คลาดเคลื่อนได้ ~1 ชม.)

## ข้อจำกัดที่ควรรู้
- รูปสลิปจากมือถือที่ใหญ่เกิน 4 MB จะถูกปฏิเสธ (บีบรูปก่อนส่ง หรือขอให้ถ่ายใหม่ขนาดเล็กลง)
- เวลา cron บนแพ็กเกจ Hobby คลาดเคลื่อนได้ ~1 ชั่วโมง; การแจ้งเตือนมี dedupe ต่อวัน จึงไม่ส่งซ้ำ
- IP ของผู้ใช้ที่ API เห็นต้องตรวจจริงหลัง deploy (เว็บส่งต่อผ่าน rewrite อีกชั้น) — ถ้า IP ที่เห็นเป็นของ Vercel ไม่ใช่ของผู้ใช้ ให้พึ่ง Firewall rule ที่ขั้นตอน 7 เป็นหลัก
- การ deploy นี้ยังไม่ได้ทดสอบบน iPhone จริง (T-1002) และ PDPA/ไอคอนจริงยังเป็นงานค้างตาม `deploy/ACCEPTANCE.md`
