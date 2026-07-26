import { Router } from 'express';
import QRCode from 'qrcode';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { getSettings } from '../lib/settings.js';
import { requireUser } from '../lib/auth.js';
import { createRegistration, RegistrationError, registrationWindowState, promoteFromWaitlist } from '../lib/registrations.js';
import { buildApplePass } from '../wallet/apple.js';
import { googleSaveUrl } from '../wallet/google.js';
import { notifyUser } from '../bot/index.js';

export const publicRouter = Router();

publicRouter.get('/settings', async (_req, res) => {
  const s = await getSettings();
  res.json({
    ...s,
    wallet: { apple: env.apple.enabled, google: env.google.enabled },
    telegramBot: env.telegram.username,
  });
});

publicRouter.get('/events', async (_req, res) => {
  const events = await prisma.event.findMany({
    where: { published: true },
    orderBy: { startsAt: 'asc' },
    include: { _count: { select: { registrations: { where: { status: 'CONFIRMED' } } } } },
  });
  res.json(events.map(summarize));
});

publicRouter.get('/events/:slug', async (req, res) => {
  const event = await prisma.event.findUnique({
    where: { slug: req.params.slug },
    include: { _count: { select: { registrations: { where: { status: 'CONFIRMED' } } } } },
  });
  if (!event || !event.published) return res.status(404).json({ error: 'Event not found.' });
  const state = registrationWindowState(event, event._count.registrations);
  let mine = null;
  if (req.user) {
    mine = await prisma.registration.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.user.id } },
    });
  }
  res.json({
    ...summarize(event), description: event.description, tosTitle: event.tosTitle, tosBody: event.tosBody,
    customFields: event.customFields, state, registration: mine && shapeReg(mine),
    donationTierName: event.donationTierName, donationPaypalLink: event.donationPaypalLink,
  });
});

/// Who's going — signed-in only, since it surfaces Telegram usernames/photos.
/// People who RSVP'd No are omitted outright, not just hidden client-side.
publicRouter.get('/events/:slug/rsvps', requireUser, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published) return res.status(404).json({ error: 'Event not found.' });
  const regs = await prisma.registration.findMany({
    where: { eventId: event.id, status: 'CONFIRMED', rsvp: { in: ['YES', 'MAYBE'] } },
    include: { user: true },
    orderBy: [{ rsvp: 'asc' }, { fursonaName: 'asc' }],
  });
  res.json(regs.map((r) => ({
    name: r.fursonaName || r.user.displayName,
    telegramUsername: r.user.telegramUsername,
    telegramPhotoUrl: r.user.telegramPhotoUrl,
    rsvp: r.rsvp,
  })));
});

/// Read-only availability for signed-in attendees — same bar as /rsvps above
/// (anyone who can sign in already clears it). Sales are always recorded by
/// staff in person; there is no self-checkout here.
publicRouter.get('/events/:slug/merch', requireUser, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published) return res.status(404).json({ error: 'Event not found.' });
  const items = await prisma.merchItem.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
  res.json(items.map((i) => ({ id: i.id, name: i.name, price: i.price, remaining: Math.max(i.maxCount - i.soldCount, 0) })));
});

