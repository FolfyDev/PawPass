import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { eventDayState } from '../../lib/checkin.js';
import { usePageMeta } from '../../lib/meta.js';
import { Empty, Pill, fmtDate } from '../../components/Bits.jsx';

const DAY_ORDER = { today: 0, upcoming: 1, ended: 2 };

function DayPill({ state }) {
  if (state === 'today') return <Pill tone="go">Today</Pill>;
  if (state === 'upcoming') return <Pill>Upcoming</Pill>;
  return <Pill>Ended</Pill>;
}

export default function CheckInSelect() {
  usePageMeta({ title: 'Check in', noindex: true });
  const [events, setEvents] = useState(null);

  useEffect(() => { api.get('/api/admin/events').then(setEvents).catch(() => setEvents([])); }, []);

  // Today's events first, then upcoming (soonest first), then past (most recent first).
  const sorted = events
    ?.map((e) => ({ ...e, day: eventDayState(e) }))
    .sort((a, b) => {
      if (a.day !== b.day) return DAY_ORDER[a.day] - DAY_ORDER[b.day];
      const diff = new Date(a.startsAt) - new Date(b.startsAt);
      return a.day === 'ended' ? -diff : diff;
    });

  return (
    <>
      <p className="eyebrow">Door operations</p>
      <h1>Check in &amp; print</h1>
      <p className="muted">Which event are you checking in for?</p>

      {events === null && <p className="muted">Loading events…</p>}
      {events?.length === 0 && <Empty title="No events yet">Create an event first, then come back here to check people in.</Empty>}

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill,minmax(min(300px,100%),1fr))' }}>
        {sorted?.map((e) => (
          <Link key={e.id} to={`/admin/scan/${e.id}`} className="stub" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="stub-accent" style={{ background: e.accentColor }} />
            <div className="stub-head">
              <p className="eyebrow">{fmtDate(e.startsAt, e.timezone)}</p>
              <h2 style={{ margin: '6px 0 4px' }}>{e.title}</h2>
              <p className="muted small" style={{ margin: '0 0 12px' }}>
                {e.venue ? `${e.venue} · ` : ''}{e.registrationCount} registered
              </p>
              <div className="row">
                <DayPill state={e.day} />
                {!e.published && <Pill tone="wait">Draft</Pill>}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
