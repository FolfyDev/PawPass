import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Pill, fmtDate, fmtMoney } from '../../components/Bits.jsx';
import { PageSkeleton } from '../../components/Skeleton.jsx';

const compact = (n) => new Intl.NumberFormat(undefined, { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/// A share of a limit. The fill carries the state (on track / getting
/// full / at the limit) and the track is a lighter step of the same hue.
function Meter({ value, max, tone = 'go', label }) {
  const p = Math.min(pct(value, max), 100);
  return (
    <div className={`meter ${tone}`} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <span style={{ width: `${p}%` }} />
    </div>
  );
}

/// One headline number: label, value, and a line of context under it.
function Stat({ label, value, sub, to, children }) {
  const body = (
    <>
      <p className="eyebrow" style={{ margin: 0 }}>{label}</p>
      <p className="value">{value}</p>
      {children}
      {sub && <p className="small muted" style={{ margin: 0 }}>{sub}</p>}
    </>
  );
  return to ? <Link className="card stat-tile stat-link" to={to}>{body}</Link> : <div className="card stat-tile">{body}</div>;
}

const LEVEL = {
  bad: { pill: <Pill tone="stop">Fix</Pill> },
  warn: { pill: <Pill tone="wait">Soon</Pill> },
  info: { pill: <Pill>To do</Pill> },
};

function phaseLine(e) {
  if (e.phase === 'live') return <Pill tone="go">Happening now</Pill>;
  if (e.phase === 'ended') return <Pill>Ended</Pill>;
  return <Pill tone="wait">{e.daysUntil === 1 ? 'Tomorrow' : `In ${e.daysUntil} days`}</Pill>;
}

export default function Overview() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setD(null); api.get(`/api/admin/events/${id}/overview`).then(setD).catch((e) => setError(e.message)); }, [id]);

  if (error) return <p className="note bad" style={{ marginTop: 40 }}>{error}</p>;
  if (!d) return <PageSkeleton />;
  const { event: e, registrations: r } = d;
  const base = `/admin/events/${id}`;
  const capTone = e.capacity && r.confirmed >= e.capacity ? 'stop' : e.capacity && r.confirmed >= e.capacity * 0.9 ? 'signal' : 'go';
  const doorTone = d.door.limit && d.door.inside >= d.door.limit ? 'stop' : d.door.limit && d.door.inside >= d.door.limit * 0.9 ? 'signal' : 'go';

  return (
    <>
      <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <p className="row small muted" style={{ margin: '0 0 6px', gap: 8 }}>
            {phaseLine(e)}
            {!e.published && <Pill>Not published</Pill>}
            <span>{fmtDate(e.startsAt, e.timezone)}{e.venue ? ` · ${e.venue}` : ''}</span>
          </p>
          <h1 style={{ margin: 0 }}>{e.title}</h1>
        </div>
        <div className="row">
          <a className="btn" href={`/e/${e.slug}`} target="_blank" rel="noreferrer">{e.published ? 'Public page ↗' : 'Preview ↗'}</a>
          {e.phase !== 'ended' && <Link className="btn signal" to={`/admin/scan/${id}`}>Check-in</Link>}
        </div>
      </div>

      <div className="grid-4 overview-stats">
        <Stat label="Registered" value={compact(r.confirmed)} to={`${base}/attendees`}
          sub={[e.capacity && `of ${compact(e.capacity)} spots`, r.waitlist && `${r.waitlist} waitlisted`, r.pending && `${r.pending} paying now`].filter(Boolean).join(' · ') || 'Confirmed tickets'}>
          {e.capacity ? <Meter value={r.confirmed} max={e.capacity} tone={capTone} label="Spots taken" /> : null}
        </Stat>
        {e.phase === 'live' ? (
          <Stat label="Inside now" value={compact(d.door.inside)} to={`/admin/scan/${id}`}
            sub={`${d.door.entered} arrived today${d.door.limit ? ` · limit ${d.door.limit}` : ''}`}>
            {d.door.limit ? <Meter value={d.door.inside} max={d.door.limit} tone={doorTone} label="Occupancy" /> : null}
          </Stat>
        ) : (
          <Stat label="Checked in" value={compact(r.arrived)} sub={e.phase === 'ended' ? `${pct(r.arrived, r.confirmed)}% of registered came` : 'Opens at the door'} />
        )}
        <Stat label="Money in" value={fmtMoney(d.moneyCents, d.currency)} to={`${base}/reconciliation`} sub="Net of refunds, every source" />
        <Stat label="Open incidents" value={d.incidents.open} to="/admin/incidents"
          sub={d.incidents.high ? `${d.incidents.high} high severity` : d.incidents.scope === 'yours' ? 'That you filed' : 'Nothing urgent'} />
      </div>

      <div className="grid-2" style={{ alignItems: 'start', gap: 20, marginTop: 20 }}>
        <section className="card stack">
          <h2 style={{ margin: 0 }}>Needs attention</h2>
          {d.attention.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nothing right now.</p>
          ) : (
            <ul className="attention">
              {d.attention.map((a, i) => (
                <li key={i}>
                  {LEVEL[a.level].pill}
                  <Link to={a.tab.startsWith('/') ? a.tab : `${base}/${a.tab}`}>{a.text}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="stack" style={{ gap: 12 }}>
          {d.volunteers && (
            <Link className="card stack overview-row" to={`${base}/volunteers`}>
              <div className="spread"><strong>Volunteers</strong><span className="small muted">{d.volunteers.filled} of {d.volunteers.slots} slots · {d.volunteers.shifts} shifts</span></div>
              <Meter value={d.volunteers.filled} max={d.volunteers.slots} tone={d.volunteers.filled >= d.volunteers.slots ? 'go' : 'signal'} label="Volunteer slots filled" />
            </Link>
          )}
          {d.hotels && (
            <Link className="card stack overview-row" to={`${base}/hotels`}>
              <div className="spread"><strong>Hotel pickup</strong><span className="small muted">{d.hotels.pickedUp} of {d.hotels.contracted} room nights · {pct(d.hotels.pickedUp, d.hotels.contracted)}%</span></div>
              <Meter value={d.hotels.pickedUp} max={d.hotels.contracted} tone={pct(d.hotels.pickedUp, d.hotels.contracted) >= 80 ? 'go' : 'signal'} label="Hotel room nights picked up" />
            </Link>
          )}
          {d.vendors && (
            <Link className="card stack overview-row" to={`${base}/vendors`}>
              <div className="spread"><strong>Vendor tables</strong><span className="small muted">{d.vendors.taken} of {d.vendors.tables} given out{d.vendors.feeDue ? ` · ${d.vendors.feeDue} fee${d.vendors.feeDue === 1 ? '' : 's'} due` : ''}</span></div>
              <Meter value={d.vendors.taken} max={d.vendors.tables} tone="go" label="Vendor tables given out" />
            </Link>
          )}
          {d.program && (
            <Link className="card stack overview-row" to={`${base}/schedule`}>
              <div className="spread">
                <strong>Program</strong>
                <span className="small muted">
                  {d.program.published} published{d.program.drafts ? ` · ${d.program.drafts} drafts` : ''}{d.program.unscheduled ? ` · ${d.program.unscheduled} unscheduled` : ''}
                </span>
              </div>
            </Link>
          )}
          {!d.volunteers && !d.hotels && !d.vendors && !d.program && (
            <div className="card">
              <p className="small muted" style={{ margin: 0 }}>
                Volunteers, hotels, the schedule and vendors show up here once you set them up from the sidebar.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
