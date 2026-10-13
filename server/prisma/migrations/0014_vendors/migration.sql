-- Dealers' den / artist alley: table types, applications, and payments
-- linked to an application. Additive only; closed until turned on per event.

-- CreateEnum
CREATE TYPE "VendorArea" AS ENUM ('DEALERS_DEN', 'ARTIST_ALLEY');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('SUBMITTED', 'WAITLISTED', 'ACCEPTED', 'CONFIRMED', 'DECLINED', 'WITHDRAWN', 'CANCELLED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "vendorInfo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vendorsCloseAt" TIMESTAMP(3),
ADD COLUMN     "vendorsOpen" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "vendorApplicationId" TEXT;

-- CreateTable
CREATE TABLE "VendorTableType" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "area" "VendorArea" NOT NULL DEFAULT 'DEALERS_DEN',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "quantity" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorTableType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorApplication" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "area" "VendorArea" NOT NULL,
    "tableTypeId" TEXT,
    "businessName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "portfolioUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assistants" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "VendorStatus" NOT NULL DEFAULT 'SUBMITTED',
    "feeCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "tableNumber" TEXT,
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorTableType_eventId_idx" ON "VendorTableType"("eventId");

-- CreateIndex
CREATE INDEX "VendorApplication_eventId_status_idx" ON "VendorApplication"("eventId", "status");

-- CreateIndex
CREATE INDEX "VendorApplication_userId_idx" ON "VendorApplication"("userId");

-- CreateIndex
CREATE INDEX "Payment_vendorApplicationId_idx" ON "Payment"("vendorApplicationId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vendorApplicationId_fkey" FOREIGN KEY ("vendorApplicationId") REFERENCES "VendorApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorTableType" ADD CONSTRAINT "VendorTableType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorApplication" ADD CONSTRAINT "VendorApplication_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorApplication" ADD CONSTRAINT "VendorApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorApplication" ADD CONSTRAINT "VendorApplication_tableTypeId_fkey" FOREIGN KEY ("tableTypeId") REFERENCES "VendorTableType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorApplication" ADD CONSTRAINT "VendorApplication_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A payment still pays for exactly one thing, now one of three.
-- (Prisma has no syntax for CHECK constraints, so it only lives here; see 0003.)
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_one_target";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_one_target" CHECK (num_nonnulls("registrationId", "merchOrderId", "vendorApplicationId") = 1);
