import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Empty, Field, Pill, fmtTimeRange, fmtHours } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import { localInZone } from '../../lib/tz.js';
import { PageSkeleton } from '../../components/Skeleton.jsx';

const BLANK = { role: '', location: '', startsAt: '', endsAt: '', slots: 2, description: '' };

const ATTENDANCE = [
  ['PENDING', 'Not yet'],
  ['PRESENT', 'Present'],
  ['NO_SHOW', 'No-show'],
];

function ShiftForm({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Role"><input placeholder="e.g. Door crew" value={value.role} onChange={(e) => set({ role: e.target.value })} /></Field>
        <Field label="Where" help="Optional"><input placeholder="e.g. Main entrance" value={value.location} onChange={(e) => set({ location: e.target.value })} /></Field>
        <Field label="Starts"><input type="datetime-local" value={value.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></Field>
        <Field label="Ends"><input type="datetime-local" value={value.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></Field>
        <Field label="People needed"><input type="number" min="1" value={value.slots} onChange={(e) => set({ slots: e.target.value })} /></Field>
      </div>
      <Field label="What it involves" help="Optional, shown to volunteers">
        <textarea style={{ minHeight: 70 }} value={value.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
    </div>
  );
}

function Roster({ shift, onChange, setMsg }) {
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setMsg('');
    setBusy(true);
    try { await api.post(`/api/admin/shifts/${shift.id}/signups`, { who }); setWho(''); onChange(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const mark = async (s, attendance) => {
    setMsg('');
    try { await api.patch(`/api/admin/volunteer-signups/${s.id}`, { attendance }); onChange(); }
    catch (e) { setMsg(e.message); }
  };

  const remove = async (s) => {
    if (!confirm(`Take ${s.volunteer.name} off this shift? They'll get a Telegram message if they use the bot.`)) return;
    setMsg('');
    try { await api.del(`/api/admin/volunteer-signups/${s.id}`); onChange(); }
    catch (e) { setMsg(e.message); }
  };

  return (
    <>
      {shift.signups.length === 0
        ? <p className="small muted" style={{ margin: 0 }}>Nobody yet.</p>
        : (
          <div style={{ overflow: 'auto' }}>
            <table>
              <thead><tr><th>Volunteer</th><th>Contact</th><th>Note</th><th>Attendance</th><th /></tr></thead>
              <tbody>
                {shift.signups.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.volunteer.name}
                      {s.volunteer.legalName && s.volunteer.legalName !== s.volunteer.name && <div className="small muted">{s.volunteer.legalName}</div>}
                    </td>
                    <td className="small muted">
                      {s.volunteer.email}
                      {s.volunteer.telegramUsername && <>{s.volunteer.email && <br />}@{s.volunteer.telegramUsername}</>}
                    </td>
                    <td className="small muted">{s.note || '-'}</td>
                    <td>
                      <div className="segmented">
                        {ATTENDANCE.map(([v, label]) => (
                          <button key={v} type="button" className={s.attendance === v ? 'selected' : ''} onClick={() => s.attendance !== v && mark(s, v)}>{label}</button>
                        ))}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}><button className="btn sm danger" onClick={() => remove(s)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <div className="row">
        <input placeholder="Ticket code or @telegram" value={who} onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && who.trim() && add()} style={{ flex: 1, maxWidth: 280 }} />
        <button className="btn sm" disabled={!who.trim() || busy} onClick={add}>Add volunteer</button>
      </div>
    </>
  );
}

export default function Volunteers() {
  const { id } = useParams();
  const { can } = useSession();
  const canSetUp = can('volunteers.shifts');
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [adding, setAdding] = useState(BLANK);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/volunteers`).then((d) => {
    setData(d);
    setSettings((s) => s || { volunteersEnabled: d.enabled, volunteerInfo: d.info });
  });
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);

  const tz = event?.timezone;

  const saveSettings = async () => {
    setMsg(''); setNote('');
    try { await api.patch(`/api/admin/events/${id}`, settings); setNote('Saved.'); load(); }
    catch (e) { setMsg(e.message); }
  };

  const createShift = async () => {
    setMsg(''); setNote('');
    try { await api.post(`/api/admin/events/${id}/shifts`, adding); setAdding({ ...BLANK, role: adding.role, location: adding.location }); load(); }
    catch (e) { setMsg(e.message); }
  };

  const saveShift = async () => {
    setMsg('');
    try { await api.patch(`/api/admin/shifts/${editing.id}`, editing.draft); setEditing(null); load(); }
    catch (e) { setMsg(e.message); }
  };

  const deleteShift = async (s) => {
    if (!confirm(`Delete the ${s.role} shift?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/shifts/${s.id}`); load(); }
    catch (e) { setMsg(e.message); }
  };

  // Next block of time for the same role: starts when this one ends, same length.
  const duplicate = (s) => {
    const length = new Date(s.endsAt) - new Date(s.startsAt);
    setAdding({
      role: s.role, location: s.location || '', description: s.description, slots: s.slots,
      startsAt: localInZone(s.endsAt, tz), endsAt: localInZone(new Date(new Date(s.endsAt).getTime() + length), tz),
    });
    document.getElementById('add-shift')?.scrollIntoView({ behavior: 'smooth' });
  };

  if (!event || !data || !settings) return <PageSkeleton />;

  const filled = data.shifts.reduce((n, s) => n + s.filledCount, 0);
  const slots = data.shifts.reduce((n, s) => n + s.slots, 0);
  const worked = data.volunteers.reduce((n, v) => n + v.hoursWorked, 0);

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Volunteers</h1>
        </div>
        <a className="btn" href={`${api.base}/api/admin/events/${id}/volunteers.csv`}>Export CSV</a>
      </div>

      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="card" style={{ marginBottom: 24 }}>
      <fieldset disabled={!canSetUp} className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
        <label className="row">
          <input type="checkbox" checked={settings.volunteersEnabled} onChange={(e) => setSettings({ ...settings, volunteersEnabled: e.target.checked })} />
          <span>Let people sign up for shifts on the event page</span>
        </label>
        <Field label="Instructions for volunteers" help="Where to report, what to wear, who to ask for">
          <textarea style={{ minHeight: 80 }} value={settings.volunteerInfo} onChange={(e) => setSettings({ ...settings, volunteerInfo: e.target.value })} />
        </Field>
        {canSetUp && (
          <div className="row">
            <button className="btn primary" onClick={saveSettings}>Save</button>
            {note && <span className="small muted">{note}</span>}
          </div>
        )}
        {!canSetUp && <p className="small muted" style={{ margin: 0 }}>Changing these and setting up shifts needs the Volunteer shifts permission. You can add and remove volunteers and mark attendance.</p>}
      </fieldset>
      </div>

      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="card stat-tile"><p className="eyebrow" style={{ margin: 0 }}>Shifts</p><p className="value">{data.shifts.length}</p></div>
        <div className="card stat-tile">
          <p className="eyebrow" style={{ margin: 0 }}>Slots filled</p>
          <p className="value">{filled} / {slots}</p>
        </div>
        <div className="card stat-tile"><p className="eyebrow" style={{ margin: 0 }}>Volunteers</p><p className="value">{data.volunteers.length}</p></div>
        <div className="card stat-tile"><p className="eyebrow" style={{ margin: 0 }}>Hours worked</p><p className="value">{fmtHours(worked)}</p></div>
      </div>

      {data.shifts.length === 0 && <Empty title="No shifts yet">{canSetUp ? 'Add the first one below.' : 'Someone with the Volunteer shifts permission can set them up.'}</Empty>}
      <div className="stack" style={{ gap: 16, marginBottom: 24 }}>
        {data.shifts.map((s) => (
          <div key={s.id} className="card stack">
            <div className="spread" style={{ alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0 }}>{s.role}</h2>
                <p className="small muted" style={{ margin: '2px 0 0' }}>
                  {fmtTimeRange(s.startsAt, s.endsAt, tz)} · {fmtHours(s.hours)}{s.location ? ` · ${s.location}` : ''}
                </p>
                {s.description && <p className="small" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{s.description}</p>}
              </div>
              <div className="row">
                <Pill tone={s.remaining === 0 ? 'go' : 'wait'}>{s.filledCount} / {s.slots}</Pill>
                {canSetUp && <>
                  <button className="btn sm" onClick={() => duplicate(s)}>Next block</button>
                  <button className="btn sm" onClick={() => setEditing({
                    id: s.id,
                    draft: { role: s.role, location: s.location || '', description: s.description, slots: s.slots, startsAt: localInZone(s.startsAt, tz), endsAt: localInZone(s.endsAt, tz) },
                  })}>Edit</button>
                  <button className="btn sm danger" disabled={s.filledCount > 0} title={s.filledCount > 0 ? 'Remove the volunteers first' : undefined} onClick={() => deleteShift(s)}>Delete</button>
                </>}
              </div>
            </div>
            <Roster shift={s} onChange={load} setMsg={setMsg} />
          </div>
        ))}
      </div>

      {canSetUp && (
        <div id="add-shift" className="card stack" style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Add a shift</h2>
          <p className="small muted" style={{ margin: 0 }}>Times are in the event's timezone ({tz}).</p>
          <ShiftForm value={adding} onChange={setAdding} />
          <button className="btn primary" style={{ justifySelf: 'start' }} onClick={createShift}>Add shift</button>
        </div>
      )}

      {data.volunteers.length > 0 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Hours by volunteer</h2>
          <div style={{ overflow: 'auto' }}>
            <table>
              <thead><tr><th>Volunteer</th><th>Contact</th><th>Shifts</th><th>Scheduled</th><th>Worked</th><th>No-shows</th></tr></thead>
              <tbody>
                {data.volunteers.map((v) => (
                  <tr key={v.id}>
                    <td>{v.name}</td>
                    <td className="small muted">{v.email}{v.telegramUsername && <>{v.email && <br />}@{v.telegramUsername}</>}</td>
                    <td>{v.shifts}</td>
                    <td>{fmtHours(v.hoursScheduled)}</td>
                    <td>{fmtHours(v.hoursWorked)}</td>
                    <td>{v.noShows ? <Pill tone="stop">{v.noShows}</Pill> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <Modal title="Edit shift" onClose={() => setEditing(null)} footer={<>
          <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn primary" onClick={saveShift}>Save</button>
        </>}>
          {msg && <p className="note bad">{msg}</p>}
          <ShiftForm value={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
        </Modal>
      )}
    </>
  );
}
