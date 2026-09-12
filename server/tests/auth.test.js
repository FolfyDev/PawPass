import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken } from '../src/lib/auth.js';
import { resetDb, closeDb, createStaff, createUser, createLoginCode, createEmailLoginCode, nextEmail } from './helpers/db.js';

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

  test('end users cannot sign in with a password even if one is somehow set', async () => {
    const email = nextEmail();
    await createUser({ email, passwordHash: bcrypt.hashSync('irrelevant-but-long', 4), role: 'USER' });

    const res = await request(app).post('/api/auth/password').send({ email, password: 'irrelevant-but-long' });
    assert.equal(res.status, 401);
  });

  test('issues a session that expires in about a day', () => {
    const token = issueToken({ id: 'x', role: 'USER' });
    const payload = jwt.decode(token);
    const lifetimeSeconds = payload.exp - payload.iat;
    assert.ok(Math.abs(lifetimeSeconds - 24 * 3600) < 5, `expected a ~1 day token, got ${lifetimeSeconds}s`);
  });

  test('requests and redeems an email sign-in code', async () => {
    const email = nextEmail();
    await createUser({ email });

    const request1 = await request(app).post('/api/auth/email-code/request').send({ email });
    assert.equal(request1.status, 200);

    const row = await prisma.emailLoginCode.findFirst({ orderBy: { createdAt: 'desc' } });
    const verify = await request(app).post('/api/auth/email-code/verify').send({ email, code: row.code });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.user.email, email);

    const reuse = await request(app).post('/api/auth/email-code/verify').send({ email, code: row.code });
    assert.equal(reuse.status, 401);
  });

  test('requesting an email code for an unknown address does not reveal that', async () => {
    const res = await request(app).post('/api/auth/email-code/request').send({ email: nextEmail() });
    assert.equal(res.status, 200);
    const count = await prisma.emailLoginCode.count();
    assert.equal(count, 0);
  });

  test('rejects an email code for the wrong address', async () => {
    const email = nextEmail();
    await createUser({ email });
    const code = await createEmailLoginCode(email);

    const res = await request(app).post('/api/auth/email-code/verify').send({ email: nextEmail(), code: code.code });
    assert.equal(res.status, 401);
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
