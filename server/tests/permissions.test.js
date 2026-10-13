import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE, audit } from '../src/lib/auth.js';
import { upgradeBackup } from '../src/lib/backup.js';
import { STAFF_DEFAULTS } from '../src/lib/permissions.js';
import { resetDb, closeDb, createEvent, createStaff, createUser } from './helpers/db.js';

after(async () => { await closeDb(); });

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;
const as = (user) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(user)),
  post: (url, body) => request(app).post(url).set('Cookie', cookieFor(user)).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookieFor(user)).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookieFor(user)).send(body),
  del: (url) => request(app).delete(url).set('Cookie', cookieFor(user)),
});

describe('staff permissions', () => {
  let owner;
  let event;
  beforeEach(async () => {
    await resetDb();
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
    event = await createEvent();
  });

  test('an admin with no groups can open the admin but nothing in it', async () => {
    const { user: bare } = await createStaff({ staffGroup: false });
    assert.equal((await as(bare).get('/api/admin/events')).status, 200, 'the event list is for all staff');
    assert.equal((await as(bare).get(`/api/admin/events/${event.id}/registrations`)).status, 403);
    const me = await as(bare).get('/api/auth/me');
    assert.deepEqual(me.body.user.permissions, []);
  });

  test('direct grants and group grants both count, and take effect on the next request', async () => {
    const { user: admin } = await createStaff({ staffGroup: false });
    const url = `/api/admin/events/${event.id}/registrations`;

    const direct = await as(owner).put(`/api/admin/users/${admin.id}/access`, { groupIds: [], permissions: ['attendees.view', 'not.a.permission'] });
    assert.equal(direct.status, 200);
    assert.deepEqual(direct.body.directPermissions, ['attendees.view'], 'unknown keys are dropped');
    assert.equal((await as(admin).get(url)).status, 200);

    const group = await as(owner).post('/api/admin/staff-groups', { name: 'Door', permissions: ['checkin', 'attendees.view'] });
    assert.equal(group.status, 200);
    await as(owner).put(`/api/admin/users/${admin.id}/access`, { groupIds: [group.body.id], permissions: [] });
    assert.equal((await as(admin).get(url)).status, 200, 'now through the group');
    assert.deepEqual((await as(admin).get('/api/auth/me')).body.user.permissions.sort(), ['attendees.view', 'checkin']);

    await as(owner).patch(`/api/admin/staff-groups/${group.body.id}`, { permissions: ['checkin'] });
    assert.equal((await as(admin).get(url)).status, 403, 'taking it off the group takes it off its members');
  });

  test('the default Staff group keeps what admins could always do, and nothing owner-only', async () => {
    const { user: admin } = await createStaff();
    assert.equal((await as(admin).get(`/api/admin/events/${event.id}/registrations`)).status, 200);
    assert.equal((await as(admin).post('/api/admin/events', { title: 'Nope' })).status, 403);
    assert.equal((await as(admin).get('/api/admin/audit')).status, 403);
  });

  test('staff management, settings and backups stay owner-only, whatever is granted', async () => {
    const { user: admin } = await createStaff({ staffGroup: false, permissions: STAFF_DEFAULTS.concat(['audit.view', 'events.edit']) });
    for (const url of ['/api/admin/users', '/api/admin/access', '/api/admin/settings', '/api/admin/backup']) {
      assert.equal((await as(admin).get(url)).status, 403, url);
    }
    assert.equal((await as(admin).post('/api/admin/staff-groups', { name: 'Mine', permissions: ['bans.manage'] })).status, 403);
    assert.equal((await as(admin).put(`/api/admin/users/${admin.id}/access`, { permissions: ['bans.manage'] })).status, 403);
  });

  test('a section lead can save their section\'s settings card but nothing else on the event', async () => {
    const { user: lead } = await createStaff({ staffGroup: false, permissions: ['hotels.setup'] });
    const url = `/api/admin/events/${event.id}`;
    assert.equal((await as(lead).patch(url, { hotelsEnabled: true, hotelInfo: 'Book early' })).status, 200);
    assert.equal((await as(lead).patch(url, { hotelsEnabled: true, title: 'Renamed' })).status, 403);
    assert.equal((await as(lead).patch(url, { volunteersEnabled: true })).status, 403);
    assert.equal((await prisma.event.findUnique({ where: { id: event.id } })).title, event.title);
  });

  test('removing staff access clears their groups, and promoting can place them in groups', async () => {
    const user = await createUser();
    const group = await prisma.staffGroup.create({ data: { name: 'Hotel team', permissions: ['hotels.requests'] } });
    const promoted = await as(owner).post(`/api/admin/users/${user.id}/role`, { role: 'ADMIN', groupIds: [group.id] });
    assert.equal(promoted.status, 200);
    assert.deepEqual(promoted.body.groups.map((g) => g.name), ['Hotel team']);
    await as(owner).post(`/api/admin/users/${user.id}/role`, { role: 'USER' });
    assert.equal(await prisma.staffGroupMember.count({ where: { userId: user.id } }), 0);
  });

  test('incident reports: filing staff see their own, managers see all', async () => {
    const { user: filer } = await createStaff({ staffGroup: false, permissions: ['incidents.file'] });
    const { user: lead } = await createStaff({ staffGroup: false, permissions: ['incidents.manage'] });
    await prisma.incident.create({ data: { summary: 'Owner filed', occurredAt: new Date(), filedById: owner.id } });
    assert.equal((await as(filer).get('/api/admin/incidents')).body.incidents.length, 0);
    const all = await as(lead).get('/api/admin/incidents');
    assert.equal(all.body.incidents.length, 1);
    assert.equal(all.body.canManage, true);
  });

  test('an older backup restores its admins into the Staff group, like the migration', () => {
    const v9 = { meta: { version: 9 }, data: { user: [{ id: 'a', role: 'ADMIN' }, { id: 'u', role: 'USER' }, { id: 'o', role: 'OWNER' }] } };
    const { data } = upgradeBackup(v9);
    assert.deepEqual(data.staffGroup[0].permissions, STAFF_DEFAULTS);
    assert.deepEqual(data.staffGroupMember, [{ userId: 'a', groupId: 'staff_default' }]);
  });
});

