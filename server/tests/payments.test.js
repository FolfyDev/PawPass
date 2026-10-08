import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Stripe from 'stripe';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { setStripeClient } from '../src/lib/stripe.js';
import { sweepExpiredHolds } from '../src/lib/payments.js';
import { resetDb, closeDb, createEvent, createStaff, nextEmail } from './helpers/db.js';

const WEBHOOK_SECRET = 'whsec_pawpass_test';
const real = new Stripe('sk_test_pawpass_dummy');

/// Just enough of the Stripe API for PawPass, in memory. Webhook signing and
/// verification use the real SDK (it's local crypto, no network).
function fakeStripe() {
  let n = 0;
  const id = (prefix) => `${prefix}_test_${++n}`;
  const products = new Map();
  const prices = new Map();
  const sessions = new Map();
  const charges = new Map();
  return {
    sessions,
    charges: Object.assign(charges, {
      retrieve: async (cid) => ({ ...charges.get(cid) }),
    }),
    webhooks: real.webhooks,
    products: Object.assign(products, {
      create: async (p) => { const prod = { id: id('prod'), ...p }; products.set(prod.id, prod); return prod; },
      update: async (pid, p) => { Object.assign(products.get(pid), p); return products.get(pid); },
    }),
    prices: Object.assign(prices, {
      create: async (p) => { const price = { id: id('price'), active: true, ...p }; prices.set(price.id, price); return price; },
      retrieve: async (pid) => prices.get(pid),
      update: async (pid, p) => { Object.assign(prices.get(pid), p); return prices.get(pid); },
    }),
    checkout: {
      sessions: {
        create: async (params) => {
          const price = prices.get(params.line_items[0].price);
          const s = {
            id: id('cs'), url: `https://checkout.stripe.test/${n}`, status: 'open', payment_status: 'unpaid',
            expires_at: params.expires_at, metadata: params.metadata, amount_total: price.unit_amount, currency: price.currency,
            payment_intent: null,
          };
          sessions.set(s.id, s);
          return s;
        },
        retrieve: async (sid) => ({ ...sessions.get(sid) }),
        expire: async (sid) => { sessions.get(sid).status = 'expired'; return sessions.get(sid); },
      },
    },
  };
}

function deliver(event) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').set('stripe-signature', header).send(payload);
}

let evtSeq = 0;
const stripeEvent = (type, object) => ({ id: `evt_test_${++evtSeq}_${Date.now()}`, object: 'event', type, data: { object } });

