import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { printBadge, printBadges, printAttendeeList } from '../../lib/print.js';
import { StatusPill, Pill, Empty, Field, PaymentButtons } from '../../components/Bits.jsx';
import Modal from '../../components/Modal.jsx';
import EventTabs from '../../components/EventTabs.jsx';

export default function Attendees() {
  const { id } = useParams();
  const { settings } = useSession();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [event, setEvent] = useState(null);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);
  const [selected, setSelected] = useState(() => new Set());

  const load = () => api.get(`/api/admin/events/${id}/registrations?q=${encodeURIComponent(q)}`).then(setRows);
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); }, [id]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q, id]);
  useEffect(() => { setSelected(new Set()); }, [id]);

  const print = async (code) => {
    setMsg('');
    try { const r = await printBadge(code, settings?.printMode); setMsg(`Sent ${r.code} to the printer (copy ${r.printCount}).`); setMsgOk(true); }
    catch (e) { setMsg(e.message); setMsgOk(false); }
    load();
  };

  const printSelected = async () => {
    setMsg('');
    const codes = [...selected];
    try {
      await printBadges(codes, settings?.printMode);
      setMsg(`Sent ${codes.length} badge${codes.length === 1 ? '' : 's'} to the printer.`);
      setMsgOk(true);
      setSelected(new Set());
    } catch (e) { setMsg(e.message); setMsgOk(false); }
    load();
  };

  const toggleRow = (code) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const toggleAll = () => setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.code))));

  const setStatus = async (code, status) => { await api.patch(`/api/admin/registrations/${code}`, { status }); load(); };

  const checkedIn = rows?.filter((r) => r.checkedInAt).length || 0;

  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [editMsg, setEditMsg] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const openEdit = (r) => {
    setEditing(r);
    setEditForm({
      legalName: r.legalName || '',
      fursonaName: r.fursonaName || '',
      email: r.email || '',
      paymentMethod: r.paymentMethod || '',
      paymentAmount: r.paymentAmount != null ? String(r.paymentAmount) : '',
      paymentNote: r.paymentNote || '',
      answers: { ...(r.answers || {}) },
    });
    setEditMsg('');
  };

  const setAnswer = (key, value) => setEditForm((f) => ({ ...f, answers: { ...f.answers, [key]: value } }));

  const saveEdit = async () => {
    setEditBusy(true);
    setEditMsg('');
    try {
      await api.patch(`/api/admin/registrations/${editing.code}`, {
        legalName: editForm.legalName,
        fursonaName: editForm.fursonaName,
        email: editForm.email,
        paymentMethod: editForm.paymentMethod || null,
        paymentAmount: editForm.paymentAmount === '' ? null : Number(editForm.paymentAmount),
        paymentNote: editForm.paymentNote,
        answers: editForm.answers,
      });
      setEditing(null);
      load();
    } catch (e) { setEditMsg(e.message); }
    finally { setEditBusy(false); }
  };

  const [telegramQuery, setTelegramQuery] = useState('');
  const [telegramMatches, setTelegramMatches] = useState([]);
  const [telegramBusy, setTelegramBusy] = useState(false);

  useEffect(() => {
    if (!editing || !telegramQuery.trim()) { setTelegramMatches([]); return; }
    const t = setTimeout(() => {
      api.get(`/api/admin/telegram-lookup?q=${encodeURIComponent(telegramQuery)}`).then(setTelegramMatches);
    }, 200);
    return () => clearTimeout(t);
  }, [telegramQuery, editing]);

  const linkTelegram = async (telegramId) => {
    setTelegramBusy(true);
    setEditMsg('');
    try {
      await api.patch(`/api/admin/registrations/${editing.code}/telegram`, { telegramId });
      setTelegramQuery('');
      setTelegramMatches([]);
      setEditing(null);
      setMsg('Telegram account linked.');
      setMsgOk(true);
      load();
    } catch (e) { setEditMsg(e.message); }
    finally { setTelegramBusy(false); }
  };

  const [combining, setCombining] = useState(null);
  const [combineBusy, setCombineBusy] = useState(false);

  const combineChoose = async (keepCode) => {
    const dropCode = combining.find((r) => r.code !== keepCode).code;
    setCombineBusy(true);
    try {
      const r = await api.post('/api/admin/registrations/combine', { keepCode, dropCode });
      setMsg(r.skipped?.length
        ? `Combined — ${r.skipped.length} other registration${r.skipped.length === 1 ? '' : 's'} couldn't be moved: ${r.skipped.join(', ')}.`
        : 'Registrations combined.');
      setMsgOk(true);
      setCombining(null);
      setSelected(new Set());
      load();
    } catch (e) { setMsg(e.message); setMsgOk(false); }
    finally { setCombineBusy(false); }
  };

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event?.title}</p>
          <h1 style={{ margin: 0 }}>Attendees</h1>
        </div>
        <div className="row">
          <Link className="btn" to="/admin/scan">Open scanner</Link>
          <button className="btn" disabled={!rows?.length} onClick={() => printAttendeeList(rows, event?.title)}>Print attendee list</button>
          <a className="btn" href={`${api.base}/api/admin/events/${id}/registrations.csv`}>Export CSV</a>
        </div>
      </div>
      <EventTabs id={id} />

      <div className="row" style={{ marginBottom: 14 }}>
        <input placeholder="Search name, fursona, code or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
        <span className="small muted">{rows?.length || 0} registered · {checkedIn} checked in</span>
        {!!selected.size && (
          <>
            <span className="small muted">· {selected.size} selected</span>
            <button className="btn sm" onClick={printSelected}>Print {selected.size} badge{selected.size === 1 ? '' : 's'}</button>
            {selected.size === 2 && (
              <button className="btn sm" onClick={() => setCombining(rows.filter((r) => selected.has(r.code)))}>Combine 2 registrations</button>
            )}
          </>
        )}
      </div>
      {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`} style={{ marginBottom: 14 }}>{msg}</p>}

      {rows?.length === 0 && <Empty title="Nobody yet">Share the event link or point people at the Telegram bot.</Empty>}

      {!!rows?.length && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr><th><input type="checkbox" checked={selected.size === rows.length} onChange={toggleAll} /></th><th>Code</th><th>Badge #</th><th>Badge name</th><th>Legal name</th><th>Contact</th><th>Status</th><th>Tier</th><th>Badge tier</th><th>Payment</th><th>Printed</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td><input type="checkbox" checked={selected.has(r.code)} onChange={() => toggleRow(r.code)} /></td>
                  <td className="mono">{r.code}</td>
                  <td className="mono">{r.badgeNumber ?? '—'}</td>
                  <td><strong>{r.fursonaName || '—'}</strong></td>
                  <td>{r.legalName}</td>
                  <td className="small muted">{r.telegram ? `@${r.telegram}` : ''}{r.email ? <><br />{r.email}</> : ''}</td>
                  <td><StatusPill status={r.status} checkedInAt={r.checkedInAt} /></td>
                  <td>{r.tier === 'DONATION' ? <Pill tone="go">Donation</Pill> : <Pill>Free</Pill>}</td>
                  <td className="small muted">{r.badgeTier ? <Pill tone="go">{r.badgeTier}</Pill> : '—'}</td>
                  <td className="small muted">
                    {r.tier !== 'DONATION' ? '—' : r.paymentMethod
                      ? <>{r.paymentMethod}{r.paymentAmount != null ? ` · $${Number(r.paymentAmount).toFixed(2)}` : ''}{r.paymentNote ? <><br />{r.paymentNote}</> : ''}</>
                      : <Pill tone="wait">Unrecorded</Pill>}
                  </td>
                  <td className="small muted">{r.printCount ? `${r.printCount}×` : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <a className="btn sm" href={`${api.base}/api/badges/registration/${r.code}.png`} target="_blank" rel="noreferrer">Preview</a>{' '}
                    <button className="btn sm" onClick={() => openEdit(r)}>Edit</button>{' '}
                    <button className="btn sm" onClick={() => print(r.code)}>Print</button>{' '}
                    {r.status !== 'CANCELLED'
                      ? <button className="btn sm danger" onClick={() => setStatus(r.code, 'CANCELLED')}>Cancel</button>
                      : <button className="btn sm" onClick={() => setStatus(r.code, 'CONFIRMED')}>Restore</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && editForm && (
        <Modal title={`Edit ${editing.fursonaName || editing.legalName}`} onClose={() => setEditing(null)}
          footer={<>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" disabled={editBusy} onClick={saveEdit}>Save changes</button>
          </>}>
          <div className="stack">
            <p className="mono small muted" style={{ margin: 0 }}>{editing.code}</p>
            {editMsg && <p className="note bad">{editMsg}</p>}
            <div className="grid-2">
              <Field label="Legal name">
                <input value={editForm.legalName} onChange={(e) => setEditForm({ ...editForm, legalName: e.target.value })} />
              </Field>
              <Field label={settings?.fursonaNameLabel || 'Fursona name'}>
                <input value={editForm.fursonaName} onChange={(e) => setEditForm({ ...editForm, fursonaName: e.target.value })} />
              </Field>
            </div>
            <Field label="Email">
              <input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            </Field>

            <Field label="Telegram account" help="Search by name or username to link or replace">
              <div className="stack" style={{ gap: 6 }}>
                <p className="small muted" style={{ margin: 0 }}>{editing.telegram ? `Currently @${editing.telegram}` : 'Not linked'}</p>
                <input placeholder="Search name or username" value={telegramQuery} onChange={(e) => setTelegramQuery(e.target.value)} />
                {telegramMatches.length > 0 && (
                  <div className="card" style={{ padding: 0 }}>
                    {telegramMatches.map((m) => (
                      <div key={m.id} className="spread small" style={{ padding: '6px 10px', borderBottom: '1px solid var(--rule)' }}>
                        <span>{m.displayName}{m.telegramUsername ? <> <span className="mono muted">@{m.telegramUsername}</span></> : null}</span>
                        <button className="btn sm" disabled={telegramBusy} onClick={() => linkTelegram(m.telegramId)}>Link</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Field>

            {(event?.customFields || []).map((f) => (
              <Field key={f.key} label={f.label} help={f.help}>
                {f.type === 'select' ? (
                  <select value={editForm.answers[f.key] || ''} onChange={(e) => setAnswer(f.key, e.target.value)}>
                    <option value="">Choose one</option>
                    {(f.options || []).map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : f.type === 'checkbox' ? (
                  <span className="row"><input type="checkbox" checked={!!editForm.answers[f.key]}
                    onChange={(e) => setAnswer(f.key, e.target.checked)} /> {f.help}</span>
                ) : f.type === 'qualifier' ? (
                  <div className="stack" style={{ gap: 4 }}>
                    {(f.options || []).map((o) => {
                      const picked = Array.isArray(editForm.answers[f.key]) ? editForm.answers[f.key] : [];
                      return (
                        <label key={o} className="row small">
                          <input type="checkbox" checked={picked.includes(o)}
                            onChange={(e) => setAnswer(f.key, e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))} /> {o}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <input type={f.type === 'number' ? 'number' : 'text'} value={editForm.answers[f.key] || ''}
                    onChange={(e) => setAnswer(f.key, e.target.value)} />
                )}
              </Field>
            ))}

            {editing.tier === 'DONATION' && (
              <>
                <Field label="Payment method">
                  <PaymentButtons value={editForm.paymentMethod} onChange={(v) => setEditForm({ ...editForm, paymentMethod: v })} />
                </Field>
                <div className="grid-2">
                  <Field label="Amount">
                    <input type="number" step="0.01" value={editForm.paymentAmount} onChange={(e) => setEditForm({ ...editForm, paymentAmount: e.target.value })} />
                  </Field>
                  <Field label="Note">
                    <input value={editForm.paymentNote} onChange={(e) => setEditForm({ ...editForm, paymentNote: e.target.value })} />
                  </Field>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {combining && (
        <Modal title="Combine registrations" onClose={() => setCombining(null)}
          footer={<button className="btn ghost" onClick={() => setCombining(null)}>Cancel</button>}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              Pick which registration to keep — the other is cancelled, and any Telegram account or email the kept one is
              missing gets copied over from it.
            </p>
            {combining.map((r) => (
              <div key={r.code} className="spread card" style={{ padding: 12, alignItems: 'center' }}>
                <span className="small">
                  <strong>{r.fursonaName || r.legalName}</strong> · {r.legalName} · <span className="mono">{r.code}</span>
                  {r.telegram ? <> · @{r.telegram}</> : ''}{r.email ? <> · {r.email}</> : ''}
                </span>
                <button className="btn sm primary" disabled={combineBusy} onClick={() => combineChoose(r.code)}>Keep this one</button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
