import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field, Pill, fmtMoney } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';
import { localInZone } from '../../lib/tz.js';

const BLANK = { name: '', price: '', currency: 'usd', capacity: '', description: '', salesStartAt: '', salesEndAt: '' };
const BLANK_CODE = { code: '', kind: 'percent', value: '', maxUses: '', tierIds: [], expiresAt: '' };

// Edits keep price as a dollars string; the API takes either and stores cents.
// Sale-window times are wall-clock strings in the event's timezone.
const toDraft = (t, tz) => ({
  name: t.name, description: t.description, currency: t.currency, active: t.active,
  price: t.priceCents ? (t.priceCents / 100).toFixed(2) : '',
  capacity: t.capacity ?? '',
  salesStartAt: localInZone(t.salesStartAt, tz),
  salesEndAt: localInZone(t.salesEndAt, tz),
});

const discountLabel = (d) => (d.percentOff ? `${d.percentOff}% off` : `${fmtMoney(d.amountOffCents)} off`);

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
  const [codes, setCodes] = useState([]);
  // Donation add-on settings live on the event; edited here next to the prices.
  const [donation, setDonation] = useState(null);
  const [newCode, setNewCode] = useState(BLANK_CODE);

  const load = () => Promise.all([
    api.get(`/api/admin/events/${id}/tiers`).then((r) => {
      setData(r);
      setDrafts(Object.fromEntries(r.tiers.map((t) => [t.id, toDraft(t, r.timezone)])));
    }),
    api.get(`/api/admin/events/${id}/discounts`).then(setCodes),
    api.get(`/api/admin/events/${id}`).then((e) => setDonation({
      enabled: e.donationAddonEnabled, label: e.donationAddonLabel,
      presets: (e.donationAddonPresets || []).map((c) => c / 100).join(', '),
    })),
  ]);
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
  const addCode = (e) => {
    e.preventDefault();
    run('code', async () => {
      await api.post(`/api/admin/events/${id}/discounts`, {
        code: newCode.code,
        percentOff: newCode.kind === 'percent' ? newCode.value : null,
        amountOff: newCode.kind === 'amount' ? newCode.value : null,
        maxUses: newCode.maxUses, tierIds: newCode.tierIds, expiresAt: newCode.expiresAt,
      });
      setNewCode(BLANK_CODE);
    }, 'Discount code added.');
  };
  const toggleCode = (d) => run(d.id, () => api.patch(`/api/admin/discounts/${d.id}`, { active: !d.active }));
  const removeCode = (d) => {
    if (!confirm(`Delete the code ${d.code}? People who already used it keep their discount.`)) return;
    run(d.id, () => api.del(`/api/admin/discounts/${d.id}`), 'Deleted.');
  };

  const saveDonation = (e) => {
    e.preventDefault();
    run('donation', () => api.patch(`/api/admin/events/${id}`, {
      donationAddonEnabled: donation.enabled,
      donationAddonLabel: donation.label,
      donationAddonPresets: donation.presets.split(',').map((x) => Math.round(Number(x.trim()) * 100)).filter((c) => c > 0),
    }), 'Saved.');
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

      {!stripe && <p className="small muted" style={{ marginTop: 0 }}>Stripe isn't set up, so paid tickets are paid at the door.</p>}

      <fieldset disabled={!isOwner} style={{ border: 0, margin: 0, padding: 0 }}>
        <div className="stack">
          {tiers.length === 0 && (
            <p className="note bad" style={{ margin: 0 }}>No ticket types yet, so nobody can register. Add one below.</p>
          )}
          {tiers.length > 0 && !tiers.some((t) => t.active) && (
            <p className="note bad" style={{ margin: 0 }}>No ticket type is on sale, so nobody can register right now.</p>
          )}

          {tiers.map((t, i) => {
            const d = drafts[t.id] || toDraft(t, data.timezone);
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
                <div className="grid-2">
                  <Field label="Sale starts" help={data.timezone}>
                    <input type="datetime-local" value={d.salesStartAt} onChange={(e) => setDraft(t.id, { salesStartAt: e.target.value })} />
                  </Field>
                  <Field label="Sale ends" help="Optional">
                    <input type="datetime-local" value={d.salesEndAt} onChange={(e) => setDraft(t.id, { salesEndAt: e.target.value })} />
                  </Field>
                </div>
                <div className="spread">
                  <div className="row">
                    <label className="row small"><input type="checkbox" checked={d.active} onChange={(e) => setDraft(t.id, { active: e.target.checked })} /> On sale</label>
                    <button className="btn sm ghost" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button className="btn sm ghost" disabled={i === tiers.length - 1 || !!busy} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  </div>
                  <div className="row">
                    <button className="btn sm danger" disabled={!!busy || t.registrationCount > 0}
                      title={t.registrationCount > 0 ? 'In use. Take it off sale instead.' : undefined}
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
            <div className="grid-2">
              <Field label="Sale starts" help="Optional"><input type="datetime-local" value={adding.salesStartAt} onChange={(e) => setAdding({ ...adding, salesStartAt: e.target.value })} /></Field>
              <Field label="Sale ends" help="Optional"><input type="datetime-local" value={adding.salesEndAt} onChange={(e) => setAdding({ ...adding, salesEndAt: e.target.value })} /></Field>
            </div>
            <button className="btn primary" style={{ justifySelf: 'start' }} disabled={busy === 'add' || !adding.name.trim()}>
              {busy === 'add' ? 'Adding…' : 'Add ticket type'}
            </button>
          </form>

          {donation && (
            <form className="card stack" onSubmit={saveDonation}>
              <h2 style={{ margin: 0 }}>Donation add-on</h2>
              <label className="row small">
                <input type="checkbox" checked={donation.enabled} onChange={(e) => setDonation({ ...donation, enabled: e.target.checked })} />
                Offer an optional donation at online checkout
              </label>
              {donation.enabled && (
                <div className="grid-2">
                  <Field label="Prompt"><input value={donation.label} onChange={(e) => setDonation({ ...donation, label: e.target.value })} /></Field>
                  <Field label="Suggested amounts ($)" help="Comma separated">
                    <input value={donation.presets} onChange={(e) => setDonation({ ...donation, presets: e.target.value })} />
                  </Field>
                </div>
              )}
              {!stripe && <p className="small muted" style={{ margin: 0 }}>Needs Stripe.</p>}
              <button className="btn primary" style={{ justifySelf: 'start' }}>Save</button>
            </form>
          )}

          <section className="card stack">
            <h2 style={{ margin: 0 }}>Discount codes</h2>
            {codes.length > 0 && (
              <table>
                <thead><tr><th>Code</th><th>Discount</th><th>Applies to</th><th>Used</th><th>Expires</th><th /></tr></thead>
                <tbody>
                  {codes.map((c) => (
                    <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                      <td className="mono">{c.code}</td>
                      <td>{discountLabel(c)}</td>
                      <td className="small">{c.tierIds.length ? tiers.filter((t) => c.tierIds.includes(t.id)).map((t) => t.name).join(', ') : 'All paid tickets'}</td>
                      <td className="mono small">{c.usedCount}{c.maxUses != null ? ` / ${c.maxUses}` : ''}</td>
                      <td className="small">{c.expiresAt ? new Date(c.expiresAt).toLocaleString(undefined, { timeZone: data.timezone }) : '-'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn sm ghost" onClick={() => toggleCode(c)}>{c.active ? 'Turn off' : 'Turn on'}</button>
                        <button className="btn sm danger" onClick={() => removeCode(c)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <form className="stack" onSubmit={addCode}>
              <div className="row" style={{ alignItems: 'end' }}>
                <Field label="Code">
                  <input className="mono" value={newCode.code} placeholder="SPRING20" style={{ textTransform: 'uppercase', width: 160 }}
                    onChange={(e) => setNewCode({ ...newCode, code: e.target.value })} />
                </Field>
                <Field label="Discount">
                  <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                    <input type="number" min="0" step={newCode.kind === 'percent' ? 1 : 0.01} value={newCode.value} style={{ width: 100 }}
                      onChange={(e) => setNewCode({ ...newCode, value: e.target.value })} />
                    <div className="segmented">
                      <button type="button" className={newCode.kind === 'percent' ? 'selected' : ''} onClick={() => setNewCode({ ...newCode, kind: 'percent' })}>%</button>
                      <button type="button" className={newCode.kind === 'amount' ? 'selected' : ''} onClick={() => setNewCode({ ...newCode, kind: 'amount' })}>$</button>
                    </div>
                  </div>
                </Field>
                <Field label="Max uses" help="Blank = unlimited">
                  <input type="number" min="1" value={newCode.maxUses} style={{ width: 100 }} onChange={(e) => setNewCode({ ...newCode, maxUses: e.target.value })} />
                </Field>
                <Field label="Expires" help="Optional">
                  <input type="datetime-local" value={newCode.expiresAt} onChange={(e) => setNewCode({ ...newCode, expiresAt: e.target.value })} />
                </Field>
              </div>
              {tiers.some((t) => t.priceCents > 0) && (
                <div className="row small">
                  <span className="muted">Applies to:</span>
                  {tiers.filter((t) => t.priceCents > 0).map((t) => (
                    <label key={t.id} className="row small" style={{ gap: 4 }}>
                      <input type="checkbox" checked={newCode.tierIds.includes(t.id)}
                        onChange={(e) => setNewCode({ ...newCode, tierIds: e.target.checked ? [...newCode.tierIds, t.id] : newCode.tierIds.filter((x) => x !== t.id) })} />
                      {t.name}
                    </label>
                  ))}
                  <span className="muted">(none = all)</span>
                </div>
              )}
              <button className="btn primary" style={{ justifySelf: 'start' }} disabled={!newCode.code.trim() || !newCode.value}>Add discount code</button>
            </form>
          </section>
        </div>
      </fieldset>
    </>
  );
}
