import type { Prisma } from "@prisma/client";
import { maskAccountNumber } from "./field-crypto.js";

/**
 * AuditLog writer (DES-016). Money records are edited and deleted by ADMIN, so every such
 * change must leave a before/after trail. The model has no `updatedAt` on records —
 * the history lives here only.
 *
 * Pass the transaction client (`tx`) so the audit row commits or rolls back together with
 * the change it describes.
 */
export type AuditDb = Pick<Prisma.TransactionClient, "auditLog">;

export interface AuditEntry {
  /** null for system actors (scheduler jobs). */
  actorId: string | null;
  /** Caller-defined verb, e.g. "payment.update". Must be non-empty. */
  action: string;
  entityType: string;
  entityId: string;
  /** Record state before the change; omit for creates. For deletes this is the whole deleted row. */
  before?: unknown;
  /** Record state after the change; omit for deletes. */
  after?: unknown;
  /** Extra context, e.g. the effect on contract balances. */
  extra?: Record<string, unknown>;
}

const REDACTED = "[REDACTED]";
// Secrets must never reach the log (HANDOFF rule 8). Matched against object keys.
// Exact names for password-like fields so flags such as `mustChangePassword` stay visible;
// `auth` is the PushSubscription auth secret.
const SECRET_KEY = /^(password|passwordHash|newPassword|currentPassword|auth)$|secret|token|private.?key|api.?key/i;

/**
 * Turn arbitrary values into JSON-safe data: Decimal -> string, Date -> ISO string,
 * undefined dropped, secret-looking keys redacted, `bankAccountNo` masked. Using JSON round-trip keeps Decimal
 * exact (Decimal#toJSON is a string) instead of letting it become a float.
 */
export function toAuditJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value, (key, v: unknown) => {
    if (key === "") return v;
    if (SECRET_KEY.test(key)) return REDACTED;
    // Bank account numbers are kept only as "****1234" (decision D1), whoever the caller is.
    if (key === "bankAccountNo" && typeof v === "string") return maskAccountNumber(v);
    return v;
  });
  if (text === undefined) return null;
  return JSON.parse(text) as Prisma.InputJsonValue;
}

export function buildAuditDetail(
  entry: Pick<AuditEntry, "before" | "after" | "extra">,
): Prisma.InputJsonValue | undefined {
  const detail: Record<string, unknown> = {};
  if (entry.before !== undefined) detail.before = entry.before;
  if (entry.after !== undefined) detail.after = entry.after;
  if (entry.extra) Object.assign(detail, entry.extra);
  if (Object.keys(detail).length === 0) return undefined;
  const json = toAuditJson(detail);
  return json ?? undefined;
}

export async function writeAuditLog(db: AuditDb, entry: AuditEntry) {
  if (!entry.action.trim() || !entry.entityType.trim() || !entry.entityId.trim()) {
    throw new Error("audit entry requires action, entityType and entityId");
  }
  if ((entry.extra && "before" in entry.extra) || (entry.extra && "after" in entry.extra)) {
    throw new Error("audit extra must not use the reserved keys 'before' or 'after'");
  }
  return db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      detail: buildAuditDetail(entry),
    },
  });
}
