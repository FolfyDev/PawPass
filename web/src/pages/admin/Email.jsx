import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Field, Pill } from '../../components/Bits.jsx';

const AUDIENCES = [
  ['all', 'Everyone registered'],
  ['not_checked_in', 'Confirmed, not yet checked in'],
  ['checked_in', 'Checked in'],
  ['waitlist', 'Waitlist only'],
];

export default function Email() {
  const [events, setEvents] = useState([]);
  const [sent, setSent] = useState([]);
  const [draft, setDraft] = useState({ eventId: '', subject: '', body: '', audience: 'all' });
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);

  const load = () => api.get('/api/admin/campaigns').then(setSent);
  useEffect(() => { api.get('/api/admin/events').then(setEvents); load(); }, []);

  const send = async (dryRun) => {
    setMsg('');
    try {
      const c = await api.post('/api/admin/campaigns', draft);
      const r = await api.post(`/api/admin/campaigns/${c.id}/send`, { dryRun });
      setMsg(dryRun ? `${r.recipients} people would receive this.` : `Sent to ${r.sent} of ${r.recipients}.`);
      setMsgOk(true);
      if (!dryRun) { setDraft({ ...draft, subject: '', body: '' }); load(); }
    } catch (e) { setMsg(e.message); setMsgOk(false); }
  };

  return (
    <>
      <p className="eyebrow">Announcements</p>
      <h1>Email</h1>

      <div className="card stack" style={{ marginBottom: 24 }}>
        <div className="grid-2">
          <Field label="Event">
            <select value={draft.eventId} onChange={(e) => setDraft({ ...draft, eventId: e.target.value })}>
              <option value="">Every event</option>
              {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
          </Field>
          <Field label="Audience">
            <select value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })}>
              {AUDIENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Subject"><input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Field>
        <Field label="Message" help="Tokens: {{fursona_name}} {{legal_name}} {{code}} {{event_title}} {{ticket_url}}">
          <textarea style={{ minHeight: 200 }} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </Field>
        {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`}>{msg}</p>}
        <div className="row">
          <button className="btn" onClick={() => send(true)}>Count recipients</button>
          <button className="btn signal" disabled={!draft.subject || !draft.body} onClick={() => send(false)}>Send now</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Only people who gave an email address receive these. Telegram-only attendees will not.</p>
      </div>

      <h2>Sent</h2>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table>
          <thead><tr><th>Subject</th><th>Audience</th><th>Sent</th><th>Recipients</th></tr></thead>
          <tbody>
            {sent.map((c) => (
              <tr key={c.id}>
                <td>{c.subject}</td>
                <td className="small muted">{c.audience}</td>
                <td className="small">{c.sentAt ? new Date(c.sentAt).toLocaleString() : <Pill>Draft</Pill>}</td>
                <td>{c.sentCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
