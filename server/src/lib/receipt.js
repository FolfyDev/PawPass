import { env } from './env.js';
import { escapeHtml as esc } from './html.js';

/// A printable receipt page (the browser's Print → Save as PDF makes the file).
/// Built from what was actually charged and refunded, not from current
/// prices, so it stays right after a tier or item is repriced.

const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format((cents || 0) / 100);
const day = (d, tz) => new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz || undefined });
const METHOD = { STRIPE: 'Card (online)', CASH: 'Cash', CARD: 'Card (in person)', PAYPAL: 'PayPal', OTHER: 'Other' };

function page({ title, merchant, contact, heading, meta, lines, payments, currency, tz, note }) {
  const settled = payments.filter((p) => ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));
  const paid = settled.reduce((s, p) => s + p.amountCents, 0);
  const refunded = settled.reduce((s, p) => s + p.amountRefundedCents, 0);
  const row = (a, b, cls = '') => `<tr class="${cls}"><td>${a}</td><td class="n">${b}</td></tr>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;color:#141b24;background:#f7f6f3;margin:0;padding:32px 16px}
  main{max-width:620px;margin:0 auto;background:#fff;border:1px solid #dfe3e8;border-radius:12px;padding:28px}
  h1{font-size:22px;margin:0 0 4px} .muted{color:#6b7480} .small{font-size:13px}
  table{width:100%;border-collapse:collapse;margin:16px 0} td,th{padding:7px 0;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:top}
  th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7480;font-weight:600}
  .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .total td{font-weight:700;border-bottom:0}
  .minus{color:#0f7a52} @media print{body{background:#fff;padding:0} main{border:0}}
</style>
<main>
  <p class="muted small">${esc(merchant)}${contact ? ` · ${esc(contact)}` : ''}</p>
  <h1>${esc(heading)}</h1>
  <p class="muted small">${meta.map(esc).join(' · ')}</p>
  ${lines.length ? `<table>${lines.map((l) => row(esc(l.label), (l.minus ? '−' : '') + money(l.cents, currency), l.minus ? 'minus' : '')).join('')}
    ${row('Total', money(lines.reduce((s, l) => s + (l.minus ? -l.cents : l.cents), 0), currency), 'total')}</table>` : ''}
  ${settled.length ? `<table><tr><th>Payment</th><th>Date</th><th class="n">Amount</th></tr>
    ${settled.map((p) => `<tr><td>${esc(METHOD[p.method] || p.method)}${p.stripePaymentIntentId ? `<div class="muted small">Ref ${esc(p.stripePaymentIntentId)}</div>` : ''}</td>
      <td>${esc(day(p.paidAt || p.createdAt, tz))}</td><td class="n">${money(p.amountCents, p.currency)}${p.amountRefundedCents ? `<div class="minus small">−${money(p.amountRefundedCents, p.currency)} refunded</div>` : ''}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">Paid</td><td class="n">${money(paid - refunded, currency)}</td></tr></table>` : (lines.length ? '<p class="muted">No payment recorded.</p>' : '')}
  ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
  <p class="muted small">Use your browser's Print to save this as a PDF.</p>
</main></html>`;
}

/// Receipt for a ticket. A friend's ticket shows who paid; a buyer's shows
/// the friends' tickets it included.
export function ticketReceipt(reg, settings) {
  const currency = reg.ticketTier?.currency || reg.payments[0]?.currency || 'usd';
  const price = reg.ticketTier?.priceCents || 0;
  const friends = (reg.boughtFor || []).filter((f) => f.status !== 'PENDING_PAYMENT');
  const lines = reg.paidBy ? [] : [
    { label: `${reg.tierName || 'Ticket'} (${reg.fursonaName || reg.legalName})`, cents: price },
    ...(reg.discountCents ? [{ label: 'Discount', cents: reg.discountCents, minus: true }] : []),
    ...friends.map((f) => ({ label: `${reg.tierName || 'Ticket'} (${f.fursonaName || f.legalName})`, cents: price })),
    ...(reg.donationCents ? [{ label: 'Donation', cents: reg.donationCents }] : []),
  ];
  return page({
    title: `Receipt ${reg.code}`,
    merchant: env.legal.entityName || settings.orgName,
    contact: env.legal.contactEmail || settings.supportEmail,
    heading: `Receipt: ${reg.event.title}`,
    meta: [`Badge code ${reg.code}`, reg.fursonaName || reg.legalName, `Registered ${day(reg.createdAt, reg.event.timezone)}`],
    lines,
    payments: reg.paidBy ? [] : reg.payments,
    currency,
    tz: reg.event.timezone,
    note: reg.paidBy ? `This ticket was paid for by ${reg.paidBy.fursonaName || reg.paidBy.legalName} (${reg.paidBy.code}), whose receipt shows the payment.` : '',
  });
}

export function orderReceipt(order, settings) {
  return page({
    title: 'Pre-order receipt',
    merchant: env.legal.entityName || settings.orgName,
    contact: env.legal.contactEmail || settings.supportEmail,
    heading: `Pre-order: ${order.event.title}`,
    meta: [order.user.displayName, `Ordered ${day(order.createdAt, order.event.timezone)}`, order.pickedUpAt ? 'Picked up' : 'Pick up at the merch table'],
    lines: order.items.map((i) => ({ label: `${i.quantity} × ${i.name}`, cents: i.unitPriceCents * i.quantity })),
    payments: order.payments,
    currency: order.currency,
    tz: order.event.timezone,
  });
}
