import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { usePageMeta } from '../../lib/meta.js';

const POLL_MS = 2500;
const WELCOME_MS = 4500;

/// A read-only, second-monitor view meant to run fullscreen facing the
/// crowd, not the staff working the scanner. It only ever learns about
/// successful check-ins (it polls the same registrations list Attendees.jsx
/// uses and watches checkedInAt) — a waitlisted or cancelled scan has
/// nothing to poll for here, so there's no failure state to accidentally
/// broadcast to a room full of people. No database or API changes: both
/// endpoints it polls already exist and are already staff-authenticated.
export default function CheckInDisplay() {
  const { eventId } = useParams();
  const { settings } = useSession();
  usePageMeta({ title: 'Check-in display', noindex: true });

  const [event, setEvent] = useState(null);
  const [count, setCount] = useState(0);
  const [welcome, setWelcome] = useState(null); // { name, number } | null
  const queueRef = useRef([]);
  // Anything checked in before the display mounted is the pre-existing
  // tally, not a fresh arrival — a fixed wall-clock reference, not "whatever
  // the first poll happened to return", so it can't be thrown off by which
  // poll response lands first (see the in-flight guard below).
  const lastSeenRef = useRef(new Date().toISOString());
  const showingRef = useRef(false);

  useEffect(() => {
    api.get(`/api/admin/events/${eventId}`).then(setEvent).catch(() => setEvent(null));
  }, [eventId]);

  const advanceQueue = () => {
    if (showingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    showingRef.current = true;
    setWelcome(next);
    setTimeout(() => {
      showingRef.current = false;
      setWelcome(null);
      setTimeout(advanceQueue, 300); // a beat of idle between back-to-back arrivals
    }, WELCOME_MS);
  };

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const poll = async () => {
      // Without this guard, a slow response (or React StrictMode's
      // double-invoked effect in dev) could have two requests in flight at
      // once with no guarantee they resolve in order — a request is never
      // sent while the previous one is still pending.
      if (inFlight) return;
      inFlight = true;
      try {
        const rows = await api.get(`/api/admin/events/${eventId}/registrations`);
        if (stopped) return;
        const checkedIn = rows
          .filter((r) => r.checkedInAt)
          .sort((a, b) => new Date(a.checkedInAt) - new Date(b.checkedInAt));
        setCount(checkedIn.length);

        const fresh = checkedIn.filter((r) => r.checkedInAt > lastSeenRef.current);
        if (fresh.length) {
          lastSeenRef.current = fresh[fresh.length - 1].checkedInAt;
          const startNumber = checkedIn.length - fresh.length + 1;
          fresh.forEach((r, i) => queueRef.current.push({ name: r.fursonaName || r.legalName, number: startNumber + i }));
          advanceQueue();
        }
      } catch { /* a missed poll just tries again in POLL_MS — nothing to show for it */ }
      finally { inFlight = false; }
    };

    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { stopped = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const accent = event?.accentColor || '#ff5b04';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, overflow: 'hidden',
        display: 'grid', placeItems: 'center', textAlign: 'center',
        background: `radial-gradient(circle at 50% 40%, color-mix(in srgb, ${accent} 20%, #0b0d10) 0%, #0b0d10 70%)`,
        color: '#fff', padding: '5vh 5vw',
      }}
    >
      <div key={welcome ? welcome.number : 'idle'} className="checkin-display-fade">
        {welcome ? (
          <>
            <p style={{ font: '600 3vw var(--mono)', letterSpacing: '.2em', textTransform: 'uppercase', color: accent, margin: '0 0 2vh' }}>
              Welcome
            </p>
            <h1 style={{ font: '800 9vw var(--display)', lineHeight: 1, margin: 0, wordBreak: 'break-word' }}>{welcome.name}</h1>
            <p style={{ font: '500 1.6vw var(--body)', color: 'rgba(255,255,255,.7)', marginTop: '3vh' }}>
              You're #{welcome.number} today
            </p>
          </>
        ) : (
          <>
            {settings?.logoUrl
              ? <img src={settings.logoUrl} alt="" style={{ maxHeight: '14vh', maxWidth: '60vw', marginBottom: '4vh' }} />
              : <p style={{ font: '800 4vw var(--display)', margin: '0 0 2vh' }}>{settings?.orgName || 'PawPass'}</p>}
            <h1 style={{ font: '700 4.5vw var(--display)', lineHeight: 1.15, margin: 0, color: accent }}>
              {event?.title || 'Check-in'}
            </h1>
            <p style={{ font: '500 1.6vw var(--body)', color: 'rgba(255,255,255,.6)', marginTop: '3vh' }}>
              Scan your badge to check in
            </p>
          </>
        )}
      </div>

      <p style={{
        position: 'absolute', bottom: '4vh', right: '4vw', margin: 0,
        font: '600 1.4vw var(--mono)', letterSpacing: '.08em', color: 'rgba(255,255,255,.45)',
      }}>
        {count.toLocaleString()} checked in
      </p>
    </div>
  );
}
