import { api } from './api.js';

/// Every popup window below is built with document.write() string
/// concatenation, and some of what gets concatenated in (a scanned QR/Aztec
/// payload, a typed badge code) is attacker-influenced — a malicious code
/// handed to a staff member at check-in could otherwise break out of the
/// `<title>` text or an `<img src="...">` attribute and inject script into
/// the admin's own session. Escaping quotes too (not just &/</>) makes this
/// safe in both contexts.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/// Opens the badge image in a new tab and fires the browser's own print
/// dialog — for a printer that's USB-attached to whichever computer staff
/// are actually using, not reachable on the network from the server. The
/// physical label size comes from the OS printer's own default media/page
/// setup (a one-time thing to configure in Windows), not from this page —
/// there's no TCP handshake here to control that, unlike the raw-ZPL path.
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

/// `value` is whatever identifies the ticket — a clean badge code (Attendees,
/// Kiosk), a raw scanned QR payload (a `.../t/<secret>` URL, not a code), or
/// a scanned Aztec badge payload (`CODE|TIER|NAME` — see `{{badge_payload}}`
/// in render.js, only the leading code matters here). Stripping to the first
/// "|" then the trailing path segment leaves a code or secret either way,
/// and the server resolves either — a plain code with neither passes through
/// unchanged.
///
/// `mode` is the instance's printMode setting (from useSession()'s settings,
/// sourced from ZEBRA_PRINT_MODE server-side). 'network' keeps the existing
/// raw-ZPL-over-TCP path; 'browser' is the USB/driver path above.
export async function printBadge(value, mode) {
  const tail = String(value).trim().split('|')[0].trim().split('/').pop();
  if (mode === 'browser') {
    await openPrintWindow(tail);
    return api.post(`/api/badges/registration/${tail}/printed`);
  }
  return api.post('/api/badges/print', { value });
}

/// Same idea as openPrintWindow, but stacks every selected badge into one
/// window and fires a single print job — one OS print dialog for the whole
/// batch instead of one popup per attendee.
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

/// Mass-print: `codes` is a list of badge codes selected in the attendee
/// portal. 'network' hands the whole list to /print-batch as one job;
/// 'browser' opens one combined print window (see above) and then records
/// each badge as printed, same as the single-badge browser path.
export async function printBadges(codes, mode) {
  const tails = codes.map((v) => String(v).trim().split('/').pop());
  if (mode === 'browser') {
    await openPrintWindowMulti(tails);
    return Promise.all(tails.map((t) => api.post(`/api/badges/registration/${t}/printed`)));
  }
  return api.post('/api/badges/print-batch', { codes: tails });
}

/// Opens a printable 8.5×11 reference sheet of every attendee's info in a new
/// tab and fires the print dialog — the same popup-and-print pattern as
/// badge printing, just a plain HTML table instead of a rendered image.
export function printAttendeeList(rows, eventTitle) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) throw new Error('Your browser blocked the print window — allow pop-ups for this site.');

  const cols = [
    ['code', 'Code'], ['badgeNumber', 'Badge #'], ['fursonaName', 'Badge name'], ['legalName', 'Legal name'],
    ['email', 'Email'], ['telegram', 'Telegram'], ['status', 'Status'], ['tier', 'Tier'], ['badgeTier', 'Badge tier'],
    ['paymentMethod', 'Payment'], ['paymentAmount', 'Amount'], ['checkedInAt', 'Checked in'],
  ];
  const cell = (r, key) => {
    if (key === 'checkedInAt') return r.checkedInAt ? new Date(r.checkedInAt).toLocaleString() : '';
    if (key === 'telegram') return r.telegram ? `@${r.telegram}` : '';
    if (key === 'paymentAmount') return r.paymentAmount != null ? `$${Number(r.paymentAmount).toFixed(2)}` : '';
    return r[key] ?? '';
  };

  const head = cols.map(([, label]) => `<th>${esc(label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map(([key]) => `<td>${esc(cell(r, key))}</td>`).join('')}</tr>`).join('');

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
