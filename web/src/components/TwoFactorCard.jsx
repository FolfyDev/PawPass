import { useState } from 'react';
import { api } from '../lib/api.js';
import { Field, Pill } from './Bits.jsx';

/// Recovery codes, shown exactly once, with a copy button.
function RecoveryCodes({ codes, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); setCopied(true); } catch { /* select them by hand */ }
  };
  return (
    <div className="stack">
      <p className="note" style={{ margin: 0 }}>
        <strong>Save these recovery codes now.</strong> Each one signs you in once if you lose your phone. This is the only time they're shown.
      </p>
      <pre className="mono" style={{ margin: 0, padding: 12, background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 8, columns: 2, userSelect: 'all' }}>
        {codes.join('\n')}
      </pre>
      <div className="row">
        <button type="button" className="btn sm" onClick={copy}>{copied ? 'Copied' : 'Copy codes'}</button>
        <button type="button" className="btn sm primary" onClick={onDone}>I've saved them</button>
      </div>
    </div>
  );
}

/// Two-factor for password sign-in, on the staff Account page.
export default function TwoFactorCard({ user, onChange }) {
  const [setup, setSetup] = useState(null); // { qr, secret }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [mode, setMode] = useState(null); // 'disable' | 'regenerate'
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setMsg('');
    setBusy(true);
    try { await fn(); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  const start = () => run(async () => { setSetup(await api.post('/api/auth/2fa/setup')); setCode(''); });
  const enable = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/api/auth/2fa/enable', { code });
      setSetup(null); setCode(''); setCodes(r.recoveryCodes);
    });
  };
  const confirmWithCode = (e) => {
    e.preventDefault();
    run(async () => {
      if (mode === 'disable') { await api.post('/api/auth/2fa/disable', { code }); await onChange(); }
      else setCodes((await api.post('/api/auth/2fa/recovery-codes', { code })).recoveryCodes);
      setMode(null); setCode('');
    });
  };

  return (
    <section className="card stack" style={{ marginTop: 20 }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>Two-factor sign-in</h2>
        {user.hasTwoFactor ? <Pill tone="go">On</Pill> : <Pill>Off</Pill>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Asks for a code from an authenticator app (Google Authenticator, 1Password, Aegis…) after your password. Telegram sign-in isn't affected.
      </p>

      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => { setCodes(null); onChange(); }} />
      ) : setup ? (
        <form className="stack" onSubmit={enable}>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Scan this with your authenticator app.</li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          <img src={setup.qr} alt="QR code for your authenticator app" width="180" height="180" style={{ borderRadius: 8, background: '#fff', padding: 6 }} />
          <p className="small muted" style={{ margin: 0 }}>Can't scan? Enter this key instead: <span className="mono" style={{ userSelect: 'all' }}>{setup.secret.match(/.{1,4}/g).join(' ')}</span></p>
          <Field label="Code from the app">
            <input className="mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 140 }} />
          </Field>
          <div className="row">
            <button className="btn primary" disabled={busy || code.length !== 6}>Turn on</button>
            <button type="button" className="btn ghost" onClick={() => setSetup(null)}>Cancel</button>
          </div>
        </form>
      ) : mode ? (
        <form className="stack" onSubmit={confirmWithCode}>
          <Field label={mode === 'disable' ? 'To turn it off, enter a code from your app' : 'To make new recovery codes, enter a code from your app'} help="Or a recovery code">
            <input className="mono" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 180 }} />
          </Field>
          <div className="row">
            <button className={`btn ${mode === 'disable' ? 'danger' : 'primary'}`} disabled={busy || !code.trim()}>{mode === 'disable' ? 'Turn off' : 'Make new codes'}</button>
            <button type="button" className="btn ghost" onClick={() => { setMode(null); setCode(''); }}>Cancel</button>
          </div>
        </form>
      ) : user.hasTwoFactor ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small" style={{ margin: 0 }}>
            {user.recoveryCodesLeft} recovery code{user.recoveryCodesLeft === 1 ? '' : 's'} left.
            {user.recoveryCodesLeft <= 2 && <strong> Make new ones soon.</strong>}
          </p>
          <div className="row">
            <button className="btn sm" onClick={() => setMode('regenerate')}>New recovery codes</button>
            <button className="btn sm ghost" onClick={() => setMode('disable')}>Turn off</button>
          </div>
        </div>
      ) : user.hasPassword ? (
        <button className="btn primary" style={{ justifySelf: 'start' }} disabled={busy} onClick={start}>Set up two-factor</button>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>Set a password above first.</p>
      )}
      {msg && <p className="note bad" style={{ margin: 0 }}>{msg}</p>}
    </section>
  );
}
