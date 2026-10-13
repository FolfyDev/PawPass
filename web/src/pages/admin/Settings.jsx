import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field } from '../../components/Bits.jsx';
import { PageSkeleton } from '../../components/Skeleton.jsx';

const TEXT_FIELDS = [
  ['orgName', 'Organisation name'],
  ['tagline', 'Home page headline'],
  ['welcomeMessage', 'Home page intro'],
  ['legalNameLabel', 'Label for the preferred name field'],
  ['legalNameHelp', 'Help text under the preferred name field'],
  ['fursonaNameLabel', 'Label for the fursona name field'],
  ['ticketFooter', 'Line under the ticket QR'],
  ['botWelcome', 'Telegram bot greeting'],
  ['supportEmail', 'Support email'],
  ['supportTelegram', 'Support Telegram handle'],
];

const fmtDay = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/// How long personal data is kept after each event ends (lib/retention.js).
function RetentionCard() {
  const [r, setR] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/admin/retention').then(setR).catch(() => {}); }, []);
  if (!r) return null;

  const choose = async (months) => {
    setMsg('');
    try { setR(await api.put('/api/admin/retention', { months })); } catch (e) { setMsg(e.message); }
  };
  const runNow = async () => {
    const n = r.due.reduce((sum, e) => sum + e.registrations, 0);
    if (!confirm(`Clear personal data from ${r.due.length} event${r.due.length === 1 ? '' : 's'} (${n} registration${n === 1 ? '' : 's'}) now? This can't be undone.`)) return;
    setBusy(true);
    try {
      const { cleared } = await api.post('/api/admin/retention/run');
      setMsg(`Cleared ${cleared.length} event${cleared.length === 1 ? '' : 's'}.`);
      setR(await api.get('/api/admin/retention'));
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card stack" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: 0 }}>Data retention</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Clears names, emails, question answers, hotel guest names and volunteer notes this long after each event ends.
        Payments, check-in counts and badge numbers stay, so reports still add up. Incident reports aren't affected.
      </p>
      <div className="seg" role="group" aria-label="Keep personal data for">
        <button aria-current={r.months == null ? 'true' : undefined} onClick={() => choose(null)}>Keep forever</button>
        {r.choices.map((m) => (
          <button key={m} aria-current={r.months === m ? 'true' : undefined} onClick={() => choose(m)}>{m} months</button>
        ))}
      </div>
      {r.months != null && (r.due.length === 0
        ? <p className="small muted" style={{ margin: 0 }}>Nothing is due yet. Events are checked every few hours.</p>
        : (
          <div className="note" style={{ margin: 0 }}>
            <strong>Due now:</strong>{' '}
            {r.due.map((e) => `${e.title} (ended ${fmtDay(e.endsAt)}, ${e.registrations} registration${e.registrations === 1 ? '' : 's'})`).join('; ')}.
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm danger" disabled={busy} onClick={runNow}>{busy ? 'Clearing…' : 'Clear them now'}</button>
              <span className="small muted">Otherwise they're cleared automatically within a few hours.</span>
            </div>
          </div>
        ))}
      {msg && <p className="small" style={{ margin: 0 }}>{msg}</p>}
    </div>
  );
}

export default function Settings() {
  const { user, refresh } = useSession();
  const isOwner = user.role === 'OWNER';
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => { if (isOwner) api.get('/api/admin/settings').then(setS); }, [isOwner]);
  if (!isOwner) return <p className="note bad" style={{ marginTop: 40 }}>You do not have permission to access this page.</p>;
  if (!s) return <PageSkeleton />;

  const save = async () => {
    await api.put('/api/admin/settings', s);
    await refresh();
    setMsg('Settings saved.'); setTimeout(() => setMsg(''), 2000);
  };

  const uploadBanner = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { url } = await api.upload('/api/admin/upload', file);
      await api.put('/api/admin/settings', { logoUrl: url });
      await refresh();
      setS((cur) => ({ ...cur, logoUrl: url }));
      setMsg('Banner uploaded.'); setTimeout(() => setMsg(''), 2000);
    } catch (err) { setMsg(err.message); }
  };

  const uploadBannerLight = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { url } = await api.upload('/api/admin/upload', file);
      await api.put('/api/admin/settings', { logoUrlLight: url });
      await refresh();
      setS((cur) => ({ ...cur, logoUrlLight: url }));
      setMsg('Light mode banner uploaded.'); setTimeout(() => setMsg(''), 2000);
    } catch (err) { setMsg(err.message); }
  };

  const downloadSettings = () => {
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pawpass-settings.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const uploadSettings = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const allowed = Object.keys(s);
      const clean = Object.fromEntries(Object.entries(parsed).filter(([k]) => allowed.includes(k)));
      setS((cur) => ({ ...cur, ...clean }));
      setMsg('Loaded. Review, then Save settings.');
    } catch (err) {
      setMsg(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message);
    }
  };

  return (
    <>
      <p className="eyebrow">Instance</p>
      <h1>Settings</h1>
      <p className="muted">Wording and branding. Server config lives in <code className="mono">.env</code>.</p>
      {msg && <p className="note good">{msg}</p>}

      <RetentionCard />

      <div className="card stack" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Import / export</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Copy settings between instances as JSON. Starter file: <code className="mono">settings.example.json</code>.
        </p>
        <div className="row">
          <button className="btn" onClick={downloadSettings}>Download current settings</button>
          <label className="btn">
            Upload settings JSON
            <input type="file" accept="application/json" onChange={uploadSettings} style={{ display: 'none' }} />
          </label>
        </div>
      </div>

      <div className="card stack">
        <Field label="Banner" help="PNG, about 1170×123">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadBanner} />
          {s.logoUrl && <img src={s.logoUrl} alt="Banner preview" style={{ height: 32, marginTop: 10, display: 'block' }} />}
        </Field>
        <label className="row small">
          <input type="checkbox" checked={!!s.useLightBanner} onChange={(e) => setS({ ...s, useLightBanner: e.target.checked })} />
          Different banner for light mode
        </label>
        {s.useLightBanner && (
          <Field label="Light mode banner" help="Used in light mode">
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadBannerLight} />
            {s.logoUrlLight && <img src={s.logoUrlLight} alt="Light mode banner preview" style={{ height: 32, marginTop: 10, display: 'block', background: '#fff', padding: 4 }} />}
          </Field>
        )}
        {TEXT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            {k === 'welcomeMessage' || k === 'botWelcome'
              ? <textarea value={s[k] || ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
              : <input value={s[k] || ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} />}
          </Field>
        ))}
        <div className="row">
          <Field label="Accent colour">
            <input type="color" value={s.accentColor} onChange={(e) => setS({ ...s, accentColor: e.target.value })} style={{ width: 70, padding: 4 }} />
          </Field>
          <label className="row small" style={{ marginTop: 22 }}>
            <input type="checkbox" checked={s.askFursonaName !== false} onChange={(e) => setS({ ...s, askFursonaName: e.target.checked })} />
            Ask for a fursona name
          </label>
        </div>
        <button className="btn primary" onClick={save}>Save settings</button>
      </div>
    </>
  );
}
