import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Empty, fmtDate } from '../components/Bits.jsx';

export default function Home() {
  const { settings } = useSession();
  const [events, setEvents] = useState(null);

  useEffect(() => { api.get('/api/events').then(setEvents).catch(() => setEvents([])); }, []);

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
            <a href={`https://t.me/${settings.telegramBot}`}>@{settings.telegramBot}</a> — send <code className="mono">/register</code>.
          </p>
        )}
      </header>

      {events === null && <p className="muted">Loading events…</p>}
      {events?.length === 0 && <Empty title="Nothing open yet">Check back soon, or follow the Telegram bot for an announcement.</Empty>}

      <div className="stack" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', display: 'grid' }}>
        {events?.map((e) => (
          <Link key={e.id} to={`/e/${e.slug}`} className="stub" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="stub-accent" style={{ background: e.accentColor }} />
            <div className="stub-head">
              <p className="eyebrow">{fmtDate(e.startsAt, e.timezone)}</p>
              <h2 style={{ margin: '6px 0 4px' }}>{e.title}</h2>
              <p className="muted small" style={{ margin: 0 }}>{e.tagline || e.venue}</p>
            </div>
            <div className="stub-tear" />
            <div className="stub-foot spread">
              <span className="small muted">
                {e.capacity ? `${e.confirmed ?? 0} of ${e.capacity} spots taken` : `${e.confirmed ?? 0} registered`}
              </span>
              <span className="btn sm">Register</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
