import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Empty, Field, fmtMoney, PaymentButtons } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';
import Modal from '../../components/Modal.jsx';
import { localInZone } from '../../lib/tz.js';
import { AREA_LABEL, VendorStatus } from '../../components/VendorBits.jsx';

const FILTERS = [['SUBMITTED', 'To review'], ['WAITLISTED', 'Waitlist'], ['ACCEPTED', 'Fee due'], ['CONFIRMED', 'Confirmed'], ['', 'All']];
const BLANK_TYPE = { area: 'DEALERS_DEN', name: '', price: '', quantity: '', description: '' };

function TableTypes({ eventId, types, isOwner, onChange, setMsg }) {
  const [adding, setAdding] = useState(BLANK_TYPE);
  const add = async (e) => {
    e.preventDefault();
    setMsg('');
    try { await api.post(`/api/admin/events/${eventId}/vendor-tables`, adding); setAdding({ ...BLANK_TYPE, area: adding.area }); onChange(); }
    catch (err) { setMsg(err.message); }
  };
  const update = async (t, patch) => { setMsg(''); try { await api.patch(`/api/admin/vendor-tables/${t.id}`, patch); onChange(); } catch (err) { setMsg(err.message); onChange(); } };
  const remove = async (t) => {
    if (!confirm(`Delete "${t.name}"?`)) return;
    try { await api.del(`/api/admin/vendor-tables/${t.id}`); onChange(); } catch (err) { setMsg(err.message); }
  };
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Tables</h2>
      {types.length === 0 && <p className="small muted" style={{ margin: 0 }}>Add the kinds of table you offer, with their fee and how many there are.</p>}
      {types.length > 0 && (
        <table>
          <thead><tr><th>Table</th><th>Fee</th><th>Given out</th><th /></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id} style={t.active ? undefined : { opacity: 0.55 }}>
                <td>{t.name}<div className="small muted">{AREA_LABEL[t.area]}</div></td>
                <td>{t.priceCents ? fmtMoney(t.priceCents, t.currency) : 'Free'}</td>
                <td>
                  <strong style={t.taken >= t.quantity ? { color: 'var(--stop)' } : undefined}>{t.taken}</strong> of{' '}
                  {isOwner
                    ? <input type="number" min={t.taken} defaultValue={t.quantity} style={{ width: 70 }} aria-label="How many" onBlur={(e) => Number(e.target.value) !== t.quantity && update(t, { quantity: Number(e.target.value) })} />
                    : t.quantity}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {isOwner && <>
                    <button className="btn sm ghost" onClick={() => update(t, { active: !t.active })}>{t.active ? 'Hide' : 'Show'}</button>
                    <button className="btn sm ghost" onClick={() => remove(t)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isOwner && (
        <form className="row" onSubmit={add} style={{ alignItems: 'flex-end' }}>
          <Field label="Area">
            <select value={adding.area} onChange={(e) => setAdding({ ...adding, area: e.target.value })}>
              {Object.entries(AREA_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Table"><input placeholder="e.g. Full table" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} style={{ width: 150 }} /></Field>
          <Field label="Fee ($)"><input type="number" min="0" step="0.01" placeholder="0 = free" value={adding.price} onChange={(e) => setAdding({ ...adding, price: e.target.value })} style={{ width: 100 }} /></Field>
          <Field label="How many"><input type="number" min="1" value={adding.quantity} onChange={(e) => setAdding({ ...adding, quantity: e.target.value })} style={{ width: 90 }} /></Field>
          <button className="btn sm" disabled={!adding.name.trim() || !adding.quantity}>Add table</button>
        </form>
      )}
    </div>
  );
}

function Application({ a, isOwner, payOnline, onChange, onDecide, setMsg }) {
  const [paying, setPaying] = useState(null);
  const run = async (fn) => { setMsg(''); try { await fn(); onChange(); } catch (e) { setMsg(e.message); } };
  const holds = ['ACCEPTED', 'CONFIRMED'].includes(a.status);
  return (
    <article className="card stack" style={{ gap: 8 }}>
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0 }}>{a.businessName}</h2>
          <p className="small muted" style={{ margin: '2px 0 0' }}>
            {AREA_LABEL[a.area]} · asked for {a.tableType?.name || 'any table'} · {a.applicant.legalName || a.applicant.name}
            {a.applicant.telegramUsername && ` · @${a.applicant.telegramUsername}`}{a.applicant.email && ` · ${a.applicant.email}`}
          </p>
        </div>
        <VendorStatus status={a.status} />
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{a.description}</p>
      {a.portfolioUrls.length > 0 && (
        <p className="small" style={{ margin: 0 }}>{a.portfolioUrls.map((u, i) => <span key={u}>{i > 0 && ' · '}<a href={u} target="_blank" rel="noreferrer noopener">{u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}</a></span>)}</p>
      )}
      {a.assistants && <p className="small" style={{ margin: 0 }}><strong>Assistants:</strong> {a.assistants}</p>}
      {a.notes && <p className="small" style={{ margin: 0 }}><strong>Notes:</strong> {a.notes}</p>}

      {holds && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Table number">
            <input defaultValue={a.tableNumber || ''} style={{ width: 110 }} onBlur={(e) => e.target.value.trim() !== (a.tableNumber || '') && run(() => api.patch(`/api/admin/vendor-applications/${a.id}`, { tableNumber: e.target.value }))} />
          </Field>
          {a.feeCents > 0 && (
            <span className="small">
              Fee {fmtMoney(a.feeCents, a.currency)} · paid <strong>{fmtMoney(a.paidCents, a.currency)}</strong>
              {a.status === 'ACCEPTED' && (payOnline ? ' · they can pay online' : '')}
            </span>
          )}
        </div>
      )}
      {a.payments.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {a.payments.map((p) => (
            <li key={p.id}>
              {fmtMoney(p.amountCents, p.currency)} by {p.method.toLowerCase()} · {p.status.toLowerCase().replace('_', ' ')}
              {p.amountRefundedCents > 0 && ` · ${fmtMoney(p.amountRefundedCents, p.currency)} refunded`}
              {isOwner && ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status) && (
                <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={() => {
                  const amt = prompt(`Refund how much? Leave blank for all ${fmtMoney(p.amountCents - p.amountRefundedCents, p.currency)} left. A full refund releases the table.`);
                  if (amt !== null) run(() => api.post(`/api/admin/payments/${p.id}/refund`, { amount: amt }));
                }}>Refund</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Field label="Review note" help="Staff only">
        <input defaultValue={a.reviewNote} onBlur={(e) => e.target.value !== a.reviewNote && run(() => api.patch(`/api/admin/vendor-applications/${a.id}`, { reviewNote: e.target.value }))} />
      </Field>

      <div className="row">
        {['SUBMITTED', 'WAITLISTED'].includes(a.status) && <>
          <button className="btn sm signal" onClick={() => onDecide(a, 'ACCEPTED')}>Accept</button>
          {a.status === 'SUBMITTED' && <button className="btn sm" onClick={() => onDecide(a, 'WAITLISTED')}>Waitlist</button>}
          <button className="btn sm" onClick={() => onDecide(a, 'DECLINED')}>Decline</button>
        </>}
        {a.status === 'ACCEPTED' && <button className="btn sm" onClick={() => setPaying({ method: 'CASH', amount: ((a.feeCents - a.paidCents) / 100).toFixed(2), note: '' })}>Record a payment</button>}
        {holds && <button className="btn sm ghost" onClick={() => onDecide(a, 'CANCEL')}>Cancel table</button>}
        {a.decidedAt && <span className="small muted">Decided by {a.decidedBy || 'former staff'} {new Date(a.decidedAt).toLocaleDateString()}</span>}
      </div>

      {paying && (
        <Modal title={`Payment from ${a.businessName}`} onClose={() => setPaying(null)} footer={<>
          <button className="btn ghost" onClick={() => setPaying(null)}>Cancel</button>
          <button className="btn primary" onClick={() => run(async () => { await api.post(`/api/admin/vendor-applications/${a.id}/payments`, paying); setPaying(null); })}>Record</button>
        </>}>
          <div className="stack">
            <PaymentButtons value={paying.method} onChange={(method) => setPaying({ ...paying, method })} />
            <Field label="Amount ($)"><input type="number" min="0" step="0.01" value={paying.amount} onChange={(e) => setPaying({ ...paying, amount: e.target.value })} /></Field>
            <Field label="Note" help="Optional"><input value={paying.note} onChange={(e) => setPaying({ ...paying, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </article>
  );
}

export default function AdminVendors() {
  const { id } = useParams();
  const { user } = useSession();
  const isOwner = user.role === 'OWNER';
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState('SUBMITTED');
  const [area, setArea] = useState('');
  const [deciding, setDeciding] = useState(null);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/vendors`).then((d) => {
    setData(d);
    setSettings((s) => s || { vendorsOpen: d.open, vendorsCloseAt: localInZone(d.closesAt, d.timezone), vendorInfo: d.info });
  });
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);
  if (!event || !data || !settings) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  const saveSettings = async () => {
    setMsg(''); setNote('');
    try { await api.patch(`/api/admin/events/${id}`, settings); setNote('Saved.'); } catch (e) { setMsg(e.message); }
  };
  const decide = async () => {
    setMsg('');
    const { a, decision, tableTypeId, message } = deciding;
    try {
      if (decision === 'CANCEL') await api.post(`/api/admin/vendor-applications/${a.id}/cancel`, { message });
      else await api.post(`/api/admin/vendor-applications/${a.id}/decision`, { decision, tableTypeId, message });
      setDeciding(null);
      load();
    } catch (e) { setMsg(e.message); setDeciding(null); }
  };

  const apps = data.applications.filter((a) => (!status || a.status === status) && (!area || a.area === area));
  const count = (s) => data.applications.filter((a) => a.status === s).length;
  const typesFor = (a) => data.tableTypes.filter((t) => t.area === a.area);

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Vendors</h1>
        </div>
        <div className="row">
          {event.vendorsOpen && <Link className="btn" to={`/e/${event.slug}/vendors`} target="_blank">Application form ↗</Link>}
          <a className="btn" href={`${api.base}/api/admin/events/${id}/vendors.csv`}>Export CSV</a>
        </div>
      </div>
      <EventTabs id={id} />
      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="grid-2" style={{ alignItems: 'start', marginBottom: 20 }}>
        <div className="card">
          <fieldset disabled={!isOwner} className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
            <label className="row"><input type="checkbox" checked={settings.vendorsOpen} onChange={(e) => setSettings({ ...settings, vendorsOpen: e.target.checked })} /> Take applications</label>
            <Field label="Applications close" help={`Optional, ${data.timezone}`}>
              <input type="datetime-local" value={settings.vendorsCloseAt} onChange={(e) => setSettings({ ...settings, vendorsCloseAt: e.target.value })} />
            </Field>
            <Field label="Guidelines" help="Shown above the form: what you accept, load-in times, rules">
              <textarea style={{ minHeight: 90 }} value={settings.vendorInfo} onChange={(e) => setSettings({ ...settings, vendorInfo: e.target.value })} />
            </Field>
            {isOwner
              ? <div className="row"><button className="btn primary sm" onClick={saveSettings}>Save</button>{note && <span className="small muted">{note}</span>}</div>
              : <p className="small muted" style={{ margin: 0 }}>Owners open applications and set table fees. You can review, assign tables, and record payments.</p>}
          </fieldset>
        </div>
        <TableTypes eventId={id} types={data.tableTypes} isOwner={isOwner} onChange={load} setMsg={setMsg} />
      </div>

      <div className="filter-row">
        <div className="seg">
          {FILTERS.map(([v, label]) => (
            <button key={label} aria-current={status === v ? 'true' : undefined} onClick={() => setStatus(v)}>{label}{v && count(v) ? ` (${count(v)})` : ''}</button>
          ))}
        </div>
        <select value={area} onChange={(e) => setArea(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Both areas</option>
          {Object.entries(AREA_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      {apps.length === 0 ? <Empty title="Nothing here">Applications show up under To review as they come in.</Empty> : (
        <div className="stack" style={{ gap: 14 }}>
          {apps.map((a) => (
            <Application key={a.id} a={a} isOwner={isOwner} payOnline={data.payOnline} onChange={load} setMsg={setMsg}
              onDecide={(app, decision) => setDeciding({ a: app, decision, tableTypeId: app.tableTypeId || typesFor(app)[0]?.id || '', message: '' })} />
          ))}
        </div>
      )}

      {deciding && (
        <Modal title={{ ACCEPTED: 'Accept', WAITLISTED: 'Waitlist', DECLINED: 'Decline', CANCEL: 'Cancel the table for' }[deciding.decision] + ` ${deciding.a.businessName}?`}
          onClose={() => setDeciding(null)} footer={<>
            <button className="btn ghost" onClick={() => setDeciding(null)}>Back</button>
            <button className={`btn ${['DECLINED', 'CANCEL'].includes(deciding.decision) ? 'danger' : 'signal'}`} onClick={decide}>
              {{ ACCEPTED: 'Accept', WAITLISTED: 'Waitlist', DECLINED: 'Decline', CANCEL: 'Cancel table' }[deciding.decision]}
            </button>
          </>}>
          {deciding.decision === 'ACCEPTED' && (
            <Field label="Give them">
              <select value={deciding.tableTypeId} onChange={(e) => setDeciding({ ...deciding, tableTypeId: e.target.value })}>
                {typesFor(deciding.a).map((t) => (
                  <option key={t.id} value={t.id} disabled={t.taken >= t.quantity}>
                    {t.name} · {t.priceCents ? fmtMoney(t.priceCents, t.currency) : 'free'} · {t.quantity - t.taken} left
                  </option>
                ))}
              </select>
            </Field>
          )}
          {deciding.decision === 'CANCEL' && deciding.a.paidCents > 0 && (
            <p className="note">They've paid {fmtMoney(deciding.a.paidCents, deciding.a.currency)}. Cancelling doesn't refund it; use Refund on the payment.</p>
          )}
          <Field label="Add a message" help="Optional, included in what they receive">
            <textarea style={{ minHeight: 80 }} value={deciding.message} onChange={(e) => setDeciding({ ...deciding, message: e.target.value })} />
          </Field>
        </Modal>
      )}
    </>
  );
}
