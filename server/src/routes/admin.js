import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { requireAdmin, requireOwner, audit } from '../lib/auth.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { promoteFromWaitlist, createRegistration, RegistrationError } from '../lib/registrations.js';
import { zonedTimeToUtc } from '../lib/tz.js';
import { publicUser } from './auth.js';
import { summarize, shapeReg } from './public.js';
import { sendCampaign } from '../lib/mailer.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/* ---------------- events ---------------- */

adminRouter.get('/events', async (_req, res) => {
  const events = await prisma.event.findMany({
    orderBy: { startsAt: 'desc' },
    include: { _count: { select: { registrations: true } } },
  });
  res.json(events.map((e) => ({ ...summarize(e), registrationCount: e._count.registrations, published: e.published })));
});

adminRouter.get('/events/:id', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  res.json(event);
});

const EVENT_FIELDS = ['slug','title','tagline','description','venue','startsAt','endsAt','timezone','capacity','waitlistEnabled','opensAt','closesAt','published','tosTitle','tosBody','customFields','badgeTemplateId','accentColor','donationTierName','donationPaypalLink'];

/// `timeZone` is the IANA zone the incoming startsAt/endsAt/opensAt/closesAt
/// strings should be read as wall-clock time in — always the event's own
/// `timezone` field, since that's what the datetime-local inputs are
/// displayed and edited in. See lib/tz.js for why this can't just be `new Date()`.
function eventPayload(body, timeZone) {
  const data = {};
  for (const k of EVENT_FIELDS) {
    if (body[k] === undefined) continue;
    if (['startsAt','endsAt','opensAt','closesAt'].includes(k)) data[k] = body[k] ? zonedTimeToUtc(body[k], timeZone) : null;
    else if (k === 'capacity') data[k] = body[k] === '' || body[k] === null ? null : Number(body[k]);
    else data[k] = body[k];
  }
  return data;
}

adminRouter.post('/events', async (req, res) => {
  const timeZone = req.body.timezone || env.defaultTimezone;
  const data = eventPayload(req.body, timeZone);
  if (!data.slug || !data.title) return res.status(400).json({ error: 'A title and URL slug are required.' });
  const event = await prisma.event.create({ data: { startsAt: new Date(), endsAt: new Date(), timezone: timeZone, ...data } });
  await audit(req.user.id, 'event.create', event.id, { title: event.title });
  res.json(event);
});

adminRouter.patch('/events/:id', async (req, res) => {
  const timeZone = req.body.timezone || (await prisma.event.findUnique({ where: { id: req.params.id }, select: { timezone: true } }))?.timezone || env.defaultTimezone;
  const event = await prisma.event.update({ where: { id: req.params.id }, data: eventPayload(req.body, timeZone) });
  await audit(req.user.id, 'event.update', event.id, {});
  res.json(event);
});

adminRouter.delete('/events/:id', async (req, res) => {
  await prisma.event.delete({ where: { id: req.params.id } });
  await audit(req.user.id, 'event.delete', req.params.id, {});
  res.json({ ok: true });
});

/* ---------------- registrations ---------------- */

