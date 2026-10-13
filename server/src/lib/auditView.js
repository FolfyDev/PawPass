import { prisma } from './db.js';
import { PERMISSION_GROUPS } from './permissions.js';

/// Turns raw AuditLog rows into what a person reads: a sentence for the
/// action, the target's name (rows only store its id) with a link to it, and
/// the meta as labelled values instead of JSON. Targets are looked up in one
/// query per table for the whole page of rows; a deleted one falls back to
/// whatever name the row's own meta kept.

/// Which table an action's target id lives in, first match wins. Some
/// actions point at one of two tables (hotel.update is used for hotels and
/// for room requests), so a rule can list both.
const TARGETS = [
  [/^(checkin\.offline_sync|tier\.sync|data\.purge|badge\.print_batch)$/, ['event']],
  [/^(registration|checkin)\.|^badge\.print$/, ['registration']],
  [/^event\./, ['event']],
  [/^tier\./, ['ticketTier']],
  [/^discount\./, ['discountCode']],
  [/^voucher\./, ['voucherCode']],
  [/^hotel\.block\./, ['roomBlock']],
  [/^hotel\.(create|delete)$/, ['hotel']],
  [/^hotel\.update$/, ['hotel', 'roomReservation']],
  [/^hotel\./, ['roomReservation']],
  [/^(user|auth)\./, ['user']],
  [/^payment\./, ['payment']],
  [/^merch_order\./, ['merchOrder']],
  [/^merch\.sale/, ['sale']],
  [/^merch\./, ['merchItem']],
  [/^donation\./, ['donation']],
  [/^incident\./, ['incident']],
  [/^ban\./, ['ban']],
  [/^schedule\.room\./, ['eventRoom']],
  [/^schedule\.session\./, ['scheduleSession']],
  [/^submission\./, ['panelSubmission']],
  [/^vendor\.table\./, ['vendorTableType']],
  [/^vendor\./, ['vendorApplication']],
  [/^volunteer\.shift\./, ['volunteerShift']],
  [/^volunteer\./, ['volunteerSignup']],
  [/^campaign\./, ['emailCampaign']],
  [/^staff_group\./, ['staffGroup']],
];

/// Meta keys that hold an id, and the table to name it from.
const META_REFS = {
  eventId: 'event', userId: 'user', toUserId: 'user', blockId: 'roomBlock', shiftId: 'volunteerShift',
  itemId: 'merchItem', hotelId: 'hotel', incidentId: 'incident', vendorApplicationId: 'vendorApplication',
};

const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format((cents || 0) / 100);
const who = (r) => r.fursonaName || r.legalName || 'Attendee';

