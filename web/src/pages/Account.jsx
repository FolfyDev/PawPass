import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import TelegramLogin from '../components/TelegramLogin.jsx';
import { Field } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';

export default function Account() {
  const { user, config, settings, isStaff, refresh } = useSession();
  usePageMeta({ title: 'Account', noindex: true });
  const [params] = useSearchParams();
  const [pw, setPw] = useState({ email: user.email || '', password: '' });
  const [email, setEmail] = useState(user.email || '');
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);
  const [linkCode, setLinkCode] = useState('');
  const [linkMsg, setLinkMsg] = useState('');
  const [linkMsgOk, setLinkMsgOk] = useState(true);
  const [fursonaName, setFursonaName] = useState(user.fursonaName || '');
  const [fnMsg, setFnMsg] = useState('');
  const [fnMsgOk, setFnMsgOk] = useState(true);
  const [delMsg, setDelMsg] = useState('');
  const nav = useNavigate();

  const deleteAccount = async () => {
    const typed = prompt('This removes your name, email and Telegram from PawPass and signs you out. It can\'t be undone. Type DELETE to confirm.');
    if (typed == null) return;
    setDelMsg('');
    try {
      await api.post('/api/my/account/delete', { confirm: typed.trim() });
      await refresh();
      nav('/');
    } catch (e) { setDelMsg(e.message); }
  };

  const saveFursonaName = async (e) => {
    e.preventDefault();
    setFnMsg('');
    try {
      await api.post('/api/auth/fursona-name', { fursonaName });
      await refresh();
      setFnMsg('Badge name updated.');
      setFnMsgOk(true);
    } catch (err) { setFnMsg(err.message); setFnMsgOk(false); }
  };

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
          You're registered! Sign back in any time with an emailed code.
          {!user.telegramId && ' Or link Telegram above.'}
        </p>
      )}

      {settings?.askFursonaName !== false && (
        <form className="card stack" style={{ marginBottom: 20 }} onSubmit={saveFursonaName}>
          <h2 style={{ margin: 0 }}>Badge name</h2>
          <p className="small muted">Applies to all your current registrations.</p>
          <Field label={settings?.fursonaNameLabel || 'Fursona name'} help="The big name on your badge">
            <input value={fursonaName} onChange={(e) => setFursonaName(e.target.value)} />
          </Field>
          {fnMsg && <p className={`note ${fnMsgOk ? 'good' : 'bad'}`}>{fnMsg}</p>}
          <button className="btn primary">Save badge name</button>
        </form>
      )}

      {isStaff ? (
        <form className="card stack" onSubmit={savePassword}>
          <h2 style={{ margin: 0 }}>Password sign-in</h2>
          <p className="small muted">For staff sign-in.</p>
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
          <p className="small muted">Sign-in codes are sent here.</p>
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`}>{msg}</p>}
          <button className="btn primary">Save email</button>
        </form>
      )}

      <section className="card stack" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0 }}>Your data</h2>
        <div className="row">
          <a className="btn" href={`${api.base}/api/my/data`}>Download my data</a>
          {!isStaff && <button type="button" className="btn danger" onClick={deleteAccount}>Delete my account</button>}
        </div>
        {delMsg && <p className="note bad" style={{ margin: 0 }}>{delMsg}</p>}
      </section>
    </div>
  );
}
