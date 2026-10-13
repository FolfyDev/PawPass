import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field, Pill } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import { RowsSkeleton } from '../../components/Skeleton.jsx';

/// What can't be granted: whoever can hand out permissions can give
/// themselves any of them, so these stay with owners.
const OWNER_ONLY = ['Staff and permissions', 'Instance settings', 'Backup and restore', 'Data retention'];

/// The permission checklist, area by area. `on` is what's ticked, `via` maps
/// a permission to the group names already granting it (shown, not editable).
function PermissionPicker({ catalog, on, onChange, via = {} }) {
  const toggle = (key) => onChange(on.includes(key) ? on.filter((k) => k !== key) : [...on, key]);
  return (
    <div className="perm-areas">
      {catalog.map(({ area, permissions }) => {
        const keys = permissions.map((p) => p.key).filter((k) => !via[k]);
        const all = keys.length > 0 && keys.every((k) => on.includes(k));
        return (
          <div key={area} className="perm-area" role="group" aria-label={area}>
            <div className="perm-head">
              <span className="eyebrow">{area}</span>
              {keys.length > 1 && (
                <button type="button" className="link-btn" onClick={() => onChange(all ? on.filter((k) => !keys.includes(k)) : [...new Set([...on, ...keys])])}>
                  {all ? 'Clear' : 'All'}
                </button>
              )}
            </div>
            {permissions.map((p) => (
              <label key={p.key} className={`perm${via[p.key] ? ' inherited' : ''}`}>
                <input type="checkbox" checked={Boolean(via[p.key]) || on.includes(p.key)} disabled={Boolean(via[p.key])} onChange={() => toggle(p.key)} />
                <span>
                  <strong>{p.label}</strong>
                  {via[p.key] ? <span className="help"> · from {via[p.key].join(', ')}</span> : p.help && <span className="help"> · {p.help}</span>}
                </span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const countOf = (catalog) => catalog.reduce((n, a) => n + a.permissions.length, 0);

export default function Staff() {
  const { user } = useSession();
  const [tab, setTab] = useState('people');
  const [staff, setStaff] = useState(null);
  const [access, setAccess] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [promoteTo, setPromoteTo] = useState('staff_default');
  const [msg, setMsg] = useState('');
  // { user, groupIds, permissions } while editing one person's access.
  const [editing, setEditing] = useState(null);
  // { id?, name, description, permissions } while editing a group.
  const [group, setGroup] = useState(null);
  const [formMsg, setFormMsg] = useState('');

  const load = () => Promise.all([
    api.get('/api/admin/users').then(setStaff),
    api.get('/api/admin/access').then((a) => {
      setAccess(a);
      // Promote into "Staff" if it still exists, otherwise the first group.
      setPromoteTo((cur) => (a.groups.some((g) => g.id === cur) ? cur : a.groups[0]?.id || ''));
    }),
  ]).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!q) return setFound([]);
    const t = setTimeout(() => api.get(`/api/admin/users?q=${encodeURIComponent(q)}`).then(setFound), 250);
    return () => clearTimeout(t);
  }, [q]);

  const run = async (fn) => { setMsg(''); try { await fn(); await load(); } catch (e) { setMsg(e.message); } };
  const resetTwoFactor = (id) => run(() => api.post(`/api/admin/users/${id}/2fa/reset`));
  const setRole = (id, role, groupIds) => run(async () => { await api.post(`/api/admin/users/${id}/role`, { role, groupIds }); setQ(''); });

  const saveAccess = async () => {
    setFormMsg('');
    try {
      await api.put(`/api/admin/users/${editing.user.id}/access`, { groupIds: editing.groupIds, permissions: editing.permissions });
      setEditing(null); load();
    } catch (e) { setFormMsg(e.message); }
  };
  const saveGroup = async () => {
    setFormMsg('');
    try {
      const body = { name: group.name, description: group.description, permissions: group.permissions };
      if (group.id) await api.patch(`/api/admin/staff-groups/${group.id}`, body);
      else await api.post('/api/admin/staff-groups', body);
      setGroup(null); load();
    } catch (e) { setFormMsg(e.message); }
  };
  const deleteGroup = (g) => {
    const who = g.members.length ? ` Its ${g.members.length} member${g.members.length === 1 ? '' : 's'} lose whatever it gave them.` : '';
    if (confirm(`Delete the ${g.name} group?${who}`)) run(() => api.del(`/api/admin/staff-groups/${g.id}`));
  };

  if (!staff || !access) return (
    <>
      <p className="eyebrow">Access</p>
      <h1>Staff</h1>
      {msg ? <p className="note bad">{msg}</p> : <RowsSkeleton />}
    </>
  );

  const total = countOf(access.catalog);
  const label = Object.fromEntries(access.catalog.flatMap((a) => a.permissions.map((p) => [p.key, p.label])));
  const groupById = Object.fromEntries(access.groups.map((g) => [g.id, g]));
  // While editing someone: which of their permissions come from their groups.
  const inherited = editing ? editing.groupIds.reduce((acc, id) => {
    for (const p of groupById[id]?.permissions || []) (acc[p] ||= []).push(groupById[id].name);
    return acc;
  }, {}) : {};
  const editingTotal = editing ? new Set([...Object.keys(inherited), ...editing.permissions]).size : 0;

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">Access</p>
          <h1 style={{ margin: 0 }}>Staff</h1>
        </div>
        <div className="seg" role="tablist" aria-label="Staff view">
          <button role="tab" aria-current={tab === 'people' ? 'true' : undefined} onClick={() => setTab('people')}>People <span className="muted">({staff.length})</span></button>
          <button role="tab" aria-current={tab === 'groups' ? 'true' : undefined} onClick={() => setTab('groups')}>Groups <span className="muted">({access.groups.length})</span></button>
        </div>
      </div>
      {msg && <p className="note bad">{msg}</p>}

      {tab === 'people' ? (
        <>
          <div className="card" style={{ padding: 0, marginBottom: 24, overflow: 'auto' }}>
            <table>
              <thead><tr><th>Person</th><th>Access</th><th>Two-factor</th><th /></tr></thead>
              <tbody>
                {staff.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.displayName}</strong>
                      <div className="small muted">{[u.telegramUsername ? `@${u.telegramUsername}` : null, u.email].filter(Boolean).join(' · ') || '-'}</div>
                    </td>
                    <td>
                      {u.role === 'OWNER' ? <Pill tone="wait">Owner · everything</Pill> : (
                        <div className="row" style={{ gap: 6 }}>
                          {u.groups.map((g) => <Pill key={g.id}>{g.name}</Pill>)}
                          {u.directPermissions.length > 0 && <Pill tone="go">+{u.directPermissions.length} extra</Pill>}
                          {!u.groups.length && !u.directPermissions.length && <span className="small" style={{ color: 'var(--stop)' }}>No permissions</span>}
                          <span className="small muted">{u.permissions?.length ?? 0} of {total}</span>
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {u.hasTwoFactor ? <Pill tone="go">On</Pill> : u.hasPassword ? <span className="muted">Off</span> : <span className="muted">No password</span>}
                      {u.hasTwoFactor && u.id !== user.id && (
                        <button className="btn sm ghost" style={{ marginLeft: 6 }} title="For a lost phone. Signs them out everywhere."
                          onClick={() => confirm(`Turn off two-factor for ${u.displayName}? They'll sign in with just their password and should set it up again.`) && resetTwoFactor(u.id)}>Reset</button>
                      )}
                    </td>
                    <td>
                      {u.id !== user.id && (
                        <div className="row staff-actions">
                          {u.role === 'ADMIN' && <button className="btn sm" onClick={() => { setFormMsg(''); setEditing({ user: u, groupIds: u.groups.map((g) => g.id), permissions: u.directPermissions }); }}>Permissions</button>}
                          {u.role === 'ADMIN' && <button className="btn sm ghost" onClick={() => confirm(`Make ${u.displayName} an owner? Owners can do everything, including managing staff.`) && setRole(u.id, 'OWNER')}>Make owner</button>}
                          {u.role === 'OWNER' && <button className="btn sm ghost" onClick={() => setRole(u.id, 'ADMIN', [promoteTo].filter(Boolean))}>Make staff</button>}
                          <button className="btn sm danger" onClick={() => confirm(`Remove ${u.displayName}'s staff access?`) && setRole(u.id, 'USER')}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card stack">
            <h2 style={{ margin: 0 }}>Add staff</h2>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input placeholder="Search by name, @username or email" value={q} onChange={(e) => setQ(e.target.value)} />
              <select value={promoteTo} onChange={(e) => setPromoteTo(e.target.value)} aria-label="Group for new staff" style={{ width: 'auto' }}>
                {access.groups.map((g) => <option key={g.id} value={g.id}>Into {g.name}</option>)}
                <option value="">No group yet</option>
              </select>
            </div>
            {found.filter((u) => u.role === 'USER').map((u) => (
              <div key={u.id} className="spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
                <span>{u.displayName} <span className="small muted">{u.telegramUsername ? `@${u.telegramUsername}` : ''}</span></span>
                <button className="btn sm primary" onClick={() => setRole(u.id, 'ADMIN', [promoteTo].filter(Boolean))}>Make staff</button>
              </div>
            ))}
            {q && found.filter((u) => u.role === 'USER').length === 0 && <p className="small muted" style={{ margin: 0 }}>Nobody found who isn't staff already.</p>}
          </div>
        </>
      ) : (
        <>
          <div className="spread" style={{ marginBottom: 14 }}>
            <p className="small muted" style={{ margin: 0, maxWidth: 560 }}>
              A group is a set of permissions, like "Door team" or "Hotel desk". Staff get everything their groups allow, plus anything given to them directly.
            </p>
            <button className="btn primary" onClick={() => { setFormMsg(''); setGroup({ name: '', description: '', permissions: [] }); }}>New group</button>
          </div>
          <div className="stack">
            {access.groups.length === 0 && <div className="empty"><h3>No groups yet</h3><div className="small">Make one for each team, then add people to it.</div></div>}
            {access.groups.map((g) => (
              <div key={g.id} className="card stack" style={{ gap: 10 }}>
                <div className="spread" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ margin: 0 }}>{g.name} <span className="small muted">· {g.permissions.length} of {total} permissions</span></h3>
                    {g.description && <p className="small muted" style={{ margin: '2px 0 0' }}>{g.description}</p>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={() => { setFormMsg(''); setGroup({ ...g }); }}>Edit</button>
                    <button className="btn sm danger" onClick={() => deleteGroup(g)}>Delete</button>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {g.permissions.length ? g.permissions.map((p) => <Pill key={p}>{label[p] || p}</Pill>) : <span className="small muted">No permissions yet.</span>}
                </div>
                <p className="small muted" style={{ margin: 0 }}>
                  {g.members.length ? `Members: ${g.members.map((m) => m.displayName).join(', ')}` : 'No members yet. Add people from the People tab.'}
                </p>
              </div>
            ))}
            <p className="small muted" style={{ margin: 0 }}>Always owner-only, never granted: {OWNER_ONLY.join(', ')}.</p>
          </div>
        </>
      )}

      {editing && (
        <Modal wide title={`Permissions · ${editing.user.displayName}`} onClose={() => setEditing(null)} footer={<>
          <span className="small muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>{editingTotal} of {total} permissions</span>
          <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn primary" onClick={saveAccess}>Save</button>
        </>}>
          {formMsg && <p className="note bad">{formMsg}</p>}
          <section className="reg-section">
            <h3 className="reg-heading">Groups</h3>
            {access.groups.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No groups yet. Make them on the Groups tab.</p> : (
              <div className="chips">
                {access.groups.map((g) => {
                  const on = editing.groupIds.includes(g.id);
                  return (
                    <button key={g.id} type="button" className={`chip${on ? ' selected' : ''}`} aria-pressed={on}
                      onClick={() => setEditing({ ...editing, groupIds: on ? editing.groupIds.filter((x) => x !== g.id) : [...editing.groupIds, g.id] })}>
                      {g.name}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <section className="reg-section">
            <h3 className="reg-heading">Extra permissions <span className="help">(just for {editing.user.displayName})</span></h3>
            <PermissionPicker catalog={access.catalog} on={editing.permissions} via={inherited}
              onChange={(permissions) => setEditing({ ...editing, permissions })} />
          </section>
        </Modal>
      )}

      {group && (
        <Modal wide title={group.id ? `Edit ${group.name || 'group'}` : 'New group'} onClose={() => setGroup(null)} footer={<>
          <span className="small muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>{group.permissions.length} of {total} permissions</span>
          <button className="btn ghost" onClick={() => setGroup(null)}>Cancel</button>
          <button className="btn primary" disabled={!group.name.trim()} onClick={saveGroup}>Save</button>
        </>}>
          {formMsg && <p className="note bad">{formMsg}</p>}
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <Field label="Name"><input value={group.name} autoFocus placeholder="e.g. Door team" onChange={(e) => setGroup({ ...group, name: e.target.value })} /></Field>
            <Field label="Description" help="Optional"><input value={group.description} onChange={(e) => setGroup({ ...group, description: e.target.value })} /></Field>
          </div>
          <PermissionPicker catalog={access.catalog} on={group.permissions} onChange={(permissions) => setGroup({ ...group, permissions })} />
        </Modal>
      )}
    </>
  );
}
