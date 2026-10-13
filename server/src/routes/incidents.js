import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { requireAdmin, requireOwner, audit } from '../lib/auth.js';
import { findMatchingBan, norm, normHandle } from '../lib/bans.js';

/// Confidential incident reports. Any staff member can file one and follow
/// up on it; only owners see every report, resolve them, or turn one into a
/// ban. An admin only ever sees the reports they filed — to anyone else a
/// report they can't see simply doesn't exist (404, not 403).
export const incidentRouter = Router();
incidentRouter.use(requireAdmin);

export const CATEGORIES = ['harassment', 'safety', 'medical', 'property', 'conduct', 'other'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const ROLES = ['SUBJECT', 'REPORTER', 'WITNESS'];

class IncidentError extends Error {}

const isOwner = (user) => user.role === 'OWNER';
const visibleTo = (user) => (isOwner(user) ? {} : { filedById: user.id });
const text = (v, max) => String(v ?? '').trim().slice(0, max);

const FULL_INCLUDE = {
  event: { select: { id: true, title: true, timezone: true } },
  filedBy: { select: { id: true, displayName: true } },
  people: { include: { registration: { include: { user: true } } }, orderBy: { createdAt: 'asc' } },
  notes: { include: { author: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } },
  bans: { select: { id: true, createdAt: true, legalName: true, email: true, telegramUsername: true } },
};

/// Identity a ban would use for this person: their ticket's details when
/// linked, otherwise whatever contact was written down.
function identityOf(p) {
  const r = p.registration;
  if (r) {
    return {
      legalName: r.legalName || null,
      email: r.email || r.user?.email || null,
      telegramId: r.user?.telegramId || null,
      telegramUsername: r.user?.telegramUsername || null,
    };
  }
  const contact = p.contact.trim();
  return {
    legalName: p.name.trim() || null,
    email: /\S+@\S+\.\S+/.test(contact) ? contact : null,
    telegramId: null,
    telegramUsername: contact.startsWith('@') ? contact : null,
  };
}

async function shapePerson(p) {
  const r = p.registration;
  const banned = p.role === 'SUBJECT' ? await findMatchingBan(identityOf(p)) : null;
  return {
    id: p.id, role: p.role, notes: p.notes,
    name: p.name || r?.fursonaName || r?.legalName || '',
    contact: p.contact,
    ticket: r ? { code: r.code, legalName: r.legalName, fursonaName: r.fursonaName, email: r.email, telegramUsername: r.user?.telegramUsername, status: r.status } : null,
    banned: Boolean(banned),
  };
}

async function shapeIncident(i, user) {
  return {
    id: i.id, eventId: i.eventId, event: i.event, occurredAt: i.occurredAt, location: i.location,
    category: i.category, severity: i.severity, status: i.status, summary: i.summary,
    details: i.details, resolution: i.resolution, resolvedAt: i.resolvedAt,
    filedBy: i.filedBy, createdAt: i.createdAt, updatedAt: i.updatedAt,
    people: await Promise.all(i.people.map(shapePerson)),
    notes: i.notes.map((n) => ({ id: n.id, body: n.body, author: n.author?.displayName || 'Former staff', createdAt: n.createdAt })),
    bans: i.bans,
    canManage: isOwner(user),
  };
}

async function load(req) {
  return prisma.incident.findFirst({ where: { id: req.params.id, ...visibleTo(req.user) }, include: FULL_INCLUDE });
}

/// A person from a form: a ticket code to link, and/or a name and contact.
async function personData(body, eventId) {
  const role = ROLES.includes(body.role) ? body.role : 'SUBJECT';
  let registrationId = null;
  const code = text(body.registrationCode, 40).toUpperCase();
  if (code) {
    const reg = await prisma.registration.findFirst({ where: { code, ...(eventId ? { eventId } : {}) } });
    if (!reg) throw new IncidentError(`No ticket ${code}${eventId ? ' for this event' : ''}.`);
    registrationId = reg.id;
  }
  const data = { role, registrationId, name: text(body.name, 160), contact: text(body.contact, 200), notes: text(body.notes, 2000) };
  if (!registrationId && !data.name && !data.contact) throw new IncidentError('Give each person a ticket code, or at least a name or contact.');
  return data;
}

function incidentFields(body, { creating = false, owner = false } = {}) {
  const data = {};
  if (body.summary !== undefined || creating) {
    data.summary = text(body.summary, 200);
    if (!data.summary) throw new IncidentError('Give the report a short summary.');
  }
  if (body.occurredAt !== undefined || creating) {
    const at = body.occurredAt ? new Date(body.occurredAt) : new Date();
    if (Number.isNaN(at.getTime())) throw new IncidentError('That is not a valid date and time.');
    data.occurredAt = at;
  }
  if (body.location !== undefined) data.location = text(body.location, 200) || null;
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) throw new IncidentError('Choose a category.');
    data.category = body.category;
  }
  if (body.severity !== undefined) {
    if (!SEVERITIES.includes(body.severity)) throw new IncidentError('Choose a severity.');
    data.severity = body.severity;
  }
  if (body.details !== undefined) data.details = String(body.details ?? '').slice(0, 20000);
  // Closing a report is an owner decision.
  if (owner && body.resolution !== undefined) data.resolution = String(body.resolution ?? '').slice(0, 20000);
  if (owner && body.status !== undefined) {
    if (!['OPEN', 'RESOLVED'].includes(body.status)) throw new IncidentError('Unknown status.');
    data.status = body.status;
    data.resolvedAt = body.status === 'RESOLVED' ? new Date() : null;
  }
  return data;
}