/// How each table is fetched and named. `href` is an admin page path.
const MODELS = {
  event: { query: {}, label: (e) => ({ label: e.title, href: `/admin/events/${e.id}` }) },
  registration: {
    query: { include: { event: { select: { title: true } } } },
    label: (r) => ({ label: `${who(r)} · ${r.code}`, sub: r.event?.title, href: `/admin/events/${r.eventId}/attendees?q=${encodeURIComponent(r.code)}` }),
  },
  ticketTier: { query: { include: { event: { select: { title: true } } } }, label: (t) => ({ label: t.name, sub: t.event?.title, href: `/admin/events/${t.eventId}/tickets` }) },
  discountCode: { query: { include: { event: { select: { title: true } } } }, label: (d) => ({ label: d.code, sub: d.event?.title, href: `/admin/events/${d.eventId}/tickets` }) },
  voucherCode: { query: { include: { event: { select: { title: true } } } }, label: (v) => ({ label: v.code, sub: v.event?.title, href: `/admin/events/${v.eventId}/vouchers` }) },
  hotel: { query: {}, label: (h) => ({ label: h.name, href: `/admin/events/${h.eventId}/hotels` }) },
  roomBlock: {
    query: { include: { hotel: { select: { name: true, eventId: true } } } },
    label: (b) => ({ label: `${b.hotel.name} · ${b.name}`, href: `/admin/events/${b.hotel.eventId}/hotels` }),
  },
  roomReservation: {
    query: { include: { block: { include: { hotel: { select: { name: true, eventId: true } } } } } },
    label: (r) => ({ label: r.guestName, sub: `${r.block.hotel.name} · ${r.block.name}`, href: `/admin/events/${r.block.hotel.eventId}/rooms?block=${r.blockId}&status=all` }),
  },
  user: { query: {}, label: (u) => ({ label: u.displayName }) },
  payment: {
    query: { include: { registration: { select: { code: true, eventId: true, fursonaName: true, legalName: true } }, vendorApplication: { select: { businessName: true, eventId: true } } } },
    label: (p) => ({
      label: `${money(p.amountCents, p.currency)} ${p.method === 'STRIPE' ? 'online' : p.method.toLowerCase()}`,
      sub: p.registration ? `${who(p.registration)} · ${p.registration.code}` : p.vendorApplication ? p.vendorApplication.businessName : p.merchOrderId ? 'Merch pre-order' : null,
      href: p.registration ? `/admin/events/${p.registration.eventId}/attendees?q=${encodeURIComponent(p.registration.code)}`
        : p.vendorApplication ? `/admin/events/${p.vendorApplication.eventId}/vendors` : undefined,
    }),
  },
  merchOrder: { query: { include: { user: { select: { displayName: true } } } }, label: (o) => ({ label: `Pre-order · ${money(o.totalCents, o.currency)}`, sub: o.user?.displayName, href: `/admin/events/${o.eventId}/merch` }) },
  sale: { query: { include: { item: { select: { name: true, eventId: true } } } }, label: (s) => ({ label: `${s.quantity} × ${s.item.name}`, href: `/admin/events/${s.item.eventId}/merch` }) },
  merchItem: { query: {}, label: (m) => ({ label: m.name, href: `/admin/events/${m.eventId}/merch` }) },
  donation: { query: { include: { event: { select: { title: true } } } }, label: (d) => ({ label: `$${Number(d.amount).toFixed(2)} donation`, sub: d.event?.title, href: `/admin/events/${d.eventId}/reconciliation` }) },
  incident: { query: {}, label: (i) => ({ label: i.summary, href: `/admin/incidents/${i.id}` }) },
  ban: { query: {}, label: (b) => ({ label: b.legalName || b.email || (b.telegramUsername && `@${b.telegramUsername}`) || 'Ban', href: '/admin/bans' }) },
  eventRoom: { query: {}, label: (r) => ({ label: r.name, href: `/admin/events/${r.eventId}/schedule` }) },
  scheduleSession: { query: {}, label: (s) => ({ label: s.title, href: `/admin/events/${s.eventId}/schedule` }) },
  panelSubmission: { query: {}, label: (s) => ({ label: s.title, href: `/admin/events/${s.eventId}/submissions` }) },
  vendorTableType: { query: {}, label: (t) => ({ label: t.name, href: `/admin/events/${t.eventId}/vendors` }) },
  vendorApplication: { query: {}, label: (a) => ({ label: a.businessName, href: `/admin/events/${a.eventId}/vendors` }) },
  volunteerShift: { query: {}, label: (s) => ({ label: s.role, href: `/admin/events/${s.eventId}/volunteers` }) },
  volunteerSignup: {
    query: { include: { user: { select: { displayName: true } }, shift: { select: { role: true, eventId: true } } } },
    label: (s) => ({ label: s.user.displayName, sub: `${s.shift.role} shift`, href: `/admin/events/${s.shift.eventId}/volunteers` }),
  },
  emailCampaign: { query: {}, label: (c) => ({ label: c.subject, href: '/admin/email' }) },
  staffGroup: { query: {}, label: (g) => ({ label: g.name, href: '/admin/staff' }) },
};

