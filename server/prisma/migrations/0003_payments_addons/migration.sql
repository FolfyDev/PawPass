-- PawPass v2.1: donation add-on at checkout, discount codes, tier sale
-- windows, Stripe fee tracking, and online merch pre-orders.
-- Purely additive: every new column is nullable or has a default, so existing
-- rows need no conversion.

-- CreateEnum
CREATE TYPE "MerchOrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "donationAddonEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "donationAddonLabel" TEXT NOT NULL DEFAULT 'Add a donation',
ADD COLUMN     "donationAddonPresets" INTEGER[] DEFAULT ARRAY[500, 1000, 2500]::INTEGER[];

-- AlterTable
ALTER TABLE "MerchItem" ADD COLUMN     "preorder" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "donationCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "feeCents" INTEGER,
ADD COLUMN     "merchOrderId" TEXT,
ADD COLUMN     "netCents" INTEGER,
ALTER COLUMN "registrationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountCodeId" TEXT,
ADD COLUMN     "donationCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TicketTier" ADD COLUMN     "salesEndAt" TIMESTAMP(3),
ADD COLUMN     "salesStartAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DiscountCode" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "percentOff" INTEGER,
    "amountOffCents" INTEGER,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "tierIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchOrder" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "MerchOrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "pickedUpAt" TIMESTAMP(3),
    "pickedUpById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "MerchOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCode_eventId_code_key" ON "DiscountCode"("eventId", "code");

-- CreateIndex
CREATE INDEX "MerchOrder_eventId_status_idx" ON "MerchOrder"("eventId", "status");

-- CreateIndex
CREATE INDEX "MerchOrder_userId_idx" ON "MerchOrder"("userId");

-- CreateIndex
CREATE INDEX "MerchOrderItem_orderId_idx" ON "MerchOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "Payment_merchOrderId_idx" ON "Payment"("merchOrderId");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_discountCodeId_fkey" FOREIGN KEY ("discountCodeId") REFERENCES "DiscountCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_merchOrderId_fkey" FOREIGN KEY ("merchOrderId") REFERENCES "MerchOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCode" ADD CONSTRAINT "DiscountCode_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrder" ADD CONSTRAINT "MerchOrder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrder" ADD CONSTRAINT "MerchOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrder" ADD CONSTRAINT "MerchOrder_pickedUpById_fkey" FOREIGN KEY ("pickedUpById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrderItem" ADD CONSTRAINT "MerchOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MerchOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrderItem" ADD CONSTRAINT "MerchOrderItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MerchItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A payment pays for exactly one thing: a registration or a merch order.
-- (Prisma has no syntax for CHECK constraints, so it only lives here.)
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_one_target" CHECK (("registrationId" IS NULL) <> ("merchOrderId" IS NULL));
