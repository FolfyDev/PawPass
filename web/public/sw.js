// PawPass offline shell — see web/src/lib/offlineShell.js.
//
// Caches the app itself (index.html and the hashed /assets/ files) so the
// check-in scanner opens with no connection. Nothing from the API is ever
// cached here: tickets live in the scanner's own offline copy, and every
// /api/ request goes straight to the network.
const CACHE = 'pawpass-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|t|l|uploads)\//.test(url.pathname)) return;

  // Pages: network first, so a deploy shows up straight away; the last
  // copy of the app when there's no connection.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); }
        return res;
      })
      .catch(() => caches.match('/index.html')));
    return;
  }

  // Built files have content hashes in their names, so a cached copy is
  // never stale.
  if (url.pathname.startsWith('/assets/') || url.pathname === '/theme-init.js') {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
