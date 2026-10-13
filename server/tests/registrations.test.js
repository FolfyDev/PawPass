import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { resetDb, closeDb, createEvent, createVoucher, createStaff, nextEmail } from './helpers/db.js';

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

  test('requires choosing a ticket type when an event has more than one', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Attendee' }, { name: 'Sponsor', priceCents: 5000 }] });
    const [attendee, sponsor] = event.ticketTiers;

    const none = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true });
    assert.equal(none.status, 400);

    const free = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, ticketTierId: attendee.id });
    assert.equal(free.status, 200);
    assert.equal(free.body.tierName, 'Attendee');
    assert.equal(free.body.balanceDueCents, 0);

    // No Stripe configured: a paid tier is confirmed with the balance due at the door.
    const paid = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'John Doe', email: nextEmail(), acceptedTos: true, ticketTierId: sponsor.id });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'CONFIRMED');
    assert.equal(paid.body.tierName, 'Sponsor');
    assert.equal(paid.body.balanceDueCents, 5000);
    assert.equal(paid.body.checkoutUrl, undefined);
  });

  test('refuses a tier that is inactive or belongs to another event', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Attendee' }, { name: 'Old', active: false }] });
    const other = await createEvent();
    for (const ticketTierId of [event.ticketTiers[1].id, other.ticketTiers[0].id]) {
      const res = await request(app).post(`/api/events/${event.slug}/register`)
        .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, ticketTierId });
      assert.equal(res.status, 400);
    }
  });

  test('closes registration when no tier is on sale', async () => {
    const event = await createEvent({}, { tiers: [] });
    const res = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No tickets/);
  });

  test('stops selling a tier at its own limit, without waitlisting', async () => {
    const event = await createEvent({ waitlistEnabled: true }, { tiers: [{ name: 'Early bird', capacity: 1 }, { name: 'Attendee' }] });
    const [early] = event.ticketTiers;
    const a = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'First Attendee', email: nextEmail(), acceptedTos: true, ticketTierId: early.id });
    assert.equal(a.status, 200);
    const b = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Second Attendee', email: nextEmail(), acceptedTos: true, ticketTierId: early.id });
    assert.equal(b.status, 400);
    assert.match(b.body.error, /sold out/);

    const page = await request(app).get(`/api/events/${event.slug}`);
    assert.deepEqual(page.body.tiers.map((t) => [t.name, t.soldOut]), [['Early bird', true], ['Attendee', false]]);
  });

  test('a voucher bypasses tiers and records no tier', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Sponsor', priceCents: 5000 }, { name: 'Attendee' }] });
    const voucher = await createVoucher(event.id);
    const res = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, voucherCode: voucher.code });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticketTierId, null);
    assert.equal(res.body.badgeTier, 'Organizer');
  });

  test('kiosk records an in-person payment for a paid tier', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Sponsor', priceCents: 5000 }] });
    const { user, password } = await createStaff({ role: 'ADMIN' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });

    const res = await agent.post('/api/admin/registrations').send({
      eventId: event.id, legalName: 'Walk In', ticketTierId: event.ticketTiers[0].id,
      payment: { method: 'CASH', amount: '50.00', note: 'exact change' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.paidCents, 5000);
    assert.equal(res.body.paymentMethod, 'CASH');
    assert.equal(res.body.balanceDueCents, 0);

    const recon = await agent.get(`/api/admin/events/${event.id}/reconciliation`);
    assert.equal(recon.body.tickets.CASH.total, 50);
    assert.equal(recon.body.unpaidTickets, 0);
  });

  test('admin search finds an attendee by a partial, case-insensitive name match, even though the field is encrypted at rest', async () => {
    const event = await createEvent();
    await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Zelda Zephyrhawk', email: nextEmail(), acceptedTos: true });
    await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Someone Else', email: nextEmail(), acceptedTos: true });

    const { user, password } = await createStaff({ role: 'ADMIN' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });

    const res = await agent.get(`/api/admin/events/${event.id}/registrations?q=zephyr`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].legalName, 'Zelda Zephyrhawk');
  });
});
