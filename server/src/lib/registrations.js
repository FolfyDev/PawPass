import { prisma } from './db.js';
import { ticketCode, ticketSecret } from './codes.js';

export class RegistrationError extends Error {}

const PAYMENT_METHODS = ['CASH', 'CARD', 'PAYPAL', 'OTHER'];

export function validateAnswers(event, answers = {}) {
  const fields = Array.isArray(event.customFields) ? event.customFields : [];
  const clean = {};
  for (const f of fields) {
    const value = answers[f.key];
    const empty = value === undefined || value === null || value === '';
    if (f.required && empty) throw new RegistrationError(`${f.label} is required.`);
    if (!empty) clean[f.key] = value;
  }
  return clean;
}

export function registrationWindowState(event, confirmedCount) {
  const now = new Date();
  if (!event.published) return { open: false, reason: 'Registration is not open yet.' };
  if (event.opensAt && now < event.opensAt)
    return { open: false, reason: `Registration opens ${event.opensAt.toISOString()}.` };
  if (event.closesAt && now > event.closesAt)
    return { open: false, reason: 'Registration has closed.' };
  if (event.capacity && confirmedCount >= event.capacity) {
    return event.waitlistEnabled
      ? { open: true, waitlist: true, reason: 'This event is full — you will join the waitlist.' }
      : { open: false, reason: 'This event is full.' };
  }
  return { open: true, waitlist: false };
}

export async function createRegistration({ event, user, legalName, fursonaName, email, answers, source, tosVersion, tier, paymentMethod, paymentAmount, paymentNote, voucherCode }) {
  const existing = await prisma.registration.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: user.id } },
  });
  if (existing && existing.status !== 'CANCELLED')
    throw new RegistrationError('You are already registered for this event.');

  // A valid voucher grants a free, guaranteed-confirmed spot regardless of
  // capacity/waitlist/registration window — organizers and other special
  // badge holders need to get in regardless of the public registration state.
  let voucher = null;
  if (voucherCode) {
    voucher = await prisma.voucherCode.findFirst({
      where: { eventId: event.id, code: voucherCode.trim().toUpperCase() },
    });
    if (!voucher) throw new RegistrationError('That voucher code is not valid for this event.');
    if (voucher.usedCount >= voucher.maxUses) throw new RegistrationError('That voucher code has already been used.');
  }

  let chosenTier, status;
  if (voucher) {
    chosenTier = 'FREE';
    status = 'CONFIRMED';
  } else {
    const confirmedCount = await prisma.registration.count({
      where: { eventId: event.id, status: 'CONFIRMED' },
    });
    const state = registrationWindowState(event, confirmedCount);
    if (!state.open) throw new RegistrationError(state.reason);
    chosenTier = event.donationRequired ? 'DONATION' : tier === 'DONATION' ? 'DONATION' : 'FREE';
    if (chosenTier === 'DONATION' && !event.donationPaypalLink)
      throw new RegistrationError('The donation tier is not available for this event.');
    status = state.waitlist ? 'WAITLIST' : 'CONFIRMED';
  }

  const data = {
    legalName: legalName.trim(),
    fursonaName: (fursonaName || '').trim(),
    email: email?.trim() || null,
    answers: validateAnswers(event, answers),
    status,
    tier: chosenTier,
    rsvp: 'YES',
    source,
    tosAcceptedAt: new Date(),
    tosVersion: tosVersion || null,
    paymentMethod: chosenTier === 'DONATION' && PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : null,
    paymentAmount: chosenTier === 'DONATION' && paymentAmount != null && !isNaN(Number(paymentAmount)) ? Number(paymentAmount) : null,
    paymentNote: chosenTier === 'DONATION' ? (paymentNote?.trim() || null) : null,
    voucherCodeId: voucher?.id || null,
    badgeTier: voucher?.badgeTier || null,
  };

  // The voucher claim, the badge-number increment, and the registration
  // write all happen in one transaction — a limited-use voucher redeemed by
  // two people at once must not both succeed.
  return prisma.$transaction(async (tx) => {
    if (voucher) {
      const claimed = await tx.voucherCode.updateMany({
        where: { id: voucher.id, usedCount: { lt: voucher.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (claimed.count === 0) throw new RegistrationError('That voucher code has already been used.');
    }

    if (existing) {
      return tx.registration.update({ where: { id: existing.id }, data });
    }

    const updatedEvent = await tx.event.update({
      where: { id: event.id },
      data: { nextBadgeNumber: { increment: 1 } },
    });
    return tx.registration.create({
      data: {
        ...data,
        code: ticketCode(),
        secret: ticketSecret(),
        eventId: event.id,
        userId: user.id,
        badgeNumber: updatedEvent.nextBadgeNumber - 1,
      },
    });
  });
}

/// Creates the User a registration needs when there's no signed-in account to
/// attach it to — a staff walk-up at the door, or a guest checking out on the
/// web with no Telegram. There's no telegramId to dedupe on in either case,
/// so this checks for a same-event registration under the same name/email
/// instead, to catch someone accidentally registering twice.
export async function findOrCreateHeadlessUser({ eventId, legalName, fursonaName, email }) {
  const dup = await prisma.registration.findFirst({
    where: {
      eventId,
      status: { not: 'CANCELLED' },
      OR: [
        { legalName: { equals: legalName, mode: 'insensitive' } },
        ...(email ? [{ email: { equals: email, mode: 'insensitive' } }] : []),
      ],
    },
  });
  if (dup) throw new RegistrationError(`${dup.legalName} already has a registration for this event (code ${dup.code}).`);
  return prisma.user.create({ data: { displayName: legalName, legalName, fursonaName } });
}

/// Promotes the longest-waiting person when a confirmed spot frees up.
export async function promoteFromWaitlist(eventId) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event?.capacity) return null;
  const confirmed = await prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } });
  if (confirmed >= event.capacity) return null;
  const next = await prisma.registration.findFirst({
    where: { eventId, status: 'WAITLIST' },
    orderBy: { createdAt: 'asc' },
  });
  if (!next) return null;
  return prisma.registration.update({
    where: { id: next.id },
    data: { status: 'CONFIRMED' },
    include: { user: true, event: true },
  });
}
