-- Age check on registration, and the door's "people in line" count.
ALTER TABLE "Event" ADD COLUMN "ageCheckEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN "minorAge" INTEGER NOT NULL DEFAULT 18;
ALTER TABLE "Event" ADD COLUMN "guardianMode" TEXT NOT NULL DEFAULT 'optional';
ALTER TABLE "Event" ADD COLUMN "doorLineCount" INTEGER;
ALTER TABLE "Event" ADD COLUMN "doorLineAt" TIMESTAMP(3);

ALTER TABLE "Registration" ADD COLUMN "birthDate" TEXT;
ALTER TABLE "Registration" ADD COLUMN "guardianName" TEXT;
