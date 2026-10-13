import { prisma } from './db.js';

export class ScheduleError extends Error {}

const text = (v, max) => String(v ?? '').trim().slice(0, max);

/// Validates a session create/update. Times are both set or both empty (an
/// unscheduled draft); `toUtc` reads datetime-local strings in the event's
/// timezone. `current` is the session being edited, if any.
export async function sessionPayload(body, { eventId, toUtc, current = null }) {
  const data = {};
  if (body.title !== undefined || !current) {
    data.title = text(body.title, 200);
    if (!data.title) throw new ScheduleError('Give the session a title.');
  }
  if (body.description !== undefined) data.description = String(body.description ?? '').slice(0, 5000);
  if (body.hosts !== undefined) data.hosts = text(body.hosts, 300);
  if (body.track !== undefined) data.track = text(body.track, 60) || null;
  if (body.published !== undefined) data.published = Boolean(body.published);
  if (body.roomId !== undefined) {
    if (body.roomId) {
      const room = await prisma.eventRoom.findFirst({ where: { id: String(body.roomId), eventId } });
      if (!room) throw new ScheduleError('That room isn\'t part of this event.');
      data.roomId = room.id;
    } else data.roomId = null;
  }
  for (const k of ['startsAt', 'endsAt']) {
    if (body[k] === undefined) continue;
    data[k] = body[k] ? toUtc(body[k]) : null;
    if (data[k] && Number.isNaN(data[k].getTime())) throw new ScheduleError('That is not a valid date and time.');
  }
  const startsAt = data.startsAt !== undefined ? data.startsAt : current?.startsAt ?? null;
  const endsAt = data.endsAt !== undefined ? data.endsAt : current?.endsAt ?? null;
  if (Boolean(startsAt) !== Boolean(endsAt)) throw new ScheduleError('Give the session both a start and an end, or neither to leave it unscheduled.');
  if (startsAt && endsAt <= startsAt) throw new ScheduleError('The session has to end after it starts.');

  const roomId = data.roomId !== undefined ? data.roomId : current?.roomId ?? null;
  if (roomId && startsAt) {
    const clash = await prisma.scheduleSession.findFirst({
      where: { roomId, id: current ? { not: current.id } : undefined, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      include: { room: true },
    });
    if (clash) throw new ScheduleError(`${clash.room.name} already has "${clash.title}" then.`);
  }
  return data;
}

export function submissionPayload(body, { creating = false } = {}) {
  const data = {};
  if (body.title !== undefined || creating) {
    data.title = text(body.title, 200);
    if (!data.title) throw new ScheduleError('Give your panel a title.');
  }
  if (body.description !== undefined || creating) {
    data.description = String(body.description ?? '').trim().slice(0, 3000);
    if (creating && data.description.length < 20) throw new ScheduleError('Describe the panel in a sentence or two, as it would appear on the schedule.');
  }
  if (body.hosts !== undefined) data.hosts = text(body.hosts, 300);
  if (body.availability !== undefined) data.availability = text(body.availability, 500);
  if (body.notes !== undefined) data.notes = String(body.notes ?? '').slice(0, 3000);
  if (body.lengthMinutes !== undefined) {
    const n = Number(body.lengthMinutes);
    if (![30, 45, 60, 90, 120].includes(n)) throw new ScheduleError('Choose a length: 30, 45, 60, 90, or 120 minutes.');
    data.lengthMinutes = n;
  }
  return data;
}

/// Whether the submission form takes new panels right now.
export const submissionsAccepting = (event, now = new Date()) =>
  event.submissionsOpen && (!event.submissionsCloseAt || event.submissionsCloseAt > now);
