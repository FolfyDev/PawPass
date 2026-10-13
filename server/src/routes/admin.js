import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { requireAdmin, requireOwner, audit, linkTelegramIdentity, TelegramLinkError } from '../lib/auth.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { promoteFromWaitlist, createRegistration, RegistrationError, findOrCreateHeadlessUser, validateAnswers, heldByTier, HOLDS_SEAT } from '../lib/registrations.js';
import { STAFF_PAYMENT_METHODS, recordInPersonPayment, PaymentError, toCents, refundPayment, decideCancelRequest } from '../lib/payments.js';
import { normalizeCode, MAX_DONATION_CENTS } from '../lib/pricing.js';
import { shapeOrder } from '../lib/merch.js';
import { syncTier, archiveTierProduct, stripeEnabled } from '../lib/stripe.js';
import { upgradeBackup, BACKUP_VERSION } from '../lib/backup.js';
import { norm, normHandle } from '../lib/bans.js';
import { ticketCode } from '../lib/codes.js';
import { zonedTimeToUtc, formatInTimeZone } from '../lib/tz.js';
import { publicUser } from './auth.js';
import { summarize, shapeReg, REG_INCLUDE, RECEIPT_INCLUDE } from './public.js';
import { ticketReceipt, orderReceipt } from '../lib/receipt.js';
import { sendCampaign, sendRegistrationConfirmation, sendNoticeEmail } from '../lib/mailer.js';
import { notifyWaitlistPromotion, notifyUser } from '../bot/index.js';
import { signUpForShift, dropSignup, shiftPayload, shapeVolunteer, shiftHours, ATTENDANCE, VolunteerError } from '../lib/volunteers.js';
import { recordScan, undoLastScan, todayCounts, dailyAttendance, eventDays, hashSecret, dayIn, ScanError, DIRECTIONS } from '../lib/checkins.js';
import { reserveRoom, cancelReservation, changeStay, blockTotals, hotelPayload, blockPayload, setNights, nightsBetween, HotelError, LIVE } from '../lib/hotels.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/* ---------------- events ---------------- */

/// `registrationCount` is spots taken against capacity: confirmed, plus spots
/// held for someone mid-checkout (`awaitingPayment`, released if it expires).
/// Cancelled and waitlisted registrations don't count.
adminRouter.get('/events', async (_req, res) => {
  const events = await prisma.event.findMany({ orderBy: { startsAt: 'desc' } });
  const counts = await prisma.registration.groupBy({ by: ['eventId', 'status'], where: { status: { in: HOLDS_SEAT } }, _count: { _all: true } });
  const count = (eventId, status) => counts.find((c) => c.eventId === eventId && c.status === status)?._count._all || 0;
  res.json(events.map((e) => ({
    ...summarize(e),
    confirmed: count(e.id, 'CONFIRMED'),
    awaitingPayment: count(e.id, 'PENDING_PAYMENT'),
    registrationCount: count(e.id, 'CONFIRMED') + count(e.id, 'PENDING_PAYMENT'),
    published: e.published,
  })));
});

adminRouter.get('/events/:id', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  res.json(event);
});

const EVENT_FIELDS = ['slug','title','tagline','description','venue','startsAt','endsAt','timezone','capacity','waitlistEnabled','opensAt','closesAt','published','tosTitle','tosBody','customFields','badgeTemplateId','accentColor','donationAddonEnabled','donationAddonLabel','donationAddonPresets','cancelPolicy','kbygEnabled','kbygDaysBefore','kbygMessage','thanksEnabled','thanksMessage','feedbackUrl','volunteersEnabled','volunteerInfo','hotelsEnabled','hotelInfo','occupancyLimit'];

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
    else if (k === 'occupancyLimit') {
      const n = body[k] === '' || body[k] === null ? null : Number(body[k]);
      if (n !== null && (!Number.isInteger(n) || n < 1)) throw new RegistrationError('The occupancy limit must be a whole number, or blank for none.');
      data[k] = n;
    }
    else if (k === 'donationAddonEnabled' || k === 'kbygEnabled' || k === 'thanksEnabled' || k === 'volunteersEnabled' || k === 'hotelsEnabled') data[k] = Boolean(body[k]);
    else if (k === 'kbygDaysBefore') {
      const days = Number(body[k]);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new RegistrationError('Send "know before you go" 1 to 30 days before.');
      data[k] = days;
    }
    else if (k === 'kbygMessage' || k === 'thanksMessage' || k === 'volunteerInfo' || k === 'hotelInfo') data[k] = String(body[k] || '').slice(0, 5000);
    else if (k === 'feedbackUrl') {
      const url = String(body[k] || '').trim();
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new RegistrationError('The feedback link must start with http:// or https://.');
      data[k] = url || null;
    }
    else if (k === 'cancelPolicy') {
      if (!['AUTO_REFUND', 'REQUEST'].includes(body[k])) throw new RegistrationError('Choose how cancellations of paid tickets work.');
      data[k] = body[k];
    }
    else if (k === 'donationAddonLabel') data[k] = String(body[k] || '').trim() || 'Add a donation';
    else if (k === 'donationAddonPresets') {
      const presets = (Array.isArray(body[k]) ? body[k] : []).map(Number);
      if (presets.some((c) => !Number.isInteger(c) || c < 100 || c > MAX_DONATION_CENTS))
        throw new RegistrationError(`Donation amounts must be between $1 and $${MAX_DONATION_CENTS / 100}.`);
      data[k] = [...new Set(presets)].sort((a, b) => a - b).slice(0, 6);
    }
    else data[k] = body[k];
  }
  return data;
}

adminRouter.post('/events', requireOwner, async (req, res) => {
  const timeZone = req.body.timezone || env.defaultTimezone;
  let data;
  try { data = eventPayload(req.body, timeZone); }
  catch (e) { if (e instanceof RegistrationError) return res.status(400).json({ error: e.message }); throw e; }
  if (!data.slug || !data.title) return res.status(400).json({ error: 'A title and URL slug are required.' });
  const event = await prisma.event.create({ data: { startsAt: new Date(), endsAt: new Date(), timezone: timeZone, ...data } });
  await audit(req.user.id, 'event.create', event.id, { title: event.title });
  res.json(event);
});

adminRouter.patch('/events/:id', requireOwner, async (req, res) => {
  const before = await prisma.event.findUnique({ where: { id: req.params.id }, select: { timezone: true, title: true } });
  if (!before) return res.status(404).json({ error: 'Event not found.' });
  const timeZone = req.body.timezone || before.timezone || env.defaultTimezone;
  let data;
  try { data = eventPayload(req.body, timeZone); }
  catch (e) { if (e instanceof RegistrationError) return res.status(400).json({ error: e.message }); throw e; }
  const event = await prisma.event.update({ where: { id: req.params.id }, data });
  // Stripe product names include the event title — keep them matching.
  if (event.title !== before.title) {
    const tiers = await prisma.ticketTier.findMany({ where: { eventId: event.id, stripeProductId: { not: null } } });
    for (const t of tiers) await syncTier(t, event);
  }
  await audit(req.user.id, 'event.update', event.id, {});
  res.json(event);
});

/* ---------------- ticket tiers ---------------- */

const shapeTier = (t, held = 0) => ({ ...t, held, remaining: t.capacity != null ? Math.max(t.capacity - held, 0) : null });
const CURRENCY = /^[a-z]{3}$/;

/// Validates a tier create/update body into Prisma data. `existing` is the
/// current row on update, so partial bodies only touch what they include.
/// Sale-window times arrive as wall-clock strings in the event's timezone,
/// same as the event's own dates.
function tierPayload(body, existing, timeZone) {
  const data = {};
  for (const k of ['salesStartAt', 'salesEndAt']) {
    if (body[k] !== undefined) data[k] = body[k] ? zonedTimeToUtc(body[k], timeZone) : null;
  }
  const start = data.salesStartAt !== undefined ? data.salesStartAt : existing?.salesStartAt;
  const end = data.salesEndAt !== undefined ? data.salesEndAt : existing?.salesEndAt;
  if (start && end && end <= start) throw new RegistrationError('The sale has to end after it starts.');
  if (body.name !== undefined || !existing) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new RegistrationError('Give the ticket type a name.');
    data.name = name;
  }
  if (body.description !== undefined) data.description = String(body.description ?? '').trim();
  if (body.price !== undefined) {
    const cents = toCents(body.price) ?? 0;
    if (!Number.isInteger(cents) || cents < 0) throw new RegistrationError('Price must be zero or more.');
    if (cents > 0 && cents < 50) throw new RegistrationError('Paid tickets must cost at least $0.50.');
    data.priceCents = cents;
  }
  if (body.currency !== undefined) {
    const currency = String(body.currency).trim().toLowerCase();
    if (!CURRENCY.test(currency)) throw new RegistrationError('Currency must be a three-letter code like USD.');
    data.currency = currency;
  }
  if (body.capacity !== undefined) {
    const cap = body.capacity === '' || body.capacity === null ? null : Number(body.capacity);
    if (cap !== null && (!Number.isInteger(cap) || cap < 0)) throw new RegistrationError('Ticket limit must be a whole number, or blank for no limit.');
    data.capacity = cap;
  }
  if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.validDays !== undefined) {
    const days = Array.isArray(body.validDays) ? body.validDays : [];
    if (days.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(String(d)))) throw new RegistrationError('Valid days must be dates.');
    data.validDays = [...new Set(days.map(String))].sort();
  }
  return data;
}

adminRouter.get('/events/:id/tiers', async (req, res) => {
  const [tiers, held] = await Promise.all([
    prisma.ticketTier.findMany({ where: { eventId: req.params.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    heldByTier(req.params.id),
  ]);
  const counts = await prisma.registration.groupBy({ by: ['ticketTierId'], where: { eventId: req.params.id }, _count: { _all: true } });
  const total = Object.fromEntries(counts.map((c) => [c.ticketTierId, c._count._all]));
  const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { timezone: true, startsAt: true, endsAt: true } });
  res.json({
    stripe: stripeEnabled(),
    timezone: event?.timezone,
    // For picking a day pass's valid days.
    days: event ? eventDays(event) : [],
    tiers: tiers.map((t) => ({ ...shapeTier(t, held[t.id] || 0), registrationCount: total[t.id] || 0 })),
  });
});

adminRouter.post('/events/:id/tiers', requireOwner, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  let data;
  try { data = tierPayload(req.body || {}, null, event.timezone); }
  catch (e) { if (e instanceof RegistrationError) return res.status(400).json({ error: e.message }); throw e; }
  if (data.sortOrder === undefined) data.sortOrder = await prisma.ticketTier.count({ where: { eventId: event.id } });
  const tier = await syncTier(await prisma.ticketTier.create({ data: { ...data, eventId: event.id } }), event);
  await audit(req.user.id, 'tier.create', tier.id, { name: tier.name, priceCents: tier.priceCents });
  res.json(shapeTier(tier));
});

