import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Pill } from '../../components/Bits.jsx';

/// Admin access is grant-only: someone signs in with Telegram first, then an
/// owner finds them here and elevates them.
export default function Staff() {
  const { user } = useSession();
  const [staff, setStaff] = useState([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [msg, setMsg] = useState('');
  const isOwner = user.role === 'OWNER';

  const load = () => api.get('/api/admin/users').then(setStaff);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!q) return setFound([]);
    const t = setTimeout(() => api.get(`/api/admin/users?q=${encodeURIComponent(q)}`).then(setFound), 250);
    return () => clearTimeout(t);
  }, [q]);

  const setRole = async (id, role) => {
    try { await api.post(`/api/admin/users/${id}/role`, { role }); setMsg(''); load(); setQ(''); }
    catch (e) { setMsg(e.message); }
  };

  return (
    <>
      <p className="eyebrow">Access</p>
      <h1>Staff</h1>
      {!isOwner && <p className="note">Only owners can change roles. You can see who has access.</p>}
      {msg && <p className="note bad">{msg}</p>}

      <div className="card" style={{ padding: 0, marginBottom: 24, overflow: 'auto' }}>
        <table>
          <thead><tr><th>Person</th><th>Telegram</th><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {staff.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.displayName}</strong></td>
                <td className="small muted">{u.telegramUsername ? `@${u.telegramUsername}` : u.telegramId || '—'}</td>
                <td className="small muted">{u.email || '—'}</td>
                <td><Pill tone={u.role === 'OWNER' ? 'wait' : 'go'}>{u.role}</Pill></td>
                <td style={{ textAlign: 'right' }}>
                  {isOwner && u.id !== user.id && (
                    <>
                      {u.role === 'ADMIN' && <button className="btn sm" onClick={() => setRole(u.id, 'OWNER')}>Make owner</button>}{' '}
                      <button className="btn sm danger" onClick={() => setRole(u.id, 'USER')}>Remove access</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isOwner && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Grant admin access</h2>
          <p className="small muted">They need to sign in with Telegram once first, then search for them here.</p>
          <input placeholder="Search by name, @username or email" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.filter((u) => u.role === 'USER').map((u) => (
            <div key={u.id} className="spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
              <span>{u.displayName} <span className="small muted">{u.telegramUsername ? `@${u.telegramUsername}` : ''}</span></span>
              <button className="btn sm primary" onClick={() => setRole(u.id, 'ADMIN')}>Make admin</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
