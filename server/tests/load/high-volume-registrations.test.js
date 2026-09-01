import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/db.js';
import { resetDb, closeDb, createEvent, createVoucher, nextEmail } from '../helpers/db.js';

function registerOne(slug, name, email) {
  return request(app)
    .post(`/api/events/${slug}/register`)
    .send({ legalName: name, email, acceptedTos: true });
}

describe('high volume registrations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  after(async () => {
    await closeDb();
  });

  test('capacity is never oversold under concurrent registration, with waitlisting on', async () => {
    const capacity = 10;
    const concurrentAttempts = 30;
    const event = await createEvent({ capacity, waitlistEnabled: true });

    const responses = await Promise.all(
      Array.from({ length: concurrentAttempts }, (_, i) => registerOne(event.slug, `Attendee ${i}`, nextEmail())),
    );

    const succeeded = responses.filter((r) => r.status === 200);
    assert.equal(succeeded.length, concurrentAttempts);

    const confirmed = await prisma.registration.count({ where: { eventId: event.id, status: 'CONFIRMED' } });
    const waitlisted = await prisma.registration.count({ where: { eventId: event.id, status: 'WAITLIST' } });

    assert.ok(
      confirmed <= capacity,
      `expected at most ${capacity} confirmed registrations, got ${confirmed}. `
      + 'This event has a fixed capacity and concurrent registrations must not oversell it.',
    );
    assert.equal(confirmed + waitlisted, concurrentAttempts);
  });

  test('registration is refused past capacity under concurrent load, with waitlisting off', async () => {
    const capacity = 5;
    const concurrentAttempts = 20;
    const event = await createEvent({ capacity, waitlistEnabled: false });

    const responses = await Promise.all(
      Array.from({ length: concurrentAttempts }, (_, i) => registerOne(event.slug, `Attendee ${i}`, nextEmail())),
    );

    const succeeded = responses.filter((r) => r.status === 200).length;
    const rejected = responses.filter((r) => r.status === 400).length;

    const confirmed = await prisma.registration.count({ where: { eventId: event.id, status: 'CONFIRMED' } });

    assert.ok(
      confirmed <= capacity,
      `expected at most ${capacity} confirmed registrations, got ${confirmed}`,
    );
    assert.equal(succeeded, confirmed);
    assert.equal(succeeded + rejected, concurrentAttempts);
  });

  test('a limited-use voucher is never redeemed more than maxUses times under concurrent load', async () => {
    const maxUses = 3;
    const concurrentAttempts = 12;
    const event = await createEvent();
    const voucher = await createVoucher(event.id, { maxUses });

    const responses = await Promise.all(
      Array.from({ length: concurrentAttempts }, (_, i) =>
        request(app)
          .post(`/api/events/${event.slug}/register`)
          .send({ legalName: `Voucher Claimant ${i}`, email: nextEmail(), acceptedTos: true, voucherCode: voucher.code })),
    );

    const succeeded = responses.filter((r) => r.status === 200).length;
    const rejected = responses.filter((r) => r.status === 400).length;

    const redeemed = await prisma.registration.count({ where: { voucherCodeId: voucher.id } });
    const row = await prisma.voucherCode.findUnique({ where: { id: voucher.id } });

    assert.equal(succeeded, maxUses);
    assert.equal(rejected, concurrentAttempts - maxUses);
    assert.equal(redeemed, maxUses);
    assert.equal(row.usedCount, maxUses);
  });

  test('throughput: unlimited-capacity event absorbs a burst of concurrent registrations', async () => {
    const concurrentAttempts = 150;
    const event = await createEvent();

    const startedAt = Date.now();
    const responses = await Promise.all(
      Array.from({ length: concurrentAttempts }, (_, i) => registerOne(event.slug, `Attendee ${i}`, nextEmail())),
    );
    const elapsedMs = Date.now() - startedAt;

    const succeeded = responses.filter((r) => r.status === 200).length;
    assert.equal(succeeded, concurrentAttempts);

    console.log(`registered ${concurrentAttempts} attendees concurrently in ${elapsedMs}ms`);
  });
});
