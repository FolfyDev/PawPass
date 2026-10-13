import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { nightsBetween } from '../src/lib/hotels.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, createBan } from './helpers/db.js';

function cookieFor(user) {
  return `${COOKIE}=${issueToken(user)}`;
}

let regSeq = 0;
/// A confirmed ticket, which attendees-only blocks require.
function confirmTicket(event, user, overrides = {}) {
  regSeq += 1;
  return prisma.registration.create({
    data: {
      eventId: event.id, userId: user.id, code: `HTL-${regSeq}${Date.now()}`, secret: `hotel-secret-${regSeq}-${Date.now()}`,
      legalName: 'Robin Guest', fursonaName: 'Robin', status: 'CONFIRMED', ...overrides,
    },
  });
}

/// A hotel with one block covering Fri and Sat night, `rooms` rooms each.
async function createBlock(event, { rooms = 2, nights = ['2030-05-03', '2030-05-04'], ...overrides } = {}) {
  const hotel = await prisma.hotel.create({ data: { eventId: event.id, name: 'Grand Hotel' } });
  return prisma.roomBlock.create({
    data: {
      hotelId: hotel.id, name: 'King', rateCents: 14900, mode: 'ORGANIZER_MANAGED',
      nights: { create: nights.map((night) => ({ night, contracted: rooms })) },
      ...overrides,
    },
    include: { nights: true, hotel: true },
  });
}

const request_ = (event, block, user, body = {}) => request(app)
  .post(`/api/events/${event.slug}/room-blocks/${block.id}/reservations`)
  .set('Cookie', cookieFor(user))
  .send({ checkIn: '2030-05-03', checkOut: '2030-05-05', guestName: 'Robin Guest', ...body });

const held = async (block) => Object.fromEntries((await prisma.roomBlockNight.findMany({ where: { blockId: block.id } })).map((n) => [n.night, n.held]));

