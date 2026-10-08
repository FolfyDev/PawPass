import { prisma } from './db.js';
import { env } from './env.js';
import { stripeEnabled } from './stripe.js';
import { STRIPE_MIN_CHARGE_CENTS } from './pricing.js';

export class MerchOrderError extends Error {}

const MAX_PER_ITEM = 10;

/// Price of a merch item in cents (MerchItem.price is stored in dollars).
export const itemPriceCents = (item) => (item.price != null ? Math.round(item.price * 100) : null);

/// Creates a PENDING pre-order and holds its stock, the same way a
/// PENDING_PAYMENT registration holds a seat: the caller follows up with
/// startOrderCheckout(), and if the checkout lapses unpaid the stock goes
/// back (lib/payments.js releaseOrderIfUnheld). Only attendees with a
/// confirmed registration can pre-order — it's picked up at the event.
export async function createMerchOrder({ event, user, items }) {
  if (!stripeEnabled()) throw new MerchOrderError('Online pre-orders are not available.');

  const reg = await prisma.registration.findUnique({ where: { eventId_userId: { eventId: event.id, userId: user.id } } });
  if (!reg || reg.status !== 'CONFIRMED') throw new MerchOrderError('Pre-orders are for confirmed attendees. Register first.');

  const open = await prisma.merchOrder.findFirst({ where: { eventId: event.id, userId: user.id, status: 'PENDING' } });
  if (open) throw new MerchOrderError('You already have a pre-order waiting on payment. Finish it from your tickets, or wait for it to expire.');

  const wanted = new Map();
  for (const line of Array.isArray(items) ? items : []) {
    const qty = Number(line?.quantity);
    if (!line?.itemId || !Number.isInteger(qty) || qty < 0) throw new MerchOrderError('Choose a quantity for each item.');
    if (qty) wanted.set(line.itemId, (wanted.get(line.itemId) || 0) + qty);
  }
  if (!wanted.size) throw new MerchOrderError('Choose at least one item.');

  const catalog = await prisma.merchItem.findMany({ where: { id: { in: [...wanted.keys()] }, eventId: event.id } });
  const lines = [...wanted].map(([itemId, quantity]) => {
    const item = catalog.find((c) => c.id === itemId);
    if (!item || !item.preorder || itemPriceCents(item) == null || itemPriceCents(item) <= 0) throw new MerchOrderError('One of those items is not available to pre-order.');
    if (quantity > MAX_PER_ITEM) throw new MerchOrderError(`You can pre-order at most ${MAX_PER_ITEM} of ${item.name}.`);
    return { item, quantity, unitPriceCents: itemPriceCents(item) };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  if (totalCents < STRIPE_MIN_CHARGE_CENTS) throw new MerchOrderError('That order is below the minimum online payment.');

  return prisma.$transaction(async (tx) => {
    // Same compare-and-swap as a sale at the table, so online and in-person
    // sales share one stock count and can't oversell between them.
    for (const l of lines) {
      const ok = await tx.merchItem.updateMany({
        where: { id: l.item.id, soldCount: { lte: l.item.maxCount - l.quantity } },
        data: { soldCount: { increment: l.quantity } },
      });
      if (!ok.count) throw new MerchOrderError(`Not enough ${l.item.name} left.`);
    }
    const order = await tx.merchOrder.create({
      data: {
        eventId: event.id, userId: user.id, totalCents, currency: 'usd',
        items: { create: lines.map((l) => ({ itemId: l.item.id, name: l.item.name, unitPriceCents: l.unitPriceCents, quantity: l.quantity })) },
      },
    });
    await tx.payment.create({
      data: {
        merchOrderId: order.id, method: 'STRIPE', status: 'PENDING', amountCents: totalCents, currency: 'usd',
        expiresAt: new Date(Date.now() + (env.stripe.checkoutMinutes + 2) * 60_000),
      },
    });
    return tx.merchOrder.findUnique({ where: { id: order.id }, include: { items: true, payments: true } });
  });
}

export function shapeOrder(o) {
  const pending = (o.payments || []).filter((p) => p.method === 'STRIPE' && p.status === 'PENDING' && p.expiresAt);
  return {
    id: o.id, status: o.status, totalCents: o.totalCents, currency: o.currency,
    pickedUpAt: o.pickedUpAt, createdAt: o.createdAt,
    // The payment that settled it, for staff refunds.
    paymentId: (o.payments || []).find((p) => ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status))?.id ?? null,
    holdExpiresAt: o.status === 'PENDING' && pending.length ? new Date(Math.max(...pending.map((p) => p.expiresAt.getTime()))) : null,
    items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    event: o.event ? { id: o.event.id, slug: o.event.slug, title: o.event.title } : undefined,
    buyer: o.user ? { name: o.user.displayName, telegramUsername: o.user.telegramUsername } : undefined,
  };
}
