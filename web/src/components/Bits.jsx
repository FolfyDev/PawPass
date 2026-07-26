export const Pill = ({ tone = '', children }) => <span className={`pill ${tone}`}>{children}</span>;

export const StatusPill = ({ status, checkedInAt }) => {
  if (checkedInAt) return <Pill tone="go">Checked in</Pill>;
  if (status === 'WAITLIST') return <Pill tone="wait">Waitlist</Pill>;
  if (status === 'CANCELLED') return <Pill tone="stop">Cancelled</Pill>;
  return <Pill>Confirmed</Pill>;
};

export function Field({ label, help, children }) {
  return (
    <label className="field">
      <span>{label}{help && <span className="help"> — {help}</span>}</span>
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

export const fmtDate = (d, tz) =>
  new Date(d).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: tz || undefined,
  });

/// Telegram photo if we have one (only ever comes through the web Login
/// Widget — see server/src/routes/auth.js), otherwise a plain initial.
export function Avatar({ src, name, size = 28 }) {
  const style = { width: size, height: size, borderRadius: '50%' };
  if (src) return <img src={src} alt="" width={size} height={size} style={{ ...style, objectFit: 'cover' }} />;
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