/// What each action says, as a sentence about the target.
const VERBS = {
  'auth.2fa.enable': 'Turned on two-factor', 'auth.2fa.disable': 'Turned off two-factor',
  'auth.2fa.recovery_regenerated': 'Made new two-factor recovery codes', 'auth.2fa.recovery_used': 'Signed in with a recovery code',
  'backup.create': 'Downloaded a backup', 'backup.restore': 'Restored a backup',
  'badge.print': 'Printed a badge', 'badge.print_batch': 'Printed a batch of badges',
  'ban.create': 'Banned someone', 'ban.delete': 'Lifted a ban', 'ban.blocked_registration': 'Blocked a banned person from registering',
  'campaign.send': 'Sent an email campaign',
  'checkin.override': 'Checked someone in despite a warning', 'checkin.undo': 'Undid a check-in',
  'checkin.offline_sync': 'Synced offline check-ins', 'checkin.offline_flagged': 'Flagged an offline check-in',
  'data.purge': 'Purged personal data for an event',
  'discount.create': 'Created a discount code', 'discount.update': 'Edited a discount code', 'discount.delete': 'Deleted a discount code',
  'donation.create': 'Recorded a donation', 'donation.undo': 'Undid a donation',
  'event.create': 'Created an event', 'event.update': 'Edited an event', 'event.delete': 'Deleted an event',
  'hotel.create': 'Added a hotel', 'hotel.update': 'Edited a hotel booking', 'hotel.delete': 'Deleted a hotel',
  'hotel.block.create': 'Added a room block', 'hotel.block.update': 'Edited a room block', 'hotel.block.delete': 'Deleted a room block',
  'hotel.block.nights': 'Changed the nights in a room block',
  'hotel.request': 'Requested a hotel room', 'hotel.add': 'Added a hotel room for someone', 'hotel.cancel': 'Cancelled a hotel room',
  'incident.create': 'Filed an incident report', 'incident.update': 'Updated an incident report', 'incident.delete': 'Deleted an incident report',
  'incident.note': 'Added a note to an incident report', 'incident.person.add': 'Added someone to an incident report',
  'incident.person.remove': 'Removed someone from an incident report',
  'merch.create': 'Added a merch item', 'merch.update': 'Edited a merch item', 'merch.delete': 'Deleted a merch item',
  'merch.sale': 'Sold merch', 'merch.sale.undo': 'Undid a merch sale',
  'merch_order.notify_ready': 'Told buyers their pre-orders are ready', 'merch_order.hold_expired': 'A merch pre-order hold expired',
  'payment.record': 'Recorded a payment', 'payment.undo': 'Undid a payment', 'payment.paid': 'Payment received online',
  'payment.refund_requested': 'Started a refund', 'payment.refunded': 'Refund completed', 'payment.refund_recorded': 'Recorded a refund',
  'payment.mismatch': 'Online payment amount didn\'t match', 'payment.paid_after_cancel': 'Payment arrived after cancellation',
  'registration.create': 'Added a registration', 'registration.update': 'Edited a registration',
  'registration.cancel_requested': 'Asked to cancel their ticket', 'registration.cancel_approved': 'Approved a cancellation',
  'registration.cancel_declined': 'Declined a cancellation', 'registration.self_cancel_refund': 'Cancelled their ticket with a refund',
  'registration.combine': 'Combined duplicate registrations', 'registration.hold_expired': 'A seat hold expired',
  'registration.link_telegram': 'Linked Telegram to a registration', 'registration.resend_email': 'Resent a ticket email',
  'registration.transfer': 'Transferred a ticket',
  'schedule.room.create': 'Added a schedule room', 'schedule.room.delete': 'Deleted a schedule room',
  'schedule.session.create': 'Added a session', 'schedule.session.update': 'Edited a session', 'schedule.session.delete': 'Deleted a session',
  'settings.update': 'Changed instance settings', 'settings.retention': 'Changed data retention',
  'staff_group.create': 'Created a staff group', 'staff_group.update': 'Edited a staff group', 'staff_group.delete': 'Deleted a staff group',
  'submission.create': 'Submitted a panel', 'submission.withdraw': 'Withdrew a panel submission',
  'tier.create': 'Created a ticket type', 'tier.update': 'Edited a ticket type', 'tier.delete': 'Deleted a ticket type', 'tier.sync': 'Synced ticket types with Stripe',
  'user.role': 'Changed someone\'s role', 'user.access': 'Changed someone\'s permissions', 'user.password': 'Set someone\'s password',
  'user.2fa.reset': 'Reset someone\'s two-factor', 'user.self_delete': 'Deleted their own account',
  'vendor.apply': 'Applied for a vendor table', 'vendor.withdraw': 'Withdrew a vendor application', 'vendor.cancel': 'Cancelled a vendor application',
  'vendor.payment': 'Recorded a vendor payment', 'vendor.table_number': 'Assigned a vendor table number',
  'vendor.table.create': 'Added a vendor table type', 'vendor.table.update': 'Edited a vendor table type', 'vendor.table.delete': 'Deleted a vendor table type',
  'volunteer.signup': 'Signed up for a volunteer shift', 'volunteer.drop': 'Dropped a volunteer shift',
  'volunteer.add': 'Added someone to a volunteer shift', 'volunteer.remove': 'Removed someone from a volunteer shift',
  'volunteer.attendance': 'Marked volunteer attendance',
  'volunteer.shift.create': 'Created a volunteer shift', 'volunteer.shift.update': 'Edited a volunteer shift', 'volunteer.shift.delete': 'Deleted a volunteer shift',
  'voucher.create': 'Created a voucher', 'voucher.update': 'Edited a voucher', 'voucher.delete': 'Deleted a voucher',
};

