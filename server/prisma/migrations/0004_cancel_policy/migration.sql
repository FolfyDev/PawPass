-- Per-event cancellation policy for paid tickets, and pending cancellation
-- requests on registrations. Additive only. Existing events default to
-- REQUEST, so nothing gets refunded automatically until an owner opts in.

-- CreateEnum
CREATE TYPE "CancelPolicy" AS ENUM ('AUTO_REFUND', 'REQUEST');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "cancelPolicy" "CancelPolicy" NOT NULL DEFAULT 'REQUEST';

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "cancelRequestNote" TEXT,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3);

