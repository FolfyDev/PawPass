import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Empty, StatusPill, RsvpButtons, fmtDate } from '../components/Bits.jsx';

export default function Tickets() {
  const { settings } = useSession();
  const [tickets, setTickets] = useState(null);
  const load = () => api.get('/api/my/tickets').then(setTickets);
  useEffect(() => { load(); }, []);

  const google = async (code) => {
    try { window.location.href = (await api.get(`/api/my/tickets/${code}/google`)).url; }
    catch (e) { alert(e.message); }
  };

  const rsvp = async (code, value) => {
    const updated = await api.post(`/api/my/tickets/${code}/rsvp`, { rsvp: value });
    setTickets((cur) => cur.map((t) => (t.code === code ? { ...t, rsvp: updated.rsvp } : t)));
  };

  if (!tickets) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  return (
    <>
      <header style={{ padding: '40px 0 24px' }}>
        <p className="eyebrow">Your wallet</p>
        <h1>Tickets</h1>
      </header>

      {tickets.length === 0 && <Empty title="No tickets yet">Pick an event from the home page to register.</Empty>}

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))' }}>
        {tickets.map((t) => (
          <div key={t.code} className="stub">
            <div className="stub-accent" style={{ background: t.event.accentColor }} />
            <div className="stub-head">
              <p className="eyebrow">{fmtDate(t.event.startsAt, t.event.timezone)}</p>
              <h2 style={{ margin: '4px 0 2px' }}>{t.event.title}</h2>
              <p className="small muted" style={{ margin: 0 }}>{t.event.venue}</p>
              <div style={{ margin: '18px 0 6px', display: 'grid', placeItems: 'center' }}>
                <img alt={`QR code for ${t.code}`} width="190" height="190"
                  src={`${api.base}/api/my/tickets/${t.code}/qr.png`} style={{ borderRadius: 8 }} />
              </div>
              <p className="code" style={{ textAlign: 'center', margin: 0 }}>{t.code}</p>
              <p className="small muted" style={{ textAlign: 'center' }}>{settings?.ticketFooter}</p>
            </div>
            <div className="stub-tear" />
            <div className="stub-foot stack">
              <div className="spread">
                <span className="small muted">{t.fursonaName || t.legalName}</span>
                <StatusPill status={t.status} checkedInAt={t.checkedInAt} />
              </div>
              {t.status !== 'CANCELLED' && (
                <div>
                  <p className="eyebrow" style={{ marginBottom: 6 }}>Going?</p>
                  <RsvpButtons value={t.rsvp} onChange={(v) => rsvp(t.code, v)} />
                </div>
              )}
              <div className="row">
                {settings?.wallet?.apple && (
                  <a className="btn sm" href={`${api.base}/api/my/tickets/${t.code}/apple.pkpass`}>Add to Apple Wallet</a>
                )}
                {settings?.wallet?.google && (
                  <button className="btn sm" onClick={() => google(t.code)}>Add to Google Wallet</button>
                )}
              </div>
              {!settings?.wallet?.apple && !settings?.wallet?.google && (
                <p className="small muted" style={{ margin: 0 }}>Wallet passes are not set up on this instance — screenshot the code instead.</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
