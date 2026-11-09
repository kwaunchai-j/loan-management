-- AlterTable
ALTER TABLE "Borrower" ADD COLUMN     "idCardFileKey" TEXT,
ADD COLUMN     "nationalId" TEXT,
ADD COLUMN     "realNameConfirmedAt" TIMESTAMP(3);
