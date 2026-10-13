import { prisma } from './db.js';

/// The public "wait at the door" estimate. Check-in speed alone can't tell
/// how long the line is, so door staff report roughly how many people are
/// waiting (from the scanner), and the wait is that line divided by the
/// recent check-in pace. Shown only while the event is on and the count is
/// recent; otherwise it would be a guess dressed up as a number.

const FRESH_FOR = 20 * 60_000;
const PACE_WINDOW = 15 * 60_000;
export const MAX_LINE = 5000;

export async function setDoorLine(eventId, count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LINE) throw new Error(`Enter how many people are in line, 0 to ${MAX_LINE}.`);
  return prisma.event.update({ where: { id: eventId }, data: { doorLineCount: n, doorLineAt: new Date() }, select: { doorLineCount: true, doorLineAt: true } });
}

/// { line, perMinute, minutes, updatedAt }, or null when there's nothing honest to show.
/// minutes is null when people are waiting but nobody has been let in lately.
export async function doorWait(event, now = new Date()) {
  if (now < event.startsAt || now > event.endsAt) return null;
  if (event.doorLineCount == null || !event.doorLineAt || now - event.doorLineAt > FRESH_FOR) return null;
  const scans = await prisma.checkIn.count({
    where: { eventId: event.id, direction: 'ENTRY', at: { gte: new Date(now.getTime() - PACE_WINDOW) } },
  });
  const perMinute = scans / (PACE_WINDOW / 60_000);
  const line = event.doorLineCount;
  const minutes = line === 0 ? 0 : perMinute > 0 ? Math.max(1, Math.round(line / perMinute)) : null;
  return { line, perMinute: Math.round(perMinute * 10) / 10, minutes, updatedAt: event.doorLineAt };
}
