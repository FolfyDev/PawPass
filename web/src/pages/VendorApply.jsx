import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import { Field, fmtMoney } from '../components/Bits.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import { AREA_LABEL, VendorStatus } from '../components/VendorBits.jsx';
import { PageSkeleton } from '../components/Skeleton.jsx';

const BLANK = { area: 'DEALERS_DEN', tableTypeId: '', businessName: '', description: '', portfolio: '', assistants: '', notes: '' };
const toBody = (d) => ({ ...d, portfolioUrls: d.portfolio.split(/\s+/).filter(Boolean), portfolio: undefined });

function ApplicationForm({ value, onChange, tableTypes, lockArea }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const areas = [...new Set(tableTypes.map((t) => t.area))];
  const types = tableTypes.filter((t) => t.area === value.area);
  return (
    <div className="stack">
      {!lockArea && areas.length > 1 && (
        <Field label="Where">
          <div className="segmented">
            {areas.map((a) => (
              <button key={a} type="button" className={value.area === a ? 'selected' : ''} onClick={() => set({ area: a, tableTypeId: '' })}>{AREA_LABEL[a]}</button>
            ))}
          </div>
        </Field>
      )}
      {types.length > 0 && (
        <Field label="Table" help="What you'd like; the organizers confirm what you get">
          <select value={value.tableTypeId} onChange={(e) => set({ tableTypeId: e.target.value })}>
            <option value="">Choose one</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.priceCents ? fmtMoney(t.priceCents, t.currency) : 'Free'}</option>)}
          </select>
        </Field>
      )}
      <Field label="Business or artist name"><input value={value.businessName} onChange={(e) => set({ businessName: e.target.value })} /></Field>
      <Field label="What you make or sell"><textarea style={{ minHeight: 100 }} value={value.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <Field label="Portfolio or shop links" help="One per line, up to 8">
        <textarea style={{ minHeight: 70 }} placeholder="https://" value={value.portfolio} onChange={(e) => set({ portfolio: e.target.value })} />
      </Field>
      <Field label="Assistants" help="Optional, names of anyone helping at your table">
        <input value={value.assistants} onChange={(e) => set({ assistants: e.target.value })} />
      </Field>
      <Field label="Notes for the organizers" help="Optional: power, accessibility, who you'd like to sit near">
        <textarea style={{ minHeight: 60 }} value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}

