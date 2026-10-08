import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import EventTabs from '../../components/EventTabs.jsx';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const minus = (n) => (n ? `−${money(n)}` : money(0));
const METHOD_LABEL = { CASH: 'Cash', CARD: 'Card', PAYPAL: 'PayPal', STRIPE: 'Stripe (online)', OTHER: 'Other' };
const CATEGORIES = [['tickets', 'Tickets'], ['donations', 'Donations'], ['merch', 'Merch']];

function Stat({ label, value, big }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span className="eyebrow">{label}</span>
      <strong className="mono" style={{ fontSize: big ? 30 : 20 }}>{value}</strong>
    </div>
  );
}

/// One table: a row per payment method that actually has money on it, a
/// column per kind of income. Count shown small next to each amount.
function Breakdown({ data }) {
  const rows = data.methods.filter((m) => CATEGORIES.some(([k]) => data[k][m]?.count));
  if (!rows.length) return <p className="muted" style={{ margin: 0 }}>Nothing collected yet.</p>;
  const cell = (k, m) => {
    const v = data[k][m];
    if (!v?.count) return <span className="muted">-</span>;
    return <>{money(v.total)} <span className="small muted">×{v.count}</span></>;
  };
  const rowTotal = (m) => CATEGORIES.reduce((sum, [k]) => sum + (data[k][m]?.total || 0), 0);
  return (
    <div style={{ overflow: 'auto' }}>
      <table>
        <thead>
          <tr><th>Method</th>{CATEGORIES.map(([k, label]) => <th key={k} style={{ textAlign: 'right' }}>{label}</th>)}<th style={{ textAlign: 'right' }}>Total</th></tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m}>
              <td>{METHOD_LABEL[m] || m}</td>
              {CATEGORIES.map(([k]) => <td key={k} className="mono" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{cell(k, m)}</td>)}
              <td className="mono" style={{ textAlign: 'right' }}><strong>{money(rowTotal(m))}</strong></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            {CATEGORIES.map(([k]) => <td key={k} className="mono" style={{ textAlign: 'right' }}><strong>{money(data[`${k}Total`])}</strong></td>)}
            <td className="mono" style={{ textAlign: 'right' }}><strong>{money(data.grandTotal)}</strong></td>
          </tr>
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

      <div className="card row" style={{ marginBottom: 20, gap: 40, alignItems: 'flex-end' }}>
        <Stat label="Grand total" value={money(data.grandTotal)} big />
        <Stat label="Tickets" value={money(data.ticketsTotal)} />
        <Stat label="Donations" value={money(data.donationsTotal)} />
        <Stat label="Merch" value={money(data.merchTotal)} />
      </div>

      {data.stripe?.count > 0 && (
        <div className="card row" style={{ marginBottom: 20, gap: 40, alignItems: 'flex-end' }}>
          <Stat label="Stripe charged" value={money(data.stripe.grossCents / 100)} />
          <Stat label="Refunded" value={minus(data.stripe.refundedCents / 100)} />
          <Stat label="Stripe fees" value={minus(data.stripe.feeCents / 100)} />
          <Stat label="Net payout" value={money(data.stripe.netCents / 100)} />
        </div>
      )}

      {data.unpaidTickets > 0 && (
        <p className="note" style={{ marginBottom: 20 }}>
          {data.unpaidTickets} registration{data.unpaidTickets === 1 ? '' : 's'} on a paid ticket still owe{data.unpaidTickets === 1 ? 's' : ''} {money(data.unpaidTotal)} in
          total (pay-at-the-door tickets nobody has collected on yet) and {data.unpaidTickets === 1 ? 'is' : 'are'} not counted above.
          Check <Link to={`/admin/events/${id}/attendees`}>Attendees</Link> for the "Owes" tag.
        </p>
      )}

      <div className="card">
        <Breakdown data={data} />
      </div>
    </>
  );
}
