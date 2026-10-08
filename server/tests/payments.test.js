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
    // A refund through the API updates the charge the way Stripe would.
    refunds: {
      create: async (params) => {
        const charge = [...charges.values()].find((c) => c.payment_intent === params.payment_intent);
        charge.amount_refunded += params.amount ?? charge.amount - charge.amount_refunded;
        return { id: id('re'), charge: charge.id, status: 'succeeded' };
      },
    },
    // Fees come from the charge's balance transaction: 2.9% + 30c.
    paymentIntents: {
      retrieve: async (pid) => {
        const charge = [...charges.values()].find((c) => c.payment_intent === pid);
        if (!charge) return { id: pid, latest_charge: null };
        const fee = Math.round(charge.amount * 0.029) + 30;
        return { id: pid, latest_charge: { ...charge, balance_transaction: { fee, net: charge.amount - fee } } };
      },
    },
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
          const line = (li) => (li.price ? prices.get(li.price) : { unit_amount: li.price_data.unit_amount, currency: li.price_data.currency });
          const amount = params.line_items.reduce((sum, li) => sum + line(li).unit_amount * li.quantity, 0);
          const s = {
            id: id('cs'), url: `https://checkout.stripe.test/${n}`, status: 'open', payment_status: 'unpaid',
            expires_at: params.expires_at, metadata: params.metadata, amount_total: amount, currency: line(params.line_items[0]).currency,
            payment_intent: null, line_items: params.line_items,
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
    piSeq = 0;
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

  /// Marks a session paid, and creates the charge behind it (so refunds and
  /// fee lookups have something to find).
  let piSeq = 0;
  const complete = (session, intent) => {
    const s = stripe.sessions.get(session.id);
    const pi = intent || (piSeq++ === 0 ? 'pi_test_1' : `pi_test_${piSeq}`);
    Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi });
    if (![...stripe.charges.values()].some((c) => c.payment_intent === pi)) {
      stripe.charges.set(`ch_for_${pi}`, { id: `ch_for_${pi}`, object: 'charge', payment_intent: pi, amount: s.amount_total, amount_refunded: 0 });
    }
    return s;
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

  test('cuts off an address sending forged webhooks without blocking Stripe', async () => {
    const { reg, session } = await paidRegistration();
    // Two proxy hops, like Cloudflare Tunnel -> nginx: the client's address
    // first, then the private address of the proxy in between.
    const from = (ip) => request(app).post('/api/stripe/webhook')
      .set('Content-Type', 'application/json').set('X-Forwarded-For', `${ip}, 172.18.0.3`);

    let status;
    for (let i = 0; i < 31; i++) {
      ({ status } = await from('203.0.113.66').set('stripe-signature', 't=1,v1=forged').send('{}'));
    }
    assert.equal(status, 429, 'the forging address is blocked after 30 rejections');

    // A real delivery from a different address still goes through.
    const payload = JSON.stringify(stripeEvent('checkout.session.completed', complete(session)));
    const header = real.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const ok = await from('3.18.12.63').set('stripe-signature', header).send(payload);
    assert.equal(ok.status, 200);
    assert.equal((await prisma.registration.findUnique({ where: { id: reg.id } })).status, 'CONFIRMED');
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
    assert.equal(stripe.products.get(created.body.stripeProductId).name, `${event.title}: Super Sponsor`);

    const repriced = await agent.patch(`/api/admin/tiers/${created.body.id}`).send({ price: '30' });
    assert.notEqual(repriced.body.stripePriceId, firstPrice);
    assert.equal(stripe.prices.get(repriced.body.stripePriceId).unit_amount, 3000);
    assert.equal(stripe.prices.get(firstPrice).active, false);
    assert.equal(stripe.products.get(created.body.stripeProductId).default_price, repriced.body.stripePriceId);
  });

  /* ------------------------------------------------ helpers for below ---- */

  async function owner() {
    const { user, password } = await createStaff({ role: 'OWNER' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });
    return agent;
  }

  let signInSeq = 0;
  async function signInAs(userId) {
    const tg = `tg-test-${++signInSeq}-${Date.now()}`;
    await prisma.user.update({ where: { id: userId }, data: { telegramId: tg } });
    await prisma.loginCode.create({ data: { code: `SIGNIN${signInSeq}${Date.now()}`.slice(0, 20), telegramId: tg } });
    const code = (await prisma.loginCode.findFirst({ where: { telegramId: tg } })).code;
    const agent = request.agent(app);
    await agent.get(`/l/${code}`);
    return agent;
  }

  const lastSession = () => [...stripe.sessions.values()].at(-1);

  /* --------------------------------------------------- discount codes ---- */

  test('a percent discount code lowers the checkout and is given back if the hold lapses', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Sponsor', priceCents: 5000 }] });
    const code = await prisma.discountCode.create({ data: { eventId: event.id, code: 'SPRING20', percentOff: 20, maxUses: 1 } });

    const preview = await request(app).post(`/api/events/${event.slug}/discount`).send({ code: 'spring20', ticketTierId: event.ticketTiers[0].id });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.ticketCents, 4000);

    const res = await register(event, event.ticketTiers[0].id, { discountCode: 'spring20' });
    assert.equal(res.body.status, 'PENDING_PAYMENT');
    assert.equal(lastSession().amount_total, 4000);
    assert.equal(res.body.chargeCents, 4000);
    assert.equal((await prisma.discountCode.findUnique({ where: { id: code.id } })).usedCount, 1);

    // Used up while that hold is live.
    const second = await register(event, event.ticketTiers[0].id, { legalName: 'Second Person', discountCode: 'SPRING20' });
    assert.equal(second.status, 400);

    stripe.sessions.get(lastSession().id).status = 'expired';
    const session = [...stripe.sessions.values()][0];
    stripe.sessions.get(session.id).status = 'expired';
    await deliver(stripeEvent('checkout.session.expired', session));
    assert.equal((await prisma.discountCode.findUnique({ where: { id: code.id } })).usedCount, 0);
  });

  test('a discount code limited to one tier is refused on another', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Sponsor', priceCents: 5000 }, { name: 'Attendee', priceCents: 2000 }] });
    await prisma.discountCode.create({ data: { eventId: event.id, code: 'SPONSORONLY', amountOffCents: 1000, tierIds: [event.ticketTiers[0].id] } });
    const res = await register(event, event.ticketTiers[1].id, { discountCode: 'SPONSORONLY' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /doesn't apply/);
  });

  /* --------------------------------------------------- donation add-on ---- */

  test('a donation add-on is a second line on the same checkout, and reported separately', async () => {
    const event = await createEvent({ donationAddonEnabled: true }, { tiers: [{ name: 'Sponsor', priceCents: 2500 }] });
    const res = await register(event, event.ticketTiers[0].id, { donationCents: 1000 });
    assert.equal(res.body.status, 'PENDING_PAYMENT');
    const session = lastSession();
    assert.equal(session.line_items.length, 2);
    assert.equal(session.amount_total, 3500);

    await deliver(stripeEvent('checkout.session.completed', complete(session)));
    const reg = await prisma.registration.findUnique({ where: { code: res.body.code } });
    assert.equal(reg.status, 'CONFIRMED');

    const agent = await owner();
    const recon = await agent.get(`/api/admin/events/${event.id}/reconciliation`);
    assert.equal(recon.body.tickets.STRIPE.total, 25);
    assert.equal(recon.body.donations.STRIPE.total, 10);
    // 2.9% + 30c on $35.00, from the fake balance transaction.
    assert.equal(recon.body.stripe.feeCents, 132);
    assert.equal(recon.body.stripe.netCents, 3500 - 132);
  });

  test('a free ticket with a donation goes through checkout for just the donation', async () => {
    const event = await createEvent({ donationAddonEnabled: true }, { tiers: [{ name: 'Attendee' }] });
    const res = await register(event, event.ticketTiers[0].id, { donationCents: 500 });
    assert.equal(res.body.status, 'PENDING_PAYMENT');
    assert.equal(lastSession().amount_total, 500);
    assert.equal(lastSession().line_items.length, 1);
  });

  test('ignores a donation when the event has the add-on turned off', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Attendee' }] });
    const res = await register(event, event.ticketTiers[0].id, { donationCents: 500 });
    assert.equal(res.body.status, 'CONFIRMED');
  });

  /* ------------------------------------------------------ sale windows ---- */

  test('a tier outside its sale window cannot be bought, and an ended one drops off the page', async () => {
    const hour = 3600_000;
    const event = await createEvent({}, {
      tiers: [
        { name: 'Early bird', priceCents: 2000, salesEndAt: new Date(Date.now() - hour) },
        { name: 'Late', priceCents: 3000, salesStartAt: new Date(Date.now() + hour) },
        { name: 'Regular', priceCents: 2500 },
      ],
    });
    const [early, late] = event.ticketTiers;
    assert.equal((await register(event, early.id)).status, 400);
    const notYet = await register(event, late.id, { legalName: 'Too Early' });
    assert.equal(notYet.status, 400);
    assert.match(notYet.body.error, /go on sale/);

    const page = await request(app).get(`/api/events/${event.slug}`);
    assert.deepEqual(page.body.tiers.map((t) => [t.name, t.onSale]), [['Late', false], ['Regular', true]]);
  });

  /* ----------------------------------------------------------- refunds ---- */

  test('the refund button refunds through Stripe and a full refund cancels the ticket', async () => {
    const { reg, session } = await paidRegistration();
    await deliver(stripeEvent('checkout.session.completed', complete(session)));
    const payment = await prisma.payment.findFirst({ where: { registrationId: reg.id, status: 'PAID' } });

    const agent = await owner();
    const partial = await agent.post(`/api/admin/payments/${payment.id}/refund`).send({ amount: '5.00' });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.registration.status, 'CONFIRMED');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'PARTIALLY_REFUNDED');

    const tooMuch = await agent.post(`/api/admin/payments/${payment.id}/refund`).send({ amount: '100' });
    assert.equal(tooMuch.status, 400);

    const rest = await agent.post(`/api/admin/payments/${payment.id}/refund`).send({});
    assert.equal(rest.status, 200);
    assert.equal(rest.body.registration.status, 'CANCELLED');
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(after.status, 'REFUNDED');
    assert.equal(after.amountRefundedCents, 2500);
  });

  test('refunding an in-person payment just records it', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Sponsor', priceCents: 5000 }] });
    const agent = await owner();
    const reg = await agent.post('/api/admin/registrations').send({
      eventId: event.id, legalName: 'Walk In', ticketTierId: event.ticketTiers[0].id, payment: { method: 'CASH', amount: '50' },
    });
    const payment = reg.body.payments[0];
    const res = await agent.post(`/api/admin/payments/${payment.id}/refund`).send({ amount: '20' });
    assert.equal(res.status, 200);
    assert.equal(res.body.registration.paidCents, 3000);
    assert.equal(res.body.registration.balanceDueCents, 2000);
  });

  test('only owners can refund', async () => {
    const { reg, session } = await paidRegistration();
    await deliver(stripeEvent('checkout.session.completed', complete(session)));
    const payment = await prisma.payment.findFirst({ where: { registrationId: reg.id, status: 'PAID' } });
    const { user, password } = await createStaff({ role: 'ADMIN' });
    const admin = request.agent(app);
    await admin.post('/api/auth/password').send({ email: user.email, password });
    assert.equal((await admin.post(`/api/admin/payments/${payment.id}/refund`).send({})).status, 403);
  });

  /* --------------------------------------------------- merch pre-orders ---- */

  async function preorderSetup() {
    const event = await createEvent({}, { tiers: [{ name: 'Attendee' }] });
    const shirt = await prisma.merchItem.create({ data: { eventId: event.id, name: 'Shirt', price: 20, maxCount: 3, preorder: true } });
    const res = await register(event, event.ticketTiers[0].id);
    const reg = await prisma.registration.findUnique({ where: { code: res.body.code } });
    return { event, shirt, reg, agent: await signInAs(reg.userId) };
  }

  test('a merch pre-order holds stock through checkout and is marked paid', async () => {
    const { event, shirt, agent } = await preorderSetup();
    const res = await agent.post(`/api/events/${event.slug}/merch/orders`).send({ items: [{ itemId: shirt.id, quantity: 2 }] });
    assert.equal(res.status, 200);
    assert.ok(res.body.checkoutUrl);
    assert.equal(lastSession().amount_total, 4000);
    assert.equal((await prisma.merchItem.findUnique({ where: { id: shirt.id } })).soldCount, 2);

    // Only 1 left — someone else can't take 2.
    const tooMany = await agent.post(`/api/events/${event.slug}/merch/orders`).send({ items: [{ itemId: shirt.id, quantity: 2 }] });
    assert.equal(tooMany.status, 400);

    await deliver(stripeEvent('checkout.session.completed', complete(lastSession())));
    const orders = await agent.get('/api/my/merch-orders');
    assert.equal(orders.body[0].status, 'PAID');

    const staff = await owner();
    const merch = await staff.get(`/api/admin/events/${event.id}/merch`);
    assert.equal(merch.body.preorders.length, 1);
    const picked = await staff.post(`/api/admin/merch-orders/${orders.body[0].id}/pickup`).send({});
    assert.ok(picked.body.pickedUpAt);
    const recon = await staff.get(`/api/admin/events/${event.id}/reconciliation`);
    assert.equal(recon.body.merch.STRIPE.total, 40);
  });

  test('an expired pre-order puts its stock back', async () => {
    const { event, shirt, agent } = await preorderSetup();
    await agent.post(`/api/events/${event.slug}/merch/orders`).send({ items: [{ itemId: shirt.id, quantity: 3 }] });
    const session = lastSession();
    stripe.sessions.get(session.id).status = 'expired';
    await deliver(stripeEvent('checkout.session.expired', session));
    assert.equal((await prisma.merchItem.findUnique({ where: { id: shirt.id } })).soldCount, 0);
    assert.equal((await prisma.merchOrder.findFirst({ where: { eventId: event.id } })).status, 'CANCELLED');
  });

  test('pre-orders are only for confirmed attendees and pre-order items', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Attendee' }] });
    const tableOnly = await prisma.merchItem.create({ data: { eventId: event.id, name: 'Sticker', price: 2, maxCount: 10 } });
    const stranger = await prisma.user.create({ data: { displayName: 'No Ticket' } });
    const agent = await signInAs(stranger.id);
    const res = await agent.post(`/api/events/${event.slug}/merch/orders`).send({ items: [{ itemId: tableOnly.id, quantity: 1 }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /confirmed attendees/);
  });

  /* ----------------------------------------------- cancellation policy ---- */

  async function paidAndSignedIn(policy) {
    const event = await createEvent({ cancelPolicy: policy }, { tiers: [{ name: 'Sponsor', priceCents: 2500 }] });
    const res = await register(event, event.ticketTiers[0].id);
    await deliver(stripeEvent('checkout.session.completed', complete(lastSession())));
    const reg = await prisma.registration.findUnique({ where: { code: res.body.code } });
    return { event, reg, agent: await signInAs(reg.userId) };
  }

  test('AUTO_REFUND: an attendee cancelling a paid ticket is refunded straight away', async () => {
    const { reg, agent } = await paidAndSignedIn('AUTO_REFUND');
    const res = await agent.post(`/api/my/tickets/${reg.code}/cancel`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'refunded');
    const after = await prisma.registration.findUnique({ where: { id: reg.id }, include: { payments: true } });
    assert.equal(after.status, 'CANCELLED');
    assert.equal(after.payments.find((p) => p.stripePaymentIntentId).status, 'REFUNDED');
  });

  test('REQUEST: cancelling asks an owner, who can approve (refund) or decline', async () => {
    const { reg, agent } = await paidAndSignedIn('REQUEST');
    const res = await agent.post(`/api/my/tickets/${reg.code}/cancel`).send({ note: 'Got sick' });
    assert.equal(res.body.outcome, 'requested');
    const pending = await prisma.registration.findUnique({ where: { id: reg.id } });
    assert.equal(pending.status, 'CONFIRMED');
    assert.ok(pending.cancelRequestedAt);
    assert.equal((await agent.post(`/api/my/tickets/${reg.code}/cancel`).send({})).body.outcome, 'already_requested');

    const staff = await owner();
    const declined = await staff.post(`/api/admin/registrations/${reg.code}/cancel-request`).send({ approve: false });
    assert.equal(declined.body.status, 'CONFIRMED');
    assert.equal(declined.body.cancelRequestedAt, null);

    await agent.post(`/api/my/tickets/${reg.code}/cancel`).send({});
    const approved = await staff.post(`/api/admin/registrations/${reg.code}/cancel-request`).send({ approve: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'CANCELLED');
    assert.ok(approved.body.payments.some((p) => p.status === 'REFUNDED'));
  });

  test('a free ticket is cancelled directly whatever the policy', async () => {
    const event = await createEvent({ cancelPolicy: 'REQUEST' }, { tiers: [{ name: 'Attendee' }] });
    const res = await register(event, event.ticketTiers[0].id);
    const reg = await prisma.registration.findUnique({ where: { code: res.body.code } });
    const agent = await signInAs(reg.userId);
    const cancel = await agent.post(`/api/my/tickets/${reg.code}/cancel`).send({});
    assert.equal(cancel.body.outcome, 'cancelled');
  });

  test('the admin event list counts confirmed and held spots, not cancelled ones', async () => {
    const event = await createEvent({ capacity: 10 }, { tiers: [{ name: 'Attendee' }, { name: 'Sponsor', priceCents: 2500 }] });
    const [free, paid] = event.ticketTiers;
    const a = await register(event, free.id);
    await register(event, free.id, { legalName: 'Second Person' });
    await register(event, paid.id, { legalName: 'Mid Checkout' });
    await prisma.registration.update({ where: { code: a.body.code }, data: { status: 'CANCELLED' } });

    const staff = await owner();
    const list = await staff.get('/api/admin/events');
    const row = list.body.find((e) => e.id === event.id);
    assert.equal(row.confirmed, 1);
    assert.equal(row.awaitingPayment, 1);
    assert.equal(row.registrationCount, 2);
    assert.equal((await request(app).get(`/api/events/${event.slug}`)).body.confirmed, 1);
  });
});
