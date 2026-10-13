-- Per-scan check-in log (entries and exits, per day), day passes, and an
-- occupancy limit. Existing check-ins become one ENTRY scan each, on the day
-- they happened in the event's timezone, so nothing about who has arrived changes.

-- CreateEnum
CREATE TYPE "ScanDirection" AS ENUM ('ENTRY', 'EXIT');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "occupancyLimit" INTEGER;

-- AlterTable
ALTER TABLE "TicketTier" ADD COLUMN     "validDays" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "direction" "ScanDirection" NOT NULL DEFAULT 'ENTRY',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannedById" TEXT,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_clientId_key" ON "CheckIn"("clientId");

-- CreateIndex
CREATE INDEX "CheckIn_eventId_day_idx" ON "CheckIn"("eventId", "day");

-- CreateIndex
CREATE INDEX "CheckIn_registrationId_at_idx" ON "CheckIn"("registrationId", "at");

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: one ENTRY per ticket already checked in.
INSERT INTO "CheckIn" ("id", "registrationId", "eventId", "day", "direction", "at", "scannedById", "createdAt")
SELECT 'ci' || r."id", r."id", r."eventId",
       to_char(r."checkedInAt" AT TIME ZONE 'UTC' AT TIME ZONE e."timezone", 'YYYY-MM-DD'),
       'ENTRY', r."checkedInAt", r."checkedInById", r."checkedInAt"
FROM "Registration" r
JOIN "Event" e ON e."id" = r."eventId"
WHERE r."checkedInAt" IS NOT NULL;
