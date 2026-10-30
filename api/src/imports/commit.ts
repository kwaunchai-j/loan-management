import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { withJobLock } from "../jobs/scheduler.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { requireRates } from "../lib/rates.js";
import { lockContract, reconcileContract } from "../loans/ledger.js";
import { contractNumbers } from "../loans/service.js";
import { analyzeRows, loadBorrowerIndex, MAX_BACKFILL_ACCRUALS, matchName } from "./analyze.js";
import { ImportFileError, readUpload } from "./parse-file.js";
import { STAGED_MAX_AGE_MS, type ImportStorage } from "./storage.js";
import { parseRows } from "./validate.js";

/**
 * Confirming an import and undoing it (T-602, DES-014 §2, §4, §6).
 *
 * Confirm re-reads the staged file and re-checks everything on the server — nothing the browser
 * says about the preview is trusted — then, in ONE transaction: creates the new borrowers, one
 * ImportBatch and one Contract per valid row (isImported, ACTIVE, no Disbursement, no LoanRequest;
 * the interest is the file's, never computed from a rate) and writes the back-dated late fees of
 * overdue rows with the ledger's own replay. Either everything is saved or nothing.
 * Rollback deletes a batch's contracts and fees, but only while none of them has a payment.
 */
export interface CommitInput {
  importKey: string;
  fileName: string;
  /** For a name shared by several borrowers: the borrower the admin picked, by exact (tidied) name. */
  choices: Record<string, string>;
  /** Must be true to import while some rows are invalid (they are then skipped, not imported). */
  skipInvalidRows: boolean;
  actorId: string;
}

export interface CommitResult {
  batchId: string;
  contractsCreated: number;
  borrowersCreated: number;
  borrowersLinked: number;
  skippedRows: number;
  totalPrincipal: string;
  totalInterest: string;
  lateFeeBackfilled: string;
  lateFeeRows: number;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 10 * 60 * 1000 } as const;

async function doCommit(prisma: Db, storage: ImportStorage, input: CommitInput, now: Date): Promise<CommitResult> {
  const staged = await storage.get(input.importKey);
  if (!staged || now.getTime() - staged.createdAt.getTime() > STAGED_MAX_AGE_MS) {
    throw new DomainError(404, "IMPORT_NOT_FOUND", "ไม่พบไฟล์นำเข้า (หมดอายุแล้ว หรือถูกนำเข้าไปแล้ว) กรุณาอัปโหลดใหม่");
  }

  let parsed;
  try {
    parsed = parseRows((await readUpload(staged.data)).rows);
  } catch (err) {
    if (err instanceof ImportFileError) throw new DomainError(400, "INVALID_FILE", err.message);
    throw err;
  }

  // Refuses (409 RATES_NOT_SET) until an admin has set the rates: the late-fee rate is snapshotted.
  const rates = await requireRates(prisma);
  const today = bangkokToday(now);
  const analyzed = analyzeRows(parsed, await loadBorrowerIndex(prisma), today, rates.lateFeeRatePctPerDay);
  const valid = analyzed.filter((r) => r.errors.length === 0);
  const invalid = analyzed.length - valid.length;
  if (invalid > 0 && !input.skipInvalidRows) {
    throw new DomainError(409, "INVALID_ROWS_PRESENT", `มี ${invalid} แถวที่ไม่ถูกต้อง ต้องยืนยันว่าจะข้ามแถวเหล่านั้น (skipInvalidRows) หรือแก้ไฟล์แล้วอัปโหลดใหม่`);
  }
  if (valid.length === 0) throw new DomainError(400, "NO_VALID_ROWS", "ไม่มีแถวที่นำเข้าได้");
  if (valid.reduce((n, r) => n + r.lateDays, 0) > MAX_BACKFILL_ACCRUALS) {
    throw new DomainError(409, "TOO_MANY_LATE_DAYS", "จำนวนวันค่าปรับย้อนหลังรวมมากเกินไป กรุณาแบ่งไฟล์");
  }

  const year = formatDateOnly(today).slice(0, 4);
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Match again inside the transaction: borrowers may have changed since the preview.
        const index = await loadBorrowerIndex(tx);
        const unresolved = new Set<string>();
        const borrowerOf = new Map<string, string>(); // name -> existing borrower id
        const toCreate = new Set<string>();
        for (const r of valid) {
          if (borrowerOf.has(r.name) || toCreate.has(r.name)) continue;
          const m = matchName(index, r.name);
          if (m.status === "EXISTING") borrowerOf.set(r.name, m.borrowerId);
          else if (m.status === "NEW") toCreate.add(r.name);
          else {
            const chosen = input.choices[r.name];
            if (chosen !== undefined && m.candidates.some((c) => c.borrowerId === chosen)) borrowerOf.set(r.name, chosen);
            else unresolved.add(r.name);
          }
        }
        if (unresolved.size > 0) {
          throw new DomainError(409, "AMBIGUOUS_BORROWER_NOT_CHOSEN", `ต้องเลือกผู้ยืมสำหรับชื่อที่ซ้ำกันในระบบ: ${[...unresolved].slice(0, 10).join(", ")}`);
        }

        for (const name of toCreate) {
          borrowerOf.set(name, (await tx.borrower.create({ data: { fullName: name }, select: { id: true } })).id);
        }

        const batch = await tx.importBatch.create({
          data: { fileName: input.fileName, importedById: input.actorId, rowCount: valid.length },
        });
        const numbers = await contractNumbers(tx, year, valid.length);
        let principal = new Prisma.Decimal(0);
        let interest = new Prisma.Decimal(0);
        let lateFee = new Prisma.Decimal(0);
        let lateFeeRows = 0;
        for (const [i, r] of valid.entries()) {
          const c = await tx.contract.create({
            data: {
              contractNo: numbers[i]!,
              borrowerId: borrowerOf.get(r.name)!,
              principal: r.amount!,
              dueDate: r.dueDate!,
              status: "ACTIVE",
              disbursedOn: null,
              // the interest comes from the file; the rate is not used (DES-014)
              interestRatePctPerMonth: null,
              lateFeeRatePctPerDay: rates.lateFeeRatePctPerDay,
              interestAmount: r.interest!,
              outstandingPrincipal: r.amount!,
              outstandingInterest: r.interest!,
              isImported: true,
              importBatchId: batch.id,
            },
          });
          principal = principal.plus(r.amount!);
          interest = interest.plus(r.interest!);
          if (r.dueDate!.getTime() < today.getTime()) {
            // back-dated late fees from the day after the due date until today, by the ledger's replay
            const { contract, sim } = await reconcileContract(tx, c.id, today);
            lateFee = lateFee.plus(contract.accruedLateFee);
            lateFeeRows += sim.ok ? sim.accruals.length : 0;
          }
        }

        const linked = new Set([...borrowerOf.entries()].filter(([n]) => !toCreate.has(n)).map(([, id]) => id)).size;
        const summary: CommitResult = {
          batchId: batch.id,
          contractsCreated: valid.length,
          borrowersCreated: toCreate.size,
          borrowersLinked: linked,
          skippedRows: invalid,
          totalPrincipal: principal.toString(),
          totalInterest: interest.toString(),
          lateFeeBackfilled: lateFee.toString(),
          lateFeeRows,
        };
        await writeAuditLog(tx, {
          actorId: input.actorId,
          action: "import.commit",
          entityType: "ImportBatch",
          entityId: batch.id,
          extra: { fileName: input.fileName, ...summary },
        });
        return summary;
      }, TX_OPTIONS);
      return result;
    } catch (err) {
      // two numbers can collide with a concurrent approval: nothing was saved, try again with fresh numbers
      const collision =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && String(err.meta?.target ?? "").includes("contractNo");
      if (!collision || attempt >= 3) throw err;
    }
  }
}

