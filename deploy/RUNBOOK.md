# คู่มือ deploy และดูแลระบบ (Runbook) — ระบบขอยืมเงิน

> ใช้กับงาน T-1001 · เขียนเมื่อ 2026-10-30 โดย Claude Code · ทุกคำสั่งในไฟล์นี้ผมลองรันกับ stack จริงบนเครื่องพัฒนา (Docker) แล้ว **แต่ยังไม่เคยรันบนเซิร์ฟเวอร์จริงในประเทศไทย** — ครั้งแรกบนเซิร์ฟเวอร์จริงให้ทำทีละขั้นและจดสิ่งที่ต่างไว้
> **ห้าม** วางรหัสผ่าน โทเคน หรือกุญแจใดๆ ลงในแชท, ticket, repository หรือ log

## 0. ภาพรวม

```
อินเทอร์เน็ต ──443/80──► proxy (Caddy: HTTPS อัตโนมัติ)
                           ├─ /api/*  ──► api (Node, มี scheduler ข้างใน)  ──► db (PostgreSQL)
                           └─ อื่นๆ   ──► web (Next.js)                       └─ volume "uploads" (สลิป, ไฟล์นำเข้าที่รอยืนยัน)
```

- เปิดสู่อินเทอร์เน็ต **เฉพาะ proxy** (พอร์ต 80/443) — db, api, web ไม่เปิดพอร์ตออกนอก Docker
- ความลับทั้งหมดอยู่ในโฟลเดอร์ `LOAN_ENV_DIR` (ค่าเริ่มต้น `/etc/loan`) **นอก repository**
- ไฟล์ใน repo: `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/scripts/*.sh`, `api/Dockerfile`, `web/Dockerfile`
- ทุกคำสั่ง compose ให้เรียกผ่าน `deploy/scripts/compose.sh` (ชี้ไปยังไฟล์ความลับให้เอง) ตัวอย่างด้านล่างย่อเป็น `compose`:

```bash
alias compose='/opt/loan/app/deploy/scripts/compose.sh'   # ปรับพาธให้ตรงกับที่วางโค้ด
```

## 1. สิ่งที่ผู้ใช้ต้องเตรียมก่อน (ผมทำแทนไม่ได้)

| # | สิ่งที่ต้องมี | หมายเหตุ |
|---|---|---|
| 1 | **เซิร์ฟเวอร์ Linux ในประเทศไทย** (Q4) | แนะนำ 2 vCPU / 4 GB RAM / ดิสก์ 40 GB ขึ้นไป (สลิปและฐานข้อมูลโตช้า) ผู้ให้บริการใดก็ได้ที่ศูนย์ข้อมูลอยู่ในไทย — **ยังไม่ได้เลือกผู้ให้บริการ** |
| 2 | **ชื่อโดเมน** ที่ชี้ (A record) มาที่เครื่อง | Web Push บน iPhone ต้องใช้ HTTPS ที่ใบรับรองถูกต้อง |
| 3 | เปิดไฟร์วอลล์เฉพาะ **80 และ 443** (และ SSH จากที่ที่ไว้ใจ) | ปิดพอร์ตอื่น โดยเฉพาะ 5432 (ฐานข้อมูล) |
| 4 | ติดตั้ง **Docker Engine + Docker Compose plugin** | |
| 5 | **LINE Official Account + Messaging API** (Q3) | channel access token และเช็กโควตาข้อความของแพ็กเกจ; LINE user id ของแอดมิน (ขึ้นต้น `U` ตามด้วย 32 ตัว) |
| 6 | **ที่เก็บสำรองข้อมูลอีกเครื่อง** ในประเทศไทย | สำเนาสำรองต้องไม่อยู่เครื่องเดียวกับระบบ |
| 7 | **ที่เก็บ `FIELD_ENCRYPTION_KEY` แยกจากที่เก็บข้อมูลสำรอง** | เช่น ตู้นิรภัยรหัสผ่านของบริษัท ถ้าสูญหาย เลขบัญชีผู้ยืมที่เข้ารหัสไว้ **กู้คืนไม่ได้เลย** |
| 8 | ข้อความ PDPA ที่ผู้ให้กู้/ที่ปรึกษากฎหมายอนุมัติแล้ว + ไอคอนแอปจริง | ดู PHASE7-SECURITY-REVIEW.md (W4, W5) |

