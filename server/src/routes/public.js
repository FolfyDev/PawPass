import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { getSettings } from '../lib/settings.js';
import { requireUser, issueToken, setSessionCookie, audit } from '../lib/auth.js';
import { createRegistration, RegistrationError, registrationWindowState, findOrCreateHeadlessUser, cancelRegistration } from '../lib/registrations.js';
import { findMatchingBan, normHandle } from '../lib/bans.js';
import { ticketCode, ticketSecret } from '../lib/codes.js';
import { buildApplePass } from '../wallet/apple.js';
import { googleSaveUrl } from '../wallet/google.js';
import { notifyUser } from '../bot/index.js';
import { blindIndex } from '../lib/crypto.js';
import { sendRegistrationConfirmation } from '../lib/mailer.js';
import { verifyTurnstile } from '../lib/turnstile.js';

export const publicRouter = Router();

// Unauthenticated and the only public write endpoint that creates rows
// (users + registrations) — without this, a script can hammer it far faster
// than any human filling out the form, ahead of the duplicate-email check.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many registration attempts from this connection. Wait a while and try again.' },
});

publicRouter.get('/settings', async (_req, res) => {
  const s = await getSettings();
  res.json({
    ...s,
    wallet: { apple: env.apple.enabled, google: env.google.enabled },
    turnstile: { enabled: env.turnstile.enabled, siteKey: env.turnstile.siteKey },
    telegramBot: env.telegram.username,
    printMode: env.zebra.mode,
    webUrl: env.webUrl,
    legal: { entityName: env.legal.entityName, contactEmail: env.legal.contactEmail },
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
    donationRequired: event.donationRequired,
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
    orderBy: { rsvp: 'asc' },
  });
  regs.sort((a, b) => (a.rsvp === b.rsvp ? (a.fursonaName || a.user.displayName).localeCompare(b.fursonaName || b.user.displayName) : 0));
  res.json(regs.map((r) => ({
    name: r.fursonaName || r.user.displayName,
    telegramUsername: r.user.telegramUsername,
    telegramPhotoUrl: r.user.telegramPhotoUrl,
    rsvp: r.rsvp,
  })));
});


publicRouter.get('/events/:slug/merch', requireUser, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published) return res.status(404).json({ error: 'Event not found.' });
  const items = await prisma.merchItem.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
  res.json(items.map((i) => ({ id: i.id, name: i.name, price: i.price, remaining: Math.max(i.maxCount - i.soldCount, 0) })));
});


publicRouter.post('/events/:slug/register', registerLimiter, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published) return res.status(404).json({ error: 'Event not found.' });

  const { legalName, fursonaName, email, answers, acceptedTos, tier, voucherCode } = req.body || {};
  if (!acceptedTos) return res.status(400).json({ error: 'You need to accept the terms before registering.' });
  if (!legalName || String(legalName).trim().length < 2)
    return res.status(400).json({ error: 'Enter your preferred name.' });

  let user = req.user;
  let guest = false;
  if (!user) {
    if (!email || !/^\S+@\S+\.\S+$/.test(email))
      return res.status(400).json({ error: 'Enter an email address so you can get back into your account later.' });

    if (!(await verifyTurnstile(req.body.turnstileToken, req.ip)))
      return res.status(400).json({ error: 'Please complete the verification challenge and try again.' });
    const normalized = String(email).trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { emailIndex: blindIndex(normalized) } });
    if (existing) return res.status(409).json({ error: 'An account already exists with that email. Sign in first.' });
    try {
      user = await findOrCreateHeadlessUser({ eventId: event.id, legalName, fursonaName, email: normalized });
    } catch (e) {
      if (e instanceof RegistrationError) return res.status(400).json({ error: e.message });
      throw e;
    }
    guest = true;
  }

  try {
    const reg = await createRegistration({
      event, user,
      legalName, fursonaName, email, answers, tier, voucherCode,
      source: 'web',
      tosVersion: hashTos(event.tosBody),
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { legalName: reg.legalName, fursonaName: reg.fursonaName, email: reg.email ?? undefined },
    });
    getSettings().then((settings) => sendRegistrationConfirmation(reg, event, settings)).catch((e) => console.error('confirmation email failed', reg.code, e.message));
    if (guest) setSessionCookie(res, issueToken(user));
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
  const promoted = await cancelRegistration(reg);
  if (promoted?.user.telegramId) {
    await notifyUser(promoted.user.telegramId,
      `Good news — a spot opened up for ${promoted.event.title} and you have been moved off the waitlist.\n\n` +
      `Badge code: ${promoted.code}\n` +
      `Ticket and wallet pass: ${env.webUrl}/tickets`);
  }
  res.json({ ok: true });
});


