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
import { ticketCode } from '../lib/codes.js';
import { zonedTimeToUtc } from '../lib/tz.js';
import { publicUser } from './auth.js';
import { summarize, shapeReg } from './public.js';
import { sendCampaign } from '../lib/mailer.js';
import { notifyUser } from '../bot/index.js';

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
  const keys = ['code','status','legalName','fursonaName','email','telegram','checkedInAt','source','createdAt','tier','badgeTier','paymentMethod','paymentAmount','paymentNote'];
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
    // No Telegram ID to match on, so this would otherwise always create a
    // brand-new person — catch the common case of someone who preregistered
    // online walking up and getting entered as a second, separate attendee.
    const dup = await prisma.registration.findFirst({
      where: {
        eventId: req.body.eventId,
        status: { not: 'CANCELLED' },
        OR: [
          { legalName: { equals: req.body.legalName, mode: 'insensitive' } },
          ...(req.body.email ? [{ email: { equals: req.body.email, mode: 'insensitive' } }] : []),
        ],
      },
    });
    if (dup) return res.status(409).json({ error: `${dup.legalName} already has a registration for this event (code ${dup.code}). Look them up in Attendees instead of creating a new one.` });
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
  const allowed = ['legalName','fursonaName','email','status','answers','paymentMethod','paymentAmount','paymentNote'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const reg = await prisma.registration.update({ where: { code: req.params.code }, data });
  if (data.status === 'CANCELLED') {
    const promoted = await promoteFromWaitlist(reg.eventId);
    if (promoted?.user.telegramId) {
      await notifyUser(promoted.user.telegramId,
        `Good news — a spot opened up for ${promoted.event.title} and you have been moved off the waitlist.\n\n` +
        `Badge code: ${promoted.code}\n` +
        `Ticket and wallet pass: ${env.webUrl}/tickets`);
    }
  }
  await audit(req.user.id, 'registration.update', reg.id, data);
  res.json(shapeReg(reg));
});

/* ---------------- merch ---------------- */

const PAYMENT_METHODS = ['CASH', 'CARD', 'PAYPAL', 'OTHER'];
class MerchError extends Error {}

adminRouter.get('/events/:id/merch', async (req, res) => {
  const items = await prisma.merchItem.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'asc' } });
  const sales = await prisma.sale.findMany({
    where: { item: { eventId: req.params.id } },
    include: { item: true, processedBy: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const revenueTotal = sales.reduce((sum, s) => sum + (s.item.price || 0) * s.quantity, 0);
  res.json({
    items: items.map((i) => ({ ...i, remaining: Math.max(i.maxCount - i.soldCount, 0) })),
    sales: sales.map((s) => ({
      id: s.id, itemId: s.itemId, itemName: s.item.name, quantity: s.quantity,
      paymentMethod: s.paymentMethod, paymentNote: s.paymentNote,
      processedByName: s.processedBy.displayName, createdAt: s.createdAt,
    })),
    revenueTotal,
  });
});

adminRouter.post('/events/:id/merch', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const { name, price, maxCount } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give the item a name.' });
  const max = Number(maxCount);
  if (!Number.isInteger(max) || max < 0) return res.status(400).json({ error: 'Max count must be a whole number, zero or more.' });
  const item = await prisma.merchItem.create({
    data: { eventId: req.params.id, name: String(name).trim(), price: price != null && price !== '' ? Number(price) : null, maxCount: max },
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

adminRouter.delete('/merch/:id', async (req, res) => {
  const item = await prisma.merchItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  if (item.soldCount > 0) return res.status(400).json({ error: 'This item has recorded sales — cannot delete.' });
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

/// Combines the two separate places money gets recorded — donation-tier
/// registrations and merch sales — into one end-of-shift total, broken out
/// by payment method. Donation registrations with no paymentMethod recorded
/// (i.e. nobody at the door confirmed the PayPal payment actually happened)
/// are called out separately rather than silently counted as zero.
adminRouter.get('/events/:id/reconciliation', async (req, res) => {
  const donationRegs = await prisma.registration.findMany({
    where: { eventId: req.params.id, tier: 'DONATION', status: { not: 'CANCELLED' } },
  });
  const sales = await prisma.sale.findMany({
    where: { item: { eventId: req.params.id } },
    include: { item: true },
  });

  const byMethod = () => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, { count: 0, total: 0 }]));
  const sumTotals = (obj) => Object.values(obj).reduce((sum, m) => sum + m.total, 0);

  const donations = byMethod();
  let unrecordedDonations = 0;
  for (const r of donationRegs) {
    if (!r.paymentMethod) { unrecordedDonations++; continue; }
    donations[r.paymentMethod].count++;
    donations[r.paymentMethod].total += r.paymentAmount || 0;
  }

  const merch = byMethod();
  for (const s of sales) {
    merch[s.paymentMethod].count += s.quantity;
    merch[s.paymentMethod].total += (s.item.price || 0) * s.quantity;
  }

  const donationsTotal = sumTotals(donations);
  const merchTotal = sumTotals(merch);
  res.json({ donations, merch, unrecordedDonations, donationsTotal, merchTotal, grandTotal: donationsTotal + merchTotal });
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
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { actor: true } });
  res.json(rows.map((r) => ({ ...r, actor: r.actor ? publicUser(r.actor) : null })));
});

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