## 2. ติดตั้งครั้งแรก

```bash
# 2.1 วางโค้ดบนเซิร์ฟเวอร์ (เช่น git clone ไปที่ /opt/loan/app) แล้ว
export LOAN_ENV_DIR=/etc/loan
cd /opt/loan/app

# 2.2 สร้างไฟล์ความลับ (สุ่มให้เอง ไม่แสดงบนจอ ไม่ทับของเดิม)
sudo mkdir -p "$LOAN_ENV_DIR" && sudo chown "$USER" "$LOAN_ENV_DIR"
SITE_ADDRESS=loan.ตัวอย่าง.co.th deploy/scripts/make-secrets.sh

# 2.3 สำรอง FIELD_ENCRYPTION_KEY ไปที่เก็บข้อ 7 ทันที (เปิดไฟล์ api.env ดูเฉพาะบรรทัดนั้น ห้ามส่งทางแชท/อีเมล)

# 2.4 สร้าง image และเริ่มฐานข้อมูล
compose build
compose up -d db

# 2.5 สร้างตารางด้วย migration (ห้ามใช้ prisma migrate dev / reset บน production)
compose run --rm tools npx prisma migrate deploy

# 2.6 สร้างแอดมินคนแรก: อ่านรหัสผ่านโดยไม่แสดงและไม่ฝากไว้ใน history
read -rsp "รหัสผ่านแอดมินชั่วคราว (>=10 ตัว): " ADMIN_PASSWORD; echo
export ADMIN_USERNAME=admin ADMIN_PASSWORD
compose run --rm -e ADMIN_USERNAME -e ADMIN_PASSWORD tools npm run admin:create
unset ADMIN_PASSWORD

# 2.7 Web Push (ไม่บังคับแต่แนะนำ): สร้างกุญแจ VAPID ลง api.env โดยไม่แสดง
deploy/scripts/make-vapid.sh ติดต่อ@โดเมนของคุณ
# LINE: เปิด $LOAN_ENV_DIR/api.env แล้วเติมบรรทัด LINE_CHANNEL_ACCESS_TOKEN=... (ด้วยตัวแก้ไขบนเซิร์ฟเวอร์เอง)

# 2.8 เริ่มทั้งระบบ
compose up -d
compose ps                       # ทุกบริการต้อง Up (api และ db: healthy)
```

เมื่อ DNS ชี้ถูกและพอร์ต 80/443 เปิด Caddy จะขอใบรับรอง Let's Encrypt เอง (ใช้เวลาไม่กี่วินาที ถึง 1–2 นาที) — ดู `compose logs proxy`

**ตรวจจากเครื่องอื่น (ไม่ใช่เซิร์ฟเวอร์):**

```bash
deploy/scripts/verify-deploy.sh https://loan.ตัวอย่าง.co.th
```
ต้องขึ้น `ALL CHECKS PASSED` (ตรวจ HTTPS, สิทธิ์ของ endpoint, header ความปลอดภัย, PWA, พอร์ตภายในปิด, การล็อกโดน IP ปลอมไม่ได้)

## 3. ตั้งค่าครั้งแรกในระบบ

1. เปิดเว็บ → เข้าสู่ระบบด้วยแอดมิน → ระบบบังคับเปลี่ยนรหัสผ่านทันที
2. **ตั้งอัตรา** ที่เมนู "ตั้งค่าอัตรา" (ก่อนตั้ง จ่ายเงิน/นำเข้าไม่ได้)
3. เมนู "แจ้งเตือน": ผูก LINE (ใส่ LINE user id), เปิด Web Push บนเครื่องที่จะใช้รับแจ้ง (iPhone ต้องเพิ่มแอปลงหน้าจอโฮมก่อน), กด "ส่งทดสอบ"
4. ตั้งค่า cron สำรองข้อมูล (หัวข้อ 6) และ**ทดสอบกู้คืนหนึ่งครั้งทันที**
5. ทำตาม `deploy/ACCEPTANCE.md` (T-1002) ร่วมกับผู้ใช้

## 4. อัปเดตเวอร์ชัน (release)

