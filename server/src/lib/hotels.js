import { prisma } from './db.js';

export class HotelError extends Error {}

export const BLOCK_MODES = ['HOTEL_BOOKED', 'ORGANIZER_MANAGED'];
/// Reservations that are holding a room.
export const LIVE = ['REQUESTED', 'CONFIRMED'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NIGHTS = 21;

/// A real calendar date, so "2026-02-30" doesn't sneak through the regex.
export function isDate(s) {
  if (!DATE.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/// The nights a stay covers: check-in up to, not including, check-out.
export function nightsBetween(checkIn, checkOut) {
  if (!isDate(checkIn) || !isDate(checkOut)) throw new HotelError('Pick a check-in and a check-out date.');
  if (checkOut <= checkIn) throw new HotelError('Check-out has to be after check-in.');
  const nights = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    nights.push(d);
    if (nights.length > MAX_NIGHTS) throw new HotelError(`A stay can be at most ${MAX_NIGHTS} nights.`);
  }
  return nights;
}

export const checkOutAfter = (night) => addDays(night, 1);

/// Today's date where the event is, as YYYY-MM-DD.
export const todayIn = (timeZone) => new Date().toLocaleDateString('en-CA', { timeZone });

export const cutoffPassed = (block) => !!block.cutoffAt && block.cutoffAt <= new Date();

/// Whether this person gets the booking details / can request a room in an
/// attendees-only block: a confirmed ticket for the event, or staff.
export async function eligibleForBlocks(eventId, user) {
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'OWNER') return true;
  const reg = await prisma.registration.findUnique({ where: { eventId_userId: { eventId, userId: user.id } } });
  return reg?.status === 'CONFIRMED';
}

const text = (v, max) => String(v ?? '').trim().slice(0, max);

/// Takes a room for every night of the stay. Each night is claimed with a
/// compare-and-swap on `held` inside one transaction, so the block can't be
/// oversold, and a stay that runs into one full night claims none of them.
///
/// Self-service is one live room per person per event and closes at the
/// block's cutoff; `byStaff` skips both (staff booking a second room for a
/// guest of honour, or a late add the hotel agreed to).
export async function reserveRoom({ blockId, userId, checkIn, checkOut, guests, guestName, roommates, note, staffNote, source = 'web', byStaff = false }) {
  const nights = nightsBetween(checkIn, checkOut);
  const name = text(guestName, 120);
  if (!name) throw new HotelError('Enter the name the room should be booked under.');

  return prisma.$transaction(async (tx) => {
    const block = await tx.roomBlock.findUnique({ where: { id: blockId }, include: { hotel: true, nights: true } });
    if (!block) throw new HotelError('Room block not found.');
    if (block.mode !== 'ORGANIZER_MANAGED') throw new HotelError('Rooms in this block are booked directly with the hotel.');
    if (!byStaff && (!block.active || cutoffPassed(block))) throw new HotelError('Requests for this block have closed.');

    const guestCount = guests === undefined || guests === '' ? 1 : Number(guests);
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > block.maxGuests)
      throw new HotelError(`A room here takes 1 to ${block.maxGuests} guests.`);

    if (!byStaff) {
      const existing = await tx.roomReservation.findFirst({
        where: { userId, status: { in: LIVE }, block: { hotel: { eventId: block.hotel.eventId } } },
      });
      if (existing) throw new HotelError('You already have a room for this event. Cancel it first to book a different one.');
    }

    for (const night of nights) {
      const n = block.nights.find((x) => x.night === night);
      if (!n) throw new HotelError(`This block doesn't cover the night of ${night}.`);
      const { count } = await tx.roomBlockNight.updateMany({
        where: { id: n.id, held: { lt: n.contracted } },
        data: { held: { increment: 1 } },
      });
      if (!count) throw new HotelError(`The block is full on the night of ${night}.`);
    }

    return tx.roomReservation.create({
      data: {
        blockId, userId, checkIn, checkOut, guests: guestCount, source,
        guestName: name,
        roommates: text(roommates, 500),
        note: text(note, 500) || null,
        staffNote: text(staffNote, 500) || null,
      },
    });
  });
}

