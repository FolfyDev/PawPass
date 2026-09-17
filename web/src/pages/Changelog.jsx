import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import { Pill } from '../components/Bits.jsx';
import entries from '../data/changelog.json';

const fmtVersionDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function ChangeList({ highlights, style }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20, ...style }}>
      {highlights.map((h, i) => <li key={i} style={{ marginBottom: 6 }}>{h}</li>)}
    </ul>
  );
}

export default function Changelog() {
  const { isStaff } = useSession();
  usePageMeta({ title: 'Changelog', noindex: true });

  if (!isStaff) return <p className="note bad" style={{ marginTop: 40 }}>You do not have permission to access this page.</p>;

  return (
    <article style={{ padding: '40px 0 60px', maxWidth: 720 }}>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Changelog' }]} />
      <p className="eyebrow">Staff</p>
      <div className="hero-rule" style={{ maxWidth: 80 }} />
      <h1>Changelog</h1>

      <div className="stack" style={{ gap: 22 }}>
        {entries.map((e) => {
          const header = (
            <>
              <h2 style={{ margin: 0, display: 'inline' }}>
                v{e.version}{' '}
                {e.current && <Pill tone="go">Current</Pill>}
              </h2>
              <span className="small muted">{fmtVersionDate(e.date)}</span>
            </>
          );
          if (e.current) {
            return (
              <section key={e.version} className="card">
                <div className="spread" style={{ marginBottom: 10 }}>{header}</div>
                <ChangeList highlights={e.highlights} />
              </section>
            );
          }
          return (
            <details key={e.version} className="card">
              <summary className="spread" style={{ cursor: 'pointer' }}>{header}</summary>
              <ChangeList highlights={e.highlights} style={{ marginTop: 10 }} />
            </details>
          );
        })}
      </div>
    </article>
  );
}
