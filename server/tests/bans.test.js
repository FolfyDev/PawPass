import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, createBan, nextEmail } from './helpers/db.js';

function cookieFor(user) {
  return `${COOKIE}=${issueToken(user)}`;
}

describe('bans', () => {
  beforeEach(async () => {
    await resetDb();
  });

  after(async () => {
    await closeDb();
  });

  test('blocks registration by legal name, case insensitively, and logs the attempt', async () => {
    const event = await createEvent();
    await createBan({ legalName: 'John Smith' });

    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'john SMITH', email: nextEmail(), acceptedTos: true });
    assert.equal(res.status, 400);

    const attempts = await prisma.auditLog.findMany({ where: { action: 'ban.blocked_registration' } });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].meta.eventId, event.id);
  });

  test('blocks registration by email', async () => {
    const event = await createEvent();
    const email = nextEmail();
    await createBan({ email });

    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Someone Else', email, acceptedTos: true });
    assert.equal(res.status, 400);
  });

  test('blocks a signed-in user by telegram id', async () => {
    const event = await createEvent();
    const user = await createUser({ telegramId: 'banned-tg-id', telegramUsername: 'bannedhandle' });
    await createBan({ telegramId: 'banned-tg-id' });

    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .set('Cookie', cookieFor(user))
      .send({ legalName: 'Whatever Name', acceptedTos: true });
    assert.equal(res.status, 400);
  });

  test('does not block someone who matches no ban', async () => {
    const event = await createEvent();
    await createBan({ legalName: 'Someone Banned' });

    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Totally Different Person', email: nextEmail(), acceptedTos: true });
    assert.equal(res.status, 200);
  });

  test('admin can list, create, and delete bans', async () => {
    const { user, password } = await createStaff({ role: 'ADMIN' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });

    const create = await agent.post('/api/admin/bans').send({ legalName: 'New Ban Target' });
    assert.equal(create.status, 200);

    const list = await agent.get('/api/admin/bans');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const del = await agent.delete(`/api/admin/bans/${create.body.id}`);
    assert.equal(del.status, 200);

    const listAfter = await agent.get('/api/admin/bans');
    assert.equal(listAfter.body.length, 0);
  });

  test('rejects a ban with no identifying field', async () => {
    const { user, password } = await createStaff({ role: 'ADMIN' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });

    const res = await agent.post('/api/admin/bans').send({ reason: 'no identifiers here' });
    assert.equal(res.status, 400);
  });

  test('non-admins cannot manage bans', async () => {
    const res = await request(app).get('/api/admin/bans');
    assert.equal(res.status, 403);
  });
});
