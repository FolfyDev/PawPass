/// What staff can be allowed to do, one key per area of the admin.
/// Owners always have every one. Admins have the union of their groups'
/// permissions plus any granted to them directly. `staff: true` marks what
/// the built-in "Staff" group starts with: exactly what an admin could do
/// before permissions existed, so the 0015 migration changes nobody's access.
///
/// Staff and access, settings, backup/restore and data retention stay
/// owner-only and aren't listed: whoever can grant permissions can grant
/// themselves anything, so that can't be handed out piecemeal.
export const PERMISSION_GROUPS = [
  ['Events and tickets', [
    ['events.edit', 'Create and edit events', 'Details, publishing and registration settings.'],
    ['events.delete', 'Delete events', 'Removes the event and everything in it.'],
    ['tickets.manage', 'Ticket types and discounts', 'Prices, limits, sale windows, discount codes, the donation add-on and Stripe sync.'],
    ['vouchers.manage', 'Vouchers', 'Create, edit and delete voucher codes.', true],
  ]],
  ['Attendees and the door', [
    ['attendees.view', 'See attendees', 'The attendee list, search, CSV export and receipts.', true],
    ['attendees.edit', 'Edit attendees', 'Add and edit registrations, record payments, resend emails, link Telegram, combine duplicates.', true],
    ['payments.refund', 'Refunds and cancellations', 'Refund payments and decide cancellation requests.'],
    ['checkin', 'Check in and print badges', 'The scanner, offline sync, arrivals and badge printing.', true],
    ['badges.design', 'Badge designer', 'Badge templates and printer setup.'],
  ]],
  ['People', [
    ['volunteers.manage', 'Volunteer roster', 'Add and remove people from shifts and mark attendance.', true],
    ['volunteers.shifts', 'Volunteer shifts', 'Create, edit and delete shifts, and turn sign-up on or off.'],
    ['hotels.requests', 'Room requests', 'Add, confirm, change and cancel room requests.', true],
    ['hotels.setup', 'Hotels and room blocks', 'Partner hotels, blocks, contracted nights and the public hotel list.'],
  ]],
  ['Program', [
    ['schedule.manage', 'Schedule', 'Rooms and sessions.', true],
    ['schedule.publish', 'Publish the schedule', 'Show the schedule publicly, and open or close panel submissions.'],
    ['submissions.review', 'Panel submissions', 'Review, accept and decline panel submissions.', true],
    ['vendors.review', 'Vendor applications', 'Decide applications, assign tables and record payments.', true],
    ['vendors.setup', 'Vendor tables', 'Table types, prices, and opening or closing applications.'],
  ]],
  ['Money', [
    ['merch.sell', 'Sell at the kiosk', 'Merch sales, donations and pre-order pickups.', true],
    ['merch.manage', 'Merch items', 'Add, edit and delete merch items.', true],
    ['reconciliation.view', 'Cash reconciliation', 'Totals by payment method and the CSV exports.', true],
  ]],
  ['Messages', [
    ['email.draft', 'Draft emails', 'Write email campaigns for an owner or sender to send.', true],
    ['email.send', 'Send emails', 'Send campaigns to attendees.'],
    ['broadcast.telegram', 'Telegram broadcast', 'Message every attendee of an event with /broadcast in the bot.', true],
  ]],
  ['Safety', [
    ['incidents.file', 'File incident reports', 'File reports and see the ones they filed.', true],
    ['incidents.manage', 'Manage all incident reports', 'See every report, remove people from one, ban from one, and delete reports.'],
    ['bans.view', 'See bans', 'The ban list and blocked registration attempts.', true],
    ['bans.manage', 'Add and lift bans', ''],
  ]],
  ['Instance', [
    ['audit.view', 'Audit log', 'Everything staff have done, and when.'],
    ['analytics.view', 'Analytics', 'Registration and revenue trends across events.'],
  ]],
];

export const PERMISSIONS = PERMISSION_GROUPS.flatMap(([, list]) => list.map(([key]) => key));
const KNOWN = new Set(PERMISSIONS);
export const STAFF_DEFAULTS = PERMISSION_GROUPS.flatMap(([, list]) => list.filter((p) => p[3]).map(([key]) => key));

/// The catalog as the Staff page shows it.
export const permissionCatalog = () => PERMISSION_GROUPS.map(([area, list]) => ({
  area, permissions: list.map(([key, label, help]) => ({ key, label, help })),
}));

/// Drops anything unknown and duplicates, so stored lists stay clean.
export const cleanPermissions = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => KNOWN.has(k)))];

/// Load a user with this so effectivePermissions() can see their groups.
export const WITH_GROUPS = { staffGroups: { include: { group: true } } };

/// Everything this user may do. `user` must be loaded with WITH_GROUPS for an
/// admin's groups to count; without it only their direct grants do.
export function effectivePermissions(user) {
  if (!user) return new Set();
  if (user.role === 'OWNER') return new Set(PERMISSIONS);
  if (user.role !== 'ADMIN') return new Set();
  const out = new Set(user.permissions || []);
  for (const m of user.staffGroups || []) for (const p of m.group.permissions) out.add(p);
  for (const p of out) if (!KNOWN.has(p)) out.delete(p);
  return out;
}

/// Fields of PATCH /events/:id that belong to one section's own settings
/// card, so whoever runs that section can save it without full event edit
/// rights. Everything else on an event needs events.edit.
export const EVENT_FIELD_PERMISSION = {
  hotelsEnabled: 'hotels.setup', hotelInfo: 'hotels.setup',
  volunteersEnabled: 'volunteers.shifts', volunteerInfo: 'volunteers.shifts',
  scheduleEnabled: 'schedule.publish', submissionsOpen: 'schedule.publish', submissionsCloseAt: 'schedule.publish', submissionInfo: 'schedule.publish',
  vendorsOpen: 'vendors.setup', vendorsCloseAt: 'vendors.setup', vendorInfo: 'vendors.setup',
  donationAddonEnabled: 'tickets.manage', donationAddonLabel: 'tickets.manage', donationAddonPresets: 'tickets.manage',
};
