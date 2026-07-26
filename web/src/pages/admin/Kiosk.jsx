import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Field, PaymentButtons } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';
import { printBadge } from '../../lib/print.js';

const BLANK_FORM = { legalName: '', fursonaName: '', email: '', answers: {}, tier: 'FREE', paymentMethod: '', paymentAmount: '', paymentNote: '', tosAccepted: false };

/// Onsite registration desk: staff type in a walk-in's info, optionally note
/// how a donation was paid, then the screen resets for the next person.
/// Unlike the public form or the bot, there is no Telegram linking here —
/// this is for brand-new walk-ins, not looking up people who preregistered.
export default function Kiosk() {
  const { id } = useParams();
  const { settings } = useSession();
  const [event, setEvent] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [printMsg, setPrintMsg] = useState('');

  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); }, [id]);

  if (!event) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  const fields = event.customFields || [];

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.legalName.trim().length < 2) return setError('Enter the attendee\'s full legal name.');
    for (const f of fields) if (f.required && !form.answers[f.key]) return setError(`${f.label} is required.`);
    if (!form.tosAccepted) return setError('Confirm the attendee has agreed to the terms.');
    if (form.tier === 'DONATION' && !form.paymentMethod) return setError('Select how the payment was received.');
    if (form.tier === 'DONATION' && !(Number(form.paymentAmount) > 0)) return setError('Enter the amount received.');

    setBusy(true);
    try {
      const reg = await api.post('/api/admin/registrations', {
        eventId: id,
        legalName: form.legalName,
        fursonaName: form.fursonaName,
        email: form.email || null,
        answers: form.answers,
        tier: form.tier,
        paymentMethod: form.tier === 'DONATION' ? form.paymentMethod : undefined,
        paymentAmount: form.tier === 'DONATION' ? Number(form.paymentAmount) : undefined,
        paymentNote: form.tier === 'DONATION' ? form.paymentNote : undefined,
      });
      setResult(reg);
      setPrintMsg('');
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  const print = async () => {
    setPrintMsg('');
    try { const r = await printBadge(result.code, settings?.printMode); setPrintMsg(`Sent to the printer (copy ${r.printCount}).`); }
    catch (e) { setPrintMsg(e.message); }
  };

  const next = () => { setResult(null); setForm(BLANK_FORM); setError(''); setPrintMsg(''); };

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Kiosk</h1>
        </div>
      </div>
      <EventTabs id={id} />

      <div className="card" style={{ maxWidth: 560 }}>
        {result ? (
          <div className="stack">
            <h2 style={{ margin: 0 }}>Registered</h2>
            <p style={{ margin: 0 }}><strong>{result.fursonaName || result.legalName}</strong> — {result.status === 'WAITLIST' ? 'waitlisted' : 'confirmed'}</p>
            <p className="row" style={{ margin: 0 }}>
              <span className="code">{result.code}</span>
              {result.badgeNumber != null && <span className="small muted">Badge #{result.badgeNumber}</span>}
            </p>
            {result.tier === 'DONATION' && (
              <p className="small muted" style={{ margin: 0 }}>
                Paid {result.paymentAmount != null ? `$${Number(result.paymentAmount).toFixed(2)} ` : ''}
                via {result.paymentMethod || 'unrecorded method'}{result.paymentNote ? ` — ${result.paymentNote}` : ''}
              </p>
            )}
            {printMsg && <p className="note">{printMsg}</p>}
            <div className="row">
              <button className="btn" onClick={print}>Print badge</button>
              <button className="btn signal" onClick={next}>Register next person →</button>
            </div>
          </div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <h2 style={{ margin: 0 }}>Register a walk-in</h2>

            <Field label={settings?.legalNameLabel || 'Full legal name'} help={settings?.legalNameHelp}>
              <input value={form.legalName} autoFocus
                onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
            </Field>

            {settings?.askFursonaName !== false && (
              <Field label={settings?.fursonaNameLabel || 'Fursona name'} help="The big name on your badge">
                <input value={form.fursonaName}
                  onChange={(e) => setForm({ ...form, fursonaName: e.target.value })} />
              </Field>
            )}

            <Field label="Email" help="Optional">
              <input type="email" value={form.email}
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
                    <span className="tier-help">Paid onsite</span>
                  </button>
                </div>
              </Field>
            )}

            {form.tier === 'DONATION' && (
              <>
                <Field label="Payment received via">
                  <PaymentButtons value={form.paymentMethod} onChange={(v) => setForm({ ...form, paymentMethod: v })} />
                </Field>
                <Field label="Amount received ($)">
                  <input type="number" step="0.01" min="0" value={form.paymentAmount}
                    onChange={(e) => setForm({ ...form, paymentAmount: e.target.value })} />
                </Field>
                <Field label="Payment note" help="Optional — change given, etc.">
                  <input value={form.paymentNote} onChange={(e) => setForm({ ...form, paymentNote: e.target.value })} />
                </Field>
              </>
            )}

            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={form.tosAccepted}
                onChange={(e) => setForm({ ...form, tosAccepted: e.target.checked })} />
              <span className="small">Attendee has agreed to {event.tosTitle.toLowerCase()}</span>
            </label>
            <details>
              <summary className="small muted">Show terms</summary>
              <p className="tos small">{event.tosBody || 'No terms published for this event.'}</p>
            </details>

            {error && <p className="note bad">{error}</p>}
            <button className="btn signal" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register'}</button>
          </form>
        )}
      </div>
    </>
  );
}
