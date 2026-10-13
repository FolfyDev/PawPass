import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { requireAdmin, requirePerm, requireUser, audit } from '../lib/auth.js';
import { formatInTimeZone } from '../lib/tz.js';
import { stripeEnabled } from '../lib/stripe.js';
import {
  startVendorCheckout, abandonVendorPayments, notifyVendorConfirmed, notifyPerson, PaymentError,
  STAFF_PAYMENT_METHODS, toCents, shapePayment,
} from '../lib/payments.js';
import {
  applicationPayload, tableTypePayload, acceptApplication, vendorsAccepting, paidCents,
  VendorError, LIVE, HOLDS_TABLE, AREA_LABEL,
} from '../lib/vendors.js';
import { blockedByBan } from './public.js';

/// Dealers' den and artist alley applications. Owners set the table types
/// and prices and open applications (PATCH /admin/events/:id); reviewing,
/// assigning table numbers, and recording payments is open to admins.

const isStaff = (user) => !!user && (user.role === 'ADMIN' || user.role === 'OWNER');
const fail = (res, e) => {
  if (e instanceof VendorError || e instanceof PaymentError) return res.status(400).json({ error: e.message });
  throw e;
};
const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`;

/* ------------------------------------------------------------- public --- */

export const vendorPublicRouter = Router();

const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many applications from this connection. Try again later.' },
});

const myApplication = (a) => ({
  id: a.id, area: a.area, areaLabel: AREA_LABEL[a.area], businessName: a.businessName, description: a.description,
  portfolioUrls: a.portfolioUrls, assistants: a.assistants, notes: a.notes, status: a.status,
  tableType: a.tableType ? { id: a.tableType.id, name: a.tableType.name } : null, tableTypeId: a.tableTypeId,
  tableNumber: a.tableNumber, feeCents: a.feeCents, currency: a.currency, paidCents: paidCents(a.payments),
  createdAt: a.createdAt, decidedAt: a.decidedAt,
  event: a.event ? { title: a.event.title, slug: a.event.slug, startsAt: a.event.startsAt, timezone: a.event.timezone } : undefined,
});
const MINE_INCLUDE = { tableType: true, payments: true, event: true };

vendorPublicRouter.get('/events/:slug/vendors', async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || ((!event.published || !event.vendorsOpen) && !isStaff(req.user))) return res.status(404).json({ error: 'This event isn\'t taking vendor applications.' });
  const [types, mine] = await Promise.all([
    prisma.vendorTableType.findMany({ where: { eventId: event.id, active: true }, orderBy: [{ area: 'asc' }, { sortOrder: 'asc' }, { priceCents: 'desc' }] }),
    req.user ? prisma.vendorApplication.findMany({ where: { eventId: event.id, userId: req.user.id }, include: MINE_INCLUDE, orderBy: { createdAt: 'desc' } }) : [],
  ]);
  res.json({
    title: event.title, accepting: vendorsAccepting(event), closesAt: event.vendorsCloseAt, info: event.vendorInfo,
    timezone: event.timezone, payOnline: stripeEnabled(),
    tableTypes: types.map((t) => ({ id: t.id, area: t.area, name: t.name, description: t.description, priceCents: t.priceCents, currency: t.currency })),
    mine: mine.map(myApplication),
  });
});

vendorPublicRouter.post('/events/:slug/vendors', requireUser, applyLimiter, async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || !event.published || !vendorsAccepting(event)) return res.status(400).json({ error: 'Vendor applications are closed for this event.' });
  if (await blockedByBan(req.user, event, 'vendor'))
    return res.status(403).json({ error: 'Vendor applications are not available for this account. Contact the organizers if you think this is a mistake.' });
  try {
    const data = applicationPayload(req.body || {}, { creating: true });
    if (data.tableTypeId && !(await prisma.vendorTableType.findFirst({ where: { id: data.tableTypeId, eventId: event.id, area: data.area, active: true } })))
      throw new VendorError('Choose one of the tables listed for that area.');
    const existing = await prisma.vendorApplication.findFirst({ where: { eventId: event.id, userId: req.user.id, area: data.area, status: { in: LIVE } } });
    if (existing) throw new VendorError(`You already have an application for the ${AREA_LABEL[data.area].toLowerCase()}. Edit that one instead.`);
    const app = await prisma.vendorApplication.create({ data: { ...data, eventId: event.id, userId: req.user.id }, include: MINE_INCLUDE });
    await audit(req.user.id, 'vendor.apply', app.id, { eventId: event.id, area: app.area });
    res.json(myApplication(app));
  } catch (e) { fail(res, e); }
});

vendorPublicRouter.get('/my/vendor-applications', requireUser, async (req, res) => {
  const apps = await prisma.vendorApplication.findMany({ where: { userId: req.user.id, status: { in: LIVE } }, include: MINE_INCLUDE, orderBy: { createdAt: 'desc' } });
  res.json(apps.map(myApplication));
});

/// Editable while it's still waiting on a decision.
vendorPublicRouter.patch('/my/vendor-applications/:id', requireUser, async (req, res) => {
  const app = await prisma.vendorApplication.findUnique({ where: { id: req.params.id } });
  if (!app || app.userId !== req.user.id) return res.status(404).json({ error: 'Application not found.' });
  if (!['SUBMITTED', 'WAITLISTED'].includes(app.status)) return res.status(400).json({ error: 'This application has been decided, so it can\'t be changed here.' });
  try {
    const data = applicationPayload(req.body || {});
    delete data.area; // fixed once applied
    if (data.tableTypeId && !(await prisma.vendorTableType.findFirst({ where: { id: data.tableTypeId, eventId: app.eventId, area: app.area, active: true } })))
      throw new VendorError('Choose one of the tables listed for that area.');
    const updated = await prisma.vendorApplication.update({ where: { id: app.id }, data, include: MINE_INCLUDE });
    res.json(myApplication(updated));
  } catch (e) { fail(res, e); }
});

vendorPublicRouter.post('/my/vendor-applications/:id/withdraw', requireUser, async (req, res) => {
  const { count } = await prisma.vendorApplication.updateMany({
    where: { id: req.params.id, userId: req.user.id, status: { in: ['SUBMITTED', 'WAITLISTED'] } },
    data: { status: 'WITHDRAWN' },
  });
  if (!count) return res.status(400).json({ error: 'Only an application that\'s still waiting can be withdrawn. Contact the organizers.' });
  await audit(req.user.id, 'vendor.withdraw', req.params.id, {});
  res.json({ ok: true });
});

vendorPublicRouter.post('/my/vendor-applications/:id/pay', requireUser, async (req, res) => {
  const app = await prisma.vendorApplication.findUnique({ where: { id: req.params.id } });
  if (!app || app.userId !== req.user.id) return res.status(404).json({ error: 'Application not found.' });
  try { res.json({ url: await startVendorCheckout(app.id) }); } catch (e) { fail(res, e); }
});

/* -------------------------------------------------------------- admin --- */

export const vendorAdminRouter = Router();
vendorAdminRouter.use(requireAdmin);

const ADMIN_INCLUDE = { user: true, tableType: true, decidedBy: { select: { displayName: true } }, payments: { orderBy: { createdAt: 'asc' } } };
const shapeForStaff = (a) => ({
  ...myApplication(a),
  reviewNote: a.reviewNote,
  decidedBy: a.decidedBy?.displayName || null,
  applicant: { id: a.user.id, name: a.user.fursonaName || a.user.displayName, legalName: a.user.legalName, email: a.user.email, telegramUsername: a.user.telegramUsername },
  payments: a.payments.map(shapePayment),
});

vendorAdminRouter.get('/events/:id/vendors', requirePerm('vendors.review', 'vendors.setup'), async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const [types, apps] = await Promise.all([
    prisma.vendorTableType.findMany({ where: { eventId: event.id }, orderBy: [{ area: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.vendorApplication.findMany({ where: { eventId: event.id }, include: ADMIN_INCLUDE, orderBy: { createdAt: 'asc' } }),
  ]);
  res.json({
    open: event.vendorsOpen, closesAt: event.vendorsCloseAt, info: event.vendorInfo, timezone: event.timezone, payOnline: stripeEnabled(),
    tableTypes: types.map((t) => ({ ...t, taken: apps.filter((a) => a.tableTypeId === t.id && HOLDS_TABLE.includes(a.status)).length })),
    applications: apps.map(shapeForStaff),
  });
});

vendorAdminRouter.post('/events/:id/vendor-tables', requirePerm('vendors.setup'), async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  try {
    const type = await prisma.vendorTableType.create({ data: { ...tableTypePayload(req.body || {}, { creating: true }), eventId: event.id } });
    await audit(req.user.id, 'vendor.table.create', type.id, { name: type.name });
    res.json(type);
  } catch (e) { fail(res, e); }
});

vendorAdminRouter.patch('/vendor-tables/:id', requirePerm('vendors.setup'), async (req, res) => {
  const type = await prisma.vendorTableType.findUnique({ where: { id: req.params.id } });
  if (!type) return res.status(404).json({ error: 'Table type not found.' });
  try {
    const data = tableTypePayload(req.body || {});
    if (data.area && data.area !== type.area && await prisma.vendorApplication.count({ where: { tableTypeId: type.id } }))
      throw new VendorError('Applications point at this table type, so it can\'t move to the other area.');
    if (data.quantity !== undefined) {
      const taken = await prisma.vendorApplication.count({ where: { tableTypeId: type.id, status: { in: HOLDS_TABLE } } });
      if (data.quantity < taken) throw new VendorError(`${taken} of these tables are already given out.`);
    }
    // Changing the price doesn't touch fees already offered (snapshotted on acceptance).
    const updated = await prisma.vendorTableType.update({ where: { id: type.id }, data });
    await audit(req.user.id, 'vendor.table.update', type.id, data);
    res.json(updated);
  } catch (e) { fail(res, e); }
});

vendorAdminRouter.delete('/vendor-tables/:id', requirePerm('vendors.setup'), async (req, res) => {
  const type = await prisma.vendorTableType.findUnique({ where: { id: req.params.id } });
  if (!type) return res.status(404).json({ error: 'Table type not found.' });
  const used = await prisma.vendorApplication.count({ where: { tableTypeId: type.id, status: { in: LIVE } } });
  if (used) return res.status(400).json({ error: 'Live applications use this table type. Turn it off instead.' });
  await prisma.vendorTableType.delete({ where: { id: type.id } });
  await audit(req.user.id, 'vendor.table.delete', type.id, { name: type.name });
  res.json({ ok: true });
});

/// Accept (onto a table type; free tables are confirmed at once), waitlist,
/// or decline. `message` is added to what the applicant receives.
vendorAdminRouter.post('/vendor-applications/:id/decision', requirePerm('vendors.review'), async (req, res) => {
  const { decision, tableTypeId, message, reviewNote } = req.body || {};
  if (!['ACCEPTED', 'WAITLISTED', 'DECLINED'].includes(decision)) return res.status(400).json({ error: 'Accept, waitlist, or decline.' });
  const extra = String(message || '').trim().slice(0, 2000);
  try {
    let app;
    if (decision === 'ACCEPTED') {
      app = await acceptApplication({ applicationId: req.params.id, tableTypeId, actorId: req.user.id, reviewNote });
    } else {
      const current = await prisma.vendorApplication.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Application not found.' });
      const from = decision === 'WAITLISTED' ? ['SUBMITTED'] : ['SUBMITTED', 'WAITLISTED'];
      const { count } = await prisma.vendorApplication.updateMany({
        where: { id: current.id, status: { in: from } },
        data: { status: decision, decidedAt: new Date(), decidedById: req.user.id, ...(reviewNote !== undefined ? { reviewNote: String(reviewNote).slice(0, 3000) } : {}) },
      });
      if (!count) throw new VendorError('This application was already decided or withdrawn.');
      app = await prisma.vendorApplication.findUnique({ where: { id: current.id }, include: { event: true, user: true, tableType: true } });
    }
    await audit(req.user.id, `vendor.${decision.toLowerCase()}`, app.id, { tableTypeId: app.tableTypeId });

    const where = `${AREA_LABEL[app.area].toLowerCase()} at ${app.event.title}`;
    let subject;
    let text;
    if (app.status === 'CONFIRMED') {
      await notifyVendorConfirmed(app);
    } else {
      if (decision === 'ACCEPTED') {
        subject = `You're in the ${where}`;
        text = `${app.businessName} was accepted for the ${where}: ${app.tableType.name}. The table fee is ${money(app.feeCents, app.currency)}. `
          + (stripeEnabled() ? `Pay it from ${env.webUrl}/e/${app.event.slug}/vendors to confirm your table.` : 'The organizers will tell you how to pay it.');
      } else if (decision === 'WAITLISTED') {
        subject = `You're on the waitlist for the ${where}`;
        text = `${app.businessName} is on the waitlist for the ${where}. We'll be in touch if a table opens up.`;
      } else {
        subject = `About your application for the ${where}`;
        text = `Thank you for applying to the ${where} with ${app.businessName}. We weren't able to offer you a table this time.`;
      }
      await notifyPerson({ user: app.user, email: app.user.email, subject, text: extra ? `${text}\n\n${extra}` : text });
    }
    const full = await prisma.vendorApplication.findUnique({ where: { id: app.id }, include: ADMIN_INCLUDE });
    res.json(shapeForStaff(full));
  } catch (e) { fail(res, e); }
});

