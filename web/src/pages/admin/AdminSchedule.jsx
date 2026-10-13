import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Empty, Field, Pill, fmtNight } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import { localInZone } from '../../lib/tz.js';
import { PageSkeleton } from '../../components/Skeleton.jsx';

const timeIn = (d, tz) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
const dayOf = (d, tz) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
const BLANK = { title: '', hosts: '', track: '', roomId: '', startsAt: '', endsAt: '', description: '', published: false };

function SessionForm({ value, onChange, rooms }) {
  const set = (patch) => onChange({ ...value, ...patch });
  // A new start keeps the length the session had, or defaults to an hour.
  const setStart = (startsAt) => {
    const len = value.startsAt && value.endsAt ? new Date(value.endsAt) - new Date(value.startsAt) : 3600_000;
    const end = startsAt ? localInZone(new Date(new Date(`${startsAt}Z`).getTime() + len), 'UTC') : '';
    set({ startsAt, endsAt: startsAt ? end : '' });
  };
  return (
    <div className="stack">
      <Field label="Title"><input value={value.title} onChange={(e) => set({ title: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Hosts" help="As shown publicly"><input value={value.hosts} onChange={(e) => set({ hosts: e.target.value })} /></Field>
        <Field label="Track" help="Optional, e.g. Art, Music, 18+"><input value={value.track} onChange={(e) => set({ track: e.target.value })} /></Field>
        <Field label="Room">
          <select value={value.roomId} onChange={(e) => set({ roomId: e.target.value })}>
            <option value="">No room yet</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity})` : ''}</option>)}
          </select>
        </Field>
        <div />
        <Field label="Starts" help="Blank = unscheduled"><input type="datetime-local" value={value.startsAt} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Ends"><input type="datetime-local" value={value.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></Field>
      </div>
      <Field label="Description"><textarea style={{ minHeight: 100 }} value={value.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <label className="row"><input type="checkbox" checked={value.published} onChange={(e) => set({ published: e.target.checked })} /> Published (shows on the public schedule once it has a time)</label>
    </div>
  );
}

function Rooms({ eventId, rooms, onChange, setMsg }) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const add = async (e) => {
    e.preventDefault();
    setMsg('');
    try { await api.post(`/api/admin/events/${eventId}/rooms`, { name, capacity }); setName(''); setCapacity(''); onChange(); }
    catch (err) { setMsg(err.message); }
  };
  const update = async (r, patch) => { try { await api.patch(`/api/admin/rooms/${r.id}`, patch); onChange(); } catch (err) { setMsg(err.message); } };
  const remove = async (r) => {
    if (!confirm(`Delete ${r.name}? Sessions in it stay on the schedule without a room.`)) return;
    try { await api.del(`/api/admin/rooms/${r.id}`); onChange(); } catch (err) { setMsg(err.message); }
  };
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Rooms</h2>
      {rooms.length === 0 && <p className="small muted" style={{ margin: 0 }}>Add the rooms and spaces sessions happen in.</p>}
      {rooms.map((r) => (
        <div key={r.id} className="row">
          <input defaultValue={r.name} onBlur={(e) => e.target.value.trim() && e.target.value !== r.name && update(r, { name: e.target.value })} style={{ flex: 1, minWidth: 140 }} aria-label="Room name" />
          <input type="number" min="1" placeholder="Capacity" defaultValue={r.capacity ?? ''} onBlur={(e) => String(r.capacity ?? '') !== e.target.value && update(r, { capacity: e.target.value })} style={{ width: 110 }} aria-label="Capacity" />
          <button className="btn sm ghost" onClick={() => remove(r)}>Delete</button>
        </div>
      ))}
      <form className="row" onSubmit={add}>
        <input placeholder="e.g. Main Stage" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <input type="number" min="1" placeholder="Capacity" value={capacity} onChange={(e) => setCapacity(e.target.value)} style={{ width: 110 }} />
        <button className="btn sm" disabled={!name.trim()}>Add room</button>
      </form>
    </div>
  );
}

export default function AdminSchedule() {
  const { id } = useParams();
  const { can } = useSession();
  const canPublish = can('schedule.publish');
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [day, setDay] = useState(null);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const [formMsg, setFormMsg] = useState('');
  const [note, setNote] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/schedule`).then((d) => {
    setData(d);
    setDay((cur) => cur || d.days[0] || 'unscheduled');
    setSettings((s) => s || {
      scheduleEnabled: d.enabled, submissionsOpen: d.submissions.open,
      submissionsCloseAt: localInZone(d.submissions.closesAt, d.timezone), submissionInfo: d.submissions.info,
    });
  });
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);

  if (!event || !data || !settings) return <PageSkeleton />;
  const tz = data.timezone;

  const saveSettings = async () => {
    setMsg(''); setNote('');
    try { await api.patch(`/api/admin/events/${id}`, settings); setNote('Saved.'); } catch (e) { setMsg(e.message); }
  };
  const openNew = () => {
    setFormMsg('');
    const start = day && day !== 'unscheduled' ? `${day}T10:00` : '';
    setEditing({ id: null, draft: { ...BLANK, startsAt: start, endsAt: start ? `${day}T11:00` : '' } });
  };
  const openEdit = (s) => {
    setFormMsg('');
    setEditing({ id: s.id, draft: {
      title: s.title, hosts: s.hosts, track: s.track || '', roomId: s.roomId || '', description: s.description, published: s.published,
      startsAt: localInZone(s.startsAt, tz), endsAt: localInZone(s.endsAt, tz),
    } });
  };
  const save = async () => {
    setFormMsg('');
    try {
      if (editing.id) await api.patch(`/api/admin/sessions/${editing.id}`, editing.draft);
      else await api.post(`/api/admin/events/${id}/sessions`, editing.draft);
      setEditing(null);
      load();
    } catch (e) { setFormMsg(e.message); }
  };
  const remove = async () => {
    if (!confirm('Delete this session? Anyone who starred it loses it from their schedule.')) return;
    try { await api.del(`/api/admin/sessions/${editing.id}`); setEditing(null); load(); } catch (e) { setFormMsg(e.message); }
  };
  const togglePublished = async (s) => {
    try { await api.patch(`/api/admin/sessions/${s.id}`, { published: !s.published }); load(); } catch (e) { setMsg(e.message); }
  };

  const unscheduled = data.sessions.filter((s) => !s.startsAt);
  const shown = day === 'unscheduled' ? unscheduled : data.sessions.filter((s) => s.startsAt && dayOf(s.startsAt, tz) === day);
  const outside = data.sessions.filter((s) => s.startsAt && !data.days.includes(dayOf(s.startsAt, tz)));

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Schedule</h1>
        </div>
        <div className="row">
          {event.scheduleEnabled && <Link className="btn" to={`/e/${event.slug}/schedule`} target="_blank">Public schedule ↗</Link>}
          <a className="btn" href={`${api.base}/api/admin/events/${id}/schedule.csv`}>Export CSV</a>
        </div>
      </div>
      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="grid-2" style={{ alignItems: 'start', marginBottom: 20 }}>
        <div className="card">
          <fieldset disabled={!canPublish} className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
            <label className="row"><input type="checkbox" checked={settings.scheduleEnabled} onChange={(e) => setSettings({ ...settings, scheduleEnabled: e.target.checked })} /> Show the schedule publicly</label>
            <label className="row"><input type="checkbox" checked={settings.submissionsOpen} onChange={(e) => setSettings({ ...settings, submissionsOpen: e.target.checked })} /> Take panel submissions</label>
            {settings.submissionsOpen && <>
              <Field label="Submissions close" help={`Optional, ${tz}`}>
                <input type="datetime-local" value={settings.submissionsCloseAt} onChange={(e) => setSettings({ ...settings, submissionsCloseAt: e.target.value })} />
              </Field>
              <Field label="Guidelines for submitters" help="Shown above the form">
                <textarea style={{ minHeight: 80 }} value={settings.submissionInfo} onChange={(e) => setSettings({ ...settings, submissionInfo: e.target.value })} />
              </Field>
            </>}
            {canPublish
              ? <div className="row"><button className="btn primary sm" onClick={saveSettings}>Save</button>{note && <span className="small muted">{note}</span>}</div>
              : <p className="small muted" style={{ margin: 0 }}>Turning these on needs the Publish the schedule permission. You can build the schedule and review submissions.</p>}
            {event.submissionsOpen && <Link className="small" to={`/e/${event.slug}/submit`} target="_blank">The submission form ↗</Link>}
          </fieldset>
        </div>
        <Rooms eventId={id} rooms={data.rooms} onChange={load} setMsg={setMsg} />
      </div>

      {outside.length > 0 && (
        <p className="note" style={{ marginBottom: 14 }}>
          {outside.length} session{outside.length === 1 ? ' is' : 's are'} outside the event's dates: {outside.map((s) => s.title).join(', ')}.
        </p>
      )}

      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="seg" role="tablist">
          {data.days.map((d) => (
            <button key={d} aria-current={day === d ? 'true' : undefined} onClick={() => setDay(d)}>{fmtNight(d)}</button>
          ))}
          <button aria-current={day === 'unscheduled' ? 'true' : undefined} onClick={() => setDay('unscheduled')}>Unscheduled ({unscheduled.length})</button>
        </div>
        <button className="btn primary" onClick={openNew}>Add session</button>
      </div>

      {shown.length === 0 ? (
        <Empty title={day === 'unscheduled' ? 'Nothing waiting for a slot' : 'Nothing on this day yet'}>
          {day === 'unscheduled' ? 'Accepted panels land here until they get a time.' : 'Use Add session, or give an unscheduled one a time.'}
        </Empty>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr><th>Time</th><th>Session</th><th>Room</th><th title="Attendees who starred it">★</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{s.startsAt ? `${timeIn(s.startsAt, tz)} – ${timeIn(s.endsAt, tz)}` : <span className="muted">No time</span>}</td>
                  <td>
                    <strong>{s.title}</strong>
                    <div className="small muted">{[s.hosts, s.track].filter(Boolean).join(' · ')}{s.submissionId ? ' · from a submission' : ''}</div>
                  </td>
                  <td className="small">{s.room?.name || <span className="muted">-</span>}</td>
                  <td className="small">{s.stars}</td>
                  <td>
                    <button className="btn sm ghost" onClick={() => togglePublished(s)} title={s.published ? 'Unpublish' : 'Publish'}>
                      {s.published ? <Pill tone="go">Published</Pill> : <Pill>Draft</Pill>}
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => openEdit(s)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal wide title={editing.id ? 'Edit session' : 'Add session'} onClose={() => setEditing(null)} footer={<>
          {editing.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>Delete</button>}
          <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </>}>
          {formMsg && <p className="note bad">{formMsg}</p>}
          <p className="small muted" style={{ marginTop: 0 }}>Times are in the event's timezone ({tz}).</p>
          <SessionForm value={editing.draft} rooms={data.rooms} onChange={(draft) => setEditing({ ...editing, draft })} />
        </Modal>
      )}
    </>
  );
}
