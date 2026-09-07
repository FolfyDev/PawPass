import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import TelegramLogin from '../components/TelegramLogin.jsx';
import { Field } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';

export default function Login() {
  const { config, settings, refresh } = useSession();
  usePageMeta({ title: 'Sign in' });
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [tab, setTab] = useState(null);
  const [code, setCode] = useState('');
  const [emailStep, setEmailStep] = useState('enter');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [devName, setDevName] = useState('Dev User');
  const [devRole, setDevRole] = useState('OWNER');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!config) return;
    setTab(
      config.telegram?.widgetUsable ? 'widget'
      : config.telegram?.enabled ? 'code'
      : config.emailCodeEnabled ? 'email'
      : config.devAuth ? 'dev'
      : null,
    );
  }, [config]);

  const done = async () => { await refresh(); nav('/'); };
  const run = async (fn) => { setError(''); try { await fn(); await done(); } catch (e) { setError(e.message); } };

  const bot = settings?.telegramBot || config?.telegram?.botUsername;

  const requestEmailCode = async (e) => {
    e.preventDefault();
    setError('');
    try { await api.post('/api/auth/email-code/request', { email }); setEmailStep('sent'); }
    catch (e) { setError(e.message); }
  };

  return (
    <div style={{ maxWidth: 440, margin: '60px auto' }}>
      <p className="eyebrow">Sign in</p>
      <h1>Continue</h1>

      {params.get('expired') === '1' && (
        <p className="note bad" style={{ marginBottom: 14 }}>
          That sign-in link already expired or was used. Send <code className="mono">/login</code> to the bot again for a fresh one.
        </p>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        {config?.telegram?.widgetUsable && <button className={`btn sm ${tab === 'widget' ? 'primary' : ''}`} onClick={() => setTab('widget')}>Telegram button</button>}
        {config?.telegram?.enabled && <button className={`btn sm ${tab === 'code' ? 'primary' : ''}`} onClick={() => setTab('code')}>Code from the bot</button>}
        {config?.emailCodeEnabled && <button className={`btn sm ${tab === 'email' ? 'primary' : ''}`} onClick={() => setTab('email')}>Email code</button>}
        {config?.devAuth && <button className={`btn sm ${tab === 'dev' ? 'primary' : ''}`} onClick={() => setTab('dev')}>Dev</button>}
      </div>

      {tab === null && config && (
        <p className="note bad">
          No sign-in method is configured on this instance. Set a Telegram bot token, SMTP credentials, or ask an organizer for access.
        </p>
      )}

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

      {tab === 'email' && emailStep === 'enter' && (
        <form className="card stack" onSubmit={requestEmailCode}>
          <p className="muted small">We'll email you a one-time code — no password to remember.</p>
          <Field label="Email"><input type="email" autoComplete="username" autoFocus value={email}
            onChange={(e) => setEmail(e.target.value)} /></Field>
          {error && <p className="note bad">{error}</p>}
          <button className="btn primary">Send code</button>
        </form>
      )}

      {tab === 'email' && emailStep === 'sent' && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/auth/email-code/verify', { email, code: emailCode })); }}>
          <p className="muted small">If an account uses {email}, a code just landed in that inbox.</p>
          <Field label="Sign-in code">
            <input className="mono" autoFocus placeholder="XXXX-XXXX" value={emailCode}
              onChange={(e) => setEmailCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.12em' }} />
          </Field>
          {error && <p className="note bad">{error}</p>}
          <button className="btn primary">Sign in</button>
          <button type="button" className="btn ghost sm" onClick={() => { setEmailStep('enter'); setError(''); }}>Use a different email</button>
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

      {!config?.telegram?.enabled && config?.emailCodeEnabled && tab !== 'dev' && (
        <p className="small muted" style={{ marginTop: 14 }}>
          Telegram sign-in is off because no bot token is set. You can still register for events and sign in with an emailed code.
        </p>
      )}
    </div>
  );
}
