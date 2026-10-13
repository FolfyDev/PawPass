import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field } from '../../components/Bits.jsx';

const ZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();

/// Pauses every public sign-up (server/src/lib/maintenance.js). Saves on
/// toggle: it's the switch you reach for in a hurry.
export function MaintenanceCard() {
  const { settings, refresh } = useSession();
  const [message, setMessage] = useState(settings?.maintenanceMessage || '');
  const [msg, setMsg] = useState('');
  const on = !!settings?.maintenanceMode;

  const save = async (patch, done) => {
    setMsg('');
    try { await api.put('/api/admin/settings', patch); await refresh(); setMsg(done); setTimeout(() => setMsg(''), 2500); }
    catch (e) { setMsg(e.message); }
  };

  return (
    <div className="card stack" style={{ marginBottom: 20, borderColor: on ? 'var(--signal)' : undefined }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>Maintenance mode</h2>
        {on && <span className="pill wait">On</span>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Pauses registering, buying merch, volunteer and hotel sign-ups, and panel and vendor applications, on the website and the bot.
        Pages stay readable, tickets still work at the door, and staff can still add people from the admin pages.
      </p>
      <Field label="Message" help="Shown as a banner on every page. Blank = a standard line.">
        <input value={message} placeholder="Registration is paused for maintenance. Please check back soon." onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <div className="row">
        <button className={`btn ${on ? '' : 'danger'}`} onClick={() => save({ maintenanceMode: !on, maintenanceMessage: message }, on ? 'Maintenance mode is off.' : 'Maintenance mode is on.')}>
          {on ? 'Turn off maintenance mode' : 'Turn on maintenance mode'}
        </button>
        {on && message !== (settings?.maintenanceMessage || '') && (
          <button className="btn ghost" onClick={() => save({ maintenanceMessage: message }, 'Message updated.')}>Update message</button>
        )}
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

/// Options that used to be .env-only (server/src/lib/instance.js). Blank
/// means "use .env", shown as the placeholder.
export function InstanceOptionsCard() {
  const { user } = useSession();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState({ text: '', ok: true });
  const [testTo, setTestTo] = useState(user?.email || '');
  const [busy, setBusy] = useState('');

  useEffect(() => { api.get('/api/admin/instance-config').then((c) => { setCfg(c); setForm(c.saved); }).catch(() => {}); }, []);
  if (!cfg) return null;

  const say = (text, ok = true) => setMsg({ text, ok });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const env = (k) => (cfg.fromEnv[k] === '' || cfg.fromEnv[k] == null ? 'not set in .env' : `${cfg.fromEnv[k]} (from .env)`);
  const input = (k, props = {}) => <input value={form[k] ?? ''} placeholder={env(k)} onChange={set(k)} {...props} />;

  const save = async () => {
    setBusy('save'); say('');
    try { const c = await api.put('/api/admin/instance-config', form); setCfg(c); setForm(c.saved); say('Saved. In use straight away.'); }
    catch (e) { say(e.message, false); } finally { setBusy(''); }
  };
  const run = async (key, url, body, done) => {
    setBusy(key); say('');
    try { await api.post(url, body); say(done); } catch (e) { say(e.message, false); } finally { setBusy(''); }
  };

  return (
    <div className="card stack" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: 0 }}>Instance options</h2>
      <p className="small muted" style={{ margin: 0 }}>
        These used to be <code className="mono">.env</code> only. Leave a box blank to keep the <code className="mono">.env</code> value shown in it. Save before testing.
      </p>

      <h3 style={{ margin: '8px 0 0' }}>Email</h3>
      <div className="grid-2">
        <Field label="Sender name" help="Shown as who the email is from">{input('emailFromName')}</Field>
        <Field label="Reply-to address" help="Where replies go, e.g. your support inbox">{input('emailReplyTo', { type: 'email' })}</Field>
      </div>
      <Field label="Footer" help="Added to every confirmation, notice and campaign email (not sign-in codes)">
        <textarea value={form.emailFooter ?? ''} placeholder="e.g. Questions? Reply to this email. — The PawCon team" onChange={set('emailFooter')} />
      </Field>
      <div className="row">
        <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" style={{ maxWidth: 260 }} aria-label="Send the test email to" />
        <button className="btn sm" disabled={!!busy} onClick={() => run('email', '/api/admin/status/test-email', { to: testTo }, `Test email sent to ${testTo}.`)}>
          {busy === 'email' ? 'Sending…' : 'Send test email'}
        </button>
      </div>

      <h3 style={{ margin: '8px 0 0' }}>Badge printer</h3>
      <div className="grid-2">
        <Field label="Printer address" help="Host name or IP of the Zebra printer">{input('zebraHost')}</Field>
        <Field label="Port">{input('zebraPort', { type: 'number', min: 1, max: 65535 })}</Field>
        <Field label="Resolution">
          <select value={form.zebraDpi ?? ''} onChange={set('zebraDpi')}>
            <option value="">{env('zebraDpi')}</option>
            {[203, 300, 600].map((d) => <option key={d} value={d}>{d} dpi</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <button className="btn sm" disabled={!!busy} onClick={() => run('print', '/api/admin/status/test-print', {}, 'Test label sent to the printer.')}>
          {busy === 'print' ? 'Printing…' : 'Print test label'}
        </button>
      </div>

      <h3 style={{ margin: '8px 0 0' }}>Defaults and legal</h3>
      <div className="grid-2">
        <Field label="Time zone for new events">
          {input('defaultTimezone', { list: 'pp-zones' })}
          <datalist id="pp-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
        <Field label="Legal entity name" help="On receipts and the privacy and terms pages">{input('legalEntityName')}</Field>
        <Field label="Legal contact email" help="For privacy requests">{input('legalContactEmail', { type: 'email' })}</Field>
      </div>

      <h3 style={{ margin: '8px 0 0' }}>Timing</h3>
      <div className="grid-2">
        <Field label="Checkout hold (minutes)" help="How long a seat is held while someone pays on Stripe. 30 to 1440">
          {input('checkoutMinutes', { type: 'number', min: 30, max: 1440 })}
        </Field>
        <Field label="Sign-in code lifetime (minutes)" help="2 to 60">{input('loginCodeTtlMinutes', { type: 'number', min: 2, max: 60 })}</Field>
      </div>

      <div className="row">
        <button className="btn primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save instance options'}</button>
        {msg.text && <span className="small" style={{ color: msg.ok ? undefined : 'var(--stop)' }}>{msg.text}</span>}
      </div>
    </div>
  );
}

const STATE = { ok: ['go', 'Working'], off: ['', 'Not set up'], error: ['stop', 'Failing'] };

/// Each outside service: working, not set up, or failing, and why
/// (server/src/lib/status.js).
export function StatusCard() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => { setBusy(true); api.get('/api/admin/status').then(setSt).catch(() => {}).finally(() => setBusy(false)); };
  useEffect(load, []);

  return (
    <div className="card stack" style={{ marginBottom: 20 }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>Connections</h2>
        <button className="btn sm" disabled={busy} onClick={load}>{busy ? 'Checking…' : 'Check again'}</button>
      </div>
      {!st ? <p className="small muted" style={{ margin: 0 }}>Checking…</p> : (
        <div className="stack" style={{ gap: 10 }}>
          {st.services.map((s) => (
            <div key={s.key} className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <span className={`pill ${STATE[s.state][0]}`} style={{ minWidth: 92, textAlign: 'center' }}>{STATE[s.state][1]}</span>
              <div>
                <strong>{s.label}</strong>
                <div className="small muted">{s.detail}</div>
              </div>
            </div>
          ))}
          <p className="small muted" style={{ margin: 0 }}>Checked {new Date(st.checkedAt).toLocaleTimeString()}. Keys and passwords are set in <code className="mono">.env</code>.</p>
        </div>
      )}
    </div>
  );
}
