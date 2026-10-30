import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { AdminScriptError, resetAdminPassword } from "./admin-accounts.js";

/**
 * Resets the password of an existing ADMIN from environment variables (never hard-coded).
 *   ADMIN_USERNAME, ADMIN_PASSWORD  ->  npm run admin:reset
 * Run it on the server with shell access. Remove ADMIN_PASSWORD from the environment afterwards.
 */
async function main() {
  const username = process.env.ADMIN_USERNAME ?? "";
  const password = process.env.ADMIN_PASSWORD;
  if (!username.trim() || !password) {
    throw new AdminScriptError("ต้องตั้ง ADMIN_USERNAME และ ADMIN_PASSWORD ใน environment ก่อน");
  }
  const prisma = new PrismaClient();
  try {
    const result = await resetAdminPassword(prisma, { username, password });
    console.log(`รีเซ็ตรหัสผ่านของ ADMIN "${result.username}" แล้ว ต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งถัดไป`);
    if (result.inactive) {
      console.warn("คำเตือน: บัญชีนี้ถูกปิดการใช้งานอยู่ สคริปต์ไม่ได้เปิดให้ — ต้องแก้ isActive ใน DB เอง");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof AdminScriptError ? err.message : "ล้มเหลว (ไม่ทราบสาเหตุ)");
  process.exitCode = 1;
});
