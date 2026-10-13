-- Granular staff permissions (lib/permissions.js): named staff groups, and
-- permissions granted to one person directly. Owners keep everything.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "StaffGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffGroupMember" (
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffGroupMember_pkey" PRIMARY KEY ("userId","groupId")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffGroup_name_key" ON "StaffGroup"("name");

-- CreateIndex
CREATE INDEX "StaffGroupMember_groupId_idx" ON "StaffGroupMember"("groupId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "StaffGroupMember" ADD CONSTRAINT "StaffGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffGroupMember" ADD CONSTRAINT "StaffGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "StaffGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Nobody's access changes with this upgrade: every existing admin goes into
-- a "Staff" group holding exactly what admins could do before. Owners can
-- then narrow it, or split it into groups, from Admin -> Staff.
INSERT INTO "StaffGroup" ("id", "name", "description", "permissions")
VALUES ('staff_default', 'Staff', 'Everything admins could do before permissions existed.',
  ARRAY['vouchers.manage', 'attendees.view', 'attendees.edit', 'checkin', 'volunteers.manage', 'hotels.requests', 'schedule.manage', 'submissions.review', 'vendors.review', 'merch.sell', 'merch.manage', 'reconciliation.view', 'email.draft', 'broadcast.telegram', 'incidents.file', 'bans.view']::TEXT[]);

INSERT INTO "StaffGroupMember" ("userId", "groupId")
SELECT "id", 'staff_default' FROM "User" WHERE "role" = 'ADMIN';
