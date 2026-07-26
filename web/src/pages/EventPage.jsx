import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import Modal from '../components/Modal.jsx';
import { Field, fmtDate, StatusPill, Avatar, RsvpButtons, Pill } from '../components/Bits.jsx';

export default function EventPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const { user, settings } = useSession();
  const [event, setEvent] = useState(null);
  const [form, setForm] = useState({ legalName: '', fursonaName: '', email: '', answers: {}, tier: 'FREE' });
  const [showTos, setShowTos] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [going, setGoing] = useState(null);
  const [merch, setMerch] = useState(null);

  const load = () => api.get(`/api/events/${slug}`).then((e) => {
    setEvent(e);
    setForm((f) => ({
      ...f,
      legalName: e.registration?.legalName || user?.legalName || '',
      fursonaName: e.registration?.fursonaName || user?.fursonaName || '',
      email: e.registration?.email || user?.email || '',
    }));
  }).catch((err) => setError(err.message));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [slug, user]);
  useEffect(() => {
    if (!user) { setGoing(null); return; }
    api.get(`/api/events/${slug}/rsvps`).then(setGoing).catch(() => setGoing([]));
  }, [slug, user]);
  useEffect(() => {
    if (!user) { setMerch(null); return; }
    api.get(`/api/events/${slug}/merch`).then(setMerch).catch(() => setMerch([]));
  }, [slug, user]);

  const rsvp = async (value) => {
    const updated = await api.post(`/api/my/tickets/${event.registration.code}/rsvp`, { rsvp: value });
    setEvent((e) => ({ ...e, registration: { ...e.registration, rsvp: updated.rsvp } }));
    api.get(`/api/events/${slug}/rsvps`).then(setGoing).catch(() => {});
  };

  if (error && !event) return <p className="note bad" style={{ marginTop: 40 }}>{error}</p>;
  if (!event) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  const fields = event.customFields || [];
  const registered = event.registration && event.registration.status !== 'CANCELLED';

  // The submit button opens the terms; agreeing inside the sheet is what registers.
  const openTos = (e) => {
    e.preventDefault();
    setError('');
    if (form.legalName.trim().length < 2) return setError('Enter your full legal name.');
    for (const f of fields) if (f.required && !form.answers[f.key]) return setError(`${f.label} is required.`);
    setShowTos(true);
  };

  const accept = async () => {
    setBusy(true);
    try {
      await api.post(`/api/events/${slug}/register`, { ...form, acceptedTos: true });
      setShowTos(false);
      if (form.tier === 'DONATION' && event.donationPaypalLink) {
        window.open(event.donationPaypalLink, '_blank', 'noopener');
      }
      nav('/tickets');
    } catch (e) {
      setError(e.message);
      setShowTos(false);
    } finally { setBusy(false); }
  };

  return (
    <>
      <header style={{ padding: '40px 0 24px', maxWidth: 680 }}>
        <p className="eyebrow">{fmtDate(event.startsAt, event.timezone)} · {event.venue}</p>
        <h1>{event.title}</h1>
        {event.tagline && <p className="muted">{event.tagline}</p>}
      </header>

      <div className="grid-2" style={{ alignItems: 'start', gap: 28 }}>
        <article className="card">
          <p style={{ whiteSpace: 'pre-wrap' }}>{event.description || 'No description yet.'}</p>
          <dl className="small muted" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: 0 }}>
            <dt className="eyebrow">Starts</dt><dd style={{ margin: 0 }}>{fmtDate(event.startsAt, event.timezone)}</dd>
            <dt className="eyebrow">Ends</dt><dd style={{ margin: 0 }}>{fmtDate(event.endsAt, event.timezone)}</dd>
            {event.venue && <><dt className="eyebrow">Where</dt><dd style={{ margin: 0 }}>{event.venue}</dd></>}
            {event.capacity && <><dt className="eyebrow">Spots</dt><dd style={{ margin: 0 }}>{event.confirmed} of {event.capacity} taken</dd></>}
          </dl>
        </article>

        <section className="card">
          {registered ? (
            <div className="stack">
              <h2 style={{ margin: 0 }}>You are in</h2>
              <p className="row" style={{ margin: 0 }}><StatusPill status={event.registration.status} /> <span className="code">{event.registration.code}</span></p>
              <div>
                <p className="eyebrow" style={{ marginBottom: 6 }}>Going?</p>
                <RsvpButtons value={event.registration.rsvp} onChange={rsvp} />
              </div>
              <Link className="btn primary" to="/tickets" style={{ justifySelf: 'start' }}>Open your ticket</Link>
            </div>
          ) : !user ? (
            <>
              <h2>Register</h2>
              <p className="muted">Registration uses your Telegram account, so your ticket follows you into chat.</p>
              <Link className="btn primary" to="/login">Continue with Telegram</Link>
              {settings?.telegramBot && (
                <p className="small muted" style={{ marginTop: 14 }}>
                  Or skip the site entirely: message <a href={`https://t.me/${settings.telegramBot}`}>@{settings.telegramBot}</a> and send <code className="mono">/register</code>.
                </p>
              )}
            </>
          ) : !event.state.open ? (
            <>
              <h2>Registration closed</h2>
              <p className="muted">{event.state.reason}</p>
            </>
          ) : (
            <form className="stack" onSubmit={openTos}>
              <h2 style={{ margin: 0 }}>Register</h2>
              {event.state.waitlist && <p className="note">{event.state.reason}</p>}

              <Field label={settings?.legalNameLabel || 'Full legal name'} help={settings?.legalNameHelp}>
                <input value={form.legalName} required autoComplete="name"
                  onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
              </Field>

              {settings?.askFursonaName !== false && (
                <Field label={settings?.fursonaNameLabel || 'Fursona name'} help="The big name on your badge">
                  <input value={form.fursonaName}
                    onChange={(e) => setForm({ ...form, fursonaName: e.target.value })} />
                </Field>
              )}

              <Field label="Email" help="For event updates — optional">
                <input type="email" value={form.email} autoComplete="email"
                  onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>

              {fields.map((f) => (
                <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')} help={f.help}>
                  {f.type === 'select' ? (
                    <select value={form.answers[f.key] || ''} onChange={(e) => setForm({ ...form, answers: { ...form.answers, [f.key]: e.target.value } })}>
                      <option value="">Choose one</option>
                      {(f.options || []).map((o) => <option key={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'checkbox' ? (
                    <span className="row"><input type="checkbox" checked={!!form.answers[f.key]}
                      onChange={(e) => setForm({ ...form, answers: { ...form.answers, [f.key]: e.target.checked } })} /> {f.help}</span>
                  ) : (
                    <input type={f.type === 'number' ? 'number' : 'text'} value={form.answers[f.key] || ''}
                      onChange={(e) => setForm({ ...form, answers: { ...form.answers, [f.key]: e.target.value } })} />
                  )}
                </Field>
              ))}

              {event.donationPaypalLink && (
                <Field label="Tier">
                  <div className="tiers">
                    <button type="button" className={`tier${form.tier === 'FREE' ? ' selected' : ''}`}
                      onClick={() => setForm({ ...form, tier: 'FREE' })}>
                      <span className="tier-name">Free</span>
                      <span className="tier-help">Standard registration</span>
                    </button>
                    <button type="button" className={`tier${form.tier === 'DONATION' ? ' selected' : ''}`}
                      onClick={() => setForm({ ...form, tier: 'DONATION' })}>
                      <span className="tier-name">{event.donationTierName}</span>
                      <span className="tier-help">Opens PayPal in a new tab</span>
                    </button>
                  </div>
                </Field>
              )}

              {error && <p className="note bad">{error}</p>}
              <button className="btn signal" type="submit">Review terms and register</button>
            </form>
          )}
        </section>
      </div>

      {user && going && going.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <p className="eyebrow" style={{ marginBottom: 10 }}>Who's going</p>
          <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {going.map((g, i) => (
              <div key={i} className="row" style={{ gap: 8 }}>
                <Avatar src={g.telegramPhotoUrl} name={g.name} />
                <span>
                  <span style={{ fontWeight: 600 }}>{g.name}</span>
                  {g.telegramUsername && <span className="small muted"> @{g.telegramUsername}</span>}
                  {g.rsvp === 'MAYBE' && <span className="pill" style={{ marginLeft: 6 }}>Maybe</span>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {user && merch && merch.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <p className="eyebrow" style={{ marginBottom: 10 }}>Merch</p>
          <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {merch.map((m) => (
              <div key={m.id} className="stack" style={{ gap: 2, minWidth: 140 }}>
                <strong>{m.name}</strong>
                <span className="small muted">{m.price != null ? `$${Number(m.price).toFixed(2)}` : ''}</span>
                {m.remaining > 0 ? <span className="small muted">{m.remaining} left</span> : <Pill tone="stop">Sold out</Pill>}
              </div>
            ))}
          </div>
        </section>
      )}

      {showTos && (
        <Modal
          title={event.tosTitle}
          onClose={() => setShowTos(false)}
          footer={<>
            <button className="btn ghost" onClick={() => setShowTos(false)}>Back</button>
            <button className="btn signal" disabled={busy} onClick={accept}>
              {busy ? 'Registering…' : 'I accept — register me'}
            </button>
          </>}
        >
          <p className="tos">{event.tosBody || 'The organiser has not published terms for this event yet.'}</p>
        </Modal>
      )}
    </>
  );
}
