import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { resetDb, closeDb, createStaff, createLoginCode } from './helpers/db.js';

describe('auth', () => {
  beforeEach(async () => {
    await resetDb();
  });

  after(async () => {
    await closeDb();
  });

  test('signs in with a correct password and reflects the session on /me', async () => {
    const { user, password } = await createStaff({ role: 'OWNER' });
    const agent = request.agent(app);

    const login = await agent.post('/api/auth/password').send({ email: user.email, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.email, user.email);

    const me = await agent.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, user.id);
  });

  test('rejects a wrong password', async () => {
    const { user } = await createStaff();
    const res = await request(app).post('/api/auth/password').send({ email: user.email, password: 'not-the-password' });
    assert.equal(res.status, 401);
  });

  test('redeems a login code once and rejects reuse', async () => {
    const staff = await createStaff();
    const code = await createLoginCode({ telegramId: 'redeem-once' });
    await prisma.user.update({ where: { id: staff.user.id }, data: { telegramId: 'redeem-once' } });

    const first = await request(app).post('/api/auth/telegram-code').send({ code: code.code });
    assert.equal(first.status, 200);

    const second = await request(app).post('/api/auth/telegram-code').send({ code: code.code });
    assert.equal(second.status, 401);
  });

  test('rejects an expired login code', async () => {
    const staff = await createStaff();
    const code = await createLoginCode({
      telegramId: 'expired-code',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await prisma.user.update({ where: { id: staff.user.id }, data: { telegramId: 'expired-code' } });

    const res = await request(app).post('/api/auth/telegram-code').send({ code: code.code });
    assert.equal(res.status, 401);
  });

  test('one-tap link redeems the code, sets a cookie, and redirects home', async () => {
    const staff = await createStaff();
    const code = await createLoginCode({ telegramId: 'one-tap' });
    await prisma.user.update({ where: { id: staff.user.id }, data: { telegramId: 'one-tap' } });

    const res = await request(app).get(`/l/${code.code}`);
    assert.equal(res.status, 302);
    assert.ok(res.headers['set-cookie']);
    assert.ok(!res.headers.location.includes('expired'));
  });

  test('one-tap link with a bad code redirects to login with an expired flag', async () => {
    const res = await request(app).get('/l/NOT-A-REAL-CODE');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('/login?expired=1'));
  });

  test('rate limits repeated password attempts from the same client', async () => {
    const { user } = await createStaff();
    let sawTooMany = false;
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post('/api/auth/password').send({ email: user.email, password: 'wrong' });
      if (res.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    assert.equal(sawTooMany, true);
  });
});
