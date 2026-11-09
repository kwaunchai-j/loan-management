import { z } from "zod";

/**
 * What the API sends, checked at runtime. Each schema mirrors a response of the API (the file named
 * in the comment). The web app trusts only what passes these schemas, so if the API changes shape the
 * page shows a clear error instead of rendering wrong data or wrong money.
 * Money and rates arrive as strings (exact decimals) and are never turned into numbers here.
 */

export const roleSchema = z.enum(["ADMIN", "BORROWER"]);
export type Role = z.infer<typeof roleSchema>;

/** api/src/auth/routes.ts — POST /auth/login, POST /auth/change-password */
export const loginResponseSchema = z.object({
  user: z.object({ id: z.string(), username: z.string(), role: roleSchema, mustChangePassword: z.boolean() }),
});

/** api/src/auth/routes.ts — GET /auth/me (pdpaAccepted is null for an ADMIN) */
export const sessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: roleSchema,
  mustChangePassword: z.boolean(),
  borrowerId: z.string().nullable(),
  pdpaAccepted: z.boolean().nullable(),
  /** BORROWER only: phone, bank and account number are all filled in; null for an admin (CR-6) */
  profileComplete: z.boolean().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
export const meResponseSchema = z.object({ user: sessionUserSchema });

/** api/src/auth/pdpa.ts — GET /pdpa, POST /pdpa/accept */
export const pdpaStatusSchema = z.object({
  currentVersion: z.string(),
  accepted: z.boolean(),
  acceptedAt: z.string().nullable(),
  acceptedVersion: z.string().nullable(),
});
export type PdpaStatus = z.infer<typeof pdpaStatusSchema>;

/** api/src/admin/settings.ts — GET/PATCH /admin/settings (null = not set yet) */
export const settingsSchema = z.object({
  interestRatePctPerMonth: z.string().nullable(),
  lateFeeRatePctPerDay: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** api/src/borrower/portal.ts — GET/PATCH /me/profile and POST /me/id-card: the borrower's own details; `profileComplete` = real name, national ID, ID-card photo, phone, bank and account number are all in */
export const profileSchema = z.object({
  username: z.string().nullable(),
  fullName: z.string(),
  phone: z.string().nullable(),
  bankName: z.string().nullable(),
  bankAccountNo: z.string().nullable(),
  nationalId: z.string().nullable(),
  hasIdCard: z.boolean(),
  realNameConfirmed: z.boolean(),
  profileComplete: z.boolean(),
  pdpaAcceptedAt: z.string().nullable(),
  pdpaVersion: z.string().nullable(),
});
export type Profile = z.infer<typeof profileSchema>;

/** api/src/borrower/portal.ts — GET /me/payment-account: the lender's account to transfer to (all null until the admin sets it) */
export const paymentAccountSchema = z.object({
  configured: z.boolean(),
  bankName: z.string().nullable(),
  accountName: z.string().nullable(),
  accountNo: z.string().nullable(),
});
export type PaymentAccount = z.infer<typeof paymentAccountSchema>;

/** api/src/admin/payment-account.ts — GET/PUT /admin/payment-account */
export const adminPaymentAccountSchema = z.object({
  bankName: z.string().nullable(),
  accountName: z.string().nullable(),
  accountNo: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
});
export type AdminPaymentAccount = z.infer<typeof adminPaymentAccountSchema>;

/** api/src/admin/borrowers.ts — one borrower; `account` is null for a borrower created by import */
export const borrowerSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  bankName: z.string().nullable(),
  bankAccountNo: z.string().nullable(),
  /** the full number on one borrower, masked ("*********0732") in the list */
  nationalId: z.string().nullable(),
  hasIdCard: z.boolean(),
  realNameConfirmed: z.boolean(),
  pdpaAcceptedAt: z.string().nullable(),
  pdpaVersion: z.string().nullable(),
  createdAt: z.string(),
  account: z
    .object({ userId: z.string(), username: z.string(), isActive: z.boolean(), mustChangePassword: z.boolean() })
    .nullable(),
});
export type Borrower = z.infer<typeof borrowerSchema>;

/** api/src/admin/borrowers.ts — GET /admin/borrowers */
export const borrowerListSchema = z.object({ total: z.number().int(), items: z.array(borrowerSchema) });
export type BorrowerList = z.infer<typeof borrowerListSchema>;

// ---------------------------------------------------------------------------------------------
// Loan requests, contracts and payments (Phase 8). Money, rates and dates stay strings
// ("1234.50", "2026-11-30"); they are never turned into numbers.