```bash
export LOAN_ENV_DIR=/etc/loan; cd /opt/loan/app
deploy/scripts/backup.sh                         # 1. สำรองก่อนเสมอ (ต้องขึ้น OK)
git fetch && git checkout <แท็กของ release>      # 2. เปลี่ยนเป็นเวอร์ชันใหม่
sed -i 's/^RELEASE=.*//' "$LOAN_ENV_DIR/compose.env"; echo "RELEASE=<แท็ก>" >> "$LOAN_ENV_DIR/compose.env"
compose build                                    # 3. สร้าง image (ติดป้าย loan-api:<แท็ก>)
compose run --rm tools npx prisma migrate deploy # 4. ปรับฐานข้อมูล (ดูกฎด้านล่าง)
compose up -d                                    # 5. สลับเวอร์ชัน (ดับสั้นๆ)
deploy/scripts/verify-deploy.sh https://...      # 6. ตรวจจากเครื่องอื่น
```

กฎ migration: มีแต่ migration แบบ "เพิ่ม" เท่านั้น (Data Model ยืนยันแล้ว) — migration ที่ลบ/เปลี่ยนชนิดคอลัมน์ต้องมีแผนกู้คืนและได้รับอนุมัติก่อน; ห้ามแก้ไฟล์ migration ที่เคยใช้ไปแล้ว ให้เพิ่ม migration ใหม่แทน

## 5. ย้อนกลับ (rollback)

| สถานการณ์ | ทำอย่างไร |
|---|---|
| เวอร์ชันใหม่มีบั๊ก แต่ **ยังไม่ได้ migrate** หรือ migration เป็นแบบเพิ่มอย่างเดียว | `git checkout <แท็กเดิม>` → ตั้ง `RELEASE=<แท็กเดิม>` → `compose build && compose up -d` (ฐานข้อมูลคงเดิม) |
| migration ทำให้ข้อมูลเสียหาย | `deploy/scripts/restore.sh check` ไฟล์สำรองก่อน deploy → `CONFIRM_REPLACE_LIVE=yes deploy/scripts/restore.sh live <db.dump> <files.tar>` (ข้อมูลหลังสำรองจะหาย) |
| งานคิดค่าปรับคำนวณผิด | ปิดชั่วคราว: ใน `deploy/docker-compose.prod.yml` เปลี่ยน `SCHEDULER_ENABLED: "false"` → `compose up -d api`; แก้โค้ด; เปิดกลับ — งานตามเก็บย้อนหลังเองและไม่ซ้ำ (idempotent) |

## 6. สำรองข้อมูลและกู้คืน

**ตั้งเวลา (ตัวอย่าง crontab ของผู้ใช้ที่รัน Docker; ตีสองครึ่งทุกคืนตามเวลาไทย):**

```cron
CRON_TZ=Asia/Bangkok
30 2 * * *  LOAN_ENV_DIR=/etc/loan BACKUP_DIR=/var/backups/loan BACKUP_PASSPHRASE_FILE=/etc/loan/backup.pass /opt/loan/app/deploy/scripts/backup.sh >> /var/log/loan-backup.log 2>&1
```

- สร้างรหัสเข้ารหัสไฟล์สำรอง (ครั้งเดียว): `openssl rand -hex 32 > /etc/loan/backup.pass && chmod 600 /etc/loan/backup.pass` — **เก็บสำเนารหัสนี้ไว้ที่เก็บข้อ 7 ด้วย** ไม่งั้นไฟล์สำรองเปิดไม่ได้
- ไฟล์สำรองมี ชื่อ เบอร์โทร สลิป จึงต้องเข้ารหัสและจำกัดสิทธิ์ (สคริปต์ตั้งโฟลเดอร์ 700)
- เก็บไว้ 30 วัน (`KEEP_DAYS`) แล้วลบอัตโนมัติ
- **คัดลอกไปอีกเครื่องในประเทศไทย** ทุกคืน เช่น `rsync -a --delete-after /var/backups/loan/ backup@เครื่องสำรอง:/srv/loan-backups/`
- ให้ตรวจ `/var/log/loan-backup.log` หรือใช้บริการแจ้งเตือน cron ล้มเหลว — สคริปต์จะออกด้วยรหัสผิดพลาดและลบไฟล์ที่ไม่สมบูรณ์เสมอ

**ทดสอบกู้คืน (ทุกเดือน และหลังเปลี่ยนวิธีสำรอง):**

