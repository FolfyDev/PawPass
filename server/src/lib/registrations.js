import { prisma } from './db.js';
import { ticketCode, ticketSecret } from './codes.js';
import { findMatchingBan } from './bans.js';
import { audit } from './auth.js';
import { blindIndex } from './crypto.js';
import { formatInTimeZone } from './tz.js';
import { env } from './env.js';
import { stripeEnabled } from './stripe.js';
import { STAFF_PAYMENT_METHODS, abandonPendingPayments, releaseDiscount } from './payments.js';
import { tierSaleState, checkDiscount, checkDonation, registrationCharge, normalizeCode, PricingError, STRIPE_MIN_CHARGE_CENTS } from './pricing.js';

export class RegistrationError extends Error {}

/// Statuses that occupy a seat against event (and tier) capacity. A
/// PENDING_PAYMENT registration holds its seat while the attendee is on
/// Stripe Checkout, so two people can't both pay for the last one.
export const HOLDS_SEAT = ['CONFIRMED', 'PENDING_PAYMENT'];

/// Active tiers in display order — the same order everywhere they're listed.
export function activeTiers(eventId, db = prisma) {
  return db.ticketTier.findMany({
    where: { eventId, active: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/// Seats taken per tier, for "N left" / sold-out display.
export async function heldByTier(eventId) {
  const rows = await prisma.registration.groupBy({
    by: ['ticketTierId'],
    where: { eventId, status: { in: HOLDS_SEAT } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.ticketTierId, r._count._all]));
}

export function validateAnswers(event, answers = {}) {
  const fields = Array.isArray(event.customFields) ? event.customFields : [];
  const clean = {};
  for (const f of fields) {
    const value = answers[f.key];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (f.required && empty) throw new RegistrationError(`${f.label} is required.`);
    if (!empty) clean[f.key] = value;
  }
  return clean;
}

/// `heldCount` is registrations in HOLDS_SEAT, not just CONFIRMED.
export function registrationWindowState(event, heldCount) {
  const now = new Date();
  if (!event.published) return { open: false, reason: 'Registration is not open yet.' };
  if (event.opensAt && now < event.opensAt)
    return { open: false, reason: `Registration opens ${formatInTimeZone(event.opensAt, event.timezone)}.` };
  if (event.closesAt && now > event.closesAt)
    return { open: false, reason: 'Registration has closed.' };
  if (event.capacity && heldCount >= event.capacity) {
    return event.waitlistEnabled
      ? { open: true, waitlist: true, reason: 'This event is full. You will join the waitlist.' }
      : { open: false, reason: 'This event is full.' };
  }
  return { open: true, waitlist: false };
}

/// How a paid tier gets paid depends on where the registration comes from:
///   - staff (source 'admin') with `inPersonPayment` -> recorded as PAID now
///   - attendee, Stripe configured                   -> PENDING_PAYMENT + a
///     pending Payment; the caller follows up with startCheckout()
///   - anything else                                 -> CONFIRMED, balance due
///     (pay at the door — what v1's PayPal tier effectively was)
/// `inPersonPayment` is { method, amountCents, note }.
///
/// Attendee registrations can also carry a `discountCode` (reduces the
/// ticket price, online or at the door) and `donationCents` (the optional
/// add-on — only charged online, so ignored without Stripe).
export async function createRegistration({ event, user, legalName, fursonaName, email, answers, source, tosVersion, ticketTierId, voucherCode, discountCode, donationCents, inPersonPayment, processedById }) {
  const ban = await findMatchingBan({ legalName, email, telegramId: user.telegramId, telegramUsername: user.telegramUsername });
  if (ban) {
    await audit(null, 'ban.blocked_registration', ban.id, {
      banReason: ban.reason || undefined,
      eventId: event.id,
      eventTitle: event.title,
      legalName: legalName?.trim() || undefined,
      fursonaName: fursonaName?.trim() || undefined,
      email: email?.trim() || undefined,
      telegramId: user.telegramId || undefined,
      telegramUsername: user.telegramUsername || undefined,
      source,
    });
    throw new RegistrationError('Registration is not available for this account. Contact the organizers if you think this is a mistake.');
  }

  const existing = await prisma.registration.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: user.id } },
  });
  if (existing?.status === 'PENDING_PAYMENT')
    throw new RegistrationError('You already have a registration for this event waiting on payment. Finish paying from your tickets, or cancel it there to start over.');
  if (existing && existing.status !== 'CANCELLED')
    throw new RegistrationError('You are already registered for this event.');

   if (email) {
    const emailDup = await prisma.registration.findFirst({
      where: { eventId: event.id, status: { not: 'CANCELLED' }, emailIndex: blindIndex(email), userId: { not: user.id } },
    });
    if (emailDup)
      throw new RegistrationError(`${emailDup.legalName} already has a registration for this event using that email (code ${emailDup.code}). If this is you, ask an organizer to combine your accounts.`);
  }

    let voucher = null;
  if (voucherCode) {
    voucher = await prisma.voucherCode.findFirst({
      where: { eventId: event.id, code: voucherCode.trim().toUpperCase() },
    });
    if (!voucher) throw new RegistrationError('That voucher code is not valid for this event.');
    if (voucher.usedCount >= voucher.maxUses) throw new RegistrationError('That voucher code has already been used.');
  }

  const cleanAnswers = validateAnswers(event, answers);

  // Vouchers bypass tiers entirely, same as they bypass capacity.
  let tier = null;
  if (!voucher) {
    const tiers = await activeTiers(event.id);
    if (!tiers.length) throw new RegistrationError('No tickets are on sale for this event right now.');
    // Staff at the kiosk can still sell a tier outside its sale window.
    const buyable = source === 'admin' ? tiers : tiers.filter((t) => tierSaleState(t).buyable);
    tier = ticketTierId ? tiers.find((t) => t.id === ticketTierId) : buyable.length === 1 ? buyable[0] : null;
    if (!tier) throw new RegistrationError(ticketTierId ? 'That ticket type is not available.' : 'Choose a ticket type.');
    if (!buyable.includes(tier)) {
      const sale = tierSaleState(tier);
      throw new RegistrationError(sale.reason === 'not_yet'
        ? `${tier.name} tickets go on sale ${formatInTimeZone(sale.at, event.timezone)}.`
        : `${tier.name} tickets are no longer on sale.`);
    }
  }

  // Discount codes and the donation add-on are attendee-side only; staff
  // just enter what they actually took at the kiosk.
  let discount = null;
  let discountCents = 0;
  let donation = 0;
  if (tier && source !== 'admin') {
    try {
      if (normalizeCode(discountCode)) {
        discount = await prisma.discountCode.findUnique({ where: { eventId_code: { eventId: event.id, code: normalizeCode(discountCode) } } });
        discountCents = checkDiscount(discount, tier);
      }
      if (stripeEnabled()) donation = checkDonation(event, donationCents);
    } catch (e) {
      if (e instanceof PricingError) throw new RegistrationError(e.message);
      throw e;
    }
  }
  const paid = tier?.priceCents > 0;
  const staffPaid = paid && source === 'admin' && inPersonPayment?.method;
  if (staffPaid) {
    if (!STAFF_PAYMENT_METHODS.includes(inPersonPayment.method)) throw new RegistrationError('Choose how the payment was received.');
    if (!Number.isInteger(inPersonPayment.amountCents) || inPersonPayment.amountCents < 0) throw new RegistrationError('Enter the amount received.');
  }
  let charge = registrationCharge({ tierPriceCents: tier?.priceCents, discountCents, donationCents: donation });
  let online = charge.totalCents > 0 && source !== 'admin' && stripeEnabled();

  return prisma.$transaction(async (tx) => {
    let status;

    if (voucher) {
      const claimed = await tx.voucherCode.updateMany({
        where: { id: voucher.id, usedCount: { lt: voucher.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (claimed.count === 0) throw new RegistrationError('That voucher code has already been used.');
      status = 'CONFIRMED';
    } else {
      if (event.capacity || tier.capacity != null) {
        await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${event.id} FOR UPDATE`;
      }
      const held = await tx.registration.count({
        where: { eventId: event.id, status: { in: HOLDS_SEAT } },
      });
      const state = registrationWindowState(event, held);
      if (!state.open) throw new RegistrationError(state.reason);
      if (tier.capacity != null) {
        const tierHeld = await tx.registration.count({
          where: { ticketTierId: tier.id, status: { in: HOLDS_SEAT } },
        });
        if (tierHeld >= tier.capacity) throw new RegistrationError(`${tier.name} tickets are sold out.`);
      }
      // A waitlisted spot has nothing to charge for yet, and promotion off
      // the waitlist is automatic — so an online-paid ticket never waitlists.
      // A free ticket with only a donation on top just waitlists without it.
      if (state.waitlist && donation && charge.ticketCents === 0) {
        donation = 0;
        charge = registrationCharge({ tierPriceCents: tier.priceCents, discountCents, donationCents: 0 });
        online = false;
      }
      if (state.waitlist && online) throw new RegistrationError('This event is full.');
      if (online && charge.totalCents < STRIPE_MIN_CHARGE_CENTS)
        throw new RegistrationError(`Online payments must be at least $${(STRIPE_MIN_CHARGE_CENTS / 100).toFixed(2)}.`);
      status = state.waitlist ? 'WAITLIST' : online ? 'PENDING_PAYMENT' : 'CONFIRMED';

      if (discount) {
        // Claimed here, compare-and-swap like vouchers; lib/payments.js gives
        // it back if the checkout hold lapses unpaid.
        const claimed = await tx.discountCode.updateMany({
          where: { id: discount.id, active: true, ...(discount.maxUses != null ? { usedCount: { lt: discount.maxUses } } : {}) },
          data: { usedCount: { increment: 1 } },
        });
        if (claimed.count === 0) throw new RegistrationError('That discount code has been used up.');
      }
    }

    const data = {
      legalName: legalName.trim(),
      fursonaName: (fursonaName || '').trim(),
      email: email?.trim() || null,
      answers: cleanAnswers,
      status,
      ticketTierId: tier?.id ?? null,
      tierName: tier?.name ?? null,
      rsvp: 'YES',
      source,
      tosAcceptedAt: new Date(),
      tosVersion: tosVersion || null,
      voucherCodeId: voucher?.id || null,
      badgeTier: voucher?.badgeTier || null,
      discountCodeId: discount?.id ?? null,
      discountCents,
      donationCents: donation,
    };

    // Badge numbers go to spots that are actually held — a PENDING_PAYMENT
    // registration gets one when the payment lands (lib/payments.js markPaid).
    if (status !== 'PENDING_PAYMENT' && existing?.badgeNumber == null) {
      const updatedEvent = await tx.event.update({
        where: { id: event.id },
        data: { nextBadgeNumber: { increment: 1 } },
      });
      data.badgeNumber = updatedEvent.nextBadgeNumber - 1;
    }

    const reg = existing
      ? await tx.registration.update({ where: { id: existing.id }, data })
      : await tx.registration.create({
          data: { ...data, code: ticketCode(), secret: ticketSecret(), eventId: event.id, userId: user.id },
        });

    if (staffPaid) {
      await tx.payment.create({
        data: {
          registrationId: reg.id, method: inPersonPayment.method, status: 'PAID',
          amountCents: inPersonPayment.amountCents, currency: tier.currency,
          note: inPersonPayment.note?.trim() || null, paidAt: new Date(), processedById: processedById || null,
        },
      });
    } else if (status === 'PENDING_PAYMENT') {
      // The hold itself — startCheckout attaches a Stripe session to this row.
      // A little over the checkout window, so the session (created a moment
      // later with the full window) is what actually decides when it lapses.
      await tx.payment.create({
        data: {
          registrationId: reg.id, method: 'STRIPE', status: 'PENDING',
          amountCents: charge.totalCents, donationCents: charge.donationCents, currency: tier.currency,
          expiresAt: new Date(Date.now() + (env.stripe.checkoutMinutes + 2) * 60_000),
        },
      });
    }

    return tx.registration.findUnique({
      where: { id: reg.id },
      include: { ticketTier: true, payments: { orderBy: { createdAt: 'asc' } } },
    });
  }, { maxWait: 10000, timeout: 10000 });
}

/// Creates the User a registration needs when there's no signed-in account to
/// attach it to — a staff walk-up at the door, or a guest checking out on the
/// web with no Telegram. There's no telegramId to dedupe on in either case,
/// so this checks for a same-event registration under the same name/email
/// instead, to catch someone accidentally registering twice.
export async function findOrCreateHeadlessUser({ eventId, legalName, fursonaName, email }) {
  const dup = await prisma.registration.findFirst({
    where: {
      eventId,
      status: { not: 'CANCELLED' },
      OR: [
        { legalNameIndex: blindIndex(legalName) },
        ...(email ? [{ emailIndex: blindIndex(email) }] : []),
      ],
    },
  });
  if (dup) throw new RegistrationError(`${dup.legalName} already has a registration for this event (code ${dup.code}).`);
  return prisma.user.create({ data: { displayName: legalName, legalName, fursonaName } });
}

/// Shared by the web self-service cancel and the bot's /regcancel — flips the
/// registration to cancelled and immediately tries to backfill the freed
/// spot from the waitlist, same as the admin status-edit path does. Callers
/// are responsible for notifying whoever gets promoted (Telegram vs HTTP
/// response formats differ, so that part isn't shared).
export async function cancelRegistration(reg) {
  await prisma.registration.update({ where: { id: reg.id }, data: { status: 'CANCELLED' } });
  if (reg.status === 'PENDING_PAYMENT') {
    await abandonPendingPayments(reg.id);
    await releaseDiscount(reg.id);
  }
  return promoteFromWaitlist(reg.eventId);
}

/// Promotes the longest-waiting person when a confirmed spot frees up.
export async function promoteFromWaitlist(eventId) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event?.capacity) return null;
  const held = await prisma.registration.count({ where: { eventId, status: { in: HOLDS_SEAT } } });
  if (held >= event.capacity) return null;
  const next = await prisma.registration.findFirst({
    where: { eventId, status: 'WAITLIST' },
    orderBy: { createdAt: 'asc' },
  });
  if (!next) return null;
  return prisma.registration.update({
    where: { id: next.id },
    data: { status: 'CONFIRMED' },
    include: { user: true, event: true },
  });
}
