-- Volunteer shifts and sign-ups. Additive only; sign-up stays hidden on every
-- event until an owner turns it on.

-- CreateEnum
CREATE TYPE "VolunteerAttendance" AS ENUM ('PENDING', 'PRESENT', 'NO_SHOW');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "volunteerInfo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "volunteersEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VolunteerShift" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "slots" INTEGER NOT NULL,
    "filledCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerSignup" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT,
    "attendance" "VolunteerAttendance" NOT NULL DEFAULT 'PENDING',
    "markedAt" TIMESTAMP(3),
    "markedById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolunteerSignup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VolunteerShift_eventId_startsAt_idx" ON "VolunteerShift"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "VolunteerSignup_userId_idx" ON "VolunteerSignup"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerSignup_shiftId_userId_key" ON "VolunteerSignup"("shiftId", "userId");

-- AddForeignKey
ALTER TABLE "VolunteerShift" ADD CONSTRAINT "VolunteerShift_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "VolunteerShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

