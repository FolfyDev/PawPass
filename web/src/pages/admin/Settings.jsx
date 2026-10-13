import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

/// Newer releases on GitHub (server/src/lib/updates.js). Upgrading is done on
/// the host, so this shows the commands rather than running anything.
function UpdatesCard() {
  const [u, setU] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/api/admin/updates').then(setU).catch(() => {}); }, []);
  if (!u) return null;

  const refresh = async () => {
    setBusy(true); setMsg('');
    try { setU(await api.get('/api/admin/updates?refresh=1')); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const choose = async (channel) => {
    setMsg('');
    try { setU(await api.put('/api/admin/updates/channel', { channel })); } catch (e) { setMsg(e.message); }
  };
  const t = u.target;
  const commands = t && `git fetch --tags\ngit checkout ${t.tag}\ndocker compose up -d --build`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(commands); setMsg('Commands copied.'); } catch { setMsg('Copy failed. Select the commands and copy them by hand.'); }
  };

  return (
    <div className="card stack" style={{ marginBottom: 20 }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>Updates</h2>
        <span className="small muted">This build: <span className="mono">{u.current}</span></span>
      </div>
      {!u.enabled ? (
        <p className="small muted" style={{ margin: 0 }}>Release checks are off (<code className="mono">UPDATE_CHECK=false</code> in <code className="mono">.env</code>).</p>
      ) : (
        <>
          <div className="row">
            <div className="seg" role="group" aria-label="Release channel">
              <button aria-current={u.channel === 'main' ? 'true' : undefined} onClick={() => choose('main')}>Stable</button>
              <button aria-current={u.channel === 'dev' ? 'true' : undefined} onClick={() => choose('dev')}>Dev</button>
            </div>
            <span className="small muted">
              {u.channel === 'dev' ? 'Stable releases and pre-releases from the Dev branch.' : 'Stable releases from main only.'}
            </span>
          </div>

          {u.status === 'behind' && (
            <div className="note" style={{ margin: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <strong>{t.name} is available</strong>
                {t.prerelease && <span className="pill wait">Pre-release</span>}
                <span className="small muted">{new Date(t.publishedAt).toLocaleDateString()}</span>
              </div>
              {u.between.length > 1 && <p className="small" style={{ margin: '6px 0 0' }}>{u.between.length} releases since this build: {u.between.map((r) => r.tag).join(', ')}.</p>}
              {u.between.filter((r) => r.notes.trim()).map((r) => (
                <details key={r.tag} style={{ marginTop: 8 }}>
                  <summary className="small">What's new in {r.name}</summary>
                  <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{r.notes}</div>
                </details>
              ))}
              <p className="small" style={{ margin: '10px 0 6px' }}>
                To upgrade, take a backup first (<Link to="/admin/backup">Backup &amp; restore</Link>), then run this in the PawPass folder on the server.
                Database changes apply on their own when the server restarts. Avoid doing it while check-in is busy.
              </p>
              <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{commands}</pre>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={copy}>Copy commands</button>
                <a className="btn sm ghost" href={t.url} target="_blank" rel="noreferrer">Release on GitHub ↗</a>
              </div>
            </div>
          )}

          {u.status === 'current' && (
            <p className="small" style={{ margin: 0 }}><span className="pill go">Up to date</span> This is the newest {u.channel === 'dev' ? 'release' : 'stable release'}, {t.name}.</p>
          )}

          {u.status === 'ahead' && (
            <div className="note" style={{ margin: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="pill wait">Development build</span>
                <span className="small">Newer than the latest {u.channel === 'dev' ? 'release' : 'stable release'}, {t.name}.</span>
              </div>
              {u.unreleasedMigrations == null ? (
                <p className="small muted" style={{ margin: '8px 0 0' }}>Couldn't compare this build's database changes with {t.tag}.</p>
              ) : u.unreleasedMigrations.length > 0 && (
                <p className="small" style={{ margin: '8px 0 0' }}>
                  <strong>Unreleased database changes:</strong>{' '}
                  {u.unreleasedMigrations.length > 3
                    ? `${u.unreleasedMigrations.length} (${u.unreleasedMigrations[0]} to ${u.unreleasedMigrations.at(-1)})`
                    : u.unreleasedMigrations.join(', ')}. They aren't in any {u.channel === 'dev' ? '' : 'stable '}release yet,
                  and they can't be undone, so this database can't go back to {t.tag}. Keep a backup from before this build if you might need to.
                </p>
              )}
              <p className="small" style={{ margin: '8px 0 0' }}>
                {u.channel === 'dev'
                  ? <>Want to get back onto stable releases? Switch to <strong>Stable</strong> and you'll be told when one reaches or passes this build. There's no downgrade.{' '}
                      <button className="link-btn" onClick={() => choose('main')}>Switch to stable</button></>
                  : <>You'll be told here when a stable release reaches or passes this build. There's no downgrade.</>}
              </p>
            </div>
          )}

          {u.status === 'unknown' && !u.error && <p className="small muted" style={{ margin: 0 }}>No releases found on {u.repo}.</p>}
          {u.error && <p className="small" style={{ margin: 0, color: 'var(--stop)' }}>Couldn't check for updates: {u.error}</p>}

          <div className="row">
            <button className="btn sm" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Check now'}</button>
            {u.checkedAt && <span className="small muted">Checked {new Date(u.checkedAt).toLocaleString()} · <a href={`https://github.com/${u.repo}/releases`} target="_blank" rel="noreferrer">All releases ↗</a></span>}
          </div>
        </>
      )}
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

      <UpdatesCard />
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
