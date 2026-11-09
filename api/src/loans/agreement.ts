import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { DomainError } from "../http.js";
import { writeAuditLog } from "../lib/audit.js";
import { bangkokToday, formatDateOnly } from "../lib/dates.js";
import { calendarDaysBetween, computeInterestForDays } from "../lib/interest.js";
import { MAX_AMOUNT } from "../lib/late-fee.js";
import { getRates, SETTING_ID } from "../lib/rates.js";

/**
 * The loan agreement (สัญญาเงินกู้) that is generated with EVERY loan request, whoever files it and
 * whatever becomes of the request afterwards (approved, rejected, cancelled).
 *
 * The document's figures are copied into `LoanAgreement.terms` when it is issued, so a later change to a
 * rate, to the lender's account or to a borrower's name never rewrites a document that was already given out.
 * The interest shown is an ESTIMATE for a payout on the day of issue; the real interest counts the days from the
 * day the lender really transfers the money (DES-010) and is written on the Contract then.
 *
 * Requests filed before this feature existed get their agreement the first time somebody opens it
 * (`getAgreement`), dated the day the request was filed.
 */

export interface AgreementTerms {
  /** The day the agreement was issued, "YYYY-MM-DD" (Asia/Bangkok). */
  issuedOn: string;
  borrowerName: string;
  principal: string;
  dueDate: string;
  /** % per month; null when the lender had not set a rate yet. */
  interestRatePctPerMonth: string | null;
  /** % per day; null when the lender had not set a rate yet. */
  lateFeeRatePctPerDay: string | null;
  /** Interest if the money were paid out on `issuedOn`; null without a rate (or for an impossible due date). */
  estimate: { days: number; interestAmount: string; totalToRepay: string } | null;
  /** The lender's account the borrower repays to; null until an admin sets it. */
  payment: { bankName: string; accountName: string; accountNo: string } | null;
}

export interface AgreementInput {
  borrowerName: string;
  amount: Prisma.Decimal;
  dueDate: Date;
  issuedOn: Date;
  interestRatePctPerMonth: Prisma.Decimal | null;
  lateFeeRatePctPerDay: Prisma.Decimal | null;
  payment: { bankName: string | null; accountName: string | null; accountNo: string | null } | null;
}

/** Pure: what the document says, from the figures that were true when it was issued. */
export function buildAgreementTerms(input: AgreementInput): AgreementTerms {
  let estimate: AgreementTerms["estimate"] = null;
  if (input.interestRatePctPerMonth !== null) {
    const days = calendarDaysBetween(input.issuedOn, input.dueDate);
    if (days >= 1) {
      const interest = computeInterestForDays(input.amount, input.interestRatePctPerMonth, days);
      const total = input.amount.plus(interest);
      if (!interest.gt(MAX_AMOUNT) && !total.gt(MAX_AMOUNT)) {
        estimate = { days, interestAmount: interest.toString(), totalToRepay: total.toString() };
      }
    }
  }
  const p = input.payment;
  return {
    issuedOn: formatDateOnly(input.issuedOn),
    borrowerName: input.borrowerName,
    principal: input.amount.toString(),
    dueDate: formatDateOnly(input.dueDate),
    interestRatePctPerMonth: input.interestRatePctPerMonth?.toString() ?? null,
    lateFeeRatePctPerDay: input.lateFeeRatePctPerDay?.toString() ?? null,
    estimate,
    payment: p?.bankName && p.accountName && p.accountNo ? { bankName: p.bankName, accountName: p.accountName, accountNo: p.accountNo } : null,
  };
}

