/// App-wide "something is happening" state for buttons, so no button has to
/// track it by hand. When a `.btn` is clicked (or a form is submitted) and
/// that kicks off API requests, the button gets aria-busy="true" — which
/// theme.css turns into a spinner and blocks further clicks — until every
/// request it started has finished.
///
/// A request belongs to the most recently clicked button if it starts within
/// CLAIM_MS of the click, or while that button is still busy (so a chain like
/// `await a(); await b();` keeps spinning across both).

const CLAIM_MS = 400;
// Gap between one request ending and the next starting in a chain.
const SETTLE_MS = 60;

let lastButton = null;
let lastAt = 0;
const pending = new Map(); // button -> in-flight count
const settleTimers = new Map();

function remember(button) {
  if (!button || button.disabled) return;
  lastButton = button;
  lastAt = Date.now();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => remember(e.target.closest?.('.btn')), true);
  document.addEventListener('submit', (e) => {
    remember(e.submitter?.closest?.('.btn') || e.target.querySelector?.('button.btn:not([type=button])'));
  }, true);
}

/// Called by lib/api.js around every request. Returns a function to call when
/// the request finishes.
export function trackRequest() {
  const button = lastButton;
  const owned = button && button.isConnected && (pending.has(button) || Date.now() - lastAt < CLAIM_MS);
  if (!owned) return () => {};

  clearTimeout(settleTimers.get(button));
  pending.set(button, (pending.get(button) || 0) + 1);
  button.setAttribute('aria-busy', 'true');

  return () => {
    const left = (pending.get(button) || 1) - 1;
    if (left > 0) { pending.set(button, left); return; }
    settleTimers.set(button, setTimeout(() => {
      if ((pending.get(button) || 0) > 0) return;
      pending.delete(button);
      settleTimers.delete(button);
      button.removeAttribute('aria-busy');
    }, SETTLE_MS));
    pending.set(button, 0);
  };
}
