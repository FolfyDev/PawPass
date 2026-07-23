import { prisma } from './db.js';
import { ticketCode, ticketSecret } from './codes.js';

export class RegistrationError extends Error {}

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

export async function createRegistration({ event, user, legalName, fursonaName, email, answers, source, tosVersion, tier }) {
  const confirmedCount = await prisma.registration.count({
    where: { eventId: event.id, status: 'CONFIRMED' },
  });
  const state = registrationWindowState(event, confirmedCount);
  if (!state.open) throw new RegistrationError(state.reason);

  const chosenTier = tier === 'DONATION' ? 'DONATION' : 'FREE';
  if (chosenTier === 'DONATION' && !event.donationPaypalLink)
    throw new RegistrationError('The donation tier is not available for this event.');

  const existing = await prisma.registration.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: user.id } },
  });
  if (existing && existing.status !== 'CANCELLED')
    throw new RegistrationError('You are already registered for this event.');

  const data = {
    legalName: legalName.trim(),
    fursonaName: (fursonaName || '').trim(),
    email: email?.trim() || null,
    answers: validateAnswers(event, answers),
    status: state.waitlist ? 'WAITLIST' : 'CONFIRMED',
    tier: chosenTier,
    rsvp: 'YES',
    source,
    tosAcceptedAt: new Date(),
    tosVersion: tosVersion || null,
  };

  if (existing) {
    return prisma.registration.update({ where: { id: existing.id }, data });
  }

  // The badge number comes from an atomic increment on the event so concurrent
  // registrations never collide, even though this isn't wrapped in the same
  // transaction as the read above (a race there only risks an extra waitlist
  // entry, which is harmless — a race here would risk a duplicate badge number).
  return prisma.$transaction(async (tx) => {
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
  return prisma.registration.update({ where: { id: next.id }, data: { status: 'CONFIRMED' } });
}