describe('audit log', () => {
  let owner;
  beforeEach(async () => {
    await resetDb();
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
  });

  test('names targets and ids in the details instead of showing raw ids or JSON', async () => {
    const event = await createEvent({ title: 'Howl Con' });
    const user = await createUser({ displayName: 'Test Dealer' });
    const app1 = await prisma.vendorApplication.create({ data: { eventId: event.id, userId: user.id, area: 'DEALERS_DEN', businessName: 'Fox Goods' } });
    await audit(user.id, 'vendor.apply', app1.id, { eventId: event.id, area: 'DEALERS_DEN' });
    await audit(owner.id, 'tier.delete', 'gone-id', { name: 'Early bird' });

    const res = await as(owner).get('/api/admin/audit');
    assert.equal(res.status, 200);
    const [deleted, apply] = res.body.rows;
    assert.equal(apply.summary, 'Applied for a vendor table');
    assert.equal(apply.actor.name, 'Test Dealer');
    assert.equal(apply.target.label, 'Fox Goods');
    assert.equal(apply.target.href, `/admin/events/${event.id}/vendors`);
    assert.deepEqual(apply.details, [
      { label: 'Event', value: 'Howl Con', href: `/admin/events/${event.id}` },
      { label: 'Area', value: 'Dealers den' },
    ]);
    assert.deepEqual(deleted.target, { label: 'Early bird', deleted: true }, 'a deleted target keeps its name from the row');
  });

  test('pages newest first and filters by area and by who did it', async () => {
    for (let i = 0; i < 5; i += 1) await audit(owner.id, 'event.update', null, {});
    await audit(null, 'registration.hold_expired', null, { code: 'X' });

    const first = await as(owner).get('/api/admin/audit?limit=4');
    assert.equal(first.body.rows.length, 4);
    assert.equal(first.body.rows[0].action, 'registration.hold_expired');
    const rest = await as(owner).get(`/api/admin/audit?limit=4&before=${first.body.next}`);
    assert.equal(rest.body.rows.length, 2);
    assert.equal(rest.body.next, null);

    const attendees = await as(owner).get('/api/admin/audit?area=attendees');
    assert.deepEqual(attendees.body.rows.map((r) => r.action), ['registration.hold_expired']);
    const system = await as(owner).get('/api/admin/audit?actor=system');
    assert.equal(system.body.rows.length, 1);
    assert.equal((await as(owner).get(`/api/admin/audit?actor=${owner.id}`)).body.rows.length, 5);
  });
});
