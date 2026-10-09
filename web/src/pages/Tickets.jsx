import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import { downloadEventIcs } from '../lib/ics.js';
import { Empty, StatusPill, RsvpButtons, fmtDate, fmtMoney, Field, HoldCountdown } from '../components/Bits.jsx';
import Modal from '../components/Modal.jsx';
import PaymentNotice from '../components/PaymentNotice.jsx';

const TICKET_GRID = { display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill,minmax(min(320px,100%),1fr))' };

function TicketCard({ t, settings, onModify, onGoogleWallet }) {
  return (
    <div className="stub">
      <div className="stub-accent" style={{ background: t.event.accentColor }} />
      <div className="stub-head">
        <p className="eyebrow">{fmtDate(t.event.startsAt, t.event.timezone)}</p>
        <h2 style={{ margin: '4px 0 2px' }}>{t.event.title}</h2>
        <p className="small muted" style={{ margin: 0 }}>{t.event.venue}</p>
        <div style={{ margin: '18px 0 6px', display: 'grid', placeItems: 'center' }}>
          <img alt={`QR code for ${t.code}`} width="190" height="190"
            src={`${api.base}/api/my/tickets/${t.code}/qr.png`} style={{ borderRadius: 8 }} />
        </div>
        <p className="code" style={{ textAlign: 'center', margin: 0 }}>{t.code}</p>
        <p className="small muted" style={{ textAlign: 'center' }}>{settings?.ticketFooter}</p>
      </div>
      <div className="stub-tear" />
      <div className="stub-foot stack">
        <div className="spread">
          <span className="small muted">{t.fursonaName || t.legalName}</span>
          <StatusPill status={t.status} checkedInAt={t.checkedInAt} />
        </div>
        {t.status !== 'CANCELLED' && (
          <button className="btn sm" onClick={() => onModify(t)}>Modify ticket</button>
        )}
        <div className="row">
          <button className="btn sm" onClick={() => downloadEventIcs({
            uid: t.code, title: t.event.title, venue: t.event.venue,
            startsAt: t.event.startsAt, endsAt: t.event.endsAt, description: `Badge code: ${t.code}`,
          })}>
            Add to calendar
          </button>
          {settings?.wallet?.apple && (
            <a className="btn sm" href={`${api.base}/api/my/tickets/${t.code}/apple.pkpass`}>Add to Apple Wallet</a>
          )}
          {settings?.wallet?.google && (
            <button className="btn sm" onClick={() => onGoogleWallet(t.code)}>Add to Google Wallet</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Tickets() {
  const { settings, refresh } = useSession();
  usePageMeta({ title: 'My tickets', noindex: true });
  const [tickets, setTickets] = useState(null);
  const [params, setParams] = useSearchParams();
  const [payNote, setPayNote] = useState('');
  const [payBusy, setPayBusy] = useState('');
  const [orders, setOrders] = useState([]);
  const load = () => {
    api.get('/api/my/merch-orders').then(setOrders).catch(() => setOrders([]));
    return api.get('/api/my/tickets').then(setTickets);
  };

  // Back from Stripe Checkout: settle the session from Stripe right away
  // instead of waiting on the webhook, then show the confirmed ticket.
  useEffect(() => {
    const sessionId = params.get('session_id');
    if (params.get('paid') && sessionId) {
      setPayNote('Payment received. Confirming your ticket…');
      api.post('/api/my/payments/sync', { sessionId })
        .then((r) => setPayNote(
          r.kind === 'merch'
            ? (r.status === 'PAID' ? 'Payment received. Your pre-order is confirmed. Pick it up at the merch table.' : 'Payment received. Your pre-order will update in a moment.')
            : (r.status === 'CONFIRMED' ? 'Payment received. You are registered!' : 'Payment received. Your ticket will update in a moment.')))
        .catch(() => setPayNote('Payment received. Your ticket will update in a moment.'))
        .finally(() => { setParams({}, { replace: true }); load(); });
    } else {
      load();
    }
    // eslint-disable-next-line
  }, []);

  const payOrder = async (id) => {
    setPayBusy(id);
    try { window.location.href = (await api.post(`/api/my/merch-orders/${id}/pay`)).url; }
    catch (e) { setPayNote(e.message); setPayBusy(''); load(); }
  };

  const pay = async (code) => {
    setPayBusy(code);
    try { window.location.href = (await api.post(`/api/my/tickets/${code}/pay`)).url; }
    catch (e) { setPayNote(e.message); setPayBusy(''); load(); }
  };

  const google = async (code) => {
    try { window.location.href = (await api.get(`/api/my/tickets/${code}/google`)).url; }
    catch (e) { alert(e.message); }
  };

  const [modifying, setModifying] = useState(null);
  const [badgeName, setBadgeName] = useState('');
  const [nameMsg, setNameMsg] = useState('');
  const [nameMsgOk, setNameMsgOk] = useState(true);
  const [showTransferNudge, setShowTransferNudge] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferMethod, setTransferMethod] = useState('telegram');
  const [transferValue, setTransferValue] = useState('');
  const [transferConfirm, setTransferConfirm] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMsg, setTransferMsg] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const openModify = (t) => {
    setModifying(t);
    setBadgeName(t.fursonaName || t.legalName || '');
    setNameMsg('');
    setShowTransferNudge(false);
    setTransferOpen(false);
    setTransferConfirm(false);
    setTransferValue('');
    setTransferMsg('');
  };
  const closeModify = () => setModifying(null);

  const saveBadgeName = async (e) => {
    e.preventDefault();
    setNameMsg('');
    try {
      await api.post('/api/auth/fursona-name', { fursonaName: badgeName });
      await refresh();
      load();
      setNameMsg('Badge name updated.');
      setNameMsgOk(true);
    } catch (err) { setNameMsg(err.message); setNameMsgOk(false); }
  };

  const rsvp = async (code, value) => {
    const updated = await api.post(`/api/my/tickets/${code}/rsvp`, { rsvp: value });
    setTickets((cur) => cur.map((t) => (t.code === code ? { ...t, rsvp: updated.rsvp } : t)));
    setModifying((m) => (m && m.code === code ? { ...m, rsvp: updated.rsvp } : m));
    setShowTransferNudge(value === 'NO');
  };

  const cancelTicket = async (code) => {
    const t = tickets.find((x) => x.code === code);
    const paid = t?.paidCents > 0;
    const auto = t?.event?.cancelPolicy === 'AUTO_REFUND';
    let note;
    if (!paid) {
      if (!confirm('Cancel this registration? This cannot be undone.')) return;
    } else if (auto) {
      if (!confirm(`Cancel this registration and get ${fmtMoney(t.paidCents, t.currency)} refunded? This cannot be undone.`)) return;
    } else {
      note = prompt('Ask to cancel and refund this ticket? Add a reason (optional):', '');
      if (note == null) return;
    }
    setCancelBusy(true);
    try {
      const { outcome } = await api.post(`/api/my/tickets/${code}/cancel`, { note });
      setPayNote({
        cancelled: 'Your registration has been cancelled.',
        refunded: "Cancelled and refunded. It's back on your card in 5 to 10 business days.",
        requested: "Request sent. We'll message you when it's approved.",
        already_requested: "You've already asked to cancel this one.",
      }[outcome]);
      closeModify();
      load();
    } catch (e) { alert(e.message); }
    finally { setCancelBusy(false); }
  };
  const cancelLabel = (t) => (t?.paidCents > 0
    ? (t.event?.cancelPolicy === 'AUTO_REFUND' ? 'Cancel and refund' : 'Request cancellation')
    : 'Cancel registration');

  const submitTransfer = async () => {
    setTransferBusy(true);
    setTransferMsg('');
    try {
      await api.post(`/api/my/tickets/${modifying.code}/transfer`, {
        [transferMethod === 'telegram' ? 'telegramUsername' : 'email']: transferValue,
      });
      closeModify();
      load();
    } catch (e) {
      setTransferMsg(e.message);
      setTransferBusy(false);
    }
  };

  if (!tickets) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  return (
    <>
      <header style={{ padding: '40px 0 24px' }}>
        <p className="eyebrow">Your wallet</p>
        <h1>Tickets</h1>
      </header>

      {payNote && <p className="note good" style={{ marginBottom: 20 }}>{payNote}</p>}
      {tickets.length === 0 && <Empty title="No tickets yet">Pick an event from the home page to register.</Empty>}

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill,minmax(min(320px,100%),1fr))' }}>
        {tickets.map((t) => (
          <div key={t.code} className="stub">
            <div className="stub-accent" style={{ background: t.event.accentColor }} />
            <div className="stub-head">
              <p className="eyebrow">{fmtDate(t.event.startsAt, t.event.timezone)}</p>
              <h2 style={{ margin: '4px 0 2px' }}>{t.event.title}</h2>
              <p className="small muted" style={{ margin: 0 }}>{t.event.venue}</p>
              {t.status === 'PENDING_PAYMENT' ? (
                // No QR until it's paid — it wouldn't get them in anyway.
                <div className="stack" style={{ margin: '18px 0 6px', justifyItems: 'center', textAlign: 'center' }}>
                  <p className="muted" style={{ margin: 0 }}>Pay{t.chargeCents > 0 ? ` ${fmtMoney(t.chargeCents, t.currency)}` : ''} to confirm your spot.</p>
                  <HoldCountdown until={t.holdExpiresAt} onExpire={() => setTimeout(load, 10_000)} />
                  <button className="btn signal" disabled={payBusy === t.code} data-busy={payBusy === t.code ? 'true' : undefined} onClick={() => pay(t.code)}>
                    {payBusy === t.code ? 'Opening payment…' : 'Complete payment'}
                  </button>
                  <PaymentNotice />
                </div>
              ) : (
                <>
                  <div style={{ margin: '18px 0 6px', display: 'grid', placeItems: 'center' }}>
                    <img alt={`QR code for ${t.code}`} width="190" height="190"
                      src={`${api.base}/api/my/tickets/${t.code}/qr.png`} style={{ borderRadius: 8 }} />
                  </div>
                  <p className="code" style={{ textAlign: 'center', margin: 0 }}>{t.code}</p>
                </>
              )}
              {t.status !== 'PENDING_PAYMENT' && <p className="small muted" style={{ textAlign: 'center' }}>{settings?.ticketFooter}</p>}
            </div>
            <div className="stub-tear" />
            <div className="stub-foot stack">
              <div className="spread">
                <span className="small muted">{t.fursonaName || t.legalName}{t.tierName ? ` · ${t.tierName}` : ''}</span>
                <StatusPill status={t.status} checkedInAt={t.checkedInAt} />
              </div>
              {t.cancelRequestedAt && <p className="note" style={{ margin: 0 }}>Cancellation requested. Waiting on the organizers.</p>}
              {t.paidBy && <p className="small muted" style={{ margin: 0 }}>Bought for you by {t.paidBy.name}.</p>}
              {t.boughtFor?.some((f) => f.status !== 'CANCELLED') && (
                <p className="small muted" style={{ margin: 0 }}>Includes tickets for {t.boughtFor.filter((f) => f.status !== 'CANCELLED').map((f) => f.name).join(', ')}.</p>
              )}
              {(t.paidCents > 0 || t.payments?.length > 0) && t.status !== 'PENDING_PAYMENT' && (
                <a className="small" href={`${api.base}/api/my/tickets/${t.code}/receipt`} target="_blank" rel="noreferrer">Receipt</a>
              )}
              {t.balanceDueCents > 0 && t.status !== 'PENDING_PAYMENT' && (
                <p className="small muted" style={{ margin: 0 }}>Pay {fmtMoney(t.balanceDueCents, t.currency)} at the door.</p>
              )}
              {t.status !== 'CANCELLED' && t.status !== 'PENDING_PAYMENT' && (
                <button className="btn sm" onClick={() => openModify(t)}>Modify ticket</button>
              )}
              {/* No wallet pass for an unpaid ticket — its QR wouldn't get them in. */}
              {t.status !== 'PENDING_PAYMENT' && <div className="row">
                {settings?.wallet?.apple && (
                  <a className="btn sm" href={`${api.base}/api/my/tickets/${t.code}/apple.pkpass`}>Add to Apple Wallet</a>
                )}
                {settings?.wallet?.google && (
                  <button className="btn sm" onClick={() => google(t.code)}>Add to Google Wallet</button>
                )}
              </div>}
            </div>
          </div>
        ))}
      </div>

      {orders.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <p className="eyebrow" style={{ marginBottom: 10 }}>Your pre-orders</p>
          <div className="stack">
            {orders.map((o) => (
              <div key={o.id} className="card spread" style={{ alignItems: 'flex-start' }}>
                <div className="stack" style={{ gap: 4 }}>
                  <strong>{o.event?.title}</strong>
                  <span className="small muted">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} · {fmtMoney(o.totalCents, o.currency)}</span>
                  {o.status !== 'PENDING' && <a className="small" href={`${api.base}/api/my/merch-orders/${o.id}/receipt`} target="_blank" rel="noreferrer">Receipt</a>}
                  {o.status === 'PENDING' && <HoldCountdown until={o.holdExpiresAt} onExpire={() => setTimeout(load, 10_000)} />}
                </div>
                <div className="stack" style={{ gap: 6, justifyItems: 'end' }}>
                  {o.status === 'PENDING' ? (
                    <button className="btn signal sm" disabled={payBusy === o.id} data-busy={payBusy === o.id ? 'true' : undefined} onClick={() => payOrder(o.id)}>
                      {payBusy === o.id ? 'Opening payment…' : 'Complete payment'}
                    </button>
                  ) : o.status === 'REFUNDED' ? <span className="pill">Refunded</span>
                    : o.pickedUpAt ? <span className="pill go">Picked up</span>
                    : <span className="pill go">Paid · pick up at merch</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {modifying && (
        <Modal title={`Modify · ${modifying.event.title}`} onClose={closeModify}
          footer={<button className="btn ghost" onClick={closeModify}>Close</button>}>
          <div className="stack">
            {settings?.askFursonaName !== false && (
              <form className="stack" onSubmit={saveBadgeName}>
                <Field label={settings?.fursonaNameLabel || 'Fursona name'} help="Change your badge name.">
                  <div className="row">
                    <input value={badgeName} onChange={(e) => setBadgeName(e.target.value)} />
                    <button className="btn sm">Save</button>
                  </div>
                </Field>
                {nameMsg && <p className={`note ${nameMsgOk ? 'good' : 'bad'}`} style={{ margin: 0 }}>{nameMsg}</p>}
              </form>
            )}

            <div>
              <p className="eyebrow" style={{ marginBottom: 6 }}>Going?</p>
              <RsvpButtons value={modifying.rsvp} onChange={(v) => rsvp(modifying.code, v)} />
            </div>

            {showTransferNudge && !transferOpen && (
              <div className="card stack" style={{ background: 'var(--paper)', boxShadow: 'none' }}>
                <p className="small muted" style={{ margin: 0 }}>Can't make it? Cancel or transfer your spot.</p>
                <div className="row">
                  {!modifying.cancelRequestedAt && <button className="btn sm danger" disabled={cancelBusy} onClick={() => cancelTicket(modifying.code)}>{cancelLabel(modifying)}</button>}
                  <button className="btn sm" onClick={() => setTransferOpen(true)}>Transfer to someone else</button>
                </div>
              </div>
            )}

            <div className="card stack" style={{ background: 'var(--paper)', boxShadow: 'none' }}>
              <div className="spread">
                <h3 style={{ margin: 0 }}>Transfer ticket</h3>
                {!transferOpen && <button className="btn sm" onClick={() => setTransferOpen(true)}>Transfer</button>}
              </div>

              {transferOpen && !transferConfirm && (
                <>
                  <p className="small muted" style={{ margin: 0 }}>
                    Give this spot to someone else. Telegram users must have messaged the bot once.
                  </p>
                  <div className="segmented">
                    <button type="button" className={transferMethod === 'telegram' ? 'selected' : ''} onClick={() => setTransferMethod('telegram')}>Telegram username</button>
                    <button type="button" className={transferMethod === 'email' ? 'selected' : ''} onClick={() => setTransferMethod('email')}>Email</button>
                  </div>
                  <input placeholder={transferMethod === 'telegram' ? '@username' : 'name@example.com'} value={transferValue}
                    onChange={(e) => setTransferValue(e.target.value)} />
                  {transferMsg && <p className="note bad" style={{ margin: 0 }}>{transferMsg}</p>}
                  <div className="row">
                    <button className="btn ghost sm" onClick={() => { setTransferOpen(false); setTransferMsg(''); }}>Cancel</button>
                    <button className="btn sm primary" disabled={!transferValue.trim()} onClick={() => setTransferConfirm(true)}>Continue</button>
                  </div>
                </>
              )}

              {transferConfirm && (
                <>
                  <p className="note bad" style={{ margin: 0 }}>
                    Transfer this ticket to {transferMethod === 'telegram' ? `@${transferValue.replace(/^@/, '')}` : transferValue}?
                    You'll lose it, and any printed badge stops working. This can't be undone.
                  </p>
                  {transferMsg && <p className="note bad" style={{ margin: 0 }}>{transferMsg}</p>}
                  <div className="row">
                    <button className="btn ghost sm" disabled={transferBusy} onClick={() => setTransferConfirm(false)}>Back</button>
                    <button className="btn sm danger" disabled={transferBusy} onClick={submitTransfer}>
                      {transferBusy ? 'Transferring…' : 'Yes, transfer it'}
                    </button>
                  </div>
                </>
              )}
            </div>

            {modifying.cancelRequestedAt ? (
              <p className="small muted" style={{ margin: 0 }}>Cancellation requested. Waiting on the organizers.</p>
            ) : (
              <button className="btn danger sm" style={{ justifySelf: 'start' }} disabled={cancelBusy} onClick={() => cancelTicket(modifying.code)}>
                {cancelLabel(modifying)}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
