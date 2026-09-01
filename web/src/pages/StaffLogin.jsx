import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Field } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';

/// Deliberately not linked from anywhere in the nav or the public sign-in
/// page — reachable only by whoever has this URL. Hits the same
/// POST /api/auth/password as the public "Sign in with email" tab on
/// Login.jsx; the split here is presentation only, not a second mechanism.
export default function StaffLogin() {
  const { refresh } = useSession();
  usePageMeta({ title: 'Staff sign in', noindex: true });
  const nav = useNavigate();
  const [creds, setCreds] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/api/auth/password', creds);
      await refresh();
      nav('/admin');
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 440, margin: '60px auto' }}>
      <p className="eyebrow">Staff</p>
      <h1>Sign in</h1>
      <form className="card stack" onSubmit={submit}>
        <Field label="Email"><input type="email" autoComplete="username" value={creds.email}
          onChange={(e) => setCreds({ ...creds, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={creds.password}
          onChange={(e) => setCreds({ ...creds, password: e.target.value })} /></Field>
        {error && <p className="note bad">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
