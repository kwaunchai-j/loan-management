import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { ledgerSnapshot, lockContract, reconcileContract, withLedgerErrors, type Tx } from "./ledger.js";

/**
 * Recording, editing and deleting payments (DES-007, DES-011, DES-016). ADMIN only (router).
 * Each operation = lock the contract, change the Payment row, replay the whole contract, and write
 * an AuditLog row with the before/after of the record and of the contract's balances. If the replay
 * finds a broken rule the transaction is rolled back and nothing is saved.
 */
export interface PaymentFields {
  amount: string;
  paidOn: Date;
  note?: string | null;
}

const paymentAudit = (p: { amount: { toString(): string }; paidOn: Date; note: string | null; contractId: string }) => ({
  contractId: p.contractId,
  amount: p.amount.toString(),
  paidOn: formatDateOnly(p.paidOn),
  note: p.note,
});

/**
 * The ledger part of recording a payment, inside a transaction the caller owns: lock, check the
 * status, insert, replay the whole contract, audit. `recordPayment` is this plus its own transaction;
 * confirming a borrower's slip (submissions.ts) runs it in the same transaction as the confirmation,
 * so either both happen or neither does. A ledger violation is thrown as LedgerViolationError: the
 * caller wraps the transaction in `withLedgerErrors`.
 */
export async function recordPaymentInTx(
  tx: Tx,
  input: { contractId: string; actorId: string } & PaymentFields,
  today: Date,
  onCreated?: (paymentId: string) => void,
) {
  if (!(await lockContract(tx, input.contractId))) throw new DomainError(404, "NOT_FOUND", "ไม่พบสัญญา");
  const before = await tx.contract.findUniqueOrThrow({ where: { id: input.contractId } });
  if (before.status !== "ACTIVE") {
    throw new DomainError(409, "INVALID_STATE", "รับชำระได้เฉพาะสัญญาที่จ่ายเงินแล้วและยังไม่ปิด");
  }
  const created = await tx.payment.create({
    data: {
      contractId: input.contractId,
      amount: input.amount,
      paidOn: input.paidOn,
      note: input.note ?? null,
      recordedById: input.actorId,
    },
  });
  onCreated?.(created.id);
  // Replays the whole contract; a payment above what is owed on its day aborts everything.
  const { contract } = await reconcileContract(tx, input.contractId, today);
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: created.id } });
  await writeAuditLog(tx, {
    actorId: input.actorId,
    action: "payment.create",
    entityType: "Payment",
    entityId: payment.id,
    after: {
      ...paymentAudit(payment),
      allocatedLateFee: payment.allocatedLateFee,
      allocatedInterest: payment.allocatedInterest,
      allocatedPrincipal: payment.allocatedPrincipal,
    },
    extra: { contractBefore: ledgerSnapshot(before), contractAfter: ledgerSnapshot(contract) },
  });
  return { payment, contract };
}

export async function recordPayment(
  prisma: Db,
  input: { contractId: string; actorId: string } & PaymentFields,
  now: Date = new Date(),
) {
  const today = bangkokToday(now);
  let targetId: string | undefined;
  return withLedgerErrors(
    () => targetId,
    () =>
      prisma.$transaction((tx) =>
        recordPaymentInTx(tx, input, today, (id) => {
          targetId = id;
        }),
      ),
  );
}

async function changePayment(
  prisma: Db,
  paymentId: string,
  actorId: string,
  now: Date,
  apply: (tx: Parameters<Parameters<Db["$transaction"]>[0]>[0], before: { id: string; contractId: string }) => Promise<void>,
  action: "payment.update" | "payment.delete",
) {
  const today = bangkokToday(now);
  const found = await prisma.payment.findUnique({ where: { id: paymentId }, select: { contractId: true } });
  if (!found) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการรับชำระ");
  return withLedgerErrors(
    () => paymentId,
    () =>
      prisma.$transaction(async (tx) => {
        await lockContract(tx, found.contractId);
        const before = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!before) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการรับชำระ");
        const contractBefore = await tx.contract.findUniqueOrThrow({ where: { id: before.contractId } });
        await apply(tx, before);
        const { contract } = await reconcileContract(tx, before.contractId, today);
        const after = action === "payment.delete" ? null : await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        await writeAuditLog(tx, {
          actorId,
          action,
          entityType: "Payment",
          entityId: paymentId,
          // For a delete the whole row is kept here: the model has no soft-delete (DES-016).
          before: { ...paymentAudit(before), allocatedLateFee: before.allocatedLateFee, allocatedInterest: before.allocatedInterest, allocatedPrincipal: before.allocatedPrincipal, recordedById: before.recordedById, createdAt: before.createdAt },
          after: after ? { ...paymentAudit(after), allocatedLateFee: after.allocatedLateFee, allocatedInterest: after.allocatedInterest, allocatedPrincipal: after.allocatedPrincipal } : undefined,
          extra: { contractBefore: ledgerSnapshot(contractBefore), contractAfter: ledgerSnapshot(contract) },
        });
        return { payment: after, contract };
      }),
  );
}

export function updatePayment(
  prisma: Db,
  paymentId: string,
  actorId: string,
  patch: { amount?: string; paidOn?: Date; note?: string | null },
  now: Date = new Date(),
) {
  return changePayment(
    prisma,
    paymentId,
    actorId,
    now,
    async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
          ...(patch.paidOn !== undefined ? { paidOn: patch.paidOn } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
        },
      });
    },
    "payment.update",
  );
}

export function deletePayment(prisma: Db, paymentId: string, actorId: string, now: Date = new Date()) {
  return changePayment(
    prisma,
    paymentId,
    actorId,
    now,
    async (tx) => {
      await tx.payment.delete({ where: { id: paymentId } });
    },
    "payment.delete",
  );
}