const fail = (res, e) => {
  if (e instanceof IncidentError) return res.status(400).json({ error: e.message });
  throw e;
};

/// The list: open first, then most recent. `q` matches the summary only —
/// everything else is encrypted and can't be searched in the database.
incidentRouter.get('/', async (req, res) => {
  const where = { ...visibleTo(req.user) };
  if (req.query.eventId) where.eventId = String(req.query.eventId);
  if (['OPEN', 'RESOLVED'].includes(req.query.status)) where.status = req.query.status;
  if (req.query.q) where.summary = { contains: String(req.query.q).slice(0, 100), mode: 'insensitive' };
  const rows = await prisma.incident.findMany({
    where,
    include: { event: { select: { id: true, title: true } }, filedBy: { select: { displayName: true } }, people: { select: { role: true, name: true, registration: { select: { fursonaName: true, legalName: true } } } } },
    orderBy: [{ status: 'asc' }, { occurredAt: 'desc' }],
    take: 500,
  });
  res.json({
    canManage: isOwner(req.user),
    incidents: rows.map((i) => ({
      id: i.id, summary: i.summary, category: i.category, severity: i.severity, status: i.status,
      occurredAt: i.occurredAt, location: i.location, event: i.event, filedBy: i.filedBy?.displayName || 'Former staff',
      subjects: i.people.filter((p) => p.role === 'SUBJECT').map((p) => p.name || p.registration?.fursonaName || p.registration?.legalName).filter(Boolean),
    })),
  });
});

incidentRouter.get('/:id', async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  res.json(await shapeIncident(incident, req.user));
});

incidentRouter.post('/', async (req, res) => {
  const body = req.body || {};
  try {
    const eventId = body.eventId ? String(body.eventId) : null;
    if (eventId && !(await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } }))) throw new IncidentError('Event not found.');
    const data = incidentFields(body, { creating: true, owner: isOwner(req.user) });
    const people = [];
    for (const p of Array.isArray(body.people) ? body.people.slice(0, 30) : []) people.push(await personData(p, eventId));
    // People are written one by one rather than as a nested create: the
    // encryption in lib/db.js only sees top-level writes, so nested rows
    // would land in plain text.
    const created = await prisma.$transaction(async (tx) => {
      const incident = await tx.incident.create({ data: { ...data, eventId, filedById: req.user.id } });
      for (const p of people) await tx.incidentPerson.create({ data: { ...p, incidentId: incident.id } });
      return incident;
    });
    await audit(req.user.id, 'incident.create', created.id, { eventId, severity: created.severity, category: created.category });
    res.json(await shapeIncident(await prisma.incident.findUnique({ where: { id: created.id }, include: FULL_INCLUDE }), req.user));
  } catch (e) { fail(res, e); }
});