adminRouter.get('/events/:id/registrations', async (req, res) => {
  const { q, status } = req.query;
  const regs = await prisma.registration.findMany({
    where: {
      eventId: req.params.id,
      ...(status ? { status } : {}),
      ...(q ? {
        OR: [
          { legalName: { contains: String(q), mode: 'insensitive' } },
          { fursonaName: { contains: String(q), mode: 'insensitive' } },
          { code: { contains: String(q).toUpperCase() } },
          { email: { contains: String(q), mode: 'insensitive' } },
        ],
      } : {}),
    },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(regs.map((r) => ({
    id: r.id, ...shapeReg(r),
    printCount: r.printCount, badgePrintedAt: r.badgePrintedAt, source: r.source,
    telegram: r.user.telegramUsername,
  })));
});

adminRouter.get('/events/:id/registrations.csv', async (req, res) => {
  const regs = await prisma.registration.findMany({ where: { eventId: req.params.id }, include: { user: true }, orderBy: { createdAt: 'asc' } });
  const keys = ['code','status','legalName','fursonaName','email','telegram','checkedInAt','source','createdAt'];
  const rows = regs.map((r) => keys.map((k) => csv(k === 'telegram' ? r.user.telegramUsername : r[k])).join(','));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="registrations.csv"').send([keys.join(','), ...rows].join('\n'));
});

adminRouter.post('/registrations', async (req, res) => {
  // Walk-up registration typed in by staff at the door.
  const event = await prisma.event.findUnique({ where: { id: req.body.eventId } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  let user = req.body.telegramId
    ? await prisma.user.findUnique({ where: { telegramId: String(req.body.telegramId) } })
    : null;
  if (!user) {
    user = await prisma.user.create({
      data: { displayName: req.body.legalName, legalName: req.body.legalName, fursonaName: req.body.fursonaName },
    });
  }
  try {
    const reg = await createRegistration({ event, user, ...req.body, source: 'admin' });
    await audit(req.user.id, 'registration.create', reg.id, { code: reg.code });
    res.json(shapeReg(reg));
  } catch (e) {
    if (e instanceof RegistrationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

adminRouter.patch('/registrations/:code', async (req, res) => {
  const allowed = ['legalName','fursonaName','email','status','answers'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const reg = await prisma.registration.update({ where: { code: req.params.code }, data });
  if (data.status === 'CANCELLED') await promoteFromWaitlist(reg.eventId);
  await audit(req.user.id, 'registration.update', reg.id, data);
  res.json(shapeReg(reg));
});

/* ---------------- check-in ---------------- */

/// The scanner posts whatever the camera read: a full ticket URL, a bare
/// secret, or a typed badge code. All three resolve here.
adminRouter.post('/checkin', async (req, res) => {
  const raw = String(req.body.value || '').trim();
  const secret = raw.split('/').pop();
  const reg = await prisma.registration.findFirst({
    where: { OR: [{ secret }, { code: raw.toUpperCase() }] },
    include: { event: true, user: true },
  });
  if (!reg) return res.status(404).json({ error: 'No ticket matches that code.' });
  if (req.body.eventId && reg.eventId !== req.body.eventId)
    return res.status(409).json({ error: `That ticket is for ${reg.event.title}.`, registration: shapeReg(reg) });
  if (reg.status === 'CANCELLED')
    return res.status(409).json({ error: 'This ticket was cancelled.', registration: shapeReg(reg) });

  const already = reg.checkedInAt;
  const updated = already
    ? reg
    : await prisma.registration.update({
        where: { id: reg.id },
        data: { checkedInAt: new Date(), checkedInById: req.user.id },
      });

  res.json({
    ok: true,
    already: Boolean(already),
    registration: { ...shapeReg(updated), id: reg.id, event: summarize(reg.event), telegram: reg.user.telegramUsername },
  });
});

adminRouter.post('/checkin/:code/undo', async (req, res) => {
  const reg = await prisma.registration.update({
    where: { code: req.params.code },
    data: { checkedInAt: null, checkedInById: null },
  });
  await audit(req.user.id, 'checkin.undo', reg.id, {});
  res.json(shapeReg(reg));
});

/* ---------------- staff ---------------- */

adminRouter.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    where: req.query.q ? {
      OR: [
        { displayName: { contains: String(req.query.q), mode: 'insensitive' } },
        { telegramUsername: { contains: String(req.query.q), mode: 'insensitive' } },
        { email: { contains: String(req.query.q), mode: 'insensitive' } },
      ],
    } : { role: { in: ['ADMIN', 'OWNER'] } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  res.json(users.map(publicUser));
});

adminRouter.post('/users/:id/role', requireOwner, async (req, res) => {
  const role = req.body.role;
  if (!['USER', 'ADMIN', 'OWNER'].includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
  await audit(req.user.id, 'user.role', user.id, { role });
  res.json(publicUser(user));
});

adminRouter.post('/users/:id/password', requireOwner, async (req, res) => {
  const { email, password } = req.body || {};
  if (!password || password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters.' });
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { email: email?.toLowerCase(), passwordHash: await bcrypt.hash(password, 12) },
  });
  await audit(req.user.id, 'user.password', user.id, {});
  res.json(publicUser(user));
});

/* ---------------- email ---------------- */

adminRouter.get('/campaigns', async (_req, res) => {
  res.json(await prisma.emailCampaign.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
});

adminRouter.post('/campaigns', async (req, res) => {
  const c = await prisma.emailCampaign.create({
    data: {
      eventId: req.body.eventId || null,
      subject: req.body.subject,
      body: req.body.body,
      audience: req.body.audience || 'all',
    },
  });
  res.json(c);
});

adminRouter.post('/campaigns/:id/send', async (req, res) => {
  if (!env.smtp.enabled) return res.status(503).json({ error: 'SMTP is not configured on this instance.' });
  try {
    const result = await sendCampaign(req.params.id, { dryRun: Boolean(req.body.dryRun) });
    await audit(req.user.id, 'campaign.send', req.params.id, result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- uploads ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(process.cwd(), 'uploads'),
    filename: (_req, file, cb) => cb(null, `${nanoid(10)}${path.extname(file.originalname) || '.png'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

adminRouter.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received.' });
  res.json({ url: `${env.publicUrl}/uploads/${req.file.filename}` });
});

/* ---------------- settings ---------------- */

adminRouter.get('/settings', async (_req, res) => res.json(await getSettings()));
adminRouter.put('/settings', async (req, res) => {
  const s = await setSettings(req.body || {});
  await audit(req.user.id, 'settings.update', null, {});
  res.json(s);
});

adminRouter.get('/audit', async (_req, res) => {
  res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { actor: true } }));
});

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
