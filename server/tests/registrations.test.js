import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { resetDb, closeDb, createEvent, createVoucher, nextEmail } from './helpers/db.js';

describe('registrations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  after(async () => {
    await closeDb();
  });

  test('registers a guest and confirms the ticket', async () => {
    const event = await createEvent();
    const email = nextEmail();

    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', fursonaName: 'Jay', email, acceptedTos: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CONFIRMED');
    assert.ok(res.body.code);
  });

  test('rejects registration without accepting terms', async () => {
    const event = await createEvent();
    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail() });
    assert.equal(res.status, 400);
  });

  test('blocks a second registration for the same event under the same email', async () => {
    const event = await createEvent();
    const email = nextEmail();
    const body = { legalName: 'Jane Doe', email, acceptedTos: true };

    const first = await request(app).post(`/api/events/${event.slug}/register`).send(body);
    assert.equal(first.status, 200);

    const second = await request(app).post(`/api/events/${event.slug}/register`).send(body);
    assert.equal(second.status, 409);
  });

  test('waitlists once capacity is reached, when waitlisting is on', async () => {
    const event = await createEvent({ capacity: 1, waitlistEnabled: true });

    const a = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'First Attendee', email: nextEmail(), acceptedTos: true });
    assert.equal(a.status, 200);
    assert.equal(a.body.status, 'CONFIRMED');

    const b = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Second Attendee', email: nextEmail(), acceptedTos: true });
    assert.equal(b.status, 200);
    assert.equal(b.body.status, 'WAITLIST');
  });

  test('rejects registration once full, when waitlisting is off', async () => {
    const event = await createEvent({ capacity: 1, waitlistEnabled: false });

    const a = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'First Attendee', email: nextEmail(), acceptedTos: true });
    assert.equal(a.status, 200);

    const b = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Second Attendee', email: nextEmail(), acceptedTos: true });
    assert.equal(b.status, 400);
  });

  test('a voucher grants a confirmed spot even when the event is full', async () => {
    const event = await createEvent({ capacity: 1, waitlistEnabled: false });
    const voucher = await createVoucher(event.id, { maxUses: 1 });

    const a = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'First Attendee', email: nextEmail(), acceptedTos: true });
    assert.equal(a.status, 200);

    const b = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Voucher Holder', email: nextEmail(), acceptedTos: true, voucherCode: voucher.code });
    assert.equal(b.status, 200);
    assert.equal(b.body.status, 'CONFIRMED');
    assert.equal(b.body.badgeTier, 'Organizer');
  });

  test('a used-up voucher is rejected', async () => {
    const event = await createEvent();
    const voucher = await createVoucher(event.id, { maxUses: 1 });

    const a = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'First Claim', email: nextEmail(), acceptedTos: true, voucherCode: voucher.code });
    assert.equal(a.status, 200);

    const b = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Second Claim', email: nextEmail(), acceptedTos: true, voucherCode: voucher.code });
    assert.equal(b.status, 400);
  });

  test('requires an answer to a required custom field', async () => {
    const event = await createEvent({
      customFields: [{ key: 'shirt', label: 'Shirt size', type: 'text', required: true }],
    });

    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, answers: {} });
    assert.equal(res.status, 400);

    const ok = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, answers: { shirt: 'L' } });
    assert.equal(ok.status, 200);
  });

  test('forces the donation tier when the event requires payment', async () => {
    const event = await createEvent({ donationRequired: true, donationPaypalLink: 'https://paypal.me/test' });
    const res = await request(app)
      .post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, tier: 'FREE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'DONATION');
  });
});
