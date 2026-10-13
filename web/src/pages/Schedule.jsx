import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import { downloadIcs } from '../lib/ics.js';
import { Empty, Pill, fmtNight } from '../components/Bits.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';

const timeIn = (d, tz) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
const dayOf = (d, tz) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });

/// The public schedule: one day at a time, grouped by start time, with a
/// star on each session and a "My schedule" view of the starred ones.
export default function Schedule() {
  const { slug } = useParams();
  const { user } = useSession();
  const [event, setEvent] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [track, setTrack] = useState('');
  const [starred, setStarred] = useState(new Set());
  usePageMeta({ title: event ? `Schedule · ${event.title}` : 'Schedule', description: event?.tagline });

  useEffect(() => {
    api.get(`/api/events/${slug}`).then(setEvent).catch(() => {});
    api.get(`/api/events/${slug}/schedule`).then((d) => {
      setData(d);
      setStarred(new Set(d.starred));
      // Open on today if the event is on, otherwise its first day with anything.
      const today = dayOf(new Date(), d.timezone);
      const withSessions = d.days.filter((x) => d.sessions.some((s) => dayOf(s.startsAt, d.timezone) === x));
      setDay(withSessions.includes(today) ? today : withSessions[0] || d.days[0]);
    }).catch((e) => setError(e.message));
  }, [slug, user]);

  const tracks = useMemo(() => [...new Set((data?.sessions || []).map((s) => s.track).filter(Boolean))].sort(), [data]);

  if (error) return <p className="note bad" style={{ marginTop: 40 }}>{error} <Link to={`/e/${slug}`}>Back to the event</Link></p>;
  if (!data || !event) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;
  const tz = data.timezone;

  const toggleStar = async (s) => {
    if (!user) return;
    const on = !starred.has(s.id);
    const next = new Set(starred);
    if (on) next.add(s.id); else next.delete(s.id);
    setStarred(next);
    try {
      if (on) await api.put(`/api/my/stars/${s.id}`); else await api.del(`/api/my/stars/${s.id}`);
    } catch {
      setStarred(starred); // put it back the way it was
    }
  };

  const visible = data.sessions.filter((s) => (mineOnly || dayOf(s.startsAt, tz) === day)
    && (!mineOnly || starred.has(s.id)) && (!track || s.track === track));
  const groups = [];
  for (const s of visible) {
    const key = mineOnly ? `${dayOf(s.startsAt, tz)} ${s.startsAt}` : s.startsAt;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(s); else groups.push({ key, at: s.startsAt, items: [s] });
  }
  const mine = data.sessions.filter((s) => starred.has(s.id));

  return (
    <>
      <header style={{ padding: '40px 0 16px' }}>
        <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: event.title, to: `/e/${slug}` }, { label: 'Schedule' }]} />
        <p className="eyebrow">{event.title}</p>
        <h1 style={{ margin: 0 }}>Schedule</h1>
        <p className="small muted">Times are {event.venue ? `local to ${event.venue}` : `in ${tz}`}.</p>
      </header>

      <div className="schedule-bar">
        <div className="seg" role="tablist" aria-label="Day">
          {data.days.map((d) => (
            <button key={d} role="tab" aria-current={!mineOnly && day === d ? 'true' : undefined} onClick={() => { setDay(d); setMineOnly(false); }}>
              {fmtNight(d, { weekday: 'short', month: 'short', day: 'numeric' })}
            </button>
          ))}
          {user && <button role="tab" aria-current={mineOnly ? 'true' : undefined} onClick={() => setMineOnly(true)}>★ My schedule ({mine.length})</button>}
        </div>
        <div className="row">
          {tracks.length > 0 && (
            <select value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Track" style={{ width: 'auto' }}>
              <option value="">All tracks</option>
              {tracks.map((t) => <option key={t}>{t}</option>)}
            </select>
          )}
          {user && mine.length > 0 && (
            <button className="btn sm" onClick={() => downloadIcs(mine.map((s) => ({
              uid: s.id, title: s.title, startsAt: s.startsAt, endsAt: s.endsAt,
              venue: [s.room?.name, event.venue].filter(Boolean).join(', '), description: [s.hosts && `With ${s.hosts}`, s.description].filter(Boolean).join('\n\n'),
            })), `${event.title} my schedule`)}>Add my schedule to calendar</button>
          )}
        </div>
      </div>
      {!user && <p className="small muted"><Link to="/login">Sign in</Link> to star sessions and build your own schedule.</p>}

      {groups.length === 0 ? (
        <Empty title={mineOnly ? 'Nothing starred yet' : 'Nothing scheduled'}>
          {mineOnly ? 'Star sessions to collect them here.' : track ? 'Nothing in this track on this day.' : 'Check another day.'}
        </Empty>
      ) : (
        <div className="schedule">
          {groups.map((g) => (
            <section key={g.key} className="schedule-slot">
              <div className="schedule-time">
                {mineOnly && <span className="small muted">{fmtNight(dayOf(g.at, tz), { weekday: 'short' })}</span>}
                <strong>{timeIn(g.at, tz)}</strong>
              </div>
              <div className="stack" style={{ gap: 10 }}>
                {g.items.map((s) => (
                  <article key={s.id} className={`card session${starred.has(s.id) ? ' starred' : ''}`}>
                    <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <h3 style={{ margin: 0 }}>{s.title}</h3>
                        <p className="small muted" style={{ margin: '2px 0 0' }}>
                          {timeIn(s.startsAt, tz)} – {timeIn(s.endsAt, tz)}{s.room ? ` · ${s.room.name}` : ''}{s.hosts ? ` · ${s.hosts}` : ''}
                        </p>
                      </div>
                      {user && (
                        <button className={`star${starred.has(s.id) ? ' on' : ''}`} aria-pressed={starred.has(s.id)}
                          aria-label={starred.has(s.id) ? `Remove ${s.title} from my schedule` : `Add ${s.title} to my schedule`}
                          onClick={() => toggleStar(s)}>★</button>
                      )}
                    </div>
                    {s.track && <Pill>{s.track}</Pill>}
                    {s.description && <p className="small" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{s.description}</p>}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
