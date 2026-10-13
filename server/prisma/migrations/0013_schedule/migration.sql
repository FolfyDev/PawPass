-- Event schedule (rooms, sessions, attendee stars) and panel submissions.
-- Additive only; both stay hidden until turned on per event.

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "submissionInfo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "submissionsCloseAt" TIMESTAMP(3),
ADD COLUMN     "submissionsOpen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EventRoom" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSession" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roomId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "hosts" TEXT NOT NULL DEFAULT '',
    "track" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionStar" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionStar_pkey" PRIMARY KEY ("sessionId","userId")
);

-- CreateTable
CREATE TABLE "PanelSubmission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "hosts" TEXT NOT NULL DEFAULT '',
    "lengthMinutes" INTEGER NOT NULL DEFAULT 60,
    "availability" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "SubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PanelSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventRoom_eventId_idx" ON "EventRoom"("eventId");

-- CreateIndex
CREATE INDEX "ScheduleSession_eventId_startsAt_idx" ON "ScheduleSession"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduleSession_roomId_idx" ON "ScheduleSession"("roomId");

-- CreateIndex
CREATE INDEX "SessionStar_userId_idx" ON "SessionStar"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PanelSubmission_sessionId_key" ON "PanelSubmission"("sessionId");

-- CreateIndex
CREATE INDEX "PanelSubmission_eventId_status_idx" ON "PanelSubmission"("eventId", "status");

-- CreateIndex
CREATE INDEX "PanelSubmission_userId_idx" ON "PanelSubmission"("userId");

-- AddForeignKey
ALTER TABLE "EventRoom" ADD CONSTRAINT "EventRoom_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSession" ADD CONSTRAINT "ScheduleSession_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSession" ADD CONSTRAINT "ScheduleSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "EventRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionStar" ADD CONSTRAINT "SessionStar_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ScheduleSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionStar" ADD CONSTRAINT "SessionStar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSubmission" ADD CONSTRAINT "PanelSubmission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSubmission" ADD CONSTRAINT "PanelSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSubmission" ADD CONSTRAINT "PanelSubmission_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSubmission" ADD CONSTRAINT "PanelSubmission_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ScheduleSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

