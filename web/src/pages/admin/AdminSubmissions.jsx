import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Empty, Field, Pill } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import { PageSkeleton, RowsSkeleton } from '../../components/Skeleton.jsx';

const FILTERS = [['SUBMITTED', 'To review'], ['ACCEPTED', 'Accepted'], ['DECLINED', 'Declined'], ['WITHDRAWN', 'Withdrawn'], ['', 'All']];
const STATUS = {
  SUBMITTED: <Pill tone="wait">To review</Pill>, ACCEPTED: <Pill tone="go">Accepted</Pill>,
  DECLINED: <Pill tone="stop">Declined</Pill>, WITHDRAWN: <Pill>Withdrawn</Pill>,
};

/// Reviewing panel submissions. Accepting makes an unscheduled draft on
/// the Schedule tab; the submitter hears either way.
export default function AdminSubmissions() {
  const { id } = useParams();
  const [event, setEvent] = useState(null);
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('SUBMITTED');
  const [deciding, setDeciding] = useState(null); // { s, decision, message, reviewNote }
  const [msg, setMsg] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/submissions${status ? `?status=${status}` : ''}`).then(setRows);
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); }, [id]);
  useEffect(() => { setRows(null); load(); /* eslint-disable-next-line */ }, [id, status]);

  const saveNote = async (s, reviewNote) => {
    try { await api.patch(`/api/admin/submissions/${s.id}`, { reviewNote }); } catch (e) { setMsg(e.message); }
  };
  const decide = async () => {
    setMsg('');
    try {
      await api.post(`/api/admin/submissions/${deciding.s.id}/decision`, { decision: deciding.decision, message: deciding.message, reviewNote: deciding.reviewNote });
      setDeciding(null);
      load();
    } catch (e) { setMsg(e.message); }
  };

  if (!event) return <PageSkeleton />;

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Panel submissions</h1>
        </div>
        {event.submissionsOpen
          ? <Link className="btn" to={`/e/${event.slug}/submit`} target="_blank">Submission form ↗</Link>
          : <span className="small muted">Submissions are closed. Owners open them on the Schedule tab.</span>}
      </div>
      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="seg" style={{ marginBottom: 16 }}>
        {FILTERS.map(([v, label]) => <button key={label} aria-current={status === v ? 'true' : undefined} onClick={() => setStatus(v)}>{label}</button>)}
      </div>

      {!rows ? <RowsSkeleton /> : rows.length === 0 ? (
        <Empty title={status === 'SUBMITTED' ? 'Nothing to review' : 'No submissions here'}>New submissions show up under To review.</Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {rows.map((s) => (
            <article key={s.id} className="card stack" style={{ gap: 8 }}>
              <div className="spread" style={{ alignItems: 'flex-start' }}>
                <div>
                  <h2 style={{ margin: 0 }}>{s.title}</h2>
                  <p className="small muted" style={{ margin: '2px 0 0' }}>
                    {s.lengthMinutes} min · {s.hosts || 'No hosts listed'} · from {s.submitter.name}
                    {s.submitter.telegramUsername && ` (@${s.submitter.telegramUsername})`}{s.submitter.email && ` · ${s.submitter.email}`}
                  </p>
                </div>
                {STATUS[s.status]}
              </div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{s.description}</p>
              {s.availability && <p className="small" style={{ margin: 0 }}><strong>Availability:</strong> {s.availability}</p>}
              {s.notes && <p className="small" style={{ margin: 0 }}><strong>Notes for organizers:</strong> {s.notes}</p>}
              <Field label="Review note" help="Staff only, never sent">
                <input defaultValue={s.reviewNote} onBlur={(e) => e.target.value !== s.reviewNote && saveNote(s, e.target.value)} />
              </Field>
              {s.status === 'SUBMITTED' ? (
                <div className="row">
                  <button className="btn sm signal" onClick={() => setDeciding({ s, decision: 'ACCEPTED', message: '', reviewNote: s.reviewNote })}>Accept</button>
                  <button className="btn sm" onClick={() => setDeciding({ s, decision: 'DECLINED', message: '', reviewNote: s.reviewNote })}>Decline</button>
                </div>
              ) : s.decidedAt && (
                <p className="small muted" style={{ margin: 0 }}>
                  {s.status === 'ACCEPTED' ? 'Accepted' : 'Declined'} by {s.decidedBy || 'former staff'} {new Date(s.decidedAt).toLocaleDateString()}
                  {s.sessionId && <> · <Link to={`/admin/events/${id}/schedule`}>On the schedule tab</Link></>}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      {deciding && (
        <Modal title={`${deciding.decision === 'ACCEPTED' ? 'Accept' : 'Decline'} "${deciding.s.title}"?`} onClose={() => setDeciding(null)} footer={<>
          <button className="btn ghost" onClick={() => setDeciding(null)}>Cancel</button>
          <button className={`btn ${deciding.decision === 'ACCEPTED' ? 'signal' : 'danger'}`} onClick={decide}>{deciding.decision === 'ACCEPTED' ? 'Accept' : 'Decline'}</button>
        </>}>
          <p style={{ marginTop: 0 }}>
            {deciding.decision === 'ACCEPTED'
              ? `${deciding.s.submitter.name} gets a message that it was accepted. It goes on the Schedule tab as an unscheduled draft for you to give a time and room.`
              : `${deciding.s.submitter.name} gets a polite "not this time" message.`}
          </p>
          <Field label="Add a personal message" help="Optional, included in what they receive">
            <textarea style={{ minHeight: 80 }} value={deciding.message} onChange={(e) => setDeciding({ ...deciding, message: e.target.value })} />
          </Field>
        </Modal>
      )}
    </>
  );
}
