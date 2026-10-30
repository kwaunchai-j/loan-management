import type { Prisma } from "@prisma/client";
import { writeAuditLog } from "../lib/audit.js";
import { hashPassword, passwordPolicyViolation } from "../lib/password.js";

/** A message safe to show to the operator running the script. */
export class AdminScriptError extends Error {}

type Db = Pick<Prisma.TransactionClient, "user" | "auditLog">;

export interface ResetAdminResult {
  username: string;
  /** True when the account is switched off; the script does not turn it back on. */
  inactive: boolean;
}

/**
 * Recovery path for a forgotten ADMIN password (nobody else can reset it through the API).
 * Sets a new password, forces a change at next login, and — because the session token is tied to
 * the password hash — ends every existing session of that admin. Writes an AuditLog row; the
 * password itself is never logged.
 */
export async function resetAdminPassword(
  db: Db,
  input: { username: string; password: string },
): Promise<ResetAdminResult> {
  const username = input.username.trim();
  if (!username) throw new AdminScriptError("ต้องระบุ ADMIN_USERNAME");
  const violation = passwordPolicyViolation(input.password);
  if (violation) throw new AdminScriptError(`ADMIN_PASSWORD ใช้ไม่ได้: ${violation}`);

  const user = await db.user.findUnique({ where: { username } });
  // Same message for "missing" and "not an admin": this script only ever touches ADMIN accounts.
  if (!user || user.role !== "ADMIN") {
    throw new AdminScriptError(`ไม่พบบัญชี ADMIN ชื่อ "${username}" ไม่มีการเปลี่ยนแปลงใดๆ`);
  }

  const passwordHash = await hashPassword(input.password);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePassword: true },
  });
  await writeAuditLog(db, {
    actorId: null,
    action: "admin.resetPassword",
    entityType: "User",
    entityId: user.id,
    extra: { via: "scripts/reset-admin-password", username },
  });
  return { username, inactive: !user.isActive };
}
