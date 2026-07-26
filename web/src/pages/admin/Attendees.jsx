import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { StatusPill, Pill, Empty } from '../../components/Bits.jsx';

export default function Attendees() {
  const { id } = useParams();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [event, setEvent] = useState(null);
  const [msg, setMsg] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/registrations?q=${encodeURIComponent(q)}`).then(setRows);
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); }, [id]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q, id]);

  const print = async (code) => {
    setMsg('');
    try { const r = await api.post('/api/badges/print', { code }); setMsg(`Sent ${r.code} to the printer (copy ${r.printCount}).`); }
    catch (e) { setMsg(e.message); }
    load();
  };

  const setStatus = async (code, status) => { await api.patch(`/api/admin/registrations/${code}`, { status }); load(); };

  const checkedIn = rows?.filter((r) => r.checkedInAt).length || 0;

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event?.title}</p>
          <h1 style={{ margin: 0 }}>Attendees</h1>
        </div>
        <div className="row">
          <Link className="btn" to="/admin/scan">Open scanner</Link>
          <a className="btn" href={`${api.base}/api/admin/events/${id}/registrations.csv`}>Export CSV</a>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <input placeholder="Search name, fursona, code or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
        <span className="small muted">{rows?.length || 0} registered · {checkedIn} checked in</span>
      </div>
      {msg && <p className="note" style={{ marginBottom: 14 }}>{msg}</p>}

      {rows?.length === 0 && <Empty title="Nobody yet">Share the event link or point people at the Telegram bot.</Empty>}

      {!!rows?.length && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr><th>Code</th><th>Badge #</th><th>Badge name</th><th>Legal name</th><th>Contact</th><th>Status</th><th>Tier</th><th>Badge tier</th><th>Payment</th><th>Printed</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
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
    </>
  );
}
