import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Field } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';

// Renders a stored UTC instant as the wall-clock string an
// <input type="datetime-local"> expects — in the event's own timezone, not
// the browser's. Editing and re-saving that string goes back through the
// same zone server-side (see zonedTimeToUtc in server/src/lib/tz.js), so the
// round trip is consistent regardless of what timezone the admin is sitting in.
const DT_PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
const localInZone = (d, tz) => {
  if (!d) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { ...DT_PARTS, timeZone: tz || 'UTC' }).formatToParts(new Date(d)).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
};

export default function EventEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const [e, setE] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get(`/api/admin/events/${id}`).then((ev) => setE({
      ...ev,
      startsAt: localInZone(ev.startsAt, ev.timezone),
      endsAt: localInZone(ev.endsAt, ev.timezone),
      opensAt: localInZone(ev.opensAt, ev.timezone),
      closesAt: localInZone(ev.closesAt, ev.timezone),
    }));
    api.get('/api/badges/templates').then(setTemplates);
  }, [id]);

  if (!e) return <p className="muted">Loading…</p>;
  const set = (k, v) => setE({ ...e, [k]: v });
  const fields = e.customFields || [];

  const save = async () => {
    try { await api.patch(`/api/admin/events/${id}`, e); setMsg('Saved.'); setTimeout(() => setMsg(''), 2000); }
    catch (err) { setMsg(err.message); }
  };

  const remove = async () => {
    if (!confirm('Delete this event and every registration on it?')) return;
    await api.del(`/api/admin/events/${id}`);
    nav('/admin');
  };

  const setField = (i, patch) => set('customFields', fields.map((f, n) => (n === i ? { ...f, ...patch } : f)));

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div>
          <p className="eyebrow">Event</p>
          <h1 style={{ margin: 0 }}>{e.title}</h1>
        </div>
        <button className="btn primary" onClick={save}>Save changes</button>
      </div>
      <EventTabs id={id} />
      {msg && <p className="note" style={{ marginBottom: 16 }}>{msg}</p>}

      <div className="stack">
        <section className="card stack">
          <h2 style={{ margin: 0 }}>Basics</h2>
          <div className="grid-2">
            <Field label="Title"><input value={e.title} onChange={(ev) => set('title', ev.target.value)} /></Field>
            <Field label="URL slug" help={`/e/${e.slug}`}><input value={e.slug} onChange={(ev) => set('slug', ev.target.value)} /></Field>
          </div>
          <Field label="Tagline"><input value={e.tagline || ''} onChange={(ev) => set('tagline', ev.target.value)} /></Field>
          <Field label="Description"><textarea value={e.description || ''} onChange={(ev) => set('description', ev.target.value)} /></Field>
          <div className="grid-2">
            <Field label="Venue"><input value={e.venue || ''} onChange={(ev) => set('venue', ev.target.value)} /></Field>
            <Field label="Time zone"><input value={e.timezone} onChange={(ev) => set('timezone', ev.target.value)} /></Field>
            <Field label="Starts"><input type="datetime-local" value={e.startsAt} onChange={(ev) => set('startsAt', ev.target.value)} /></Field>
            <Field label="Ends"><input type="datetime-local" value={e.endsAt} onChange={(ev) => set('endsAt', ev.target.value)} /></Field>
          </div>
        </section>

        <section className="card stack">
          <h2 style={{ margin: 0 }}>Registration</h2>
          <div className="grid-2">
            <Field label="Capacity" help="Leave blank for unlimited">
              <input type="number" value={e.capacity ?? ''} onChange={(ev) => set('capacity', ev.target.value === '' ? null : Number(ev.target.value))} />
            </Field>
            <Field label="Badge template">
              <select value={e.badgeTemplateId || ''} onChange={(ev) => set('badgeTemplateId', ev.target.value || null)}>
                <option value="">Instance default</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Opens"><input type="datetime-local" value={e.opensAt} onChange={(ev) => set('opensAt', ev.target.value || null)} /></Field>
            <Field label="Closes"><input type="datetime-local" value={e.closesAt} onChange={(ev) => set('closesAt', ev.target.value || null)} /></Field>
          </div>
          <div className="row">
            <label className="row small"><input type="checkbox" checked={e.published} onChange={(ev) => set('published', ev.target.checked)} /> Published — visible and open for sign-ups</label>
            <label className="row small"><input type="checkbox" checked={e.waitlistEnabled} onChange={(ev) => set('waitlistEnabled', ev.target.checked)} /> Waitlist once full</label>
          </div>
          <Field label="Accent colour"><input type="color" value={e.accentColor} onChange={(ev) => set('accentColor', ev.target.value)} style={{ width: 70, padding: 4 }} /></Field>
        </section>

        <section className="card stack">
          <h2 style={{ margin: 0 }}>Tiers</h2>
          <p className="small muted">Everyone can register free. Add a PayPal link to also offer a donation tier — registration completes immediately and a new tab opens to PayPal, with no confirmation step.</p>
          <div className="grid-2">
            <Field label="Donation tier name"><input value={e.donationTierName || ''} onChange={(ev) => set('donationTierName', ev.target.value)} /></Field>
            <Field label="PayPal link" help="Leave blank to offer free registration only">
              <input type="url" placeholder="https://paypal.me/…" value={e.donationPaypalLink || ''} onChange={(ev) => set('donationPaypalLink', ev.target.value || null)} />
            </Field>
          </div>
        </section>

        <section className="card stack">
          <h2 style={{ margin: 0 }}>Terms</h2>
          <p className="small muted">Shown in a sheet on the web form before anyone can submit, and sent by the bot before <code className="mono">/accept</code>.</p>
          <Field label="Heading"><input value={e.tosTitle} onChange={(ev) => set('tosTitle', ev.target.value)} /></Field>
          <Field label="Body"><textarea style={{ minHeight: 220 }} value={e.tosBody} onChange={(ev) => set('tosBody', ev.target.value)} /></Field>
        </section>

        <section className="card stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>Extra questions</h2>
            <button className="btn sm" onClick={() => set('customFields', [...fields, { key: `q${fields.length + 1}`, label: 'New question', type: 'text', required: false }])}>Add question</button>
          </div>
          <p className="small muted">These appear on the web form and the bot asks them in order.</p>
          {fields.map((f, i) => (
            <div key={i} className="card" style={{ background: 'var(--paper)', boxShadow: 'none' }}>
              <div className="grid-2">
                <Field label="Label"><input value={f.label} onChange={(ev) => setField(i, { label: ev.target.value })} /></Field>
                <Field label="Key" help="Also usable as {{key}} on badges"><input className="mono" value={f.key} onChange={(ev) => setField(i, { key: ev.target.value })} /></Field>
                <Field label="Type">
                  <select value={f.type} onChange={(ev) => setField(i, { type: ev.target.value })}>
                    {['text', 'select', 'checkbox', 'number'].map((t) => <option key={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label="Options" help="Comma separated, for select">
                  <input value={(f.options || []).join(', ')} onChange={(ev) => setField(i, { options: ev.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                </Field>
              </div>
              <div className="spread" style={{ marginTop: 10 }}>
                <label className="row small"><input type="checkbox" checked={!!f.required} onChange={(ev) => setField(i, { required: ev.target.checked })} /> Required</label>
                <button className="btn sm danger" onClick={() => set('customFields', fields.filter((_, n) => n !== i))}>Remove</button>
              </div>
            </div>
          ))}
        </section>

        <div className="spread">
          <button className="btn danger" onClick={remove}>Delete event</button>
          <button className="btn primary" onClick={save}>Save changes</button>
        </div>
      </div>
    </>
  );
}
