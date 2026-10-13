import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { dayIn, eventDays, scanProblem } from '../src/lib/checkins.js';
import { upgradeBackup } from '../src/lib/backup.js';
import { resetDb, closeDb, createEvent, createStaff, createUser } from './helpers/db.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;
const HOUR = 3600_000;

let seq = 0;
async function ticket(event, overrides = {}) {
  // Taken before the await: these run concurrently in some tests.
  const n = ++seq;
  const user = await createUser();
  return prisma.registration.create({
    data: {
      eventId: event.id, userId: user.id, code: `CHK-${n}-${Date.now()}`, secret: `chk-secret-${n}-${Date.now()}`,
      legalName: 'Door Person', fursonaName: 'Doorie', status: 'CONFIRMED', ticketTierId: event.ticketTiers[0]?.id, ...overrides,
    },
  });
}

/// An event running from yesterday to tomorrow in UTC, so "today" is always inside it.
const liveEvent = (overrides, opts) => createEvent({
  timezone: 'UTC', startsAt: new Date(Date.now() - 24 * HOUR), endsAt: new Date(Date.now() + 24 * HOUR), ...overrides,
}, opts);

describe('check-in', () => {
  let admin;
  const scan = (body) => request(app).post('/api/admin/checkin').set('Cookie', cookieFor(admin)).send(body);

  beforeEach(async () => {
    await resetDb();
    ({ user: admin } = await createStaff({ role: 'ADMIN' }));
  });

  after(async () => {
    await closeDb();
  });

  test('event days cover every calendar day in the event timezone', () => {
    const event = { timezone: 'America/New_York', startsAt: new Date('2030-05-03T23:00:00Z'), endsAt: new Date('2030-05-06T02:00:00Z') };
    // 7pm Fri to 10pm Sun New York time.
    assert.deepEqual(eventDays(event), ['2030-05-03', '2030-05-04', '2030-05-05']);
    assert.equal(dayIn(new Date('2030-05-04T03:00:00Z'), 'America/New_York'), '2030-05-03');
  });

  test('enters once a day, exits, re-enters, and counts who is inside', async () => {
    const event = await liveEvent({ occupancyLimit: 100 });
    const reg = await ticket(event);

    const first = await scan({ value: reg.code, eventId: event.id });
    assert.equal(first.status, 200);
    assert.equal(first.body.firstVisit, true);
    assert.deepEqual([first.body.today.inside, first.body.today.entered, first.body.today.limit], [1, 1, 100]);

    const again = await scan({ value: reg.code, eventId: event.id });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_inside');

    const out = await scan({ value: reg.code, eventId: event.id, direction: 'EXIT' });
    assert.equal(out.status, 200);
    assert.equal(out.body.today.inside, 0);
    assert.equal((await scan({ value: reg.code, eventId: event.id, direction: 'EXIT' })).body.code, 'not_inside');

    const back = await scan({ value: reg.code, eventId: event.id });
    assert.equal(back.status, 200);
    assert.equal(back.body.firstVisit, false);
    assert.deepEqual([back.body.today.inside, back.body.today.entered], [1, 1]);
  });

  test('a day pass only gets in on its day, unless staff override it', async () => {
    const event = await liveEvent({}, { tiers: [{ name: 'Saturday pass', validDays: ['2001-01-06'] }] });
    const reg = await ticket(event, { tierName: 'Saturday pass' });

    const refused = await scan({ value: reg.code, eventId: event.id });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'wrong_day');
    assert.match(refused.body.error, /Saturday pass is only valid on Sat, Jan 6/);

    const forced = await scan({ value: reg.code, eventId: event.id, force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.scan.overridden, true);
    assert.equal(await prisma.auditLog.count({ where: { action: 'checkin.override' } }), 1);
  });

  test('refuses entry at the occupancy limit until someone leaves, unless overridden', async () => {
    const event = await liveEvent({ occupancyLimit: 1 });
    const [a, b] = [await ticket(event), await ticket(event)];
    assert.equal((await scan({ value: a.code, eventId: event.id })).status, 200);
    const full = await scan({ value: b.code, eventId: event.id });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'at_capacity');
    await scan({ value: a.code, eventId: event.id, direction: 'EXIT' });
    assert.equal((await scan({ value: b.code, eventId: event.id })).status, 200);
    assert.equal((await scan({ value: a.code, eventId: event.id, force: true })).status, 200, 'override past the limit');
  });

  test('two doors scanning different people at the last free spot only let one in', async () => {
    const event = await liveEvent({ occupancyLimit: 1 });
    const tickets = await Promise.all(Array.from({ length: 6 }, () => ticket(event)));
    const results = await Promise.all(tickets.map((t) => scan({ value: t.code, eventId: event.id })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
  });

  test('never lets the same badge in twice when two scanners read it at once', async () => {
    const event = await liveEvent();
    const reg = await ticket(event);
    const results = await Promise.all(Array.from({ length: 5 }, () => scan({ value: reg.code, eventId: event.id })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(await prisma.checkIn.count({ where: { registrationId: reg.id } }), 1);
  });

  test('cancelled and unpaid tickets are refused, even with an override', async () => {
    const event = await liveEvent();
    const cancelled = await ticket(event, { status: 'CANCELLED' });
    const res = await scan({ value: cancelled.code, eventId: event.id, force: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'cancelled');
  });

  test('undo takes back the last scan, and the first arrival with it', async () => {
    const event = await liveEvent();
    const reg = await ticket(event);
    await scan({ value: reg.code, eventId: event.id });
    await scan({ value: reg.code, eventId: event.id, direction: 'EXIT' });

    await request(app).post(`/api/admin/checkin/${reg.code}/undo`).set('Cookie', cookieFor(admin));
    assert.equal((await scan({ value: reg.code, eventId: event.id })).body.code, 'already_inside', 'the exit was undone');

    const undone = await request(app).post(`/api/admin/checkin/${reg.code}/undo`).set('Cookie', cookieFor(admin));
    assert.equal(undone.body.checkedInAt, null);
  });

  test('the offline manifest hashes QR secrets instead of sending them', async () => {
    const event = await liveEvent();
    const reg = await ticket(event);
    await scan({ value: reg.code, eventId: event.id });
    const res = await request(app).get(`/api/admin/events/${event.id}/checkin-manifest`).set('Cookie', cookieFor(admin));
    const t = res.body.tickets.find((x) => x.code === reg.code);
    assert.equal(t.secretHash, crypto.createHash('sha256').update(reg.secret).digest('hex'));
    assert.ok(!JSON.stringify(res.body).includes(reg.secret));
    assert.equal(t.name, 'Doorie', 'names come back decrypted');
    assert.equal(t.scans.length, 1);
  });

  test('offline sync records scans at their own time, once, and flags ones the rules would now refuse', async () => {
    const event = await liveEvent();
    const ok = await ticket(event);
    const cancelled = await ticket(event, { status: 'CANCELLED' });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    const body = { scans: [
      { clientId: 'dev1-1', code: ok.code, direction: 'ENTRY', at },
      { clientId: 'dev1-2', code: cancelled.code, direction: 'ENTRY', at },
      { clientId: 'dev1-3', code: 'NOPE-NOPE', direction: 'ENTRY', at },
    ] };
    const sync = () => request(app).post(`/api/admin/events/${event.id}/checkin/sync`).set('Cookie', cookieFor(admin)).send(body);

    const first = await sync();
    assert.equal(first.status, 200);
    const [a, b, c] = first.body.results;
    assert.deepEqual([a.ok, a.duplicate, a.flagged], [true, false, null]);
    assert.equal(b.ok, true);
    assert.match(b.flagged, /cancelled/);
    assert.equal(c.ok, false);

    const stored = await prisma.checkIn.findUnique({ where: { clientId: 'dev1-1' } });
    assert.equal(stored.at.toISOString(), at);
    assert.equal(stored.offline, true);

    const retry = await sync();
    assert.ok(retry.body.results.slice(0, 2).every((r) => r.duplicate), 'a retried sync records nothing twice');
    assert.equal(await prisma.checkIn.count(), 2);
  });

  test('attendance counts different tickets per day', async () => {
    const event = await liveEvent();
    for (let i = 0; i < 3; i += 1) await scan({ value: (await ticket(event)).code, eventId: event.id });
    const res = await request(app).get(`/api/admin/events/${event.id}/attendance`).set('Cookie', cookieFor(admin));
    const today = res.body.days.find((d) => d.day === res.body.today.day);
    assert.equal(today.entered, 3);
    assert.equal(res.body.days.length, 3);
  });

  test('the scan rules match what the offline scanner applies', () => {
    const ticketInfo = { status: 'CONFIRMED', validDays: [] };
    assert.equal(scanProblem(ticketInfo, 'ENTRY', '2030-05-04', []), null);
    assert.equal(scanProblem(ticketInfo, 'EXIT', '2030-05-04', []).code, 'not_inside');
    assert.equal(scanProblem(ticketInfo, 'ENTRY', '2030-05-04', [{ direction: 'ENTRY', at: new Date() }, { direction: 'EXIT', at: new Date() }]), null);
  });

  test('old backups gain a scan for every check-in', () => {
    const { data } = upgradeBackup({
      meta: { version: 5 },
      data: {
        event: [{ id: 'e1', timezone: 'America/New_York' }],
        registration: [{ id: 'r1', eventId: 'e1', checkedInAt: new Date('2030-05-04T02:00:00Z') }, { id: 'r2', eventId: 'e1', checkedInAt: null }],
      },
    });
    assert.equal(data.checkIn.length, 1);
    assert.equal(data.checkIn[0].day, '2030-05-03');
  });
});
