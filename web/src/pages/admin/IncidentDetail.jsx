import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { usePageMeta } from '../../lib/meta.js';
import { Field, Pill } from '../../components/Bits.jsx';
import Breadcrumbs from '../../components/Breadcrumbs.jsx';
import Modal from '../../components/Modal.jsx';
import { CATEGORY_LABEL, SeverityPill, StatusPillIncident, PeopleEditor } from './Incidents.jsx';

const ROLE_LABEL = { SUBJECT: 'About', REPORTER: 'Reported by', WITNESS: 'Witness' };
const toLocal = (d) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};
const when = (d) => new Date(d).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function IncidentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [inc, setInc] = useState(null);
  const [missing, setMissing] = useState(false);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(null);
  const [banning, setBanning] = useState(null);
  const [resolution, setResolution] = useState('');
  usePageMeta({ title: inc ? `Incident: ${inc.summary}` : 'Incident', noindex: true });

  const take = (i) => { setInc(i); setResolution(i.resolution); };
  useEffect(() => { api.get(`/api/admin/incidents/${id}`).then(take).catch(() => setMissing(true)); }, [id]);

  const run = async (fn) => {
    setMsg('');
    try { take(await fn()); return true; } catch (e) { setMsg(e.message); return false; }
  };

  if (missing) return <p className="note bad" style={{ marginTop: 40 }}>This report doesn't exist, or you can't see it. <Link to="/admin/incidents">Back to reports</Link></p>;
  if (!inc) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  const open = inc.status === 'OPEN';
  const canEdit = inc.canManage || open;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Admin', to: '/admin' }, { label: 'Incidents', to: '/admin/incidents' }, { label: inc.summary }]} />
      <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <p className="eyebrow">{CATEGORY_LABEL[inc.category]}{inc.event ? ` · ${inc.event.title}` : ''}</p>
          <h1 style={{ margin: '0 0 6px' }}>{inc.summary}</h1>
          <p className="row small muted" style={{ margin: 0, gap: 8 }}>
            <SeverityPill severity={inc.severity} /> <StatusPillIncident status={inc.status} />
            <span>{when(inc.occurredAt)}{inc.location ? ` · ${inc.location}` : ''}</span>
            <span>· Filed by {inc.filedBy?.displayName || 'former staff'} {when(inc.createdAt)}</span>
          </p>
        </div>
        <div className="row">
          {canEdit && <button className="btn sm" onClick={() => setEditing({ summary: inc.summary, occurredAt: toLocal(inc.occurredAt), location: inc.location || '', category: inc.category, severity: inc.severity, details: inc.details })}>Edit</button>}
          {inc.canManage && (
            <button className="btn sm danger" onClick={async () => {
              if (!confirm('Delete this report for good? Bans made from it stay in place.')) return;
              try { await api.del(`/api/admin/incidents/${id}`); nav('/admin/incidents'); } catch (e) { setMsg(e.message); }
            }}>Delete</button>
          )}
        </div>
      </div>

      {msg && <p className="note bad">{msg}</p>}

      <div className="grid-2" style={{ alignItems: 'start', gap: 20 }}>
        <div className="stack" style={{ gap: 20 }}>
          <section className="card stack">
            <h2 style={{ margin: 0 }}>What happened</h2>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{inc.details || <span className="muted">No details written down.</span>}</p>
          </section>

          <section className="card stack">
            <h2 style={{ margin: 0 }}>Follow-ups</h2>
            {inc.notes.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing yet.</p>}
            {inc.notes.map((n) => (
              <div key={n.id} style={{ borderLeft: '3px solid var(--rule)', paddingLeft: 12 }}>
                <p className="small muted" style={{ margin: 0 }}>{n.author} · {when(n.createdAt)}</p>
                <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{n.body}</p>
              </div>
            ))}
            <textarea placeholder="Add a follow-up: who you spoke to, what was decided…" value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 80 }} />
            <button className="btn sm primary" style={{ justifySelf: 'start' }} disabled={!note.trim()} onClick={async () => {
              if (await run(() => api.post(`/api/admin/incidents/${id}/notes`, { body: note }))) setNote('');
            }}>Add note</button>
          </section>

          {inc.canManage && (
            <section className="card stack">
              <h2 style={{ margin: 0 }}>Outcome</h2>
              <textarea placeholder="What was decided and done" value={resolution} onChange={(e) => setResolution(e.target.value)} style={{ minHeight: 80 }} />
              <div className="row">
                <button className="btn sm" disabled={resolution === inc.resolution} onClick={() => run(() => api.patch(`/api/admin/incidents/${id}`, { resolution }))}>Save outcome</button>
                {open
                  ? <button className="btn sm signal" onClick={() => run(() => api.patch(`/api/admin/incidents/${id}`, { resolution, status: 'RESOLVED' }))}>Mark resolved</button>
                  : <button className="btn sm ghost" onClick={() => run(() => api.patch(`/api/admin/incidents/${id}`, { status: 'OPEN' }))}>Reopen</button>}
              </div>
              {inc.resolvedAt && <p className="small muted" style={{ margin: 0 }}>Resolved {when(inc.resolvedAt)}</p>}
            </section>
          )}
          {!inc.canManage && inc.resolution && (
            <section className="card stack"><h2 style={{ margin: 0 }}>Outcome</h2><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{inc.resolution}</p></section>
          )}
        </div>

        <section className="card stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>People involved</h2>
            {canEdit && <button className="btn sm" onClick={() => setAdding([{ role: 'WITNESS', registrationCode: '', name: '', contact: '' }])}>Add person</button>}
          </div>
          {inc.people.length === 0 && <p className="small muted" style={{ margin: 0 }}>No one recorded.</p>}
          {inc.people.map((p) => (
            <div key={p.id} className="stack" style={{ gap: 4, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
              <div className="spread">
                <span><strong>{p.name || 'Unnamed'}</strong> <span className="small muted">· {ROLE_LABEL[p.role]}</span></span>
                {p.banned && <Pill tone="stop">Banned</Pill>}
              </div>
              {p.ticket && (
                <p className="small muted" style={{ margin: 0 }}>
                  Ticket <span className="mono">{p.ticket.code}</span>{p.ticket.legalName ? ` · ${p.ticket.legalName}` : ''}
                  {p.ticket.email ? ` · ${p.ticket.email}` : ''}{p.ticket.telegramUsername ? ` · @${p.ticket.telegramUsername}` : ''}
                </p>
              )}
              {p.contact && <p className="small muted" style={{ margin: 0 }}>{p.contact}</p>}
              {inc.canManage && (
                <div className="row" style={{ gap: 6 }}>
                  {p.role === 'SUBJECT' && !p.banned && (
                    <button className="btn sm danger" onClick={() => setBanning({ person: p, reason: `Incident: ${inc.summary}` })}>Ban this person</button>
                  )}
                  <button className="btn sm ghost" onClick={() => confirm(`Remove ${p.name || 'this person'} from the report?`) && run(() => api.del(`/api/admin/incidents/${id}/people/${p.id}`))}>Remove</button>
                </div>
              )}
            </div>
          ))}
          {inc.bans.length > 0 && (
            <p className="small muted" style={{ margin: 0 }}>
              {inc.bans.length} ban{inc.bans.length === 1 ? '' : 's'} came from this report. <Link to="/admin/bans">See bans</Link>
            </p>
          )}
        </section>
      </div>

      {editing && (
        <Modal wide title="Edit report" onClose={() => setEditing(null)} footer={<>
          <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            if (await run(() => api.patch(`/api/admin/incidents/${id}`, { ...editing, occurredAt: new Date(editing.occurredAt).toISOString() }))) setEditing(null);
          }}>Save</button>
        </>}>
          <div className="stack">
            <Field label="Summary"><input value={editing.summary} onChange={(e) => setEditing({ ...editing, summary: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="When it happened"><input type="datetime-local" value={editing.occurredAt} onChange={(e) => setEditing({ ...editing, occurredAt: e.target.value })} /></Field>
              <Field label="Where"><input value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field>
              <Field label="Category">
                <select value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                  {Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Severity">
                <select value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value })}>
                  <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
                </select>
              </Field>
            </div>
            <Field label="What happened"><textarea style={{ minHeight: 160 }} value={editing.details} onChange={(e) => setEditing({ ...editing, details: e.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {adding && (
        <Modal wide title="Add people" onClose={() => setAdding(null)} footer={<>
          <button className="btn ghost" onClick={() => setAdding(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            for (const p of adding.filter((x) => x.registrationCode.trim() || x.name.trim() || x.contact.trim())) {
              if (!(await run(() => api.post(`/api/admin/incidents/${id}/people`, p)))) return;
            }
            setAdding(null);
          }}>Add</button>
        </>}>
          <PeopleEditor people={adding} onChange={setAdding} />
        </Modal>
      )}

      {banning && (
        <Modal title={`Ban ${banning.person.name || 'this person'}?`} onClose={() => setBanning(null)} footer={<>
          <button className="btn ghost" onClick={() => setBanning(null)}>Cancel</button>
          <button className="btn danger" onClick={async () => {
            if (await run(() => api.post(`/api/admin/incidents/${id}/people/${banning.person.id}/ban`, { reason: banning.reason }))) setBanning(null);
          }}>Ban</button>
        </>}>
          <p style={{ marginTop: 0 }}>
            They won't be able to register for any event, volunteer, or request a hotel room.
            {banning.person.ticket
              ? ' The ban uses the legal name, email, and Telegram from their ticket.'
              : ' The ban uses the name and contact written on this report, so check they\'re right.'}
          </p>
          <Field label="Reason" help="Shown on the Bans page"><input value={banning.reason} onChange={(e) => setBanning({ ...banning, reason: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}
