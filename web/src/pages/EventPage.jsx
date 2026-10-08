import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import Modal from '../components/Modal.jsx';
import { Field, fmtDate, fmtMoney, StatusPill, Avatar, RsvpButtons, Pill } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import Turnstile from '../components/Turnstile.jsx';

/// One answer input per custom question — shared by the registration popup.
function AnswerInput({ f, answers, setAnswer }) {
  if (f.type === 'select') {
    return (
      <select value={answers[f.key] || ''} onChange={(e) => setAnswer(f.key, e.target.value)}>
        <option value="">Choose one</option>
        {(f.options || []).map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  }
  if (f.type === 'checkbox') {
    return <span className="row"><input type="checkbox" checked={!!answers[f.key]} onChange={(e) => setAnswer(f.key, e.target.checked)} /> {f.help}</span>;
  }
  if (f.type === 'qualifier') {
    const picked = Array.isArray(answers[f.key]) ? answers[f.key] : [];
    return (
      <div className="stack" style={{ gap: 4 }}>
        {(f.options || []).map((o) => (
          <label key={o} className="row small">
            <input type="checkbox" checked={picked.includes(o)}
              onChange={(e) => setAnswer(f.key, e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))} /> {o}
          </label>
        ))}
      </div>
    );
  }
  return <input type={f.type === 'number' ? 'number' : 'text'} value={answers[f.key] || ''} onChange={(e) => setAnswer(f.key, e.target.value)} />;
}

const tierPrice = (t) => (t.priceCents ? fmtMoney(t.priceCents, t.currency) : 'Free');
const tierAvailability = (t, payOnline) => [
  t.soldOut ? 'Sold out' : t.remaining != null ? `${t.remaining} left` : '',
  t.priceCents > 0 && !payOnline && !t.soldOut ? 'Pay at the door' : '',
].filter(Boolean).join(' · ');

export default function EventPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user, settings, refresh } = useSession();
  const [event, setEvent] = useState(null);
  usePageMeta({ title: event?.title, description: event?.tagline || event?.description });
  const [form, setForm] = useState({ legalName: '', fursonaName: '', email: '', answers: {}, ticketTierId: '', voucherCode: '' });
  // null = closed; 'details' -> 'terms' inside the registration popup.
  const [step, setStep] = useState(null);
  const [showVoucher, setShowVoucher] = useState(false);
  const [error, setError] = useState('');
  const [pageNote, setPageNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [going, setGoing] = useState(null);
  const [merch, setMerch] = useState(null);

  const load = () => api.get(`/api/events/${slug}`).then((e) => {
    setEvent(e);
    setForm((f) => ({
      ...f,
      legalName: e.registration?.legalName || user?.legalName || '',
      fursonaName: e.registration?.fursonaName || user?.fursonaName || '',
      email: e.registration?.email || user?.email || '',
      // Preselect when there's nothing to choose between.
      ticketTierId: f.ticketTierId || (e.tiers?.filter((t) => !t.soldOut).length === 1 ? e.tiers.find((t) => !t.soldOut).id : ''),
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
  // Back from Stripe's "cancel" link.
  useEffect(() => {
    if (params.get('payment') === 'cancelled') {
      setPageNote('Payment was cancelled. Your spot is still held for a little while — complete payment below, or cancel it from your tickets.');
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const rsvp = async (value) => {
    const updated = await api.post(`/api/my/tickets/${event.registration.code}/rsvp`, { rsvp: value });
    setEvent((e) => ({ ...e, registration: { ...e.registration, rsvp: updated.rsvp } }));
    api.get(`/api/events/${slug}/rsvps`).then(setGoing).catch(() => {});
  };

  const pay = async () => {
    setBusy(true);
    setPageNote('');
    try { window.location.href = (await api.post(`/api/my/tickets/${event.registration.code}/pay`)).url; }
    catch (e) { setPageNote(e.message); load(); setBusy(false); }
  };

  if (error && !event) return <p className="note bad" style={{ marginTop: 40 }}>{error}</p>;
  if (!event) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  const fields = event.customFields || [];
  const tiers = event.tiers || [];
  const reg = event.registration;
  const registered = reg && reg.status !== 'CANCELLED';
  const selectedTier = tiers.find((t) => t.id === form.ticketTierId);
  const usingVoucher = Boolean(form.voucherCode.trim());
  const payOnline = settings?.payments?.online;
  const goesToPayment = !usingVoucher && selectedTier?.priceCents > 0 && payOnline;
  // Only the guest (no signed-in session) path is challenged — see the
  // matching guard server-side in public.js's /register handler.
  const captchaRequired = !user && settings?.turnstile?.enabled;
  const setAnswer = (key, value) => setForm((f) => ({ ...f, answers: { ...f.answers, [key]: value } }));

  const openRegister = ({ voucher = false } = {}) => {
    setError('');
    if (voucher) setShowVoucher(true);
    setStep('details');
  };
  const closeRegister = () => { setStep(null); setError(''); };

  const toTerms = (e) => {
    e?.preventDefault();
    setError('');
    if (!usingVoucher && !form.ticketTierId) return setError('Choose a ticket.');
    if (form.legalName.trim().length < 2) return setError('Enter your preferred name.');
    if (!user && !/^\S+@\S+\.\S+$/.test(form.email)) return setError('Enter an email address so you can get back into your account later.');
    for (const f of fields) {
      const v = form.answers[f.key];
      if (f.required && (Array.isArray(v) ? v.length === 0 : !v)) return setError(`${f.label} is required.`);
    }
    setStep('terms');
  };

  const accept = async () => {
    const wasGuest = !user;
    setBusy(true);
    setError('');
    try {
      const created = await api.post(`/api/events/${slug}/register`, {
        ...form, ticketTierId: form.ticketTierId || undefined, acceptedTos: true, turnstileToken: captchaToken,
      });
      // Gate on the server's result, not the form — a voucher code can turn
      // a paid pick into a free confirmed spot.
      if (created.checkoutUrl) {
        window.location.href = created.checkoutUrl;
        return;
      }
      setStep(null);
      if (wasGuest) await refresh();
      if (created.checkoutError) {
        // The seat is held; the "complete payment" button on this page retries.
        setPageNote(created.checkoutError);
        await load();
        return;
      }
      nav(wasGuest ? '/account?justRegistered=1' : '/tickets');
    } catch (e) {
      setError(e.message);
      setStep('details');
    } finally { setBusy(false); }
  };

  const tierPicker = (
    <div className="tiers">
      {tiers.map((t) => (
        <button key={t.id} type="button" disabled={t.soldOut}
          className={`tier${form.ticketTierId === t.id ? ' selected' : ''}`}
          onClick={() => setForm({ ...form, ticketTierId: t.id })}>
          <span className="tier-name">{t.name}</span>
          <span className="tier-price">{tierPrice(t)}</span>
          {t.description && <span className="tier-help">{t.description}</span>}
          <span className="tier-help">{tierAvailability(t, payOnline)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      <header style={{ padding: '40px 0 24px', maxWidth: 680 }}>
        <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: event.title }]} />
        {!event.published && (
          <p className="note" style={{ marginBottom: 14 }}>
            <strong>Staff preview</strong>
            This event is not published. Attendees can't see or register for this page yet.
          </p>
        )}
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
            {event.confirmed > 0 && <><dt className="eyebrow">Registered</dt><dd style={{ margin: 0 }}>{event.confirmed}</dd></>}
          </dl>
        </article>

        <section className="card">
          {pageNote && <p className="note" style={{ marginBottom: 14 }}>{pageNote}</p>}
          {registered && reg.status === 'PENDING_PAYMENT' ? (
            <div className="stack">
              <h2 style={{ margin: 0 }}>Almost there</h2>
              <p className="muted" style={{ margin: 0 }}>
                Your {reg.tierName || 'ticket'} spot is held while you pay. It's confirmed as soon as the payment goes through.
              </p>
              <p className="row" style={{ margin: 0 }}><StatusPill status={reg.status} /> {reg.tierPriceCents != null && <strong>{fmtMoney(reg.tierPriceCents, reg.currency)}</strong>}</p>
              <div className="row">
                <button className="btn signal" disabled={busy} onClick={pay}>{busy ? 'Opening payment…' : 'Complete payment'}</button>
                <Link className="btn ghost" to="/tickets">Manage in tickets</Link>
              </div>
            </div>
          ) : registered ? (
            <div className="stack">
              <h2 style={{ margin: 0 }}>You are in</h2>
              <p className="row" style={{ margin: 0 }}>
                <StatusPill status={reg.status} /> <span className="code">{reg.code}</span>
                {reg.tierName && <Pill>{reg.tierName}</Pill>}
              </p>
              {reg.balanceDueCents > 0 && <p className="note" style={{ margin: 0 }}>Pay {fmtMoney(reg.balanceDueCents, reg.currency)} at the door.</p>}
              <div>
                <p className="eyebrow" style={{ marginBottom: 6 }}>Going?</p>
                <RsvpButtons value={reg.rsvp} onChange={rsvp} />
              </div>
              <Link className="btn primary" to="/tickets" style={{ justifySelf: 'start' }}>Open your ticket</Link>
            </div>
          ) : (
            <div className="stack">
              <h2 style={{ margin: 0 }}>{event.state.open ? 'Tickets' : 'Registration closed'}</h2>
              {!event.state.open && <p className="muted" style={{ margin: 0 }}>{event.state.reason}</p>}
              {event.state.open && event.state.waitlist && <p className="note" style={{ margin: 0 }}>{event.state.reason}</p>}

              {event.state.open && (tiers.length ? (
                <ul className="tier-list">
                  {tiers.map((t) => (
                    <li key={t.id}>
                      <div>
                        <strong>{t.name}</strong>
                        {t.description && <p className="small muted" style={{ margin: '2px 0 0' }}>{t.description}</p>}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <strong>{tierPrice(t)}</strong>
                        <div className="small muted">{tierAvailability(t, payOnline)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted" style={{ margin: 0 }}>No tickets are on sale yet.</p>)}

              {event.state.open && tiers.some((t) => !t.soldOut) && (
                user ? (
                  <button className="btn signal" style={{ justifySelf: 'start' }} onClick={() => openRegister()}>Register</button>
                ) : (
                  <>
                    <div className="row">
                      <Link className="btn primary" to="/login">Continue with Telegram</Link>
                      <button type="button" className="btn" onClick={() => openRegister()}>Register with email</button>
                    </div>
                    {settings?.telegramBot && (
                      <p className="small muted" style={{ margin: 0 }}>
                        Or skip the site entirely: message <a href={`https://t.me/${settings.telegramBot}`}>@{settings.telegramBot}</a> and send <code className="mono">/register</code>.
                      </p>
                    )}
                  </>
                )
              )}

              <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => openRegister({ voucher: true })}>
                Have a voucher code?
              </button>
            </div>
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

      {step && (
        <Modal
          title={step === 'details' ? `Register · ${event.title}` : event.tosTitle}
          onClose={closeRegister}
          footer={step === 'details' ? <>
            <button className="btn ghost" onClick={closeRegister}>Cancel</button>
            <button className="btn signal" onClick={toTerms}>Review terms</button>
          </> : <>
            <button className="btn ghost" disabled={busy} onClick={() => setStep('details')}>Back</button>
            <button className="btn signal" disabled={busy || (captchaRequired && !captchaToken)} onClick={accept}>
              {busy ? 'Registering…'
                : goesToPayment ? `I accept — pay ${fmtMoney(selectedTier.priceCents, selectedTier.currency)}`
                : 'I accept — register me'}
            </button>
          </>}
        >
          {step === 'details' ? (
            <form className="stack" onSubmit={toTerms}>
              {!event.state.open && <p className="note">Registration is normally closed ({event.state.reason}) — a valid voucher code will still get you in.</p>}

              {event.state.open && tiers.length > 0 && !usingVoucher && <Field label="Ticket">{tierPicker}</Field>}

              <Field label={settings?.legalNameLabel || 'Preferred name'} help={settings?.legalNameHelp}>
                <input value={form.legalName} required autoComplete="name" autoFocus
                  onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
              </Field>

              {settings?.askFursonaName !== false && (
                <Field label={settings?.fursonaNameLabel || 'Fursona name'} help="The big name on your badge">
                  <input value={form.fursonaName}
                    onChange={(e) => setForm({ ...form, fursonaName: e.target.value })} />
                </Field>
              )}

              <Field label="Email" help={user ? 'For event updates — optional' : 'Required — this is how you\'ll get back into your account'}>
                <input type="email" value={form.email} autoComplete="email" required={!user}
                  onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>

              {fields.map((f) => (
                <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')} help={f.help}>
                  <AnswerInput f={f} answers={form.answers} setAnswer={setAnswer} />
                </Field>
              ))}

              {(showVoucher || !event.state.open) ? (
                <Field label="Voucher code" help="Grants free entry and a guaranteed spot">
                  <input value={form.voucherCode}
                    onChange={(e) => setForm({ ...form, voucherCode: e.target.value })} />
                </Field>
              ) : (
                <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setShowVoucher(true)}>
                  Have a voucher code?
                </button>
              )}

              {error && <p className="note bad">{error}</p>}
              {/* Lets Enter submit the form; the visible button is in the footer. */}
              <button type="submit" hidden />
            </form>
          ) : (
            <>
              {goesToPayment && (
                <p className="note">
                  After you accept, you'll go to Stripe to pay {fmtMoney(selectedTier.priceCents, selectedTier.currency)} for {selectedTier.name}.
                  Your spot is held while you pay. Card details go straight to Stripe and never touch this site.
                </p>
              )}
              <p className="tos">{event.tosBody || 'The organiser has not published terms for this event yet.'}</p>
              {captchaRequired && (
                <div style={{ marginTop: 14 }}>
                  <Turnstile siteKey={settings.turnstile.siteKey} onChange={setCaptchaToken} />
                </div>
              )}
              {error && <p className="note bad">{error}</p>}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
