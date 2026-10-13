import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { issueToken, COOKIE } from '../src/lib/auth.js';
import { setStripeClient } from '../src/lib/stripe.js';
import { resetDb, closeDb, createEvent, createStaff, createUser, createBan } from './helpers/db.js';
import { WEBHOOK_SECRET, fakeStripe, deliver, stripeEvent } from './helpers/stripe.js';

const cookieFor = (user) => `${COOKIE}=${issueToken(user)}`;

describe('vendor applications', () => {
  let admin;
  let owner;
  let event;
  let full;
  let free;
  let stripe;
  const as = (user) => ({
    get: (p) => request(app).get(p).set('Cookie', cookieFor(user)),
    post: (p, b) => request(app).post(p).set('Cookie', cookieFor(user)).send(b),
    patch: (p, b) => request(app).patch(p).set('Cookie', cookieFor(user)).send(b),
  });
  const APP = { area: 'DEALERS_DEN', businessName: 'Fuzzy Prints', description: 'Art prints, stickers, and enamel pins.', portfolioUrls: ['https://example.com/shop'] };

  beforeEach(async () => {
    await resetDb();
    stripe = fakeStripe();
    setStripeClient(stripe);
    env.stripe.webhookSecret = WEBHOOK_SECRET;
    ({ user: admin } = await createStaff({ role: 'ADMIN' }));
    ({ user: owner } = await createStaff({ role: 'OWNER' }));
    event = await createEvent({ vendorsOpen: true });
    full = await prisma.vendorTableType.create({ data: { eventId: event.id, area: 'DEALERS_DEN', name: 'Full table', priceCents: 15000, quantity: 1 } });
    free = await prisma.vendorTableType.create({ data: { eventId: event.id, area: 'ARTIST_ALLEY', name: 'Alley spot', priceCents: 0, quantity: 5 } });
  });
  afterEach(() => {
    setStripeClient(null);
    env.stripe.webhookSecret = '';
  });
  after(async () => { await closeDb(); });

  const apply = async (user, extra = {}) => as(user).post(`/api/events/${event.slug}/vendors`, { ...APP, tableTypeId: full.id, ...extra });
  const decide = (id, body) => as(admin).post(`/api/admin/vendor-applications/${id}/decision`, body);

  test('one live application per area; portfolio links are checked', async () => {
    const user = await createUser();
    assert.equal((await apply(user, { portfolioUrls: ['not a link'] })).status, 400);
    assert.equal((await apply(user)).status, 200);
    assert.equal((await apply(user)).status, 400, 'second dealers den application');
    assert.equal((await apply(user, { area: 'ARTIST_ALLEY', tableTypeId: free.id })).status, 200, 'the other area is fine');
    assert.equal((await apply(user, { area: 'ARTIST_ALLEY', tableTypeId: full.id })).status, 400, 'table from the wrong area');
  });

  test('accepting takes a table; the last one can\'t go twice', async () => {
    const [a, b] = await Promise.all([apply(await createUser()), apply(await createUser())]);
    const results = await Promise.all([decide(a.body.id, { decision: 'ACCEPTED' }), decide(b.body.id, { decision: 'ACCEPTED' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const lost = results.find((r) => r.status === 400);
    assert.match(lost.body.error, /All 1 Full table tables are taken/);
    const loser = results[0].status === 400 ? a : b;
    assert.equal((await decide(loser.body.id, { decision: 'WAITLISTED' })).body.status, 'WAITLISTED');
  });

  test('a free table is confirmed on acceptance', async () => {
    const user = await createUser();
    const res = await apply(user, { area: 'ARTIST_ALLEY', tableTypeId: free.id });
    const accepted = await decide(res.body.id, { decision: 'ACCEPTED' });
    assert.equal(accepted.body.status, 'CONFIRMED');
    assert.equal(accepted.body.feeCents, 0);
  });

  test('the fee is paid through Stripe Checkout and the webhook confirms the table', async () => {
    const user = await createUser();
    const { body } = await apply(user);
    const accepted = await decide(body.id, { decision: 'ACCEPTED' });
    assert.equal(accepted.body.status, 'ACCEPTED');
    assert.equal(accepted.body.feeCents, 15000);

    const pay = await as(user).post(`/api/my/vendor-applications/${body.id}/pay`);
    assert.equal(pay.status, 200);
    const session = [...stripe.sessions.values()][0];
    assert.equal(session.amount_total, 15000);
    assert.equal(session.metadata.pawpassVendorApplicationId, body.id);

    Object.assign(stripe.sessions.get(session.id), { status: 'complete', payment_status: 'paid', payment_intent: 'pi_vendor_1' });
    stripe.charges.set('ch_vendor_1', { id: 'ch_vendor_1', object: 'charge', payment_intent: 'pi_vendor_1', amount: 15000, amount_refunded: 0 });
    const hook = await deliver(stripeEvent('checkout.session.completed', stripe.sessions.get(session.id)));
    assert.equal(hook.status, 200);
    const app1 = await prisma.vendorApplication.findUnique({ where: { id: body.id } });
    assert.equal(app1.status, 'CONFIRMED');

    const recon = await as(owner).get(`/api/admin/events/${event.id}/reconciliation`);
    assert.equal(recon.body.vendorsTotal, 150);
    assert.equal(recon.body.vendors.STRIPE.total, 150);

    // A full refund gives the table back.
    const payment = await prisma.payment.findFirst({ where: { vendorApplicationId: body.id } });
    const refund = await as(owner).post(`/api/admin/payments/${payment.id}/refund`, {});
    assert.equal(refund.status, 200);
    assert.equal((await prisma.vendorApplication.findUnique({ where: { id: body.id } })).status, 'CANCELLED');
  });

  test('staff can record an in-person payment, which confirms once the fee is covered', async () => {
    const { body } = await apply(await createUser());
    await decide(body.id, { decision: 'ACCEPTED' });
    const part = await as(admin).post(`/api/admin/vendor-applications/${body.id}/payments`, { method: 'CASH', amount: '100' });
    assert.equal(part.body.status, 'ACCEPTED');
    assert.equal(part.body.paidCents, 10000);
    const rest = await as(admin).post(`/api/admin/vendor-applications/${body.id}/payments`, { method: 'CARD', amount: '50' });
    assert.equal(rest.body.status, 'CONFIRMED');
    // Undoing a mistaken entry puts it back to waiting on the fee.
    const card = rest.body.payments.find((p) => p.method === 'CARD');
    const undo = await request(app).delete(`/api/admin/payments/${card.id}`).set('Cookie', cookieFor(admin));
    assert.equal(undo.status, 200);
    assert.equal((await prisma.vendorApplication.findUnique({ where: { id: body.id } })).status, 'ACCEPTED');
  });

  test('only owners set table prices; withdrawn and banned applicants are handled', async () => {
    assert.equal((await as(admin).post(`/api/admin/events/${event.id}/vendor-tables`, { area: 'DEALERS_DEN', name: 'Half', price: '75', quantity: 4 })).status, 403);
    const half = await as(owner).post(`/api/admin/events/${event.id}/vendor-tables`, { area: 'DEALERS_DEN', name: 'Half', price: '75', quantity: 4 });
    assert.equal(half.body.priceCents, 7500);

    const user = await createUser();
    const { body } = await apply(user);
    assert.equal((await as(user).post(`/api/my/vendor-applications/${body.id}/withdraw`)).status, 200);
    assert.equal((await decide(body.id, { decision: 'ACCEPTED' })).status, 400);

    const banned = await createUser({ telegramId: 'tg-banned-vendor' });
    await createBan({ telegramId: 'tg-banned-vendor' });
    assert.equal((await apply(banned)).status, 403);
  });

  test('cancelling an accepted application closes its open checkout', async () => {
    const user = await createUser();
    const { body } = await apply(user);
    await decide(body.id, { decision: 'ACCEPTED' });
    await as(user).post(`/api/my/vendor-applications/${body.id}/pay`);
    const cancelled = await as(admin).post(`/api/admin/vendor-applications/${body.id}/cancel`, {});
    assert.equal(cancelled.body.status, 'CANCELLED');
    const session = [...stripe.sessions.values()][0];
    assert.equal(session.status, 'expired');
    assert.equal((await as(user).post(`/api/my/vendor-applications/${body.id}/pay`)).status, 400);
  });
});
