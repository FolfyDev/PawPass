import { useEffect, useState } from 'react';

export const Pill = ({ tone = '', children }) => <span className={`pill ${tone}`}>{children}</span>;

export const StatusPill = ({ status, checkedInAt }) => {
  if (checkedInAt) return <Pill tone="go">Checked in</Pill>;
  if (status === 'WAITLIST') return <Pill tone="wait">Waitlist</Pill>;
  if (status === 'PENDING_PAYMENT') return <Pill tone="wait">Awaiting payment</Pill>;
  if (status === 'CANCELLED') return <Pill tone="stop">Cancelled</Pill>;
  return <Pill>Confirmed</Pill>;
};

export function Field({ label, help, children }) {
  return (
    <label className="field">
      <span>{label}{help && <span className="help"> · {help}</span>}</span>
      {children}
    </label>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <div className="small">{children}</div>
    </div>
  );
}

/// Integer cents to "$12.50" (or "€12.50" for a eur tier).
export const fmtMoney = (cents, currency = 'usd') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format((cents || 0) / 100);

export const fmtDate = (d, tz) =>
  new Date(d).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: tz || undefined,
  });

export function Avatar({ src, name, size = 28 }) {
  const style = { width: size, height: size, borderRadius: '50%' };
  if (src) return <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" style={{ ...style, objectFit: 'cover' }} />;
  return (
    <span style={{
      ...style, display: 'grid', placeItems: 'center', background: 'var(--rule)', color: 'var(--ink-2)',
      font: `600 ${size * 0.42}px/1 var(--display)`, flex: `0 0 ${size}px`,
    }}>
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

const RSVP_OPTIONS = [
  ['YES', 'Going'],
  ['MAYBE', 'Maybe'],
  ['NO', "Can't go"],
];

export function RsvpButtons({ value, onChange }) {
  return (
    <div className="segmented">
      {RSVP_OPTIONS.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'selected' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const PAYMENT_OPTIONS = [
  ['CASH', 'Cash'],
  ['CARD', 'Card'],
  ['PAYPAL', 'PayPal'],
  ['OTHER', 'Other'],
];

export function PaymentButtons({ value, onChange }) {
  return (
    <div className="segmented">
      {PAYMENT_OPTIONS.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'selected' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/// Live "29:41 left" for a held seat. Calls onExpire once when it hits zero.
export function HoldCountdown({ until, onExpire }) {
  const end = until ? new Date(until).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!end) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [end]);
  const left = end ? Math.max(0, Math.ceil((end - now) / 1000)) : null;
  useEffect(() => {
    if (left === 0) onExpire?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left === 0]);
  if (left === null) return null;
  if (left === 0) return <span className="hold-countdown expired">Your hold has expired</span>;
  const m = Math.floor(left / 60);
  const sec = String(left % 60).padStart(2, '0');
  return (
    <span className={`hold-countdown${left <= 120 ? ' urgent' : ''}`} role="timer" aria-live="off">
      Spot held for <strong className="mono">{m}:{sec}</strong>
    </span>
  );
}

/// The event's custom questions that apply to a ticket type. Mirrors
/// fieldsForTier on the server: a question with tierIds is only for those.
export const fieldsForTier = (event, tierId) =>
  (event?.customFields || []).filter((f) => !f.tierIds?.length || (tierId && f.tierIds.includes(tierId)));
