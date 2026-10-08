import rateLimit from 'express-rate-limit';
import { prisma } from './db.js';
import { env } from './env.js';
import { audit } from './auth.js';
import { getStripe, syncTier } from './stripe.js';
import { getSettings } from './settings.js';
import { sendRegistrationConfirmation, sendNoticeEmail } from './mailer.js';
import { HOLDS_SEAT, promoteFromWaitlist, cancelRegistration } from './registrations.js';
import { registrationCharge, STRIPE_MIN_CHARGE_CENTS } from './pricing.js';
import { notifyUser, notifyWaitlistPromotion } from '../bot/index.js';

/// The life of an online purchase — a ticket or a merch pre-order:
///
///   createRegistration / createMerchOrder
///                       -> the thing being bought is held (a seat, or stock)
///                          + Payment STRIPE/PENDING with an expiresAt
///   startCheckout / startOrderCheckout
///                       -> Stripe Checkout session attached to that Payment;
///                          the buyer is redirected to session.url
///   Stripe webhook      -> applyCheckoutSession / applyRefund. Only these
///   (or the sweeper,       ever move money state forward, and only from data
///    or the success-page   fetched from or signed by Stripe — never from
///    sync)                 anything the browser sends.
///
/// Every transition is a compare-and-swap on Payment.status, so the webhook,
/// the sweeper, and the success-page sync can all race on the same session
/// and it still only gets applied once. A Payment points at exactly one of
/// a registration or a merch order (enforced by a CHECK constraint).

export class PaymentError extends Error {}

export const STAFF_PAYMENT_METHODS = ['CASH', 'CARD', 'PAYPAL', 'OTHER'];

const sessionIntentId = (session) =>
  typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;

const targetOf = (payment) => (payment.registrationId ? { registrationId: payment.registrationId } : { merchOrderId: payment.merchOrderId });

/* ------------------------------------------------------------ checkout ---- */

/// Settles any session already attached to these pending payments. Returns
/// the open session's URL to reuse, or null. Throws if one already completed.
async function reuseOpenSession(stripe, payments) {
  for (const p of payments.filter((x) => x.stripeSessionId)) {
    const session = await stripe.checkout.sessions.retrieve(p.stripeSessionId);
    if (session.status === 'open' && session.expires_at * 1000 > Date.now() + 60_000) return session.url;
    await applyCheckoutSession(session);
    if (session.status === 'complete') throw new PaymentError('This payment already went through. Refresh the page.');
  }
  return null;
}

