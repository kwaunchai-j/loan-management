-- CreateTable
CREATE TABLE "LoanAgreement" (
    "id" TEXT NOT NULL,
    "agreementNo" TEXT NOT NULL,
    "loanRequestId" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanAgreement_agreementNo_key" ON "LoanAgreement"("agreementNo");

-- CreateIndex
CREATE UNIQUE INDEX "LoanAgreement_loanRequestId_key" ON "LoanAgreement"("loanRequestId");

-- AddForeignKey
ALTER TABLE "LoanAgreement" ADD CONSTRAINT "LoanAgreement_loanRequestId_fkey" FOREIGN KEY ("loanRequestId") REFERENCES "LoanRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
