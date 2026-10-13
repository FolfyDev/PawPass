import { prisma } from './db.js';

export class VendorError extends Error {}

export const AREAS = ['DEALERS_DEN', 'ARTIST_ALLEY'];
export const AREA_LABEL = { DEALERS_DEN: "Dealers' den", ARTIST_ALLEY: 'Artist alley' };
/// Statuses that hold (or are asking for) a table.
export const LIVE = ['SUBMITTED', 'WAITLISTED', 'ACCEPTED', 'CONFIRMED'];
/// Statuses that take one of a table type's `quantity`.
export const HOLDS_TABLE = ['ACCEPTED', 'CONFIRMED'];

const text = (v, max) => String(v ?? '').trim().slice(0, max);

export const vendorsAccepting = (event, now = new Date()) =>
  event.vendorsOpen && (!event.vendorsCloseAt || event.vendorsCloseAt > now);

/// What an applicant can set. `creating` requires the basics.
export function applicationPayload(body, { creating = false } = {}) {
  const data = {};
  if (body.area !== undefined || creating) {
    if (!AREAS.includes(body.area)) throw new VendorError("Choose the dealers' den or the artist alley.");
    data.area = body.area;
  }
  if (body.businessName !== undefined || creating) {
    data.businessName = text(body.businessName, 120);
    if (!data.businessName) throw new VendorError('Enter your business or artist name.');
  }
  if (body.description !== undefined || creating) {
    data.description = String(body.description ?? '').trim().slice(0, 3000);
    if (creating && data.description.length < 20) throw new VendorError('Tell us what you make or sell, in a sentence or two.');
  }
  if (body.portfolioUrls !== undefined) {
    const urls = (Array.isArray(body.portfolioUrls) ? body.portfolioUrls : String(body.portfolioUrls).split(/\s+/))
      .map((u) => String(u).trim()).filter(Boolean).slice(0, 8);
    const bad = urls.find((u) => !/^https?:\/\/\S+$/i.test(u));
    if (bad) throw new VendorError(`"${bad.slice(0, 60)}" isn't a web link. Links start with https://`);
    data.portfolioUrls = urls;
  }
  if (body.assistants !== undefined) data.assistants = text(body.assistants, 300);
  if (body.notes !== undefined) data.notes = String(body.notes ?? '').slice(0, 3000);
  if (body.tableTypeId !== undefined) data.tableTypeId = body.tableTypeId ? String(body.tableTypeId) : null;
  return data;
}

export function tableTypePayload(body, { creating = false } = {}) {
  const data = {};
  if (body.area !== undefined || creating) {
    if (!AREAS.includes(body.area)) throw new VendorError("Choose the dealers' den or the artist alley.");
    data.area = body.area;
  }
  if (body.name !== undefined || creating) {
    data.name = text(body.name, 120);
    if (!data.name) throw new VendorError('Name the table type, e.g. "Full table".');
  }
  if (body.description !== undefined) data.description = String(body.description ?? '').slice(0, 1000);
  if (body.price !== undefined) {
    const cents = Math.round(Number(body.price || 0) * 100);
    if (!Number.isInteger(cents) || cents < 0 || cents > 10_000_00) throw new VendorError('Enter the table fee in dollars.');
    if (cents > 0 && cents < 50) throw new VendorError('Paid tables must cost at least $0.50.');
    data.priceCents = cents;
  }
  if (body.currency !== undefined) data.currency = text(body.currency, 3).toLowerCase() || 'usd';
  if (body.quantity !== undefined || creating) {
    const n = Number(body.quantity);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new VendorError('How many of these tables are there?');
    data.quantity = n;
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;
  return data;
}

/// Accepts an application onto a table type. The type's row is locked
/// while counting, so two reviewers can't hand out the last table twice.
/// A free table is confirmed straight away; a paid one waits for the fee.
export async function acceptApplication({ applicationId, tableTypeId, actorId, reviewNote }) {
  return prisma.$transaction(async (tx) => {
    const app = await tx.vendorApplication.findUnique({ where: { id: applicationId } });
    if (!app) throw new VendorError('Application not found.');
    if (!['SUBMITTED', 'WAITLISTED'].includes(app.status)) throw new VendorError('This application was already decided or withdrawn.');
    const typeId = tableTypeId || app.tableTypeId;
    if (!typeId) throw new VendorError('Choose which table to give them.');
    await tx.$queryRaw`SELECT id FROM "VendorTableType" WHERE id = ${typeId} FOR UPDATE`;
    const type = await tx.vendorTableType.findFirst({ where: { id: typeId, eventId: app.eventId } });
    if (!type) throw new VendorError('That table type isn\'t part of this event.');
    if (type.area !== app.area) throw new VendorError('That table type is for the other area.');
    const taken = await tx.vendorApplication.count({ where: { tableTypeId: type.id, status: { in: HOLDS_TABLE } } });
    if (taken >= type.quantity) throw new VendorError(`All ${type.quantity} ${type.name} tables are taken. Waitlist them, or add more tables.`);
    const { count } = await tx.vendorApplication.updateMany({
      where: { id: app.id, status: { in: ['SUBMITTED', 'WAITLISTED'] } },
      data: {
        status: type.priceCents ? 'ACCEPTED' : 'CONFIRMED', tableTypeId: type.id, feeCents: type.priceCents, currency: type.currency,
        decidedAt: new Date(), decidedById: actorId, ...(reviewNote !== undefined ? { reviewNote: String(reviewNote).slice(0, 3000) } : {}),
      },
    });
    if (!count) throw new VendorError('This application was already decided or withdrawn.');
    return tx.vendorApplication.findUnique({ where: { id: app.id }, include: { event: true, user: true, tableType: true } });
  });
}

/// Paid so far, net of refunds.
export const paidCents = (payments = []) => payments
  .filter((p) => ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status))
  .reduce((sum, p) => sum + p.amountCents - p.amountRefundedCents, 0);