adminRouter.patch('/tiers/:id', requireOwner, async (req, res) => {
  const existing = await prisma.ticketTier.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!existing) return res.status(404).json({ error: 'Ticket type not found.' });
  let data;
  try { data = tierPayload(req.body || {}, existing, existing.event.timezone); }
  catch (e) { if (e instanceof RegistrationError) return res.status(400).json({ error: e.message }); throw e; }
  if (data.capacity != null) {
    const held = (await heldByTier(existing.eventId))[existing.id] || 0;
    if (data.capacity < held) return res.status(400).json({ error: `Ticket limit cannot be below the ${held} already taken.` });
  }
  const updated = await prisma.ticketTier.update({ where: { id: existing.id }, data });
  const tier = await syncTier(updated, existing.event);
  await audit(req.user.id, 'tier.update', tier.id, data);
  res.json(shapeTier(tier, (await heldByTier(existing.eventId))[tier.id] || 0));
});

/// Only for tiers nobody has registered on — otherwise deactivate it, which
/// stops sales but keeps the registrations' tier (and its price) intact.
adminRouter.delete('/tiers/:id', requireOwner, async (req, res) => {
  const tier = await prisma.ticketTier.findUnique({ where: { id: req.params.id }, include: { _count: { select: { registrations: true } } } });
  if (!tier) return res.status(404).json({ error: 'Ticket type not found.' });
  if (tier._count.registrations > 0)
    return res.status(400).json({ error: 'People are registered on this ticket type. Turn off "On sale" instead.' });
  await prisma.ticketTier.delete({ where: { id: tier.id } });
  await archiveTierProduct(tier);
  await audit(req.user.id, 'tier.delete', tier.id, { name: tier.name });
  res.json({ ok: true });
});

/* ---------------- discount codes ---------------- */

/// Validates a discount code body. Exactly one of percentOff / amountOff.
function discountPayload(body, existing, timeZone) {
  const data = {};
  if (body.code !== undefined || !existing) {
    const code = normalizeCode(body.code);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new RegistrationError('Codes are 3–32 letters, numbers, dashes or underscores.');
    data.code = code;
  }
  if (body.percentOff !== undefined || body.amountOff !== undefined) {
    const pct = body.percentOff === '' || body.percentOff == null ? null : Number(body.percentOff);
    const amt = body.amountOff === '' || body.amountOff == null ? null : toCents(body.amountOff);
    if ((pct == null) === (amt == null)) throw new RegistrationError('Set either a percent off or an amount off, not both.');
    if (pct != null && (!Number.isInteger(pct) || pct < 1 || pct > 100)) throw new RegistrationError('Percent off must be a whole number from 1 to 100.');
    if (amt != null && (!Number.isInteger(amt) || amt <= 0)) throw new RegistrationError('Amount off must be more than zero.');
    data.percentOff = pct;
    data.amountOffCents = amt;
  } else if (!existing) {
    throw new RegistrationError('Set a percent off or an amount off.');
  }
  if (body.maxUses !== undefined) {
    const max = body.maxUses === '' || body.maxUses == null ? null : Number(body.maxUses);
    if (max != null && (!Number.isInteger(max) || max < 1)) throw new RegistrationError('Max uses must be a whole number, or blank for unlimited.');
    if (max != null && existing && max < existing.usedCount) throw new RegistrationError(`Max uses cannot be below the ${existing.usedCount} already used.`);
    data.maxUses = max;
  }
  if (body.tierIds !== undefined) data.tierIds = Array.isArray(body.tierIds) ? body.tierIds.map(String) : [];
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.expiresAt !== undefined) data.expiresAt = body.expiresAt ? zonedTimeToUtc(body.expiresAt, timeZone) : null;
  return data;
}

adminRouter.get('/events/:id/discounts', async (req, res) => {
  res.json(await prisma.discountCode.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'desc' } }));
});

adminRouter.post('/events/:id/discounts', requireOwner, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  try {
    const code = await prisma.discountCode.create({ data: { ...discountPayload(req.body || {}, null, event.timezone), eventId: event.id } });
    await audit(req.user.id, 'discount.create', code.id, { code: code.code, percentOff: code.percentOff, amountOffCents: code.amountOffCents });
    res.json(code);
  } catch (e) {
    if (e instanceof RegistrationError) return res.status(400).json({ error: e.message });
    if (e.code === 'P2002') return res.status(400).json({ error: 'That code already exists for this event.' });
    throw e;
  }
});

adminRouter.patch('/discounts/:id', requireOwner, async (req, res) => {
  const existing = await prisma.discountCode.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!existing) return res.status(404).json({ error: 'Discount code not found.' });
  try {
    const code = await prisma.discountCode.update({ where: { id: existing.id }, data: discountPayload(req.body || {}, existing, existing.event.timezone) });
    await audit(req.user.id, 'discount.update', code.id, req.body);
    res.json(code);
  } catch (e) {
    if (e instanceof RegistrationError) return res.status(400).json({ error: e.message });
    if (e.code === 'P2002') return res.status(400).json({ error: 'That code already exists for this event.' });
    throw e;
  }
});

/// Registrations that used it keep their discount (it's snapshotted).
adminRouter.delete('/discounts/:id', requireOwner, async (req, res) => {
  const code = await prisma.discountCode.findUnique({ where: { id: req.params.id } });
  if (!code) return res.status(404).json({ error: 'Discount code not found.' });
  await prisma.discountCode.delete({ where: { id: code.id } });
  await audit(req.user.id, 'discount.delete', code.id, { code: code.code });
  res.json({ ok: true });
});

/// Re-pushes every tier on the event to Stripe — for recovering from a sync
/// error, or after adding STRIPE_SECRET_KEY to an instance that already had tiers.
adminRouter.post('/events/:id/tiers/sync', requireOwner, async (req, res) => {
  if (!stripeEnabled()) return res.status(400).json({ error: 'Stripe is not configured on this instance (STRIPE_SECRET_KEY).' });
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const tiers = await prisma.ticketTier.findMany({ where: { eventId: event.id } });
  const synced = [];
  for (const t of tiers) synced.push(await syncTier(t, event));
  await audit(req.user.id, 'tier.sync', event.id, { count: synced.length });
  res.json({ ok: true, errors: synced.filter((t) => t.stripeSyncError).map((t) => ({ id: t.id, name: t.name, error: t.stripeSyncError })) });
});

adminRouter.delete('/events/:id', requireOwner, async (req, res) => {
  await prisma.event.delete({ where: { id: req.params.id } });
  await audit(req.user.id, 'event.delete', req.params.id, {});
  res.json({ ok: true });
});

/* ---------------- registrations ---------------- */

// legalName/fursonaName/email are encrypted at rest, so a substring search
// across them can't happen in the database query — it's filtered here
// instead, after Prisma has already decrypted the fetched rows.
adminRouter.get('/events/:id/registrations', async (req, res) => {
  const { q, status } = req.query;
  const regs = await prisma.registration.findMany({
    where: { eventId: req.params.id, ...(status ? { status } : {}) },
    include: { user: true, ...REG_INCLUDE },
    orderBy: { createdAt: 'asc' },
  });
  const needle = q ? String(q).toLowerCase() : '';
  const filtered = needle
    ? regs.filter((r) => [r.legalName, r.fursonaName, r.code, r.email].some((v) => v && v.toLowerCase().includes(needle)))
    : regs;
  res.json(filtered.map((r) => ({
    id: r.id, ...shapeReg(r),
    printCount: r.printCount, badgePrintedAt: r.badgePrintedAt, source: r.source,
    telegram: r.user.telegramUsername,
  })));
});

adminRouter.get('/events/:id/registrations.csv', async (req, res) => {
  const regs = await prisma.registration.findMany({ where: { eventId: req.params.id }, include: { user: true, ...REG_INCLUDE }, orderBy: { createdAt: 'asc' } });
  const keys = ['code','status','legalName','fursonaName','email','telegram','checkedInAt','source','createdAt','tierName','badgeTier','tierPrice','paid','paymentMethod','balanceDue'];
  const dollars = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));
  const rows = regs.map((r) => {
    const shaped = shapeReg(r);
    const value = {
      telegram: r.user.telegramUsername,
      tierPrice: dollars(shaped.tierPriceCents),
      paid: dollars(shaped.paidCents),
      paymentMethod: shaped.paymentMethod,
      balanceDue: dollars(shaped.balanceDueCents),
    };
    return keys.map((k) => csv(k in value ? value[k] : r[k])).join(',');
  });
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="registrations.csv"').send([keys.join(','), ...rows].join('\n'));
});

