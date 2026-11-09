-- AlterTable
ALTER TABLE "Borrower" ADD COLUMN     "rateNoticeAckAt" TIMESTAMP(3),
ADD COLUMN     "rateNoticeAckSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RateChange" (
    "seq" SERIAL NOT NULL,
    "prevInterestRatePctPerMonth" DECIMAL(7,4),
    "prevLateFeeRatePctPerDay" DECIMAL(7,4),
    "interestRatePctPerMonth" DECIMAL(7,4),
    "lateFeeRatePctPerDay" DECIMAL(7,4),
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateChange_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "RateChange_createdAt_idx" ON "RateChange"("createdAt");

-- AddForeignKey
ALTER TABLE "RateChange" ADD CONSTRAINT "RateChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
