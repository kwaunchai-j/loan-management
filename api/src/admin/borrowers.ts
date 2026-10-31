import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AuthMiddleware } from "../auth/middleware.js";
import { asyncHandler, sendError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { FieldCipher } from "../lib/field-crypto.js";
import { bankAccountNoField, bankNameField, phoneField } from "../lib/borrower-fields.js";
import { hashPassword, passwordPolicyViolation } from "../lib/password.js";

/**
 * Admin management of borrowers and their login accounts (DES-001, DES-002, DES-008).
 * ADMIN only. This is the only place the bank account number is returned to a client.
 */

const username = z
  .string()
  .trim()
  .regex(/^\S{1,64}$/, "ชื่อผู้ใช้ต้องไม่มีช่องว่างและยาวไม่เกิน 64 ตัวอักษร");
const fullName = z.string().trim().min(1).max(200);
const phone = phoneField;
const bankName = bankNameField;
const bankAccountNo = bankAccountNoField;
const newPassword = z.string().min(1).max(1024);

const createBody = z.object({
  username,
  password: newPassword,
  fullName,
  // Optional (CR-5): the admin creates the account with the name, and the borrower fills in the phone number
  // and the bank account themself after the first login (PATCH /me/profile). The admin may still give them.
  phone: phone.optional(),
  bankName: bankName.optional(),
  bankAccountNo: bankAccountNo.optional(),
});

const updateBody = z
  .object({
    fullName: fullName.optional(),
    phone: phone.optional(),
    bankName: bankName.optional(),
    bankAccountNo: bankAccountNo.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "ไม่มีข้อมูลที่ต้องแก้ไข");

const activeBody = z.object({ isActive: z.boolean() });
const resetBody = z.object({ newPassword });
const idParam = z.string().min(1).max(40);
const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const borrowerSelect = {
  id: true,
  fullName: true,
  phone: true,
  bankName: true,
  bankAccountNo: true,
  pdpaAcceptedAt: true,
  pdpaVersion: true,
  createdAt: true,
  user: { select: { id: true, username: true, isActive: true, mustChangePassword: true } },
} satisfies Prisma.BorrowerSelect;

type BorrowerRow = Prisma.BorrowerGetPayload<{ select: typeof borrowerSelect }>;

function view(b: BorrowerRow) {
  const { user, ...rest } = b;
  return {
    ...rest,
    // null for borrowers created by import: they have a name only and no login yet.
    account: user
      ? {
          userId: user.id,
          username: user.username,
          isActive: user.isActive,
          mustChangePassword: user.mustChangePassword,
        }
      : null,
  };
}

const profileOf = (b: BorrowerRow) => ({
  fullName: b.fullName,
  phone: b.phone,
  bankName: b.bankName,
  bankAccountNo: b.bankAccountNo,
});

export function createAdminBorrowersRouter(deps: {
  prisma: Db;
  auth: AuthMiddleware;
  cipher: FieldCipher;
}): Router {
  const router = Router();
  const { prisma, cipher } = deps;
  router.use(deps.auth.authorize("ADMIN"));

  // bankAccountNo is stored encrypted (decision D1); every row read from the database goes through
  // `open` so responses and audit entries are built from the decrypted value (audit then masks it).
  const open = (b: BorrowerRow): BorrowerRow => ({
    ...b,
    bankAccountNo: b.bankAccountNo === null ? null : cipher.decrypt(b.bankAccountNo),
  });

  async function findOr404(res: Parameters<typeof sendError>[0], rawId: unknown) {
    const id = idParam.safeParse(rawId);
    const row = id.success
      ? await prisma.borrower.findUnique({ where: { id: id.data }, select: borrowerSelect })
      : null;
    if (!row) sendError(res, 404, "NOT_FOUND", "ไม่พบผู้ยืม");
    return row ? open(row) : null;
  }

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const body = createBody.safeParse(req.body);
      if (!body.success) {
        return sendError(res, 400, "VALIDATION_ERROR", body.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      }
      const data = body.data;
      const violation = passwordPolicyViolation(data.password);
      if (violation) return sendError(res, 400, "WEAK_PASSWORD", violation);

      // Names that differ only by case would be confusable (and share a login throttle).
      const clash = await prisma.user.findFirst({
        where: { username: { equals: data.username, mode: "insensitive" } },
        select: { id: true },
      });
      if (clash) return sendError(res, 409, "USERNAME_TAKEN", "ชื่อผู้ใช้นี้ถูกใช้แล้ว");

      const passwordHash = await hashPassword(data.password);
      try {
        const created = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { username: data.username, passwordHash, role: "BORROWER", mustChangePassword: true },
          });
          const borrower = await tx.borrower.create({
            data: {
              userId: user.id,
              fullName: data.fullName,
              phone: data.phone ?? null,
              bankName: data.bankName ?? null,
              bankAccountNo: data.bankAccountNo === undefined ? null : cipher.encrypt(data.bankAccountNo),
            },
            select: borrowerSelect,
          });
          await writeAuditLog(tx, {
            actorId: req.user!.id,
            action: "borrower.create",
            entityType: "Borrower",
            entityId: borrower.id,
            after: { ...profileOf(open(borrower)), username: user.username, userId: user.id },
          });
          return borrower;
        });
        return res.status(201).json(view(open(created)));
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return sendError(res, 409, "USERNAME_TAKEN", "ชื่อผู้ใช้นี้ถูกใช้แล้ว");
        }
        throw err;
      }
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) return sendError(res, 400, "VALIDATION_ERROR", "พารามิเตอร์ค้นหาไม่ถูกต้อง");
      const where: Prisma.BorrowerWhereInput = q.data.q
        ? { fullName: { contains: q.data.q, mode: "insensitive" } }
        : {};
      const [total, rows] = await Promise.all([
        prisma.borrower.count({ where }),
        prisma.borrower.findMany({
          where,
          select: borrowerSelect,
          orderBy: [{ fullName: "asc" }, { id: "asc" }],
          take: q.data.limit,
          skip: q.data.offset,
        }),
      ]);
      res.status(200).json({ total, items: rows.map((r) => view(open(r))) });
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const row = await findOr404(res, req.params.id);
      if (row) res.status(200).json(view(row));
    }),
  );

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const body = updateBody.safeParse(req.body);
      if (!body.success) {
        return sendError(res, 400, "VALIDATION_ERROR", body.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      }
      const before = await findOr404(res, req.params.id);
      if (!before) return;
      const { bankAccountNo, ...rest } = body.data;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.borrower.update({
          where: { id: before.id },
          data: {
            ...rest,
            ...(bankAccountNo !== undefined ? { bankAccountNo: cipher.encrypt(bankAccountNo) } : {}),
          },
          select: borrowerSelect,
        });
        await writeAuditLog(tx, {
          actorId: req.user!.id,
          action: "borrower.update",
          entityType: "Borrower",
          entityId: row.id,
          before: profileOf(before),
          after: profileOf(open(row)),
          // The account number is masked in audit, so name the fields that were sent for change.
          extra: { changedFields: Object.keys(body.data) },
        });
        return row;
      });
      res.status(200).json(view(open(updated)));
    }),
  );

  router.put(
    "/:id/active",
    asyncHandler(async (req, res) => {
      const body = activeBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาระบุ isActive เป็น true หรือ false");
      const before = await findOr404(res, req.params.id);
      if (!before) return;
      if (!before.user) {
        return sendError(res, 409, "NO_ACCOUNT", "ผู้ยืมรายนี้ยังไม่มีบัญชีเข้าสู่ระบบ");
      }
      const userId = before.user.id;
      const updated = await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { isActive: body.data.isActive } });
        await writeAuditLog(tx, {
          actorId: req.user!.id,
          action: "borrower.setActive",
          entityType: "Borrower",
          entityId: before.id,
          before: { isActive: before.user!.isActive },
          after: { isActive: body.data.isActive },
          extra: { userId },
        });
        return tx.borrower.findUniqueOrThrow({ where: { id: before.id }, select: borrowerSelect });
      });
      res.status(200).json(view(open(updated)));
    }),
  );

  router.post(
    "/:id/reset-password",
    asyncHandler(async (req, res) => {
      const body = resetBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "VALIDATION_ERROR", "กรุณากรอกรหัสผ่านใหม่");
      const violation = passwordPolicyViolation(body.data.newPassword);
      if (violation) return sendError(res, 400, "WEAK_PASSWORD", violation);
      const before = await findOr404(res, req.params.id);
      if (!before) return;
      if (!before.user) {
        return sendError(res, 409, "NO_ACCOUNT", "ผู้ยืมรายนี้ยังไม่มีบัญชีเข้าสู่ระบบ");
      }
      const userId = before.user.id;
      const passwordHash = await hashPassword(body.data.newPassword);
      const updated = await prisma.$transaction(async (tx) => {
        // New hash => every existing session token of this user stops working (password fingerprint).
        await tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: true } });
        // The password itself is never written to the audit log.
        await writeAuditLog(tx, {
          actorId: req.user!.id,
          action: "borrower.resetPassword",
          entityType: "Borrower",
          entityId: before.id,
          extra: { userId },
        });
        return tx.borrower.findUniqueOrThrow({ where: { id: before.id }, select: borrowerSelect });
      });
      res.status(200).json(view(open(updated)));
    }),
  );

  return router;
}