/// Creates the Stripe session for a pending Payment row (reused if there's
/// one without a session yet, so each attempt has one pending payment).
async function openSession(stripe, { pending, target, amountCents, donationCents = 0, currency, lineItems, email, metadata, successPath, cancelPath }) {
  if (amountCents < STRIPE_MIN_CHARGE_CENTS) throw new PaymentError('This is below the minimum Stripe can charge. Contact the organizers.');
  const unattached = pending.find((p) => !p.stripeSessionId && p.expiresAt > new Date());
  const expiresAt = new Date(Date.now() + env.stripe.checkoutMinutes * 60_000);
  const payment = unattached
    ? await prisma.payment.update({ where: { id: unattached.id }, data: { amountCents, donationCents, currency, expiresAt } })
    : await prisma.payment.create({ data: { ...target, method: 'STRIPE', status: 'PENDING', amountCents, donationCents, currency, expiresAt } });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: email || undefined,
      client_reference_id: target.registrationId || target.merchOrderId,
      metadata: { ...metadata, pawpassPaymentId: payment.id },
      payment_intent_data: { metadata: { ...metadata, pawpassPaymentId: payment.id } },
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      success_url: `${env.webUrl}${successPath}${successPath.includes('?') ? '&' : '?'}paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.webUrl}${cancelPath}`,
    }, { idempotencyKey: `pawpass-checkout-${payment.id}` });
    await prisma.payment.update({ where: { id: payment.id }, data: { stripeSessionId: session.id } });
    return session.url;
  } catch (e) {
    // Left PENDING with no session: a retry reuses it, and if nobody retries
    // the sweeper expires it at expiresAt and releases the hold.
    console.error('stripe checkout create failed', target, e.message);
    await prisma.payment.update({ where: { id: payment.id }, data: { note: e.message } });
    throw new PaymentError('Could not start the payment. Try again in a moment.');
  }
}

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

  const reuse = await reuseOpenSession(stripe, reg.payments);
  if (reuse) return reuse;
  // Settling an expired session above may have released the hold.
  const { status } = await prisma.registration.findUnique({ where: { id: reg.id }, select: { status: true } });
  if (status !== 'PENDING_PAYMENT') throw new PaymentError('Your held spot expired before payment went through. Register again to get a new one.');

  let tier = reg.ticketTier;
  if (!tier) throw new PaymentError('This ticket type is no longer for sale. Contact the organizers.');
  const charge = registrationCharge({ tierPriceCents: tier.priceCents, discountCents: reg.discountCents, donationCents: reg.donationCents });
  if (charge.ticketCents > 0 && (!tier.stripePriceId || !tier.stripeProductId)) tier = await syncTier(tier, reg.event);
  if (charge.ticketCents > 0 && !tier.stripePriceId) throw new PaymentError('Payment for this ticket type is not available right now. Contact the organizers.');

  // The synced Stripe price when it's the plain price; with a discount the
  // same product at the discounted amount, so the dashboard still groups it.
  const lineItems = [];
  if (charge.ticketCents > 0) {
    lineItems.push(reg.discountCents
      ? { price_data: { currency: tier.currency, product: tier.stripeProductId, unit_amount: charge.ticketCents }, quantity: 1 }
      : { price: tier.stripePriceId, quantity: 1 });
  }
  if (charge.donationCents > 0) {
    lineItems.push({
      price_data: { currency: tier.currency, unit_amount: charge.donationCents, product_data: { name: `${reg.event.donationAddonLabel}: ${reg.event.title}` } },
      quantity: 1,
    });
  }

  return openSession(stripe, {
    pending: reg.payments,
    target: { registrationId: reg.id },
    amountCents: charge.totalCents,
    donationCents: charge.donationCents,
    currency: tier.currency,
    lineItems,
    email: reg.email,
    metadata: { pawpassRegistrationId: reg.id, pawpassEventId: reg.eventId },
    successPath: '/tickets',
    cancelPath: `/e/${reg.event.slug}?payment=cancelled`,
  });
}

/// Same as startCheckout, for a PENDING merch pre-order.
export async function startOrderCheckout(orderId) {
  const stripe = getStripe();
  if (!stripe) throw new PaymentError('Online payment is not set up. Contact the organizers.');

  const order = await prisma.merchOrder.findUnique({
    where: { id: orderId },
    include: { event: true, user: true, items: true, payments: { where: { method: 'STRIPE', status: 'PENDING' }, orderBy: { createdAt: 'desc' } } },
  });
  if (!order) throw new PaymentError('Order not found.');
  if (order.status !== 'PENDING') throw new PaymentError('This order has nothing left to pay.');

  const reuse = await reuseOpenSession(stripe, order.payments);
  if (reuse) return reuse;
  const { status } = await prisma.merchOrder.findUnique({ where: { id: order.id }, select: { status: true } });
  if (status !== 'PENDING') throw new PaymentError('This order expired before payment went through. Place it again.');

  return openSession(stripe, {
    pending: order.payments,
    target: { merchOrderId: order.id },
    amountCents: order.totalCents,
    currency: order.currency,
    lineItems: order.items.map((i) => ({
      price_data: { currency: order.currency, unit_amount: i.unitPriceCents, product_data: { name: `${i.name}: ${order.event.title} (pre-order)` } },
      quantity: i.quantity,
    })),
    email: order.user.email,
    metadata: { pawpassMerchOrderId: order.id, pawpassEventId: order.eventId },
    successPath: '/tickets',
    cancelPath: `/e/${order.event.slug}?payment=cancelled`,
  });
}

