import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { verifyEncryptionKey, EncryptionKeyError } from '../src/lib/keycheck.js';
import { resetDb, closeDb, createEvent, nextEmail } from './helpers/db.js';

describe('startup and housekeeping checks', () => {
  beforeEach(async () => { await resetDb(); });
  after(async () => { await closeDb(); });

  test('records a key check on first run, and accepts the same key after', async () => {
    await verifyEncryptionKey();
    assert.ok(await prisma.setting.findUnique({ where: { key: '__encryption_check' } }));
    await verifyEncryptionKey();
  });

  test('refuses to start when data was encrypted with a different key', async () => {
    // A value encrypted with some other key: well-formed, but won't authenticate.
    await prisma.setting.create({ data: { key: '__encryption_check', value: 'v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==' } });
    await assert.rejects(verifyEncryptionKey(), EncryptionKeyError);
  });

  test('the public settings endpoint only shows branding keys', async () => {
    await prisma.setting.create({ data: { key: '__encryption_check', value: 'secret' } });
    await prisma.setting.create({ data: { key: 'somethingRandom', value: 'x' } });
    const res = await request(app).get('/api/settings');
    assert.equal(res.body.__encryption_check, undefined);
    assert.equal(res.body.somethingRandom, undefined);
    assert.ok(res.body.orgName);
  });

  test('a guest whose registration fails can retry with the same email', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'A' }, { name: 'B' }] });
    const email = nextEmail();
    const fail = await request(app).post(`/api/events/${event.slug}/register`).send({ legalName: 'Jane Doe', email, acceptedTos: true });
    assert.equal(fail.status, 400); // no tier chosen
    const retry = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email, acceptedTos: true, ticketTierId: event.ticketTiers[0].id });
    assert.equal(retry.status, 200);
  });

  test('sitemap renders', async () => {
    await createEvent();
    const res = await request(app).get('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.text, /<urlset/);
  });
});
