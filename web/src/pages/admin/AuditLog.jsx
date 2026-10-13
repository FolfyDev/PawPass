import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Avatar, Empty } from '../../components/Bits.jsx';
import { RowsSkeleton } from '../../components/Skeleton.jsx';

const dayKey = (d) => new Date(d).toLocaleDateString('en-CA');
function dayLabel(d) {
  const key = dayKey(d);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (key === dayKey(today)) return 'Today';
  if (key === dayKey(yesterday)) return 'Yesterday';
  return new Date(d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: new Date(d).getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const timeOf = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/// What staff (and the system) did, newest first: a sentence per entry with
/// the thing it was done to, named and linked, and the details underneath.
export default function AuditLog() {
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [areas, setAreas] = useState([]);
  const [actors, setActors] = useState([]);
  const [area, setArea] = useState('');
  const [actor, setActor] = useState('');
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const query = (before) => {
    const p = new URLSearchParams({ limit: '50' });
    if (area) p.set('area', area);
    if (actor) p.set('actor', actor);
    if (before) p.set('before', before);
    return api.get(`/api/admin/audit?${p}`);
  };

  useEffect(() => {
    setRows(null);
    setError('');
    query().then((r) => {
      setRows(r.rows);
      setNext(r.next);
      setAreas(r.areas);
      if (r.actors && !actors.length) setActors(r.actors);
    }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, actor]);

  const loadMore = async () => {
    setMore(true);
    try {
      const r = await query(next);
      setRows((cur) => [...cur, ...r.rows]);
      setNext(r.next);
    } catch (e) { setError(e.message); }
    finally { setMore(false); }
  };

  const needle = q.trim().toLowerCase();
  const shown = (rows || []).filter((r) => !needle || [
    r.summary, r.actor?.name, r.target?.label, r.target?.sub, ...r.details.map((d) => `${d.label} ${d.value}`),
  ].some((v) => v && v.toLowerCase().includes(needle)));
  const days = [];
  for (const r of shown) {
    const key = dayKey(r.at);
    if (days[days.length - 1]?.key === key) days[days.length - 1].rows.push(r);
    else days.push({ key, label: dayLabel(r.at), rows: [r] });
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">Instance</p>
          <h1 style={{ margin: 0 }}>Audit log</h1>
        </div>
      </div>

      <div className="filter-row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Search what's loaded" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 'auto', flex: '1 1 220px' }} aria-label="Search the audit log" />
        <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Who">
          <option value="">Everyone</option>
          <option value="system">Automatic (no one)</option>
          {actors.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
        </select>
      </div>
      <div className="chips" style={{ marginBottom: 20 }} role="radiogroup" aria-label="Area">
        {[{ key: '', label: 'Everything' }, ...areas].map((a) => (
          <button key={a.key} type="button" role="radio" aria-checked={area === a.key} className={`chip sm${area === a.key ? ' selected' : ''}`} onClick={() => setArea(a.key)}>
            {a.label}
          </button>
        ))}
      </div>

      {error && <p className="note bad">{error}</p>}
      {rows === null && !error && <RowsSkeleton rows={8} />}
      {rows?.length === 0 && <Empty title="Nothing logged here">{area || actor ? 'Try another filter.' : 'Actions staff take in the admin area will show up here.'}</Empty>}
      {rows?.length > 0 && shown.length === 0 && <Empty title="No matches">Nothing loaded matches "{q}". Load more, or clear the search.</Empty>}

      <div className="stack" style={{ gap: 22 }}>
        {days.map((day) => (
          <section key={day.key}>
            <p className="eyebrow" style={{ margin: '0 0 8px' }}>{day.label}</p>
            <ol className="audit-feed card">
              {day.rows.map((r) => (
                <li key={r.id} className="audit-entry">
                  <time className="audit-time" dateTime={r.at} title={new Date(r.at).toLocaleString()}>{timeOf(r.at)}</time>
                  {r.actor ? <Avatar name={r.actor.name} size={28} /> : <span className="audit-system" aria-hidden="true">⚙</span>}
                  <div className="audit-body">
                    <p className="audit-line">
                      <strong>{r.actor?.name || 'Automatic'}</strong>{' '}
                      <span className="muted">{r.summary.charAt(0).toLowerCase() + r.summary.slice(1)}</span>
                      {r.target && <>
                        {' · '}
                        {r.target.href && !r.target.deleted
                          ? <Link to={r.target.href} className="audit-target">{r.target.label}</Link>
                          : <span className={`audit-target${r.target.deleted ? ' deleted' : ''}`}>{r.target.label}</span>}
                        {r.target.deleted && <span className="small muted"> (deleted)</span>}
                        {r.target.sub && <span className="small muted"> · {r.target.sub}</span>}
                      </>}
                    </p>
                    {r.details.length > 0 && (
                      <dl className="audit-details">
                        {r.details.map((d) => (
                          <div key={d.label}>
                            <dt>{d.label}</dt>
                            <dd>{d.href ? <Link to={d.href}>{d.value}</Link> : d.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {next && rows && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
          <button className="btn" disabled={more} data-busy={more ? 'true' : undefined} onClick={loadMore}>{more ? 'Loading…' : 'Load older entries'}</button>
        </div>
      )}
    </>
  );
}
