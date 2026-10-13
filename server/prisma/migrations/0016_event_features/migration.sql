-- Optional event sections an admin has switched off (lib/features.js).
ALTER TABLE "Event" ADD COLUMN "disabledFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[];
