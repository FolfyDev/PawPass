import Stripe from 'stripe';
import { env } from './env.js';
import { prisma } from './db.js';

let client = env.stripe.enabled ? new Stripe(env.stripe.secretKey) : null;

/// null when STRIPE_SECRET_KEY isn't set — every caller has to handle that,
/// since Stripe is optional (paid tiers fall back to pay-at-the-door).
export const getStripe = () => client;
export const stripeEnabled = () => Boolean(client);

/// Tests swap in a client with stubbed API methods. Not for app code.
export function setStripeClient(c) { client = c; }

/// Pushes a tier to Stripe as a Product with one active Price. PawPass is the
/// source of truth, so this only ever writes to Stripe, never reads tier
/// details back from it.
///
/// Stripe Prices are immutable, so a changed amount or currency means a new
/// Price: it becomes the product's default, then the old one is archived
/// (Stripe won't archive a product's current default_price). Checkout
/// sessions already open on the old Price still complete at the old amount.
///
/// Never throws — a Stripe outage shouldn't stop an owner saving a tier.
/// Failures are recorded on the tier as stripeSyncError for the admin UI, and
/// the next save (or the Resync button) retries.
export async function syncTier(tier, event) {
  if (!client) return tier;
  if (tier.priceCents === 0 && !tier.stripeProductId) {
    return tier.stripeSyncError ? prisma.ticketTier.update({ where: { id: tier.id }, data: { stripeSyncError: null } }) : tier;
  }
  try {
    const sellable = tier.active && tier.priceCents > 0;
    const product = {
      name: `${event.title}: ${tier.name}`,
      description: tier.description || '',
      active: sellable,
      metadata: { pawpassTierId: tier.id, pawpassEventId: event.id },
    };

    let productId = tier.stripeProductId;
    if (productId) {
      await client.products.update(productId, product);
    } else {
      // Stripe rejects an empty description on create (but accepts it on
      // update, where it clears the field).
      const created = await client.products.create(
        { ...product, description: tier.description || undefined },
        // Same key on a retry after a crash between create and the DB write
        // below, so a second attempt returns the same product, not a twin.
        { idempotencyKey: `pawpass-tier-product-${tier.id}` },
      );
      productId = created.id;
    }

    let priceId = tier.stripePriceId;
    if (tier.priceCents > 0) {
      const current = priceId ? await client.prices.retrieve(priceId) : null;
      if (!current || !current.active || current.unit_amount !== tier.priceCents || current.currency !== tier.currency) {
        const price = await client.prices.create({
          product: productId,
          unit_amount: tier.priceCents,
          currency: tier.currency,
          metadata: { pawpassTierId: tier.id },
        });
        await client.products.update(productId, { default_price: price.id });
        if (current?.active) await client.prices.update(current.id, { active: false });
        priceId = price.id;
      }
    }

    return prisma.ticketTier.update({
      where: { id: tier.id },
      data: { stripeProductId: productId, stripePriceId: priceId, stripeSyncedAt: new Date(), stripeSyncError: null },
    });
  } catch (e) {
    console.error('stripe tier sync failed', tier.id, e.message);
    return prisma.ticketTier.update({ where: { id: tier.id }, data: { stripeSyncError: e.message || 'Stripe sync failed.' } });
  }
}

/// A deleted tier's Product is archived rather than deleted — Stripe refuses
/// to delete a product that has prices, and its past payments still point at it.
export async function archiveTierProduct(tier) {
  if (!client || !tier.stripeProductId) return;
  try {
    await client.products.update(tier.stripeProductId, { active: false });
  } catch (e) {
    console.error('stripe product archive failed', tier.stripeProductId, e.message);
  }
}
