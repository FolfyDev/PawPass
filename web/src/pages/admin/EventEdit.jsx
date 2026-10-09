import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';
import { localInZone } from '../../lib/tz.js';

export default function EventEdit() {
  const { id } = useParams();
  const { user } = useSession();
  const isOwner = user.role === 'OWNER';
  const nav = useNavigate();
  const [e, setE] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);

  useEffect(() => {
    api.get(`/api/admin/events/${id}`).then((ev) => setE({
      ...ev,
      startsAt: localInZone(ev.startsAt, ev.timezone),
      endsAt: localInZone(ev.endsAt, ev.timezone),
      opensAt: localInZone(ev.opensAt, ev.timezone),
      closesAt: localInZone(ev.closesAt, ev.timezone),
    }));
    api.get('/api/badges/templates').then(setTemplates);
    api.get(`/api/admin/events/${id}/tiers`).then((r) => setTiers(r.tiers)).catch(() => setTiers([]));
  }, [id]);

  if (!e) return <p className="muted">Loading…</p>;
  const set = (k, v) => setE({ ...e, [k]: v });
  const fields = e.customFields || [];

  const save = async () => {
    try { await api.patch(`/api/admin/events/${id}`, e); setMsg('Saved.'); setMsgOk(true); setTimeout(() => setMsg(''), 2000); }
    catch (err) { setMsg(err.message); setMsgOk(false); }
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
        <div className="row">
          <a className="btn" href={`/e/${e.slug}`} target="_blank" rel="noreferrer">
            {e.published ? 'View public page' : 'Preview (unpublished)'}
          </a>
          {isOwner && <button className="btn primary" onClick={save}>Save changes</button>}
        </div>
      </div>
      <EventTabs id={id} />
      {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`} style={{ marginBottom: 16 }}>{msg}</p>}

      <fieldset disabled={!isOwner} style={{ border: 0, margin: 0, padding: 0 }}>
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
            <label className="row small"><input type="checkbox" checked={e.published} onChange={(ev) => set('published', ev.target.checked)} /> Published</label>
            <label className="row small"><input type="checkbox" checked={e.waitlistEnabled} onChange={(ev) => set('waitlistEnabled', ev.target.checked)} /> Waitlist once full</label>
          </div>
          {/* A div, not <Field>: Field is a <label>, and labels can't nest. */}
          <div className="field" role="radiogroup" aria-label="Cancelling a paid ticket">
            <span>Cancelling a paid ticket</span>
            <label className="choice">
              <input type="radio" name="cancelPolicy" checked={e.cancelPolicy === 'AUTO_REFUND'} onChange={() => set('cancelPolicy', 'AUTO_REFUND')} />
              <span><strong>Self-cancel and auto-refund</strong></span>
            </label>
            <label className="choice">
              <input type="radio" name="cancelPolicy" checked={e.cancelPolicy !== 'AUTO_REFUND'} onChange={() => set('cancelPolicy', 'REQUEST')} />
              <span><strong>Request a cancellation</strong> (an owner approves it)</span>
            </label>
          </div>
          <Field label="Accent colour"><input type="color" value={e.accentColor} onChange={(ev) => set('accentColor', ev.target.value)} style={{ width: 70, padding: 4 }} /></Field>
        </section>

        <section className="card stack">
          <h2 style={{ margin: 0 }}>Automatic messages</h2>
          <p className="small muted" style={{ margin: 0 }}>Sent by email and Telegram. Tokens: {'{{fursona_name}} {{code}} {{event_title}}'}</p>
          <label className="row small">
            <input type="checkbox" checked={!!e.kbygEnabled} onChange={(ev) => set('kbygEnabled', ev.target.checked)} />
            Know before you go
          </label>
          {e.kbygEnabled && (
            <>
              <Field label="Days before">
                <input type="number" min="1" max="30" value={e.kbygDaysBefore ?? 3} style={{ width: 90 }}
                  onChange={(ev) => set('kbygDaysBefore', Number(ev.target.value))} />
              </Field>
              <Field label="Message" help="Parking, what to bring, schedule. Date, venue and badge code are added.">
                <textarea value={e.kbygMessage || ''} onChange={(ev) => set('kbygMessage', ev.target.value)} />
              </Field>
            </>
          )}
          <label className="row small">
            <input type="checkbox" checked={!!e.thanksEnabled} onChange={(ev) => set('thanksEnabled', ev.target.checked)} />
            Thank-you after the event
          </label>
          {e.thanksEnabled && (
            <>
              <Field label="Message" help="Blank = a short thanks">
                <textarea value={e.thanksMessage || ''} onChange={(ev) => set('thanksMessage', ev.target.value)} />
              </Field>
              <Field label="Feedback link" help="Optional">
                <input type="url" placeholder="https://" value={e.feedbackUrl || ''} onChange={(ev) => set('feedbackUrl', ev.target.value)} />
              </Field>
            </>
          )}
        </section>

        <section className="card stack">
          <h2 style={{ margin: 0 }}>Terms</h2>
          <p className="small muted">Shown before anyone registers.</p>
          <Field label="Heading"><input value={e.tosTitle} onChange={(ev) => set('tosTitle', ev.target.value)} /></Field>
          <Field label="Body"><textarea style={{ minHeight: 220 }} value={e.tosBody} onChange={(ev) => set('tosBody', ev.target.value)} /></Field>
        </section>

        <section className="card stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>Extra questions</h2>
            <button className="btn sm" onClick={() => set('customFields', [...fields, { key: `q${fields.length + 1}`, label: 'New question', type: 'text', required: false }])}>Add question</button>
          </div>
          <p className="small muted">Asked on the web form and by the bot.</p>
          {fields.map((f, i) => (
            <div key={i} className="card" style={{ background: 'var(--paper)', boxShadow: 'none' }}>
              <div className="grid-2">
                <Field label="Label"><input value={f.label} onChange={(ev) => setField(i, { label: ev.target.value })} /></Field>
                <Field label="Key" help="Also usable as {{key}} on badges"><input className="mono" value={f.key} onChange={(ev) => setField(i, { key: ev.target.value })} /></Field>
                <Field label="Type">
                  <select value={f.type} onChange={(ev) => setField(i, { type: ev.target.value })}>
                    {['text', 'select', 'checkbox', 'number'].map((t) => <option key={t}>{t}</option>)}
                    {(f.type === 'qualifier' || !fields.some((x) => x.type === 'qualifier')) && <option>qualifier</option>}
                  </select>
                </Field>
                <Field label="Options" help={f.type === 'qualifier'
                  ? 'Comma separated, highest priority first'
                  : 'Comma separated, for select'}>
                  <input value={(f.options || []).join(', ')} onChange={(ev) => setField(i, { options: ev.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                </Field>
              </div>
              {tiers.length > 1 && (
                <div className="row small" style={{ marginTop: 8 }}>
                  <span className="muted">Ask for:</span>
                  {tiers.map((t) => (
                    <label key={t.id} className="row small" style={{ gap: 4 }}>
                      <input type="checkbox" checked={(f.tierIds || []).includes(t.id)}
                        onChange={(ev) => setField(i, { tierIds: ev.target.checked ? [...(f.tierIds || []), t.id] : (f.tierIds || []).filter((x) => x !== t.id) })} />
                      {t.name}
                    </label>
                  ))}
                  <span className="muted">(none = everyone)</span>
                </div>
              )}
              {f.type === 'qualifier' && (
                <p className="small muted" style={{ marginTop: 6 }}>
                  Attendees can pick several. The badge shows the highest one.
                </p>
              )}
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
      </fieldset>
    </>
  );
}
