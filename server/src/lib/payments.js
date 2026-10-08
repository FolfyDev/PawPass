import { prisma } from './db.js';
import { env } from './env.js';
import { audit } from './auth.js';
import { getStripe, syncTier } from './stripe.js';
import { getSettings } from './settings.js';
import { sendRegistrationConfirmation } from './mailer.js';
import { HOLDS_SEAT, promoteFromWaitlist } from './registrations.js';
import { notifyUser, notifyWaitlistPromotion } from '../bot/index.js';

/// The life of an online ticket purchase:
///
///   createRegistration  -> Registration PENDING_PAYMENT (holds a seat)
///                          + Payment STRIPE/PENDING with an expiresAt
///   startCheckout       -> Stripe Checkout session attached to that Payment;
///                          the attendee is redirected to session.url
///   Stripe webhook      -> applyCheckoutSession / applyRefund. Only these
///   (or the sweeper,       ever move money state forward, and only from data
///    or the success-page   fetched from or signed by Stripe — never from
///    sync)                 anything the browser sends.
///
/// Every transition is a compare-and-swap on Payment.status, so the webhook,
/// the sweeper, and the success-page sync can all race on the same session
/// and it still only gets applied once.

export class PaymentError extends Error {}

export const STAFF_PAYMENT_METHODS = ['CASH', 'CARD', 'PAYPAL', 'OTHER'];

const sessionIntentId = (session) =>
  typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;

/// Returns a Stripe Checkout URL for a PENDING_PAYMENT registration — the
/// still-open session if there is one, otherwise a fresh one, which also
/// extends the seat hold.
export async function startCheckout(registrationId) {
  const stripe = getStripe();
  if (!stripe) throw new PaymentError('Online payment is not set up. Contact the organizers.');

  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { event: true, ticketTier: true, payments: { where: { method: 'STRIPE', status: 'PENDING' }, orderBy: { createdAt: 'desc' } } },
  });
  if (!reg) throw new PaymentError('Registration not found.');
  if (reg.status !== 'PENDING_PAYMENT') throw new PaymentError('This registration has nothing left to pay.');

  for (const p of reg.payments.filter((x) => x.stripeSessionId)) {
    const session = await stripe.checkout.sessions.retrieve(p.stripeSessionId);
    if (session.status === 'open' && session.expires_at * 1000 > Date.now() + 60_000) return session.url;
    await applyCheckoutSession(session);
    if (session.status === 'complete') throw new PaymentError('This payment has already gone through — refresh your tickets.');
  }
  // Settling an expired session above may have released the hold.
  const { status } = await prisma.registration.findUnique({ where: { id: reg.id }, select: { status: true } });
  if (status !== 'PENDING_PAYMENT') throw new PaymentError('Your held spot expired before payment went through. Register again to get a new one.');

  let tier = reg.ticketTier;
  if (!tier || tier.priceCents <= 0) throw new PaymentError('This ticket type is no longer for sale. Contact the organizers.');
  if (!tier.stripePriceId) tier = await syncTier(tier, reg.event);
  if (!tier.stripePriceId) throw new PaymentError('Payment for this ticket type is not available right now. Contact the organizers.');

  // Reuse the Payment row createRegistration opened (no session yet), so a
  // registration has one pending payment per attempt, not two.
  const unattached = reg.payments.find((p) => !p.stripeSessionId && p.expiresAt > new Date());
  const expiresAt = new Date(Date.now() + env.stripe.checkoutMinutes * 60_000);
  const payment = unattached
    ? await prisma.payment.update({ where: { id: unattached.id }, data: { amountCents: tier.priceCents, currency: tier.currency, expiresAt } })
    : await prisma.payment.create({
        data: { registrationId: reg.id, method: 'STRIPE', status: 'PENDING', amountCents: tier.priceCents, currency: tier.currency, expiresAt },
      });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: tier.stripePriceId, quantity: 1 }],
      client_reference_id: reg.id,
      customer_email: reg.email || undefined,
      metadata: { pawpassRegistrationId: reg.id, pawpassPaymentId: payment.id, pawpassEventId: reg.eventId },
      payment_intent_data: { metadata: { pawpassRegistrationId: reg.id, pawpassPaymentId: payment.id } },
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      success_url: `${env.webUrl}/tickets?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.webUrl}/e/${reg.event.slug}?payment=cancelled`,
    }, { idempotencyKey: `pawpass-checkout-${payment.id}` });
    await prisma.payment.update({ where: { id: payment.id }, data: { stripeSessionId: session.id } });
    return session.url;
  } catch (e) {
    // Left PENDING with no session: a retry reuses it, and if nobody retries
    // the sweeper expires it at expiresAt and releases the seat.
    console.error('stripe checkout create failed', reg.id, e.message);
    await prisma.payment.update({ where: { id: payment.id }, data: { note: e.message } });
    throw new PaymentError('Could not start the payment. Try again in a moment.');
  }
}

