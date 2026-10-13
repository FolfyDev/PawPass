import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/db.js';
import { requireAdmin, requirePerm, requireUser, audit } from '../lib/auth.js';
import { zonedTimeToUtc, formatInTimeZone } from '../lib/tz.js';
import { eventDays } from '../lib/checkins.js';
import { sessionPayload, submissionPayload, submissionsAccepting, ScheduleError } from '../lib/schedule.js';
import { notifyPerson } from '../lib/payments.js';
import { blockedByBan } from './public.js';

/// The event schedule and panel submissions. Owners turn each on per event
/// (PATCH /admin/events/:id); building the schedule and reviewing
/// submissions is open to admins, usually a programming team.

const isStaff = (user) => !!user && (user.role === 'ADMIN' || user.role === 'OWNER');
const fail = (res, e) => {
  if (e instanceof ScheduleError) return res.status(400).json({ error: e.message });
  throw e;
};

/* ------------------------------------------------------------- public --- */

export const schedulePublicRouter = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many submissions from this connection. Try again later.' },
});

async function publicEvent(req) {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  return event && (event.published || isStaff(req.user)) ? event : null;
}

const publicSession = (s) => ({
  id: s.id, title: s.title, description: s.description, hosts: s.hosts, track: s.track,
  startsAt: s.startsAt, endsAt: s.endsAt, room: s.room ? { id: s.room.id, name: s.room.name } : null,
});