/// Filter chips on the audit page: label and the action prefixes in each.
export const AUDIT_AREAS = [
  ['attendees', 'Attendees and door', ['registration.', 'checkin.', 'badge.']],
  ['money', 'Money', ['payment.', 'donation.', 'merch.', 'merch_order.']],
  ['events', 'Events and tickets', ['event.', 'tier.', 'discount.', 'voucher.']],
  ['people', 'Volunteers and hotels', ['volunteer.', 'hotel.']],
  ['program', 'Schedule and vendors', ['schedule.', 'submission.', 'vendor.']],
  ['safety', 'Incidents and bans', ['incident.', 'ban.']],
  ['staff', 'Staff and sign-in', ['user.', 'auth.', 'staff_group.']],
  ['instance', 'Settings and data', ['settings.', 'backup.', 'data.', 'campaign.']],
];

const humanize = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
/// DEALERS_DEN -> Dealers den; free text (a shift's role) is left as typed.
const enumText = (v) => (/^[A-Z][A-Z0-9_]*$/.test(String(v)) ? humanize(String(v).toLowerCase()) : String(v));
const PERMISSION_LABEL = Object.fromEntries(PERMISSION_GROUPS.flatMap(([, list]) => list.map(([key, label]) => [key, label])));
const nightText = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/// Labels and formatting for known meta keys. Anything not listed is shown
/// with a humanized key; ids we can't name and internals are left out.
const META = {
  amountCents: ['Amount', (v) => money(v)], priceCents: ['Price', (v) => money(v)], amountOffCents: ['Amount off', (v) => money(v)],
  amountRefundedCents: ['Refunded', (v) => money(v)], amount: ['Amount', (v) => `$${Number(v).toFixed(2)}`],
  percentOff: ['Discount', (v) => `${v}% off`],
  code: ['Ticket code'], keptCode: ['Kept ticket'], droppedCode: ['Merged ticket'],
  method: ['Paid by', enumText], paymentMethod: ['Paid by', enumText], area: ['Area', enumText],
  status: ['Status', enumText], severity: ['Severity', enumText], category: ['Category', enumText], role: ['Role', enumText],
  attendance: ['Attendance', enumText], direction: ['Direction', enumText], badgeTier: ['Badge tier'],
  checkIn: ['Check-in', nightText], checkOut: ['Check-out', nightText], day: ['Day', nightText],
  fields: ['Changed', (v) => v.map(humanize).join(', ')],
  full: ['Full refund', (v) => (v ? 'Yes' : 'No')], byStaff: ['By staff', (v) => (v ? 'Yes' : 'No')],
  left: ['Recovery codes left'], nights: ['Nights'], quantity: ['Quantity'], count: ['Badges'], synced: ['Synced'], sent: ['Messages sent'],
  maxCount: ['Stock'], tableNumber: ['Table'], months: ['Keep data for', (v) => `${v} months`], via: ['Printed from', enumText],
  problem: ['Problem', enumText], skipped: ['Skipped'],
  name: ['Name'], title: ['Title'], summary: ['Summary'], legalName: ['Name'], email: ['Email'], telegramUsername: ['Telegram', (v) => `@${v}`],
  renamedFrom: ['Renamed from'],
  groups: ['Groups', (v) => v.join(', ') || 'None'], joined: ['Added to'], 'left_groups': ['Removed from'],
  permissions: ['Permissions', (v) => v.map((k) => PERMISSION_LABEL[k] || k).join(', ') || 'None'],
  added: ['Allowed', (v) => v.map((k) => PERMISSION_LABEL[k] || k).join(', ')],
  removed: ['No longer allowed', (v) => v.map((k) => PERMISSION_LABEL[k] || k).join(', ')],
  granted: ['Granted', (v) => v.map((k) => PERMISSION_LABEL[k] || k).join(', ')],
  revoked: ['Revoked', (v) => v.map((k) => PERMISSION_LABEL[k] || k).join(', ')],
  counts: ['Rows restored', (v) => Object.values(v).reduce((n, c) => n + c, 0).toLocaleString('en-US')],
};
/// Never worth showing: Stripe internals and raw ids nothing can name.
const HIDDEN = new Set(['sessionId', 'refundId', 'telegramId']);

function formatValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.map(formatValue).filter(Boolean).join(', ') : null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${humanize(k)}: ${formatValue(x)}`).join(' · ');
  return String(v);
}

function details(action, meta, names) {
  const out = [];
  // jsonb doesn't keep key order, so set one: linked things (event, person)
  // first, then the rest alphabetically.
  const entries = Object.entries(meta || {}).sort(([a], [b]) => (META_REFS[b] ? 1 : 0) - (META_REFS[a] ? 1 : 0) || a.localeCompare(b));
  for (const [key, value] of entries) {
    if (HIDDEN.has(key) || value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
    if (META_REFS[key]) {
      const named = names[META_REFS[key]]?.get(value);
      if (named) out.push({ label: humanize(key.replace(/Id$/, '')), value: named.label, href: named.href });
      continue;
    }
    // user.access logs both groups joined and left; "left" means recovery
    // codes everywhere else.
    const spec = action === 'user.access' && key === 'left' ? META.left_groups : META[key];
    const label = spec?.[0] || humanize(key);
    let text;
    try { text = spec?.[1] ? spec[1](value) : formatValue(value); } catch { text = formatValue(value); }
    if (text) out.push({ label, value: text });
  }
  return out;
}

/// Shapes a page of AuditLog rows (with `actor` included) for the audit page.
export async function describeAuditRows(rows) {
  const want = {}; // model -> Set of ids
  const ask = (model, id) => { if (id && typeof id === 'string') (want[model] ||= new Set()).add(id); };
  const candidates = rows.map((r) => (r.target ? TARGETS.find(([re]) => re.test(r.action))?.[1] || [] : []));
  rows.forEach((r, i) => {
    for (const m of candidates[i]) ask(m, r.target);
    for (const [key, model] of Object.entries(META_REFS)) ask(model, r.meta?.[key]);
  });

  const names = {};
  await Promise.all(Object.entries(want).map(async ([model, ids]) => {
    const spec = MODELS[model];
    const found = await prisma[model].findMany({ where: { id: { in: [...ids] } }, ...spec.query });
    names[model] = new Map(found.map((row) => [row.id, spec.label(row)]));
  }));

  return rows.map((r, i) => {
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    let target = null;
    for (const m of candidates[i]) { target = names[m]?.get(r.target); if (target) break; }
    if (!target && r.target && candidates[i].length) {
      // Deleted since: name it from what the row kept, if anything.
      const kept = meta.name || meta.title || meta.summary || meta.code || meta.legalName || meta.email;
      target = { label: kept ? String(kept) : 'Something since deleted', deleted: true };
    }
    if (!target && r.target === 'selection') target = { label: 'Selected badges' };
    return {
      id: r.id,
      at: r.createdAt,
      action: r.action,
      summary: VERBS[r.action] || humanize(r.action),
      actor: r.actor ? { id: r.actor.id, name: r.actor.displayName, role: r.actor.role } : null,
      target,
      // A name the target already shows isn't worth repeating below it.
      details: details(r.action, meta, names).filter((d) => d.value !== target?.label),
    };
  });
}
