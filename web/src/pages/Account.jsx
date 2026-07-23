import { useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import TelegramLogin from '../components/TelegramLogin.jsx';
import { Field } from '../components/Bits.jsx';

export default function Account() {
  const { user, config, refresh, isStaff } = useSession();
  const [pw, setPw] = useState({ email: user.email || '', password: '' });
  const [msg, setMsg] = useState('');

  const save = async (e) => {
    e.preventDefault();
    try { await api.post('/api/auth/set-password', pw); await refresh(); setMsg('Password updated.'); }
    catch (err) { setMsg(err.message); }
  };

  return (
    <div style={{ maxWidth: 560, margin: '48px auto' }}>
      <p className="eyebrow">Account</p>
      <h1>{user.displayName}</h1>

      <div className="card stack" style={{ marginBottom: 20 }}>
        <div className="spread"><span className="eyebrow">Role</span><span>{user.role}</span></div>
        <div className="spread"><span className="eyebrow">Telegram</span>
          <span>{user.telegramUsername ? `@${user.telegramUsername}` : user.telegramId || 'Not linked'}</span></div>
        {!user.telegramId && (
          <>
            <p className="small muted">Link Telegram so you can sign in either way.</p>
            <TelegramLogin mode="link" botUsername={config?.telegram?.botUsername} onDone={refresh} label="Link this Telegram account" />
          </>
        )}
      </div>

      {isStaff && (
        <form className="card stack" onSubmit={save}>
          <h2 style={{ margin: 0 }}>Password sign-in</h2>
          <p className="small muted">Staff can hold a password as a fallback when Telegram is unavailable.</p>
          <Field label="Email"><input type="email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} /></Field>
          <Field label="New password" help="At least 10 characters">
            <input type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
          </Field>
          {msg && <p className="note">{msg}</p>}
          <button className="btn primary">Save password</button>
        </form>
      )}
    </div>
  );
}
