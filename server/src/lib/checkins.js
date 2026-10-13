import crypto from 'node:crypto';
import { prisma } from './db.js';

export class ScanError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const DIRECTIONS = ['ENTRY', 'EXIT'];

/// YYYY-MM-DD of an instant in a timezone — the same day convention as
/// CheckIn.day and TicketTier.validDays.
export function dayIn(date, timeZone) {
  try {
    return new Date(date).toLocaleDateString('en-CA', { timeZone });
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/// Every calendar day the event touches, in its timezone.
export function eventDays(event) {
  const days = [];
  const last = dayIn(event.endsAt, event.timezone);
  for (let d = dayIn(event.startsAt, event.timezone); d <= last && days.length < 60; d = addDays(d, 1)) days.push(d);
  return days;
}

/// "Sat, May 4" for a YYYY-MM-DD day.
export const dayLabel = (day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/// What goes in the offline manifest instead of the QR secret itself.
export const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

/// The rules for one scan, with no database access, so the offline scanner
/// (web/src/lib/offlineCheckin.js) can apply exactly the same ones. Keep the
/// two in step.
///
/// `scansToday` is this ticket's scans for `day`, oldest first. Returns
/// null when the scan is allowed, or { code, message } when it isn't.
/// `force` (staff override) waives the day-pass and already-inside rules,
/// never the ticket's status.
export function scanProblem({ status, validDays = [], tierName }, direction, day, scansToday, force = false, timeZone = undefined) {
  if (status === 'CANCELLED') return { code: 'cancelled', message: 'This ticket was cancelled.' };
  if (status === 'WAITLIST') return { code: 'waitlist', message: 'This registration is on the waitlist and has no confirmed spot.' };
  if (status === 'PENDING_PAYMENT') return { code: 'unpaid', message: 'This ticket\'s online payment never completed.' };

  const last = scansToday[scansToday.length - 1];
  const inside = last?.direction === 'ENTRY';
  if (direction === 'EXIT') {
    return inside ? null : { code: 'not_inside', message: 'This ticket isn\'t checked in right now, so it can\'t be scanned out.' };
  }
  if (force) return null;
  if (validDays.length && !validDays.includes(day)) {
    const days = validDays.map(dayLabel).join(', ');
    return { code: 'wrong_day', message: `${tierName || 'This ticket'} is only valid on ${days}.` };
  }
  if (inside) {
    const at = new Date(last.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
    return { code: 'already_inside', message: `Already checked in today at ${at}, with no exit since.` };
  }
  return null;
}

/// Records one scan. The registration row is locked for the length of the
/// transaction, so two door scanners reading the same badge at the same
/// moment can't both let it in. `clientId` makes an offline sync safe to
/// retry: a scan already recorded is returned, not recorded twice.
///
/// Offline scans (`offline: true`) already happened at the door. They're
/// recorded even if the rules now say no (say the ticket was cancelled
/// while the scanner was offline) and come back with `problem` set so staff
/// can follow up.
export async function recordScan({ registrationId, direction = 'ENTRY', at = new Date(), byId, clientId, offline = false, force = false }) {
  if (!DIRECTIONS.includes(direction)) throw new ScanError('Unknown scan direction.', 'bad_direction');
  return prisma.$transaction(async (tx) => {
    if (clientId) {
      const seen = await tx.checkIn.findUnique({ where: { clientId } });
      if (seen) return { scan: seen, duplicate: true, problem: null };
    }
    await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
    const reg = await tx.registration.findUnique({ where: { id: registrationId }, include: { event: true, ticketTier: true } });
    if (!reg) throw new ScanError('No ticket matches that code.', 'not_found');

    const day = dayIn(at, reg.event.timezone);
    const scansToday = await tx.checkIn.findMany({ where: { registrationId, day }, orderBy: { at: 'asc' } });
    const problem = scanProblem(
      { status: reg.status, validDays: reg.ticketTier?.validDays || [], tierName: reg.tierName },
      direction, day, scansToday, force, reg.event.timezone,
    );
    if (problem && !offline) throw new ScanError(problem.message, problem.code);
    // The venue's limit is checked last and only for a live scan: an offline
    // scanner already applied it to its own count at the door.
    if (!problem && direction === 'ENTRY' && !force && !offline && reg.event.occupancyLimit) {
      // One count at a time per event, or two doors could each see the last
      // free spot and both let someone in. Released when the transaction ends.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`occupancy:${reg.eventId}`}))::text`;
      const { inside } = await todayCounts(reg.event, at, tx);
      if (inside >= reg.event.occupancyLimit) throw new ScanError(atCapacity(reg.event.occupancyLimit), 'at_capacity');
    }

    const scan = await tx.checkIn.create({
      data: {
        registrationId, eventId: reg.eventId, day, direction, at,
        scannedById: byId, offline, clientId: clientId || null,
        overridden: Boolean(force && direction === 'ENTRY'),
      },
    });
    if (direction === 'ENTRY' && (!reg.checkedInAt || at < reg.checkedInAt)) {
      await tx.registration.update({ where: { id: reg.id }, data: { checkedInAt: at, checkedInById: byId } });
    }
    return { scan, duplicate: false, problem };
  });
}

/// Takes back a ticket's most recent scan. If that leaves no entry at all,
/// the ticket goes back to "not arrived".
export async function undoLastScan(registrationId) {
  return prisma.$transaction(async (tx) => {
    const last = await tx.checkIn.findFirst({ where: { registrationId }, orderBy: { at: 'desc' } });
    if (!last) return null;
    await tx.checkIn.delete({ where: { id: last.id } });
    const first = await tx.checkIn.findFirst({ where: { registrationId, direction: 'ENTRY' }, orderBy: { at: 'asc' } });
    await tx.registration.update({
      where: { id: registrationId },
      data: first ? { checkedInAt: first.at, checkedInById: first.scannedById } : { checkedInAt: null, checkedInById: null },
    });
    return last;
  });
}

export const atCapacity = (limit) => `At the occupancy limit of ${limit}. Wait for someone to leave, or let them in anyway.`;

/// Who's inside now (latest scan today was an entry) and how many
/// different tickets entered today. `db` lets recordScan count inside its
/// own transaction.
export async function todayCounts(event, now = new Date(), db = prisma) {
  const day = dayIn(now, event.timezone);
  const [row] = await db.$queryRaw`
    SELECT
      count(*) FILTER (WHERE last_direction = 'ENTRY')::int AS inside,
      count(*) FILTER (WHERE entered)::int AS entered
    FROM (
      SELECT DISTINCT ON ("registrationId")
        "direction"::text AS last_direction,
        bool_or("direction" = 'ENTRY') OVER (PARTITION BY "registrationId") AS entered
      FROM "CheckIn"
      WHERE "eventId" = ${event.id} AND "day" = ${day}
      ORDER BY "registrationId", "at" DESC
    ) s`;
  return { day, inside: row.inside, entered: row.entered, limit: event.occupancyLimit ?? null };
}

/// Different tickets that came in, per day of the event.
export async function dailyAttendance(event) {
  const rows = await prisma.$queryRaw`
    SELECT "day", count(DISTINCT "registrationId")::int AS entered
    FROM "CheckIn"
    WHERE "eventId" = ${event.id} AND "direction" = 'ENTRY'
    GROUP BY "day"`;
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.entered]));
  const days = eventDays(event);
  for (const d of Object.keys(byDay)) if (!days.includes(d)) days.push(d);
  return days.sort().map((day) => ({ day, entered: byDay[day] || 0 }));
}
