import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import Modal from '../components/Modal.jsx';
import { Field, fmtDate, fmtMoney, StatusPill, Avatar, RsvpButtons, Pill, HoldCountdown, fieldsForTier } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import Turnstile from '../components/Turnstile.jsx';
import PaymentNotice from '../components/PaymentNotice.jsx';

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
const shortDate = (d, tz) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });
const buyable = (t) => t.onSale !== false && !t.soldOut;
const tierAvailability = (t, payOnline, tz) => [
  t.onSale === false && t.salesStartAt ? `On sale ${shortDate(t.salesStartAt, tz)}` : '',
  t.onSale !== false && t.soldOut ? 'Sold out' : t.onSale !== false && t.remaining != null ? `${t.remaining} left` : '',
  t.onSale !== false && t.salesEndAt ? `Until ${shortDate(t.salesEndAt, tz)}` : '',
  t.priceCents > 0 && !payOnline && buyable(t) ? 'Pay at the door' : '',
].filter(Boolean).join(' · ');

export default function EventPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user, settings, refresh } = useSession();
  const [event, setEvent] = useState(null);
  usePageMeta({ title: event?.title, description: event?.tagline || event?.description });
  const [form, setForm] = useState({ legalName: '', fursonaName: '', email: '', answers: {}, ticketTierId: '', voucherCode: '', discountCode: '', donationCents: 0 });
  // A discount code that's been checked against the chosen tier: { code, tierId, ticketCents, label }.
  const [discount, setDiscount] = useState(null);
  const [discountInput, setDiscountInput] = useState('');
  const [discountMsg, setDiscountMsg] = useState('');
  const [customDonation, setCustomDonation] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  // "Buy for friends": [{ name, contact }] where contact is an email or @telegram.
  const [friends, setFriends] = useState([]);
  const [showDiscount, setShowDiscount] = useState(false);
  const [preorder, setPreorder] = useState({});
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
      ticketTierId: f.ticketTierId || (e.tiers?.filter(buyable).length === 1 ? e.tiers.find(buyable).id : ''),
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
      setPageNote('Payment cancelled. Your spot is held until the timer runs out.');
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

  const tiers = event.tiers || [];
  const reg = event.registration;
  const registered = reg && reg.status !== 'CANCELLED';
  const selectedTier = tiers.find((t) => t.id === form.ticketTierId);
  const usingVoucher = Boolean(form.voucherCode.trim());
  // Only the questions for the chosen ticket (a voucher has no ticket type).
  const fields = fieldsForTier(event, usingVoucher ? null : form.ticketTierId);
  // Only counts while it's still for the tier it was checked against.
  const appliedDiscount = discount && discount.tierId === form.ticketTierId ? discount : null;
  const ticketCents = selectedTier ? (appliedDiscount ? appliedDiscount.ticketCents : selectedTier.priceCents) : 0;
  const donationAddon = !usingVoucher && event.donationAddon && settings?.payments?.online ? event.donationAddon : null;
  const donationCents = donationAddon ? form.donationCents : 0;
  const payOnline = settings?.payments?.online;
  // Friends need a seat each and online payment for paid tickets; never on
  // the waitlist or with a voucher.
  const canBuyForFriends = Boolean(selectedTier) && !usingVoucher && event.state.open && !event.state.waitlist
    && (!selectedTier.priceCents || payOnline);
  const friendRows = canBuyForFriends ? friends : [];
  const friendsCents = selectedTier ? selectedTier.priceCents * friendRows.length : 0;
  const totalCents = ticketCents + donationCents + friendsCents;
  const waitlisting = event.state.waitlist && !usingVoucher;
  const goesToPayment = !usingVoucher && !waitlisting && totalCents > 0 && payOnline;

  const applyDiscount = async () => {
    setDiscountMsg('');
    if (!form.ticketTierId) return setDiscountMsg('Choose a ticket first.');
    try {
      const r = await api.post(`/api/events/${slug}/discount`, { code: discountInput, ticketTierId: form.ticketTierId });
      setDiscount({ ...r, tierId: form.ticketTierId });
      setForm((f) => ({ ...f, discountCode: r.code }));
    } catch (e) {
      setDiscount(null);
      setForm((f) => ({ ...f, discountCode: '' }));
      setDiscountMsg(e.message);
    }
  };
  const removeDiscount = () => { setDiscount(null); setDiscountInput(''); setDiscountMsg(''); setForm((f) => ({ ...f, discountCode: '' })); };

  const placePreorder = async () => {
    const items = Object.entries(preorder).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ itemId, quantity }));
    setPageNote('');
    try { window.location.href = (await api.post(`/api/events/${slug}/merch/orders`, { items })).checkoutUrl; }
    catch (e) { setPageNote(e.message); }
  };
  // Only the guest (no signed-in session) path is challenged — see the
  // matching guard server-side in public.js's /register handler.
  const captchaRequired = !user && settings?.turnstile?.enabled;
  const setAnswer = (key, value) => setForm((f) => ({ ...f, answers: { ...f.answers, [key]: value } }));
  const canPreorder = reg?.status === 'CONFIRMED' && settings?.payments?.online;
  const preorderCents = (merch || []).reduce((sum, m) => sum + (preorder[m.id] || 0) * (m.priceCents || 0), 0);

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
    for (const f of friendRows) {
      if (f.name.trim().length < 2) return setError('Enter a name for each friend.');
      if (!f.contact.trim()) return setError(`Add an email or @telegram for ${f.name.trim()}.`);
    }
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
    let redirecting = false;
    setBusy(true);
    setError('');
    try {
      const created = await api.post(`/api/events/${slug}/register`, {
        ...form, ticketTierId: form.ticketTierId || undefined, acceptedTos: true, turnstileToken: captchaToken,
        discountCode: appliedDiscount && !usingVoucher ? form.discountCode : undefined,
        donationCents: donationCents || undefined,
        friends: friendRows.length ? friendRows : undefined,
      });
      // Gate on the server's result, not the form — a voucher code can turn
      // a paid pick into a free confirmed spot.
      if (created.checkoutUrl) {
        redirecting = true;
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
    } finally { if (!redirecting) setBusy(false); }
  };

  const tierPicker = (
    <div className="tiers">
      {tiers.map((t) => (
        <button key={t.id} type="button" disabled={!buyable(t)}
          className={`tier${form.ticketTierId === t.id ? ' selected' : ''}`}
          onClick={() => setForm({ ...form, ticketTierId: t.id })}>
          <span className="tier-name">{t.name}</span>
          <span className="tier-price">{tierPrice(t)}</span>
          {t.description && <span className="tier-help">{t.description}</span>}
          <span className="tier-help">{tierAvailability(t, payOnline, event.timezone)}</span>
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
            Not published yet. Only staff can see this page.
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
              <p className="row" style={{ margin: 0 }}><StatusPill status={reg.status} /> {reg.chargeCents > 0 && <strong>{fmtMoney(reg.chargeCents, reg.currency)}</strong>}</p>
              <HoldCountdown until={reg.holdExpiresAt} onExpire={() => setTimeout(load, 10_000)} />
              <div className="row">
                <button className="btn signal" disabled={busy} data-busy={busy ? 'true' : undefined} onClick={pay}>{busy ? 'Opening payment…' : 'Complete payment'}</button>
                <Link className="btn ghost" to="/tickets">Manage in tickets</Link>
              </div>
              <PaymentNotice />
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
                        <div className="small muted">{tierAvailability(t, payOnline, event.timezone)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted" style={{ margin: 0 }}>No tickets are on sale yet.</p>)}
              {event.state.open && tiers.some((t) => t.priceCents > 0 && buyable(t)) && <PaymentNotice variant={payOnline ? 'online' : 'door'} />}

              {event.state.open && tiers.some(buyable) && (
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
                {canPreorder && m.preorder && m.remaining > 0 && (
                  <input type="number" min="0" max={Math.min(m.remaining, 10)} placeholder="Qty" aria-label={`How many ${m.name}`}
                    value={preorder[m.id] || ''} style={{ width: 90, marginTop: 6 }}
                    onChange={(e) => setPreorder({ ...preorder, [m.id]: Math.max(0, Math.min(Number(e.target.value) || 0, m.remaining, 10)) })} />
                )}
              </div>
            ))}
          </div>
          {canPreorder && merch.some((m) => m.preorder && m.remaining > 0) && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn signal" disabled={!preorderCents} onClick={placePreorder}>
                {preorderCents ? `Pre-order · ${fmtMoney(preorderCents)}` : 'Pre-order'}
              </button>
              <span className="small muted">Paid online, picked up at the merch table.</span>
            </div>
          )}
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
            <button className="btn signal" disabled={busy || (captchaRequired && !captchaToken)} data-busy={busy ? 'true' : undefined} onClick={accept}>
              {busy ? 'Registering…'
                : goesToPayment ? `I accept · pay ${fmtMoney(totalCents, selectedTier?.currency)}`
                : waitlisting ? 'I accept · join waitlist'
                : 'I accept · register me'}
            </button>
          </>}
        >
          {step === 'details' ? (
            <form className="stack" onSubmit={toTerms}>
              {!event.state.open && <p className="note">Registration is closed ({event.state.reason}). A voucher code still gets you in.</p>}

              {event.state.open && tiers.length > 0 && !usingVoucher && (
                <section className="reg-section">
                  <h3 className="reg-heading">Ticket</h3>
                  {tierPicker}
                </section>
              )}

              <section className="reg-section">
                <h3 className="reg-heading">Your details</h3>
                <Field label={settings?.legalNameLabel || 'Preferred name'} help={settings?.legalNameHelp}>
                  <input value={form.legalName} required autoComplete="name" autoFocus
                    onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
                </Field>
                {settings?.askFursonaName !== false && (
                  <Field label={settings?.fursonaNameLabel || 'Fursona name'} help="The big name on your badge">
                    <input value={form.fursonaName} onChange={(e) => setForm({ ...form, fursonaName: e.target.value })} />
                  </Field>
                )}
                <Field label="Email" help={user ? 'Optional' : 'Used to sign back in'}>
                  <input type="email" value={form.email} autoComplete="email" required={!user}
                    onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </Field>
                {fields.map((f) => (
                  <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')} help={f.help}>
                    <AnswerInput f={f} answers={form.answers} setAnswer={setAnswer} />
                  </Field>
                ))}
              </section>

              {donationAddon && selectedTier && (
                <section className="reg-section">
                  <h3 className="reg-heading">{donationAddon.label} <span className="help">(optional)</span></h3>
                  <div className="chips" role="radiogroup" aria-label={donationAddon.label}>
                    <button type="button" role="radio" aria-checked={!form.donationCents && !customOpen}
                      className={`chip${!form.donationCents && !customOpen ? ' selected' : ''}`}
                      onClick={() => { setCustomOpen(false); setCustomDonation(''); setForm({ ...form, donationCents: 0 }); }}>No thanks</button>
                    {donationAddon.presets.map((c) => {
                      const on = !customOpen && form.donationCents === c;
                      return (
                        <button key={c} type="button" role="radio" aria-checked={on} className={`chip${on ? ' selected' : ''}`}
                          onClick={() => { setCustomOpen(false); setCustomDonation(''); setForm({ ...form, donationCents: c }); }}>
                          {fmtMoney(c, selectedTier.currency)}
                        </button>
                      );
                    })}
                    {customOpen ? (
                      <span className="chip selected chip-input">
                        <span>$</span>
                        <input inputMode="decimal" autoFocus placeholder="0.00" value={customDonation} aria-label="Other donation amount"
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9.]/g, '');
                            setCustomDonation(v);
                            const cents = Math.round(Number(v) * 100);
                            setForm({ ...form, donationCents: Number.isFinite(cents) && cents > 0 ? cents : 0 });
                          }} />
                      </span>
                    ) : (
                      <button type="button" className="chip" onClick={() => { setCustomOpen(true); setForm({ ...form, donationCents: 0 }); }}>Other</button>
                    )}
                  </div>
                </section>
              )}

              {canBuyForFriends && (
                <section className="reg-section">
                  <h3 className="reg-heading">Tickets for friends <span className="help">(optional)</span></h3>
                  {friends.map((f, i) => (
                    <div key={i} className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                      <input placeholder="Name" value={f.name} style={{ flex: 1 }}
                        onChange={(e) => setFriends(friends.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} />
                      <input placeholder="Email or @telegram" value={f.contact} style={{ flex: 1.3 }}
                        onChange={(e) => setFriends(friends.map((x, n) => (n === i ? { ...x, contact: e.target.value } : x)))} />
                      <button type="button" className="btn ghost sm" aria-label="Remove friend" onClick={() => setFriends(friends.filter((_, n) => n !== i))}>✕</button>
                    </div>
                  ))}
                  {friends.length < 5 && (
                    <button type="button" className="link-btn" style={{ justifySelf: 'start' }} onClick={() => setFriends([...friends, { name: '', contact: '' }])}>
                      + Add a ticket for a friend
                    </button>
                  )}
                  {friends.length > 0 && <p className="small muted" style={{ margin: 0 }}>They'll get their ticket by email or Telegram.</p>}
                </section>
              )}

              {selectedTier && !usingVoucher && selectedTier.priceCents + donationCents + friendsCents > 0 && (
                <section className="reg-summary">
                  <div className="spread"><span>{selectedTier.name}</span><span className="mono">{fmtMoney(selectedTier.priceCents, selectedTier.currency)}</span></div>
                  {appliedDiscount && (
                    <div className="spread reg-discount">
                      <span>
                        Code <strong className="mono">{appliedDiscount.code}</strong> ({appliedDiscount.label})
                        {' '}<button type="button" className="link-btn" onClick={removeDiscount}>Remove</button>
                      </span>
                      <span className="mono">−{fmtMoney(selectedTier.priceCents - appliedDiscount.ticketCents, selectedTier.currency)}</span>
                    </div>
                  )}
                  {friendRows.map((f, i) => (
                    <div key={i} className="spread"><span>{selectedTier.name} for {f.name || 'a friend'}</span><span className="mono">{fmtMoney(selectedTier.priceCents, selectedTier.currency)}</span></div>
                  ))}
                  {donationCents > 0 && (
                    <div className="spread"><span>Donation</span><span className="mono">{fmtMoney(donationCents, selectedTier.currency)}</span></div>
                  )}
                  <div className="spread reg-total"><strong>Total</strong><strong className="mono">{fmtMoney(totalCents, selectedTier.currency)}</strong></div>
                  {waitlisting
                    ? <p className="small muted" style={{ margin: 0 }}>This event is full. You'll join the waitlist and only pay if a spot opens.</p>
                    : totalCents > 0 && <PaymentNotice variant={payOnline ? 'online' : 'door'} />}
                </section>
              )}

              {/* Codes: discount (money off a paid ticket) and voucher (free entry). */}
              {!usingVoucher && selectedTier?.priceCents > 0 && !appliedDiscount && showDiscount && (
                <Field label="Discount code">
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input value={discountInput} autoFocus onChange={(e) => setDiscountInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyDiscount(); } }} />
                    <button type="button" className="btn" disabled={!discountInput.trim()} onClick={applyDiscount}>Apply</button>
                  </div>
                  {discountMsg && <span className="small" style={{ color: 'var(--stop)' }}>{discountMsg}</span>}
                </Field>
              )}
              {(showVoucher || !event.state.open) && (
                <Field label="Voucher code" help="Grants free entry and a guaranteed spot">
                  <input value={form.voucherCode} onChange={(e) => setForm({ ...form, voucherCode: e.target.value })} />
                </Field>
              )}
              {((!showDiscount && !appliedDiscount && !usingVoucher && selectedTier?.priceCents > 0) || (!showVoucher && event.state.open)) && (
                <div className="row" style={{ gap: 18 }}>
                  {!showDiscount && !appliedDiscount && !usingVoucher && selectedTier?.priceCents > 0 && (
                    <button type="button" className="link-btn" onClick={() => setShowDiscount(true)}>Have a discount code?</button>
                  )}
                  {!showVoucher && event.state.open && (
                    <button type="button" className="link-btn" onClick={() => setShowVoucher(true)}>Have a voucher code?</button>
                  )}
                </div>
              )}

              {error && <p className="note bad">{error}</p>}
              {/* Lets Enter submit the form; the visible button is in the footer. */}
              <button type="submit" hidden />
            </form>
          ) : (
            <>
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
