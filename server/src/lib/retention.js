import { prisma } from './db.js';
import { audit } from './auth.js';

/// Automatic clean-up of personal data a set number of months after each
/// event ends. Off until an owner picks a period.
///
/// Cleared: names, emails, and question answers on registrations (and
/// cancellation notes), hotel guest names, roommates and notes, and
/// volunteer notes. Kept: payments (bookkeeping), check-in scans, badge
/// numbers, and counts, so reports still add up. Incident reports are kept
/// too — they're safety records and aren't covered by this setting.
///
/// The setting lives in its own Setting row rather than DEFAULT_SETTINGS,
/// which is served publicly at /api/settings.

const KEY = 'dataRetention';
export const RETENTION_CHOICES = [3, 6, 12, 24];
export const REMOVED = 'Removed';

export async function getRetention() {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const months = row?.value?.months;
  return { months: RETENTION_CHOICES.includes(months) ? months : null };
}

export async function setRetention(months) {
  const value = { months: months == null ? null : Number(months) };
  if (value.months != null && !RETENTION_CHOICES.includes(value.months)) throw new Error(`Choose ${RETENTION_CHOICES.join(', ')} months, or off.`);
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return getRetention();
}

export function cutoffFor(months, now = new Date()) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d;
}

/// Events past the retention period that still hold personal data.
export async function eventsDue(months, now = new Date()) {
  if (!months) return [];
  const events = await prisma.event.findMany({
    where: { endsAt: { lt: cutoffFor(months, now) }, dataPurgedAt: null },
    select: { id: true, title: true, endsAt: true, _count: { select: { registrations: true } } },
    orderBy: { endsAt: 'asc' },
  });
  return events.map((e) => ({ id: e.id, title: e.title, endsAt: e.endsAt, registrations: e._count.registrations }));
}

/// Clears one event's personal data. Bulk updates with a fixed value: the
/// encryption extension (lib/db.js) encrypts it like any other write, and
/// "Removed" isn't a secret.
export async function purgeEvent(eventId, actorId = null) {
  const counts = await prisma.$transaction(async (tx) => {
    const regs = await tx.registration.updateMany({
      where: { eventId },
      data: { legalName: REMOVED, fursonaName: '', email: null, answers: {}, cancelRequestNote: null },
    });
    const rooms = await tx.roomReservation.updateMany({
      where: { block: { hotel: { eventId } } },
      data: { guestName: REMOVED, roommates: '', note: null, staffNote: null },
    });
    const volunteers = await tx.volunteerSignup.updateMany({ where: { shift: { eventId } }, data: { note: null } });
    await tx.event.update({ where: { id: eventId }, data: { dataPurgedAt: new Date() } });
    return { registrations: regs.count, rooms: rooms.count, volunteerNotes: volunteers.count };
  }, { timeout: 60_000 });
  await audit(actorId, 'data.purge', eventId, counts);
  return counts;
}

/// Runs the retention setting: clears every event that's due.
export async function purgeDue(now = new Date(), actorId = null) {
  const { months } = await getRetention();
  const due = await eventsDue(months, now);
  const done = [];
  for (const e of due) done.push({ ...e, ...(await purgeEvent(e.id, actorId)) });
  return done;
}

/// Checks a minute after start, then every 6 hours. Nothing to do is the
/// common case, and it's two small queries.
export function startRetentionJob() {
  const run = () => purgeDue().then((done) => {
    if (done.length) console.log(`data retention: cleared ${done.length} event(s)`);
  }).catch((e) => console.error('data retention failed', e.message));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 6 * 3600_000);
  first.unref();
  timer.unref();
  return timer;
}