export const requestStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export const contractStatusSchema = z.enum(["AWAITING_DISBURSEMENT", "ACTIVE", "CLOSED", "CANCELLED"]);
export type ContractStatus = z.infer<typeof contractStatusSchema>;

const contractRefSchema = z.object({ id: z.string(), contractNo: z.string(), status: contractStatusSchema });

/** api/src/loans/service.ts requestView — admin side (POST/GET /admin/loan-requests, approve, reject, cancel) */
export const requestSchema = z.object({
  id: z.string(),
  borrower: z.object({ id: z.string(), fullName: z.string() }),
  amount: z.string(),
  requestedDueDate: z.string(),
  status: requestStatusSchema,
  createdById: z.string(),
  decidedById: z.string().nullable(),
  decidedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
  contract: contractRefSchema.nullable(),
});
export type LoanRequest = z.infer<typeof requestSchema>;

/** api/src/loans/interest-estimate.ts — GET /loan-requests/interest-estimate (a borrower's "how much interest?") */
export const interestEstimateSchema = z.object({
  amount: z.string(),
  payoutDate: z.string(),
  dueDate: z.string().nullable(),
  days: z.number().int(),
  daysAssumed: z.boolean(),
  interestRatePctPerMonth: z.string(),
  interestAmount: z.string(),
  totalToRepay: z.string(),
  isEstimate: z.literal(true),
});
export type InterestEstimate = z.infer<typeof interestEstimateSchema>;
export const requestListSchema = z.object({ total: z.number().int(), items: z.array(requestSchema) });

/** api/src/loans/routes.ts — POST /loan-requests and /loan-requests/:id/cancel answer with the same view */

/**
 * api/src/loans/agreement.ts — GET /admin/loan-requests/:id/agreement and GET /me/loan-requests/:id/agreement:
 * the loan agreement (สัญญาเงินกู้) generated with every request. `terms` is what the document says, frozen when it was issued.
 */
export const agreementSchema = z.object({
  agreementNo: z.string(),
  issuedAt: z.string(),
  requestId: z.string(),
  requestStatus: requestStatusSchema,
  terms: z.object({
    issuedOn: z.string(),
    borrowerName: z.string(),
    principal: z.string(),
    dueDate: z.string(),
    interestRatePctPerMonth: z.string().nullable(),
    lateFeeRatePctPerDay: z.string().nullable(),
    estimate: z.object({ days: z.number().int(), interestAmount: z.string(), totalToRepay: z.string() }).nullable(),
    payment: z.object({ bankName: z.string(), accountName: z.string(), accountNo: z.string() }).nullable(),
  }),
});
export type Agreement = z.infer<typeof agreementSchema>;

/** api/src/borrower/portal.ts — GET /me/loan-requests (no borrower name, no reject reason) */
export const myRequestSchema = z.object({
  id: z.string(),
  amount: z.string(),
  requestedDueDate: z.string(),
  status: requestStatusSchema,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  contract: contractRefSchema.nullable(),
});
export type MyRequest = z.infer<typeof myRequestSchema>;
export const myRequestListSchema = z.object({ items: z.array(myRequestSchema) });

/**
 * api/src/borrower/portal.ts contractView — before the payout (or when cancelled) ONLY the first four
 * fields exist: the page must show no amount owed. The rest are present once the money was paid out.
 */
export const portalContractSchema = z.object({
  id: z.string(),
  contractNo: z.string(),
  status: contractStatusSchema,
  principal: z.string(),
  dueDate: z.string(),
  disbursedOn: z.string().nullable().optional(),
  interestAmount: z.string().nullable().optional(),
  outstandingPrincipal: z.string().optional(),
  outstandingInterest: z.string().optional(),
  accruedLateFee: z.string().optional(),
  totalDue: z.string().optional(),
  isOverdue: z.boolean().optional(),
  daysOverdue: z.number().int().optional(),
  isLate: z.boolean().optional(),
  closedOn: z.string().nullable().optional(),
});
export type PortalContract = z.infer<typeof portalContractSchema>;
export const portalContractListSchema = z.object({ items: z.array(portalContractSchema) });
export const portalContractDetailSchema = z.object({
  contract: portalContractSchema,
  disbursement: z.object({ amount: z.string(), paidOn: z.string() }).nullable(),
  payments: z.array(
    z.object({
      id: z.string(),
      amount: z.string(),
      paidOn: z.string(),
      allocatedLateFee: z.string(),
      allocatedInterest: z.string(),
      allocatedPrincipal: z.string(),
    }),
  ),
});
export type PortalContractDetail = z.infer<typeof portalContractDetailSchema>;

