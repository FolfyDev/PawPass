import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { usePageMeta } from '../../lib/meta.js';
import { Empty, Field, Pill } from '../../components/Bits.jsx';
import Breadcrumbs from '../../components/Breadcrumbs.jsx';
import Modal from '../../components/Modal.jsx';

export const CATEGORY_LABEL = {
  harassment: 'Harassment', safety: 'Safety', medical: 'Medical', property: 'Lost / damaged property', conduct: 'Code of conduct', other: 'Other',
};
export const SeverityPill = ({ severity }) => (
  severity === 'HIGH' ? <Pill tone="stop">High</Pill> : severity === 'MEDIUM' ? <Pill tone="wait">Medium</Pill> : <Pill>Low</Pill>
);
export const StatusPillIncident = ({ status }) => (status === 'OPEN' ? <Pill tone="wait">Open</Pill> : <Pill tone="go">Resolved</Pill>);

const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const blankPerson = (role = 'SUBJECT') => ({ role, registrationCode: '', name: '', contact: '' });

/// People on a report: each linked to a ticket by code, or a name + contact.
export function PeopleEditor({ people, onChange }) {
  const set = (i, patch) => onChange(people.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {people.map((p, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
          <Field label={i === 0 ? 'Role' : ''}>
            <select value={p.role} onChange={(e) => set(i, { role: e.target.value })} style={{ width: 120 }}>
              <option value="SUBJECT">About</option>
              <option value="REPORTER">Reported by</option>
              <option value="WITNESS">Witness</option>
            </select>
          </Field>
          <Field label={i === 0 ? 'Ticket code' : ''}><input className="mono" placeholder="If they have one" value={p.registrationCode} onChange={(e) => set(i, { registrationCode: e.target.value })} style={{ width: 150 }} /></Field>
          <Field label={i === 0 ? 'Name' : ''}><input value={p.name} onChange={(e) => set(i, { name: e.target.value })} style={{ width: 170 }} /></Field>
          <Field label={i === 0 ? 'Contact' : ''}><input placeholder="Email or @telegram" value={p.contact} onChange={(e) => set(i, { contact: e.target.value })} style={{ width: 190 }} /></Field>
          <button type="button" className="btn sm ghost" onClick={() => onChange(people.filter((_, j) => j !== i))} aria-label="Remove person">×</button>
        </div>
      ))}
      <button type="button" className="btn sm" style={{ justifySelf: 'start' }} onClick={() => onChange([...people, blankPerson(people.length ? 'WITNESS' : 'SUBJECT')])}>Add person</button>
    </div>
  );
}

