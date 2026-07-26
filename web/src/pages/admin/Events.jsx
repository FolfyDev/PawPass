import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Empty, Pill, fmtDate } from '../../components/Bits.jsx';

export default function Events() {
  const [events, setEvents] = useState(null);
  const nav = useNavigate();

  const load = () => api.get('/api/admin/events').then(setEvents);
  useEffect(() => { load(); }, []);

  const create = async () => {
    const title = prompt('Event name');
    if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const e = await api.post('/api/admin/events', { title, slug });
    nav(`/admin/events/${e.id}`);
  };

  return (
    <>
      <div className="spread" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Events</h1>
        <button className="btn primary" onClick={create}>New event</button>
      </div>

      {events?.length === 0 && <Empty title="No events yet">Create one, then publish it when you are ready for sign-ups.</Empty>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead><tr><th>Event</th><th>When</th><th>Registered</th><th>Status</th><th /></tr></thead>
          <tbody>
            {events?.map((e) => (
              <tr key={e.id}>
                <td><Link to={`/admin/events/${e.id}`}><strong>{e.title}</strong></Link><br /><span className="small muted mono">/{e.slug}</span></td>
                <td className="small">{fmtDate(e.startsAt, e.timezone)}</td>
                <td>{e.registrationCount}{e.capacity ? ` / ${e.capacity}` : ''}</td>
                <td>{e.published ? <Pill tone="go">Live</Pill> : <Pill>Draft</Pill>}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link className="btn sm" to={`/admin/events/${e.id}/attendees`}>Attendees</Link>{' '}
                  <Link className="btn sm" to={`/admin/events/${e.id}/kiosk`}>Kiosk</Link>{' '}
                  <Link className="btn sm" to={`/admin/events/${e.id}/merch`}>Merch</Link>{' '}
                  <Link className="btn sm" to={`/admin/events/${e.id}/reconciliation`}>Cash</Link>{' '}
                  <Link className="btn sm" to={`/admin/events/${e.id}/vouchers`}>Vouchers</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