/** The next agreement number for `year`: AG-<year>-<6 digits>, continuing after the highest used. */
export async function nextAgreementNo(tx: Prisma.TransactionClient, year: string): Promise<string> {
  const prefix = `AG-${year}-`;
  const last = await tx.loanAgreement.findFirst({
    where: { agreementNo: { startsWith: prefix } },
    orderBy: { agreementNo: "desc" },
    select: { agreementNo: true },
  });
  const next = last ? Number(last.agreementNo.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

/** Issues the agreement of a request inside the caller's transaction. */
export async function issueAgreement(
  tx: Prisma.TransactionClient,
  request: { id: string; amount: Prisma.Decimal; requestedDueDate: Date; borrower: { fullName: string } },
  issuedOn: Date,
) {
  const [rates, setting] = await Promise.all([
    getRates(tx),
    tx.setting.findUnique({
      where: { id: SETTING_ID },
      select: { paymentBankName: true, paymentAccountName: true, paymentAccountNo: true },
    }),
  ]);
  const terms = buildAgreementTerms({
    borrowerName: request.borrower.fullName,
    amount: request.amount,
    dueDate: request.requestedDueDate,
    issuedOn,
    interestRatePctPerMonth: rates.interestRatePctPerMonth,
    lateFeeRatePctPerDay: rates.lateFeeRatePctPerDay,
    payment: setting
      ? { bankName: setting.paymentBankName, accountName: setting.paymentAccountName, accountNo: setting.paymentAccountNo }
      : null,
  });
  return tx.loanAgreement.create({
    data: {
      agreementNo: await nextAgreementNo(tx, formatDateOnly(issuedOn).slice(0, 4)),
      loanRequestId: request.id,
      terms: terms as unknown as Prisma.InputJsonObject,
    },
  });
}

const targetOf = (err: unknown): string | null =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" ? String(err.meta?.target ?? "") : null;

/** True when `err` is two issuers racing for the same agreement number: the loser simply tries the next number. */
export const isAgreementNoClash = (err: unknown) => targetOf(err)?.includes("agreementNo") === true;

/** Runs `work` again (a few times) when it lost a race for the agreement number. */
export async function withAgreementNoRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isAgreementNoClash(err) || attempt >= 4) throw err;
    }
  }
}

export function agreementView(
  a: { agreementNo: string; createdAt: Date; terms: Prisma.JsonValue },
  request: { id: string; status: string },
) {
  return {
    agreementNo: a.agreementNo,
    issuedAt: a.createdAt,
    requestId: request.id,
    requestStatus: request.status,
    terms: a.terms as unknown as AgreementTerms,
  };
}

/**
 * The agreement of a request. `ownedBy` limits it to one borrower's own request (a borrower's session);
 * another borrower's request is answered as "not found" so its existence is not revealed.
 * A request that predates this feature gets its agreement now.
 */
export async function getAgreement(prisma: Db, requestId: string, options: { ownedBy?: string } = {}) {
  const select = {
    id: true,
    status: true,
    amount: true,
    requestedDueDate: true,
    createdAt: true,
    borrower: { select: { fullName: true } },
    agreement: true,
  } satisfies Prisma.LoanRequestSelect;
  const where = { id: requestId, ...(options.ownedBy ? { borrowerId: options.ownedBy } : {}) };
  const request = await prisma.loanRequest.findFirst({ where, select });
  if (!request) throw new DomainError(404, "NOT_FOUND", "ไม่พบรายการ");
  if (request.agreement) return agreementView(request.agreement, request);

  try {
    const created = await withAgreementNoRetry(() =>
      prisma.$transaction(async (tx) => {
        const row = await issueAgreement(tx, request, bangkokToday(request.createdAt));
        await writeAuditLog(tx, {
          actorId: null,
          action: "loanAgreement.issue",
          entityType: "LoanRequest",
          entityId: request.id,
          extra: { agreementNo: row.agreementNo, backfilled: true },
        });
        return row;
      }),
    );
    return agreementView(created, request);
  } catch (err) {
    // somebody else opened the same old request at the same moment and issued it first: use theirs
    if (targetOf(err)?.includes("loanRequestId")) {
      const existing = await prisma.loanAgreement.findUniqueOrThrow({ where: { loanRequestId: request.id } });
      return agreementView(existing, request);
    }
    throw err;
  }
}
