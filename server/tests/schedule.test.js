import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, createBan } from './helpers/db.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;

describe('schedule and panel submissions', () => {
  let admin;
  let owner;
  let event;
  const api = (user) => ({
    get: (p) => request(app).get(p).set('Cookie', cookieFor(user)),
    post: (p, b) => request(app).post(p).set('Cookie', cookieFor(user)).send(b),
    patch: (p, b) => request(app).patch(p).set('Cookie', cookieFor(user)).send(b),
    put: (p, b) => request(app).put(p).set('Cookie', cookieFor(user)).send(b),
  });

  beforeEach(async () => {
    await resetDb();
    ({ user: admin } = await createStaff({ role: 'ADMIN' }));
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
    event = await createEvent({ timezone: 'UTC', scheduleEnabled: true, submissionsOpen: true });
  });
  after(async () => { await closeDb(); });

  const session = (body) => api(admin).post(`/api/admin/events/${event.id}/sessions`, body);

  test('admins build the schedule; a room can\'t hold two sessions at once', async () => {
    const room = (await api(admin).post(`/api/admin/events/${event.id}/rooms`, { name: 'Main Stage', capacity: 300 })).body;
    const a = await session({ title: 'Opening ceremonies', roomId: room.id, startsAt: '2030-05-03T10:00', endsAt: '2030-05-03T11:00', published: true });
    assert.equal(a.status, 200);
    assert.equal(new Date(a.body.startsAt).toISOString(), '2030-05-03T10:00:00.000Z');

    const clash = await session({ title: 'Fursuit parade', roomId: room.id, startsAt: '2030-05-03T10:30', endsAt: '2030-05-03T11:30' });
    assert.equal(clash.status, 400);
    assert.match(clash.body.error, /Main Stage already has "Opening ceremonies"/);
    assert.equal((await session({ title: 'Fursuit parade', roomId: room.id, startsAt: '2030-05-03T11:00', endsAt: '2030-05-03T12:00' })).status, 200, 'back to back is fine');
    assert.equal((await session({ title: 'Half', startsAt: '2030-05-03T11:00' })).status, 400, 'start without end');
    assert.equal((await session({ title: 'Unscheduled idea' })).status, 200, 'no times = unscheduled draft');
  });

  test('the public schedule only shows published, scheduled sessions; attendees star them', async () => {
    const pub = (await session({ title: 'Art jam', startsAt: '2030-05-03T13:00', endsAt: '2030-05-03T14:00', published: true })).body;
    await session({ title: 'Draft', startsAt: '2030-05-03T15:00', endsAt: '2030-05-03T16:00' });
    await session({ title: 'Unscheduled', published: true });
    const user = await createUser();

    const sched = await api(user).get(`/api/events/${event.slug}/schedule`);
    assert.deepEqual(sched.body.sessions.map((s) => s.title), ['Art jam']);
    assert.equal((await api(user).put(`/api/my/stars/${pub.id}`)).status, 200);
    assert.equal((await api(user).put(`/api/my/stars/${pub.id}`)).status, 200, 'starring twice is fine');
    assert.deepEqual((await api(user).get(`/api/events/${event.slug}/schedule`)).body.starred, [pub.id]);
    const staffView = await api(admin).get(`/api/admin/events/${event.id}/schedule`);
    assert.equal(staffView.body.sessions.find((s) => s.id === pub.id).stars, 1);

    await prisma.event.update({ where: { id: event.id }, data: { scheduleEnabled: false } });
    assert.equal((await api(user).get(`/api/events/${event.slug}/schedule`)).status, 404);
  });

  test('submit, edit while waiting, accept into a draft session, and the submitter is told', async () => {
    const user = await createUser();
    const body = { title: 'Intro to fursuit making', description: 'Patterns, foam, and fur for absolute beginners.', hosts: 'Kit & Rue', lengthMinutes: 90, notes: 'Need a projector' };
    const sub = await api(user).post(`/api/events/${event.slug}/submissions`, body);
    assert.equal(sub.status, 200);
    assert.equal((await api(user).patch(`/api/my/submissions/${sub.body.id}`, { lengthMinutes: 60 })).body.lengthMinutes, 60);

    const list = await api(admin).get(`/api/admin/events/${event.id}/submissions?status=SUBMITTED`);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].notes, 'Need a projector');

    const accepted = await api(admin).post(`/api/admin/submissions/${sub.body.id}/decision`, { decision: 'ACCEPTED', reviewNote: 'Great fit for Saturday' });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.sessionId);
    const draft = await prisma.scheduleSession.findUnique({ where: { id: accepted.body.sessionId } });
    assert.deepEqual([draft.title, draft.hosts, draft.published, draft.startsAt], ['Intro to fursuit making', 'Kit & Rue', false, null]);

    assert.equal((await api(user).patch(`/api/my/submissions/${sub.body.id}`, { title: 'x' })).status, 400, 'decided = locked');
    assert.equal((await api(admin).post(`/api/admin/submissions/${sub.body.id}/decision`, { decision: 'DECLINED' })).status, 400, 'decided once');
    const mine = await api(user).get(`/api/events/${event.slug}/submissions`);
    assert.equal(mine.body.mine[0].status, 'ACCEPTED');
    assert.equal(mine.body.mine[0].reviewNote, undefined, 'review notes stay internal');
  });

  test('submissions close on the deadline, and banned people can\'t submit', async () => {
    const user = await createUser({ telegramId: 'tg-banned-panelist' });
    await createBan({ telegramId: 'tg-banned-panelist' });
    const body = { title: 'Panel', description: 'A perfectly reasonable description here.' };
    assert.equal((await api(user).post(`/api/events/${event.slug}/submissions`, body)).status, 403);

    await prisma.event.update({ where: { id: event.id }, data: { submissionsCloseAt: new Date(Date.now() - 1000) } });
    const late = await api(await createUser()).post(`/api/events/${event.slug}/submissions`, body);
    assert.equal(late.status, 400);
    assert.match(late.body.error, /closed/);
  });

  test('a withdrawn submission can\'t be decided; only owners turn submissions on', async () => {
    const user = await createUser();
    const sub = await api(user).post(`/api/events/${event.slug}/submissions`, { title: 'P', description: 'Long enough to count as a description.' });
    assert.equal((await api(user).post(`/api/my/submissions/${sub.body.id}/withdraw`)).status, 200);
    assert.equal((await api(admin).post(`/api/admin/submissions/${sub.body.id}/decision`, { decision: 'ACCEPTED' })).status, 400);

    assert.equal((await api(admin).patch(`/api/admin/events/${event.id}`, { submissionsOpen: false })).status, 403);
    assert.equal((await api(owner).patch(`/api/admin/events/${event.id}`, { submissionsOpen: false })).status, 200);
  });
});