/* ---------------------------------------------------- applying results ---- */

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
  // The session should be exactly the one PawPass opened for this payment,
  // at the amount it was opened for. Anything else (a session on the same
  // Stripe account made by something other than PawPass, or one whose amount
  // doesn't match) is flagged for a human instead of confirming anything.
  const mismatch = [
    session.metadata?.pawpassPaymentId !== payment.id && 'payment id',
    session.amount_total !== payment.amountCents && 'amount',
    session.currency && session.currency !== payment.currency && 'currency',
  ].filter(Boolean);
  if (mismatch.length) {
    await audit(null, 'payment.mismatch', payment.id, {
      sessionId: session.id, mismatch, expectedCents: payment.amountCents, sessionCents: session.amount_total,
    });
    console.warn(`Stripe session ${session.id} does not match payment ${payment.id} (${mismatch.join(', ')}). Not confirming it.`);
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
    return payment.registrationId ? confirmRegistration(tx, payment.registrationId) : confirmOrder(tx, payment.merchOrderId);
  });
  if (!result) return null;

  await audit(null, 'payment.paid', payment.id, { ...targetOf(payment), amountCents: session.amount_total, sessionId: session.id });
  if (result.orphaned) {
    await audit(null, 'payment.paid_after_cancel', payment.id, targetOf(payment));
    console.warn(`Payment ${payment.id} completed for something that had already been released (${JSON.stringify(targetOf(payment))}). Refund it from the attendee editor or Stripe.`);
  }
  await captureFees(payment.id).catch((e) => console.error('stripe fee lookup failed', payment.id, e.message));
  if (result.confirmed) {
    await expireOtherSessions(targetOf(payment), payment.id);
    if (result.reg) await notifyPaid(result.reg);
    if (result.order) await notifyOrderPaid(result.order);
  }
  return result;
}

async function confirmRegistration(tx, registrationId) {
  const reg = await tx.registration.findUnique({ where: { id: registrationId }, include: { event: true } });
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
}

async function confirmOrder(tx, orderId) {
  const order = await tx.merchOrder.findUnique({ where: { id: orderId }, include: { items: true, event: true, user: true } });
  if (order.status === 'PAID') return { order, confirmed: false };
  // CANCELLED: the hold lapsed and the stock went back — try to take it again.
  // All or nothing: if any item has sold out since, put back what was just
  // re-taken (throwing would also undo marking the payment PAID) and flag it.
  if (order.status === 'CANCELLED') {
    const taken = [];
    for (const i of order.items) {
      const item = await tx.merchItem.findUnique({ where: { id: i.itemId } });
      const ok = item && (await tx.merchItem.updateMany({
        where: { id: i.itemId, soldCount: { lte: item.maxCount - i.quantity } },
        data: { soldCount: { increment: i.quantity } },
      })).count;
      if (!ok) {
        for (const t of taken) await tx.merchItem.update({ where: { id: t.itemId }, data: { soldCount: { decrement: t.quantity } } });
        return { order, confirmed: false, orphaned: true };
      }
      taken.push(i);
    }
  }
  const updated = await tx.merchOrder.update({ where: { id: order.id }, data: { status: 'PAID' }, include: { items: true, event: true, user: true } });
  return { order: updated, confirmed: true };
}

async function markEnded(payment, status) {
  const ended = await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status } });
  if (!ended.count) return null;
  if (payment.registrationId) await releaseIfUnheld(payment.registrationId);
  else await releaseOrderIfUnheld(payment.merchOrderId);
  return { ended: status };
}

