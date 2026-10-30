import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { computeInterest, InterestError } from "../lib/interest.js";
import { requireRates } from "../lib/rates.js";
import { isValidSlipKey, type SlipStorage } from "../lib/slip-storage.js";
import { contractMoneyView } from "./views.js";

/**
 * Recording the payout of a loan (DES-006, DES-010, DES-011). ADMIN only (enforced by the router).
 * One transaction: Disbursement row + contract becomes ACTIVE with its interest computed and the
 * interest/late-fee rates snapshotted (later rate changes never touch this contract).
 */
export interface DisbursementInput {
  contractId: string;
  actorId: string;
  paidOn: Date;
  slipFileKey: string;
  note?: string;
  /** Optional: if sent it must equal the principal — the full amount is always paid out. */
  amount?: string;
}

export async function recordDisbursement(
  prisma: Db,
  storage: SlipStorage,
  input: DisbursementInput,
  now: Date = new Date(),
) {
  // Backdating is allowed (DES-011) but not into the future.
  if (input.paidOn.getTime() > bangkokToday(now).getTime()) {
    throw new DomainError(400, "PAID_ON_FUTURE", "วันที่จ่ายเงินต้องไม่เป็นวันในอนาคต");
  }
  // A slip is mandatory: it must be one we stored (a key we generated and whose file exists).
  if (!isValidSlipKey(input.slipFileKey) || !(await storage.exists(input.slipFileKey))) {
    throw new DomainError(400, "SLIP_NOT_FOUND", "ไม่พบไฟล์สลิป กรุณาอัปโหลดสลิปก่อนบันทึกการจ่ายเงิน");
  }

  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUnique({ where: { id: input.contractId } });
    if (!contract) throw new DomainError(404, "NOT_FOUND", "ไม่พบสัญญา");
    if (contract.status !== "AWAITING_DISBURSEMENT") {
      throw new DomainError(409, "INVALID_STATE", "สัญญานี้ไม่ได้อยู่ในสถานะรอจ่ายเงิน");
    }
    if (input.amount !== undefined && !contract.principal.equals(input.amount)) {
      throw new DomainError(400, "AMOUNT_MISMATCH", "จำนวนที่จ่ายต้องเท่ากับจำนวนที่ขอ");
    }
    if (await tx.disbursement.findFirst({ where: { slipFileKey: input.slipFileKey }, select: { id: true } })) {
      throw new DomainError(409, "SLIP_ALREADY_USED", "สลิปนี้ถูกใช้กับการจ่ายเงินรายการอื่นแล้ว");
    }

    // Refuses (409 RATES_NOT_SET) until an admin has set both rates.
    const rates = await requireRates(tx);

    let result;
    try {
      result = computeInterest({
        principal: contract.principal,
        ratePctPerMonth: rates.interestRatePctPerMonth,
        disbursedOn: input.paidOn,
        dueDate: contract.dueDate,
      });
    } catch (err) {
      if (err instanceof InterestError && err.code === "INVALID_DAYS") {
        throw new DomainError(
          400,
          "DUE_DATE_TOO_SOON",
          "วันครบกำหนดต้องอยู่หลังวันที่จ่ายเงินอย่างน้อย 1 วัน",
        );
      }
      throw err;
    }

    // The status guard makes a concurrent second disbursement of the same contract fail here.
    const claimed = await tx.contract.updateMany({
      where: { id: contract.id, status: "AWAITING_DISBURSEMENT" },
      data: {
        status: "ACTIVE",
        disbursedOn: input.paidOn,
        interestRatePctPerMonth: rates.interestRatePctPerMonth,
        lateFeeRatePctPerDay: rates.lateFeeRatePctPerDay,
        interestAmount: result.interestAmount,
        outstandingInterest: result.interestAmount,
        outstandingPrincipal: contract.principal,
      },
    });
    if (claimed.count === 0) {
      throw new DomainError(409, "INVALID_STATE", "สัญญานี้ไม่ได้อยู่ในสถานะรอจ่ายเงิน");
    }

    let disbursement;
    try {
      disbursement = await tx.disbursement.create({
        data: {
          contractId: contract.id,
          amount: contract.principal,
          paidOn: input.paidOn,
          slipFileKey: input.slipFileKey,
          note: input.note,
          recordedById: input.actorId,
        },
      });
    } catch (err) {
      // Disbursement.contractId is unique: a lost race for the same contract is a conflict, not a crash.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new DomainError(409, "INVALID_STATE", "สัญญานี้ถูกบันทึกการจ่ายเงินไปแล้ว");
      }
      throw err;
    }

    await writeAuditLog(tx, {
      actorId: input.actorId,
      action: "disbursement.create",
      entityType: "Contract",
      entityId: contract.id,
      before: { status: "AWAITING_DISBURSEMENT" },
      after: { status: "ACTIVE", disbursedOn: formatDateOnly(input.paidOn) },
      extra: {
        contractNo: contract.contractNo,
        disbursementId: disbursement.id,
        amount: contract.principal,
        days: result.days,
        interestAmount: result.interestAmount,
        interestRatePctPerMonth: rates.interestRatePctPerMonth,
        lateFeeRatePctPerDay: rates.lateFeeRatePctPerDay,
      },
    });

    const updated = await tx.contract.findUniqueOrThrow({ where: { id: contract.id } });
    return { contract: updated, disbursement };
  });
}

export function disbursementView(r: Awaited<ReturnType<typeof recordDisbursement>>) {
  return {
    contract: contractMoneyView(r.contract),
    disbursement: {
      id: r.disbursement.id,
      amount: r.disbursement.amount.toString(),
      paidOn: formatDateOnly(r.disbursement.paidOn),
      note: r.disbursement.note,
      slipFileKey: r.disbursement.slipFileKey,
    },
  };
}
