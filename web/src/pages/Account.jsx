import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import TelegramLogin from '../components/TelegramLogin.jsx';
import { Field } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';

export default function Account() {
  const { user, config, isStaff, refresh } = useSession();
  usePageMeta({ title: 'Account', noindex: true });
  const [params] = useSearchParams();
  const [pw, setPw] = useState({ email: user.email || '', password: '' });
  const [email, setEmail] = useState(user.email || '');
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);
  const [linkCode, setLinkCode] = useState('');
  const [linkMsg, setLinkMsg] = useState('');
  const [linkMsgOk, setLinkMsgOk] = useState(true);

  const linkWithCode = async (e) => {
    e.preventDefault();
    setLinkMsg('');
    try {
      await api.post('/api/auth/link-telegram-code', { code: linkCode });
      await refresh();
      setLinkCode('');
      setLinkMsg('Telegram linked.');
      setLinkMsgOk(true);
    } catch (err) { setLinkMsg(err.message); setLinkMsgOk(false); }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    try { await api.post('/api/auth/set-password', pw); await refresh(); setMsg('Password updated.'); setMsgOk(true); }
    catch (err) { setMsg(err.message); setMsgOk(false); }
  };

  const saveEmail = async (e) => {
    e.preventDefault();
    try { await api.post('/api/auth/email', { email }); await refresh(); setMsg('Email updated.'); setMsgOk(true); }
    catch (err) { setMsg(err.message); setMsgOk(false); }
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
            {config?.telegram?.enabled && (
              <form className="stack" style={{ marginTop: 10 }} onSubmit={linkWithCode}>
                <p className="small muted" style={{ margin: 0 }}>
                  Or message {config.telegram.botUsername ? <a href={`https://t.me/${config.telegram.botUsername}`}>@{config.telegram.botUsername}</a> : 'the bot'} and
                  send <code className="mono">/login</code>, then paste the code here:
                </p>
                <div className="row">
                  <input className="mono" placeholder="XXXX-XXXX" value={linkCode}
                    onChange={(e) => setLinkCode(e.target.value.toUpperCase())} style={{ maxWidth: 160, letterSpacing: '.12em' }} />
                  <button className="btn sm">Link</button>
                </div>
                {linkMsg && <p className={`note ${linkMsgOk ? 'good' : 'bad'}`} style={{ margin: 0 }}>{linkMsg}</p>}
              </form>
            )}
          </>
        )}
      </div>

      {params.get('justRegistered') === '1' && (
        <p className="note good" style={{ marginBottom: 20 }}>
          You're registered! Your email works to sign back in any time — we'll send a one-time code, no password needed.
          {!user.telegramId && ' You can also link Telegram above for one-tap sign-in.'}
        </p>
      )}

      {isStaff ? (
        <form className="card stack" onSubmit={savePassword}>
          <h2 style={{ margin: 0 }}>Password sign-in</h2>
          <p className="small muted">Staff can sign in with a password as a Telegram-independent fallback.</p>
          <Field label="Email"><input type="email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} /></Field>
          <Field label="New password" help="At least 10 characters">
            <input type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
          </Field>
          {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`}>{msg}</p>}
          <button className="btn primary">Save password</button>
        </form>
      ) : (
        <form className="card stack" onSubmit={saveEmail}>
          <h2 style={{ margin: 0 }}>Email</h2>
          <p className="small muted">This is where a sign-in code goes if you use the "Email code" option on the sign-in page.</p>
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`}>{msg}</p>}
          <button className="btn primary">Save email</button>
        </form>
      )}
    </div>
  );
}
