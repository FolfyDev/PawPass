import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import { Empty, StatusPill, RsvpButtons, fmtDate, Field } from '../components/Bits.jsx';
import Modal from '../components/Modal.jsx';

export default function Tickets() {
  const { settings, refresh } = useSession();
  usePageMeta({ title: 'My tickets', noindex: true });
  const [tickets, setTickets] = useState(null);
  const load = () => api.get('/api/my/tickets').then(setTickets);
  useEffect(() => { load(); }, []);

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
    if (!confirm('Cancel this registration? This cannot be undone.')) return;
    setCancelBusy(true);
    try {
      await api.post(`/api/my/tickets/${code}/cancel`);
      closeModify();
      load();
    } catch (e) { alert(e.message); }
    finally { setCancelBusy(false); }
  };

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

      {tickets.length === 0 && <Empty title="No tickets yet">Pick an event from the home page to register.</Empty>}

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill,minmax(min(320px,100%),1fr))' }}>
        {tickets.map((t) => (
          <div key={t.code} className="stub">
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
                <button className="btn sm" onClick={() => openModify(t)}>Modify ticket</button>
              )}
              <div className="row">
                {settings?.wallet?.apple && (
                  <a className="btn sm" href={`${api.base}/api/my/tickets/${t.code}/apple.pkpass`}>Add to Apple Wallet</a>
                )}
                {settings?.wallet?.google && (
                  <button className="btn sm" onClick={() => google(t.code)}>Add to Google Wallet</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

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
                <p className="small muted" style={{ margin: 0 }}>Since you can't make it, cancel your spot, or hand it to someone else?</p>
                <div className="row">
                  <button className="btn sm danger" disabled={cancelBusy} onClick={() => cancelTicket(modifying.code)}>Cancel registration</button>
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
                    Give this spot to someone else. They'll need to sign in with the Telegram account or email you provid.
                    For Telegram, they need to have messaged the bot at least once already.
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
                    You will lose access to it, and any badge already printed for it will stop working at check-in. This cannot be undone.
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

            <button className="btn danger sm" style={{ justifySelf: 'start' }} disabled={cancelBusy} onClick={() => cancelTicket(modifying.code)}>
              Cancel this registration
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