export default function Incidents() {
  usePageMeta({ title: 'Incidents', noindex: true });
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState({ eventId: '', status: 'OPEN', q: '' });
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    return api.get(`/api/admin/incidents${qs ? `?${qs}` : ''}`).then(setData);
  };
  useEffect(() => { api.get('/api/admin/events').then(setEvents).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(load, filter.q ? 250 : 0); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [filter]);

  const startNew = () => {
    setMsg('');
    // Default to the event that's on right now, if there is one.
    const live = events.find((e) => new Date(e.startsAt) <= new Date() && new Date(e.endsAt) >= new Date());
    setDraft({ eventId: filter.eventId || live?.id || '', occurredAt: nowLocal(), location: '', category: 'conduct', severity: 'MEDIUM', summary: '', details: '', people: [blankPerson()] });
  };

  const file = async () => {
    setMsg('');
    setBusy(true);
    try {
      const created = await api.post('/api/admin/incidents', {
        ...draft,
        occurredAt: new Date(draft.occurredAt).toISOString(),
        people: draft.people.filter((p) => p.registrationCode.trim() || p.name.trim() || p.contact.trim()),
      });
      nav(`/admin/incidents/${created.id}`);
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const set = (patch) => setDraft({ ...draft, ...patch });

  return (
    <>
      <Breadcrumbs items={[{ label: 'Admin', to: '/admin' }, { label: 'Incidents' }]} />
      <div className="spread" style={{ marginBottom: 8 }}>
        <div>
          <p className="eyebrow">Safety</p>
          <h1 style={{ margin: 0 }}>Incident reports</h1>
        </div>
        <button className="btn signal" onClick={startNew}>New report</button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Confidential. {data?.canManage ? 'You can see every report.' : 'You can see the reports you filed; owners see all of them.'} Details and the people involved are encrypted.
      </p>

      <div className="filter-row">
        <select value={filter.eventId} onChange={(e) => setFilter({ ...filter, eventId: e.target.value })}>
          <option value="">All events</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
        <div className="seg">
          {[['OPEN', 'Open'], ['RESOLVED', 'Resolved'], ['', 'All']].map(([v, label]) => (
            <button key={label} aria-current={filter.status === v ? 'true' : undefined} onClick={() => setFilter({ ...filter, status: v })}>{label}</button>
          ))}
        </div>
        <input placeholder="Search summaries" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ maxWidth: 240 }} />
      </div>

      {!data ? <p className="muted">Loading…</p> : data.incidents.length === 0 ? (
        <Empty title={filter.status === 'OPEN' ? 'No open reports' : 'No reports'}>Use New report to write one down while it's fresh.</Empty>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Summary</th><th>About</th><th>Severity</th><th>Status</th><th>Filed by</th></tr></thead>
            <tbody>
              {data.incidents.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => nav(`/admin/incidents/${i.id}`)}>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(i.occurredAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td>
                    <Link to={`/admin/incidents/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.summary}</Link>
                    <div className="small muted">{CATEGORY_LABEL[i.category]}{i.event ? ` · ${i.event.title}` : ''}{i.location ? ` · ${i.location}` : ''}</div>
                  </td>
                  <td className="small">{i.subjects.join(', ') || <span className="muted">-</span>}</td>
                  <td><SeverityPill severity={i.severity} /></td>
                  <td><StatusPillIncident status={i.status} /></td>
                  <td className="small muted">{i.filedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && (
        <Modal wide title="New incident report" onClose={() => setDraft(null)} footer={<>
          <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
          <button className="btn signal" disabled={busy || !draft.summary.trim()} onClick={file}>{busy ? 'Filing…' : 'File report'}</button>
        </>}>
          {msg && <p className="note bad">{msg}</p>}
          <div className="stack">
            <Field label="Summary" help="One line, shown in the list">
              <input autoFocus placeholder="e.g. Unwanted contact in the dealers den" value={draft.summary} onChange={(e) => set({ summary: e.target.value })} />
            </Field>
            <div className="grid-2">
              <Field label="Event">
                <select value={draft.eventId} onChange={(e) => set({ eventId: e.target.value })}>
                  <option value="">Not tied to an event</option>
                  {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
                </select>
              </Field>
              <Field label="When it happened"><input type="datetime-local" value={draft.occurredAt} onChange={(e) => set({ occurredAt: e.target.value })} /></Field>
              <Field label="Where" help="Optional"><input value={draft.location} onChange={(e) => set({ location: e.target.value })} /></Field>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <Field label="Category">
                  <select value={draft.category} onChange={(e) => set({ category: e.target.value })}>
                    {Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                <Field label="Severity">
                  <select value={draft.severity} onChange={(e) => set({ severity: e.target.value })}>
                    <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
                  </select>
                </Field>
              </div>
            </div>
            <Field label="What happened" help="Facts as reported; who said what">
              <textarea style={{ minHeight: 140 }} value={draft.details} onChange={(e) => set({ details: e.target.value })} />
            </Field>
            <div>
              <p className="eyebrow" style={{ marginBottom: 6 }}>People involved</p>
              <PeopleEditor people={draft.people} onChange={(people) => set({ people })} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
