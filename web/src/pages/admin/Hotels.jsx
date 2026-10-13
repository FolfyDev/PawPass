import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Empty, Field, Pill, fmtMoney, fmtNight, addDays } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import { localInZone } from '../../lib/tz.js';

const BLANK_HOTEL = { name: '', address: '', url: '', phone: '', description: '' };
const BLANK_BLOCK = {
  name: '', description: '', rate: '', mode: 'HOTEL_BOOKED', bookingUrl: '', groupCode: '', cutoffAt: '',
  maxGuests: 4, attritionPercent: '', attendeesOnly: true, active: true, staffNotes: '',
};

const MODE_LABEL = { HOTEL_BOOKED: 'Booked with the hotel', ORGANIZER_MANAGED: 'Requested here' };

const toBlockDraft = (b, tz) => ({
  name: b.name, description: b.description, rate: b.rateCents ? (b.rateCents / 100).toFixed(2) : '', mode: b.mode,
  bookingUrl: b.bookingUrl || '', groupCode: b.groupCode || '', cutoffAt: localInZone(b.cutoffAt, tz),
  maxGuests: b.maxGuests, attritionPercent: b.attritionPercent ?? '', attendeesOnly: b.attendeesOnly, active: b.active,
  staffNotes: b.staffNotes,
});

