-- CreateEnum
CREATE TYPE "PaymentSubmissionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_SUBMITTED';

-- CreateTable
CREATE TABLE "PaymentSubmission" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "slipFileKey" TEXT NOT NULL,
    "note" TEXT,
    "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSubmission_slipFileKey_key" ON "PaymentSubmission"("slipFileKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSubmission_paymentId_key" ON "PaymentSubmission"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentSubmission_status_createdAt_idx" ON "PaymentSubmission"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentSubmission_contractId_idx" ON "PaymentSubmission"("contractId");

-- CreateIndex
CREATE INDEX "PaymentSubmission_borrowerId_idx" ON "PaymentSubmission"("borrowerId");

-- AddForeignKey
ALTER TABLE "PaymentSubmission" ADD CONSTRAINT "PaymentSubmission_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSubmission" ADD CONSTRAINT "PaymentSubmission_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "Borrower"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSubmission" ADD CONSTRAINT "PaymentSubmission_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSubmission" ADD CONSTRAINT "PaymentSubmission_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
