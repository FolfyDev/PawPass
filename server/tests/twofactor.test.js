import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { codeAt, currentStep, verifyCode, base32Decode, base32Encode } from '../src/lib/totp.js';
import { resetDb, closeDb, createStaff } from './helpers/db.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;
const sessionFrom = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE}=`));

describe('two-factor sign-in', () => {
  let staff;
  let password;

  beforeEach(async () => {
    await resetDb();
    ({ user: staff, password } = await createStaff({ role: 'OWNER' }));
  });

  after(async () => {
    await closeDb();
  });

  /// Runs setup and enable the way the Account page does; returns the
  /// secret (as the app would hold it) and the recovery codes.
  async function enable() {
    const setup = await request(app).post('/api/auth/2fa/setup').set('Cookie', cookieFor(staff));
    assert.equal(setup.status, 200);
    assert.match(setup.body.qr, /^data:image\/png;base64,/);
    const res = await request(app).post('/api/auth/2fa/enable').set('Cookie', cookieFor(staff))
      .send({ code: codeAt(setup.body.secret, currentStep()) });
    assert.equal(res.status, 200);
    staff = await prisma.user.findUnique({ where: { id: staff.id } });
    return { secret: setup.body.secret, recoveryCodes: res.body.recoveryCodes };
  }

  const signIn = () => request(app).post('/api/auth/password').send({ email: staff.email, password });
  const second = (challenge, code) => request(app).post('/api/auth/password/2fa').send({ challenge, code });

  test('matches the RFC 6238 test vector', () => {
    // RFC 6238 appendix B, SHA-1: secret "12345678901234567890", T = 59s.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
    assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'));
    assert.equal(verifyCode(secret, '287082', { now: 59_000 }), 1);
  });

  test('without two-factor, a password signs straight in', async () => {
    const res = await signIn();
    assert.ok(sessionFrom(res));
    assert.equal(res.body.user.hasTwoFactor, false);
  });

  test('with it on, the password only gets a challenge; the code finishes sign-in, once', async () => {
    const { secret } = await enable();
    const first = await signIn();
    assert.equal(first.body.twoFactor, true);
    assert.equal(sessionFrom(first), undefined, 'no session from the password alone');

    assert.equal((await second(first.body.challenge, '000000')).status, 401);
    // The code used to turn it on was already spent; the next step's code works.
    const code = codeAt(secret, currentStep() + 1);
    const ok = await second(first.body.challenge, code);
    assert.equal(ok.status, 200);
    assert.ok(sessionFrom(ok));

    const replay = await second((await signIn()).body.challenge, code);
    assert.equal(replay.status, 401, 'a code works once');
  });

  test('recovery codes each work once', async () => {
    const { recoveryCodes } = await enable();
    assert.equal(recoveryCodes.length, 8);
    const use = async (c) => second((await signIn()).body.challenge, c);
    assert.equal((await use(recoveryCodes[0].toLowerCase())).status, 200, 'case and dash don\'t matter');
    assert.equal((await use(recoveryCodes[0])).status, 401);
    const me = await prisma.user.findUnique({ where: { id: staff.id } });
    assert.equal(me.totpRecoveryHashes.length, 7);
  });

  test('a challenge dies with a logout, and forged ones are refused', async () => {
    const { secret } = await enable();
    const { challenge } = (await signIn()).body;
    await prisma.user.update({ where: { id: staff.id }, data: { tokenVersion: { increment: 1 } } });
    assert.equal((await second(challenge, codeAt(secret, currentStep() + 1))).status, 401);
    // A normal session token isn't a challenge.
    assert.equal((await second(issueToken(staff), codeAt(secret, currentStep() + 1))).status, 401);
  });

  test('the secret is encrypted at rest', async () => {
    const { secret } = await enable();
    const [row] = await prisma.$queryRaw`SELECT "totpSecret" FROM "User" WHERE id = ${staff.id}`;
    assert.match(row.totpSecret, /^v1:/);
    assert.ok(!row.totpSecret.includes(secret));
  });

  test('turning it off needs a current code; an owner can reset someone else\'s', async () => {
    const { secret } = await enable();
    assert.equal((await request(app).post('/api/auth/2fa/disable').set('Cookie', cookieFor(staff)).send({ code: '123456' })).status, 400);

    const { user: owner } = await createStaff({ role: 'OWNER' });
    const reset = await request(app).post(`/api/admin/users/${staff.id}/2fa/reset`).set('Cookie', cookieFor(owner));
    assert.equal(reset.status, 200);
    assert.equal(reset.body.hasTwoFactor, false);
    assert.ok(sessionFrom(await signIn()), 'password alone works again');
    assert.ok(secret);
  });
});