/// Cancels a reservation and hands its nights back to the block. Only the
/// call that actually flips the status releases them, so a double-click
/// can't free a night twice.
export async function cancelReservation(reservation) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.roomReservation.updateMany({
      where: { id: reservation.id, status: { in: LIVE } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (!count) return;
    await tx.roomBlockNight.updateMany({
      where: { blockId: reservation.blockId, night: { in: nightsBetween(reservation.checkIn, reservation.checkOut) } },
      data: { held: { decrement: 1 } },
    });
  });
}

/// Contracted vs picked-up room nights for a block. Pickup is the live
/// reservations for an organizer-managed block, and whatever the hotel last
/// reported for a hotel-booked one.
export function blockTotals(block) {
  const pickupOf = (n) => (block.mode === 'ORGANIZER_MANAGED' ? n.held : (n.reportedPickup ?? 0));
  const contracted = block.nights.reduce((sum, n) => sum + n.contracted, 0);
  const pickedUp = block.nights.reduce((sum, n) => sum + pickupOf(n), 0);
  const pickupPercent = contracted ? Math.round((pickedUp / contracted) * 100) : 0;
  const required = block.attritionPercent ? Math.ceil((contracted * block.attritionPercent) / 100) : null;
  return {
    contracted, pickedUp, pickupPercent, required,
    shortfall: required != null ? Math.max(required - pickedUp, 0) : null,
    nights: block.nights.map((n) => ({ ...n, pickup: pickupOf(n) })),
  };
}

export function hotelPayload(body, current = null) {
  const data = {};
  if (body.name !== undefined) {
    data.name = text(body.name, 160);
    if (!data.name) throw new HotelError('Give the hotel a name.');
  }
  if (!current && !data.name) throw new HotelError('Give the hotel a name.');
  for (const k of ['address', 'phone']) if (body[k] !== undefined) data[k] = text(body[k], 300) || null;
  if (body.url !== undefined) data.url = link(body.url, 'The hotel website');
  if (body.description !== undefined) data.description = String(body.description || '').slice(0, 3000);
  if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;
  return data;
}

function link(v, label) {
  const url = text(v, 1000);
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new HotelError(`${label} must start with http:// or https://.`);
  return url || null;
}

/// `toUtc` reads the cutoff's datetime-local string in the event's timezone.
export function blockPayload(body, toUtc, current = null) {
  const data = {};
  if (body.name !== undefined) {
    data.name = text(body.name, 120);
    if (!data.name) throw new HotelError('Give the block a room type, e.g. "King".');
  }
  if (!current && !data.name) throw new HotelError('Give the block a room type, e.g. "King".');
  if (body.description !== undefined) data.description = String(body.description || '').slice(0, 2000);
  if (body.staffNotes !== undefined) data.staffNotes = String(body.staffNotes || '').slice(0, 5000);
  if (body.rate !== undefined) {
    const rate = Number(body.rate || 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100000) throw new HotelError('Enter the nightly rate in dollars.');
    data.rateCents = Math.round(rate * 100);
  }
  if (body.currency !== undefined) data.currency = text(body.currency, 3).toLowerCase() || 'usd';
  if (body.mode !== undefined) {
    if (!BLOCK_MODES.includes(body.mode)) throw new HotelError('Choose how rooms in this block get booked.');
    if (current && current.mode !== body.mode && current.nights?.some((n) => n.held > 0))
      throw new HotelError('People have requested rooms in this block. Cancel them before changing how it is booked.');
    data.mode = body.mode;
  }
  if (body.bookingUrl !== undefined) data.bookingUrl = link(body.bookingUrl, 'The booking link');
  if (body.groupCode !== undefined) data.groupCode = text(body.groupCode, 80) || null;
  if (body.cutoffAt !== undefined) data.cutoffAt = body.cutoffAt ? toUtc(body.cutoffAt) : null;
  if (body.maxGuests !== undefined) {
    const n = Number(body.maxGuests);
    if (!Number.isInteger(n) || n < 1 || n > 12) throw new HotelError('Guests per room must be from 1 to 12.');
    data.maxGuests = n;
  }
  if (body.attritionPercent !== undefined) {
    if (body.attritionPercent === '' || body.attritionPercent === null) data.attritionPercent = null;
    else {
      const n = Number(body.attritionPercent);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new HotelError('The pickup target is a percentage from 1 to 100.');
      data.attritionPercent = n;
    }
  }
  for (const k of ['attendeesOnly', 'active']) if (body[k] !== undefined) data[k] = Boolean(body[k]);
  return data;
}

