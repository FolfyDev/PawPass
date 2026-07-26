import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Empty } from '../../components/Bits.jsx';

export default function AuditLog() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => { api.get('/api/admin/audit').then(setRows); }, []);

  const filtered = rows?.filter((r) => {
    if (!q) return true;
    const hay = `${r.action} ${r.actor?.displayName || ''} ${r.target || ''} ${JSON.stringify(r.meta || {})}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">Instance</p>
          <h1 style={{ margin: 0 }}>Audit log</h1>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <input placeholder="Filter by action, staff, or target" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
        <span className="small muted">{filtered?.length ?? 0} of {rows?.length ?? 0} shown · most recent 200</span>
      </div>

      {rows === null && <p className="muted">Loading…</p>}
      {rows?.length === 0 && <Empty title="Nothing logged yet">Actions staff take in the admin area will show up here.</Empty>}

      {!!filtered?.length && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Staff</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{r.actor?.displayName || <span className="small muted">system</span>}</td>
                  <td className="mono small">{r.action}</td>
                  <td className="small muted mono">{r.target || '—'}</td>
                  <td className="small muted" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.meta && Object.keys(r.meta).length ? JSON.stringify(r.meta) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
