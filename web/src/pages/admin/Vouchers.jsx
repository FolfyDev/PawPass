import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Empty } from '../../components/Bits.jsx';

export default function Vouchers() {
  const { id } = useParams();
  const [event, setEvent] = useState(null);
  const [vouchers, setVouchers] = useState(null);
  const [draft, setDraft] = useState({ code: '', badgeTier: '', maxUses: 1 });
  const [msg, setMsg] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/vouchers`).then(setVouchers);
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);

  const create = async () => {
    setMsg('');
    if (!draft.badgeTier.trim()) return setMsg('Give the voucher a badge tier label, e.g. "Organizer".');
    try {
      await api.post(`/api/admin/events/${id}/vouchers`, draft);
      setDraft({ code: '', badgeTier: '', maxUses: 1 });
      load();
    } catch (e) { setMsg(e.message); }
  };

  const editItem = async (voucher, patch) => {
    setMsg('');
    try { await api.patch(`/api/admin/vouchers/${voucher.id}`, patch); load(); }
    catch (e) { setMsg(e.message); }
  };

  const remove = async (voucher) => {
    if (!confirm(`Delete voucher "${voucher.code}"?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/vouchers/${voucher.id}`); load(); }
    catch (e) { setMsg(e.message); }
  };

  if (!event || !vouchers) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Voucher codes</h1>
        </div>
        <Link className="btn" to={`/admin/events/${id}/attendees`}>Attendees</Link>
      </div>
      <p className="small muted" style={{ marginTop: -8, marginBottom: 16 }}>
        Redeeming a valid code on the public event page registers someone for free with a guaranteed spot,
        regardless of tier or capacity, and prints the badge tier label on their badge.
      </p>

      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="card stack" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Codes</h2>
        {vouchers.length === 0 && <Empty title="No voucher codes yet">Add one below for organizers, photographers, or other special badges.</Empty>}
        {vouchers.length > 0 && (
          <div style={{ overflow: 'auto' }}>
            <table>
              <thead><tr><th>Code</th><th>Badge tier</th><th>Uses</th><th>Redeemed by</th><th /></tr></thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.code}</td>
                    <td>
                      <input defaultValue={v.badgeTier} onBlur={(e) => e.target.value !== v.badgeTier && editItem(v, { badgeTier: e.target.value })} style={{ minWidth: 120 }} />
                    </td>
                    <td className="small muted">
                      <input type="number" min={v.usedCount} defaultValue={v.maxUses}
                        onBlur={(e) => Number(e.target.value) !== v.maxUses && editItem(v, { maxUses: e.target.value })}
                        style={{ width: 60 }} /> ({v.usedCount} used, {v.remaining} left)
                    </td>
                    <td className="small muted">
                      {v.redemptions.length === 0 ? '—' : v.redemptions.map((r) => r.fursonaName || r.legalName).join(', ')}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm danger" onClick={() => remove(v)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <input placeholder="Code (optional — auto-generated)" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} style={{ flex: 1 }} />
          <input placeholder="Badge tier, e.g. Organizer" value={draft.badgeTier} onChange={(e) => setDraft({ ...draft, badgeTier: e.target.value })} style={{ flex: 1 }} />
          <input type="number" min="1" placeholder="Max uses" value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })} style={{ width: 100 }} />
          <button className="btn primary" onClick={create}>Add voucher</button>
        </div>
      </div>
    </>
  );
}