export async function commitImport(prisma: Db, storage: ImportStorage, input: CommitInput, now: Date = new Date()): Promise<CommitResult> {
  let result: CommitResult | undefined;
  // One confirm per staged file at a time (and a file confirmed once is gone): no double import.
  const ran = await withJobLock(prisma, `import:${input.importKey}`, async () => {
    result = await doCommit(prisma, storage, input, now);
    await storage.delete(input.importKey);
  });
  if (!ran) throw new DomainError(409, "IMPORT_IN_PROGRESS", "ไฟล์นี้กำลังถูกนำเข้าอยู่");
  return result!;
}

// ---------------------------------------------------------------------------------------------

export async function rollbackBatch(prisma: Db, batchId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new DomainError(404, "NOT_FOUND", "ไม่พบชุดนำเข้า");
    if (batch.status !== "COMPLETED") throw new DomainError(409, "ALREADY_ROLLED_BACK", "ชุดนำเข้านี้ถูกย้อนกลับไปแล้ว");

    const contracts = await tx.contract.findMany({ where: { importBatchId: batchId }, select: { id: true, contractNo: true } });
    // Lock every contract first, so a payment being recorded right now either lands before the check or waits.
    for (const c of contracts) await lockContract(tx, c.id);
    const withPayments = await tx.payment.groupBy({ by: ["contractId"], where: { contractId: { in: contracts.map((c) => c.id) } }, _count: { _all: true } });
    if (withPayments.length > 0) {
      const nos = contracts.filter((c) => withPayments.some((p) => p.contractId === c.id)).map((c) => c.contractNo);
      throw new DomainError(409, "HAS_PAYMENTS", `ย้อนกลับไม่ได้ เพราะมีรายการรับชำระแล้วในสัญญา: ${nos.slice(0, 10).join(", ")}${nos.length > 10 ? " ..." : ""}`);
    }

    const ids = contracts.map((c) => c.id);
    const fees = await tx.lateFeeAccrual.deleteMany({ where: { contractId: { in: ids } } });
    await tx.notificationLog.updateMany({ where: { contractId: { in: ids } }, data: { contractId: null } });
    await tx.contract.deleteMany({ where: { id: { in: ids } } });
    const updated = await tx.importBatch.update({ where: { id: batchId }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
    await writeAuditLog(tx, {
      actorId,
      action: "import.rollback",
      entityType: "ImportBatch",
      entityId: batchId,
      before: { status: "COMPLETED" },
      after: { status: "ROLLED_BACK" },
      extra: { fileName: batch.fileName, contractsDeleted: contracts.length, lateFeeRowsDeleted: fees.count },
    });
    return { batch: updated, contractsDeleted: contracts.length, lateFeeRowsDeleted: fees.count };
  }, TX_OPTIONS);
}

export async function listBatches(prisma: Db) {
  const batches = await prisma.importBatch.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 200,
    include: { importedBy: { select: { id: true, username: true } }, _count: { select: { contracts: true } } },
  });
  return Promise.all(
    batches.map(async (b) => {
      const paymentCount = await prisma.payment.count({ where: { contract: { importBatchId: b.id } } });
      return {
        id: b.id,
        fileName: b.fileName,
        rowCount: b.rowCount,
        status: b.status,
        createdAt: b.createdAt,
        rolledBackAt: b.rolledBackAt,
        importedBy: b.importedBy,
        contractCount: b._count.contracts,
        paymentCount,
        // can be undone only while it is live and nothing has been paid on its contracts
        canRollback: b.status === "COMPLETED" && paymentCount === 0,
      };
    }),
  );
}
