import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { usePageMeta } from '../../lib/meta.js';

const RANGE_OPTIONS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: 0 },
];

const STATUS_COLOR = { CONFIRMED: 'var(--go)', WAITLIST: 'var(--signal)', CANCELLED: 'var(--stop)' };
const STATUS_LABEL = { CONFIRMED: 'Confirmed', WAITLIST: 'Waitlist', CANCELLED: 'Cancelled' };
const SOURCE_LABEL = { web: 'Web', telegram: 'Telegram', admin: 'Kiosk' };

const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });


function niceMax(max) {
  if (max <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function DailyChart({ daily }) {
  const [hover, setHover] = useState(null);
  const max = niceMax(Math.max(1, ...daily.map((d) => d.count)));
  const ticks = [0, max / 2, max];
  const W = 720, H = 200, padL = 30, padB = 22, padT = 10, padR = 6;
  const plotW = W - padL - padR, plotH = H - padB - padT;
  const n = daily.length || 1;
  const band = plotW / n;
  const barW = Math.max(2, Math.min(22, band - 2));
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.map((t) => {
          const y = padT + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--rule)" strokeWidth="1" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9.5" fill="var(--ink-3)" fontFamily="var(--mono)">{Math.round(t)}</text>
            </g>
          );
        })}
        {daily.map((d, i) => {
          const x = padL + i * band + (band - barW) / 2;
          const h = max ? (d.count / max) * plotH : 0;
          const y = padT + plotH - h;
          const r = Math.min(4, barW / 2, h);
          const path = h <= 0 ? '' :
            `M${x},${padT + plotH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${padT + plotH} Z`;
          return (
            <g key={d.date} onMouseEnter={() => setHover({ i, x: x + barW / 2, y })} onMouseLeave={() => setHover((h2) => (h2?.i === i ? null : h2))}>
              <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
              {h > 0 && <path d={path} fill={hover?.i === i ? 'var(--platform)' : 'color-mix(in srgb, var(--platform) 78%, transparent)'} />}
              {i % labelEvery === 0 && (
                <text x={padL + i * band + band / 2} y={H - 6} textAnchor="middle" fontSize="9.5" fill="var(--ink-3)">{shortDate(d.date)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="bar-tooltip" style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }}>
          {shortDate(daily[hover.i].date)} · {daily[hover.i].count}
        </div>
      )}
    </div>
  );
}

function StatusBar({ byStatus }) {
  const total = byStatus.reduce((s, b) => s + b.count, 0) || 1;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--paper)', gap: 2 }}>
        {byStatus.map((b) => b.count > 0 && (
          <div key={b.status} title={`${STATUS_LABEL[b.status]}: ${b.count}`}
            style={{ width: `${(b.count / total) * 100}%`, background: STATUS_COLOR[b.status] }} />
        ))}
      </div>
      <div className="legend">
        {byStatus.map((b) => (
          <span className="legend-item" key={b.status}>
            <span className="legend-key" style={{ background: STATUS_COLOR[b.status] }} />
            {STATUS_LABEL[b.status]} · {b.count}
          </span>
        ))}
      </div>
    </div>
  );
}

function SourceBars({ bySource }) {
  const max = Math.max(1, ...bySource.map((s) => s.count));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {bySource.map((s) => (
        <div className="rank-bar-row" key={s.source}>
          <span className="small muted">{SOURCE_LABEL[s.source] || s.source}</span>
          <div className="rank-bar-track"><div className="rank-bar-fill" style={{ width: `${(s.count / max) * 100}%` }} /></div>
          <span className="mono small" style={{ textAlign: 'right' }}>{s.count}</span>
        </div>
      ))}
    </div>
  );
}

export default function Analytics() {
  const { user } = useSession();
  usePageMeta({ title: 'Analytics', noindex: true });
  const isOwner = user.role === 'OWNER';
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => { if (isOwner) api.get('/api/admin/events').then(setEvents); }, [isOwner]);
  useEffect(() => {
    if (!isOwner) return;
    const q = new URLSearchParams({ days, ...(eventId && { eventId }) });
    api.get(`/api/admin/analytics?${q}`).then(setData);
  }, [isOwner, eventId, days]);

  if (!isOwner) return <p className="note bad" style={{ marginTop: 40 }}>You do not have permission to access this page.</p>;

  return (
    <>
      <p className="eyebrow">Instance</p>
      <h1>Analytics</h1>

      <div className="filter-row">
        <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">All events</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
        <div className="seg">
          {RANGE_OPTIONS.map((r) => (
            <button key={r.days} aria-current={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>
          ))}
        </div>
      </div>

      {!data ? <p className="muted">Loading…</p> : (
        <>
          <div className="grid-4" style={{ marginBottom: 20 }}>
            <div className="card stat-tile">
              <p className="eyebrow" style={{ margin: 0 }}>Registrations</p>
              <p className="value">{data.totals.total.toLocaleString()}</p>
            </div>
            <div className="card stat-tile">
              <p className="eyebrow" style={{ margin: 0 }}>Checked in</p>
              <p className="value">{data.totals.checkedIn.toLocaleString()}</p>
              <p className="small muted" style={{ margin: 0 }}>
                {data.totals.total ? Math.round((data.totals.checkedIn / data.totals.total) * 100) : 0}% of the above
              </p>
            </div>
            <div className="card stat-tile">
              <p className="eyebrow" style={{ margin: 0 }}>Waitlisted</p>
              <p className="value">{(data.byStatus.find((s) => s.status === 'WAITLIST')?.count ?? 0).toLocaleString()}</p>
            </div>
            <div className="card stat-tile">
              <p className="eyebrow" style={{ margin: 0 }}>Registered today</p>
              <p className="value">{data.totals.today.toLocaleString()}</p>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Registrations per day</h2>
              <button className="btn sm ghost" onClick={() => setShowTable((s) => !s)}>{showTable ? 'Hide table' : 'View as table'}</button>
            </div>
            {data.daily.length === 0
              ? <p className="small muted">No registrations in this range.</p>
              : <DailyChart daily={data.daily} />}
            {showTable && (
              <div style={{ marginTop: 14, maxHeight: 240, overflow: 'auto' }}>
                <table>
                  <thead><tr><th>Date</th><th>Registrations</th></tr></thead>
                  <tbody>
                    {[...data.daily].reverse().map((d) => (
                      <tr key={d.date}><td>{d.date}</td><td className="mono">{d.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid-2">
            <div className="card">
              <h2 style={{ margin: '0 0 14px', fontSize: 16 }}>By status</h2>
              <StatusBar byStatus={data.byStatus} />
            </div>
            <div className="card">
              <h2 style={{ margin: '0 0 14px', fontSize: 16 }}>By sign-up channel</h2>
              {data.bySource.length === 0
                ? <p className="small muted">No registrations in this range.</p>
                : <SourceBars bySource={data.bySource} />}
            </div>
          </div>
        </>
      )}
    </>
  );
}
