import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { resetDb, closeDb, createEvent, createStaff, createUser } from './helpers/db.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;

describe('event overview', () => {
  let owner;
  let admin;
  beforeEach(async () => {
    await resetDb();
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
    ({ user: admin } = await createStaff({ role: 'ADMIN' }));
  });
  after(async () => { await closeDb(); });
  const get = (user, event) => request(app).get(`/api/admin/events/${event.id}/overview`).set('Cookie', cookieFor(user));

  test('a quiet, unpublished event says so and has nothing else to do', async () => {
    const event = await createEvent({ published: false });
    const res = await get(owner, event);
    assert.equal(res.status, 200);
    assert.equal(res.body.event.phase, 'upcoming');
    assert.deepEqual(res.body.attention.map((a) => a.tab), ['details']);
    assert.equal(res.body.volunteers, null, 'sections not in use are left out');
  });

  test('collects to-dos from every area, most urgent first', async () => {
    const event = await createEvent();
    const user = await createUser();
    await prisma.registration.create({ data: { eventId: event.id, userId: user.id, code: 'OV-1', secret: 'ov-1', legalName: 'A', fursonaName: 'A', cancelRequestedAt: new Date() } });
    await prisma.panelSubmission.create({ data: { eventId: event.id, userId: user.id, title: 'P' } });
    const type = await prisma.vendorTableType.create({ data: { eventId: event.id, name: 'Full', priceCents: 1000, quantity: 3 } });
    await prisma.vendorApplication.create({ data: { eventId: event.id, userId: user.id, area: 'DEALERS_DEN', businessName: 'B', tableTypeId: type.id, status: 'ACCEPTED', feeCents: 1000 } });
    await prisma.volunteerShift.create({ data: { eventId: event.id, role: 'Door', startsAt: new Date(Date.now() + 86400_000), endsAt: new Date(Date.now() + 90000_000), slots: 4 } });
    await prisma.incident.create({ data: { eventId: event.id, summary: 'Bad thing', severity: 'HIGH', occurredAt: new Date(), filedById: owner.id } });

    const res = await get(owner, event);
    const tabs = res.body.attention.map((a) => a.tab);
    assert.equal(tabs[0], '/admin/incidents', 'the high-severity incident comes first');
    for (const t of ['attendees', 'submissions', 'vendors', 'volunteers']) assert.ok(tabs.includes(t), t);
    assert.deepEqual(res.body.vendors, { tables: 3, taken: 1, toReview: 0, feeDue: 1 });

    const asAdmin = await get(admin, event);
    assert.equal(asAdmin.body.incidents.open, 0, 'admins only count the incidents they filed');
    assert.ok(!asAdmin.body.attention.some((a) => a.tab === '/admin/incidents'));
  });
});
