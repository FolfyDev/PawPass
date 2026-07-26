import { api } from './api.js';

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
    win.document.write(`<!doctype html><title>${tail}</title>
<style>@page{size:auto;margin:0} html,body{margin:0;padding:0;height:100%} img{width:100%;height:100%;object-fit:contain;display:block}</style>
<img id="badge" src="${api.base}/api/badges/registration/${tail}.png">`);
    win.document.close();
    win.onafterprint = () => win.close();
    const img = win.document.getElementById('badge');
    img.onload = () => { win.focus(); win.print(); resolve(); };
    img.onerror = () => reject(new Error('Could not load the badge image to print.'));
  });
}

/// `value` is whatever identifies the ticket — a clean badge code (Attendees,
/// Kiosk) or a raw scanned QR payload, which is a `.../t/<secret>` URL, not a
/// code (Scanner). The trailing path segment is a code or a secret either
/// way, and the server resolves either — a plain code with no slashes just
/// passes through split('/').pop() unchanged.
///
/// `mode` is the instance's printMode setting (from useSession()'s settings,
/// sourced from ZEBRA_PRINT_MODE server-side). 'network' keeps the existing
/// raw-ZPL-over-TCP path; 'browser' is the USB/driver path above.
export async function printBadge(value, mode) {
  const tail = String(value).trim().split('/').pop();
  if (mode === 'browser') {
    await openPrintWindow(tail);
    return api.post(`/api/badges/registration/${tail}/printed`);
  }
  return api.post('/api/badges/print', { value });
}
