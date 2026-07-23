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

  return (
    <>
      <p className="eyebrow">Instance</p>
      <h1>Settings</h1>
      <p className="muted">Wording and branding for this deployment. Anything infrastructural — SMTP, printer address, wallet certificates — lives in <code className="mono">.env</code>.</p>
      {msg && <p className="note good">{msg}</p>}

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
