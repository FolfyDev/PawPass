const GLYPH = {
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  ready: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  bad: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  warn: <path d="M12 6.5v7M12 17.5h.01" />,
};

const LABEL = { ok: 'Success', ready: 'Ready', bad: 'Failed', warn: 'Warning' };

/// kind: 'ok' (green check) | 'bad' (red X) | 'warn' (amber !) | 'ready'
/// (white circle with a green check, for use on the green ready panel).
export default function StatusMark({ kind, small }) {
  return (
    <span className={`status-mark ${kind}${small ? ' sm' : ''}`} role="img" aria-label={LABEL[kind]}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{GLYPH[kind]}</svg>
    </span>
  );
}
