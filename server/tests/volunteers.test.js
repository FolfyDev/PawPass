import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, createBan } from './helpers/db.js';

function cookieFor(user) {
  return `${COOKIE}=${issueToken(user)}`;
}

const HOUR = 3600_000;

function createShift(eventId, overrides = {}) {
  const start = Date.now() + 24 * HOUR;
  return prisma.volunteerShift.create({
    data: { eventId, role: 'Door crew', startsAt: new Date(start), endsAt: new Date(start + 2 * HOUR), slots: 2, ...overrides },
  });
}

const signUp = (event, shift, user, body = {}) => request(app)
  .post(`/api/events/${event.slug}/volunteer/${shift.id}`)
  .set('Cookie', cookieFor(user))
  .send(body);

describe('volunteers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  after(async () => {
    await closeDb();
  });

  test('the shift board is hidden until volunteering is turned on', async () => {
    const event = await createEvent();
    await createShift(event.id);
    const off = await request(app).get(`/api/events/${event.slug}/volunteer`);
    assert.equal(off.status, 404);

    await prisma.event.update({ where: { id: event.id }, data: { volunteersEnabled: true, volunteerInfo: 'Report to the front desk.' } });
    const on = await request(app).get(`/api/events/${event.slug}/volunteer`);
    assert.equal(on.status, 200);
    assert.equal(on.body.info, 'Report to the front desk.');
    assert.equal(on.body.shifts.length, 1);
    assert.equal(on.body.shifts[0].remaining, 2);
    assert.equal(on.body.shifts[0].mine, null);
  });

  test('signs up, shows the shift as mine, and frees the slot when dropped', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const shift = await createShift(event.id);
    const user = await createUser();

    const res = await signUp(event, shift, user, { note: 'Can stay late' });
    assert.equal(res.status, 200);
    assert.equal(res.body.remaining, 1);
    assert.ok(res.body.mine);

    const mine = await request(app).get('/api/my/volunteer-shifts').set('Cookie', cookieFor(user));
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].note, 'Can stay late');

    const dropped = await request(app).delete(`/api/my/volunteer-shifts/${mine.body[0].id}`).set('Cookie', cookieFor(user));
    assert.equal(dropped.status, 200);
    const after = await prisma.volunteerShift.findUnique({ where: { id: shift.id } });
    assert.equal(after.filledCount, 0);
  });

  test('never fills a shift past its slots, even with simultaneous sign-ups', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const shift = await createShift(event.id, { slots: 3 });
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser()));

    const results = await Promise.all(users.map((u) => signUp(event, shift, u)));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 400));

    const after = await prisma.volunteerShift.findUnique({ where: { id: shift.id } });
    assert.equal(after.filledCount, 3);
    assert.equal(await prisma.volunteerSignup.count({ where: { shiftId: shift.id } }), 3);
  });

  test('refuses overlapping shifts at the same event, but allows back-to-back ones', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const start = Date.now() + 24 * HOUR;
    const first = await createShift(event.id, { startsAt: new Date(start), endsAt: new Date(start + 2 * HOUR) });
    const overlapping = await createShift(event.id, { role: 'Merch', startsAt: new Date(start + HOUR), endsAt: new Date(start + 3 * HOUR) });
    const next = await createShift(event.id, { role: 'Merch', startsAt: new Date(start + 2 * HOUR), endsAt: new Date(start + 4 * HOUR) });
    const user = await createUser();

    assert.equal((await signUp(event, first, user)).status, 200);
    const clash = await signUp(event, overlapping, user);
    assert.equal(clash.status, 400);
    assert.match(clash.body.error, /overlaps/);
    assert.equal((await signUp(event, next, user)).status, 200);
  });

  test('refuses a shift that has already started and a duplicate sign-up', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const started = await createShift(event.id, { startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) });
    const upcoming = await createShift(event.id, { role: 'Later', startsAt: new Date(Date.now() + 48 * HOUR), endsAt: new Date(Date.now() + 50 * HOUR) });
    const user = await createUser();

    assert.equal((await signUp(event, started, user)).status, 400);
    assert.equal((await signUp(event, upcoming, user)).status, 200);
    assert.equal((await signUp(event, upcoming, user)).status, 400);
    const after = await prisma.volunteerShift.findUnique({ where: { id: upcoming.id } });
    assert.equal(after.filledCount, 1);
  });

  test('blocks banned people from volunteering and logs it with the other blocked attempts', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const shift = await createShift(event.id);
    const user = await createUser({ telegramId: 'banned-volunteer', telegramUsername: 'nope' });
    await createBan({ telegramId: 'banned-volunteer' });

    const res = await signUp(event, shift, user);
    assert.equal(res.status, 403);
    const attempts = await prisma.auditLog.findMany({ where: { action: 'ban.blocked_registration' } });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].meta.source, 'volunteer');
  });

  test('only owners set up shifts; admins run the roster and mark attendance', async () => {
    const event = await createEvent({ timezone: 'UTC' });
    const { user: owner } = await createStaff({ role: 'OWNER' });
    const { user: admin } = await createStaff({ role: 'ADMIN' });
    const body = { role: 'Badge desk', startsAt: '2030-05-01T10:00', endsAt: '2030-05-01T13:30', slots: 2 };

    const denied = await request(app).post(`/api/admin/events/${event.id}/shifts`).set('Cookie', cookieFor(admin)).send(body);
    assert.equal(denied.status, 403);
    const created = await request(app).post(`/api/admin/events/${event.id}/shifts`).set('Cookie', cookieFor(owner)).send(body);
    assert.equal(created.status, 200);
    assert.equal(new Date(created.body.startsAt).toISOString(), '2030-05-01T10:00:00.000Z');

    const volunteer = await createUser({ telegramUsername: 'helper' });
    const added = await request(app).post(`/api/admin/shifts/${created.body.id}/signups`).set('Cookie', cookieFor(admin)).send({ who: '@Helper' });
    assert.equal(added.status, 200);
    assert.equal(added.body.volunteer.id, volunteer.id);

    const marked = await request(app).patch(`/api/admin/volunteer-signups/${added.body.id}`).set('Cookie', cookieFor(admin)).send({ attendance: 'PRESENT' });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.attendance, 'PRESENT');

    const roster = await request(app).get(`/api/admin/events/${event.id}/volunteers`).set('Cookie', cookieFor(admin));
    assert.equal(roster.status, 200);
    assert.equal(roster.body.shifts[0].signups.length, 1);
    assert.equal(roster.body.volunteers[0].hoursWorked, 3.5);
  });

  test('cannot lower slots below the sign-ups or delete a shift people are on', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const { user: owner } = await createStaff({ role: 'OWNER' });
    const shift = await createShift(event.id, { slots: 3 });
    await signUp(event, shift, await createUser());
    await signUp(event, shift, await createUser());

    const lower = await request(app).patch(`/api/admin/shifts/${shift.id}`).set('Cookie', cookieFor(owner)).send({ slots: 1 });
    assert.equal(lower.status, 400);
    const del = await request(app).delete(`/api/admin/shifts/${shift.id}`).set('Cookie', cookieFor(owner));
    assert.equal(del.status, 400);
    const ok = await request(app).patch(`/api/admin/shifts/${shift.id}`).set('Cookie', cookieFor(owner)).send({ slots: 2 });
    assert.equal(ok.status, 200);
  });

  test('roster contact details come back decrypted', async () => {
    const event = await createEvent();
    const { user: admin } = await createStaff({ role: 'ADMIN' });
    const shift = await createShift(event.id);
    const user = await createUser({ email: 'volunteer@test.pawpass', legalName: 'Val Unteer' });
    await prisma.volunteerSignup.create({ data: { shiftId: shift.id, userId: user.id } });

    const roster = await request(app).get(`/api/admin/events/${event.id}/volunteers`).set('Cookie', cookieFor(admin));
    const { volunteer } = roster.body.shifts[0].signups[0];
    assert.equal(volunteer.email, 'volunteer@test.pawpass');
    assert.equal(volunteer.legalName, 'Val Unteer');
  });

  test('account deletion waits until upcoming shifts are dropped', async () => {
    const event = await createEvent({ volunteersEnabled: true });
    const shift = await createShift(event.id);
    const user = await createUser();
    await signUp(event, shift, user);

    const res = await request(app).post('/api/my/account/delete').set('Cookie', cookieFor(user)).send({ confirm: 'DELETE' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /volunteer shift/);
  });
});