describe('stripe payments', () => {
  let stripe;

  beforeEach(async () => {
    await resetDb();
    stripe = fakeStripe();
    setStripeClient(stripe);
    env.stripe.webhookSecret = WEBHOOK_SECRET;
  });

  afterEach(() => {
    setStripeClient(null);
    env.stripe.webhookSecret = '';
    env.stripe.secretKey = '';
  });

  after(async () => {
    await closeDb();
  });

  const register = (event, ticketTierId, body = {}) => request(app)
    .post(`/api/events/${event.slug}/register`)
    .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, ticketTierId, ...body });

  async function paidRegistration(eventOverrides = {}) {
    const event = await createEvent(eventOverrides, { tiers: [{ name: 'Sponsor', priceCents: 2500 }] });
    const res = await register(event, event.ticketTiers[0].id);
    const reg = await prisma.registration.findUnique({ where: { code: res.body.code }, include: { payments: true } });
    return { event, res, reg, session: [...stripe.sessions.values()].at(-1) };
  }

  const complete = (session) => {
    Object.assign(stripe.sessions.get(session.id), { status: 'complete', payment_status: 'paid', payment_intent: 'pi_test_1' });
    return stripe.sessions.get(session.id);
  };

  test('a paid tier holds the seat and hands back a Checkout URL', async () => {
    const { res, reg, session } = await paidRegistration();
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'PENDING_PAYMENT');
    assert.equal(res.body.checkoutUrl, session.url);
    assert.equal(reg.badgeNumber, null);
    assert.equal(reg.payments.length, 1);
    assert.equal(reg.payments[0].stripeSessionId, session.id);
    // The tier was pushed to Stripe on demand, at the right amount.
    const price = [...stripe.prices.values()][0];
    assert.equal(price.unit_amount, 2500);
    assert.equal(price.currency, 'usd');
  });

  test('the completed webhook confirms the ticket, and a redelivery is a no-op', async () => {
    const { reg, session } = await paidRegistration();
    const event = stripeEvent('checkout.session.completed', complete(session));

    const first = await deliver(event);
    assert.equal(first.status, 200);
    const confirmed = await prisma.registration.findUnique({ where: { id: reg.id }, include: { payments: true } });
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(confirmed.badgeNumber, 1);
    assert.equal(confirmed.payments[0].status, 'PAID');
    assert.equal(confirmed.payments[0].stripePaymentIntentId, 'pi_test_1');

    const again = await deliver(event);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal((await prisma.event.findUnique({ where: { id: reg.eventId } })).nextBadgeNumber, 2);
  });

  test('a correctly signed event that lies about the payment confirms nothing', async () => {
    // Someone with the webhook secret signs "this session is paid" — but
    // Stripe itself still says it's open, and that's what gets applied.
    const { reg, session } = await paidRegistration();
    const forged = { ...session, status: 'complete', payment_status: 'paid' };
    const res = await deliver(stripeEvent('checkout.session.completed', forged));
    assert.equal(res.status, 200);
    assert.equal((await prisma.registration.findUnique({ where: { id: reg.id } })).status, 'PENDING_PAYMENT');
  });

  test('a paid session for the wrong amount is flagged, not confirmed', async () => {
    const { reg, session } = await paidRegistration();
    Object.assign(complete(session), { amount_total: 100 });
    await deliver(stripeEvent('checkout.session.completed', stripe.sessions.get(session.id)));
    assert.equal((await prisma.registration.findUnique({ where: { id: reg.id } })).status, 'PENDING_PAYMENT');
    assert.equal(await prisma.auditLog.count({ where: { action: 'payment.mismatch' } }), 1);
  });

  test('refuses a test-mode event on a live-mode instance', async () => {
    const { reg, session } = await paidRegistration();
    env.stripe.secretKey = 'sk_live_pawpass_dummy';
    const res = await deliver({ ...stripeEvent('checkout.session.completed', complete(session)), livemode: false });
    assert.equal(res.status, 400);
    assert.equal((await prisma.registration.findUnique({ where: { id: reg.id } })).status, 'PENDING_PAYMENT');
  });

  test('a late event for an earlier partial refund does not undo a full one', async () => {
    const { reg, session } = await paidRegistration();
    await deliver(stripeEvent('checkout.session.completed', complete(session)));
    const charge = { id: 'ch_test_2', object: 'charge', payment_intent: 'pi_test_1', amount: 2500, amount_refunded: 2500 };
    stripe.charges.set(charge.id, charge);
    await deliver(stripeEvent('charge.refunded', charge));
    // Stale state from an earlier partial refund (as if fetched before the full one).
    stripe.charges.set(charge.id, { ...charge, amount_refunded: 1000 });
    await deliver(stripeEvent('charge.refunded', { ...charge, amount_refunded: 1000 }));
    const p = await prisma.payment.findFirst({ where: { registrationId: reg.id, status: { not: 'EXPIRED' } } });
    assert.equal(p.status, 'REFUNDED');
    assert.equal(p.amountRefundedCents, 2500);
  });

  test('rejects a webhook with a bad signature', async () => {
    const res = await request(app).post('/api/stripe/webhook')
      .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=deadbeef')
      .send(JSON.stringify(stripeEvent('checkout.session.completed', {})));
    assert.equal(res.status, 400);
  });

  test('the success page can settle the session without the webhook', async () => {
    const { session, reg } = await paidRegistration();
    complete(session);
    const agent = request.agent(app);
    // The guest registration set a session cookie on that response — sign
    // in as the same user to call the sync endpoint.
    const user = await prisma.user.findUnique({ where: { id: reg.userId } });
    await prisma.loginCode.create({ data: { code: 'SYNCTEST1', telegramId: 'tg-sync' } });
    await prisma.user.update({ where: { id: user.id }, data: { telegramId: 'tg-sync' } });
    await agent.get('/l/SYNCTEST1');
    const res = await agent.post('/api/my/payments/sync').send({ sessionId: session.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CONFIRMED');
  });

  test('an expired session cancels the hold and promotes the waitlist', async () => {
    const event = await createEvent({ capacity: 1, waitlistEnabled: true }, { tiers: [{ name: 'Sponsor', priceCents: 2500 }, { name: 'Attendee' }] });
    const [sponsor, attendee] = event.ticketTiers;
    const paid = await register(event, sponsor.id);
    assert.equal(paid.body.status, 'PENDING_PAYMENT');

    const free = await register(event, attendee.id, { legalName: 'Second Person' });
    assert.equal(free.body.status, 'WAITLIST', 'the pending checkout holds the only seat');

    // A paid ticket never waitlists — there'd be nothing to charge for.
    const paidWhenFull = await register(event, sponsor.id, { legalName: 'Third Person' });
    assert.equal(paidWhenFull.status, 400);

    const session = [...stripe.sessions.values()][0];
    stripe.sessions.get(session.id).status = 'expired';
    await deliver(stripeEvent('checkout.session.expired', stripe.sessions.get(session.id)));

    assert.equal((await prisma.registration.findUnique({ where: { code: paid.body.code } })).status, 'CANCELLED');
    assert.equal((await prisma.registration.findUnique({ where: { code: free.body.code } })).status, 'CONFIRMED');
  });

  test('the sweeper settles a hold whose webhook never arrived', async () => {
    const { reg, session } = await paidRegistration();
    stripe.sessions.get(session.id).status = 'expired';
    await prisma.payment.updateMany({ where: { registrationId: reg.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await sweepExpiredHolds();
    assert.equal((await prisma.registration.findUnique({ where: { id: reg.id } })).status, 'CANCELLED');
  });

  test('a full refund in Stripe cancels the ticket', async () => {
    const { reg, session } = await paidRegistration();
    await deliver(stripeEvent('checkout.session.completed', complete(session)));
    const charge = { id: 'ch_test_1', object: 'charge', payment_intent: 'pi_test_1', amount: 2500, amount_refunded: 2500 };
    stripe.charges.set(charge.id, charge);
    await deliver(stripeEvent('charge.refunded', charge));
    const after = await prisma.registration.findUnique({ where: { id: reg.id }, include: { payments: true } });
    assert.equal(after.status, 'CANCELLED');
    assert.equal(after.payments[0].status, 'REFUNDED');
  });

  test('check-in refuses a ticket whose payment never completed', async () => {
    const { res } = await paidRegistration();
    const { user, password } = await createStaff({ role: 'ADMIN' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });
    const scan = await agent.post('/api/admin/checkin').send({ value: res.body.code });
    assert.equal(scan.status, 409);
  });

  test('changing a tier price makes a new Stripe price and archives the old one', async () => {
    const event = await createEvent({}, { tiers: [] });
    const { user, password } = await createStaff({ role: 'OWNER' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });

    const created = await agent.post(`/api/admin/events/${event.id}/tiers`).send({ name: 'Sponsor', price: '25.00' });
    assert.equal(created.status, 200);
    assert.ok(created.body.stripeProductId);
    const firstPrice = created.body.stripePriceId;

    const renamed = await agent.patch(`/api/admin/tiers/${created.body.id}`).send({ name: 'Super Sponsor' });
    assert.equal(renamed.body.stripePriceId, firstPrice, 'a rename keeps the price');
    assert.equal(stripe.products.get(created.body.stripeProductId).name, `${event.title} — Super Sponsor`);

    const repriced = await agent.patch(`/api/admin/tiers/${created.body.id}`).send({ price: '30' });
    assert.notEqual(repriced.body.stripePriceId, firstPrice);
    assert.equal(stripe.prices.get(repriced.body.stripePriceId).unit_amount, 3000);
    assert.equal(stripe.prices.get(firstPrice).active, false);
    assert.equal(stripe.products.get(created.body.stripeProductId).default_price, repriced.body.stripePriceId);
  });
});
