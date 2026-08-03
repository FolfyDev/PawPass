import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import TelegramLogin from '../components/TelegramLogin.jsx';
import { Field } from '../components/Bits.jsx';

export default function Login() {
  const { config, settings, refresh } = useSession();
  const nav = useNavigate();
  const [tab, setTab] = useState(null);
  const [code, setCode] = useState('');
  const [creds, setCreds] = useState({ email: '', password: '' });
  const [devName, setDevName] = useState('Dev User');
  const [devRole, setDevRole] = useState('OWNER');
  const [error, setError] = useState('');

  // The widget needs an https domain registered with BotFather. When that is
  // not the case, lead with the code flow instead of showing a button that
  // silently fails.
  useEffect(() => {
    if (!config) return;
    setTab(config.telegram?.widgetUsable ? 'widget' : config.telegram?.enabled ? 'code' : 'email');
  }, [config]);

  const done = async () => { await refresh(); nav('/'); };
  const run = async (fn) => { setError(''); try { await fn(); await done(); } catch (e) { setError(e.message); } };

  const bot = settings?.telegramBot || config?.telegram?.botUsername;

  return (
    <div style={{ maxWidth: 440, margin: '60px auto' }}>
      <p className="eyebrow">Sign in</p>
      <h1>Continue</h1>

      <div className="row" style={{ marginBottom: 14 }}>
        {config?.telegram?.widgetUsable && <button className={`btn sm ${tab === 'widget' ? 'primary' : ''}`} onClick={() => setTab('widget')}>Telegram button</button>}
        {config?.telegram?.enabled && <button className={`btn sm ${tab === 'code' ? 'primary' : ''}`} onClick={() => setTab('code')}>Code from the bot</button>}
        <button className={`btn sm ${tab === 'email' ? 'primary' : ''}`} onClick={() => setTab('email')}>Sign in with email</button>
        {config?.devAuth && <button className={`btn sm ${tab === 'dev' ? 'primary' : ''}`} onClick={() => setTab('dev')}>Dev</button>}
      </div>

      {tab === 'widget' && (
        <div className="card stack">
          <p className="muted small">Attendee accounts are Telegram accounts. Nothing to remember, and your ticket shows up in chat.</p>
          <TelegramLogin botUsername={bot} onDone={done} />
        </div>
      )}

      {tab === 'code' && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/auth/telegram-code', { code })); }}>
          <p className="muted small">
            Message {bot ? <a href={`https://t.me/${bot}`}>@{bot}</a> : 'the bot'} and send <code className="mono">/login</code>. It replies with a code.
          </p>
          <Field label="Sign-in code">
            <input className="mono" autoFocus placeholder="XXXX-XXXX" value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.12em' }} />
          </Field>
          {error && <p className="note bad">{error}</p>}
          <button className="btn primary">Sign in</button>
          <p className="small muted" style={{ margin: 0 }}>Codes work once and expire after a few minutes.</p>
        </form>
      )}

      {tab === 'email' && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/auth/password', creds)); }}>
          <p className="muted small">Sign in with the email and password you set on your account after registering.</p>
          <Field label="Email"><input type="email" autoComplete="username" value={creds.email}
            onChange={(e) => setCreds({ ...creds, email: e.target.value })} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" value={creds.password}
            onChange={(e) => setCreds({ ...creds, password: e.target.value })} /></Field>
          {error && <p className="note bad">{error}</p>}
          <button className="btn primary">Sign in</button>
        </form>
      )}

      {tab === 'dev' && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/auth/dev', { name: devName, role: devRole })); }}>
          <p className="note">Local development sign-in. This is refused unless the server is running on http and localhost.</p>
          <Field label="Name"><input value={devName} onChange={(e) => setDevName(e.target.value)} /></Field>
          <Field label="Role">
            <select value={devRole} onChange={(e) => setDevRole(e.target.value)}>
              {['USER', 'ADMIN', 'OWNER'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          {error && <p className="note bad">{error}</p>}
          <button className="btn signal">Sign in as this account</button>
        </form>
      )}

      {!config?.telegram?.enabled && tab !== 'dev' && (
        <p className="small muted" style={{ marginTop: 14 }}>
          Telegram sign-in is off because no bot token is set. You can still register for events and sign in with just an email and password.
        </p>
      )}
    </div>
  );
}