export default function VendorApply() {
  const { slug } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(BLANK);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  usePageMeta({ title: data ? `Vendor tables · ${data.title}` : 'Vendor tables' });

  const load = () => api.get(`/api/events/${slug}/vendors`).then((d) => {
    setData(d);
    // Start on an area that has tables.
    setDraft((cur) => (d.tableTypes.some((t) => t.area === cur.area) || !d.tableTypes.length ? cur : { ...cur, area: d.tableTypes[0].area }));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [slug, user]);
  useEffect(() => {
    if (params.get('payment') === 'cancelled') { setMsg('Payment cancelled. You can pay any time from here.'); setParams({}, { replace: true }); }
  }, [params, setParams]);

  if (error) return <p className="note bad" style={{ marginTop: 40 }}>{error} <Link to={`/e/${slug}`}>Back to the event</Link></p>;
  if (!data) return <PageSkeleton crumbs />;

  const live = (a) => ['SUBMITTED', 'WAITLISTED', 'ACCEPTED', 'CONFIRMED'].includes(a.status);
  const openAreas = Object.keys(AREA_LABEL).filter((a) => !data.mine.some((m) => m.area === a && live(m)));
  // Applied to one area already: the form switches to the other.
  const form = openAreas.includes(draft.area) || !openAreas.length ? draft : { ...draft, area: openAreas[0], tableTypeId: '' };

  const submit = async (e) => {
    e.preventDefault();
    setMsg(''); setBusy('apply');
    try { await api.post(`/api/events/${slug}/vendors`, toBody(form)); setDraft({ ...BLANK, area: openAreas.find((a) => a !== form.area) || form.area }); setMsg('Application sent! You\'ll hear back by message.'); load(); }
    catch (err) { setMsg(err.message); } finally { setBusy(''); }
  };
  const pay = async (a) => {
    setBusy(a.id);
    try { window.location.href = (await api.post(`/api/my/vendor-applications/${a.id}/pay`)).url; }
    catch (err) { setMsg(err.message); setBusy(''); }
  };
  const saveEdit = async () => {
    try { await api.patch(`/api/my/vendor-applications/${editing.id}`, toBody(editing.draft)); setEditing(null); load(); }
    catch (err) { setMsg(err.message); }
  };
  const withdraw = async (a) => {
    if (!confirm(`Withdraw ${a.businessName}'s application?`)) return;
    try { await api.post(`/api/my/vendor-applications/${a.id}/withdraw`); load(); } catch (err) { setMsg(err.message); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <header style={{ padding: '40px 0 16px' }}>
        <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: data.title, to: `/e/${slug}` }, { label: 'Vendor tables' }]} />
        <p className="eyebrow">{data.title}</p>
        <h1 style={{ margin: 0 }}>Dealers' den &amp; artist alley</h1>
        {data.closesAt && (
          <p className="small muted">{data.accepting ? 'Applications close' : 'Applications closed'} {new Date(data.closesAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: data.timezone })}.</p>
        )}
      </header>

      {data.info && <div className="card" style={{ marginBottom: 20 }}><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{data.info}</p></div>}

      {data.tableTypes.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <ul className="tier-list">
            {data.tableTypes.map((t) => (
              <li key={t.id}>
                <div>
                  <strong>{t.name}</strong> <span className="muted small">· {AREA_LABEL[t.area]}</span>
                  {t.description && <p className="small muted" style={{ margin: '2px 0 0' }}>{t.description}</p>}
                </div>
                <strong>{t.priceCents ? fmtMoney(t.priceCents, t.currency) : 'Free'}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && <p className="note" style={{ marginBottom: 16 }}>{msg}</p>}

      {data.mine.length > 0 && (
        <section className="stack" style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Your applications</h2>
          {data.mine.map((a) => (
            <div key={a.id} className="card stack" style={{ gap: 6 }}>
              <div className="spread">
                <span><strong>{a.businessName}</strong> <span className="muted small">· {AREA_LABEL[a.area]}</span></span>
                <VendorStatus status={a.status} />
              </div>
              {a.tableType && <p className="small muted" style={{ margin: 0 }}>{a.tableType.name}{a.tableNumber ? ` · table ${a.tableNumber}` : ''}</p>}
              {a.status === 'ACCEPTED' && (
                <div className="row">
                  <span>Table fee: <strong>{fmtMoney(a.feeCents - a.paidCents, a.currency)}</strong>{a.paidCents > 0 && <span className="small muted"> left of {fmtMoney(a.feeCents, a.currency)}</span>}</span>
                  {data.payOnline
                    ? <button className="btn signal sm" disabled={busy === a.id} onClick={() => pay(a)}>{busy === a.id ? 'Opening payment…' : 'Pay now'}</button>
                    : <span className="small muted">The organizers will tell you how to pay.</span>}
                </div>
              )}
              {['SUBMITTED', 'WAITLISTED'].includes(a.status) && (
                <div className="row">
                  <button className="btn sm" onClick={() => setEditing({ id: a.id, area: a.area, draft: { area: a.area, tableTypeId: a.tableTypeId || '', businessName: a.businessName, description: a.description, portfolio: a.portfolioUrls.join('\n'), assistants: a.assistants, notes: a.notes } })}>Edit</button>
                  <button className="btn sm ghost" onClick={() => withdraw(a)}>Withdraw</button>
                </div>
              )}
              {editing?.id === a.id && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <ApplicationForm value={editing.draft} tableTypes={data.tableTypes} lockArea onChange={(d) => setEditing({ ...editing, draft: d })} />
                  <div className="row"><button className="btn primary sm" onClick={saveEdit}>Save changes</button><button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button></div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {!data.accepting ? (
        <p className="note">Vendor applications are closed for this event.</p>
      ) : !user ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>Sign in to apply, so the organizers can reach you about your table.</p>
          <Link className="btn primary" to="/login" style={{ justifySelf: 'start' }}>Sign in</Link>
        </div>
      ) : openAreas.length === 0 ? (
        <p className="small muted">You've applied to both areas.</p>
      ) : (
        <form className="card stack" onSubmit={submit}>
          <h2 style={{ margin: 0 }}>Apply for a table</h2>
          <ApplicationForm value={form} tableTypes={data.tableTypes.filter((t) => openAreas.includes(t.area))} onChange={setDraft} />
          <button className="btn signal" style={{ justifySelf: 'start' }} disabled={busy === 'apply' || !draft.businessName.trim()}>{busy === 'apply' ? 'Sending…' : 'Send application'}</button>
        </form>
      )}
    </div>
  );
}