/// Replaces a block's per-night inventory with `rows` ([{ night, contracted,
/// reportedPickup }]). Lowering a night below the rooms already held, or
/// dropping a night someone is booked on, is refused — each night's update
/// is a compare-and-swap on `held`, so a request landing mid-save can't end
/// up overbooked either.
export async function setNights(blockId, rows) {
  if (!Array.isArray(rows)) throw new HotelError('Send the nights as a list.');
  const seen = new Set();
  const clean = rows.map((r) => {
    if (!isDate(r.night)) throw new HotelError(`"${r.night}" is not a date.`);
    if (seen.has(r.night)) throw new HotelError(`The night of ${r.night} is listed twice.`);
    seen.add(r.night);
    const contracted = Number(r.contracted);
    if (!Number.isInteger(contracted) || contracted < 0 || contracted > 10000) throw new HotelError(`Rooms for ${r.night} must be a whole number.`);
    let reportedPickup = null;
    if (r.reportedPickup !== undefined && r.reportedPickup !== null && r.reportedPickup !== '') {
      reportedPickup = Number(r.reportedPickup);
      if (!Number.isInteger(reportedPickup) || reportedPickup < 0) throw new HotelError(`Pickup for ${r.night} must be a whole number.`);
    }
    return { night: r.night, contracted, reportedPickup };
  });
  if (clean.length > 60) throw new HotelError('A block can cover at most 60 nights.');

  await prisma.$transaction(async (tx) => {
    const existing = await tx.roomBlockNight.findMany({ where: { blockId } });
    for (const n of existing) {
      if (seen.has(n.night)) continue;
      const { count } = await tx.roomBlockNight.deleteMany({ where: { id: n.id, held: 0 } });
      if (!count) throw new HotelError(`Rooms are booked on the night of ${n.night}, so it can't be removed.`);
    }
    for (const r of clean) {
      const n = existing.find((x) => x.night === r.night);
      if (!n) {
        await tx.roomBlockNight.create({ data: { blockId, ...r } });
        continue;
      }
      const { count } = await tx.roomBlockNight.updateMany({
        where: { id: n.id, held: { lte: r.contracted } },
        data: { contracted: r.contracted, reportedPickup: r.reportedPickup },
      });
      if (!count) throw new HotelError(`More rooms are already booked on the night of ${r.night} than that.`);
    }
  });
}

/// Staff moving a live reservation to new dates. Nights it keeps stay held;
/// nights it gains are claimed with the same compare-and-swap as a new
/// request, and nights it drops are released — all or nothing.
export async function changeStay(reservation, checkIn, checkOut) {
  const next = nightsBetween(checkIn, checkOut);
  const prev = nightsBetween(reservation.checkIn, reservation.checkOut);
  return prisma.$transaction(async (tx) => {
    const current = await tx.roomReservation.findUnique({ where: { id: reservation.id } });
    if (!current || !LIVE.includes(current.status)) throw new HotelError('This room request was cancelled.');
    const nights = await tx.roomBlockNight.findMany({ where: { blockId: reservation.blockId } });
    for (const night of next.filter((d) => !prev.includes(d))) {
      const n = nights.find((x) => x.night === night);
      if (!n) throw new HotelError(`This block doesn't cover the night of ${night}.`);
      const { count } = await tx.roomBlockNight.updateMany({ where: { id: n.id, held: { lt: n.contracted } }, data: { held: { increment: 1 } } });
      if (!count) throw new HotelError(`The block is full on the night of ${night}.`);
    }
    const dropped = prev.filter((d) => !next.includes(d));
    if (dropped.length) {
      await tx.roomBlockNight.updateMany({ where: { blockId: reservation.blockId, night: { in: dropped } }, data: { held: { decrement: 1 } } });
    }
    return tx.roomReservation.update({ where: { id: reservation.id }, data: { checkIn, checkOut } });
  });
}