adminRouter.post('/registrations', async (req, res) => {
  // Walk-up registration typed in by staff at the door.
  const event = await prisma.event.findUnique({ where: { id: req.body.eventId } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  try {
    // No Telegram ID to match on for a bare walk-up, so findOrCreateHeadlessUser
    // catches the common case of someone who preregistered online walking up
    // and getting entered as a second, separate attendee.
    let user = req.body.telegramId
      ? await prisma.user.findUnique({ where: { telegramId: String(req.body.telegramId) } })
      : null;
    if (!user) user = await findOrCreateHeadlessUser({ eventId: req.body.eventId, legalName: req.body.legalName, fursonaName: req.body.fursonaName, email: req.body.email });
    const p = req.body.payment;
    const reg = await createRegistration({
      event, user,
      legalName: req.body.legalName, fursonaName: req.body.fursonaName, email: req.body.email, answers: req.body.answers,
      ticketTierId: req.body.ticketTierId, voucherCode: req.body.voucherCode,
      inPersonPayment: p?.method ? { method: p.method, amountCents: toCents(p.amount), note: p.note } : null,
      processedById: req.user.id,
      source: 'admin',
    });
    await audit(req.user.id, 'registration.create', reg.id, { code: reg.code });
    getSettings().then((settings) => sendRegistrationConfirmation(reg, event, settings)).catch((e) => console.error('confirmation email failed', reg.code, e.message));
    res.json(shapeReg(reg));
  } catch (e) {
    if (e instanceof RegistrationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

adminRouter.patch('/registrations/:code', async (req, res) => {
  const allowed = ['legalName','fursonaName','email','status','answers','ticketTierId'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (data.ticketTierId !== undefined) {
    const current = await prisma.registration.findUnique({ where: { code: req.params.code }, select: { eventId: true } });
    if (!current) return res.status(404).json({ error: 'Registration not found.' });
    const tier = data.ticketTierId ? await prisma.ticketTier.findFirst({ where: { id: data.ticketTierId, eventId: current.eventId } }) : null;
    if (data.ticketTierId && !tier) return res.status(400).json({ error: 'That ticket type is not on this event.' });
    data.ticketTierId = tier?.id ?? null;
    data.tierName = tier?.name ?? null;
  }
  if (data.answers) {
    const existing = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { event: true } });
    if (!existing) return res.status(404).json({ error: 'Registration not found.' });
    // Only checked for required-field violations here, not reassigned —
    // validateAnswers()'s return value drops any key no longer in the
    // event's current customFields, which would silently erase an answer to
    // a question that has since been removed from the event.
    try { validateAnswers(existing.event, data.answers, data.ticketTierId !== undefined ? data.ticketTierId : existing.ticketTierId); }
    catch (e) { if (e instanceof RegistrationError) return res.status(400).json({ error: e.message }); throw e; }
  }
  const reg = await prisma.registration.update({ where: { code: req.params.code }, data, include: REG_INCLUDE });
  if (data.status === 'CANCELLED') {
    const promoted = await promoteFromWaitlist(reg.eventId);
    await notifyWaitlistPromotion(promoted);
  }
  await audit(req.user.id, 'registration.update', reg.id, data);
  res.json(shapeReg(reg));
});

/// Money taken in person for a registration that was already created — e.g.
/// someone who registered online on a pay-at-the-door tier, paying at check-in.
adminRouter.post('/registrations/:code/payments', async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { ticketTier: true } });
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  try {
    const payment = await recordInPersonPayment({
      registrationId: reg.id, method: req.body?.method, amountCents: toCents(req.body?.amount),
      note: req.body?.note, processedById: req.user.id, currency: reg.ticketTier?.currency,
    });
    await audit(req.user.id, 'payment.record', payment.id, { code: reg.code, method: payment.method, amountCents: payment.amountCents });
    res.json(shapeReg(await prisma.registration.findUnique({ where: { id: reg.id }, include: REG_INCLUDE })));
  } catch (e) {
    if (e instanceof PaymentError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/// Undoes a mistaken in-person entry. Stripe payments are refunded from the
/// Stripe dashboard instead, and the refund webhook updates them here.
adminRouter.delete('/payments/:id', async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { registration: true } });
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.method === 'STRIPE') return res.status(400).json({ error: 'Use Refund for Stripe payments instead.' });
  await prisma.payment.delete({ where: { id: payment.id } });
  await audit(req.user.id, 'payment.undo', payment.id, { code: payment.registration.code, amountCents: payment.amountCents });
  res.json(shapeReg(await prisma.registration.findUnique({ where: { id: payment.registrationId }, include: REG_INCLUDE })));
});

/// Refunds a payment, in full or part. Stripe payments go back to the card
/// through the Stripe API; in-person ones are recorded as handed back. A full
/// refund cancels the ticket (or pre-order), same as a refund in the Stripe
/// dashboard would. Owner-only: it moves real money.
adminRouter.post('/payments/:id/refund', requireOwner, async (req, res) => {
  const amountCents = req.body?.amount === undefined || req.body?.amount === '' ? undefined : toCents(req.body.amount);
  try {
    const payment = await refundPayment({ paymentId: req.params.id, amountCents, actorId: req.user.id });
    if (payment.registrationId) {
      return res.json({ registration: shapeReg(await prisma.registration.findUnique({ where: { id: payment.registrationId }, include: REG_INCLUDE })) });
    }
    res.json({ order: shapeOrder(await prisma.merchOrder.findUnique({ where: { id: payment.merchOrderId }, include: { items: true, payments: true, user: true } })) });
  } catch (e) {
    if (e instanceof PaymentError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/// Approve (refund + cancel) or decline an attendee's cancellation request.
/// Owner-only, since approving moves money.
adminRouter.post('/registrations/:code/cancel-request', requireOwner, async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code } });
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  try {
    const { promoted } = await decideCancelRequest({ registrationId: reg.id, approve: req.body?.approve === true, actorId: req.user.id });
    await notifyWaitlistPromotion(promoted);
    res.json(shapeReg(await prisma.registration.findUnique({ where: { id: reg.id }, include: REG_INCLUDE })));
  } catch (e) {
    if (e instanceof PaymentError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/// Manual re-send for "I never got the confirmation email" — awaited rather
/// than fire-and-forget like the automatic send at registration time, since
/// here an admin is directly waiting on the result and needs to know if it
/// actually went out (e.g. SMTP not configured on this instance).
adminRouter.post('/registrations/:code/resend-email', async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { event: true } });
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  if (!reg.email) return res.status(400).json({ error: 'This registration has no email on file.' });
  try {
    const settings = await getSettings();
    await sendRegistrationConfirmation(reg, reg.event, settings);
    await audit(req.user.id, 'registration.resend_email', reg.id, { email: reg.email });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/// Narrow, purpose-built search for the "link/combine" tools below — deliberately
/// not the fuller GET /users (owner-only, since that exposes the whole staff
/// roster) since this only needs to find an existing Telegram-linked account by
/// name or username, and staff below owner are allowed to use it.
adminRouter.get('/telegram-lookup', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const users = await prisma.user.findMany({
    where: {
      telegramId: { not: null },
      OR: [
        { displayName: { contains: q, mode: 'insensitive' } },
        { telegramUsername: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 8,
  });
  res.json(users.map((u) => ({ id: u.id, displayName: u.displayName, telegramUsername: u.telegramUsername, telegramId: u.telegramId })));
});

/// Manually attach a Telegram identity to a registration's account — same
/// empty-shell-vs-real-conflict handling as the self-service code flow (see
/// linkTelegramIdentity), just admin-initiated and by search instead of a code.
adminRouter.patch('/registrations/:code/telegram', async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: { user: true } });
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  const telegramId = String(req.body.telegramId || '').trim();
  if (!telegramId) return res.status(400).json({ error: 'Choose a Telegram account.' });
  try {
    const user = await linkTelegramIdentity(reg.user, telegramId);
    await audit(req.user.id, 'registration.link_telegram', reg.id, { telegramId });
    res.json(publicUser(user));
  } catch (e) {
    if (e instanceof TelegramLinkError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

/// Combines two registrations that turned out to be the same person under
/// two different accounts (one web, one Telegram, say) — cancels the
/// duplicate rather than deleting it, and copies over whichever of
/// telegramId/telegramUsername/email the keeper's account is missing. Any
/// *other* registrations the dropped account had (different events) move
/// over too, except ones that would collide with a registration the keeper
/// already has for that event — those are left alone and reported back
/// rather than silently dropped.
adminRouter.post('/registrations/combine', async (req, res) => {
  const { keepCode, dropCode } = req.body || {};
  const [keep, drop] = await Promise.all([
    prisma.registration.findUnique({ where: { code: keepCode }, include: { user: true } }),
    prisma.registration.findUnique({ where: { code: dropCode }, include: { user: true } }),
  ]);
  if (!keep || !drop) return res.status(404).json({ error: 'Registration not found.' });
  if (keep.eventId !== drop.eventId) return res.status(400).json({ error: 'Registrations must be for the same event.' });
  if (keep.userId === drop.userId) return res.status(400).json({ error: 'These are already the same account.' });

  const adoptTelegram = !keep.user.telegramId && drop.user.telegramId;
  const patch = {};
  if (adoptTelegram) { patch.telegramId = drop.user.telegramId; patch.telegramUsername = drop.user.telegramUsername; }
  if (!keep.user.email && drop.user.email) patch.email = drop.user.email;

  await prisma.$transaction([
    prisma.registration.update({ where: { id: drop.id }, data: { status: 'CANCELLED' } }),
    // telegramId is @unique — the old holder has to be cleared in the same
    // transaction before the keeper can take it.
    ...(adoptTelegram ? [prisma.user.update({ where: { id: drop.userId }, data: { telegramId: null, telegramUsername: null } })] : []),
    prisma.user.update({ where: { id: keep.userId }, data: patch }),
  ]);

  const others = await prisma.registration.findMany({ where: { userId: drop.userId, id: { not: drop.id } } });
  const skipped = [];
  for (const other of others) {
    const collision = await prisma.registration.findUnique({ where: { eventId_userId: { eventId: other.eventId, userId: keep.userId } } });
    if (collision) { skipped.push(other.code); continue; }
    await prisma.registration.update({ where: { id: other.id }, data: { userId: keep.userId } });
  }

  await audit(req.user.id, 'registration.combine', keep.id, { keptCode: keep.code, droppedCode: drop.code, skipped });
  res.json({ ok: true, skipped });
});

/* ---------------- merch ---------------- */

/// Methods staff can record by hand (merch, donations, tickets at the door).
const PAYMENT_METHODS = STAFF_PAYMENT_METHODS;
/// Everything that can show up in the money totals — Stripe on top of those.
const ALL_PAYMENT_METHODS = [...STAFF_PAYMENT_METHODS, 'STRIPE'];
class MerchError extends Error {}

adminRouter.get('/events/:id/merch', async (req, res) => {
  const items = await prisma.merchItem.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'asc' } });
  const sales = await prisma.sale.findMany({
    where: { item: { eventId: req.params.id } },
    include: { item: true, processedBy: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const donations = await prisma.donation.findMany({
    where: { eventId: req.params.id },
    include: { processedBy: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const orders = await prisma.merchOrder.findMany({
    where: { eventId: req.params.id, status: { in: ['PAID', 'REFUNDED'] } },
    include: { items: true, payments: true, user: true },
    orderBy: [{ pickedUpAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
  const revenueTotal = sales.reduce((sum, s) => sum + (s.item.price || 0) * s.quantity, 0);
  const donationsTotal = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({
    stripe: stripeEnabled(),
    preorders: orders.map(shapeOrder),
    preorderTotal: orders.filter((o) => o.status === 'PAID').reduce((sum, o) => sum + o.totalCents, 0) / 100,
    items: items.map((i) => ({ ...i, remaining: Math.max(i.maxCount - i.soldCount, 0) })),
    sales: sales.map((s) => ({
      id: s.id, itemId: s.itemId, itemName: s.item.name, quantity: s.quantity,
      paymentMethod: s.paymentMethod, paymentNote: s.paymentNote,
      processedByName: s.processedBy.displayName, createdAt: s.createdAt,
    })),
    donations: donations.map((d) => ({
      id: d.id, amount: d.amount, paymentMethod: d.paymentMethod, note: d.note,
      processedByName: d.processedBy.displayName, createdAt: d.createdAt,
    })),
    revenueTotal,
    donationsTotal,
  });
});

/// A donation taken in person at the table, not tied to a merch item or an
/// event registration — e.g. a walk-up donation box. Rolls into the Cash
/// reconciliation totals alongside ticket payments.
adminRouter.post('/events/:id/donations', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const amount = Number(req.body.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  if (!PAYMENT_METHODS.includes(req.body.paymentMethod)) return res.status(400).json({ error: 'Choose a payment method.' });
  const donation = await prisma.donation.create({
    data: {
      eventId: event.id, amount, paymentMethod: req.body.paymentMethod,
      note: req.body.note?.trim() || null, processedById: req.user.id,
    },
    include: { processedBy: true },
  });
  await audit(req.user.id, 'donation.create', donation.id, { amount, paymentMethod: donation.paymentMethod });
  res.json({
    id: donation.id, amount: donation.amount, paymentMethod: donation.paymentMethod,
    note: donation.note, processedByName: donation.processedBy.displayName, createdAt: donation.createdAt,
  });
});

/// Undoes a mistaken entry, mirroring /merch/sales/:id.
adminRouter.delete('/donations/:id', async (req, res) => {
  const donation = await prisma.donation.findUnique({ where: { id: req.params.id } });
  if (!donation) return res.status(404).json({ error: 'Donation not found.' });
  await prisma.donation.delete({ where: { id: donation.id } });
  await audit(req.user.id, 'donation.undo', donation.id, { amount: donation.amount });
  res.json({ ok: true });
});

adminRouter.post('/events/:id/merch', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const { name, price, maxCount, preorder } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give the item a name.' });
  const max = Number(maxCount);
  if (!Number.isInteger(max) || max < 0) return res.status(400).json({ error: 'Max count must be a whole number, zero or more.' });
  const item = await prisma.merchItem.create({
    data: { eventId: req.params.id, name: String(name).trim(), price: price != null && price !== '' ? Number(price) : null, maxCount: max, preorder: Boolean(preorder) },
  });
  await audit(req.user.id, 'merch.create', item.id, { name: item.name, maxCount: item.maxCount });
  res.json({ ...item, remaining: item.maxCount });
});

adminRouter.patch('/merch/:id', async (req, res) => {
  const item = await prisma.merchItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const data = {};
  if (req.body.name !== undefined) data.name = String(req.body.name).trim();
  if (req.body.price !== undefined) data.price = req.body.price !== '' && req.body.price !== null ? Number(req.body.price) : null;
  if (req.body.preorder !== undefined) data.preorder = Boolean(req.body.preorder);
  if (req.body.maxCount !== undefined) {
    const max = Number(req.body.maxCount);
    if (!Number.isInteger(max) || max < item.soldCount)
      return res.status(400).json({ error: `Max count cannot be below the ${item.soldCount} already sold.` });
    data.maxCount = max;
  }
  const updated = await prisma.merchItem.update({ where: { id: item.id }, data });
  await audit(req.user.id, 'merch.update', item.id, data);
  res.json({ ...updated, remaining: Math.max(updated.maxCount - updated.soldCount, 0) });
});

adminRouter.get('/registrations/:code/receipt', async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code }, include: RECEIPT_INCLUDE });
  if (!reg) return res.status(404).send('Registration not found.');
  res.type('html').send(ticketReceipt(reg, await getSettings()));
});

adminRouter.get('/merch-orders/:id/receipt', async (req, res) => {
  const order = await prisma.merchOrder.findUnique({ where: { id: req.params.id }, include: { event: true, user: true, items: true, payments: true } });
  if (!order) return res.status(404).send('Order not found.');
  res.type('html').send(orderReceipt(order, await getSettings()));
});

/// "Tell buyers it's ready": messages every paid, uncollected pre-order
/// that hasn't been told yet.
adminRouter.post('/events/:id/merch-orders/notify-ready', async (req, res) => {
  const { notifyPreordersReady } = await import('../lib/reminders.js');
  const sent = await notifyPreordersReady(req.params.id);
  await audit(req.user.id, 'merch_order.notify_ready', req.params.id, { sent });
  res.json({ sent });
});

/// Hands over (or un-hands) a paid pre-order at the merch table.
adminRouter.post('/merch-orders/:id/pickup', async (req, res) => {
  const order = await prisma.merchOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'PAID') return res.status(400).json({ error: 'Only paid orders can be picked up.' });
  const pickedUp = req.body?.pickedUp !== false;
  const updated = await prisma.merchOrder.update({
    where: { id: order.id },
    data: pickedUp ? { pickedUpAt: new Date(), pickedUpById: req.user.id } : { pickedUpAt: null, pickedUpById: null },
    include: { items: true, payments: true, user: true },
  });
  await audit(req.user.id, pickedUp ? 'merch_order.pickup' : 'merch_order.pickup_undo', order.id, {});
  res.json(shapeOrder(updated));
});

adminRouter.delete('/merch/:id', async (req, res) => {
  const item = await prisma.merchItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  if (item.soldCount > 0) return res.status(400).json({ error: 'This item has sales, so it cannot be deleted.' });
  await prisma.merchItem.delete({ where: { id: item.id } });
  await audit(req.user.id, 'merch.delete', item.id, { name: item.name });
  res.json({ ok: true });
});

/// Compare-and-swap stock check so concurrent sales at the table can never
/// oversell past maxCount, without needing a serializable transaction.
adminRouter.post('/merch/:id/sale', async (req, res) => {
  const quantity = req.body.quantity === undefined ? 1 : Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: 'Quantity must be a positive whole number.' });
  if (!PAYMENT_METHODS.includes(req.body.paymentMethod)) return res.status(400).json({ error: 'Choose a payment method.' });

  try {
    const sale = await prisma.$transaction(async (tx) => {
      const item = await tx.merchItem.findUnique({ where: { id: req.params.id } });
      if (!item) throw new MerchError('Item not found.');
      const result = await tx.merchItem.updateMany({
        where: { id: item.id, soldCount: { lte: item.maxCount - quantity } },
        data: { soldCount: { increment: quantity } },
      });
      if (result.count === 0) throw new MerchError('Not enough stock left.');
      return tx.sale.create({
        data: {
          itemId: item.id, quantity,
          paymentMethod: req.body.paymentMethod,
          paymentNote: req.body.paymentNote?.trim() || null,
          processedById: req.user.id,
        },
      });
    });
    await audit(req.user.id, 'merch.sale', sale.id, { itemId: sale.itemId, quantity: sale.quantity });
    res.json(sale);
  } catch (e) {
    if (e instanceof MerchError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/// Undoes a mistaken entry at the table — restocks the item and removes the
/// sale, mirroring the existing /checkin/:code/undo pattern.
adminRouter.delete('/merch/sales/:id', async (req, res) => {
  const sale = await prisma.sale.findUnique({ where: { id: req.params.id } });
  if (!sale) return res.status(404).json({ error: 'Sale not found.' });
  await prisma.$transaction([
    prisma.merchItem.update({ where: { id: sale.itemId }, data: { soldCount: { decrement: sale.quantity } } }),
    prisma.sale.delete({ where: { id: sale.id } }),
  ]);
  await audit(req.user.id, 'merch.sale.undo', sale.id, { itemId: sale.itemId, quantity: sale.quantity });
  res.json({ ok: true });
});

/// A payment's money net of refunds, split into ticket and donation add-on.
/// Refunds come off the ticket part first.
function splitPayment(p) {
  const net = p.amountCents - p.amountRefundedCents;
  const donation = Math.min(p.donationCents || 0, Math.max(net, 0));
  return { net, donation, ticket: net - donation };
}

const SETTLED = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const eventPayments = (eventId, include) => prisma.payment.findMany({
  where: { status: { in: SETTLED }, OR: [{ registration: { eventId } }, { merchOrder: { eventId } }] },
  include,
});

/// Combines every place money gets recorded — ticket payments (Stripe and
/// in-person), donations (the online add-on and in person), and merch (table
/// sales and online pre-orders) — into one end-of-shift total, broken out by
/// payment method, net of refunds. Stripe also gets gross / fees / net, since
/// that's what actually lands in the bank. Registrations on a paid tier that
/// still owe money are called out separately, not counted.
adminRouter.get('/events/:id/reconciliation', async (req, res) => {
  const eventId = req.params.id;
  const [payments, sales, donationEntries, owing] = await Promise.all([
    eventPayments(eventId),
    prisma.sale.findMany({ where: { item: { eventId } }, include: { item: true } }),
    prisma.donation.findMany({ where: { eventId } }),
    prisma.registration.findMany({
      where: { eventId, status: { in: ['CONFIRMED', 'WAITLIST'] }, ticketTier: { priceCents: { gt: 0 } } },
      include: REG_INCLUDE,
    }),
  ]);

  const byMethod = () => Object.fromEntries(ALL_PAYMENT_METHODS.map((m) => [m, { count: 0, total: 0 }]));
  const sumTotals = (obj) => Object.values(obj).reduce((sum, m) => sum + m.total, 0);
  const tickets = byMethod();
  const donations = byMethod();
  const merch = byMethod();

  const stripe = { count: 0, grossCents: 0, refundedCents: 0, feeCents: 0, netCents: 0, missingFees: 0 };
  for (const p of payments) {
    const { ticket, donation, net } = splitPayment(p);
    if (p.merchOrderId) {
      merch[p.method].count++;
      merch[p.method].total += net / 100;
    } else {
      tickets[p.method].count++;
      tickets[p.method].total += ticket / 100;
      if (donation) {
        donations[p.method].count++;
        donations[p.method].total += donation / 100;
      }
    }
    if (p.method === 'STRIPE') {
      stripe.count++;
      stripe.grossCents += p.amountCents;
      stripe.refundedCents += p.amountRefundedCents;
      if (p.feeCents == null) stripe.missingFees++;
      else stripe.feeCents += p.feeCents;
    }
  }
  // Stripe keeps its fee on a refunded charge, so the payout is gross minus
  // fees minus whatever went back to the buyer.
  stripe.netCents = stripe.grossCents - stripe.feeCents - stripe.refundedCents;

  for (const d of donationEntries) {
    donations[d.paymentMethod].count++;
    donations[d.paymentMethod].total += d.amount;
  }
  for (const s of sales) {
    merch[s.paymentMethod].count += s.quantity;
    merch[s.paymentMethod].total += (s.item.price || 0) * s.quantity;
  }

  const unpaid = owing.map(shapeReg).filter((r) => r.balanceDueCents > 0);
  const ticketsTotal = sumTotals(tickets);
  const donationsTotal = sumTotals(donations);
  const merchTotal = sumTotals(merch);
  res.json({
    methods: ALL_PAYMENT_METHODS,
    tickets, donations, merch, stripe,
    unpaidTickets: unpaid.length,
    unpaidTotal: unpaid.reduce((sum, r) => sum + r.balanceDueCents, 0) / 100,
    ticketsTotal, donationsTotal, merchTotal,
    grandTotal: ticketsTotal + donationsTotal + merchTotal,
  });
});

/// Full sales log, not just the last 100 shown on screen.
adminRouter.get('/events/:id/merch.csv', async (req, res) => {
  const sales = await prisma.sale.findMany({
    where: { item: { eventId: req.params.id } },
    include: { item: true, processedBy: true },
    orderBy: { createdAt: 'asc' },
  });
  const keys = ['createdAt', 'item', 'quantity', 'total', 'paymentMethod', 'paymentNote', 'processedBy'];
  const rows = sales.map((s) => keys.map((k) => csv({
    createdAt: s.createdAt.toISOString(),
    item: s.item.name,
    quantity: s.quantity,
    total: ((s.item.price || 0) * s.quantity).toFixed(2),
    paymentMethod: s.paymentMethod,
    paymentNote: s.paymentNote,
    processedBy: s.processedBy.displayName,
  }[k])).join(','));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="merch.csv"').send([keys.join(','), ...rows].join('\n'));
});

/// One combined ledger of every place money got recorded for this event —
/// ticket payments, merch sales, and in-person donations — for end-of-event
/// bookkeeping. The on-screen reconciliation view only shows totals by
/// method; this is the transaction-level detail behind them.
adminRouter.get('/events/:id/reconciliation.csv', async (req, res) => {
  const eventId = req.params.id;
  const [payments, sales, donationEntries] = await Promise.all([
    eventPayments(eventId, { registration: true, merchOrder: { include: { items: true, user: true } }, processedBy: true }),
    prisma.sale.findMany({ where: { item: { eventId } }, include: { item: true, processedBy: true } }),
    prisma.donation.findMany({ where: { eventId }, include: { processedBy: true } }),
  ]);

  const rows = [];
  for (const p of payments) {
    const { ticket, donation, net } = splitPayment(p);
    const note = [
      p.note,
      p.amountRefundedCents ? `refunded ${(p.amountRefundedCents / 100).toFixed(2)}` : '',
      p.feeCents != null ? `Stripe fee ${(p.feeCents / 100).toFixed(2)}` : '',
    ].filter(Boolean).join('; ');
    const base = { createdAt: p.paidAt || p.createdAt, paymentMethod: p.method, note, processedBy: p.processedBy?.displayName || '' };
    if (p.merchOrderId) {
      const o = p.merchOrder;
      rows.push({ ...base, type: 'Merch pre-order', description: `${o.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')}: ${o.user.displayName}`, amount: net / 100 });
      continue;
    }
    const who = `${p.registration.legalName} (${p.registration.code})`;
    rows.push({ ...base, type: 'Ticket', description: `${p.registration.tierName || 'Ticket'}: ${who}`, amount: ticket / 100 });
    if (donation) rows.push({ ...base, type: 'Donation', description: `Online donation: ${who}`, amount: donation / 100, note: '' });
  }
  rows.push(
    ...sales.map((s) => ({
      createdAt: s.createdAt, type: 'Merch', description: `${s.quantity} x ${s.item.name}`,
      amount: (s.item.price || 0) * s.quantity, paymentMethod: s.paymentMethod, note: s.paymentNote || '', processedBy: s.processedBy.displayName,
    })),
    ...donationEntries.map((d) => ({
      createdAt: d.createdAt, type: 'Donation', description: 'In-person donation',
      amount: d.amount, paymentMethod: d.paymentMethod, note: d.note || '', processedBy: d.processedBy.displayName,
    })),
  );
  rows.sort((a, b) => a.createdAt - b.createdAt);

  const keys = ['createdAt', 'type', 'description', 'amount', 'paymentMethod', 'note', 'processedBy'];
  const csvRows = rows.map((r) => keys.map((k) => csv(k === 'createdAt' ? r.createdAt.toISOString() : k === 'amount' ? r.amount.toFixed(2) : r[k])).join(','));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="cash.csv"').send([keys.join(','), ...csvRows].join('\n'));
});

/* ---------------- vouchers ---------------- */

adminRouter.get('/events/:id/vouchers', async (req, res) => {
  const vouchers = await prisma.voucherCode.findMany({
    where: { eventId: req.params.id },
    include: { redemptions: { select: { code: true, legalName: true, fursonaName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(vouchers.map((v) => ({ ...v, remaining: Math.max(v.maxUses - v.usedCount, 0) })));
});

/// A handout sheet for staff: codes and their badge tier, ready to give to
/// organizers/photographers ahead of time instead of reading them off a screen.
adminRouter.get('/events/:id/vouchers.csv', async (req, res) => {
  const vouchers = await prisma.voucherCode.findMany({
    where: { eventId: req.params.id },
    include: { redemptions: { select: { legalName: true, fursonaName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const keys = ['code', 'badgeTier', 'maxUses', 'usedCount', 'redeemedBy'];
  const rows = vouchers.map((v) => keys.map((k) => csv(
    k === 'redeemedBy' ? v.redemptions.map((r) => r.fursonaName || r.legalName).join('; ') : v[k],
  )).join(','));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="vouchers.csv"').send([keys.join(','), ...rows].join('\n'));
});

adminRouter.post('/events/:id/vouchers', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const badgeTier = String(req.body.badgeTier || '').trim();
  if (!badgeTier) return res.status(400).json({ error: 'Give the voucher a badge tier label, e.g. "Organizer".' });
  const maxUses = req.body.maxUses === undefined ? 1 : Number(req.body.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 1) return res.status(400).json({ error: 'Max uses must be a positive whole number.' });
  const code = req.body.code ? String(req.body.code).trim().toUpperCase() : ticketCode();

  try {
    const voucher = await prisma.voucherCode.create({
      data: { eventId: event.id, code, badgeTier, maxUses },
    });
    await audit(req.user.id, 'voucher.create', voucher.id, { code: voucher.code, badgeTier });
    res.json({ ...voucher, remaining: voucher.maxUses, redemptions: [] });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'That code is already in use.' });
    throw e;
  }
});

adminRouter.patch('/vouchers/:id', async (req, res) => {
  const voucher = await prisma.voucherCode.findUnique({ where: { id: req.params.id } });
  if (!voucher) return res.status(404).json({ error: 'Voucher not found.' });
  const data = {};
  if (req.body.badgeTier !== undefined) {
    const badgeTier = String(req.body.badgeTier).trim();
    if (!badgeTier) return res.status(400).json({ error: 'Badge tier cannot be empty.' });
    data.badgeTier = badgeTier;
  }
  if (req.body.code !== undefined) data.code = String(req.body.code).trim().toUpperCase();
  if (req.body.maxUses !== undefined) {
    const maxUses = Number(req.body.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < voucher.usedCount)
      return res.status(400).json({ error: `Max uses cannot be below the ${voucher.usedCount} already used.` });
    data.maxUses = maxUses;
  }
  try {
    const updated = await prisma.voucherCode.update({ where: { id: voucher.id }, data });
    await audit(req.user.id, 'voucher.update', voucher.id, data);
    res.json({ ...updated, remaining: Math.max(updated.maxUses - updated.usedCount, 0) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'That code is already in use.' });
    throw e;
  }
});

adminRouter.delete('/vouchers/:id', async (req, res) => {
  const voucher = await prisma.voucherCode.findUnique({ where: { id: req.params.id } });
  if (!voucher) return res.status(404).json({ error: 'Voucher not found.' });
  await prisma.voucherCode.delete({ where: { id: voucher.id } });
  await audit(req.user.id, 'voucher.delete', voucher.id, { code: voucher.code });
  res.json({ ok: true });
});

/* ---------------- volunteers ---------------- */

/// Staff adding someone to a shift or a room: by ticket code, or by
/// Telegram @handle for people who never bought a ticket.
async function findPerson(raw) {
  const who = String(raw || '').trim();
  if (!who) return { status: 400, error: 'Enter a ticket code or a Telegram @username.' };
  if (who.startsWith('@')) {
    const user = await prisma.user.findFirst({ where: { telegramUsername: { equals: normHandle(who), mode: 'insensitive' } } });
    return user ? { user } : { status: 404, error: 'Nobody with that Telegram username has signed in here yet.' };
  }
  const reg = await prisma.registration.findUnique({ where: { code: who.toUpperCase() }, include: { user: true } });
  return reg ? { user: reg.user, registration: reg } : { status: 404, error: 'No ticket matches that code.' };
}

const SIGNUP_INCLUDE = { user: true, markedBy: { select: { displayName: true } } };

const shiftTime = (shift, event) => `${formatInTimeZone(shift.startsAt, event.timezone)} to ${formatInTimeZone(shift.endsAt, event.timezone)}`;

function shapeSignup(s) {
  return {
    id: s.id, note: s.note, attendance: s.attendance, source: s.source, createdAt: s.createdAt,
    markedAt: s.markedAt, markedBy: s.markedBy?.displayName ?? null,
    volunteer: shapeVolunteer(s.user),
  };
}

/// Per-person totals across the event: hours scheduled, hours worked (shifts
/// marked present), and no-shows — what a coordinator needs for thank-yous
/// or perks like "4+ hours gets a free shirt".
function volunteerTotals(shifts) {
  const people = new Map();
  for (const shift of shifts) {
    const hours = shiftHours(shift);
    for (const s of shift.signups) {
      const p = people.get(s.user.id) || { ...shapeVolunteer(s.user), shifts: 0, hoursScheduled: 0, hoursWorked: 0, noShows: 0 };
      p.shifts += 1;
      p.hoursScheduled += hours;
      if (s.attendance === 'PRESENT') p.hoursWorked += hours;
      if (s.attendance === 'NO_SHOW') p.noShows += 1;
      people.set(s.user.id, p);
    }
  }
  return [...people.values()].sort((a, b) => b.hoursScheduled - a.hoursScheduled || a.name.localeCompare(b.name));
}

const eventShifts = (eventId) => prisma.volunteerShift.findMany({
  where: { eventId },
  include: { signups: { include: SIGNUP_INCLUDE, orderBy: { createdAt: 'asc' } } },
  orderBy: [{ startsAt: 'asc' }, { role: 'asc' }],
});

adminRouter.get('/events/:id/volunteers', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const shifts = await eventShifts(event.id);
  res.json({
    enabled: event.volunteersEnabled,
    info: event.volunteerInfo,
    shifts: shifts.map(({ signups, ...s }) => ({
      ...s, hours: shiftHours(s), remaining: Math.max(s.slots - s.filledCount, 0), signups: signups.map(shapeSignup),
    })),
    volunteers: volunteerTotals(shifts),
  });
});

/// The roster as a sheet, one row per sign-up — for printing a clipboard
/// copy or sending to a volunteer lead.
adminRouter.get('/events/:id/volunteers.csv', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const shifts = await eventShifts(event.id);
  const keys = ['role', 'startsAt', 'endsAt', 'location', 'hours', 'name', 'legalName', 'email', 'telegram', 'attendance', 'note'];
  const rows = shifts.flatMap((shift) => shift.signups.map((s) => [
    shift.role, formatInTimeZone(shift.startsAt, event.timezone), formatInTimeZone(shift.endsAt, event.timezone),
    shift.location, shiftHours(shift).toFixed(2), s.user.fursonaName || s.user.displayName, s.user.legalName,
    s.user.email, s.user.telegramUsername ? `@${s.user.telegramUsername}` : '', s.attendance, s.note,
  ].map(csv).join(',')));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="volunteers.csv"').send([keys.join(','), ...rows].join('\n'));
});

/// Setting up shifts is event configuration, so owner-only like the rest of
/// it. Running the roster on the day (adding, removing, attendance) is open
/// to admins.
adminRouter.post('/events/:id/shifts', requireOwner, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  try {
    const data = shiftPayload(req.body || {}, (v) => zonedTimeToUtc(v, event.timezone));
    const shift = await prisma.volunteerShift.create({ data: { ...data, eventId: event.id } });
    await audit(req.user.id, 'volunteer.shift.create', shift.id, { role: shift.role });
    res.json(shift);
  } catch (e) {
    if (e instanceof VolunteerError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

adminRouter.patch('/shifts/:id', requireOwner, async (req, res) => {
  const shift = await prisma.volunteerShift.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  try {
    const data = shiftPayload(req.body || {}, (v) => zonedTimeToUtc(v, shift.event.timezone), shift);
    // Lowering slots is checked against filledCount inside the update, so a
    // sign-up landing between the read and the write can't end up over the limit.
    const where = data.slots !== undefined ? { id: shift.id, filledCount: { lte: data.slots } } : { id: shift.id };
    const { count } = await prisma.volunteerShift.updateMany({ where, data });
    if (!count) throw new VolunteerError('More people signed up in the meantime. Reload and try again.');
    await audit(req.user.id, 'volunteer.shift.update', shift.id, data);
    res.json(await prisma.volunteerShift.findUnique({ where: { id: shift.id } }));
  } catch (e) {
    if (e instanceof VolunteerError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/// Only empty shifts can be deleted, so nobody silently loses a shift they
/// signed up for. Remove the volunteers first (each one gets told).
adminRouter.delete('/shifts/:id', requireOwner, async (req, res) => {
  const shift = await prisma.volunteerShift.findUnique({ where: { id: req.params.id } });
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  const { count } = await prisma.volunteerShift.deleteMany({ where: { id: shift.id, filledCount: 0 } });
  if (!count) return res.status(400).json({ error: 'People are signed up for this shift. Remove them first.' });
  await audit(req.user.id, 'volunteer.shift.delete', shift.id, { role: shift.role });
  res.json({ ok: true });
});

/// Puts someone on a shift by their ticket code or Telegram @handle — for
/// the person who asked at the desk instead of on the site.
adminRouter.post('/shifts/:id/signups', async (req, res) => {
  const shift = await prisma.volunteerShift.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  const found = await findPerson(req.body?.who);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const { user } = found;

  try {
    const signup = await signUpForShift({ shiftId: shift.id, userId: user.id, note: req.body?.note, source: 'admin', byStaff: true });
    await audit(req.user.id, 'volunteer.add', signup.id, { shiftId: shift.id, userId: user.id });
    notifyUser(user.telegramId, `You're on the ${shift.role} volunteer shift at ${shift.event.title}, ${shiftTime(shift, shift.event)}. Thank you!`);
    const full = await prisma.volunteerSignup.findUnique({ where: { id: signup.id }, include: SIGNUP_INCLUDE });
    res.json(shapeSignup(full));
  } catch (e) {
    if (e instanceof VolunteerError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

adminRouter.patch('/volunteer-signups/:id', async (req, res) => {
  const attendance = req.body?.attendance;
  if (!ATTENDANCE.includes(attendance)) return res.status(400).json({ error: 'Unknown attendance value.' });
  const signup = await prisma.volunteerSignup.findUnique({ where: { id: req.params.id } });
  if (!signup) return res.status(404).json({ error: 'Sign-up not found.' });
  const updated = await prisma.volunteerSignup.update({
    where: { id: signup.id },
    data: attendance === 'PENDING'
      ? { attendance, markedAt: null, markedById: null }
      : { attendance, markedAt: new Date(), markedById: req.user.id },
    include: SIGNUP_INCLUDE,
  });
  await audit(req.user.id, 'volunteer.attendance', signup.id, { attendance });
  res.json(shapeSignup(updated));
});

adminRouter.delete('/volunteer-signups/:id', async (req, res) => {
  const signup = await prisma.volunteerSignup.findUnique({ where: { id: req.params.id }, include: { user: true, shift: { include: { event: true } } } });
  if (!signup) return res.status(404).json({ error: 'Sign-up not found.' });
  await dropSignup(signup);
  await audit(req.user.id, 'volunteer.remove', signup.id, { shiftId: signup.shiftId, userId: signup.userId });
  const { shift } = signup;
  notifyUser(signup.user.telegramId, `The organizers took you off the ${shift.role} volunteer shift at ${shift.event.title} (${shiftTime(shift, shift.event)}). Reach out to them if that's unexpected.`);
  res.json({ ok: true });
});

/* ---------------- hotels ---------------- */

/// Room news matters enough to send on every channel the person has.
/// Best-effort: a missing SMTP config or a blocked bot never fails the request.
async function notifyPerson(user, subject, text) {
  await notifyUser(user.telegramId, text);
  if (user.email && env.smtp.enabled) {
    await sendNoticeEmail(user.email, subject, `${text}\n\n${env.webUrl}/tickets`).catch((e) => console.error('hotel notice email failed', user.id, e.message));
  }
}

const hotelError = (res, e) => {
  if (e instanceof HotelError) return res.status(400).json({ error: e.message });
  throw e;
};

function shapeReservation(r) {
  return {
    id: r.id, status: r.status, guestName: r.guestName, roommates: r.roommates, guests: r.guests,
    checkIn: r.checkIn, checkOut: r.checkOut, nights: nightsBetween(r.checkIn, r.checkOut).length,
    confirmationNumber: r.confirmationNumber, note: r.note, staffNote: r.staffNote, source: r.source,
    createdAt: r.createdAt, cancelledAt: r.cancelledAt,
    person: shapeVolunteer(r.user),
  };
}

const ADMIN_RESERVATION_INCLUDE = { user: true, block: { include: { hotel: { include: { event: true } } } } };

adminRouter.get('/events/:id/hotels', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const hotels = await prisma.hotel.findMany({
    where: { eventId: event.id },
    include: {
      blocks: {
        include: {
          nights: { orderBy: { night: 'asc' } },
          reservations: { include: { user: true }, orderBy: [{ checkIn: 'asc' }, { createdAt: 'asc' }] },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json({
    enabled: event.hotelsEnabled,
    info: event.hotelInfo,
    hotels: hotels.map((h) => ({
      ...h,
      blocks: h.blocks.map(({ reservations, nights, ...b }) => ({
        ...b, ...blockTotals({ ...b, nights }), reservations: reservations.map(shapeReservation),
      })),
    })),
  });
});

/// What the hotel needs to load the block: one row per live room.
adminRouter.get('/room-blocks/:id/rooming-list.csv', async (req, res) => {
  const block = await prisma.roomBlock.findUnique({
    where: { id: req.params.id },
    include: { hotel: true, reservations: { where: { status: { in: LIVE } }, include: { user: true }, orderBy: [{ checkIn: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!block) return res.status(404).json({ error: 'Room block not found.' });
  const keys = ['guestName', 'checkIn', 'checkOut', 'nights', 'guests', 'roommates', 'roomType', 'status', 'confirmationNumber', 'email', 'note'];
  const rows = block.reservations.map((r) => [
    r.guestName, r.checkIn, r.checkOut, nightsBetween(r.checkIn, r.checkOut).length, r.guests, r.roommates,
    block.name, r.status, r.confirmationNumber, r.user.email, r.note,
  ].map(csv).join(','));
  const file = `rooming-list-${block.hotel.name}-${block.name}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  res.type('text/csv').set('Content-Disposition', `attachment; filename="${file}.csv"`).send([keys.join(','), ...rows].join('\n'));
});

/// Hotels and blocks are contract terms, so setting them up is owner-only.
/// Working the requests (confirming, changing dates, cancelling, adding
/// someone) is open to admins.
adminRouter.post('/events/:id/hotels', requireOwner, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  try {
    const hotel = await prisma.hotel.create({ data: { ...hotelPayload(req.body || {}), eventId: event.id } });
    await audit(req.user.id, 'hotel.create', hotel.id, { name: hotel.name });
    res.json(hotel);
  } catch (e) { hotelError(res, e); }
});

adminRouter.patch('/hotels/:id', requireOwner, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { id: req.params.id } });
  if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
  try {
    const data = hotelPayload(req.body || {}, hotel);
    const updated = await prisma.hotel.update({ where: { id: hotel.id }, data });
    await audit(req.user.id, 'hotel.update', hotel.id, data);
    res.json(updated);
  } catch (e) { hotelError(res, e); }
});

adminRouter.delete('/hotels/:id', requireOwner, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { id: req.params.id } });
  if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
  const live = await prisma.roomReservation.count({ where: { status: { in: LIVE }, block: { hotelId: hotel.id } } });
  if (live) return res.status(400).json({ error: `${live} room request${live === 1 ? ' is' : 's are'} still live at this hotel. Cancel them first.` });
  await prisma.hotel.delete({ where: { id: hotel.id } });
  await audit(req.user.id, 'hotel.delete', hotel.id, { name: hotel.name });
  res.json({ ok: true });
});

adminRouter.post('/hotels/:id/blocks', requireOwner, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
  try {
    const data = blockPayload(req.body || {}, (v) => zonedTimeToUtc(v, hotel.event.timezone));
    const block = await prisma.roomBlock.create({ data: { ...data, hotelId: hotel.id } });
    if (req.body?.nights) await setNights(block.id, req.body.nights);
    await audit(req.user.id, 'hotel.block.create', block.id, { hotelId: hotel.id, name: block.name });
    res.json(block);
  } catch (e) { hotelError(res, e); }
});

adminRouter.patch('/room-blocks/:id', requireOwner, async (req, res) => {
  const block = await prisma.roomBlock.findUnique({ where: { id: req.params.id }, include: { nights: true, hotel: { include: { event: true } } } });
  if (!block) return res.status(404).json({ error: 'Room block not found.' });
  try {
    const data = blockPayload(req.body || {}, (v) => zonedTimeToUtc(v, block.hotel.event.timezone), block);
    const updated = await prisma.roomBlock.update({ where: { id: block.id }, data });
    await audit(req.user.id, 'hotel.block.update', block.id, data);
    res.json(updated);
  } catch (e) { hotelError(res, e); }
});

/// Replaces the per-night inventory: `{ nights: [{ night, contracted, reportedPickup }] }`.
adminRouter.put('/room-blocks/:id/nights', requireOwner, async (req, res) => {
  const block = await prisma.roomBlock.findUnique({ where: { id: req.params.id } });
  if (!block) return res.status(404).json({ error: 'Room block not found.' });
  try {
    await setNights(block.id, req.body?.nights);
    await audit(req.user.id, 'hotel.block.nights', block.id, { nights: req.body.nights.length });
    res.json(await prisma.roomBlockNight.findMany({ where: { blockId: block.id }, orderBy: { night: 'asc' } }));
  } catch (e) { hotelError(res, e); }
});

adminRouter.delete('/room-blocks/:id', requireOwner, async (req, res) => {
  const block = await prisma.roomBlock.findUnique({ where: { id: req.params.id } });
  if (!block) return res.status(404).json({ error: 'Room block not found.' });
  const live = await prisma.roomReservation.count({ where: { blockId: block.id, status: { in: LIVE } } });
  if (live) return res.status(400).json({ error: `${live} room request${live === 1 ? ' is' : 's are'} still live in this block. Cancel them first.` });
  await prisma.roomBlock.delete({ where: { id: block.id } });
  await audit(req.user.id, 'hotel.block.delete', block.id, { name: block.name });
  res.json({ ok: true });
});

/// Books a room for someone by ticket code or @handle. Skips the one-room
/// limit and the cutoff (staff only do that with the hotel's agreement),
/// never the block's inventory.
adminRouter.post('/room-blocks/:id/reservations', async (req, res) => {
  const block = await prisma.roomBlock.findUnique({ where: { id: req.params.id }, include: { hotel: { include: { event: true } } } });
  if (!block) return res.status(404).json({ error: 'Room block not found.' });
  const found = await findPerson(req.body?.who);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const b = req.body;
  try {
    const r = await reserveRoom({
      blockId: block.id, userId: found.user.id, checkIn: b.checkIn, checkOut: b.checkOut, guests: b.guests,
      guestName: b.guestName || found.registration?.legalName || found.user.legalName,
      roommates: b.roommates, staffNote: b.staffNote, source: 'admin', byStaff: true,
    });
    await audit(req.user.id, 'hotel.add', r.id, { blockId: block.id, userId: found.user.id });
    await notifyPerson(found.user, `Room requested at ${block.hotel.name}`,
      `The organizers of ${block.hotel.event.title} requested a ${block.name} room for you at ${block.hotel.name}, ${r.checkIn} to ${r.checkOut}. You'll hear again once the hotel confirms it.`);
    res.json(shapeReservation(await prisma.roomReservation.findUnique({ where: { id: r.id }, include: { user: true } })));
  } catch (e) { hotelError(res, e); }
});

/// Working a request: hotel confirmation number (which confirms it), dates,
/// guest details, staff notes.
adminRouter.patch('/room-reservations/:id', async (req, res) => {
  const r = await prisma.roomReservation.findUnique({ where: { id: req.params.id }, include: ADMIN_RESERVATION_INCLUDE });
  if (!r) return res.status(404).json({ error: 'Room request not found.' });
  if (!LIVE.includes(r.status)) return res.status(400).json({ error: 'This room request was cancelled.' });
  const b = req.body || {};
  const data = {};
  try {
    if (b.guestName !== undefined) {
      data.guestName = String(b.guestName || '').trim().slice(0, 120);
      if (!data.guestName) throw new HotelError('The room needs a guest name.');
    }
    if (b.roommates !== undefined) data.roommates = String(b.roommates || '').trim().slice(0, 500);
    if (b.staffNote !== undefined) data.staffNote = String(b.staffNote || '').trim().slice(0, 500) || null;
    if (b.guests !== undefined) {
      const n = Number(b.guests);
      if (!Number.isInteger(n) || n < 1 || n > r.block.maxGuests) throw new HotelError(`A room here takes 1 to ${r.block.maxGuests} guests.`);
      data.guests = n;
    }
    if (b.confirmationNumber !== undefined) {
      data.confirmationNumber = String(b.confirmationNumber || '').trim().slice(0, 80) || null;
      // Entering the hotel's number is what confirming means; clearing it un-confirms.
      if (b.status === undefined) data.status = data.confirmationNumber ? 'CONFIRMED' : 'REQUESTED';
    }
    if (b.status !== undefined) {
      if (!LIVE.includes(b.status)) throw new HotelError('Use cancel to cancel a room request.');
      data.status = b.status;
    }
    if ((b.checkIn !== undefined || b.checkOut !== undefined) && (b.checkIn !== r.checkIn || b.checkOut !== r.checkOut)) {
      await changeStay(r, b.checkIn ?? r.checkIn, b.checkOut ?? r.checkOut);
    }
  } catch (e) { return hotelError(res, e); }

  const updated = await prisma.roomReservation.update({ where: { id: r.id }, data, include: { user: true } });
  await audit(req.user.id, 'hotel.update', r.id, { ...data, guestName: undefined, roommates: undefined, checkIn: b.checkIn, checkOut: b.checkOut });
  if (updated.status === 'CONFIRMED' && (r.status !== 'CONFIRMED' || (data.confirmationNumber && data.confirmationNumber !== r.confirmationNumber))) {
    const { hotel } = r.block;
    await notifyPerson(updated.user, `Your room at ${hotel.name} is confirmed`,
      `Your ${r.block.name} room at ${hotel.name} for ${hotel.event.title} is confirmed: ${updated.checkIn} to ${updated.checkOut}` +
      `${updated.confirmationNumber ? `, confirmation number ${updated.confirmationNumber}` : ''}.`);
  }
  res.json(shapeReservation(updated));
});

adminRouter.post('/room-reservations/:id/cancel', async (req, res) => {
  const r = await prisma.roomReservation.findUnique({ where: { id: req.params.id }, include: ADMIN_RESERVATION_INCLUDE });
  if (!r) return res.status(404).json({ error: 'Room request not found.' });
  if (!LIVE.includes(r.status)) return res.status(400).json({ error: 'This room request is already cancelled.' });
  await cancelReservation(r);
  await audit(req.user.id, 'hotel.cancel', r.id, { blockId: r.blockId, byStaff: true });
  const { hotel } = r.block;
  await notifyPerson(r.user, `Your room at ${hotel.name} was cancelled`,
    `The organizers of ${hotel.event.title} cancelled your ${r.block.name} room at ${hotel.name} (${r.checkIn} to ${r.checkOut}). Reach out to them if that's unexpected.`);
  res.json({ ok: true });
});

/* ---------------- check-in ---------------- */

/// Finds the ticket for whatever the scanner read: a full ticket URL, a bare
/// secret, a typed badge code, or an Aztec badge payload (`CODE|TIER|NAME`,
/// see `{{badge_payload}}` in render.js — only the leading code matters).
function scanLookup(value) {
  const primary = String(value || '').trim().split('|')[0].trim();
  const secret = primary.split('/').pop();
  return { OR: [{ secret }, { code: primary.toUpperCase() }] };
}

const scanReply = (reg, event, extra = {}) => ({
  registration: { ...shapeReg(reg), id: reg.id, event: summarize(event), telegram: reg.user?.telegramUsername, validDays: reg.ticketTier?.validDays || [] },
  ...extra,
});

/// One scan at the door. `direction` is ENTRY (default) or EXIT; `force`
/// lets staff admit someone past the day-pass or already-inside rule.
/// A rejected scan comes back as 409 with `code` and the registration, so
/// the scanner can show who it was and offer an override.
adminRouter.post('/checkin', async (req, res) => {
  const reg = await prisma.registration.findFirst({ where: scanLookup(req.body.value), include: { event: true, user: true, ...REG_INCLUDE } });
  if (!reg) return res.status(404).json({ error: 'No ticket matches that code.' });
  if (req.body.eventId && reg.eventId !== req.body.eventId)
    return res.status(409).json({ error: `That ticket is for ${reg.event.title}.`, code: 'wrong_event', ...scanReply(reg, reg.event) });
  const direction = req.body.direction || 'ENTRY';
  const firstVisit = !reg.checkedInAt;
  try {
    const { scan } = await recordScan({ registrationId: reg.id, direction, byId: req.user.id, force: Boolean(req.body.force) });
    if (scan.overridden) await audit(req.user.id, 'checkin.override', reg.id, { day: scan.day });
    const updated = await prisma.registration.findUnique({ where: { id: reg.id }, include: { user: true, ...REG_INCLUDE } });
    res.json({ ok: true, ...scanReply(updated, reg.event, { scan, firstVisit: direction === 'ENTRY' && firstVisit, today: await todayCounts(reg.event) }) });
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    res.status(409).json({ error: e.message, code: e.code, ...scanReply(reg, reg.event, { today: await todayCounts(reg.event) }) });
  }
});

/// Takes back the ticket's most recent scan (entry or exit).
adminRouter.post('/checkin/:code/undo', async (req, res) => {
  const reg = await prisma.registration.findUnique({ where: { code: req.params.code } });
  if (!reg) return res.status(404).json({ error: 'Ticket not found.' });
  const undone = await undoLastScan(reg.id);
  if (!undone) return res.status(400).json({ error: 'This ticket has no scans to undo.' });
  await audit(req.user.id, 'checkin.undo', reg.id, { direction: undone.direction, day: undone.day });
  res.json(shapeReg(await prisma.registration.findUnique({ where: { id: reg.id }, include: REG_INCLUDE })));
});

/// Everything a door scanner needs to keep working with no connection:
/// each ticket's status, day pass, and this event's scans. QR secrets are
/// only sent hashed, so a lost door laptop doesn't leak working tickets.
adminRouter.get('/events/:id/checkin-manifest', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const [regs, scans] = await Promise.all([
    prisma.registration.findMany({ where: { eventId: event.id }, include: { ticketTier: { select: { validDays: true } } } }),
    prisma.checkIn.findMany({ where: { eventId: event.id }, select: { registrationId: true, day: true, direction: true, at: true }, orderBy: { at: 'asc' } }),
  ]);
  const scansBy = {};
  for (const s of scans) (scansBy[s.registrationId] ||= []).push({ day: s.day, direction: s.direction, at: s.at });
  res.json({
    eventId: event.id, timezone: event.timezone, days: eventDays(event), occupancyLimit: event.occupancyLimit,
    generatedAt: new Date(),
    tickets: regs.map((r) => ({
      code: r.code, secretHash: hashSecret(r.secret), name: r.fursonaName || r.legalName, legalName: r.legalName,
      status: r.status, tierName: r.tierName, badgeTier: r.badgeTier, validDays: r.ticketTier?.validDays || [],
      checkedInAt: r.checkedInAt, scans: scansBy[r.id] || [],
    })),
  });
});

/// Scans a door scanner made while offline: `{ scans: [{ clientId, code,
/// direction, at, force }] }`. Each is recorded at the time it happened and
/// at most once (by clientId), even if this request is retried. Scans the
/// rules would now refuse are still recorded — the person is already
/// through the door — and come back flagged for staff to follow up.
adminRouter.post('/events/:id/checkin/sync', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const scans = Array.isArray(req.body?.scans) ? req.body.scans.slice(0, 2000) : [];
  const results = [];
  for (const s of scans) {
    const clientId = String(s.clientId || '').slice(0, 64);
    const at = new Date(s.at);
    if (!clientId || Number.isNaN(at.getTime()) || at > new Date(Date.now() + 5 * 60_000)) {
      results.push({ clientId, ok: false, error: 'Bad scan record.' });
      continue;
    }
    const reg = await prisma.registration.findFirst({ where: { code: String(s.code || '').toUpperCase(), eventId: event.id } });
    if (!reg) { results.push({ clientId, ok: false, error: 'No ticket matches that code.' }); continue; }
    try {
      const { scan, duplicate, problem } = await recordScan({
        registrationId: reg.id, direction: DIRECTIONS.includes(s.direction) ? s.direction : 'ENTRY', at,
        byId: req.user.id, clientId, offline: true, force: Boolean(s.force),
      });
      if (!duplicate && problem) await audit(req.user.id, 'checkin.offline_flagged', reg.id, { code: reg.code, problem: problem.code, day: scan.day });
      results.push({ clientId, ok: true, duplicate, flagged: problem ? `${reg.code}: ${problem.message}` : null });
    } catch (e) {
      if (!(e instanceof ScanError)) throw e;
      results.push({ clientId, ok: false, error: e.message });
    }
  }
  const synced = results.filter((r) => r.ok && !r.duplicate).length;
  if (synced) await audit(req.user.id, 'checkin.offline_sync', event.id, { synced });
  res.json({ results, today: await todayCounts(event) });
});

/// For the lobby display: each ticket's first entry today after `since`,
/// numbered in the order people arrived today. A same-day re-entry isn't a
/// new arrival; tomorrow, everyone is welcomed again.
adminRouter.get('/events/:id/arrivals', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
  const day = dayIn(new Date(), event.timezone);
  const firsts = await prisma.$queryRaw`
    SELECT "registrationId", "at", row_number() OVER (ORDER BY "at")::int AS number
    FROM (
      SELECT DISTINCT ON ("registrationId") "registrationId", "at"
      FROM "CheckIn"
      WHERE "eventId" = ${event.id} AND "day" = ${day} AND "direction" = 'ENTRY'
      ORDER BY "registrationId", "at"
    ) f`;
  const fresh = firsts.filter((f) => !Number.isNaN(since.getTime()) && f.at > since).sort((a, b) => a.number - b.number);
  const regs = fresh.length
    ? await prisma.registration.findMany({ where: { id: { in: fresh.map((f) => f.registrationId) } }, select: { id: true, fursonaName: true, legalName: true } })
    : [];
  res.json({
    today: await todayCounts(event),
    arrivals: fresh.map((f) => {
      const r = regs.find((x) => x.id === f.registrationId);
      return { name: r?.fursonaName || r?.legalName || '', at: f.at, number: f.number };
    }),
  });
});

/// Who's inside now and today's arrivals, plus arrivals for every day.
adminRouter.get('/events/:id/attendance', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const [today, days] = await Promise.all([todayCounts(event), dailyAttendance(event)]);
  res.json({ today, days, eventDays: eventDays(event), timezone: event.timezone });
});

adminRouter.get('/bans', async (_req, res) => {
  const bans = await prisma.ban.findMany({ orderBy: { createdAt: 'desc' }, include: { createdBy: true } });
  res.json(bans);
});

adminRouter.get('/bans/attempts', async (_req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'ban.blocked_registration' },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(rows);
});

adminRouter.post('/bans', requireOwner, async (req, res) => {
  const { legalName, email, telegramId, telegramUsername, reason } = req.body || {};
  // Normalized the same way findMatchingBan() reads incoming registrations,
  // so an inconsistently-spaced/accented ban record can't silently fail to
  // match later.
  const data = {
    legalName: norm(legalName) || null,
    email: norm(email) || null,
    telegramId: norm(telegramId) || null,
    telegramUsername: normHandle(telegramUsername) || null,
    reason: reason?.trim() || '',
  };
  if (!data.legalName && !data.email && !data.telegramId && !data.telegramUsername)
    return res.status(400).json({ error: 'Enter at least a preferred name, email, or Telegram ID/username to ban.' });
  const ban = await prisma.ban.create({ data: { ...data, createdById: req.user.id } });
  await audit(req.user.id, 'ban.create', ban.id, data);
  res.json(ban);
});

adminRouter.delete('/bans/:id', requireOwner, async (req, res) => {
  const ban = await prisma.ban.delete({ where: { id: req.params.id } });
  await audit(req.user.id, 'ban.delete', req.params.id, { legalName: ban.legalName, email: ban.email });
  res.json({ ok: true });
});

/* ---------------- staff ---------------- */

// email is encrypted at rest, so matching it against a typed-in search term
// can't happen in the database query — see the same note above on the
// attendee search. displayName/telegramUsername aren't encrypted and could
// still be matched in the query, but it's simplest to filter all three the
// same way once the (already-decrypted) rows are in hand.
adminRouter.get('/users', requireOwner, async (req, res) => {
  const q = req.query.q ? String(req.query.q).toLowerCase() : '';
  const users = await prisma.user.findMany({
    where: q ? {} : { role: { in: ['ADMIN', 'OWNER'] } },
    orderBy: { createdAt: 'asc' },
    take: q ? undefined : 100,
  });
  const filtered = q
    ? users.filter((u) => [u.displayName, u.telegramUsername, u.email].some((v) => v && v.toLowerCase().includes(q))).slice(0, 100)
    : users;
  res.json(filtered.map(publicUser));
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
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'USER') return res.status(400).json({ error: 'End users sign in with an email code or Telegram, not a password. Promote them to staff first if they need one.' });
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { email: email?.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), tokenVersion: { increment: 1 } },
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

adminRouter.post('/campaigns/:id/send', requireOwner, async (req, res) => {
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

// Memory storage, not disk — the file is only written once its actual bytes
// have been decoded and verified below. Trusting the client's declared
// mimetype and original filename (as a `fileFilter` + disk `filename()`
// would) lets an upload named "x.png" with content-type image/png but actual
// content of, say, an SVG with an embedded <script> land on disk as
// whatever extension the client chose, then get served back same-origin —
// a stored-XSS path into an admin session.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const EXT_BY_FORMAT = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' };

adminRouter.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received.' });
  let format;
  try { ({ format } = await sharp(req.file.buffer).metadata()); }
  catch { return res.status(400).json({ error: 'That file could not be read as an image.' }); }
  const ext = EXT_BY_FORMAT[format];
  if (!ext) return res.status(400).json({ error: 'Use a PNG, JPEG, WebP, or GIF image.' });
  const filename = `${nanoid(10)}${ext}`;
  await fs.writeFile(path.join(process.cwd(), 'uploads', filename), req.file.buffer);
  // webUrl, not publicUrl — see the matching note in bot/index.js's
  // cacheTelegramPhoto. This one is rendered as the site logo/banner <img>,
  // same CSP img-src exposure.
  res.json({ url: `${env.webUrl}/uploads/${filename}` });
});

/* ---------------- settings ---------------- */

adminRouter.get('/settings', requireOwner, async (_req, res) => res.json(await getSettings()));
adminRouter.put('/settings', requireOwner, async (req, res) => {
  const s = await setSettings(req.body || {});
  await audit(req.user.id, 'settings.update', null, {});
  res.json(s);
});

adminRouter.get('/audit', requireOwner, async (_req, res) => {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { actor: true } });
  res.json(rows.map((r) => ({ ...r, actor: r.actor ? publicUser(r.actor) : null })));
});

/* ---------------- analytics (owner only) ---------------- */

// Buckets registration counts per calendar day in UTC — daily granularity is
// plenty for a signup trend line, and it sidesteps per-event timezone
// handling that would otherwise be needed to bucket "by day" correctly.
adminRouter.get('/analytics', requireOwner, async (req, res) => {
  const eventId = req.query.eventId || undefined;
  const daysParam = Number(req.query.days);
  const days = Number.isFinite(daysParam) ? daysParam : 30;
  const since = days > 0 ? new Date(Date.now() - days * 86400000) : null;

  const regs = await prisma.registration.findMany({
    where: { ...(eventId && { eventId }), ...(since && { createdAt: { gte: since } }) },
    select: { createdAt: true, status: true, source: true, checkedInAt: true },
  });

  const dayKey = (d) => d.toISOString().slice(0, 10);
  const dailyMap = new Map();
  if (since) {
    for (let t = new Date(since); t <= new Date(); t.setUTCDate(t.getUTCDate() + 1)) dailyMap.set(dayKey(t), 0);
  }
  const bySource = {};
  const byStatus = { CONFIRMED: 0, PENDING_PAYMENT: 0, WAITLIST: 0, CANCELLED: 0 };
  let checkedIn = 0;
  const todayKey = dayKey(new Date());
  let today = 0;

  for (const r of regs) {
    const k = dayKey(r.createdAt);
    dailyMap.set(k, (dailyMap.get(k) || 0) + 1);
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.checkedInAt) checkedIn += 1;
    if (k === todayKey) today += 1;
  }

  const daily = [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));

  res.json({
    range: { days, since: since?.toISOString() ?? null },
    totals: { total: regs.length, checkedIn, today },
    daily,
    bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
  });
});

/* ---------------- backup & restore (owner only) ---------------- */

// Parent-before-child order — this is also the order rows get recreated in on
// restore. Deletion (on restore, before recreating) runs the reverse of this.
const BACKUP_MODELS = ['user', 'badgeTemplate', 'setting', 'event', 'ticketTier', 'discountCode', 'voucherCode', 'merchItem', 'registration', 'checkIn', 'volunteerShift', 'volunteerSignup', 'hotel', 'roomBlock', 'roomBlockNight', 'roomReservation', 'merchOrder', 'merchOrderItem', 'payment', 'sale', 'donation', 'emailCampaign', 'incident', 'incidentPerson', 'incidentNote', 'ban', 'auditLog'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const reviveDates = (key, value) => (typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value);

adminRouter.get('/backup', requireOwner, async (req, res) => {
  const data = {};
  for (const key of BACKUP_MODELS) data[key] = await prisma[key].findMany();
  // Internal settings (e.g. the encryption key check) belong to this instance.
  data.setting = data.setting.filter((s) => !s.key.startsWith('__'));

  const zip = new AdmZip();
  zip.addFile('data.json', Buffer.from(JSON.stringify({ meta: { version: BACKUP_VERSION, exportedAt: new Date().toISOString() }, data }, null, 2)));

  const uploadsDir = path.join(process.cwd(), 'uploads');
  try {
    for (const name of await fs.readdir(uploadsDir)) {
      const full = path.join(uploadsDir, name);
      if ((await fs.stat(full)).isFile()) zip.addLocalFile(full, 'uploads');
    }
  } catch { /* no uploads directory yet — fine, the backup just has none */ }

  await audit(req.user.id, 'backup.create', null, {});
  const stamp = new Date().toISOString().slice(0, 10);
  res.type('application/zip').set('Content-Disposition', `attachment; filename="pawpass-backup-${stamp}.zip"`).send(zip.toBuffer());
});

const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

/// Replaces every row this app manages with whatever the uploaded backup
/// contains — genuinely destructive, which is why this route (and the /backup
/// one above) requires requireOwner on top of the router's own requireAdmin.
adminRouter.post('/restore', requireOwner, restoreUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file received.' });

  let zip;
  try { zip = new AdmZip(req.file.buffer); } catch { return res.status(400).json({ error: 'That file is not a valid zip archive.' }); }

  const dataEntry = zip.getEntry('data.json');
  if (!dataEntry) return res.status(400).json({ error: 'That zip is not a PawPass backup.' });

  let parsed;
  try { parsed = JSON.parse(dataEntry.getData().toString('utf8'), reviveDates); }
  catch { return res.status(400).json({ error: 'data.json in that backup is not valid JSON.' }); }

  // Older backups are converted forward one version at a time (lib/backup.js),
  // the same way the v1 -> v2 database migration converts a live instance.
  try { parsed = upgradeBackup(parsed); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const counts = {};
  await prisma.$transaction(async (tx) => {
    // Internal settings (the encryption key check) stay as they are.
    const keep = (key) => (key === 'setting' ? { where: { NOT: { key: { startsWith: '__' } } } } : {});
    for (const key of [...BACKUP_MODELS].reverse()) await tx[key].deleteMany(keep(key));
    for (const key of BACKUP_MODELS) {
      let rows = parsed.data[key] || [];
      if (key === 'setting') rows = rows.filter((r) => !String(r.key).startsWith('__'));
      if (rows.length) await tx[key].createMany({ data: rows });
      counts[key] = rows.length;
    }
  }, { timeout: 60000 });

  const uploadsDir = path.join(process.cwd(), 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });
  const fileEntries = zip.getEntries().filter((en) => en.entryName.startsWith('uploads/') && !en.isDirectory);
  for (const entry of fileEntries) await fs.writeFile(path.join(uploadsDir, path.basename(entry.entryName)), entry.getData());

  // The signed-in owner's own row may not exist in a backup taken from a
  // different instance — don't let a failed audit write mask a successful
  // restore with a confusing 500.
  try { await audit(req.user.id, 'backup.restore', null, { counts }); } catch { /* actor not in restored data */ }

  res.json({ ok: true, counts, filesRestored: fileEntries.length });
});

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