/** api/src/loans/views.ts contractMoneyView */
export const contractMoneySchema = z.object({
  id: z.string(),
  contractNo: z.string(),
  status: contractStatusSchema,
  principal: z.string(),
  dueDate: z.string(),
  disbursedOn: z.string().nullable(),
  interestRatePctPerMonth: z.string().nullable(),
  lateFeeRatePctPerDay: z.string().nullable(),
  interestAmount: z.string().nullable(),
  outstandingPrincipal: z.string(),
  outstandingInterest: z.string(),
  accruedLateFee: z.string(),
  totalDue: z.string().nullable(),
  closedOn: z.string().nullable(),
});
export type ContractMoney = z.infer<typeof contractMoneySchema>;

/** api/src/loans/queries.ts — one contract in GET /admin/contracts/:id */
export const adminContractSchema = contractMoneySchema.extend({
  borrower: z.object({ id: z.string(), fullName: z.string() }),
  isImported: z.boolean(),
  isOverdue: z.boolean(),
  daysOverdue: z.number().int(),
  isLate: z.boolean(),
  inconsistent: z.boolean(),
});

/** api/src/loans/views.ts paymentView / disbursementRowView */
export const paymentSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  amount: z.string(),
  paidOn: z.string(),
  allocatedLateFee: z.string(),
  allocatedInterest: z.string(),
  allocatedPrincipal: z.string(),
  note: z.string().nullable(),
  recordedById: z.string(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;
export const disbursementRowSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  amount: z.string(),
  paidOn: z.string(),
  note: z.string().nullable(),
  slipFileKey: z.string(),
  recordedById: z.string(),
  createdAt: z.string(),
});
export type DisbursementRow = z.infer<typeof disbursementRowSchema>;
export const lateFeeAccrualSchema = z.object({
  date: z.string(),
  baseAmount: z.string(),
  ratePctPerDay: z.string(),
  amount: z.string(),
});
export const adminContractDetailSchema = z.object({
  contract: adminContractSchema,
  disbursement: disbursementRowSchema.nullable(),
  payments: z.array(paymentSchema),
  lateFeeAccruals: z.array(lateFeeAccrualSchema),
});
export type AdminContractDetail = z.infer<typeof adminContractDetailSchema>;

/** api/src/loans/queries.ts listContracts — GET /admin/contracts */
export const adminContractListSchema = z.object({
  total: z.number().int(),
  items: z.array(
    z.object({
      id: z.string(),
      contractNo: z.string(),
      status: contractStatusSchema,
      borrower: z.object({ id: z.string(), fullName: z.string() }),
      principal: z.string(),
      dueDate: z.string(),
      disbursedOn: z.string().nullable(),
      totalDue: z.string().nullable(),
      isOverdue: z.boolean(),
      daysOverdue: z.number().int(),
      isLate: z.boolean(),
      isImported: z.boolean(),
    }),
  ),
});
export type AdminContractList = z.infer<typeof adminContractListSchema>;

/** api/src/loans/ledger-routes.ts — answers of payments and payouts */
export const paymentResultSchema = z.object({ payment: paymentSchema, contract: contractMoneySchema });
export const contractOnlySchema = z.object({ contract: contractMoneySchema });
export const disbursementCreatedSchema = z.object({
  contract: contractMoneySchema,
  disbursement: z.object({
    id: z.string(),
    amount: z.string(),
    paidOn: z.string(),
    note: z.string().nullable(),
    slipFileKey: z.string(),
  }),
});
export const disbursementResultSchema = z.object({ disbursement: disbursementRowSchema, contract: contractMoneySchema });
/** api/src/loans/routes.ts — POST /admin/contracts/:id/cancel */
export const cancelledContractSchema = z.object({
  id: z.string(),
  contractNo: z.string(),
  status: contractStatusSchema,
  principal: z.string(),
  dueDate: z.string(),
  borrowerId: z.string(),
});
/** api/src/loans/slips.ts — POST /admin/slips */
export const slipUploadSchema = z.object({ slipFileKey: z.string(), contentType: z.string(), size: z.number() });

// ---------------------------------------------------------------------------------------------
// Reports, import and notification setup (Phase 9). Same rules as above: money as text, and the page
// shows exactly what the API sends — it never adds up or recomputes a report figure.