function HotelForm({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Name"><input value={value.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Phone" help="Optional"><input value={value.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Address" help="Optional"><input value={value.address} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="Website" help="Optional"><input placeholder="https://" value={value.url} onChange={(e) => set({ url: e.target.value })} /></Field>
      </div>
      <Field label="About" help="Optional, e.g. distance to the venue, parking">
        <textarea style={{ minHeight: 70 }} value={value.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
    </div>
  );
}

function BlockForm({ value, onChange, tz }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <Field label="How do people book?">
        <div className="segmented">
          {Object.entries(MODE_LABEL).map(([v, label]) => (
            <button key={v} type="button" className={value.mode === v ? 'selected' : ''} onClick={() => set({ mode: v })}>{label}</button>
          ))}
        </div>
      </Field>
      <p className="small muted" style={{ margin: 0 }}>
        {value.mode === 'HOTEL_BOOKED'
          ? 'Attendees use the hotel\'s link or group code. You copy in the pickup from the hotel\'s reports.'
          : 'Attendees request a room here. You send the hotel the rooming list and enter its confirmation numbers.'}
      </p>
      <div className="grid-2">
        <Field label="Room type"><input placeholder="e.g. King" value={value.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Rate per night" help="Dollars, before tax"><input type="number" min="0" step="0.01" value={value.rate} onChange={(e) => set({ rate: e.target.value })} /></Field>
        {value.mode === 'HOTEL_BOOKED' && <>
          <Field label="Booking link" help="Optional"><input placeholder="https://" value={value.bookingUrl} onChange={(e) => set({ bookingUrl: e.target.value })} /></Field>
          <Field label="Group code" help="Optional"><input value={value.groupCode} onChange={(e) => set({ groupCode: e.target.value })} /></Field>
        </>}
        <Field label="Cutoff" help={`Optional, ${tz}`}><input type="datetime-local" value={value.cutoffAt} onChange={(e) => set({ cutoffAt: e.target.value })} /></Field>
        <Field label="Guests per room"><input type="number" min="1" max="12" value={value.maxGuests} onChange={(e) => set({ maxGuests: e.target.value })} /></Field>
        <Field label="Pickup target" help="Optional, % of room nights the contract requires">
          <input type="number" min="1" max="100" placeholder="e.g. 80" value={value.attritionPercent} onChange={(e) => set({ attritionPercent: e.target.value })} />
        </Field>
      </div>
      <Field label="What attendees see" help="Optional"><textarea style={{ minHeight: 60 }} value={value.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <Field label="Staff notes" help="Never shown to attendees, e.g. sales contact, contract terms">
        <textarea style={{ minHeight: 60 }} value={value.staffNotes} onChange={(e) => set({ staffNotes: e.target.value })} />
      </Field>
      <label className="row"><input type="checkbox" checked={value.attendeesOnly} onChange={(e) => set({ attendeesOnly: e.target.checked })} /> Only people with a confirmed ticket see the booking details or can request a room</label>
      <label className="row"><input type="checkbox" checked={value.active} onChange={(e) => set({ active: e.target.checked })} /> Show on the event page</label>
    </div>
  );
}

/// Every night from `from` to `to`, both included, as rows of `rooms` each.
function rangeRows({ from, to, rooms }) {
  const rows = [];
  for (let d = from; d && to && d <= to && rows.length < 60; d = addDays(d, 1)) rows.push({ night: d, contracted: Number(rooms) || 0 });
  return rows;
}

function NightsEditor({ block, onSaved }) {
  const [rows, setRows] = useState(block.nights.map((n) => ({ night: n.night, contracted: n.contracted, reportedPickup: n.reportedPickup ?? '', held: n.held })));
  const [range, setRange] = useState({ from: '', to: '', rooms: 10 });
  const [msg, setMsg] = useState('');
  const managed = block.mode === 'ORGANIZER_MANAGED';
  const rangeBad = range.from && range.to && range.to < range.from;

  const withRange = (cur) => {
    const byNight = Object.fromEntries(cur.map((r) => [r.night, r]));
    for (const r of rangeRows(range)) byNight[r.night] = { ...(byNight[r.night] || { reportedPickup: '', held: 0 }), ...r };
    return Object.values(byNight).sort((a, b) => a.night.localeCompare(b.night));
  };
  const addRange = () => { setRows(withRange(rows)); setRange({ ...range, from: '', to: '' }); };
  const set = (night, patch) => setRows(rows.map((r) => (r.night === night ? { ...r, ...patch } : r)));

  // Dates typed into the range but not added yet still count — pressing Save
  // straight after picking them is the obvious thing to do.
  const save = async () => {
    setMsg('');
    if (rangeBad) return setMsg('The last night can\'t be before the first night.');
    const final = withRange(rows);
    if (!final.length) return setMsg('Pick the first and last night the hotel is holding rooms for.');
    try {
      await api.put(`/api/admin/room-blocks/${block.id}/nights`, {
        nights: final.map((r) => ({ night: r.night, contracted: Number(r.contracted), reportedPickup: managed ? null : r.reportedPickup })),
      });
      onSaved();
    } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="stack" style={{ background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 10, padding: 14 }}>
      <p className="small muted" style={{ margin: 0 }}>
        Enter the nights in the hotel contract. A night is the date you check in: for a Friday-to-Sunday stay, that's Friday and Saturday.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="First night"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value, to: range.to || e.target.value })} /></Field>
        <Field label="Last night"><input type="date" min={range.from || undefined} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        <Field label="Rooms each night"><input type="number" min="0" value={range.rooms} onChange={(e) => setRange({ ...range, rooms: e.target.value })} style={{ width: 100 }} /></Field>
        {rows.length > 0 && <button type="button" className="btn sm" disabled={!range.from || !range.to || rangeBad} onClick={addRange}>Add to table</button>}
      </div>
      {rows.length > 0 && (
        <table>
          <thead><tr><th>Night</th><th>Rooms contracted</th><th>{managed ? 'Requested' : 'Hotel-reported pickup'}</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.night}>
                <td>{fmtNight(r.night)}</td>
                <td><input type="number" min={r.held} value={r.contracted} onChange={(e) => set(r.night, { contracted: e.target.value })} style={{ width: 90 }} /></td>
                <td>{managed ? r.held : <input type="number" min="0" value={r.reportedPickup} onChange={(e) => set(r.night, { reportedPickup: e.target.value })} style={{ width: 90 }} />}</td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button" className="btn sm ghost" disabled={r.held > 0} title={r.held > 0 ? 'Rooms are requested on this night' : undefined} onClick={() => setRows(rows.filter((x) => x.night !== r.night))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className="note bad" style={{ margin: 0 }}>{msg}</p>}
      <div className="row"><button className="btn primary sm" onClick={save}>Save nights</button><button className="btn ghost sm" onClick={onSaved}>Cancel</button></div>
    </div>
  );
}

function PickupMeter({ block }) {
  const pct = Math.min(block.pickupPercent, 100);
  const short = block.shortfall > 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="spread small">
        <span><strong>{block.pickedUp}</strong> of {block.contracted} room nights picked up ({block.pickupPercent}%)</span>
        {block.required != null && (
          short
            ? <span style={{ color: 'var(--signal)' }}>{block.shortfall} short of the {block.attritionPercent}% target</span>
            : <span style={{ color: 'var(--go)' }}>{block.attritionPercent}% target met</span>
        )}
      </div>
      <div className={`pickup-meter${short ? ' short' : ''}`} role="img" aria-label={`${block.pickupPercent}% picked up`}>
        <span style={{ width: `${pct}%` }} />
        {block.attritionPercent && <i style={{ left: `${block.attritionPercent}%` }} />}
      </div>
    </div>
  );
}

function stayOptions(block) {
  const nights = block.nights.map((n) => n.night);
  return { checkIns: nights, checkOuts: nights.map((n) => addDays(n, 1)) };
}

function ReservationForm({ value, onChange, block }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const { checkIns, checkOuts } = stayOptions(block);
  return (
    <div className="stack">
      <div className="grid-2">
        {'who' in value && <Field label="Who" help="Ticket code or @telegram"><input value={value.who} onChange={(e) => set({ who: e.target.value })} /></Field>}
        <Field label="Guest name" help={'who' in value ? 'Blank = legal name on their ticket' : 'As on their ID'}>
          <input value={value.guestName} onChange={(e) => set({ guestName: e.target.value })} />
        </Field>
        <Field label="Check-in">
          <select value={value.checkIn} onChange={(e) => set({ checkIn: e.target.value })}>
            <option value="">Choose</option>
            {checkIns.map((d) => <option key={d} value={d}>{fmtNight(d)}</option>)}
          </select>
        </Field>
        <Field label="Check-out">
          <select value={value.checkOut} onChange={(e) => set({ checkOut: e.target.value })}>
            <option value="">Choose</option>
            {checkOuts.filter((d) => !value.checkIn || d > value.checkIn).map((d) => <option key={d} value={d}>{fmtNight(d)}</option>)}
          </select>
        </Field>
        <Field label="Guests"><input type="number" min="1" max={block.maxGuests} value={value.guests} onChange={(e) => set({ guests: e.target.value })} /></Field>
        {'confirmationNumber' in value && (
          <Field label="Hotel confirmation #" help="Entering it confirms the room">
            <input value={value.confirmationNumber} onChange={(e) => set({ confirmationNumber: e.target.value })} />
          </Field>
        )}
      </div>
      <Field label="Roommates" help="Optional"><input value={value.roommates} onChange={(e) => set({ roommates: e.target.value })} /></Field>
      <Field label="Staff note" help="Optional, never shown to them"><input value={value.staffNote} onChange={(e) => set({ staffNote: e.target.value })} /></Field>
    </div>
  );
}

function Reservations({ block, onChange, setMsg }) {
  const [showCancelled, setShowCancelled] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(null);
  const [formMsg, setFormMsg] = useState('');
  const live = block.reservations.filter((r) => r.status !== 'CANCELLED');
  const cancelled = block.reservations.filter((r) => r.status === 'CANCELLED');
  const shown = showCancelled ? block.reservations : live;

  const quickConfirm = async (r, confirmationNumber) => {
    setMsg('');
    try { await api.patch(`/api/admin/room-reservations/${r.id}`, { confirmationNumber }); onChange(); }
    catch (e) { setMsg(e.message); }
  };
  const cancel = async (r) => {
    if (!confirm(`Cancel ${r.guestName}'s room? They'll be told, and the nights go back into the block. Remember to tell the hotel if it was already booked.`)) return;
    setMsg('');
    try { await api.post(`/api/admin/room-reservations/${r.id}/cancel`); onChange(); }
    catch (e) { setMsg(e.message); }
  };
  const save = async () => {
    setFormMsg('');
    try {
      if (adding) await api.post(`/api/admin/room-blocks/${block.id}/reservations`, adding);
      else await api.patch(`/api/admin/room-reservations/${editing.id}`, editing.draft);
      setAdding(null); setEditing(null); onChange();
    } catch (e) { setFormMsg(e.message); }
  };

  return (
    <div className="stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Room requests <span className="muted small">({live.length})</span></h3>
        <div className="row">
          {cancelled.length > 0 && (
            <button className="btn ghost sm" onClick={() => setShowCancelled(!showCancelled)}>{showCancelled ? 'Hide' : 'Show'} {cancelled.length} cancelled</button>
          )}
          <a className="btn sm" href={`${api.base}/api/admin/room-blocks/${block.id}/rooming-list.csv`}>Rooming list CSV</a>
          <button className="btn sm" disabled={!block.nights.length} onClick={() => { setFormMsg(''); setAdding({ who: '', guestName: '', checkIn: '', checkOut: '', guests: 1, roommates: '', staffNote: '' }); }}>Add room</button>
        </div>
      </div>
      {shown.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No requests yet.</p> : (
        <div style={{ overflow: 'auto' }}>
          <table>
            <thead><tr><th>Guest</th><th>Stay</th><th>Room</th><th>Status</th><th>Confirmation #</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} style={r.status === 'CANCELLED' ? { opacity: 0.55 } : undefined}>
                  <td>
                    {r.guestName}
                    <div className="small muted">{[r.person.email, r.person.telegramUsername && `@${r.person.telegramUsername}`].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>
                    {fmtNight(r.checkIn)} – {fmtNight(r.checkOut)}
                    <div className="muted">{r.nights} night{r.nights === 1 ? '' : 's'}</div>
                  </td>
                  <td className="small muted">
                    {r.guests} guest{r.guests === 1 ? '' : 's'}{r.roommates ? ` · ${r.roommates}` : ''}
                    {r.note && <div>“{r.note}”</div>}
                    {r.staffNote && <div><em>Staff: {r.staffNote}</em></div>}
                  </td>
                  <td>
                    {r.status === 'CONFIRMED' ? <Pill tone="go">Confirmed</Pill> : r.status === 'CANCELLED' ? <Pill tone="stop">Cancelled</Pill> : <Pill tone="wait">Requested</Pill>}
                  </td>
                  <td>
                    {r.status === 'CANCELLED' ? <span className="small muted">{r.confirmationNumber || '-'}</span> : (
                      <input defaultValue={r.confirmationNumber || ''} placeholder="From hotel" style={{ width: 110 }}
                        onBlur={(e) => e.target.value.trim() !== (r.confirmationNumber || '') && quickConfirm(r, e.target.value.trim())} />
                    )}
                  </td>
                  <td>
                    {r.status !== 'CANCELLED' && (
                      <div className="stack" style={{ gap: 4, justifyItems: 'end' }}>
                        <button className="btn sm" onClick={() => { setFormMsg(''); setEditing({ id: r.id, draft: { guestName: r.guestName, checkIn: r.checkIn, checkOut: r.checkOut, guests: r.guests, roommates: r.roommates, staffNote: r.staffNote || '', confirmationNumber: r.confirmationNumber || '' } }); }}>Edit</button>
                        <button className="btn sm danger" onClick={() => cancel(r)}>Cancel</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(adding || editing) && (
        <Modal title={adding ? `Add a room · ${block.name}` : 'Edit room request'} onClose={() => { setAdding(null); setEditing(null); }} footer={<>
          <button className="btn ghost" onClick={() => { setAdding(null); setEditing(null); }}>Close</button>
          <button className="btn primary" onClick={save}>{adding ? 'Add room' : 'Save'}</button>
        </>}>
          {formMsg && <p className="note bad">{formMsg}</p>}
          <ReservationForm block={block} value={adding || editing.draft} onChange={(v) => (adding ? setAdding(v) : setEditing({ ...editing, draft: v }))} />
        </Modal>
      )}
    </div>
  );
}

function BlockCard({ block, tz, isOwner, onChange, onEdit, setMsg }) {
  // A block is no use without its nights, so a new one opens straight into them.
  const [editingNights, setEditingNights] = useState(isOwner && block.nights.length === 0);
  const managed = block.mode === 'ORGANIZER_MANAGED';
  const remove = async () => {
    if (!confirm(`Delete the ${block.name} block?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/room-blocks/${block.id}`); onChange(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: 0 }}>{block.name} <span className="muted small">· {block.rateCents ? `${fmtMoney(block.rateCents, block.currency)}/night` : 'No rate set'}</span></h3>
          <p className="row small muted" style={{ margin: '4px 0 0', gap: 6 }}>
            <Pill>{MODE_LABEL[block.mode]}</Pill>
            {!block.active && <Pill tone="stop">Hidden</Pill>}
            {block.attendeesOnly && <Pill>Ticket holders only</Pill>}
            {block.cutoffAt && <span>Cutoff {new Date(block.cutoffAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })}</span>}
            {block.groupCode && <span>Code <span className="mono">{block.groupCode}</span></span>}
          </p>
          {block.staffNotes && <p className="small" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}><em>{block.staffNotes}</em></p>}
        </div>
        {isOwner && (
          <div className="row">
            <button className="btn sm" onClick={() => setEditingNights(!editingNights)}>{editingNights ? 'Close nights' : 'Nights'}</button>
            <button className="btn sm" onClick={() => onEdit(block)}>Edit</button>
            <button className="btn sm danger" onClick={remove}>Delete</button>
          </div>
        )}
      </div>

      {block.nights.length > 0 && <PickupMeter block={block} />}

      {editingNights ? (
        <NightsEditor block={block} onSaved={() => { setEditingNights(false); onChange(); }} />
      ) : block.nights.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>No nights set up yet.{isOwner && ' Use Nights to add the contracted rooms per night.'}</p>
      ) : (
        <div style={{ overflow: 'auto' }}>
          <table>
            <thead><tr><th>Night</th>{block.nights.map((n) => <th key={n.night} style={{ textAlign: 'center' }}>{fmtNight(n.night)}</th>)}</tr></thead>
            <tbody>
              <tr><td className="small muted">Contracted</td>{block.nights.map((n) => <td key={n.night} style={{ textAlign: 'center' }}>{n.contracted}</td>)}</tr>
              <tr><td className="small muted">{managed ? 'Requested' : 'Picked up'}</td>{block.nights.map((n) => <td key={n.night} style={{ textAlign: 'center' }}>{n.pickup}</td>)}</tr>
              {managed && <tr><td className="small muted">Open</td>{block.nights.map((n) => <td key={n.night} style={{ textAlign: 'center' }}>{Math.max(n.contracted - n.held, 0)}</td>)}</tr>}
            </tbody>
          </table>
        </div>
      )}

      {managed && <Reservations block={block} onChange={onChange} setMsg={setMsg} />}
    </div>
  );
}

export default function Hotels() {
  const { id } = useParams();
  const { user } = useSession();
  const isOwner = user.role === 'OWNER';
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');
  // { kind: 'hotel' | 'block', id?, hotelId?, draft }
  const [form, setForm] = useState(null);
  const [formMsg, setFormMsg] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/hotels`).then((d) => {
    setData(d);
    setSettings((s) => s || { hotelsEnabled: d.enabled, hotelInfo: d.info });
  });
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);
  const tz = event?.timezone;

  const saveSettings = async () => {
    setMsg(''); setNote('');
    try { await api.patch(`/api/admin/events/${id}`, settings); setNote('Saved.'); }
    catch (e) { setMsg(e.message); }
  };

  const open = (f) => { setFormMsg(''); setForm(f); };
  const saveForm = async () => {
    setFormMsg('');
    try {
      if (form.kind === 'hotel') {
        if (form.id) await api.patch(`/api/admin/hotels/${form.id}`, form.draft);
        else await api.post(`/api/admin/events/${id}/hotels`, form.draft);
      } else if (form.id) await api.patch(`/api/admin/room-blocks/${form.id}`, form.draft);
      else await api.post(`/api/admin/hotels/${form.hotelId}/blocks`, form.draft);
      setForm(null);
      load();
    } catch (e) { setFormMsg(e.message); }
  };

  const removeHotel = async (h) => {
    if (!confirm(`Delete ${h.name} and all its room blocks?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/hotels/${h.id}`); load(); }
    catch (e) { setMsg(e.message); }
  };

  if (!event || !data || !settings) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  const blocks = data.hotels.flatMap((h) => h.blocks);
  const contracted = blocks.reduce((n, b) => n + b.contracted, 0);
  const pickedUp = blocks.reduce((n, b) => n + b.pickedUp, 0);
  const waiting = blocks.reduce((n, b) => n + b.reservations.filter((r) => r.status === 'REQUESTED').length, 0);

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Hotels</h1>
        </div>
        {isOwner && <button className="btn primary" onClick={() => open({ kind: 'hotel', draft: BLANK_HOTEL })}>Add hotel</button>}
      </div>

      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="card" style={{ marginBottom: 24 }}>
        <fieldset disabled={!isOwner} className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
          <label className="row">
            <input type="checkbox" checked={settings.hotelsEnabled} onChange={(e) => setSettings({ ...settings, hotelsEnabled: e.target.checked })} />
            <span>Show "Where to stay" on the event page</span>
          </label>
          <Field label="Note above the hotel list" help="Optional, e.g. book by the cutoff to get the rate">
            <textarea style={{ minHeight: 70 }} value={settings.hotelInfo} onChange={(e) => setSettings({ ...settings, hotelInfo: e.target.value })} />
          </Field>
          {isOwner
            ? <div className="row"><button className="btn primary" onClick={saveSettings}>Save</button>{note && <span className="small muted">{note}</span>}</div>
            : <p className="small muted" style={{ margin: 0 }}>Only owners can set up hotels and blocks. You can work the room requests: confirm, change dates, add, and cancel.</p>}
        </fieldset>
      </div>

      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="card stat-tile"><p className="eyebrow" style={{ margin: 0 }}>Hotels</p><p className="value">{data.hotels.length}</p></div>
        <div className="card stat-tile"><p className="eyebrow" style={{ margin: 0 }}>Room nights</p><p className="value">{contracted}</p><p className="small muted" style={{ margin: 0 }}>contracted</p></div>
        <div className="card stat-tile">
          <p className="eyebrow" style={{ margin: 0 }}>Picked up</p>
          <p className="value">{contracted ? Math.round((pickedUp / contracted) * 100) : 0}%</p>
          <p className="small muted" style={{ margin: 0 }}>{pickedUp} room nights</p>
        </div>
        <div className="card stat-tile"><p className="eyebrow" style={{ margin: 0 }}>Awaiting hotel</p><p className="value">{waiting}</p><p className="small muted" style={{ margin: 0 }}>requests with no confirmation #</p></div>
      </div>

      {data.hotels.length === 0 && <Empty title="No hotels yet">{isOwner ? 'Add your partner hotels and their room blocks.' : 'An owner can add them.'}</Empty>}

      <div className="stack" style={{ gap: 20 }}>
        {data.hotels.map((h) => (
          <div key={h.id} className="card stack">
            <div className="spread" style={{ alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0 }}>{h.name}</h2>
                <p className="small muted" style={{ margin: '2px 0 0' }}>
                  {[h.address, h.phone].filter(Boolean).join(' · ')}
                  {h.url && <> · <a href={h.url} target="_blank" rel="noreferrer">Website</a></>}
                </p>
              </div>
              {isOwner && (
                <div className="row">
                  <button className="btn sm" onClick={() => open({ kind: 'block', hotelId: h.id, draft: BLANK_BLOCK })}>Add room block</button>
                  <button className="btn sm" onClick={() => open({ kind: 'hotel', id: h.id, draft: { name: h.name, address: h.address || '', url: h.url || '', phone: h.phone || '', description: h.description } })}>Edit</button>
                  <button className="btn sm danger" onClick={() => removeHotel(h)}>Delete</button>
                </div>
              )}
            </div>
            {h.blocks.length === 0 && <p className="small muted" style={{ margin: 0 }}>No room blocks yet.</p>}
            {h.blocks.map((b) => (
              <BlockCard key={b.id} block={b} tz={tz} isOwner={isOwner} onChange={load} setMsg={setMsg}
                onEdit={(blk) => open({ kind: 'block', id: blk.id, draft: toBlockDraft(blk, tz) })} />
            ))}
          </div>
        ))}
      </div>

      {form && (
        <Modal wide={form.kind === 'block'} onClose={() => setForm(null)}
          title={`${form.id ? 'Edit' : 'Add'} ${form.kind === 'hotel' ? 'hotel' : 'room block'}`}
          footer={<>
            <button className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn primary" onClick={saveForm}>Save</button>
          </>}>
          {formMsg && <p className="note bad">{formMsg}</p>}
          {form.kind === 'hotel'
            ? <HotelForm value={form.draft} onChange={(draft) => setForm({ ...form, draft })} />
            : <BlockForm value={form.draft} tz={tz} onChange={(draft) => setForm({ ...form, draft })} />}
          {form.kind === 'block' && !form.id && <p className="small muted">After saving, you'll enter the rooms contracted for each night.</p>}
        </Modal>
      )}
    </>
  );
}