/// Applies whatever state a Checkout session is in. Idempotent; safe to call
/// with a stale or repeated session object.
export async function applyCheckoutSession(session) {
  const payment = await prisma.payment.findUnique({ where: { stripeSessionId: session.id } });
  if (!payment) return null; // not one of ours (another app on the same Stripe account)
  if (session.status === 'complete' && ['paid', 'no_payment_required'].includes(session.payment_status)) {
    return markPaid(payment, session);
  }
  if (session.status === 'expired') return markEnded(payment, 'EXPIRED');
  return null; // still open, or complete-but-unpaid (async payment still in flight)
}

async function markPaid(payment, session) {
  // The session should be exactly the one startCheckout opened for this
  // payment, at the amount it was opened for. Anything else (a session on the
  // same Stripe account made by something other than PawPass, or one whose
  // amount doesn't match) is flagged for a human instead of confirming a ticket.
  const mismatch = [
    session.metadata?.pawpassPaymentId !== payment.id && 'payment id',
    session.amount_total !== payment.amountCents && 'amount',
    session.currency && session.currency !== payment.currency && 'currency',
  ].filter(Boolean);
  if (mismatch.length) {
    await audit(null, 'payment.mismatch', payment.id, {
      sessionId: session.id, mismatch, expectedCents: payment.amountCents, sessionCents: session.amount_total,
    });
    console.warn(`Stripe session ${session.id} does not match payment ${payment.id} (${mismatch.join(', ')}) — not confirming it.`);
    return null;
  }

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      // EXPIRED/FAILED too: an async payment method can succeed after the
      // session itself expired, and that money is real.
      where: { id: payment.id, status: { in: ['PENDING', 'EXPIRED', 'FAILED'] } },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        stripePaymentIntentId: sessionIntentId(session),
        amountCents: session.amount_total ?? payment.amountCents,
        currency: session.currency ?? payment.currency,
      },
    });
    if (!claimed.count) return null;

    const reg = await tx.registration.findUnique({ where: { id: payment.registrationId }, include: { event: true } });
    if (reg.status === 'CONFIRMED' || reg.status === 'WAITLIST') return { reg, confirmed: false };

    // PENDING_PAYMENT is the normal case. CANCELLED means the hold lapsed (or
    // they cancelled) before Stripe told us it was paid — they still paid, so
    // take them back if there's room, otherwise flag it for a refund.
    if (reg.status === 'CANCELLED' && reg.event.capacity) {
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${reg.eventId} FOR UPDATE`;
      const held = await tx.registration.count({ where: { eventId: reg.eventId, status: { in: HOLDS_SEAT } } });
      if (held >= reg.event.capacity) return { reg, confirmed: false, orphaned: true };
    }

    let badgeNumber = reg.badgeNumber;
    if (badgeNumber == null) {
      const ev = await tx.event.update({ where: { id: reg.eventId }, data: { nextBadgeNumber: { increment: 1 } } });
      badgeNumber = ev.nextBadgeNumber - 1;
    }
    const updated = await tx.registration.update({
      where: { id: reg.id },
      data: { status: 'CONFIRMED', badgeNumber },
      include: { event: true, user: true },
    });
    return { reg: updated, confirmed: true };
  });
  if (!result) return null;

  await audit(null, 'payment.paid', payment.id, { registrationId: payment.registrationId, amountCents: session.amount_total, sessionId: session.id });
  if (result.orphaned) {
    await audit(null, 'payment.paid_after_cancel', payment.id, { registrationId: payment.registrationId, code: result.reg.code });
    console.warn(`Payment ${payment.id} completed for cancelled registration ${result.reg.code} on a full event — refund it from the Stripe dashboard.`);
  }
  if (result.confirmed) {
    await expireOtherSessions(payment.registrationId, payment.id);
    await notifyPaid(result.reg);
  }
  return result;
}

async function markEnded(payment, status) {
  const ended = await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status } });
  if (ended.count) await releaseIfUnheld(payment.registrationId);
  return ended.count ? { ended: status } : null;
}

/// Cancels a PENDING_PAYMENT registration once nothing is keeping its seat —
/// no pending attempt left and nothing paid — and hands the seat on.
async function releaseIfUnheld(registrationId) {
  const live = await prisma.payment.count({ where: { registrationId, status: { in: ['PENDING', 'PAID', 'PARTIALLY_REFUNDED'] } } });
  if (live) return;
  const released = await prisma.registration.updateMany({ where: { id: registrationId, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
  if (!released.count) return;
  const reg = await prisma.registration.findUnique({ where: { id: registrationId } });
  await audit(null, 'registration.hold_expired', registrationId, { code: reg.code });
  await notifyWaitlistPromotion(await promoteFromWaitlist(reg.eventId));
}

/// After one attempt succeeds, close any other checkout the same person still
/// has open (e.g. a second tab), so they can't pay twice.
async function expireOtherSessions(registrationId, keepPaymentId) {
  const stripe = getStripe();
  const others = await prisma.payment.findMany({ where: { registrationId, status: 'PENDING', id: { not: keepPaymentId } } });
  for (const p of others) {
    if (p.stripeSessionId && stripe) {
      try { await stripe.checkout.sessions.expire(p.stripeSessionId); } catch { /* already complete/expired — the webhook settles it */ }
    }
    await prisma.payment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
  }
}

/// For an attendee cancelling a registration that's still waiting on
/// payment: close the checkout so it can't be paid afterwards.
export async function abandonPendingPayments(registrationId) {
  await expireOtherSessions(registrationId, null);
}

/// Mirrors a refund issued in the Stripe dashboard. A full refund also gives
/// up the ticket (unless they're already checked in); a partial one doesn't.
export async function applyRefund(charge) {
  const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return null;
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intentId } });
  if (!payment) return null;
  // Refunds only ever add up: a late-arriving event for an earlier, smaller
  // refund must not wind the recorded total back down.
  const refunded = Math.max(charge.amount_refunded, payment.amountRefundedCents);
  const full = refunded >= charge.amount;
  await prisma.payment.update({
    where: { id: payment.id },
    data: { amountRefundedCents: refunded, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
  });
  await audit(null, 'payment.refunded', payment.id, { amountRefundedCents: charge.amount_refunded, full });
  if (!full) return { full };
  const reg = await prisma.registration.findUnique({ where: { id: payment.registrationId } });
  if (reg && reg.status !== 'CANCELLED' && !reg.checkedInAt) {
    await prisma.registration.update({ where: { id: reg.id }, data: { status: 'CANCELLED' } });
    await notifyWaitlistPromotion(await promoteFromWaitlist(reg.eventId));
  }
  return { full };
}

/// The event body is only used for its object ID. What actually gets applied
/// is fetched fresh from the Stripe API with our secret key, so even someone
/// holding STRIPE_WEBHOOK_SECRET can't sign a fake "paid" event into existence —
/// the most a forged event can do is make us re-check a real object's real state.
/// Fetching also sidesteps out-of-order delivery: we always act on the latest state.
export async function handleStripeEvent(event) {
  const stripe = getStripe();
  const id = event.data?.object?.id;
  if (typeof id !== 'string') return null;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.expired': {
      if (!id.startsWith('cs_')) return null;
      if (!(await prisma.payment.findUnique({ where: { stripeSessionId: id } }))) return null; // not ours — skip the API call
      return applyCheckoutSession(await stripe.checkout.sessions.retrieve(id));
    }
    case 'checkout.session.async_payment_failed': {
      if (!id.startsWith('cs_')) return null;
      const payment = await prisma.payment.findUnique({ where: { stripeSessionId: id } });
      if (!payment) return null;
      const session = await stripe.checkout.sessions.retrieve(id);
      if (session.payment_status === 'paid') return applyCheckoutSession(session);
      return markEnded(payment, 'FAILED');
    }
    case 'charge.refunded': {
      if (!id.startsWith('ch_') && !id.startsWith('py_')) return null;
      return applyRefund(await stripe.charges.retrieve(id));
    }
    default:
      return null;
  }
}

/// sk_live_/rk_live_ keys expect live-mode events, sk_test_/rk_test_ test-mode
/// ones; null when the key doesn't say (e.g. in tests).
function expectedLivemode() {
  const key = env.stripe.secretKey;
  if (/^(sk|rk)_live_/.test(key)) return true;
  if (/^(sk|rk)_test_/.test(key)) return false;
  return null;
}

/// Express handler — mounted with express.raw() ahead of express.json() in
/// app.js, since the signature is over the exact bytes Stripe sent.
export async function stripeWebhook(req, res) {
  const stripe = getStripe();
  if (!stripe || !env.stripe.webhookSecret) return res.status(503).json({ error: 'Stripe is not configured.' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.stripe.webhookSecret);
  } catch {
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  // A test-mode event reaching a live instance (or the reverse) means the
  // endpoint or secret is wired to the wrong Stripe mode — refuse it rather
  // than let a sandbox "payment" confirm a real ticket.
  const live = expectedLivemode();
  if (live !== null && typeof event.livemode === 'boolean' && event.livemode !== live) {
    console.warn(`Rejected Stripe event ${event.id}: livemode=${event.livemode} but STRIPE_SECRET_KEY is ${live ? 'live' : 'test'}.`);
    return res.status(400).json({ error: 'Event mode does not match this instance.' });
  }

  // Claim the event ID first: a redelivery that arrives while this one is
  // still running gets a 200 and does nothing. If handling fails, the claim
  // is released so Stripe's own retry of this delivery can run it again.
  try {
    await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch (e) {
    if (e.code === 'P2002') return res.json({ received: true, duplicate: true });
    throw e;
  }
  try {
    await handleStripeEvent(event);
  } catch (e) {
    await prisma.stripeEvent.delete({ where: { id: event.id } }).catch(() => {});
    throw e;
  }
  res.json({ received: true });
}

/// Backstop for a missed or delayed webhook: settles every pending payment
/// whose hold has run out, by asking Stripe directly.
export async function sweepExpiredHolds() {
  const stripe = getStripe();
  const due = await prisma.payment.findMany({
    where: { method: 'STRIPE', status: 'PENDING', expiresAt: { lt: new Date() } },
    take: 50,
  });
  for (const p of due) {
    try {
      if (!p.stripeSessionId) { await markEnded(p, 'EXPIRED'); continue; }
      if (!stripe) continue;
      await applyCheckoutSession(await stripe.checkout.sessions.retrieve(p.stripeSessionId));
    } catch (e) {
      console.error('payment sweep failed', p.id, e.message);
    }
  }
}

export function startPaymentSweeper() {
  const timer = setInterval(() => sweepExpiredHolds().catch((e) => console.error('payment sweep failed', e.message)), 60_000);
  timer.unref();
  return timer;
}

/// The Stripe success_url lands here (via the web app) with the session ID.
/// Settles it straight from Stripe so the attendee sees their ticket confirmed
/// immediately instead of waiting on the webhook — the ID alone proves
/// nothing, since the state is fetched from Stripe, not taken from the request.
export async function syncSessionForUser(sessionId, userId) {
  const stripe = getStripe();
  if (!stripe || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) return null;
  const payment = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId }, include: { registration: true } });
  if (!payment || payment.registration.userId !== userId) return null;
  await applyCheckoutSession(await stripe.checkout.sessions.retrieve(sessionId));
  return prisma.registration.findUnique({ where: { id: payment.registrationId } });
}

async function notifyPaid(reg) {
  if (reg.user?.telegramId) {
    await notifyUser(reg.user.telegramId,
      `Payment received — you are registered for ${reg.event.title}.\n\n` +
      `Badge code: ${reg.code}\n` +
      `Ticket: ${env.webUrl}/tickets`);
  }
  const settings = await getSettings();
  await sendRegistrationConfirmation(reg, reg.event, settings)
    .catch((e) => console.error('payment confirmation email failed', reg.code, e.message));
}

/// Staff-recorded payment (kiosk, attendee editor). Amount in cents.
export async function recordInPersonPayment({ registrationId, method, amountCents, note, processedById, currency = 'usd' }, tx = prisma) {
  if (!STAFF_PAYMENT_METHODS.includes(method)) throw new PaymentError('Choose how the payment was received.');
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new PaymentError('Enter the amount received.');
  return tx.payment.create({
    data: {
      registrationId, method, status: 'PAID', amountCents, currency,
      note: note?.trim() || null, paidAt: new Date(), processedById,
    },
  });
}

/// Dollars-and-cents input from a form ("12.5", 12.5) to integer cents.
export function toCents(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/// Payment rollup used by shapeReg: what's actually been received, net of refunds.
export function paymentSummary(r) {
  if (!r.payments) return {};
  const settled = r.payments.filter((p) => p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED');
  const paidCents = settled.reduce((sum, p) => sum + p.amountCents - p.amountRefundedCents, 0);
  const priceCents = r.ticketTier?.priceCents ?? null;
  return {
    paidCents,
    paymentMethod: settled.at(-1)?.method ?? null,
    balanceDueCents: priceCents ? Math.max(priceCents - paidCents, 0) : 0,
    payments: r.payments.map((p) => ({
      id: p.id, method: p.method, status: p.status, amountCents: p.amountCents,
      amountRefundedCents: p.amountRefundedCents, currency: p.currency, note: p.note,
      paidAt: p.paidAt, createdAt: p.createdAt,
    })),
  };
}
