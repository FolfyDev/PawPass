-- Automatic per-event messages: "know before you go" a few days ahead and a
-- thank-you afterwards, plus when each went out per registration. Additive only;
-- both are off until an owner turns them on.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "feedbackUrl" TEXT,
ADD COLUMN     "kbygDaysBefore" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "kbygEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kbygMessage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "thanksEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "thanksMessage" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "kbygSentAt" TIMESTAMP(3),
ADD COLUMN     "thanksSentAt" TIMESTAMP(3);

