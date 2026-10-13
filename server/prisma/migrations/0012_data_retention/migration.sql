-- Marks events whose personal data has been cleared by the retention job.
-- Additive only; retention is off until an owner turns it on.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "dataPurgedAt" TIMESTAMP(3);