/// Published, scheduled sessions, and which of them the viewer starred.
schedulePublicRouter.get('/events/:slug/schedule', async (req, res) => {
  const event = await publicEvent(req);
  if (!event || (!event.scheduleEnabled && !isStaff(req.user))) return res.status(404).json({ error: 'This event has no schedule yet.' });
  const [sessions, rooms, stars] = await Promise.all([
    prisma.scheduleSession.findMany({
      where: { eventId: event.id, published: true, startsAt: { not: null } },
      include: { room: true },
      orderBy: [{ startsAt: 'asc' }, { title: 'asc' }],
    }),
    prisma.eventRoom.findMany({ where: { eventId: event.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    req.user ? prisma.sessionStar.findMany({ where: { userId: req.user.id, session: { eventId: event.id } }, select: { sessionId: true } }) : [],
  ]);
  res.json({
    timezone: event.timezone, days: eventDays(event),
    rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
    sessions: sessions.map(publicSession),
    starred: stars.map((s) => s.sessionId),
  });
});

schedulePublicRouter.put('/my/stars/:sessionId', requireUser, async (req, res) => {
  const session = await prisma.scheduleSession.findFirst({ where: { id: req.params.sessionId, published: true } });
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  await prisma.sessionStar.upsert({
    where: { sessionId_userId: { sessionId: session.id, userId: req.user.id } },
    create: { sessionId: session.id, userId: req.user.id },
    update: {},
  });
  res.json({ ok: true });
});

schedulePublicRouter.delete('/my/stars/:sessionId', requireUser, async (req, res) => {
  await prisma.sessionStar.deleteMany({ where: { sessionId: req.params.sessionId, userId: req.user.id } });
  res.json({ ok: true });
});

const mySubmission = (s) => ({
  id: s.id, title: s.title, description: s.description, hosts: s.hosts, lengthMinutes: s.lengthMinutes,
  availability: s.availability, notes: s.notes, status: s.status, createdAt: s.createdAt, decidedAt: s.decidedAt,
});

/// The submission form's state: whether it's open, the guidelines, and
/// the viewer's own submissions for this event.
schedulePublicRouter.get('/events/:slug/submissions', async (req, res) => {
  const event = await publicEvent(req);
  if (!event || (!event.submissionsOpen && !isStaff(req.user))) return res.status(404).json({ error: 'This event isn\'t taking panel submissions.' });
  const mine = req.user
    ? await prisma.panelSubmission.findMany({ where: { eventId: event.id, userId: req.user.id }, orderBy: { createdAt: 'desc' } })
    : [];
  res.json({
    title: event.title, accepting: submissionsAccepting(event), closesAt: event.submissionsCloseAt,
    info: event.submissionInfo, timezone: event.timezone, mine: mine.map(mySubmission),
  });
});

schedulePublicRouter.post('/events/:slug/submissions', requireUser, submitLimiter, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published || !submissionsAccepting(event)) return res.status(400).json({ error: 'Panel submissions are closed for this event.' });
  if (await blockedByBan(req.user, event, 'panel'))
    return res.status(403).json({ error: 'Submissions are not available for this account. Contact the organizers if you think this is a mistake.' });
  const open = await prisma.panelSubmission.count({ where: { eventId: event.id, userId: req.user.id, status: 'SUBMITTED' } });
  if (open >= 5) return res.status(400).json({ error: 'You have 5 submissions waiting on a decision already.' });
  try {
    const s = await prisma.panelSubmission.create({ data: { ...submissionPayload(req.body || {}, { creating: true }), eventId: event.id, userId: req.user.id } });
    await audit(req.user.id, 'submission.create', s.id, { eventId: event.id });
    res.json(mySubmission(s));
  } catch (e) { fail(res, e); }
});

/// The submitter can change or withdraw a submission until it's decided.
schedulePublicRouter.patch('/my/submissions/:id', requireUser, async (req, res) => {
  const s = await prisma.panelSubmission.findUnique({ where: { id: req.params.id } });
  if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Submission not found.' });
  if (s.status !== 'SUBMITTED') return res.status(400).json({ error: 'This submission has been decided, so it can\'t be changed here.' });
  try {
    const updated = await prisma.panelSubmission.update({ where: { id: s.id }, data: submissionPayload(req.body || {}) });
    res.json(mySubmission(updated));
  } catch (e) { fail(res, e); }
});

schedulePublicRouter.post('/my/submissions/:id/withdraw', requireUser, async (req, res) => {
  const { count } = await prisma.panelSubmission.updateMany({
    where: { id: req.params.id, userId: req.user.id, status: 'SUBMITTED' },
    data: { status: 'WITHDRAWN' },
  });
  if (!count) return res.status(400).json({ error: 'Only a submission that\'s still waiting can be withdrawn.' });
  await audit(req.user.id, 'submission.withdraw', req.params.id, {});
  res.json({ ok: true });
});

/* -------------------------------------------------------------- admin --- */

export const scheduleAdminRouter = Router();
scheduleAdminRouter.use(requireAdmin);

const toUtcFor = (event) => (v) => zonedTimeToUtc(v, event.timezone);
const loadEvent = (id) => prisma.event.findUnique({ where: { id } });

scheduleAdminRouter.get('/events/:id/schedule', requirePerm('schedule.manage', 'submissions.review', 'schedule.publish'), async (req, res) => {
  const event = await loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const [rooms, sessions] = await Promise.all([
    prisma.eventRoom.findMany({ where: { eventId: event.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.scheduleSession.findMany({
      where: { eventId: event.id },
      include: { room: true, _count: { select: { stars: true } }, submission: { select: { id: true } } },
      orderBy: [{ startsAt: 'asc' }, { title: 'asc' }],
    }),
  ]);
  res.json({
    enabled: event.scheduleEnabled, timezone: event.timezone, days: eventDays(event),
    submissions: { open: event.submissionsOpen, closesAt: event.submissionsCloseAt, info: event.submissionInfo },
    rooms,
    sessions: sessions.map(({ _count, submission, ...s }) => ({ ...s, stars: _count.stars, submissionId: submission?.id || null })),
  });
});

scheduleAdminRouter.post('/events/:id/rooms', requirePerm('schedule.manage'), async (req, res) => {
  const event = await loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Name the room.' });
  const capacity = req.body?.capacity ? Number(req.body.capacity) : null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) return res.status(400).json({ error: 'Capacity must be a whole number.' });
  const count = await prisma.eventRoom.count({ where: { eventId: event.id } });
  const room = await prisma.eventRoom.create({ data: { eventId: event.id, name, capacity, sortOrder: count } });
  await audit(req.user.id, 'schedule.room.create', room.id, { name });
  res.json(room);
});

scheduleAdminRouter.patch('/rooms/:id', requirePerm('schedule.manage'), async (req, res) => {
  const room = await prisma.eventRoom.findUnique({ where: { id: req.params.id } });
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const data = {};
  if (req.body?.name !== undefined) {
    data.name = String(req.body.name).trim().slice(0, 120);
    if (!data.name) return res.status(400).json({ error: 'Name the room.' });
  }
  if (req.body?.capacity !== undefined) data.capacity = req.body.capacity ? Number(req.body.capacity) || null : null;
  if (req.body?.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
  res.json(await prisma.eventRoom.update({ where: { id: room.id }, data }));
});

/// Sessions in it stay, without a room.
scheduleAdminRouter.delete('/rooms/:id', requirePerm('schedule.manage'), async (req, res) => {
  const room = await prisma.eventRoom.findUnique({ where: { id: req.params.id } });
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  await prisma.eventRoom.delete({ where: { id: room.id } });
  await audit(req.user.id, 'schedule.room.delete', room.id, { name: room.name });
  res.json({ ok: true });
});

scheduleAdminRouter.post('/events/:id/sessions', requirePerm('schedule.manage'), async (req, res) => {
  const event = await loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  try {
    const data = await sessionPayload(req.body || {}, { eventId: event.id, toUtc: toUtcFor(event) });
    const session = await prisma.scheduleSession.create({ data: { ...data, eventId: event.id } });
    await audit(req.user.id, 'schedule.session.create', session.id, { title: session.title });
    res.json(session);
  } catch (e) { fail(res, e); }
});

scheduleAdminRouter.patch('/sessions/:id', requirePerm('schedule.manage'), async (req, res) => {
  const session = await prisma.scheduleSession.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  try {
    const data = await sessionPayload(req.body || {}, { eventId: session.eventId, toUtc: toUtcFor(session.event), current: session });
    const updated = await prisma.scheduleSession.update({ where: { id: session.id }, data });
    await audit(req.user.id, 'schedule.session.update', session.id, { fields: Object.keys(data) });
    res.json(updated);
  } catch (e) { fail(res, e); }
});

scheduleAdminRouter.delete('/sessions/:id', requirePerm('schedule.manage'), async (req, res) => {
  const session = await prisma.scheduleSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  await prisma.scheduleSession.delete({ where: { id: session.id } });
  await audit(req.user.id, 'schedule.session.delete', session.id, { title: session.title });
  res.json({ ok: true });
});

const shapeSubmission = (s) => ({
  ...s,
  submitter: { id: s.user.id, name: s.user.fursonaName || s.user.displayName, email: s.user.email, telegramUsername: s.user.telegramUsername },
  user: undefined,
  decidedBy: s.decidedBy?.displayName || null,
});

scheduleAdminRouter.get('/events/:id/submissions', requirePerm('submissions.review', 'schedule.manage'), async (req, res) => {
  const where = { eventId: req.params.id };
  if (['SUBMITTED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'].includes(req.query.status)) where.status = req.query.status;
  const rows = await prisma.panelSubmission.findMany({
    where, include: { user: true, decidedBy: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' },
  });
  res.json(rows.map(shapeSubmission));
});

scheduleAdminRouter.patch('/submissions/:id', requirePerm('submissions.review'), async (req, res) => {
  const s = await prisma.panelSubmission.findUnique({ where: { id: req.params.id } });
  if (!s) return res.status(404).json({ error: 'Submission not found.' });
  const reviewNote = String(req.body?.reviewNote ?? '').slice(0, 3000);
  const updated = await prisma.panelSubmission.update({ where: { id: s.id }, data: { reviewNote }, include: { user: true, decidedBy: { select: { displayName: true } } } });
  res.json(shapeSubmission(updated));
});

/// Accept (which creates an unscheduled, unpublished draft session from it)
/// or decline. `message` goes to the submitter with the decision; the
/// review note never does.
scheduleAdminRouter.post('/submissions/:id/decision', requirePerm('submissions.review'), async (req, res) => {
  const decision = req.body?.decision;
  if (!['ACCEPTED', 'DECLINED'].includes(decision)) return res.status(400).json({ error: 'Accept or decline.' });
  const s = await prisma.panelSubmission.findUnique({ where: { id: req.params.id }, include: { user: true, event: true } });
  if (!s) return res.status(404).json({ error: 'Submission not found.' });
  if (s.status !== 'SUBMITTED') return res.status(400).json({ error: 'This submission was already decided or withdrawn.' });

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.panelSubmission.updateMany({
        where: { id: s.id, status: 'SUBMITTED' },
        data: { status: decision, decidedAt: new Date(), decidedById: req.user.id, ...(req.body?.reviewNote !== undefined ? { reviewNote: String(req.body.reviewNote).slice(0, 3000) } : {}) },
      });
      if (!count) throw new ScheduleError('This submission was already decided or withdrawn.');
      if (decision === 'ACCEPTED') {
        const session = await tx.scheduleSession.create({ data: { eventId: s.eventId, title: s.title, description: s.description, hosts: s.hosts } });
        await tx.panelSubmission.update({ where: { id: s.id }, data: { sessionId: session.id } });
      }
      return tx.panelSubmission.findUnique({ where: { id: s.id }, include: { user: true, decidedBy: { select: { displayName: true } } } });
    });
  } catch (e) { return fail(res, e); }

  await audit(req.user.id, `submission.${decision.toLowerCase()}`, s.id, {});
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  const subject = decision === 'ACCEPTED' ? `Your panel was accepted for ${s.event.title}` : `About your panel for ${s.event.title}`;
  const text = decision === 'ACCEPTED'
    ? `"${s.title}" was accepted for ${s.event.title}! We'll let you know the time and room once the schedule is set.`
    : `Thank you for submitting "${s.title}" for ${s.event.title}. We weren't able to include it this time.`;
  await notifyPerson({ user: s.user, email: s.user.email, subject, text: message ? `${text}\n\n${message}` : text });
  res.json(shapeSubmission(updated));
});

/// The whole schedule as a sheet, for printing or the program book.
scheduleAdminRouter.get('/events/:id/schedule.csv', requirePerm('schedule.manage', 'submissions.review'), async (req, res) => {
  const event = await loadEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const sessions = await prisma.scheduleSession.findMany({
    where: { eventId: event.id }, include: { room: true, _count: { select: { stars: true } } }, orderBy: [{ startsAt: 'asc' }, { title: 'asc' }],
  });
  const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const keys = ['startsAt', 'endsAt', 'room', 'title', 'hosts', 'track', 'published', 'stars', 'description'];
  const rows = sessions.map((s) => [
    s.startsAt ? formatInTimeZone(s.startsAt, event.timezone) : '', s.endsAt ? formatInTimeZone(s.endsAt, event.timezone) : '',
    s.room?.name, s.title, s.hosts, s.track, s.published ? 'yes' : 'no', s._count.stars, s.description,
  ].map(csv).join(','));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="schedule.csv"').send([keys.join(','), ...rows].join('\n'));
});
