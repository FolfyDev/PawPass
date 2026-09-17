import { api } from './api.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function openPrintWindow(tail) {
  return new Promise((resolve, reject) => {
    const win = window.open('', '_blank', 'width=420,height=640');
    if (!win) return reject(new Error('Your browser blocked the print window — allow pop-ups for this site.'));
    win.document.write(`<!doctype html><title>${esc(tail)}</title>
<style>@page{size:auto;margin:0} html,body{margin:0;padding:0;height:100%} img{width:100%;height:100%;object-fit:contain;display:block}</style>
<img id="badge" src="${esc(`${api.base}/api/badges/registration/${tail}.png`)}">`);
    win.document.close();
    win.onafterprint = () => win.close();
    const img = win.document.getElementById('badge');
    img.onload = () => { win.focus(); win.print(); resolve(); };
    img.onerror = () => reject(new Error('Could not load the badge image to print.'));
  });
}
export async function printBadge(value, mode) {
  const tail = String(value).trim().split('|')[0].trim().split('/').pop();
  if (mode === 'browser') {
    await openPrintWindow(tail);
    return api.post(`/api/badges/registration/${tail}/printed`);
  }
  return api.post('/api/badges/print', { value });
}

function openPrintWindowMulti(tails) {
  return new Promise((resolve, reject) => {
    const win = window.open('', '_blank', 'width=420,height=640');
    if (!win) return reject(new Error('Your browser blocked the print window — allow pop-ups for this site.'));
    const imgs = tails.map((t) => `<img class="badge" src="${esc(`${api.base}/api/badges/registration/${t}.png`)}">`).join('');
    win.document.write(`<!doctype html><title>${tails.length} badges</title>
<style>@page{size:auto;margin:0} html,body{margin:0;padding:0}
.badge{display:block;width:100%;page-break-after:always;object-fit:contain}
.badge:last-child{page-break-after:auto}</style>
${imgs}`);
    win.document.close();
    win.onafterprint = () => win.close();
    const tags = win.document.querySelectorAll('img.badge');
    let loaded = 0;
    let failed = false;
    tags.forEach((img) => {
      img.onload = () => {
        loaded += 1;
        if (loaded === tags.length && !failed) { win.focus(); win.print(); resolve(); }
      };
      img.onerror = () => { failed = true; reject(new Error('Could not load one of the badge images to print.')); };
    });
  });
}

export async function printBadges(codes, mode) {
  const tails = codes.map((v) => String(v).trim().split('/').pop());
  if (mode === 'browser') {
    await openPrintWindowMulti(tails);
    return Promise.all(tails.map((t) => api.post(`/api/badges/registration/${t}/printed`)));
  }
  return api.post('/api/badges/print-batch', { codes: tails });
}

export const ATTENDEE_LIST_COLUMNS = [
  ['code', 'Code'], ['badgeNumber', 'Badge #'], ['fursonaName', 'Badge name'], ['legalName', 'Preferred name'],
  ['email', 'Email'], ['telegram', 'Telegram'], ['status', 'Status'], ['tier', 'Tier'], ['badgeTier', 'Badge tier'],
  ['paymentMethod', 'Payment'], ['paymentAmount', 'Amount'], ['checkedInAt', 'Checked in'],
];

// Blanks always sort last — a column full of "—" isn't useful to page
// through either way, no matter which field it's mixed in with.
function sortRows(rows, key) {
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    const aEmpty = av === null || av === undefined || av === '';
    const bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
    if (typeof av === 'string' && typeof bv === 'string') return av.toLowerCase().localeCompare(bv.toLowerCase());
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

export function printAttendeeList(rows, eventTitle, columnKeys, sortKey = 'badgeNumber') {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) throw new Error('Your browser blocked the print window — allow pop-ups for this site.');

  const cols = columnKeys?.length
    ? ATTENDEE_LIST_COLUMNS.filter(([key]) => columnKeys.includes(key))
    : ATTENDEE_LIST_COLUMNS;
  const sorted = sortRows(rows, sortKey);
  const cell = (r, key) => {
    if (key === 'checkedInAt') return r.checkedInAt ? new Date(r.checkedInAt).toLocaleString() : '';
    if (key === 'telegram') return r.telegram ? `@${r.telegram}` : '';
    if (key === 'paymentAmount') return r.paymentAmount != null ? `$${Number(r.paymentAmount).toFixed(2)}` : '';
    return r[key] ?? '';
  };

  const head = cols.map(([, label]) => `<th>${esc(label)}</th>`).join('');
  const body = sorted.map((r) => `<tr>${cols.map(([key]) => `<td>${esc(cell(r, key))}</td>`).join('')}</tr>`).join('');

  win.document.write(`<!doctype html><title>${esc(eventTitle || 'Attendees')} — attendee list</title>
<style>
@page { size: 8.5in 11in; margin: 0.5in; }
* { box-sizing: border-box; }
body { font: 10px/1.4 -apple-system, Segoe UI, Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 16px; margin: 0 0 2px; }
p.meta { margin: 0 0 14px; color: #555; font-size: 11px; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #999; padding: 3px 5px; text-align: left; word-break: break-word; }
th { background: #eee; }
tr { page-break-inside: avoid; }
</style>
<h1>${esc(eventTitle || 'Attendees')}</h1>
<p class="meta">Attendee list &middot; ${rows.length} records &middot; printed ${new Date().toLocaleString()}</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  win.document.close();
  win.focus();
  win.print();
}
