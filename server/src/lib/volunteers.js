import { prisma } from './db.js';

export class VolunteerError extends Error {}

export const ATTENDANCE = ['PENDING', 'PRESENT', 'NO_SHOW'];

const MAX_NOTE = 500;

/// What anyone viewing the event page sees of a shift — counts only, never
/// who else signed up.
export function publicShift(s, mySignup = null) {
  return {
    id: s.id, role: s.role, description: s.description, location: s.location,
    startsAt: s.startsAt, endsAt: s.endsAt, slots: s.slots,
    remaining: Math.max(s.slots - s.filledCount, 0),
    mine: mySignup ? { id: mySignup.id, note: mySignup.note } : null,
  };
}

export const shiftHours = (s) => Math.max(0, (new Date(s.endsAt) - new Date(s.startsAt)) / 3_600_000);

/// Takes a slot on a shift. The slot is claimed with a compare-and-swap on
/// filledCount inside the same transaction as the insert, so the last slot
/// can't go to two people, and a failed insert gives it back.
///
/// Overlapping shifts at the same event are refused — nobody can stand at
/// the door and the merch table at once. `byStaff` lets staff add someone
/// to a shift that has already started (a walk-up helper), but not past the
/// slot limit; raise the slots first.
export async function signUpForShift({ shiftId, userId, note, source = 'web', byStaff = false }) {
  const [who, whoShort] = byStaff ? ['They are', "they're"] : ['You are', "you're"];
  try {
    return await prisma.$transaction(async (tx) => {
      const shift = await tx.volunteerShift.findUnique({ where: { id: shiftId } });
      if (!shift) throw new VolunteerError('Shift not found.');
      if (!byStaff && shift.startsAt <= new Date()) throw new VolunteerError('This shift has already started.');

      const existing = await tx.volunteerSignup.findUnique({ where: { shiftId_userId: { shiftId, userId } } });
      if (existing) throw new VolunteerError(`${who} already signed up for this shift.`);

      const clash = await tx.volunteerSignup.findFirst({
        where: { userId, shift: { eventId: shift.eventId, startsAt: { lt: shift.endsAt }, endsAt: { gt: shift.startsAt } } },
        include: { shift: true },
      });
      if (clash) throw new VolunteerError(`That overlaps with the ${clash.shift.role} shift ${whoShort} already on.`);

      const claimed = await tx.volunteerShift.updateMany({
        where: { id: shift.id, filledCount: { lt: shift.slots } },
        data: { filledCount: { increment: 1 } },
      });
      if (claimed.count === 0) throw new VolunteerError('This shift is full.');

      return tx.volunteerSignup.create({
        data: { shiftId, userId, source, note: String(note || '').trim().slice(0, MAX_NOTE) || null },
        include: { shift: true },
      });
    });
  } catch (e) {
    // Two requests from the same person at once: the unique index catches
    // the second, and the transaction already gave its slot back.
    if (e.code === 'P2002') throw new VolunteerError(`${who} already signed up for this shift.`);
    throw e;
  }
}

/// Removes a sign-up and frees its slot. Only frees it if this call is the
/// one that actually deleted the row, so a double-click can't free two.
export async function dropSignup(signup) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.volunteerSignup.deleteMany({ where: { id: signup.id } });
    if (count) await tx.volunteerShift.update({ where: { id: signup.shiftId }, data: { filledCount: { decrement: 1 } } });
  });
}

/// Validates the editable fields of a shift. `toUtc` turns a datetime-local
/// string into an instant in the event's own timezone (see lib/tz.js).
/// `current` is the shift being edited, if any, so a partial update can be
/// checked against the values it isn't changing.
export function shiftPayload(body, toUtc, current = null) {
  const data = {};
  if (body.role !== undefined) {
    data.role = String(body.role || '').trim().slice(0, 120);
    if (!data.role) throw new VolunteerError('Give the shift a role, e.g. "Door crew".');
  }
  if (body.description !== undefined) data.description = String(body.description || '').slice(0, 2000);
  if (body.location !== undefined) data.location = String(body.location || '').trim().slice(0, 200) || null;
  for (const k of ['startsAt', 'endsAt']) {
    if (body[k] === undefined) continue;
    if (!body[k]) throw new VolunteerError('A shift needs a start and an end time.');
    data[k] = toUtc(body[k]);
    if (Number.isNaN(data[k].getTime())) throw new VolunteerError('That is not a valid date and time.');
  }
  if (body.slots !== undefined) {
    const slots = Number(body.slots);
    if (!Number.isInteger(slots) || slots < 1 || slots > 1000) throw new VolunteerError('Slots must be a whole number from 1 to 1000.');
    if (current && slots < current.filledCount)
      throw new VolunteerError(`${current.filledCount} people are already signed up. Remove some before lowering the slots below that.`);
    data.slots = slots;
  }
  const startsAt = data.startsAt ?? current?.startsAt;
  const endsAt = data.endsAt ?? current?.endsAt;
  if (!current && (!data.role || !startsAt || !endsAt || data.slots === undefined))
    throw new VolunteerError('A shift needs a role, a start and end time, and a number of slots.');
  if (startsAt && endsAt && endsAt <= startsAt) throw new VolunteerError('The shift has to end after it starts.');
  return data;
}

/// Name and contact details for the staff roster. User fields are decrypted
/// by the prisma extension (lib/db.js) when the user relation is included.
export function shapeVolunteer(u) {
  return {
    id: u.id,
    name: u.fursonaName || u.displayName,
    legalName: u.legalName,
    email: u.email,
    telegramUsername: u.telegramUsername,
  };
}
