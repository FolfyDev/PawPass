import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { requireAdmin, can } from '../lib/auth.js';
import { todayCounts } from '../lib/checkins.js';
import { blockTotals } from '../lib/hotels.js';
import { HOLDS_TABLE } from '../lib/vendors.js';
import { featureOn } from '../lib/features.js';

/// One round trip for the event Overview page: headline numbers from every
/// part of the event, plus a "needs attention" list of concrete to-dos,
/// each pointing at the tab where it gets done.
export const overviewRouter = Router();
overviewRouter.use(requireAdmin);

const DAY = 86_400_000;
const SETTLED = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
/// Which switchable feature (lib/features.js) an attention item's tab is in.
const TAB_FEATURE = { hotels: 'hotels', rooms: 'hotels', volunteers: 'volunteers', submissions: 'schedule', schedule: 'schedule', vendors: 'vendors' };

overviewRouter.get('/events/:id/overview', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const id = event.id;
  const now = new Date();
  // Incident counts follow the incident list: all reports, or only your own.
  const owner = can(req, 'incidents.manage');

  const [regGroups, cancelRequests, arrived, today, payments, shifts, blocks, sessions, submissions, vendorGroups, tableTypes, incidents, tiersOnSale] = await Promise.all([
    prisma.registration.groupBy({ by: ['status'], where: { eventId: id }, _count: { _all: true } }),
    prisma.registration.count({ where: { eventId: id, cancelRequestedAt: { not: null }, status: { not: 'CANCELLED' } } }),
    prisma.registration.count({ where: { eventId: id, checkedInAt: { not: null } } }),
    todayCounts(event, now),
    prisma.payment.findMany({
      where: { status: { in: SETTLED }, OR: [{ registration: { eventId: id } }, { merchOrder: { eventId: id } }, { vendorApplication: { eventId: id } }] },
      select: { amountCents: true, amountRefundedCents: true, currency: true },
    }),
    prisma.volunteerShift.findMany({ where: { eventId: id }, select: { role: true, startsAt: true, slots: true, filledCount: true } }),
    prisma.roomBlock.findMany({
      where: { hotel: { eventId: id } },
      include: { hotel: { select: { name: true } }, nights: true, _count: { select: { reservations: { where: { status: 'REQUESTED' } } } } },
    }),
    prisma.scheduleSession.groupBy({ by: ['published'], where: { eventId: id, startsAt: { not: null } }, _count: { _all: true } }),
    prisma.panelSubmission.count({ where: { eventId: id, status: 'SUBMITTED' } }),
    prisma.vendorApplication.groupBy({ by: ['status'], where: { eventId: id }, _count: { _all: true } }),
    prisma.vendorTableType.findMany({ where: { eventId: id }, select: { quantity: true, _count: { select: { applications: { where: { status: { in: HOLDS_TABLE } } } } } } }),
    prisma.incident.groupBy({ by: ['severity'], where: { eventId: id, status: 'OPEN', ...(owner ? {} : { filedById: req.user.id }) }, _count: { _all: true } }),
    prisma.ticketTier.count({ where: { eventId: id, active: true } }),
  ]);
  const unscheduled = await prisma.scheduleSession.count({ where: { eventId: id, startsAt: null } });

  const regs = Object.fromEntries(regGroups.map((g) => [g.status, g._count._all]));
  const vendors = Object.fromEntries(vendorGroups.map((g) => [g.status, g._count._all]));
  const openIncidents = Object.fromEntries(incidents.map((g) => [g.severity, g._count._all]));
  const phase = now < event.startsAt ? 'upcoming' : now > event.endsAt ? 'ended' : 'live';

  const hotelBlocks = blocks.map((b) => ({ ...b, ...blockTotals(b) }));
  const contracted = hotelBlocks.reduce((n, b) => n + b.contracted, 0);
  const pickedUp = hotelBlocks.reduce((n, b) => n + b.pickedUp, 0);

  const soon = new Date(now.getTime() + 7 * DAY);
  const upcomingShifts = shifts.filter((s) => s.startsAt > now);
  const thinShifts = upcomingShifts.filter((s) => s.startsAt < soon && s.filledCount < s.slots / 2);

  // Each item: level ('bad' | 'warn' | 'info'), what, and where to fix it:
  // an event tab, or an absolute path for things outside the event.
  const attention = [];
  const add = (level, text, tab) => {
    const feature = TAB_FEATURE[tab.split('?')[0]];
    if (!feature || featureOn(event, feature)) attention.push({ level, text, tab });
  };
  const on = (feature) => featureOn(event, feature);
  if (!event.published && phase !== 'ended') add('warn', 'The event isn\'t published, so nobody can register yet.', 'details');
  if (!tiersOnSale && phase !== 'ended') add('bad', 'No ticket type is on sale.', 'tickets');
  if (openIncidents.HIGH) add('bad', `${openIncidents.HIGH} high-severity incident report${openIncidents.HIGH === 1 ? ' is' : 's are'} open.`, '/admin/incidents');
  if (cancelRequests) add('warn', `${cancelRequests} cancellation request${cancelRequests === 1 ? '' : 's'} waiting on a decision.`, 'attendees');
  if (regs.PENDING_PAYMENT) add('info', `${regs.PENDING_PAYMENT} registration${regs.PENDING_PAYMENT === 1 ? ' is' : 's are'} mid-checkout.`, 'attendees');
  if (event.capacity && (regs.CONFIRMED || 0) >= event.capacity * 0.9 && phase !== 'ended')
    add('info', `${regs.CONFIRMED} of ${event.capacity} spots taken.${regs.WAITLIST ? ` ${regs.WAITLIST} on the waitlist.` : ''}`, 'attendees');
  for (const b of hotelBlocks) {
    if (b.shortfall && b.cutoffAt && b.cutoffAt > now && b.cutoffAt - now < 21 * DAY) {
      const days = Math.ceil((b.cutoffAt - now) / DAY);
      add('warn', `${b.hotel.name} ${b.name}: ${b.shortfall} room nights short of the ${b.attritionPercent}% pickup target, cutoff in ${days} day${days === 1 ? '' : 's'}.`, 'hotels');
    }
  }
  const awaitingHotel = blocks.reduce((n, b) => n + b._count.reservations, 0);
  if (awaitingHotel) add('info', `${awaitingHotel} hotel request${awaitingHotel === 1 ? '' : 's'} waiting on a confirmation number.`, 'rooms?status=requested');
  if (thinShifts.length) add('warn', `${thinShifts.length} volunteer shift${thinShifts.length === 1 ? ' is' : 's are'} less than half full in the next week.`, 'volunteers');
  if (submissions) add('info', `${submissions} panel submission${submissions === 1 ? '' : 's'} to review.`, 'submissions');
  if (unscheduled) add('info', `${unscheduled} session${unscheduled === 1 ? '' : 's'} with no time yet.`, 'schedule');
  if (vendors.SUBMITTED) add('info', `${vendors.SUBMITTED} vendor application${vendors.SUBMITTED === 1 ? '' : 's'} to review.`, 'vendors');
  if (vendors.ACCEPTED) add('warn', `${vendors.ACCEPTED} accepted vendor${vendors.ACCEPTED === 1 ? ' hasn\'t' : 's haven\'t'} paid their table fee.`, 'vendors');
  const order = { bad: 0, warn: 1, info: 2 };
  attention.sort((a, b) => order[a.level] - order[b.level]);

  res.json({
    event: {
      id, title: event.title, slug: event.slug, published: event.published, startsAt: event.startsAt, endsAt: event.endsAt,
      timezone: event.timezone, venue: event.venue, capacity: event.capacity, phase,
      daysUntil: phase === 'upcoming' ? Math.ceil((event.startsAt - now) / DAY) : null,
    },
    registrations: { confirmed: regs.CONFIRMED || 0, waitlist: regs.WAITLIST || 0, pending: regs.PENDING_PAYMENT || 0, cancelled: regs.CANCELLED || 0, arrived },
    door: today,
    moneyCents: payments.reduce((n, p) => n + p.amountCents - p.amountRefundedCents, 0),
    currency: payments[0]?.currency || 'usd',
    volunteers: on('volunteers') && shifts.length ? { slots: shifts.reduce((n, s) => n + s.slots, 0), filled: shifts.reduce((n, s) => n + s.filledCount, 0), shifts: shifts.length } : null,
    hotels: on('hotels') && blocks.length ? { contracted, pickedUp, blocks: blocks.length } : null,
    program: on('schedule') && (sessions.length || submissions || unscheduled)
      ? { published: sessions.find((s) => s.published)?._count._all || 0, drafts: sessions.find((s) => !s.published)?._count._all || 0, unscheduled, toReview: submissions }
      : null,
    vendors: on('vendors') && (tableTypes.length || vendorGroups.length)
      ? { tables: tableTypes.reduce((n, t) => n + t.quantity, 0), taken: tableTypes.reduce((n, t) => n + t._count.applications, 0), toReview: vendors.SUBMITTED || 0, feeDue: vendors.ACCEPTED || 0 }
      : null,
    incidents: { open: Object.values(openIncidents).reduce((n, c) => n + c, 0), high: openIncidents.HIGH || 0, scope: owner ? 'all' : 'yours' },
    attention,
  });
});
