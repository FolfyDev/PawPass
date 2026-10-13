import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Empty, Field, Pill, fmtNight, addDays } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import { PageSkeleton, RowsSkeleton } from '../../components/Skeleton.jsx';

const PAGE_SIZE = 50;

/// The status tabs, and which reservations each one shows.
const STATUSES = [
  ['active', 'Active', (r) => r.status !== 'CANCELLED'],
  ['requested', 'Waiting on hotel', (r) => r.status === 'REQUESTED'],
  ['confirmed', 'Confirmed', (r) => r.status === 'CONFIRMED'],
  ['cancelled', 'Cancelled', (r) => r.status === 'CANCELLED'],
  ['all', 'All', () => true],
];

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

const statusPill = (r) => (r.status === 'CONFIRMED' ? <Pill tone="go">Confirmed</Pill>
  : r.status === 'CANCELLED' ? <Pill tone="stop">Cancelled</Pill> : <Pill tone="wait">Requested</Pill>);

/// Every room request for the event's organizer-managed blocks, in one
/// filterable, paged table — a busy con has hundreds, too many to list
/// under each block on the hotels page.
export default function RoomRequests() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  // Hotel set-up alone can look; working the requests needs hotels.requests.
  const canWork = useSession().can('hotels.requests');
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [formMsg, setFormMsg] = useState('');
  // { blockId, draft } for a new room, { id, block, draft } for an edit.
  const [adding, setAdding] = useState(null);
  const [editing, setEditing] = useState(null);

  const status = STATUSES.some(([k]) => k === params.get('status')) ? params.get('status') : 'active';
  const blockId = params.get('block') || '';
  const q = params.get('q') || '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const setFilter = (patch) => {
    const next = { status, block: blockId, q, ...patch };
    // Any filter change starts over at page one.
    if (!('page' in patch)) next.page = 1;
    setParams(Object.fromEntries(Object.entries(next).filter(([k, v]) => v && !(k === 'status' && v === 'active') && !(k === 'page' && v === 1))), { replace: true });
  };

  const load = () => api.get(`/api/admin/events/${id}/hotels`).then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);

  const blocks = useMemo(() => (data?.hotels || []).flatMap((h) => h.blocks
    .filter((b) => b.mode === 'ORGANIZER_MANAGED')
    .map((b) => ({ ...b, hotel: h, label: `${h.name} · ${b.name}` }))), [data]);
  const all = useMemo(() => blocks
    .flatMap((b) => b.reservations.map((r) => ({ ...r, block: b })))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.guestName.localeCompare(b.guestName)), [blocks]);

  if (!event) return <PageSkeleton />;

  const inBlock = all.filter((r) => !blockId || r.block.id === blockId);
  const needle = q.trim().toLowerCase();
  const matches = (r) => !needle || [r.guestName, r.person.email, r.person.telegramUsername, r.confirmationNumber, r.roommates]
    .some((v) => v && v.toLowerCase().includes(needle));
  const filtered = inBlock.filter((r) => STATUSES.find(([k]) => k === status)[2](r) && matches(r));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const selectedBlock = blocks.find((b) => b.id === blockId);
  const csvBlock = selectedBlock || (blocks.length === 1 ? blocks[0] : null);

  const quickConfirm = async (r, confirmationNumber) => {
    setMsg('');
    try { await api.patch(`/api/admin/room-reservations/${r.id}`, { confirmationNumber }); load(); }
    catch (e) { setMsg(e.message); }
  };
  const cancel = async (r) => {
    if (!confirm(`Cancel ${r.guestName}'s room? They'll be told, and the nights go back into the block. Remember to tell the hotel if it was already booked.`)) return;
    setMsg('');
    try { await api.post(`/api/admin/room-reservations/${r.id}/cancel`); load(); }
    catch (e) { setMsg(e.message); }
  };
  const openAdd = () => {
    setFormMsg('');
    setAdding({ blockId: csvBlock?.id || '', draft: { who: '', guestName: '', checkIn: '', checkOut: '', guests: 1, roommates: '', staffNote: '' } });
  };
  const close = () => { setAdding(null); setEditing(null); };
  const save = async () => {
    setFormMsg('');
    try {
      if (adding) await api.post(`/api/admin/room-blocks/${adding.blockId}/reservations`, adding.draft);
      else await api.patch(`/api/admin/room-reservations/${editing.id}`, editing.draft);
      close();
      load();
    } catch (e) { setFormMsg(e.message); }
  };
  const addBlock = adding && blocks.find((b) => b.id === adding.blockId);

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Room requests</h1>
        </div>
        <div className="row">
          {csvBlock && <a className="btn sm" href={`${api.base}/api/admin/room-blocks/${csvBlock.id}/rooming-list.csv`}>Rooming list CSV</a>}
          {canWork && blocks.length > 0 && <button className="btn primary" disabled={!blocks.some((b) => b.nights.length)} onClick={openAdd}>Add room</button>}
        </div>
      </div>

      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      {!data ? <RowsSkeleton rows={8} /> : blocks.length === 0 ? (
        <Empty title="No blocks take requests here">
          Room requests are for blocks set to "Requested here". <Link to={`/admin/events/${id}/hotels`}>Set one up on Hotels</Link>.
        </Empty>
      ) : (
        <>
          <div className="filter-row">
            <div className="seg" role="tablist" aria-label="Status">
              {STATUSES.map(([key, label, test]) => (
                <button key={key} role="tab" aria-current={status === key ? 'true' : undefined} onClick={() => setFilter({ status: key })}>
                  {label} <span className="muted">({inBlock.filter(test).length})</span>
                </button>
              ))}
            </div>
            {blocks.length > 1 && (
              <select value={blockId} aria-label="Room block" onChange={(e) => setFilter({ block: e.target.value })}>
                <option value="">All blocks</option>
                {blocks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            )}
            <input type="search" value={q} placeholder="Search name, contact, confirmation #" aria-label="Search room requests"
              style={{ width: 'auto', flex: '1 1 220px' }} onChange={(e) => setFilter({ q: e.target.value })} />
          </div>

          {shown.length === 0 ? (
            <Empty title={needle ? 'No matches' : 'Nothing here'}>{needle ? 'Try a different search.' : 'No room requests with this status yet.'}</Empty>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'auto' }}>
              <table>
                <thead>
                  <tr><th>Guest</th>{!selectedBlock && blocks.length > 1 && <th>Block</th>}<th>Stay</th><th>Room</th><th>Status</th><th>Confirmation #</th><th /></tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={`${r.id}:${r.confirmationNumber || ''}`} className={r.status === 'CANCELLED' ? 'refunded-row' : undefined}>
                      <td>
                        {r.guestName}
                        <div className="small muted">{[r.person.email, r.person.telegramUsername && `@${r.person.telegramUsername}`].filter(Boolean).join(' · ')}</div>
                      </td>
                      {!selectedBlock && blocks.length > 1 && <td className="small">{r.block.hotel.name}<div className="muted">{r.block.name}</div></td>}
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>
                        {fmtNight(r.checkIn)} – {fmtNight(r.checkOut)}
                        <div className="muted">{r.nights} night{r.nights === 1 ? '' : 's'}</div>
                      </td>
                      <td className="small muted">
                        {r.guests} guest{r.guests === 1 ? '' : 's'}{r.roommates ? ` · ${r.roommates}` : ''}
                        {r.note && <div>“{r.note}”</div>}
                        {r.staffNote && <div><em>Staff: {r.staffNote}</em></div>}
                      </td>
                      <td>{statusPill(r)}</td>
                      <td>
                        {r.status === 'CANCELLED' || !canWork ? <span className="small muted">{r.confirmationNumber || '-'}</span> : (
                          <input defaultValue={r.confirmationNumber || ''} placeholder="From hotel" style={{ width: 120, padding: '7px 10px' }}
                            aria-label={`Hotel confirmation number for ${r.guestName}`}
                            onBlur={(e) => e.target.value.trim() !== (r.confirmationNumber || '') && quickConfirm(r, e.target.value.trim())} />
                        )}
                      </td>
                      <td>
                        {canWork && r.status !== 'CANCELLED' && (
                          <div className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                            <button className="btn sm" onClick={() => { setFormMsg(''); setEditing({ id: r.id, block: r.block, draft: { guestName: r.guestName, checkIn: r.checkIn, checkOut: r.checkOut, guests: r.guests, roommates: r.roommates, staffNote: r.staffNote || '', confirmationNumber: r.confirmationNumber || '' } }); }}>Edit</button>
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

          {filtered.length > PAGE_SIZE && (
            <div className="spread" style={{ marginTop: 14 }}>
              <span className="small muted">
                {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" disabled={current === 1} onClick={() => setFilter({ page: current - 1 })}>← Previous</button>
                <span className="small muted">Page {current} of {pages}</span>
                <button className="btn sm" disabled={current === pages} onClick={() => setFilter({ page: current + 1 })}>Next →</button>
              </div>
            </div>
          )}
        </>
      )}

      {(adding || editing) && (
        <Modal title={adding ? 'Add a room' : 'Edit room request'} onClose={close} footer={<>
          <button className="btn ghost" onClick={close}>Close</button>
          <button className="btn primary" disabled={adding && !addBlock} onClick={save}>{adding ? 'Add room' : 'Save'}</button>
        </>}>
          {formMsg && <p className="note bad">{formMsg}</p>}
          {adding && blocks.length > 1 && (
            <Field label="Room block">
              <select value={adding.blockId} onChange={(e) => setAdding({ ...adding, blockId: e.target.value, draft: { ...adding.draft, checkIn: '', checkOut: '' } })}>
                <option value="">Choose</option>
                {blocks.filter((b) => b.nights.length).map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Field>
          )}
          {adding ? addBlock && (
            <div style={{ marginTop: blocks.length > 1 ? 16 : 0 }}>
              <ReservationForm block={addBlock} value={adding.draft} onChange={(draft) => setAdding({ ...adding, draft })} />
            </div>
          ) : (
            <ReservationForm block={editing.block} value={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
          )}
        </Modal>
      )}
    </>
  );
}
