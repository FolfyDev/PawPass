import fs from 'fs/promises';
import path from 'path';
import { prisma } from './db.js';
import { blindIndex } from './crypto.js';
import { audit } from './auth.js';
import { LIVE } from './hotels.js';

export class AccountError extends Error {}

/// Everything PawPass holds about a person, decrypted, as plain JSON — the
/// "download my data" the privacy policy promises.
export async function exportAccount(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const regs = await prisma.registration.findMany({
    where: { userId },
    include: { event: true, payments: { orderBy: { createdAt: 'asc' } }, checkIns: { orderBy: { at: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  const orders = await prisma.merchOrder.findMany({
    where: { userId },
    include: { event: true, items: true, payments: true },
    orderBy: { createdAt: 'asc' },
  });
  const shifts = await prisma.volunteerSignup.findMany({
    where: { userId },
    include: { shift: { include: { event: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const rooms = await prisma.roomReservation.findMany({
    where: { userId },
    include: { block: { include: { hotel: { include: { event: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const vendorApps = await prisma.vendorApplication.findMany({ where: { userId }, include: { event: true, tableType: true, payments: true }, orderBy: { createdAt: 'asc' } });
  const [submissions, stars] = await Promise.all([
    prisma.panelSubmission.findMany({ where: { userId }, include: { event: true }, orderBy: { createdAt: 'asc' } }),
    prisma.sessionStar.findMany({ where: { userId }, include: { session: { include: { event: true } } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const pay = (p) => ({
    method: p.method, status: p.status, amount: p.amountCents / 100, refunded: p.amountRefundedCents / 100,
    currency: p.currency, paidAt: p.paidAt, stripeReference: p.stripePaymentIntentId,
  });
  return {
    exportedAt: new Date().toISOString(),
    account: {
      displayName: user.displayName, legalName: user.legalName, fursonaName: user.fursonaName, email: user.email,
      telegramId: user.telegramId, telegramUsername: user.telegramUsername, role: user.role, createdAt: user.createdAt,
    },
    registrations: regs.map((r) => ({
      event: r.event.title, eventStartsAt: r.event.startsAt, code: r.code, status: r.status, ticket: r.tierName,
      legalName: r.legalName, fursonaName: r.fursonaName, email: r.email, answers: r.answers, rsvp: r.rsvp,
      badgeTier: r.badgeTier, checkedInAt: r.checkedInAt, registeredAt: r.createdAt, termsAcceptedAt: r.tosAcceptedAt,
      payments: r.payments.map(pay),
      doorScans: r.checkIns.map((c) => ({ day: c.day, direction: c.direction, at: c.at })),
    })),
    merchPreorders: orders.map((o) => ({
      event: o.event.title, status: o.status, pickedUpAt: o.pickedUpAt, orderedAt: o.createdAt,
      items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.unitPriceCents / 100 })),
      payments: o.payments.map(pay),
    })),
    volunteerShifts: shifts.map((s) => ({
      event: s.shift.event.title, role: s.shift.role, startsAt: s.shift.startsAt, endsAt: s.shift.endsAt,
      location: s.shift.location, note: s.note, attendance: s.attendance, signedUpAt: s.createdAt,
    })),
    panelSubmissions: submissions.map((s) => ({
      event: s.event.title, title: s.title, description: s.description, hosts: s.hosts, lengthMinutes: s.lengthMinutes,
      availability: s.availability, notes: s.notes, status: s.status, submittedAt: s.createdAt,
    })),
    vendorApplications: vendorApps.map((a) => ({
      event: a.event.title, area: a.area, businessName: a.businessName, description: a.description, portfolioUrls: a.portfolioUrls,
      assistants: a.assistants, notes: a.notes, status: a.status, table: a.tableType?.name, tableNumber: a.tableNumber,
      fee: a.feeCents != null ? a.feeCents / 100 : null, appliedAt: a.createdAt, payments: a.payments.map(pay),
    })),
    starredSessions: stars.map((s) => ({ event: s.session.event.title, session: s.session.title, startsAt: s.session.startsAt })),
    hotelRooms: rooms.map((r) => ({
      event: r.block.hotel.event.title, hotel: r.block.hotel.name, roomType: r.block.name,
      checkIn: r.checkIn, checkOut: r.checkOut, guests: r.guests, guestName: r.guestName, roommates: r.roommates,
      note: r.note, status: r.status, confirmationNumber: r.confirmationNumber, requestedAt: r.createdAt,
    })),
  };
}

/// "Delete my account". Payment records have to be kept for bookkeeping, so
/// rather than deleting rows this strips everything that identifies the
/// person: names, email, Telegram, answers. The account can't be signed into
/// again (no email, no Telegram, sessions revoked).
///
/// Refused while they still have a live ticket or pre-order for an event
/// that hasn't ended. Cancelling first keeps refunds and seats straight.
/// Staff accounts are refused too, so an owner can't lock everyone out.
export async function deleteAccount(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AccountError('Account not found.');
  if (user.role !== 'USER') throw new AccountError('Staff accounts have to be removed by another owner.');

  const now = new Date();
  const live = await prisma.registration.findMany({
    where: { userId, status: { not: 'CANCELLED' }, event: { endsAt: { gt: now } } },
    include: { event: true },
  });
  if (live.length) {
    throw new AccountError(`Cancel your ticket${live.length === 1 ? '' : 's'} first: ${[...new Set(live.map((r) => r.event.title))].join(', ')}.`);
  }
  const orders = await prisma.merchOrder.count({
    where: { userId, OR: [{ status: 'PENDING' }, { status: 'PAID', pickedUpAt: null, event: { endsAt: { gt: now } } }] },
  });
  if (orders) throw new AccountError('You have a pre-order waiting. Pick it up or ask the organizers to refund it first.');
  const shifts = await prisma.volunteerSignup.count({ where: { userId, shift: { endsAt: { gt: now } } } });
  const rooms = await prisma.roomReservation.count({ where: { userId, status: { in: LIVE }, block: { hotel: { event: { endsAt: { gt: now } } } } } });
  if (rooms) throw new AccountError('Cancel your hotel room first, or ask the organizers to.');
  const tables = await prisma.vendorApplication.count({ where: { userId, status: { in: ['ACCEPTED', 'CONFIRMED'] }, event: { endsAt: { gt: now } } } });
  if (tables) throw new AccountError('You have a vendor table for an upcoming event. Ask the organizers to cancel it first.');
  if (shifts) throw new AccountError(`Drop your volunteer shift${shifts === 1 ? '' : 's'} first, so the organizers know to find someone else.`);

  await prisma.$transaction(async (tx) => {
    for (const reg of await tx.registration.findMany({ where: { userId }, select: { id: true } })) {
      await tx.registration.update({
        where: { id: reg.id },
        data: { legalName: 'Deleted user', fursonaName: '', email: null, answers: {}, cancelRequestNote: null },
      });
    }
    // Past shifts stay for the organizers' hour counts; the note is the only
    // free text on them.
    await tx.volunteerSignup.updateMany({ where: { userId }, data: { note: null } });
    // Past rooms stay for the organizers' pickup history, without the guest.
    for (const room of await tx.roomReservation.findMany({ where: { userId }, select: { id: true } })) {
      await tx.roomReservation.update({ where: { id: room.id }, data: { guestName: 'Deleted user', roommates: '', note: null } });
    }
    if (user.telegramId) {
      await tx.loginCode.deleteMany({ where: { telegramId: user.telegramId } });
      await tx.botSession.deleteMany({ where: { telegramId: user.telegramId } });
    }
    if (user.email) await tx.emailLoginCode.deleteMany({ where: { emailIndex: blindIndex(user.email) } });
    await tx.user.update({
      where: { id: userId },
      data: {
        displayName: 'Deleted user', legalName: null, fursonaName: null, email: null,
        telegramId: null, telegramUsername: null, telegramPhotoUrl: null, passwordHash: null,
        tokenVersion: { increment: 1 },
      },
    });
  });

  if (user.telegramId) {
    await fs.unlink(path.join(process.cwd(), 'uploads', `tg-${user.telegramId}.webp`)).catch(() => {});
  }
  await audit(null, 'user.self_delete', userId, {});
}
