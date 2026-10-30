import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { computeInterest, InterestError } from "../lib/interest.js";
import { isValidSlipKey, type SlipStorage } from "../lib/slip-storage.js";
import { ledgerSnapshot, lockContract, reconcileContract, withLedgerErrors } from "./ledger.js";

/**
 * Editing and deleting a Disbursement (DES-016), ADMIN only (router). Same recipe as payments:
 * lock, change, replay the whole contract, audit before/after.
 *  - edit: paidOn (interest is recomputed from the contract's own snapshotted rate), slip, note.
 *    The amount can never change: it always equals the principal.
 *  - delete: only while the contract has no payments; the contract goes back to AWAITING_DISBURSEMENT.
 */
const disbursementAudit = (d: { amount: Prisma.Decimal; paidOn: Date; slipFileKey: string; note: string | null }) => ({
  amount: d.amount,
  paidOn: formatDateOnly(d.paidOn),
  slipFileKey: d.slipFileKey,
  note: d.note,
});

export async function updateDisbursement(
  prisma: Db,
  storage: SlipStorage,
  disbursementId: string,
  actorId: string,
  patch: { paidOn?: Date; slipFileKey?: string; note?: string | null },
  now: Date = new Date(),
) {
  const today = bangkokToday(now);
  const found = await prisma.disbursement.findUnique({ where: { id: disbursementId }, select: { contractId: true } });
  if (!found) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการจ่ายเงิน");

  if (patch.paidOn && patch.paidOn.getTime() > today.getTime()) {
    throw new DomainError(400, "PAID_ON_FUTURE", "วันที่จ่ายเงินต้องไม่เป็นวันในอนาคต");
  }
  if (patch.slipFileKey !== undefined && (!isValidSlipKey(patch.slipFileKey) || !(await storage.exists(patch.slipFileKey)))) {
    throw new DomainError(400, "SLIP_NOT_FOUND", "ไม่พบไฟล์สลิป กรุณาอัปโหลดสลิปก่อน");
  }

  return withLedgerErrors(
    () => undefined,
    () =>
      prisma.$transaction(async (tx) => {
        await lockContract(tx, found.contractId);
        const before = await tx.disbursement.findUnique({ where: { id: disbursementId } });
        if (!before) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการจ่ายเงิน");
        const contractBefore = await tx.contract.findUniqueOrThrow({ where: { id: before.contractId } });

        if (patch.slipFileKey !== undefined && patch.slipFileKey !== before.slipFileKey) {
          const used = await tx.disbursement.findFirst({
            where: { slipFileKey: patch.slipFileKey, id: { not: disbursementId } },
            select: { id: true },
          });
          if (used) throw new DomainError(409, "SLIP_ALREADY_USED", "สลิปนี้ถูกใช้กับการจ่ายเงินรายการอื่นแล้ว");
        }

        if (patch.paidOn && patch.paidOn.getTime() !== before.paidOn.getTime()) {
          // The payout date drives the interest (DES-010): recompute with this contract's own rate.
          if (contractBefore.interestRatePctPerMonth === null) {
            throw new Error(`contract ${contractBefore.id} has a disbursement but no interest rate`);
          }
          let interestAmount: Prisma.Decimal;
          try {
            interestAmount = computeInterest({
              principal: contractBefore.principal,
              ratePctPerMonth: contractBefore.interestRatePctPerMonth,
              disbursedOn: patch.paidOn,
              dueDate: contractBefore.dueDate,
            }).interestAmount;
          } catch (err) {
            if (err instanceof InterestError && err.code === "INVALID_DAYS") {
              throw new DomainError(400, "DUE_DATE_TOO_SOON", "วันครบกำหนดต้องอยู่หลังวันที่จ่ายเงินอย่างน้อย 1 วัน");
            }
            throw err;
          }
          await tx.contract.update({
            where: { id: contractBefore.id },
            data: { disbursedOn: patch.paidOn, interestAmount },
          });
        }

        await tx.disbursement.update({
          where: { id: disbursementId },
          data: {
            ...(patch.paidOn !== undefined ? { paidOn: patch.paidOn } : {}),
            ...(patch.slipFileKey !== undefined ? { slipFileKey: patch.slipFileKey } : {}),
            ...(patch.note !== undefined ? { note: patch.note } : {}),
          },
        });
        const { contract } = await reconcileContract(tx, before.contractId, today);
        const after = await tx.disbursement.findUniqueOrThrow({ where: { id: disbursementId } });
        await writeAuditLog(tx, {
          actorId,
          action: "disbursement.update",
          entityType: "Disbursement",
          entityId: disbursementId,
          before: disbursementAudit(before),
          after: disbursementAudit(after),
          extra: {
            contractId: contract.id,
            interestBefore: contractBefore.interestAmount,
            interestAfter: contract.interestAmount,
            contractBefore: ledgerSnapshot(contractBefore),
            contractAfter: ledgerSnapshot(contract),
          },
        });
        return { disbursement: after, contract };
      }),
  );
}

export async function deleteDisbursement(prisma: Db, disbursementId: string, actorId: string) {
  const found = await prisma.disbursement.findUnique({ where: { id: disbursementId }, select: { contractId: true } });
  if (!found) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการจ่ายเงิน");
  return prisma.$transaction(async (tx) => {
    await lockContract(tx, found.contractId);
    const before = await tx.disbursement.findUnique({ where: { id: disbursementId } });
    if (!before) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการจ่ายเงิน");
    const contractBefore = await tx.contract.findUniqueOrThrow({ where: { id: before.contractId } });
    if ((await tx.payment.count({ where: { contractId: before.contractId } })) > 0) {
      throw new DomainError(409, "HAS_PAYMENTS", "ลบการจ่ายเงินไม่ได้ ต้องลบรายการรับชำระของสัญญานี้ก่อน");
    }
    await tx.lateFeeAccrual.deleteMany({ where: { contractId: before.contractId } });
    await tx.disbursement.delete({ where: { id: disbursementId } });
    // Back to "waiting for disbursement" (DES-016). outstandingPrincipal is already the principal.
    const contract = await tx.contract.update({
      where: { id: before.contractId },
      data: {
        status: "AWAITING_DISBURSEMENT",
        disbursedOn: null,
        interestRatePctPerMonth: null,
        lateFeeRatePctPerDay: null,
        interestAmount: null,
        outstandingPrincipal: contractBefore.principal,
        outstandingInterest: 0,
        accruedLateFee: 0,
        closedOn: null,
      },
    });
    await writeAuditLog(tx, {
      actorId,
      action: "disbursement.delete",
      entityType: "Disbursement",
      entityId: disbursementId,
      // The whole deleted row is kept here: the model has no soft-delete (DES-016).
      before: { ...disbursementAudit(before), contractId: before.contractId, recordedById: before.recordedById, createdAt: before.createdAt },
      extra: { contractBefore: ledgerSnapshot(contractBefore), contractAfter: ledgerSnapshot(contract) },
    });
    return { contract };
  });
}
