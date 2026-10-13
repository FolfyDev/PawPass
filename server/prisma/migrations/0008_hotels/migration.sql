-- Partner hotels, room blocks with per-night inventory, and room requests.
-- Additive only; "Where to stay" stays hidden on every event until turned on.

-- CreateEnum
CREATE TYPE "RoomBlockMode" AS ENUM ('HOTEL_BOOKED', 'ORGANIZER_MANAGED');

-- CreateEnum
CREATE TYPE "RoomReservationStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "hotelInfo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "hotelsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Hotel" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "url" TEXT,
    "phone" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomBlock" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "rateCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "mode" "RoomBlockMode" NOT NULL DEFAULT 'HOTEL_BOOKED',
    "bookingUrl" TEXT,
    "groupCode" TEXT,
    "cutoffAt" TIMESTAMP(3),
    "maxGuests" INTEGER NOT NULL DEFAULT 4,
    "attritionPercent" INTEGER,
    "attendeesOnly" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "staffNotes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomBlockNight" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "night" TEXT NOT NULL,
    "contracted" INTEGER NOT NULL,
    "held" INTEGER NOT NULL DEFAULT 0,
    "reportedPickup" INTEGER,

    CONSTRAINT "RoomBlockNight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomReservation" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "roommates" TEXT NOT NULL DEFAULT '',
    "guests" INTEGER NOT NULL DEFAULT 1,
    "checkIn" TEXT NOT NULL,
    "checkOut" TEXT NOT NULL,
    "status" "RoomReservationStatus" NOT NULL DEFAULT 'REQUESTED',
    "confirmationNumber" TEXT,
    "note" TEXT,
    "staffNote" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Hotel_eventId_idx" ON "Hotel"("eventId");

-- CreateIndex
CREATE INDEX "RoomBlock_hotelId_idx" ON "RoomBlock"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomBlockNight_blockId_night_key" ON "RoomBlockNight"("blockId", "night");

-- CreateIndex
CREATE INDEX "RoomReservation_blockId_status_idx" ON "RoomReservation"("blockId", "status");

-- CreateIndex
CREATE INDEX "RoomReservation_userId_idx" ON "RoomReservation"("userId");

-- AddForeignKey
ALTER TABLE "Hotel" ADD CONSTRAINT "Hotel_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomBlock" ADD CONSTRAINT "RoomBlock_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomBlockNight" ADD CONSTRAINT "RoomBlockNight_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "RoomBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomReservation" ADD CONSTRAINT "RoomReservation_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "RoomBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomReservation" ADD CONSTRAINT "RoomReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