/// Cancels a PENDING_PAYMENT registration once nothing is keeping its seat —
/// no pending attempt left and nothing paid — and hands the seat on.
async function releaseIfUnheld(registrationId) {
  const live = await prisma.payment.count({ where: { registrationId, status: { in: ['PENDING', 'PAID', 'PARTIALLY_REFUNDED'] } } });
  if (live) return;
  const released = await prisma.registration.updateMany({ where: { id: registrationId, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
  if (!released.count) return;
  await releaseDiscount(registrationId);
  const reg = await prisma.registration.findUnique({ where: { id: registrationId } });
  await audit(null, 'registration.hold_expired', registrationId, { code: reg.code });
  await notifyWaitlistPromotion(await promoteFromWaitlist(reg.eventId));
}

/// Gives a discount code's use back when the registration that claimed it
/// never got paid for. Clearing discountCodeId in the same compare-and-swap
/// makes sure a use is only ever returned once.
export async function releaseDiscount(registrationId) {
  const reg = await prisma.registration.findUnique({ where: { id: registrationId }, select: { discountCodeId: true } });
  if (!reg?.discountCodeId) return;
  await prisma.$transaction(async (tx) => {
    const cleared = await tx.registration.updateMany({
      where: { id: registrationId, discountCodeId: reg.discountCodeId },
      data: { discountCodeId: null, discountCents: 0 },
    });
    if (cleared.count) {
      await tx.discountCode.updateMany({ where: { id: reg.discountCodeId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
    }
  });
}

/// Puts a lapsed pre-order's held stock back.
async function releaseOrderIfUnheld(orderId) {
  const live = await prisma.payment.count({ where: { merchOrderId: orderId, status: { in: ['PENDING', 'PAID', 'PARTIALLY_REFUNDED'] } } });
  if (live) return;
  await prisma.$transaction(async (tx) => {
    const released = await tx.merchOrder.updateMany({ where: { id: orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    if (!released.count) return;
    await restock(tx, orderId);
  });
  await audit(null, 'merch_order.hold_expired', orderId, {});
}

async function restock(tx, orderId) {
  const items = await tx.merchOrderItem.findMany({ where: { orderId } });
  for (const i of items) {
    await tx.merchItem.updateMany({ where: { id: i.itemId, soldCount: { gte: i.quantity } }, data: { soldCount: { decrement: i.quantity } } });
  }
}

/// After one attempt succeeds, close any other checkout the same buyer still
/// has open (e.g. a second tab), so they can't pay twice.
async function expireOtherSessions(target, keepPaymentId) {
  const stripe = getStripe();
  const others = await prisma.payment.findMany({ where: { ...target, status: 'PENDING', ...(keepPaymentId ? { id: { not: keepPaymentId } } : {}) } });
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
  await expireOtherSessions({ registrationId }, null);
}

/* ------------------------------------------------------------- refunds ---- */

/// Mirrors a refund issued in Stripe (dashboard, or our own refund button —
/// either way the charge is re-read from Stripe).
export async function applyRefund(charge) {
  const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return null;
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intentId } });
  if (!payment) return null;
  return applyRefundTotal(payment, charge.amount_refunded, charge.amount);
}

/// Records `refundedCents` as the payment's total refunded so far. A full
/// refund also gives up what it paid for: the ticket (unless already checked
/// in) or the pre-order (stock goes back unless it was already picked up).
async function applyRefundTotal(payment, refundedCents, totalCents) {
  // Refunds only ever add up: a late-arriving event for an earlier, smaller
  // refund must not wind the recorded total back down.
  const refunded = Math.max(refundedCents, payment.amountRefundedCents);
  const full = refunded >= totalCents;
  // Compare-and-swap on the previous total, so the webhook and our own
  // refund button racing on the same refund only notify the buyer once.
  const moved = await prisma.payment.updateMany({
    where: { id: payment.id, amountRefundedCents: payment.amountRefundedCents },
    data: { amountRefundedCents: refunded, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
  });
  const newlyRefunded = moved.count ? refunded - payment.amountRefundedCents : 0;
  if (!newlyRefunded) return { full, duplicate: true };
  await audit(null, 'payment.refunded', payment.id, { amountRefundedCents: refunded, full });
  // After the cancellation below, so a full-refund notice can say the ticket is cancelled.
  const notify = () => notifyRefund(payment, newlyRefunded, full).catch((e) => console.error('refund notice failed', payment.id, e.message));
  if (!full) { await notify(); return { full }; }

  if (payment.registrationId) {
    const reg = await prisma.registration.findUnique({ where: { id: payment.registrationId } });
    if (reg && reg.status !== 'CANCELLED' && !reg.checkedInAt) {
      await prisma.registration.update({ where: { id: reg.id }, data: { status: 'CANCELLED' } });
      await notifyWaitlistPromotion(await promoteFromWaitlist(reg.eventId));
    }
  } else {
    await prisma.$transaction(async (tx) => {
      const order = await tx.merchOrder.findUnique({ where: { id: payment.merchOrderId } });
      const flipped = await tx.merchOrder.updateMany({ where: { id: order.id, status: 'PAID' }, data: { status: 'REFUNDED' } });
      if (flipped.count && !order.pickedUpAt) await restock(tx, order.id);
    });
  }
  await notify();
  return { full };
}

/// Staff-initiated refund. Stripe payments are refunded through the Stripe
/// API; in-person ones (cash, card at the door) are just recorded, since the
/// money is handed back by hand. `amountCents` omitted = whatever is left.
export async function refundPayment({ paymentId, amountCents, actorId }) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new PaymentError('Payment not found.');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw new PaymentError('Only completed payments can be refunded.');
  const remaining = payment.amountCents - payment.amountRefundedCents;
  const amount = amountCents ?? remaining;
  if (!Number.isInteger(amount) || amount <= 0) throw new PaymentError('Enter an amount to refund.');
  if (amount > remaining) throw new PaymentError(`Only ${(remaining / 100).toFixed(2)} is left to refund on this payment.`);

  if (payment.method === 'STRIPE') {
    const stripe = getStripe();
    if (!stripe) throw new PaymentError('Stripe is not configured on this instance, so this refund has to be done in the Stripe dashboard.');
    if (!payment.stripePaymentIntentId) throw new PaymentError('This payment has no Stripe reference to refund against.');
    let refund;
    try {
      refund = await stripe.refunds.create(
        { payment_intent: payment.stripePaymentIntentId, amount, metadata: { pawpassPaymentId: payment.id, refundedBy: actorId || '' } },
        // Same key for the same refund on the same starting balance, so a
        // double click (or a retry after a timeout) can't refund twice.
        { idempotencyKey: `pawpass-refund-${payment.id}-${payment.amountRefundedCents}-${amount}` },
      );
    } catch (e) {
      throw new PaymentError(`Stripe refused the refund: ${e.message}`);
    }
    await audit(actorId, 'payment.refund_requested', payment.id, { amountCents: amount, refundId: refund.id, status: refund.status });
    const chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id;
    if (chargeId) await applyRefund(await stripe.charges.retrieve(chargeId));
  } else {
    await audit(actorId, 'payment.refund_recorded', payment.id, { amountCents: amount, method: payment.method });
    await applyRefundTotal(payment, payment.amountRefundedCents + amount, payment.amountCents);
  }
  return prisma.payment.findUnique({ where: { id: payment.id } });
}

/// Tells the buyer about a refund on Telegram and/or by email, whichever they have.
async function notifyRefund(payment, amountCents, full) {
  const money = (c) => `${(c / 100).toFixed(2)} ${payment.currency.toUpperCase()}`;
  const back = payment.method === 'STRIPE' ? ' It goes back to the card you paid with, usually within 5–10 business days.' : '';
  let user, email, subject, text;
  if (payment.registrationId) {
    const reg = await prisma.registration.findUnique({ where: { id: payment.registrationId }, include: { user: true, event: true } });
    user = reg.user;
    email = reg.email || reg.user.email;
    subject = `Refund for ${reg.event.title}`;
    text = `You've been refunded ${money(amountCents)} for your ${reg.tierName || ''} ticket to ${reg.event.title} (code ${reg.code}).${back}` +
      (full && reg.status === 'CANCELLED' ? '\n\nYour registration has been cancelled.' : '');
  } else {
    const order = await prisma.merchOrder.findUnique({ where: { id: payment.merchOrderId }, include: { user: true, event: true } });
    user = order.user;
    email = order.user.email;
    subject = `Refund for your ${order.event.title} pre-order`;
    text = `You've been refunded ${money(amountCents)} for your merch pre-order for ${order.event.title}.${back}`;
  }
  await notifyPerson({ user, email, subject, text });
}

/// Telegram and email are both best-effort — a blocked bot or missing SMTP
/// config shouldn't fail the refund or decision that triggered the notice.
async function notifyPerson({ user, email, subject, text }) {
  if (user?.telegramId) await notifyUser(user.telegramId, text);
  if (email && env.smtp.enabled) await sendNoticeEmail(email, subject, text).catch((e) => console.error('notice email failed', e.message));
}

/* --------------------------------------------------------- cancelling ---- */

const refundable = (payments) =>
  payments.filter((p) => ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status) && p.amountCents > p.amountRefundedCents);

/// An attendee cancelling their own ticket, following the event's policy:
///   - nothing paid (free, unpaid, or awaiting payment) -> cancelled now
///   - AUTO_REFUND and it was paid through Stripe     -> refunded + cancelled now
///   - otherwise (REQUEST, or money taken in person)  -> a request for an owner
/// Returns { outcome: 'cancelled' | 'refunded' | 'requested' | 'already_requested', promoted }.
export async function selfCancel(registrationId, note) {
  const reg = await prisma.registration.findUnique({ where: { id: registrationId }, include: { event: true, payments: true } });
  if (!reg || reg.status === 'CANCELLED') throw new PaymentError('This registration is already cancelled.');
  const money = refundable(reg.payments);

  if (reg.status === 'PENDING_PAYMENT' || !money.length) {
    return { outcome: 'cancelled', promoted: await cancelRegistration(reg) };
  }
  if (reg.checkedInAt) throw new PaymentError("You've already checked in, so this can't be cancelled here. Talk to the organizers.");

  if (reg.event.cancelPolicy === 'AUTO_REFUND' && money.every((p) => p.method === 'STRIPE')) {
    for (const p of money) await refundPayment({ paymentId: p.id, actorId: null });
    const after = await prisma.registration.findUnique({ where: { id: reg.id } });
    const promoted = after.status === 'CANCELLED' ? null : await cancelRegistration(after);
    await audit(null, 'registration.self_cancel_refund', reg.id, { code: reg.code });
    return { outcome: 'refunded', promoted };
  }

  if (reg.cancelRequestedAt) return { outcome: 'already_requested' };
  await prisma.registration.update({
    where: { id: reg.id },
    data: { cancelRequestedAt: new Date(), cancelRequestNote: note?.trim()?.slice(0, 500) || null },
  });
  await audit(null, 'registration.cancel_requested', reg.id, { code: reg.code });
  return { outcome: 'requested' };
}

/// An owner deciding on a cancellation request. Approving refunds every
/// payment still holding money (Stripe back to the card, in-person recorded
/// as handed back) and cancels the ticket; declining just clears the request.
export async function decideCancelRequest({ registrationId, approve, actorId }) {
  const reg = await prisma.registration.findUnique({ where: { id: registrationId }, include: { event: true, user: true, payments: true } });
  if (!reg?.cancelRequestedAt) throw new PaymentError('There is no cancellation request on this registration.');
  await prisma.registration.update({ where: { id: reg.id }, data: { cancelRequestedAt: null, cancelRequestNote: null } });

  if (!approve) {
    await audit(actorId, 'registration.cancel_declined', reg.id, { code: reg.code });
    await notifyPerson({
      user: reg.user, email: reg.email || reg.user.email,
      subject: `Your cancellation request for ${reg.event.title}`,
      text: `The organizers declined your request to cancel your ticket for ${reg.event.title} (code ${reg.code}). Your ticket is still valid.`,
    }).catch((e) => console.error('decline notice failed', reg.id, e.message));
    return { approved: false, promoted: null };
  }

  // Refund notices go out from applyRefundTotal as each payment is refunded.
  for (const p of refundable(reg.payments)) await refundPayment({ paymentId: p.id, actorId });
  const after = await prisma.registration.findUnique({ where: { id: reg.id } });
  const promoted = after.status === 'CANCELLED' ? null : await cancelRegistration(after);
  await audit(actorId, 'registration.cancel_approved', reg.id, { code: reg.code });
  return { approved: true, promoted };
}

/* ---------------------------------------------------------------- fees ---- */

/// Stripe's fee and the net amount for a paid Stripe payment, from the
/// charge's balance transaction. Not always ready the instant a session
/// completes, so the sweeper retries any that are still missing.
async function captureFees(paymentId) {
  const stripe = getStripe();
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!stripe || !payment?.stripePaymentIntentId || payment.feeCents != null) return;
  const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId, { expand: ['latest_charge.balance_transaction'] });
  const bt = intent?.latest_charge?.balance_transaction;
  if (!bt || typeof bt !== 'object') return;
  await prisma.payment.update({ where: { id: payment.id }, data: { feeCents: bt.fee, netCents: bt.net } });
}

/* ------------------------------------------------------------- webhook ---- */

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

/// Two per-IP limits for the webhook route, mounted ahead of it in app.js:
///   - rejected: only requests answered 400 (bad signature, wrong mode) count.
///     Real Stripe deliveries are never 400s, so a busy on-sale can't trip it,
///     while anyone probing with forged requests is cut off quickly.
///   - flood: a high ceiling on everything, so junk can't load the server even
///     though each forged request is cheap to reject.
/// A 500 from our side doesn't count against the strict limit, so Stripe's own
/// retries after an outage on our end always get through.
export function createWebhookLimiters({
  windowMs = 15 * 60 * 1000,
  rejectedLimit = 30,
  floodLimit = 3000,
} = {}) {
  const common = { windowMs, standardHeaders: true, legacyHeaders: false };
  return [
    rateLimit({
      ...common,
      limit: floodLimit,
      message: { error: 'Too many requests.' },
    }),
    rateLimit({
      ...common,
      limit: rejectedLimit,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 400,
      message: { error: 'Too many rejected webhook requests from this address.' },
      handler: (req, res, _next, options) => {
        console.warn(`Rate-limited Stripe webhook requests from ${req.ip} after repeated rejections.`);
        res.status(options.statusCode).json(options.message);
      },
    }),
  ];
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
/// whose hold has run out, by asking Stripe directly — and fills in fees that
/// weren't available yet when a payment completed.
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
  if (!stripe) return;
  const feeless = await prisma.payment.findMany({
    where: { method: 'STRIPE', status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, feeCents: null, stripePaymentIntentId: { not: null }, paidAt: { lt: new Date(Date.now() - 60_000) } },
    take: 20,
  });
  for (const p of feeless) await captureFees(p.id).catch((e) => console.error('stripe fee lookup failed', p.id, e.message));
}

export function startPaymentSweeper() {
  const timer = setInterval(() => sweepExpiredHolds().catch((e) => console.error('payment sweep failed', e.message)), 60_000);
  timer.unref();
  return timer;
}

/// The Stripe success_url lands here (via the web app) with the session ID.
/// Settles it straight from Stripe so the buyer sees the result immediately
/// instead of waiting on the webhook — the ID alone proves nothing, since the
/// state is fetched from Stripe, not taken from the request.
export async function syncSessionForUser(sessionId, userId) {
  const stripe = getStripe();
  if (!stripe || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) return null;
  const payment = await prisma.payment.findUnique({
    where: { stripeSessionId: sessionId },
    include: { registration: true, merchOrder: true },
  });
  const owner = payment?.registration?.userId ?? payment?.merchOrder?.userId;
  if (!payment || owner !== userId) return null;
  await applyCheckoutSession(await stripe.checkout.sessions.retrieve(sessionId));
  if (payment.registrationId) {
    const reg = await prisma.registration.findUnique({ where: { id: payment.registrationId } });
    return { kind: 'registration', code: reg.code, status: reg.status };
  }
  const order = await prisma.merchOrder.findUnique({ where: { id: payment.merchOrderId } });
  return { kind: 'merch', orderId: order.id, status: order.status };
}

async function notifyPaid(reg) {
  if (reg.user?.telegramId) {
    await notifyUser(reg.user.telegramId,
      `Payment received. You're registered for ${reg.event.title}.\n\n` +
      `Badge code: ${reg.code}\n` +
      `Ticket: ${env.webUrl}/tickets`);
  }
  const settings = await getSettings();
  await sendRegistrationConfirmation(reg, reg.event, settings)
    .catch((e) => console.error('payment confirmation email failed', reg.code, e.message));
}

async function notifyOrderPaid(order) {
  if (!order.user?.telegramId) return;
  const lines = order.items.map((i) => `· ${i.quantity} × ${i.name}`).join('\n');
  await notifyUser(order.user.telegramId,
    `Pre-order paid for ${order.event.title}:\n\n${lines}\n\nPick it up at the merch table under your name.`);
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

export const shapePayment = (p) => ({
  id: p.id, method: p.method, status: p.status, amountCents: p.amountCents,
  amountRefundedCents: p.amountRefundedCents, donationCents: p.donationCents,
  feeCents: p.feeCents, currency: p.currency, note: p.note,
  paidAt: p.paidAt, createdAt: p.createdAt,
});

/// Payment rollup used by shapeReg: what's actually been received, net of
/// refunds, and what's still owed on the ticket itself (donations don't
/// count toward the ticket, discounts come off it).
export function paymentSummary(r) {
  if (!r.payments) return {};
  const settled = r.payments.filter((p) => p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED');
  const paidCents = settled.reduce((sum, p) => sum + p.amountCents - p.amountRefundedCents, 0);
  const donatedCents = settled.reduce((sum, p) => sum + (p.donationCents || 0), 0);
  const priceCents = r.ticketTier?.priceCents ?? null;
  const owedCents = priceCents ? Math.max(priceCents - (r.discountCents || 0), 0) : 0;
  // When the held seat lapses, for the countdown on a PENDING_PAYMENT ticket.
  const holds = r.status === 'PENDING_PAYMENT'
    ? r.payments.filter((p) => p.method === 'STRIPE' && p.status === 'PENDING' && p.expiresAt).map((p) => p.expiresAt.getTime())
    : [];
  return {
    holdExpiresAt: holds.length ? new Date(Math.max(...holds)) : null,
    paidCents,
    paymentMethod: settled.at(-1)?.method ?? null,
    discountCents: r.discountCents || 0,
    donationCents: r.donationCents || 0,
    // What checkout will charge (ticket after discount + donation).
    chargeCents: owedCents + (r.donationCents || 0),
    // A cancelled ticket owes nothing, whether or not it was refunded.
    balanceDueCents: r.status === 'CANCELLED' ? 0 : Math.max(owedCents - Math.max(paidCents - donatedCents, 0), 0),
    payments: r.payments.map(shapePayment),
  };
}
