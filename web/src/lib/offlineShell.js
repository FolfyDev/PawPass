/// Registers /sw.js, which keeps the app's own files cached so a door
/// scanner reloaded with no connection still opens. Only called from the
/// scanner, so attendees' browsers never get a service worker.
export function registerOfflineShell() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline reload just won't work */ });
}
