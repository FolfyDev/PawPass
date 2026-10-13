import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { purgeDue, setRetention } from '../src/lib/retention.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, nextEmail } from './helpers/db.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;
const MONTH = 31 * 86400_000;

let n = 0;
async function reg(event, extra = {}) {
  const i = ++n;
  const user = await createUser();
  return prisma.registration.create({
    data: {
      eventId: event.id, userId: user.id, code: `RET-${i}-${Date.now()}`, secret: `ret-${i}-${Date.now()}`,
      legalName: 'Jordan Real', fursonaName: 'Jordy', email: nextEmail(), answers: { diet: 'vegan' }, ...extra,
    },
  });
}

describe('data retention', () => {
  let owner;
  beforeEach(async () => {
    await resetDb();
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
  });
  after(async () => { await closeDb(); });

  const ended = (monthsAgo) => createEvent({ startsAt: new Date(Date.now() - monthsAgo * MONTH - 86400_000), endsAt: new Date(Date.now() - monthsAgo * MONTH) });

  test('off by default: nothing is cleared', async () => {
    const old = await ended(30);
    await reg(old);
    assert.deepEqual(await purgeDue(), []);
    assert.equal((await prisma.registration.findFirst()).legalName, 'Jordan Real');
  });

  test('clears names, emails, answers and room guests on events past the period, and nothing newer', async () => {
    const old = await ended(7);
    const recent = await ended(2);
    const oldReg = await reg(old);
    const recentReg = await reg(recent);
    await prisma.payment.create({ data: { registrationId: oldReg.id, method: 'CASH', status: 'PAID', amountCents: 2500 } });
    const hotel = await prisma.hotel.create({ data: { eventId: old.id, name: 'Inn' } });
    const block = await prisma.roomBlock.create({ data: { hotelId: hotel.id, name: 'King', mode: 'ORGANIZER_MANAGED' } });
    await prisma.roomReservation.create({ data: { blockId: block.id, userId: oldReg.userId, guestName: 'Jordan Real', roommates: 'Sam', checkIn: '2030-01-01', checkOut: '2030-01-02' } });

    await setRetention(6);
    const done = await purgeDue();
    assert.deepEqual(done.map((e) => e.id), [old.id]);
    assert.equal(done[0].registrations, 1);

    const cleared = await prisma.registration.findUnique({ where: { id: oldReg.id } });
    assert.deepEqual([cleared.legalName, cleared.fursonaName, cleared.email, cleared.answers], ['Removed', '', null, {}]);
    assert.equal(cleared.code, oldReg.code, 'the ticket itself stays');
    assert.equal(await prisma.payment.count({ where: { registrationId: oldReg.id } }), 1, 'payments are kept');
    const room = await prisma.roomReservation.findFirst();
    assert.deepEqual([room.guestName, room.roommates], ['Removed', '']);
    assert.equal((await prisma.registration.findUnique({ where: { id: recentReg.id } })).legalName, 'Jordan Real');
    assert.ok((await prisma.event.findUnique({ where: { id: old.id } })).dataPurgedAt);

    assert.deepEqual(await purgeDue(), [], 'each event is only cleared once');
    assert.equal(await prisma.auditLog.count({ where: { action: 'data.purge' } }), 1);
  });

  test('owners see what a setting would clear before it runs, and can clear one event by hand', async () => {
    const old = await ended(13);
    await reg(old);
    await reg(old);
    const put = await request(app).put('/api/admin/retention').set('Cookie', cookieFor(owner)).send({ months: 12 });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.due.map((e) => [e.title, e.registrations]), [[old.title, 2]]);
    assert.equal((await request(app).put('/api/admin/retention').set('Cookie', cookieFor(owner)).send({ months: 5 })).status, 400);

    const recent = await ended(1);
    await reg(recent);
    const wrong = await request(app).post(`/api/admin/events/${recent.id}/purge`).set('Cookie', cookieFor(owner)).send({ confirm: 'nope' });
    assert.equal(wrong.status, 400);
    const ok = await request(app).post(`/api/admin/events/${recent.id}/purge`).set('Cookie', cookieFor(owner)).send({ confirm: recent.title });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.registrations, 1);

    const { user: admin } = await createStaff({ role: 'ADMIN' });
    assert.equal((await request(app).post('/api/admin/retention/run').set('Cookie', cookieFor(admin))).status, 403);
  });
});