```bash
BACKUP_PASSPHRASE_FILE=/etc/loan/backup.pass deploy/scripts/restore.sh check /var/backups/loan/db-YYYYmmdd-HHMMSS.dump.enc
```
กู้ลงฐานข้อมูลชั่วคราว แสดงจำนวนแถวของตารางหลัก แล้วลบทิ้ง — **ระบบจริงไม่ถูกแตะ**

**กู้ภัยจริง (ระบบเสียหาย):**

```bash
# 0. ถ้าเครื่องเดิมยังใช้ได้ ให้ backup.sh สถานะปัจจุบันไว้ก่อน
# 1. เครื่องใหม่: ทำหัวข้อ 2.1–2.4 (ใช้ api.env/db.env เดิมที่เก็บไว้ โดยเฉพาะ FIELD_ENCRYPTION_KEY เดิม)
# 2. กู้ข้อมูล
CONFIRM_REPLACE_LIVE=yes BACKUP_PASSPHRASE_FILE=/etc/loan/backup.pass \
  deploy/scripts/restore.sh live db-....dump.enc files-....tar.enc
# 3. compose up -d proxy; deploy/scripts/verify-deploy.sh https://...
```
สคริปต์ทดลองกู้ลงฐานข้อมูลชั่วคราวก่อนเสมอ และ **จะไม่ทำลายอะไรถ้าไฟล์สำรองเสีย** (ผ่านการทดสอบด้วยไฟล์ขยะ) ใช้ `CONFIRM_REPLACE_LIVE=yes` จึงจะทำงาน

> สำคัญ: ถ้าใช้ `FIELD_ENCRYPTION_KEY` คนละตัวกับตอนสำรอง ระบบจะเริ่มได้แต่ **เลขบัญชีผู้ยืมจะอ่านไม่ออก** (หน้าผู้ยืมจะขึ้นข้อผิดพลาด)

## 7. Scheduler (งานตามเวลา)

- ทำงานในโปรเซส `api` เดียวกัน (`SCHEDULER_ENABLED=true` ตั้งไว้ใน compose) เวลา Asia/Bangkok: คิดค่าปรับ 00:05, แจ้งเตือนครบกำหนดวันนี้ 09:00, แจ้งเลยกำหนด 17:00
- **ต้องมี `api` ตัวเดียวเท่านั้น** ห้ามใช้ `--scale api=2` ถ้าวันหนึ่งต้องรันหลายเครื่อง ให้ตั้ง `SCHEDULER_ENABLED=false` ทุกเครื่องยกเว้นหนึ่งเครื่อง (ระบบมี advisory lock กันงานซ้ำเป็นด่านสุดท้าย แต่อย่าพึ่งมัน)
- เมื่อ api เริ่มทำงาน จะตามเก็บงานที่ตกหล่นเอง (เห็นใน log: `late-fee: checked …`, `notify-due-today: …`) — เครื่องดับข้ามคืนไม่ทำให้ค่าปรับขาด
- ตรวจ: `compose logs --since 24h api | grep -E "job .* finished|failed"`
- ตรวจเวลา: `compose exec api date` และ `compose exec api sh -c 'echo $TZ'` ต้องเป็น Asia/Bangkok

## 8. ติดตามระบบ

| เรื่อง | วิธี |
|---|---|
| สถานะ | `compose ps` (api, db = healthy) · ภายนอก: ตั้ง uptime monitor ที่ `https://โดเมน/api/health` |
| log | `compose logs -f --tail 100 api` (log หมุนอัตโนมัติ 5×10 MB ต่อบริการ; api ไม่บันทึกความลับ/รหัสผ่าน) |
| ดิสก์ | ดูพื้นที่ `docker system df` และ `/var/backups/loan` ทุกสัปดาห์ (สลิปอยู่ใน volume `loan_uploads`) |
| ใบรับรอง | ต่ออายุเองโดย Caddy; ถ้าเตือนใกล้หมดอายุ: `compose logs proxy` (มักเป็นเพราะ DNS/พอร์ต 80) |
| ปรับแพตช์ระบบ | เปิด security updates อัตโนมัติของ OS; อัปเดต image ฐาน (`compose build --pull`) ทุกเดือนผ่านขั้นตอน release (หัวข้อ 4) |

