# เครื่องมือรันเทสต์ในเว็บ (DEV-TOOLS) — ใช้ตอนพัฒนา เอาออกก่อน deploy จริง

หน้า `/admin/dev-tests` ("รันเทสต์" ในเมนูผู้ดูแล) มีปุ่มสำหรับรันเทสต์อัตโนมัติของโปรเจกต์ — รันทั้งชุด ทั้งกลุ่ม หรือทีละไฟล์ — แล้วแสดงผ่าน/ไม่ผ่านพร้อมเหตุผลที่ไม่ผ่าน
ทุกส่วนติดป้าย `DEV-TOOLS` ไว้ เพื่อค้นหาและลบได้ครบ

## ใช้งาน (เครื่องพัฒนา)

1. `api/.env` ใส่ `DEV_TEST_RUNNER=true` แล้วรีสตาร์ท API
2. `web/.env.local` ใส่ `NEXT_PUBLIC_DEV_TOOLS=1` แล้ว build/รันเว็บใหม่ (ถ้าไม่ใส่ เมนูจะไม่ขึ้น แต่เข้าหน้า `/admin/dev-tests` ตรงๆ ได้)
3. ล็อกอินเป็นผู้ดูแล → เมนู **รันเทสต์**
   - เทสต์หน้าเว็บ (~30 วินาที) ไม่ต้องใช้ฐานข้อมูล
   - เทสต์ API (~4 นาทีถ้ารันทั้งหมด) เขียนข้อมูลทดสอบลงฐานข้อมูลในเครื่องแล้วลบเอง

## มาตรการความปลอดภัยที่ใส่ไว้ (ระหว่างที่ยังมีเครื่องมือนี้)

| มาตรการ | ผล |
|---|---|
| ปิดเป็นค่าเริ่มต้น | ไม่มี `DEV_TEST_RUNNER=true` = ไม่มี route นี้เลย (ตอบ 404) |
| ห้ามเปิดใน production | `NODE_ENV=production` + `DEV_TEST_RUNNER=true` = API ไม่ยอมเริ่มทำงาน (`config.ts`) |
| เฉพาะผู้ดูแล | ผู้เยี่ยมชมได้ 401, ผู้ยืมได้ 403 |
| รันได้เฉพาะไฟล์ที่มีอยู่จริง | ชื่อไฟล์ถูกเทียบกับรายการในโฟลเดอร์ `test` ไม่ต่อเข้าคำสั่งตรงๆ ไม่ใช้ shell คำสั่งคงที่คือ `node vitest.mjs run ...` |
| เทสต์ API รันเฉพาะกับฐานข้อมูลในเครื่อง | ถ้า `DATABASE_URL` ไม่ใช่ localhost / 127.0.0.1 / ::1 จะปฏิเสธ |
| รันได้ทีละงาน, ยกเลิกได้, หมดเวลา 20 นาที | กันรันซ้อนและค้าง |
| ไม่ติดไปกับ image เว็บ | `web/.dockerignore` ตัด `.env.*` ออก จึงไม่เอา `NEXT_PUBLIC_DEV_TOOLS` เข้า build ของ Docker |

## ขั้นตอนเอาออกก่อน deploy จริง

**1. ลบไฟล์/โฟลเดอร์ทั้งหมดนี้**

```
api/src/dev-tools/                     (โฟลเดอร์)
api/test/dev-tests.test.ts
web/components/devtests/               (โฟลเดอร์)
web/app/admin/dev-tests/               (โฟลเดอร์)
web/test/dev-tests.test.tsx
web/.env.local                         (ถ้ามีเฉพาะบรรทัด NEXT_PUBLIC_DEV_TOOLS)
```

**2. ลบบรรทัดที่ติดป้าย `DEV-TOOLS` ในไฟล์เหล่านี้** (ค้นด้วย `grep -rn "DEV-TOOLS" api web tools --exclude-dir=node_modules --exclude-dir=.next`)

| ไฟล์ | สิ่งที่ลบ |
|---|---|
| `api/src/app.ts` | 2 บรรทัด import, ฟิลด์ `devTestRunner` ใน `AppDeps`, บรรทัด `if (deps.devTestRunner) app.use(...)` |
| `api/src/index.ts` | 2 บรรทัด import และบล็อก `devTestRunner: ...` |
| `api/src/config.ts` | ฟิลด์ `DEV_TEST_RUNNER` ใน schema และบล็อก `if (... DEV_TEST_RUNNER && ... production)` |
| `api/.env` และ `api/.env.example` | บรรทัด `DEV_TEST_RUNNER` พร้อมคอมเมนต์ |
| `web/lib/access.ts` | บรรทัด `...(process.env.NEXT_PUBLIC_DEV_TOOLS ...)` |
| `web/components/AppShell.tsx` | บรรทัด `"/admin/dev-tests": "check"` |
| `api/test/config.test.ts` | บล็อก `describe("DEV_TEST_RUNNER ...")` |
| `tools/test-areas.json` | 2 รายการ `dev-tests.test.ts` / `dev-tests.test.tsx` |

**3. ตรวจว่าเอาออกครบ**

```bash
grep -rn "DEV-TOOLS\|DEV_TEST_RUNNER\|dev-tests" api web tools deploy --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=coverage
```

ต้องไม่เหลืออะไร (ยกเว้นไฟล์ `DEV-TOOLS-REMOVAL.md` นี้ ซึ่งลบทิ้งได้ด้วยเมื่อเสร็จ)

```bash
cd api && npx tsc --noEmit && npm run lint && npm test
cd ../web && npx tsc --noEmit && npm run lint && npm test && npm run build
node tools/gen-test-catalog.mjs     # สร้าง test-cases.md ใหม่ (ต้องรันเทสต์แบบ --reporter=json ก่อน ดูหัวไฟล์)
```

**4. ตรวจหลัง deploy** — `GET /api/admin/dev-tests` ต้องได้ 404 (หรือ 401 ถ้าไม่ได้ล็อกอิน เพราะ route อื่นใต้ `/admin` ยังต้องล็อกอิน) และเมนูผู้ดูแลต้องไม่มี "รันเทสต์"

## สิ่งที่ *ไม่* ต้องลบ

- เทสต์ทั้งหมดที่เพิ่มก่อนหน้า (`config`, `money`, `scheduler-unit`, `webpush-sender`, `app-shell`, `gate`, `ui` ฯลฯ) และคำสั่ง `npm run test:coverage`
- `tools/gen-test-catalog.mjs` และ `tools/test-areas.json` (ใช้สร้างเอกสารเคสทดสอบ)
