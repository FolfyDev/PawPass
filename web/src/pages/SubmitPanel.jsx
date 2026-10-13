import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import { Field, Pill } from '../components/Bits.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import { PageSkeleton } from '../components/Skeleton.jsx';

const LENGTHS = [30, 45, 60, 90, 120];
const BLANK = { title: '', description: '', hosts: '', lengthMinutes: 60, availability: '', notes: '' };
const STATUS = {
  SUBMITTED: <Pill tone="wait">Waiting on a decision</Pill>,
  ACCEPTED: <Pill tone="go">Accepted</Pill>,
  DECLINED: <Pill tone="stop">Not this time</Pill>,
  WITHDRAWN: <Pill>Withdrawn</Pill>,
};

function PanelForm({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <Field label="Title"><input value={value.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} /></Field>
      <Field label="Description" help="As it would appear on the schedule">
        <textarea style={{ minHeight: 110 }} maxLength={3000} value={value.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="grid-2">
        <Field label="Hosts" help="Names as they should appear">
          <input value={value.hosts} placeholder="You and any co-hosts" onChange={(e) => set({ hosts: e.target.value })} />
        </Field>
        <Field label="Length">
          <select value={value.lengthMinutes} onChange={(e) => set({ lengthMinutes: Number(e.target.value) })}>
            {LENGTHS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
          </select>
        </Field>
      </div>
      <Field label="When can you do it?" help="Optional, e.g. Saturday afternoon, not before noon">
        <input value={value.availability} onChange={(e) => set({ availability: e.target.value })} />
      </Field>
      <Field label="Notes for the organizers" help="Optional, never public: equipment, accessibility, content notes">
        <textarea style={{ minHeight: 70 }} maxLength={3000} value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}

export default function SubmitPanel() {
  const { slug } = useParams();
  const { user } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(BLANK);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  usePageMeta({ title: data ? `Submit a panel · ${data.title}` : 'Submit a panel' });

  const load = () => api.get(`/api/events/${slug}/submissions`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [slug, user]);

  if (error) return <p className="note bad" style={{ marginTop: 40 }}>{error} <Link to={`/e/${slug}`}>Back to the event</Link></p>;
  if (!data) return <PageSkeleton crumbs />;

  const submit = async (e) => {
    e.preventDefault();
    setMsg('');
    setBusy(true);
    try {
      await api.post(`/api/events/${slug}/submissions`, draft);
      setDraft(BLANK);
      setMsg('Submitted! You\'ll hear back by message once the organizers decide.');
      load();
    } catch (err) { setMsg(err.message); } finally { setBusy(false); }
  };
  const saveEdit = async () => {
    setMsg('');
    try { await api.patch(`/api/my/submissions/${editing.id}`, editing.draft); setEditing(null); load(); }
    catch (err) { setMsg(err.message); }
  };
  const withdraw = async (s) => {
    if (!confirm(`Withdraw "${s.title}"?`)) return;
    try { await api.post(`/api/my/submissions/${s.id}/withdraw`); load(); } catch (err) { setMsg(err.message); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <header style={{ padding: '40px 0 16px' }}>
        <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: data.title, to: `/e/${slug}` }, { label: 'Submit a panel' }]} />
        <p className="eyebrow">{data.title}</p>
        <h1 style={{ margin: 0 }}>Submit a panel</h1>
        {data.closesAt && (
          <p className="small muted">
            {data.accepting ? 'Submissions close' : 'Submissions closed'} {new Date(data.closesAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: data.timezone })}.
          </p>
        )}
      </header>

      {data.info && <div className="card" style={{ marginBottom: 20 }}><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{data.info}</p></div>}
      {msg && <p className="note" style={{ marginBottom: 16 }}>{msg}</p>}

      {data.mine.length > 0 && (
        <section className="stack" style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Your submissions</h2>
          {data.mine.map((s) => (
            <div key={s.id} className="card stack" style={{ gap: 6 }}>
              <div className="spread">
                <strong>{s.title}</strong>
                {STATUS[s.status]}
              </div>
              <p className="small muted" style={{ margin: 0 }}>{s.lengthMinutes} minutes{s.hosts ? ` · ${s.hosts}` : ''}</p>
              {s.status === 'SUBMITTED' && (
                <div className="row">
                  <button className="btn sm" onClick={() => setEditing({ id: s.id, draft: { title: s.title, description: s.description, hosts: s.hosts, lengthMinutes: s.lengthMinutes, availability: s.availability, notes: s.notes } })}>Edit</button>
                  <button className="btn sm ghost" onClick={() => withdraw(s)}>Withdraw</button>
                </div>
              )}
              {editing?.id === s.id && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <PanelForm value={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} />
                  <div className="row"><button className="btn primary sm" onClick={saveEdit}>Save changes</button><button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button></div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {!data.accepting ? (
        <p className="note">Panel submissions are closed for this event.</p>
      ) : !user ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>Sign in to submit a panel, so the organizers can reach you about it.</p>
          <Link className="btn primary" to="/login" style={{ justifySelf: 'start' }}>Sign in</Link>
        </div>
      ) : (
        <form className="card stack" onSubmit={submit}>
          <h2 style={{ margin: 0 }}>{data.mine.length ? 'Submit another' : 'Your panel'}</h2>
          <PanelForm value={draft} onChange={setDraft} />
          <button className="btn signal" style={{ justifySelf: 'start' }} disabled={busy || !draft.title.trim()}>{busy ? 'Submitting…' : 'Submit panel'}</button>
        </form>
      )}
    </div>
  );
}
