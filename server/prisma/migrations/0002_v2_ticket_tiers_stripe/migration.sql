-- PawPass v2: configurable ticket tiers (synced to Stripe) and a Payment
-- ledger, replacing v1's fixed Free/Donation tier and the payment columns on
-- Registration.
--
-- Ordered create -> copy data -> drop, so nothing from v1 is lost:
--   * every event gets an "Attendee" tier (price 0) standing in for v1's free
--     option, unless it required payment and nobody registered free;
--   * every event that had a PayPal donation tier (or donation registrations)
--     gets that tier carried over under its v1 name, INACTIVE and at price 0 —
--     v1 never knew what people actually paid via PayPal, so an owner has to
--     set a real price before it goes back on sale;
--   * registrations point at whichever of those matches their v1 tier
--     (voucher redemptions point at none, as in v2), and keep the tier name
--     on the badge;
--   * every staff-recorded payment becomes a PAID Payment row, in cents.
--
-- New enum values (PENDING_PAYMENT, STRIPE) are only added here, never used,
-- since Postgres can't use an enum value in the same transaction it's added in.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- AlterEnum
ALTER TYPE "RegistrationStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'STRIPE';

-- CreateTable
CREATE TABLE "TicketTier" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "capacity" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "stripeSyncedAt" TIMESTAMP(3),
    "stripeSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "amountRefundedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "note" TEXT,
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "processedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN "ticketTierId" TEXT,
ADD COLUMN "tierName" TEXT;

-- ---------------------------------------------------------------- data ----

-- Scratch marker so the UPDATEs below can find "this event's free tier" /
-- "this event's donation tier" without depending on generated IDs. Dropped
-- again at the end of the data section.
ALTER TABLE "TicketTier" ADD COLUMN "legacyKey" TEXT;

INSERT INTO "TicketTier" ("id", "eventId", "name", "description", "priceCents", "sortOrder", "active", "updatedAt", "legacyKey")
SELECT 'tt' || replace(gen_random_uuid()::text, '-', ''), e."id", 'Attendee', 'Standard registration', 0, 0, true, CURRENT_TIMESTAMP, 'free'
FROM "Event" e
WHERE e."donationRequired" = false
   OR EXISTS (
     SELECT 1 FROM "Registration" r
     WHERE r."eventId" = e."id" AND r."tier" = 'FREE' AND r."voucherCodeId" IS NULL
   );

INSERT INTO "TicketTier" ("id", "eventId", "name", "description", "priceCents", "sortOrder", "active", "updatedAt", "legacyKey")
SELECT 'tt' || replace(gen_random_uuid()::text, '-', ''), e."id", e."donationTierName",
       'Carried over from the v1 PayPal donation tier. Set a price and mark it active to sell it through Stripe.',
       0, 1, false, CURRENT_TIMESTAMP, 'donation'
FROM "Event" e
WHERE e."donationPaypalLink" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "Registration" r WHERE r."eventId" = e."id" AND r."tier" = 'DONATION');

UPDATE "Registration" r
SET "ticketTierId" = t."id", "tierName" = t."name"
FROM "TicketTier" t
WHERE t."eventId" = r."eventId"
  AND r."voucherCodeId" IS NULL
  AND t."legacyKey" = CASE r."tier" WHEN 'DONATION' THEN 'donation' ELSE 'free' END;

INSERT INTO "Payment" ("id", "registrationId", "method", "status", "amountCents", "note", "paidAt", "createdAt", "updatedAt")
SELECT 'pm' || replace(gen_random_uuid()::text, '-', ''), r."id", r."paymentMethod", 'PAID',
       ROUND(COALESCE(r."paymentAmount", 0) * 100)::INTEGER, r."paymentNote", r."createdAt", r."createdAt", CURRENT_TIMESTAMP
FROM "Registration" r
WHERE r."paymentMethod" IS NOT NULL;

ALTER TABLE "TicketTier" DROP COLUMN "legacyKey";

-- ------------------------------------------------------- drop v1 shape ----

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "donationPaypalLink",
DROP COLUMN "donationRequired",
DROP COLUMN "donationTierName";

-- AlterTable
ALTER TABLE "Registration" DROP COLUMN "paymentAmount",
DROP COLUMN "paymentMethod",
DROP COLUMN "paymentNote",
DROP COLUMN "tier";

-- DropEnum
DROP TYPE "RegistrationTier";

-- CreateIndex
CREATE UNIQUE INDEX "TicketTier_stripeProductId_key" ON "TicketTier"("stripeProductId");

-- CreateIndex
CREATE INDEX "TicketTier_eventId_idx" ON "TicketTier"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripeSessionId_key" ON "Payment"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_registrationId_idx" ON "Payment"("registrationId");

-- CreateIndex
CREATE INDEX "Payment_status_expiresAt_idx" ON "Payment"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Registration_ticketTierId_idx" ON "Registration"("ticketTierId");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_ticketTierId_fkey" FOREIGN KEY ("ticketTierId") REFERENCES "TicketTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTier" ADD CONSTRAINT "TicketTier_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