publicRouter.post('/my/tickets/:code/transfer', requireUser, async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { event: true } });
  if (!reg || reg.userId !== req.user.id) return res.status(404).json({ error: 'Ticket not found.' });
  if (reg.status === 'CANCELLED') return res.status(400).json({ error: 'This ticket is cancelled.' });
  if (reg.checkedInAt) return res.status(400).json({ error: 'This ticket has already been checked in and can no longer be transferred.' });

  const telegramUsername = req.body?.telegramUsername ? normHandle(req.body.telegramUsername) : '';
  const emailInput = req.body?.email ? String(req.body.email).trim().toLowerCase() : '';
  if (!telegramUsername && !emailInput) return res.status(400).json({ error: 'Enter a Telegram username or an email address.' });
  if (emailInput && !/^\S+@\S+\.\S+$/.test(emailInput)) return res.status(400).json({ error: 'Enter a valid email address.' });

  let target;
  if (telegramUsername) {
    target = await prisma.user.findFirst({ where: { telegramUsername: { equals: telegramUsername, mode: 'insensitive' } } });
    if (!target) return res.status(404).json({ error: 'That Telegram username has not messaged the bot yet — ask them to send /start first.' });
  } else {
    target = await prisma.user.findUnique({ where: { emailIndex: blindIndex(emailInput) } });
    if (!target) target = await prisma.user.create({ data: { displayName: emailInput, email: emailInput } });
  }
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't transfer a ticket to yourself." });

  // @@unique([eventId, userId]) means the recipient can't already hold a slot
  // here — a live one is a hard stop, but a merely-cancelled leftover from a
  // previous registration attempt is safe to clear out of the way.
  const conflict = await prisma.registration.findUnique({ where: { eventId_userId: { eventId: reg.eventId, userId: target.id } } });
  if (conflict) {
    if (conflict.status !== 'CANCELLED') return res.status(409).json({ error: 'They are already registered for this event.' });
    await prisma.registration.delete({ where: { id: conflict.id } });
  }

  const ban = await findMatchingBan({ email: emailInput, telegramId: target.telegramId, telegramUsername: target.telegramUsername });
  if (ban) return res.status(403).json({ error: 'Registration is not available for this account. Contact the organizers if you think this is a mistake.' });

  const updated = await prisma.registration.update({
    where: { id: reg.id },
    data: {
      userId: target.id,
      email: target.email ?? null,
      code: ticketCode(),
      secret: ticketSecret(),
      checkedInAt: null,
      badgePrintedAt: null,
      printCount: 0,
    },
  });

  await audit(req.user.id, 'registration.transfer', reg.id, { toUserId: target.id, telegramUsername: telegramUsername || undefined, email: emailInput || undefined });

  if (target.telegramId) {
    await notifyUser(target.telegramId,
      `A ticket for ${reg.event.title} was transferred to you.\n\nBadge code: ${updated.code}\nTicket and wallet pass: ${env.webUrl}/tickets`);
  } else if (target.email) {
    getSettings().then((settings) => sendRegistrationConfirmation(updated, reg.event, settings)).catch((e) => console.error('transfer email failed', updated.code, e.message));
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
