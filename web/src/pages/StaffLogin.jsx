import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Field } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';

export default function StaffLogin() {
  const { refresh } = useSession();
  usePageMeta({ title: 'Staff sign in', noindex: true });
  const nav = useNavigate();
  const [creds, setCreds] = useState({ email: '', password: '' });
  // Set once the password checked out on an account with two-factor on.
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (challenge) {
        await api.post('/api/auth/password/2fa', { challenge, code });
      } else {
        const r = await api.post('/api/auth/password', creds);
        if (r.twoFactor) { setChallenge(r.challenge); return; }
      }
      await refresh();
      nav('/admin');
    } catch (err) {
      setError(err.message);
      // An expired challenge means starting over from the password.
      if (challenge && err.status === 401 && /took too long/.test(err.message)) setChallenge(null);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 440, margin: '60px auto' }}>
      <p className="eyebrow">Staff</p>
      <h1>Sign in</h1>
      <form className="card stack" onSubmit={submit}>
        {challenge ? (
          <>
            <Field label="Code from your authenticator app" help="Or one of your recovery codes">
              <input className="mono" autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            {error && <p className="note bad">{error}</p>}
            <button className="btn primary" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Verify'}</button>
            <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => { setChallenge(null); setCode(''); setError(''); }}>Use a different account</button>
          </>
        ) : (
          <>
            <Field label="Email"><input type="email" autoComplete="username" value={creds.email}
              onChange={(e) => setCreds({ ...creds, email: e.target.value })} /></Field>
            <Field label="Password"><input type="password" autoComplete="current-password" value={creds.password}
              onChange={(e) => setCreds({ ...creds, password: e.target.value })} /></Field>
            {error && <p className="note bad">{error}</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </>
        )}
      </form>
    </div>
  );
}
