import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';

export default function Backup() {
  const { user, refresh } = useSession();
  const isOwner = user.role === 'OWNER';
  const [file, setFile] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState(null);

  if (!isOwner) return <p className="note bad" style={{ marginTop: 40 }}>Only the owner account can back up or restore this instance.</p>;

  const restore = async () => {
    if (!file) return setMsg('Choose a backup .zip file first.');
    if (confirmText !== 'RESTORE') return setMsg('Type RESTORE in the box to confirm.');
    setBusy(true); setMsg(''); setResult(null);
    try {
      const r = await api.upload('/api/admin/restore', file);
      setResult(r);
      setMsg('Restore complete.');
      setFile(null); setConfirmText('');
      await refresh(); // the signed-in account may have changed or gone away
    } catch (e) {
      setMsg(e.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <p className="eyebrow">Instance</p>
      <h1>Backup &amp; restore</h1>
      <p className="muted">
        Everything this app manages — events, registrations, merch, sales, donations, vouchers, badge templates,
        settings, and uploaded files (logos, cached Telegram photos) — as one file. Owner-only, since restoring
        replaces all of it.
      </p>

      <div className="card stack" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Download a backup</h2>
        <p className="small muted" style={{ margin: 0 }}>A snapshot of everything, right now, as a .zip.</p>
        <a className="btn primary" style={{ justifySelf: 'start' }} href={`${api.base}/api/admin/backup`}>Download backup</a>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Restore from a backup</h2>
        <p className="note bad" style={{ margin: 0 }}>
          This replaces ALL current data — every registration, sale, donation, and event — with the contents of the
          file you upload. Anything created since that backup was taken is gone. This cannot be undone. If the
          backup is from a different instance, your own account may not exist in it, and you could be signed out
          once it's done.
        </p>
        <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label className="field">
          <span>Type <strong className="mono">RESTORE</strong> to confirm</span>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" />
        </label>
        {msg && <p className={`note ${result ? 'good' : 'bad'}`}>{msg}</p>}
        {result && (
          <div className="small muted">
            <p style={{ margin: '0 0 6px' }}>{result.filesRestored} file(s) restored. Rows by table:</p>
            <ul style={{ margin: 0, paddingLeft: 18, columns: 2 }}>
              {Object.entries(result.counts).map(([k, n]) => <li key={k}>{k}: {n}</li>)}
            </ul>
          </div>
        )}
        <button className="btn danger" style={{ justifySelf: 'start' }} disabled={busy || !file || confirmText !== 'RESTORE'} onClick={restore}>
          {busy ? 'Restoring…' : 'Restore and replace everything'}
        </button>
      </div>
    </>
  );
}
