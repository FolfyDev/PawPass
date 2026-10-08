import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field, Pill, fmtMoney } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';

const BLANK = { name: '', price: '', currency: 'usd', capacity: '', description: '' };

// Edits keep price as a dollars string; the API takes either and stores cents.
const toDraft = (t) => ({
  name: t.name, description: t.description, currency: t.currency, active: t.active,
  price: t.priceCents ? (t.priceCents / 100).toFixed(2) : '',
  capacity: t.capacity ?? '',
});

function SyncStatus({ tier, stripe }) {
  if (!stripe || !tier.priceCents) return null;
  if (tier.stripeSyncError) return <Pill tone="stop">Stripe sync failed</Pill>;
  if (tier.stripePriceId) return <Pill tone="go">Synced to Stripe</Pill>;
  return <Pill tone="wait">Not synced yet</Pill>;
}

export default function Tiers() {
  const { id } = useParams();
  const { user } = useSession();
  const isOwner = user.role === 'OWNER';
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [adding, setAdding] = useState(BLANK);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);
  const [busy, setBusy] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/tiers`).then((r) => {
    setData(r);
    setDrafts(Object.fromEntries(r.tiers.map((t) => [t.id, toDraft(t)])));
  });
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const say = (text, ok = true) => { setMsg(text); setMsgOk(ok); if (ok) setTimeout(() => setMsg(''), 2500); };
  const run = async (key, fn, okText) => {
    setBusy(key);
    try { await fn(); await load(); if (okText) say(okText); }
    catch (e) { say(e.message, false); }
    finally { setBusy(''); }
  };

  if (!data) return <p className="muted">Loading…</p>;
  const { tiers, stripe } = data;
  const setDraft = (tid, patch) => setDrafts((d) => ({ ...d, [tid]: { ...d[tid], ...patch } }));

  const save = (t) => run(t.id, () => api.patch(`/api/admin/tiers/${t.id}`, drafts[t.id]), 'Saved.');
  const remove = (t) => {
    if (!confirm(`Delete the "${t.name}" ticket type?`)) return;
    run(t.id, () => api.del(`/api/admin/tiers/${t.id}`), 'Deleted.');
  };
  // Swaps sortOrder with the neighbour — tiers list in this order everywhere.
  const move = (index, dir) => {
    const a = tiers[index];
    const b = tiers[index + dir];
    if (!b) return;
    run(a.id, async () => {
      await api.patch(`/api/admin/tiers/${a.id}`, { sortOrder: index + dir });
      await api.patch(`/api/admin/tiers/${b.id}`, { sortOrder: index });
    });
  };
  const add = (e) => {
    e.preventDefault();
    run('add', async () => { await api.post(`/api/admin/events/${id}/tiers`, adding); setAdding(BLANK); }, 'Ticket type added.');
  };
  const resync = () => run('sync', async () => {
    const r = await api.post(`/api/admin/events/${id}/tiers/sync`);
    if (r.errors.length) throw new Error(`Some tiers didn't sync: ${r.errors.map((x) => `${x.name} (${x.error})`).join('; ')}`);
  }, 'Everything is synced with Stripe.');

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div>
          <p className="eyebrow">Event</p>
          <h1 style={{ margin: 0 }}>Tickets</h1>
        </div>
        {isOwner && stripe && <button className="btn" disabled={busy === 'sync'} onClick={resync}>{busy === 'sync' ? 'Syncing…' : 'Resync with Stripe'}</button>}
      </div>
      <EventTabs id={id} />
      {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`} style={{ marginBottom: 16 }}>{msg}</p>}

      <p className="small muted" style={{ marginTop: 0 }}>
        {stripe
          ? 'Paid tickets are sold through Stripe Checkout and confirmed automatically once paid. Each paid ticket type is kept in sync as a Stripe product; changing a price creates a new Stripe price and archives the old one.'
          : 'Stripe isn\'t set up on this instance (STRIPE_SECRET_KEY), so paid tickets are paid at the door — record the payment at the kiosk or in the attendee editor.'}
        {' '}Vouchers skip ticket types entirely.
      </p>

      <fieldset disabled={!isOwner} style={{ border: 0, margin: 0, padding: 0 }}>
        <div className="stack">
          {tiers.length === 0 && (
            <p className="note bad" style={{ margin: 0 }}>This event has no ticket types, so nobody can register. Add at least one below — a free one if it's free to attend.</p>
          )}
          {tiers.length > 0 && !tiers.some((t) => t.active) && (
            <p className="note bad" style={{ margin: 0 }}>No ticket type is on sale, so nobody can register right now.</p>
          )}

          {tiers.map((t, i) => {
            const d = drafts[t.id] || toDraft(t);
            return (
              <section key={t.id} className="card stack">
                <div className="spread">
                  <div className="row">
                    <h2 style={{ margin: 0 }}>{t.name}</h2>
                    <strong className="mono">{t.priceCents ? fmtMoney(t.priceCents, t.currency) : 'Free'}</strong>
                    {!t.active && <Pill>Not on sale</Pill>}
                    <SyncStatus tier={t} stripe={stripe} />
                  </div>
                  <span className="small muted">
                    {t.held} taken{t.capacity != null ? ` of ${t.capacity}` : ''}
                    {t.registrationCount > t.held ? ` · ${t.registrationCount - t.held} cancelled/waitlisted` : ''}
                  </span>
                </div>
                {t.stripeSyncError && <p className="note bad" style={{ margin: 0 }}>Stripe said: {t.stripeSyncError}</p>}
                <div className="grid-2">
                  <Field label="Name"><input value={d.name} onChange={(e) => setDraft(t.id, { name: e.target.value })} /></Field>
                  <div className="row" style={{ alignItems: 'end' }}>
                    <Field label="Price" help="Blank or 0 = free">
                      <input type="number" step="0.01" min="0" value={d.price} style={{ width: 120 }} onChange={(e) => setDraft(t.id, { price: e.target.value })} />
                    </Field>
                    <Field label="Currency">
                      <input value={d.currency} maxLength={3} style={{ width: 70, textTransform: 'uppercase' }} onChange={(e) => setDraft(t.id, { currency: e.target.value })} />
                    </Field>
                    <Field label="Limit" help="Blank = none">
                      <input type="number" min="0" value={d.capacity} style={{ width: 90 }} onChange={(e) => setDraft(t.id, { capacity: e.target.value })} />
                    </Field>
                  </div>
                </div>
                <Field label="Description" help="Shown to attendees under the name">
                  <input value={d.description} onChange={(e) => setDraft(t.id, { description: e.target.value })} />
                </Field>
                <div className="spread">
                  <div className="row">
                    <label className="row small"><input type="checkbox" checked={d.active} onChange={(e) => setDraft(t.id, { active: e.target.checked })} /> On sale</label>
                    <button className="btn sm ghost" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button className="btn sm ghost" disabled={i === tiers.length - 1 || !!busy} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  </div>
                  <div className="row">
                    <button className="btn sm danger" disabled={!!busy || t.registrationCount > 0}
                      title={t.registrationCount > 0 ? 'People registered on this ticket type — take it off sale instead' : undefined}
                      onClick={() => remove(t)}>Delete</button>
                    <button className="btn sm primary" disabled={!!busy} onClick={() => save(t)}>{busy === t.id ? 'Saving…' : 'Save'}</button>
                  </div>
                </div>
              </section>
            );
          })}

          <form className="card stack" onSubmit={add}>
            <h2 style={{ margin: 0 }}>Add a ticket type</h2>
            <div className="grid-2">
              <Field label="Name"><input value={adding.name} placeholder="e.g. Attendee, Sponsor, Early bird" onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></Field>
              <div className="row" style={{ alignItems: 'end' }}>
                <Field label="Price" help="Blank or 0 = free">
                  <input type="number" step="0.01" min="0" value={adding.price} style={{ width: 120 }} onChange={(e) => setAdding({ ...adding, price: e.target.value })} />
                </Field>
                <Field label="Currency">
                  <input value={adding.currency} maxLength={3} style={{ width: 70, textTransform: 'uppercase' }} onChange={(e) => setAdding({ ...adding, currency: e.target.value })} />
                </Field>
                <Field label="Limit" help="Blank = none">
                  <input type="number" min="0" value={adding.capacity} style={{ width: 90 }} onChange={(e) => setAdding({ ...adding, capacity: e.target.value })} />
                </Field>
              </div>
            </div>
            <Field label="Description"><input value={adding.description} onChange={(e) => setAdding({ ...adding, description: e.target.value })} /></Field>
            <button className="btn primary" style={{ justifySelf: 'start' }} disabled={busy === 'add' || !adding.name.trim()}>
              {busy === 'add' ? 'Adding…' : 'Add ticket type'}
            </button>
          </form>
        </div>
      </fieldset>
    </>
  );
}
