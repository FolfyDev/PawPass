import request from 'supertest';
import Stripe from 'stripe';
import { app } from '../../src/app.js';

// Shared by the Stripe-facing tests (payments, vendor table fees).

export const WEBHOOK_SECRET = 'whsec_pawpass_test';
const real = new Stripe('sk_test_pawpass_dummy');

/// Just enough of the Stripe API for PawPass, in memory. Webhook signing and
/// verification use the real SDK (it's local crypto, no network).
export function fakeStripe() {
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

export function deliver(event) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').set('stripe-signature', header).send(payload);
}

let evtSeq = 0;
export const stripeEvent = (type, object) => ({ id: `evt_test_${++evtSeq}_${Date.now()}`, object: 'event', type, data: { object } });