/// Owners can change anything. The admin who filed a report can still
/// correct it while it's open, but not resolve it.
incidentRouter.patch('/:id', async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  const owner = isOwner(req.user);
  if (!owner && incident.status !== 'OPEN') return res.status(403).json({ error: 'This report is resolved. Ask an owner to reopen it.' });
  try {
    const data = incidentFields(req.body || {}, { owner });
    await prisma.incident.update({ where: { id: incident.id }, data });
    await audit(req.user.id, 'incident.update', incident.id, { fields: Object.keys(data), status: data.status });
    res.json(await shapeIncident(await load(req), req.user));
  } catch (e) { fail(res, e); }
});

incidentRouter.post('/:id/notes', async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  const body = String(req.body?.body ?? '').trim().slice(0, 10000);
  if (!body) return res.status(400).json({ error: 'Write the note first.' });
  await prisma.incidentNote.create({ data: { incidentId: incident.id, authorId: req.user.id, body } });
  await audit(req.user.id, 'incident.note', incident.id, {});
  res.json(await shapeIncident(await load(req), req.user));
});

incidentRouter.post('/:id/people', async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  try {
    await prisma.incidentPerson.create({ data: { incidentId: incident.id, ...(await personData(req.body || {}, incident.eventId)) } });
    await audit(req.user.id, 'incident.person.add', incident.id, {});
    res.json(await shapeIncident(await load(req), req.user));
  } catch (e) { fail(res, e); }
});

incidentRouter.delete('/:id/people/:personId', requireOwner, async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  const { count } = await prisma.incidentPerson.deleteMany({ where: { id: req.params.personId, incidentId: incident.id } });
  if (!count) return res.status(404).json({ error: 'Person not found on this report.' });
  await audit(req.user.id, 'incident.person.remove', incident.id, {});
  res.json(await shapeIncident(await load(req), req.user));
});

/// "Turn this into a ban": bans the person by their ticket's identity (or
/// what was written down), linked back to this report. Same normalization
/// as POST /admin/bans, so it matches future registrations the same way.
incidentRouter.post('/:id/people/:personId/ban', requireOwner, async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  const person = incident.people.find((p) => p.id === req.params.personId);
  if (!person) return res.status(404).json({ error: 'Person not found on this report.' });
  const id = identityOf(person);
  const data = {
    legalName: norm(id.legalName) || null,
    email: norm(id.email) || null,
    telegramId: norm(id.telegramId) || null,
    telegramUsername: normHandle(id.telegramUsername) || null,
  };
  if (!data.legalName && !data.email && !data.telegramId && !data.telegramUsername)
    return res.status(400).json({ error: 'There is nothing to ban this person by. Link their ticket or add a name or contact first.' });
  if (await findMatchingBan(data)) return res.status(400).json({ error: 'This person is already banned.' });
  const reason = text(req.body?.reason, 500) || `Incident: ${incident.summary}`;
  const ban = await prisma.ban.create({ data: { ...data, reason, createdById: req.user.id, incidentId: incident.id } });
  await audit(req.user.id, 'ban.create', ban.id, { ...data, incidentId: incident.id });
  await prisma.incidentNote.create({ data: { incidentId: incident.id, authorId: req.user.id, body: `Banned ${person.name || person.registration?.fursonaName || person.registration?.legalName || 'this person'}. Reason: ${reason}` } });
  res.json(await shapeIncident(await load(req), req.user));
});

incidentRouter.delete('/:id', requireOwner, async (req, res) => {
  const incident = await load(req);
  if (!incident) return res.status(404).json({ error: 'Report not found.' });
  await prisma.incident.delete({ where: { id: incident.id } });
  await audit(req.user.id, 'incident.delete', incident.id, { summary: incident.summary });
  res.json({ ok: true });
});
