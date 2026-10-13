import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, nextEmail } from './helpers/db.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;

describe('incident reports', () => {
  let owner;
  let admin;
  let otherAdmin;
  let event;
  let subjectReg;
  const as = (user) => ({
    get: (p) => request(app).get(`/api/admin/incidents${p}`).set('Cookie', cookieFor(user)),
    post: (p, b) => request(app).post(`/api/admin/incidents${p}`).set('Cookie', cookieFor(user)).send(b),
    patch: (p, b) => request(app).patch(`/api/admin/incidents${p}`).set('Cookie', cookieFor(user)).send(b),
  });

  beforeEach(async () => {
    await resetDb();
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
    ({ user: admin } = await createStaff({ role: 'ADMIN' }));
    ({ user: otherAdmin } = await createStaff({ role: 'ADMIN' }));
    event = await createEvent();
    const attendee = await createUser({ telegramId: 'tg-subject', telegramUsername: 'subjecthandle' });
    subjectReg = await prisma.registration.create({
      data: { eventId: event.id, userId: attendee.id, code: 'INC-SUBJ', secret: 'inc-secret', legalName: 'Pat Subject', fursonaName: 'Patty', email: nextEmail() },
    });
  });

  after(async () => {
    await closeDb();
  });

  const file = (user = admin, extra = {}) => as(user).post('', {
    eventId: event.id, summary: 'Unwanted contact in the dealers den', category: 'harassment', severity: 'HIGH',
    details: 'Followed a vendor between tables after being asked to stop.', location: 'Dealers den',
    people: [{ role: 'SUBJECT', registrationCode: 'INC-SUBJ' }, { role: 'REPORTER', name: 'Vendor at table 12', contact: 'vendor@example.com' }],
    ...extra,
  });

  test('staff file reports; details and people are encrypted at rest', async () => {
    const res = await file();
    assert.equal(res.status, 200);
    assert.equal(res.body.people[0].name, 'Patty', 'a linked ticket fills in the name');
    assert.equal(res.body.people[0].ticket.code, 'INC-SUBJ');

    const [row] = await prisma.$queryRaw`SELECT details FROM "Incident" WHERE id = ${res.body.id}`;
    assert.match(row.details, /^v1:/);
    const people = await prisma.$queryRaw`SELECT name, contact FROM "IncidentPerson" WHERE "incidentId" = ${res.body.id}`;
    assert.ok(people.every((p) => !p.contact || p.contact.startsWith('v1:')));
    assert.ok(people.some((p) => p.name.startsWith('v1:')));
  });

  test('admins only see the reports they filed; owners see all', async () => {
    const mine = await file(admin);
    const theirs = await file(otherAdmin, { summary: 'Lost wallet at the front desk', category: 'property', severity: 'LOW', people: [] });

    const adminList = await as(admin).get('');
    assert.deepEqual(adminList.body.incidents.map((i) => i.id), [mine.body.id]);
    assert.equal((await as(admin).get(`/${theirs.body.id}`)).status, 404, 'invisible, not forbidden');
    assert.equal((await as(owner).get('')).body.incidents.length, 2);
  });

  test('only owners resolve; the filer can still correct an open report', async () => {
    const { body } = await file(admin);
    const fix = await as(admin).patch(`/${body.id}`, { location: 'Dealers den, row C', status: 'RESOLVED' });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.location, 'Dealers den, row C');
    assert.equal(fix.body.status, 'OPEN', 'an admin cannot resolve');

    const resolved = await as(owner).patch(`/${body.id}`, { status: 'RESOLVED', resolution: 'Spoke with them; final warning.' });
    assert.equal(resolved.body.status, 'RESOLVED');
    assert.equal(resolved.body.resolution, 'Spoke with them; final warning.');
    assert.equal((await as(admin).patch(`/${body.id}`, { location: 'x' })).status, 403);
  });

  test('turning a subject into a ban uses their ticket identity and blocks them from registering', async () => {
    const { body } = await file();
    const subject = body.people.find((p) => p.role === 'SUBJECT');
    assert.equal((await as(admin).post(`/${body.id}/people/${subject.id}/ban`, {})).status, 403, 'bans are owner-only');

    const banned = await as(owner).post(`/${body.id}/people/${subject.id}/ban`, {});
    assert.equal(banned.status, 200);
    assert.equal(banned.body.bans.length, 1);
    assert.equal(banned.body.people.find((p) => p.id === subject.id).banned, true);
    assert.ok(banned.body.notes.some((n) => n.body.startsWith('Banned Patty')));

    const ban = await prisma.ban.findFirst();
    assert.deepEqual([ban.legalName, ban.telegramUsername, ban.incidentId], ['Pat Subject', 'subjecthandle', body.id]);
    assert.equal((await as(owner).post(`/${body.id}/people/${subject.id}/ban`, {})).status, 400, 'no double ban');

    const otherEvent = await createEvent();
    const reg = await request(app).post(`/api/events/${otherEvent.slug}/register`).send({ legalName: 'pat subject', email: nextEmail(), acceptedTos: true });
    assert.equal(reg.status, 400);
  });

  test('notes are added in order and people can be added later', async () => {
    const { body } = await file();
    await as(admin).post(`/${body.id}/notes`, { body: 'Talked to security.' });
    const res = await as(admin).post(`/${body.id}/people`, { role: 'WITNESS', name: 'Sam', contact: '@samwitness' });
    assert.deepEqual(res.body.notes.map((n) => n.body), ['Talked to security.']);
    assert.equal(res.body.people.length, 3);
    assert.equal((await as(admin).post(`/${body.id}/people`, { role: 'WITNESS', registrationCode: 'NOPE' })).status, 400);
  });

  test('a backup restores incidents together with the bans that came from them', async () => {
    const { body } = await file();
    const subject = body.people.find((p) => p.role === 'SUBJECT');
    await as(owner).post(`/${body.id}/people/${subject.id}/ban`, {});

    const backup = await request(app).get('/api/admin/backup').set('Cookie', cookieFor(owner)).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(backup.status, 200);
    const restore = await request(app).post('/api/admin/restore').set('Cookie', cookieFor(owner)).attach('file', backup.body, 'backup.zip');
    assert.equal(restore.status, 200, JSON.stringify(restore.body));

    const back = await as(owner).get(`/${body.id}`);
    assert.equal(back.body.details, 'Followed a vendor between tables after being asked to stop.');
    assert.equal(back.body.bans.length, 1);
  });
});