## 9. รายการตรวจความปลอดภัย (Security gate 🔒 — ติ๊กก่อนเปิดใช้จริง)

- [ ] `verify-deploy.sh` จากเครื่องภายนอกขึ้น ALL CHECKS PASSED
- [ ] พอร์ตที่เปิดภายนอกมีแค่ 80/443 (+SSH จำกัด) — ตรวจด้วย `nmap` จากภายนอก; SSH ใช้กุญแจ ปิดรหัสผ่าน
- [ ] `ls -ld /etc/loan` = `drwx------`, ไฟล์ข้างในเป็น `-rw-------` และเจ้าของคือผู้ใช้ที่รัน Docker เท่านั้น
- [ ] ไม่มี `.env` หรือความลับใดอยู่ใน repository / image (ตรวจแล้ว: image ไม่มีไฟล์ `.env` และไม่มีตัวแปรลับ)
- [ ] เปลี่ยนรหัสผ่านแอดมินเรียบร้อย (ระบบบังคับ) และ `ADMIN_PASSWORD` ไม่ค้างใน shell history
- [ ] ผูก LINE และ Web Push แล้ว ทดสอบส่งสำเร็จ
- [ ] ทำ `restore.sh check` สำเร็จอย่างน้อยหนึ่งครั้ง และมีสำเนาสำรองอยู่เครื่องอื่น (ในไทย)
- [ ] `FIELD_ENCRYPTION_KEY` และรหัสเข้ารหัสไฟล์สำรองเก็บแยกที่ปลอดภัยแล้ว
- [ ] ข้อความ PDPA ได้รับอนุมัติ; ผู้ให้กู้รับทราบว่า **ข้อความแจ้งเตือนผ่าน LINE และ Web Push (ชื่อผู้ยืม+จำนวนเงิน) ผ่านผู้ให้บริการรายนั้น ซึ่งอยู่นอกประเทศไทย** ก่อนตัดสินใจเปิดช่องทางนั้น
- [ ] เซิร์ฟเวอร์ ฐานข้อมูล สลิป และสำเนาสำรอง อยู่ในประเทศไทยทั้งหมด

## 10. แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| เว็บขึ้นเตือนใบรับรอง / เปิดไม่ได้ | DNS ยังไม่ชี้เครื่อง หรือพอร์ต 80/443 ถูกปิด → `compose logs proxy` |
| `api` ไม่ healthy | `compose logs api`: มักเป็นค่าใน `api.env` ผิด (ข้อความขึ้นต้น `Invalid environment`) หรือ db ยังไม่พร้อม |
| ล็อกอินแล้วเด้งกลับ | ต้องเข้าผ่าน **https** (คุกกี้เซสชันเป็น Secure) |
| ผู้ใช้ทุกคนโดนล็อกพร้อมกัน | ตัวจำกัดการล็อกอินเห็น IP ผิด → ตรวจ `TRUST_PROXY=1` และมี proxy เพียงชั้นเดียว (ถ้ามี CDN/โหลดบาลานเซอร์ก่อน Caddy ต้องปรับเลข) |
| ติดล็อกอิน (429) | รอ 15 นาที |
| Web Push ไม่มาถึง | ต้อง HTTPS + ผ่าน `make-vapid.sh` + เปิดสิทธิ์แจ้งเตือน; iPhone ต้องเปิดจากไอคอนหน้าจอโฮม; ถ้าเปลี่ยน VAPID ต้องกดเปิดการแจ้งเตือนใหม่ทุกเครื่อง |
| LINE ส่งไม่สำเร็จ | token ผิด/หมดอายุ, โควตาหมด, หรือยังไม่ได้ผูก LINE user id → กด "ส่งทดสอบ" ดูข้อความ |
| ลืมรหัสผ่านแอดมิน | `read -rsp … ADMIN_PASSWORD; export ADMIN_USERNAME=admin ADMIN_PASSWORD; compose run --rm -e ADMIN_USERNAME -e ADMIN_PASSWORD tools npm run admin:reset` |
| ฐานข้อมูลเต็มดิสก์ | ลบสำเนาสำรองเก่าที่เครื่องเดียวกัน (ไม่ใช่ข้อมูลระบบ), ขยายดิสก์ — ห้ามลบไฟล์ใน `/var/lib/docker/volumes` |
