-- Reminder timestamps (event tomorrow, hold expiring, pre-order ready) and
-- "buy for friends": a ticket can point at the buyer's registration whose
-- payment covers it. Additive only.

-- AlterTable
ALTER TABLE "MerchOrder" ADD COLUMN     "readyNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "holdReminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "eventReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "paidByRegistrationId" TEXT;

-- CreateIndex
CREATE INDEX "Registration_paidByRegistrationId_idx" ON "Registration"("paidByRegistrationId");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_paidByRegistrationId_fkey" FOREIGN KEY ("paidByRegistrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

