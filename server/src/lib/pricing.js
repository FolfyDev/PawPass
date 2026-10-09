/// Pricing rules shared by registration, checkout, the public event page and
/// the bot, so they can never disagree about what something costs.

/// Stripe won't create a card charge below this (USD; close enough for the
/// other common currencies).
export const STRIPE_MIN_CHARGE_CENTS = 50;
/// Upper bound on a donation add-on, so a typo can't become a $10,000 charge.
export const MAX_DONATION_CENTS = 100_000;

export class PricingError extends Error {}

/// Whether a tier can be bought right now: on sale and inside its window.
export function tierSaleState(tier, now = new Date()) {
  if (!tier.active) return { buyable: false, reason: 'inactive' };
  if (tier.salesStartAt && now < tier.salesStartAt) return { buyable: false, reason: 'not_yet', at: tier.salesStartAt };
  if (tier.salesEndAt && now >= tier.salesEndAt) return { buyable: false, reason: 'ended', at: tier.salesEndAt };
  return { buyable: true };
}

/// Cents off `priceCents` for a discount code. Never more than the price.
export function discountAmount(code, priceCents) {
  if (code.percentOff) return Math.min(priceCents, Math.round((priceCents * code.percentOff) / 100));
  return Math.min(priceCents, code.amountOffCents || 0);
}

/// Checks a discount code against a tier without claiming a use. Throws a
/// PricingError with a message fit for an attendee.
export function checkDiscount(code, tier, now = new Date()) {
  if (!code || !code.active) throw new PricingError('That discount code is not valid for this event.');
  if (code.expiresAt && now >= code.expiresAt) throw new PricingError('That discount code has expired.');
  if (code.maxUses != null && code.usedCount >= code.maxUses) throw new PricingError('That discount code has been used up.');
  if (code.tierIds?.length && !code.tierIds.includes(tier.id)) throw new PricingError(`That discount code doesn't apply to ${tier.name} tickets.`);
  if (!tier.priceCents) throw new PricingError(`${tier.name} tickets are already free.`);
  return discountAmount(code, tier.priceCents);
}

export const normalizeCode = (code) => String(code || '').trim().toUpperCase();

/// Validates a donation amount against the event's add-on settings.
/// Returns the cents to charge (0 when there's nothing to add).
export function checkDonation(event, cents) {
  if (cents == null || cents === '' || cents === 0) return 0;
  if (!event.donationAddonEnabled) return 0;
  const n = Number(cents);
  if (!Number.isInteger(n) || n < 0) throw new PricingError('Enter a donation in whole cents.');
  if (n > 0 && n < 100) throw new PricingError('Donations start at $1.00.');
  if (n > MAX_DONATION_CENTS) throw new PricingError('That donation is too large to take online. Contact the organizers.');
  return n;
}

/// What an online checkout for a registration charges, split into its parts.
/// `friends` is how many extra tickets the buyer is paying for (full price;
/// a discount code only applies to the buyer's own ticket).
export function registrationCharge({ tierPriceCents, discountCents = 0, donationCents = 0, friends = 0 }) {
  const ticketCents = Math.max((tierPriceCents || 0) - discountCents, 0);
  const friendsCents = (tierPriceCents || 0) * friends;
  return { ticketCents, friendsCents, donationCents, totalCents: ticketCents + friendsCents + donationCents };
}