vendorAdminRouter.patch('/vendor-applications/:id', requirePerm('vendors.review'), async (req, res) => {
  const app = await prisma.vendorApplication.findUnique({ where: { id: req.params.id } });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const data = {};
  if (req.body?.tableNumber !== undefined) data.tableNumber = String(req.body.tableNumber || '').trim().slice(0, 40) || null;
  if (req.body?.reviewNote !== undefined) data.reviewNote = String(req.body.reviewNote || '').slice(0, 3000);
  const updated = await prisma.vendorApplication.update({ where: { id: app.id }, data, include: ADMIN_INCLUDE });
  if (data.tableNumber !== undefined) await audit(req.user.id, 'vendor.table_number', app.id, { tableNumber: data.tableNumber });
  res.json(shapeForStaff(updated));
});

/// Takes a table back. Money already paid isn't refunded automatically —
/// use the refund button on the payment, which can do part or all of it.
vendorAdminRouter.post('/vendor-applications/:id/cancel', requirePerm('vendors.review'), async (req, res) => {
  const app = await prisma.vendorApplication.findUnique({ where: { id: req.params.id }, include: { event: true, user: true } });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const { count } = await prisma.vendorApplication.updateMany({ where: { id: app.id, status: { in: HOLDS_TABLE } }, data: { status: 'CANCELLED' } });
  if (!count) return res.status(400).json({ error: 'Only an accepted or confirmed application can be cancelled.' });
  await abandonVendorPayments(app.id);
  await audit(req.user.id, 'vendor.cancel', app.id, {});
  const extra = String(req.body?.message || '').trim().slice(0, 2000);
  const text = `The organizers of ${app.event.title} cancelled ${app.businessName}'s table in the ${AREA_LABEL[app.area].toLowerCase()}.`;
  await notifyPerson({ user: app.user, email: app.user.email, subject: `Your table at ${app.event.title} was cancelled`, text: extra ? `${text}\n\n${extra}` : text });
  res.json(shapeForStaff(await prisma.vendorApplication.findUnique({ where: { id: app.id }, include: ADMIN_INCLUDE })));
});

