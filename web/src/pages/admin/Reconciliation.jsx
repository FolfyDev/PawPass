import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import EventTabs from '../../components/EventTabs.jsx';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const METHODS = ['CASH', 'CARD', 'PAYPAL', 'OTHER'];

function MethodTable({ title, byMethod, total }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <p className="eyebrow" style={{ padding: '14px 16px 0' }}>{title}</p>
      <table>
        <thead><tr><th>Method</th><th>Count</th><th>Total</th></tr></thead>
        <tbody>
          {METHODS.map((m) => (
            <tr key={m}>
              <td>{m}</td>
              <td className="mono">{byMethod[m]?.count ?? 0}</td>
              <td className="mono">{money(byMethod[m]?.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td><strong>Total</strong></td><td /><td className="mono"><strong>{money(total)}</strong></td></tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function Reconciliation() {
  const { id } = useParams();
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/api/admin/events/${id}`).then(setEvent);
    api.get(`/api/admin/events/${id}/reconciliation`).then(setData);
  }, [id]);

  if (!event || !data) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Cash reconciliation</h1>
        </div>
        <a className="btn" href={`${api.base}/api/admin/events/${id}/reconciliation.csv`}>Export CSV</a>
      </div>
      <EventTabs id={id} />

      <div className="card" style={{ marginBottom: 20 }}>
        <p className="eyebrow" style={{ marginBottom: 4 }}>Grand total collected</p>
        <p style={{ fontSize: 32, fontWeight: 700, margin: 0 }}>{money(data.grandTotal)}</p>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          {money(data.donationsTotal)} from donations · {money(data.merchTotal)} from merch
        </p>
      </div>

      {data.unrecordedDonations > 0 && (
        <p className="note" style={{ marginBottom: 20 }}>
          {data.unrecordedDonations} donation-tier registration{data.unrecordedDonations === 1 ? '' : 's'} with no payment method recorded
          (paid — or not — via the PayPal link on their own, never confirmed at the door) are excluded from this total.
          Check <Link to={`/admin/events/${id}/attendees`}>Attendees</Link> for the "Unrecorded" tag.
        </p>
      )}

      <div className="grid-2" style={{ gap: 20 }}>
        <MethodTable title="Donations (registrations + in-person)" byMethod={data.donations} total={data.donationsTotal} />
        <MethodTable title="Merch sales" byMethod={data.merch} total={data.merchTotal} />
      </div>
    </>
  );
}