describe('hotels', () => {
  beforeEach(async () => {
    await resetDb();
  });

  after(async () => {
    await closeDb();
  });

  test('a stay covers check-in up to, not including, check-out', () => {
    assert.deepEqual(nightsBetween('2030-05-03', '2030-05-05'), ['2030-05-03', '2030-05-04']);
    assert.deepEqual(nightsBetween('2030-12-31', '2031-01-01'), ['2030-12-31']);
    assert.throws(() => nightsBetween('2030-05-05', '2030-05-05'));
    assert.throws(() => nightsBetween('2030-02-30', '2030-03-02'));
  });

  test('hides hotels until turned on, and the booking code from people without a ticket', async () => {
    const event = await createEvent();
    await createBlock(event, { mode: 'HOTEL_BOOKED', groupCode: 'FURCON26', bookingUrl: 'https://hotel.example/book' });
    assert.equal((await request(app).get(`/api/events/${event.slug}/hotels`)).status, 404);

    await prisma.event.update({ where: { id: event.id }, data: { hotelsEnabled: true } });
    const anon = await request(app).get(`/api/events/${event.slug}/hotels`);
    assert.equal(anon.status, 200);
    const block = anon.body.hotels[0].blocks[0];
    assert.equal(block.locked, true);
    assert.equal(block.groupCode, null);
    assert.equal(block.bookingUrl, null);

    const user = await createUser();
    await confirmTicket(event, user);
    const attendee = await request(app).get(`/api/events/${event.slug}/hotels`).set('Cookie', cookieFor(user));
    assert.equal(attendee.body.hotels[0].blocks[0].groupCode, 'FURCON26');
    assert.equal(attendee.body.guestName, 'Robin Guest');
  });

  test('requests a room, holds each night, and gives them back on cancel', async () => {
    const event = await createEvent({ hotelsEnabled: true });
    const block = await createBlock(event);
    const user = await createUser();
    await confirmTicket(event, user);

    const res = await request_(event, block, user, { roommates: 'Sam, Alex', guests: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REQUESTED');
    assert.equal(res.body.roommates, 'Sam, Alex');
    assert.deepEqual(await held(block), { '2030-05-03': 1, '2030-05-04': 1 });

    const stored = await prisma.$queryRaw`SELECT "guestName" FROM "RoomReservation" WHERE id = ${res.body.id}`;
    assert.match(stored[0].guestName, /^v1:/, 'guest name is encrypted at rest');

    const cancel = await request(app).post(`/api/my/room-reservations/${res.body.id}/cancel`).set('Cookie', cookieFor(user));
    assert.equal(cancel.status, 200);
    assert.deepEqual(await held(block), { '2030-05-03': 0, '2030-05-04': 0 });
    // A second cancel is a no-op, not a second release.
    await request(app).post(`/api/my/room-reservations/${res.body.id}/cancel`).set('Cookie', cookieFor(user));
    assert.deepEqual(await held(block), { '2030-05-03': 0, '2030-05-04': 0 });
  });

  test('never oversells a night, even with simultaneous requests, and a refused stay holds nothing', async () => {
    const event = await createEvent({ hotelsEnabled: true });
    const block = await createBlock(event, { rooms: 3 });
    const users = await Promise.all(Array.from({ length: 8 }, () => createUser()));
    for (const u of users) await confirmTicket(event, u);

    const results = await Promise.all(users.map((u) => request_(event, block, u)));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.deepEqual(await held(block), { '2030-05-03': 3, '2030-05-04': 3 });

    // Saturday is full, so a Fri+Sat stay must not keep its Friday either.
    await prisma.roomBlockNight.updateMany({ where: { blockId: block.id, night: '2030-05-03' }, data: { contracted: 5 } });
    const extra = await createUser();
    await confirmTicket(event, extra);
    assert.equal((await request_(event, block, extra)).status, 400);
    assert.deepEqual(await held(block), { '2030-05-03': 3, '2030-05-04': 3 });
  });

  test('refuses nights outside the block, a second room, no ticket, past cutoff, and banned people', async () => {
    const event = await createEvent({ hotelsEnabled: true });
    const block = await createBlock(event);
    const user = await createUser();
    await confirmTicket(event, user);

    assert.equal((await request_(event, block, user, { checkOut: '2030-05-06' })).status, 400);
    assert.equal((await request_(event, block, user)).status, 200);
    const second = await request_(event, block, user, { checkIn: '2030-05-04' });
    assert.equal(second.status, 400);
    assert.match(second.body.error, /already have a room/);

    const noTicket = await createUser();
    assert.equal((await request_(event, block, noTicket)).status, 403);

    const late = await createUser();
    await confirmTicket(event, late);
    await prisma.roomBlock.update({ where: { id: block.id }, data: { cutoffAt: new Date(Date.now() - 1000) } });
    assert.equal((await request_(event, block, late)).status, 400);

    await prisma.roomBlock.update({ where: { id: block.id }, data: { cutoffAt: null } });
    const banned = await createUser({ telegramId: 'banned-guest' });
    await confirmTicket(event, banned);
    await createBan({ telegramId: 'banned-guest' });
    assert.equal((await request_(event, block, banned)).status, 403);
  });

  test('staff confirm with the hotel number, move the dates, and cancel', async () => {
    const event = await createEvent({ hotelsEnabled: true });
    const block = await createBlock(event, { nights: ['2030-05-02', '2030-05-03', '2030-05-04'] });
    const { user: admin } = await createStaff({ role: 'ADMIN' });
    const user = await createUser();
    const reg = await confirmTicket(event, user);

    const added = await request(app).post(`/api/admin/room-blocks/${block.id}/reservations`).set('Cookie', cookieFor(admin))
      .send({ who: reg.code, checkIn: '2030-05-03', checkOut: '2030-05-05' });
    assert.equal(added.status, 200);
    assert.equal(added.body.guestName, 'Robin Guest', 'defaults to the legal name on their ticket');

    const confirmed = await request(app).patch(`/api/admin/room-reservations/${added.body.id}`).set('Cookie', cookieFor(admin))
      .send({ confirmationNumber: 'HX-1234' });
    assert.equal(confirmed.body.status, 'CONFIRMED');

    const moved = await request(app).patch(`/api/admin/room-reservations/${added.body.id}`).set('Cookie', cookieFor(admin))
      .send({ checkIn: '2030-05-02', checkOut: '2030-05-04' });
    assert.equal(moved.status, 200);
    assert.deepEqual(await held(block), { '2030-05-02': 1, '2030-05-03': 1, '2030-05-04': 0 });

    const cancelled = await request(app).post(`/api/admin/room-reservations/${added.body.id}/cancel`).set('Cookie', cookieFor(admin));
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await held(block), { '2030-05-02': 0, '2030-05-03': 0, '2030-05-04': 0 });
  });

  test('only owners set up blocks; inventory can\'t drop below what is booked', async () => {
    const event = await createEvent({ hotelsEnabled: true });
    const { user: owner } = await createStaff({ role: 'OWNER' });
    const { user: admin } = await createStaff({ role: 'ADMIN' });

    assert.equal((await request(app).post(`/api/admin/events/${event.id}/hotels`).set('Cookie', cookieFor(admin)).send({ name: 'Inn' })).status, 403);
    const hotel = await request(app).post(`/api/admin/events/${event.id}/hotels`).set('Cookie', cookieFor(owner)).send({ name: 'Inn' });
    assert.equal(hotel.status, 200);
    const block = await request(app).post(`/api/admin/hotels/${hotel.body.id}/blocks`).set('Cookie', cookieFor(owner))
      .send({ name: 'Double Queen', rate: '139.00', mode: 'ORGANIZER_MANAGED', attritionPercent: 80, nights: [{ night: '2030-05-03', contracted: 2 }, { night: '2030-05-04', contracted: 2 }] });
    assert.equal(block.status, 200);
    assert.equal(block.body.rateCents, 13900);

    const user = await createUser();
    await confirmTicket(event, user);
    assert.equal((await request_(event, block.body, user)).status, 200);

    const setNights = (nights) => request(app).put(`/api/admin/room-blocks/${block.body.id}/nights`).set('Cookie', cookieFor(owner)).send({ nights });
    assert.equal((await setNights([{ night: '2030-05-03', contracted: 0 }, { night: '2030-05-04', contracted: 2 }])).status, 400);
    assert.equal((await setNights([{ night: '2030-05-04', contracted: 2 }])).status, 400, 'a booked night cannot be removed');
    assert.equal((await setNights([{ night: '2030-05-03', contracted: 1 }, { night: '2030-05-04', contracted: 1 }, { night: '2030-05-05', contracted: 4 }])).status, 200);

    const del = await request(app).delete(`/api/admin/room-blocks/${block.body.id}`).set('Cookie', cookieFor(owner));
    assert.equal(del.status, 400);

    const overview = await request(app).get(`/api/admin/events/${event.id}/hotels`).set('Cookie', cookieFor(admin));
    const b = overview.body.hotels[0].blocks[0];
    assert.equal(b.contracted, 6);
    assert.equal(b.pickedUp, 2);
    assert.equal(b.required, 5);
    assert.equal(b.shortfall, 3);
    assert.equal(b.reservations[0].guestName, 'Robin Guest');
  });

  test('hotel-booked blocks count the pickup the hotel reports', async () => {
    const event = await createEvent();
    const { user: owner } = await createStaff({ role: 'OWNER' });
    const block = await createBlock(event, { mode: 'HOTEL_BOOKED', rooms: 10 });
    const user = await createUser();
    await confirmTicket(event, user);
    await prisma.event.update({ where: { id: event.id }, data: { hotelsEnabled: true } });
    assert.equal((await request_(event, block, user)).status, 400, 'booked with the hotel, not here');

    await request(app).put(`/api/admin/room-blocks/${block.id}/nights`).set('Cookie', cookieFor(owner))
      .send({ nights: [{ night: '2030-05-03', contracted: 10, reportedPickup: 7 }, { night: '2030-05-04', contracted: 10, reportedPickup: 9 }] });
    const overview = await request(app).get(`/api/admin/events/${event.id}/hotels`).set('Cookie', cookieFor(owner));
    assert.equal(overview.body.hotels[0].blocks[0].pickedUp, 16);
    assert.equal(overview.body.hotels[0].blocks[0].pickupPercent, 80);
  });
});