/// Money taken another way (cash at the desk, an invoice). Confirms the
/// table once the fee is covered.
vendorAdminRouter.post('/vendor-applications/:id/payments', requirePerm('vendors.review'), async (req, res) => {
  const app = await prisma.vendorApplication.findUnique({ where: { id: req.params.id }, include: { payments: true } });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!HOLDS_TABLE.includes(app.status)) return res.status(400).json({ error: 'Only an accepted application takes payments.' });
  const method = req.body?.method;
  const amountCents = toCents(req.body?.amount);
  if (!STAFF_PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Choose how the payment was received.' });
  if (!Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Enter the amount received.' });
  await prisma.payment.create({
    data: { vendorApplicationId: app.id, method, status: 'PAID', amountCents, currency: app.currency, note: String(req.body?.note || '').trim() || null, paidAt: new Date(), processedById: req.user.id },
  });
  await audit(req.user.id, 'vendor.payment', app.id, { method, amountCents });
  const paid = paidCents([...app.payments, { status: 'PAID', amountCents, amountRefundedCents: 0 }]);
  if (app.status === 'ACCEPTED' && paid >= (app.feeCents || 0)) {
    const { count } = await prisma.vendorApplication.updateMany({ where: { id: app.id, status: 'ACCEPTED' }, data: { status: 'CONFIRMED' } });
    if (count) await notifyVendorConfirmed(await prisma.vendorApplication.findUnique({ where: { id: app.id }, include: { event: true, user: true, tableType: true } }));
  }
  res.json(shapeForStaff(await prisma.vendorApplication.findUnique({ where: { id: app.id }, include: ADMIN_INCLUDE })));
});

/// Floor-plan sheet: who's where, what they owe.
vendorAdminRouter.get('/events/:id/vendors.csv', requirePerm('vendors.review', 'vendors.setup'), async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const apps = await prisma.vendorApplication.findMany({ where: { eventId: event.id }, include: ADMIN_INCLUDE, orderBy: [{ area: 'asc' }, { tableNumber: 'asc' }, { businessName: 'asc' }] });
  const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const keys = ['area', 'status', 'tableNumber', 'businessName', 'tableType', 'fee', 'paid', 'contact', 'email', 'telegram', 'assistants', 'portfolio', 'notes', 'appliedAt'];
  const rows = apps.map((a) => [
    AREA_LABEL[a.area], a.status, a.tableNumber, a.businessName, a.tableType?.name,
    a.feeCents != null ? (a.feeCents / 100).toFixed(2) : '', (paidCents(a.payments) / 100).toFixed(2),
    a.user.legalName || a.user.displayName, a.user.email, a.user.telegramUsername ? `@${a.user.telegramUsername}` : '',
    a.assistants, a.portfolioUrls.join(' '), a.notes, formatInTimeZone(a.createdAt, event.timezone),
  ].map(csv).join(','));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="vendors.csv"').send([keys.join(','), ...rows].join('\n'));
});
