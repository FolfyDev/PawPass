import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import { Empty, fmtDate } from '../components/Bits.jsx';
import { EventCardsSkeleton } from '../components/Skeleton.jsx';

export default function Home() {
  const { settings } = useSession();
  usePageMeta({ description: settings?.tagline });
  const [events, setEvents] = useState(null);

  useEffect(() => { api.get('/api/events').then(setEvents).catch(() => setEvents([])); }, []);
  // The server leaves past events out when the settings page says to.
  const now = Date.now();
  const upcoming = (events || []).filter((e) => new Date(e.endsAt) >= now);
  const past = (events || []).filter((e) => new Date(e.endsAt) < now).reverse();

  return (
    <>
      <header style={{ padding: '52px 0 34px', maxWidth: 640 }}>
        <p className="eyebrow">{settings?.orgName}</p>
        <div className="hero-rule" style={{ maxWidth: 80 }} />
        <h1>{settings?.tagline || 'Registration for community events'}</h1>
        <p className="muted">{settings?.welcomeMessage}</p>
        {settings?.telegramBot && (
          <p className="small muted">
            Prefer chat? Register through{' '}
            <a href={`https://t.me/${settings.telegramBot}`}>@{settings.telegramBot}</a>: send <code className="mono">/register</code>.
          </p>
        )}
      </header>

      {events === null && <EventCardsSkeleton />}
      {events && upcoming.length === 0 && (
        <Empty title="Nothing open yet">{settings?.noEventsMessage || 'Check back soon, or follow the Telegram bot for an announcement.'}</Empty>
      )}

      <EventGrid events={upcoming} />
      {past.length > 0 && (
        <>
          <h2 style={{ margin: '36px 0 14px' }}>Past events</h2>
          <EventGrid events={past} ended />
        </>
      )}
    </>
  );
}

function EventGrid({ events, ended = false }) {
  if (!events.length) return null;
  return (
    <div className="stack" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(min(300px,100%),1fr))', display: 'grid' }}>
      {events.map((e) => (
        <Link key={e.id} to={`/e/${e.slug}`} className="stub" style={{ textDecoration: 'none', color: 'inherit', opacity: ended ? 0.75 : 1 }}>
          <div className="stub-accent" style={{ background: e.accentColor }} />
          <div className="stub-head">
            <p className="eyebrow">{fmtDate(e.startsAt, e.timezone)}</p>
            <h2 style={{ margin: '6px 0 4px' }}>{e.title}</h2>
            <p className="muted small" style={{ margin: 0 }}>{e.tagline || e.venue}</p>
          </div>
          <div className="stub-tear" />
          <div className="stub-foot spread">
            <span className="small muted">
              {e.confirmed ?? 0} {ended ? 'attended' : 'registered'}
            </span>
            {ended ? <span className="small muted">Ended</span> : <span className="btn sm">Register</span>}
          </div>
        </Link>
      ))}
    </div>
  );
}