export const periodSchema = z.object({
  kind: z.enum(["month", "year", "range", "all"]),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type ReportPeriod = z.infer<typeof periodSchema>;

/** api/src/reports/profit-loss.ts — GET /admin/reports/profit-loss */
export const profitLossSchema = z.object({
  period: periodSchema,
  cash: z.object({ interest: z.string(), lateFee: z.string(), total: z.string(), paymentCount: z.number().int() }),
  accrual: z.object({
    interest: z.string(),
    lateFee: z.string(),
    total: z.string(),
    contractCount: z.number().int(),
    interestRecognisedThrough: z.string(),
  }),
});
export type ProfitLoss = z.infer<typeof profitLossSchema>;

/** api/src/reports/contract-reports.ts — GET /admin/reports/late-payers */
export const latePayersSchema = z.object({
  period: periodSchema,
  total: z.number().int(),
  items: z.array(
    z.object({
      rank: z.number().int(),
      borrowerId: z.string(),
      fullName: z.string(),
      lateCount: z.number().int(),
      lateContracts: z.array(
        z.object({
          contractNo: z.string(),
          dueDate: z.string(),
          closedOn: z.string().nullable(),
          stillUnpaid: z.boolean(),
          daysLate: z.number().int(),
        }),
      ),
    }),
  ),
});

/** api/src/reports/contract-reports.ts — GET /admin/reports/outstanding */
export const outstandingSchema = z.object({
  asOf: z.string(),
  isToday: z.boolean(),
  openContracts: z.number().int(),
  totalOutstanding: z.string(),
  principal: z.string(),
  interest: z.string(),
  lateFee: z.string(),
  inconsistentContracts: z.number().int(),
});

/** api/src/reports/contract-reports.ts — GET /admin/reports/borrower-summary */
export const borrowerSummarySchema = z.object({
  period: periodSchema,
  total: z.number().int(),
  items: z.array(
    z.object({
      borrowerId: z.string(),
      fullName: z.string(),
      loanCount: z.number().int(),
      lateCount: z.number().int(),
      paidOnTimeCount: z.number().int(),
      notYetDueCount: z.number().int(),
      onTimeRatePct: z.string().nullable(),
      outstanding: z.string(),
    }),
  ),
});

/** api/src/imports/analyze.ts + routes.ts — POST /admin/imports/preview */
export const importCandidateSchema = z.object({
  borrowerId: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  hasAccount: z.boolean(),
  createdAt: z.string(),
});
export type ImportCandidate = z.infer<typeof importCandidateSchema>;
export const importRowSchema = z.object({
  rowNumber: z.number().int(),
  name: z.string(),
  amount: z.string().nullable(),
  interest: z.string().nullable(),
  dueDate: z.string().nullable(),
  valid: z.boolean(),
  errors: z.array(z.string()),
  match: z.object({ status: z.enum(["EXISTING", "NEW", "AMBIGUOUS"]), borrowerId: z.string().optional() }),
  daysOverdue: z.number().int(),
  lateFee: z.string().nullable(),
});
export const importPreviewSchema = z.object({
  importKey: z.string(),
  fileName: z.string(),
  ratesReady: z.boolean(),
  summary: z.object({
    rows: z.number().int(),
    validRows: z.number().int(),
    invalidRows: z.number().int(),
    borrowers: z.number().int(),
    newBorrowers: z.number().int(),
    existingBorrowers: z.number().int(),
    ambiguousBorrowers: z.number().int(),
    principal: z.string(),
    interest: z.string(),
    lateFee: z.string().nullable(),
    lateDays: z.number().int(),
  }),
  canCommit: z.boolean(),
  needsChoice: z.array(z.object({ name: z.string(), rowNumbers: z.array(z.number().int()), candidates: z.array(importCandidateSchema) })),
  hasInvalidRows: z.boolean(),
  rows: z.array(importRowSchema),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

/** api/src/imports/commit.ts — POST /admin/imports/commit */
export const importResultSchema = z.object({
  batchId: z.string(),
  contractsCreated: z.number().int(),
  borrowersCreated: z.number().int(),
  borrowersLinked: z.number().int(),
  skippedRows: z.number().int(),
  totalPrincipal: z.string(),
  totalInterest: z.string(),
  lateFeeBackfilled: z.string(),
  lateFeeRows: z.number().int(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/** api/src/imports/commit.ts listBatches — GET /admin/imports */
export const importBatchSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  rowCount: z.number().int(),
  status: z.enum(["COMPLETED", "ROLLED_BACK"]),
  createdAt: z.string(),
  rolledBackAt: z.string().nullable(),
  importedBy: z.object({ id: z.string(), username: z.string() }),
  contractCount: z.number().int(),
  paymentCount: z.number().int(),
  canRollback: z.boolean(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;
export const importBatchListSchema = z.object({ items: z.array(importBatchSchema) });
export const rollbackResultSchema = z.object({
  id: z.string(),
  status: z.enum(["COMPLETED", "ROLLED_BACK"]),
  rolledBackAt: z.string().nullable(),
  contractsDeleted: z.number().int(),
  lateFeeRowsDeleted: z.number().int(),
});

/** api/src/notifications/routes.ts */
export const lineBindingSchema = z.object({ bound: z.boolean(), lineUserId: z.string().nullable() });
export const pushPublicKeySchema = z.object({ publicKey: z.string() });
export const pushSubscribedSchema = z.object({ subscribed: z.boolean() });
/** POST /admin/notifications/test — channel -> "sent" | "no_recipient" | "failed: ..." */
export const notificationTestSchema = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------------------------
// Payment slips sent by borrowers (CR-1) and the admin calendar.

export const submissionStatusSchema = z.enum(["PENDING", "CONFIRMED", "REJECTED"]);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

/** api/src/loans/submissions.ts borrowerSubmissionView — what a borrower sees of their own claim (no slip) */
export const mySubmissionSchema = z.object({
  id: z.string(),
  contract: z.object({ id: z.string(), contractNo: z.string() }),
  amount: z.string(),
  paidOn: z.string(),
  note: z.string().nullable(),
  status: submissionStatusSchema,
  rejectReason: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MySubmission = z.infer<typeof mySubmissionSchema>;
export const mySubmissionListSchema = z.object({ items: z.array(mySubmissionSchema) });

/** api/src/loans/submissions.ts adminSubmissionView — the admin also gets the slip key and the borrower */
export const adminSubmissionSchema = z.object({
  id: z.string(),
  contract: z.object({ id: z.string(), contractNo: z.string() }),
  borrower: z.object({ id: z.string(), fullName: z.string() }),
  amount: z.string(),
  paidOn: z.string(),
  note: z.string().nullable(),
  status: submissionStatusSchema,
  rejectReason: z.string().nullable(),
  slipFileKey: z.string(),
  decidedAt: z.string().nullable(),
  paymentId: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminSubmission = z.infer<typeof adminSubmissionSchema>;
export const adminSubmissionListSchema = z.object({ total: z.number().int(), items: z.array(adminSubmissionSchema) });
/** POST /admin/payment-submissions/:id/confirm */
export const submissionConfirmedSchema = z.object({ submission: adminSubmissionSchema, payment: paymentSchema, contract: contractMoneySchema });

/** api/src/loans/calendar.ts — GET /admin/calendar?month=YYYY-MM */
export const calendarDueItemSchema = z.object({
  contractId: z.string(),
  contractNo: z.string(),
  borrower: z.object({ id: z.string(), fullName: z.string() }),
  status: z.enum(["ACTIVE", "CLOSED"]),
  totalDue: z.string(),
  isOverdue: z.boolean(),
  daysOverdue: z.number().int(),
  isImported: z.boolean(),
  closedOn: z.string().nullable(),
});
export const calendarPaidItemSchema = z.object({
  paymentId: z.string(),
  contractId: z.string(),
  contractNo: z.string(),
  borrower: z.object({ id: z.string(), fullName: z.string() }),
  amount: z.string(),
});
export const calendarDaySchema = z.object({
  date: z.string(),
  due: z.object({ count: z.number().int(), openCount: z.number().int(), openTotal: z.string(), items: z.array(calendarDueItemSchema) }),
  paid: z.object({ count: z.number().int(), total: z.string(), items: z.array(calendarPaidItemSchema) }),
});
export type CalendarDay = z.infer<typeof calendarDaySchema>;
export const calendarSchema = z.object({
  month: z.string(),
  today: z.string(),
  truncated: z.boolean(),
  days: z.array(calendarDaySchema),
});
export type Calendar = z.infer<typeof calendarSchema>;

/** api/src/loans/calendar-feed.ts — GET /admin/calendar/feed-link: the private subscription path, relative to the API. */
export const calendarFeedLinkSchema = z.object({ path: z.string().startsWith("/calendar/feed/") });