publicRouter.post('/events/:slug/register', requireUser, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published) return res.status(404).json({ error: 'Event not found.' });

  const { legalName, fursonaName, email, answers, acceptedTos, tier, voucherCode } = req.body || {};
  if (!acceptedTos) return res.status(400).json({ error: 'You need to accept the terms before registering.' });
  if (!legalName || String(legalName).trim().length < 2)
    return res.status(400).json({ error: 'Enter your full legal name.' });

  try {
    const reg = await createRegistration({
      event, user: req.user,
      legalName, fursonaName, email, answers, tier, voucherCode,
      source: 'web',
      tosVersion: hashTos(event.tosBody),
    });
    await prisma.user.update({
      where: { id: req.user.id },
      data: { legalName: reg.legalName, fursonaName: reg.fursonaName, email: reg.email ?? undefined },
    });
    res.json(shapeReg(reg));
  } catch (e) {
    if (e instanceof RegistrationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

publicRouter.get('/my/tickets', requireUser, async (req, res) => {
  const regs = await prisma.registration.findMany({
    where: { userId: req.user.id, status: { not: 'CANCELLED' } },
    include: { event: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(regs.map((r) => ({ ...shapeReg(r), event: summarize(r.event) })));
});

publicRouter.post('/my/tickets/:code/rsvp', requireUser, async (req, res) => {
  const rsvp = req.body?.rsvp;
  if (!['YES', 'MAYBE', 'NO'].includes(rsvp)) return res.status(400).json({ error: 'Unknown RSVP value.' });
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code } });
  if (!reg || reg.userId !== req.user.id) return res.status(404).json({ error: 'Ticket not found.' });
  if (reg.status === 'CANCELLED') return res.status(400).json({ error: 'This ticket is cancelled.' });
  const updated = await prisma.registration.update({ where: { id: reg.id }, data: { rsvp } });
  res.json(shapeReg(updated));
});

publicRouter.post('/my/tickets/:code/cancel', requireUser, async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code } });
  if (!reg || reg.userId !== req.user.id) return res.status(404).json({ error: 'Ticket not found.' });
  await prisma.registration.update({ where: { id: reg.id }, data: { status: 'CANCELLED' } });
  const promoted = await promoteFromWaitlist(reg.eventId);
  if (promoted?.user.telegramId) {
    await notifyUser(promoted.user.telegramId,
      `Good news — a spot opened up for ${promoted.event.title} and you have been moved off the waitlist.\n\n` +
      `Badge code: ${promoted.code}\n` +
      `Ticket and wallet pass: ${env.webUrl}/tickets`);
  }
  res.json({ ok: true });
});

/// QR image for a ticket the signed-in user owns.
publicRouter.get('/my/tickets/:code/qr.png', requireUser, async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code } });
  if (!reg || reg.userId !== req.user.id) return res.status(404).end();
  const png = await QRCode.toBuffer(`${env.publicUrl}/t/${reg.secret}`, { width: 640, margin: 1 });
  res.type('png').send(png);
});

publicRouter.get('/my/tickets/:code/apple.pkpass', requireUser, async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { event: true } });
  if (!reg || reg.userId !== req.user.id) return res.status(404).end();
  try {
    const buf = await buildApplePass({ registration: reg, event: reg.event, settings: await getSettings() });
    res.type('application/vnd.apple.pkpass').set('Content-Disposition', `attachment; filename="${reg.code}.pkpass"`).send(buf);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

publicRouter.get('/my/tickets/:code/google', requireUser, async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { event: true } });
  if (!reg || reg.userId !== req.user.id) return res.status(404).end();
  try {
    res.json({ url: googleSaveUrl({ registration: reg, event: reg.event, settings: await getSettings() }) });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

export function summarize(e) {
  return {
    id: e.id, slug: e.slug, title: e.title, tagline: e.tagline, venue: e.venue,
    startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone,
    capacity: e.capacity, accentColor: e.accentColor, published: e.published,
    confirmed: e._count?.registrations,
  };
}

export function shapeReg(r) {
  return {
    code: r.code, status: r.status, legalName: r.legalName, fursonaName: r.fursonaName,
    email: r.email, answers: r.answers, checkedInAt: r.checkedInAt, createdAt: r.createdAt,
    qrUrl: `${env.publicUrl}/t/${r.secret}`,
    tier: r.tier, badgeNumber: r.badgeNumber, rsvp: r.rsvp,
    paymentMethod: r.paymentMethod, paymentAmount: r.paymentAmount, paymentNote: r.paymentNote,
    badgeTier: r.badgeTier,
  };
}

function hashTos(body) {
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) | 0;
  return `v${(h >>> 0).toString(16)}`;
}
