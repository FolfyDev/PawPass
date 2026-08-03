import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field } from '../../components/Bits.jsx';

const TEXT_FIELDS = [
  ['orgName', 'Organisation name'],
  ['tagline', 'Home page headline'],
  ['welcomeMessage', 'Home page intro'],
  ['legalNameLabel', 'Label for the legal name field'],
  ['legalNameHelp', 'Help text under the legal name field'],
  ['fursonaNameLabel', 'Label for the fursona name field'],
  ['ticketFooter', 'Line under the ticket QR'],
  ['botWelcome', 'Telegram bot greeting'],
  ['supportEmail', 'Support email'],
  ['supportTelegram', 'Support Telegram handle'],
];

export default function Settings() {
  const { refresh } = useSession();
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => { api.get('/api/admin/settings').then(setS); }, []);
  if (!s) return <p className="muted">Loading…</p>;

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

  const downloadSettings = () => {
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pawpass-settings.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const uploadSettings = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again later
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      // Only known keys make it in — an uploaded file with junk or unexpected
      // fields shouldn't create garbage settings rows.
      const allowed = Object.keys(s);
      const clean = Object.fromEntries(Object.entries(parsed).filter(([k]) => allowed.includes(k)));
      setS((cur) => ({ ...cur, ...clean }));
      setMsg('Loaded — review the fields below, then Save settings to apply.');
    } catch (err) {
      setMsg(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message);
    }
  };

  return (
    <>
      <p className="eyebrow">Instance</p>
      <h1>Settings</h1>
      <p className="muted">Wording and branding for this deployment. Anything infrastructural — SMTP, printer address, wallet certificates — lives in <code className="mono">.env</code>.</p>
      {msg && <p className="note good">{msg}</p>}

      <div className="card stack" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Import / export</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Download this instance's settings as JSON, edit the values, and re-upload to configure a new deployment in
          one shot instead of retyping every field — the same idea as this repo's <code className="mono">.env.example</code>.
          A starter file with sample values is checked in as <code className="mono">settings.example.json</code>.
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
        <Field label="Banner" help="PNG, ~1170×123 — replaces the org name in the nav">
          <input type="file" accept="image/png,image/svg+xml,image/webp" onChange={uploadBanner} />
          {s.logoUrl && <img src={s.logoUrl} alt="Banner preview" style={{ height: 32, marginTop: 10, display: 'block' }} />}
        </Field>
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
