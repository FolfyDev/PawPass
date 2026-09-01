import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Field, Empty } from '../../components/Bits.jsx';

const BLANK = { legalName: '', email: '', telegramId: '', telegramUsername: '', reason: '' };

export default function Bans() {
  const [bans, setBans] = useState(null);
  const [attempts, setAttempts] = useState(null);
  const [draft, setDraft] = useState(BLANK);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(true);

  const load = () => api.get('/api/admin/bans').then(setBans);
  const loadAttempts = () => api.get('/api/admin/bans/attempts').then(setAttempts);
  useEffect(() => { load(); loadAttempts(); }, []);

  const create = async () => {
    setMsg('');
    try {
      await api.post('/api/admin/bans', draft);
      setDraft(BLANK);
      setMsg('Ban added.'); setMsgOk(true);
      load();
    } catch (e) { setMsg(e.message); setMsgOk(false); }
  };

  const remove = async (ban) => {
    if (!confirm(`Remove this ban${ban.legalName ? ` on "${ban.legalName}"` : ''}?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/bans/${ban.id}`); load(); }
    catch (e) { setMsg(e.message); setMsgOk(false); }
  };

  if (!bans || !attempts) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  return (
    <>
      <p className="eyebrow">Instance</p>
      <h1>Bans</h1>
      <p className="muted">
        Block someone from registering for any event, site-wide. A registration attempt is checked against a ban's
        legal name, email, and Telegram ID/username. A match on any one field is enough to block it.
      </p>

      {msg && <p className={`note ${msgOk ? 'good' : 'bad'}`} style={{ marginBottom: 16 }}>{msg}</p>}

      <div className="card stack" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Add a ban</h2>
        <p className="small muted" style={{ margin: 0 }}>Fill in whichever identifiers you know. At least one is required.</p>
        <div className="grid-2">
          <Field label="Legal name"><input value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} /></Field>
          <Field label="Email"><input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
          <Field label="Telegram ID"><input value={draft.telegramId} onChange={(e) => setDraft({ ...draft, telegramId: e.target.value })} /></Field>
          <Field label="Telegram username" help="With or without the @"><input value={draft.telegramUsername} onChange={(e) => setDraft({ ...draft, telegramUsername: e.target.value })} /></Field>
        </div>
        <Field label="Reason" help="Visible only to staff, on this page">
          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
        </Field>
        <button className="btn primary" style={{ justifySelf: 'start' }} onClick={create}>Add ban</button>
      </div>

      <h2>Active bans</h2>
      {bans.length === 0 && <Empty title="No one is banned">Bans you add will show up here.</Empty>}
      {bans.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto', marginBottom: 32 }}>
          <table>
            <thead><tr><th>Legal name</th><th>Email</th><th>Telegram</th><th>Reason</th><th>Added</th><th /></tr></thead>
            <tbody>
              {bans.map((b) => (
                <tr key={b.id}>
                  <td>{b.legalName || '-'}</td>
                  <td className="small muted">{b.email || '-'}</td>
                  <td className="small muted">
                    {b.telegramId || b.telegramUsername
                      ? <>{b.telegramUsername ? `@${b.telegramUsername}` : ''}{b.telegramId ? <><br />id {b.telegramId}</> : ''}</>
                      : '-'}
                  </td>
                  <td className="small muted">{b.reason || '-'}</td>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(b.createdAt).toLocaleDateString()}{b.createdBy ? ` - ${b.createdBy.displayName}` : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm danger" onClick={() => remove(b)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Attempted registrations</h2>
      <p className="small muted" style={{ marginTop: -8 }}>Every time a banned identity tries to register, it's logged here, even after the ban is removed.</p>
      {attempts.length === 0 && <Empty title="No blocked attempts yet">If a banned person tries to register, it'll show up here.</Empty>}
      {attempts.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Name</th><th>Contact</th><th>Event</th><th>Via</th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(a.createdAt).toLocaleString()}</td>
                  <td>{a.meta?.fursonaName || a.meta?.legalName || '-'}</td>
                  <td className="small muted">
                    {a.meta?.email || ''}
                    {a.meta?.telegramUsername ? <><br />@{a.meta.telegramUsername}</> : ''}
                  </td>
                  <td className="small muted">{a.meta?.eventTitle || '-'}</td>
                  <td className="small muted">{a.meta?.source || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
