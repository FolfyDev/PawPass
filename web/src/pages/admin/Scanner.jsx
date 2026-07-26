import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { printBadge } from '../../lib/print.js';
import { StatusPill } from '../../components/Bits.jsx';

const MODES = {
  checkin: { label: 'Check in', verb: 'Checked in' },
  print: { label: 'Print badge', verb: 'Sent to printer' },
  both: { label: 'Check in and print', verb: 'Checked in and printed' },
};

/// One camera, three jobs. The badge desk usually sits on "check in and print":
/// scan a phone, the ZD500 spits out the badge.
export default function Scanner() {
  const { settings } = useSession();
  const [mode, setMode] = useState('both');
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState('');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const [log, setLog] = useState([]);
  const readerRef = useRef(null);
  const busy = useRef(false);

  useEffect(() => { api.get('/api/admin/events').then(setEvents); }, []);
  useEffect(() => () => { readerRef.current?.stop().catch(() => {}); }, []);

  const handle = async (value) => {
    if (busy.current) return;
    busy.current = true;
    setError(''); setResult(null);
    try {
      let reg = null;
      if (mode !== 'print') {
        const r = await api.post('/api/admin/checkin', { value, eventId: eventId || undefined });
        reg = r.registration;
        setResult({ ...r, note: r.already ? 'Already checked in earlier.' : MODES[mode].verb });
      }
      if (mode !== 'checkin') {
        const p = await printBadge(value, settings?.printMode);
        setResult((prev) => ({ ...(prev || { registration: null }), printed: p, note: prev ? `${MODES[mode].verb}.` : 'Sent to printer.' }));
      }
      setLog((l) => [{ at: new Date(), text: reg ? `${reg.code} · ${reg.fursonaName || reg.legalName}` : value, ok: true }, ...l].slice(0, 12));
      if (navigator.vibrate) navigator.vibrate(40);
    } catch (e) {
      setError(e.message);
      setLog((l) => [{ at: new Date(), text: e.message, ok: false }, ...l].slice(0, 12));
    } finally {
      setTimeout(() => { busy.current = false; }, 1200);
    }
  };

  const start = async () => {
    setError('');
    const reader = new Html5Qrcode('reader');
    readerRef.current = reader;
    try {
      await reader.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, handle, () => {});
      setScanning(true);
    } catch (e) {
      setError(`Camera unavailable: ${e.message}. Type the badge code instead.`);
    }
  };

  const stop = async () => { await readerRef.current?.stop().catch(() => {}); setScanning(false); };

  return (
    <>
      <p className="eyebrow">Door operations</p>
      <h1>Check in &amp; print</h1>

      <div className="row" style={{ marginBottom: 16 }}>
        {Object.entries(MODES).map(([k, m]) => (
          <button key={k} className={`btn sm ${mode === k ? 'primary' : ''}`} onClick={() => setMode(k)}>{m.label}</button>
        ))}
        <select value={eventId} onChange={(e) => setEventId(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">Any event</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <div className="scanner"><div id="reader" style={{ width: '100%' }} />{scanning && <div className="reticle" />}</div>
          <div className="row">
            {scanning ? <button className="btn" onClick={stop}>Stop camera</button>
                      : <button className="btn signal" onClick={start}>Start camera</button>}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) { handle(manual.trim()); setManual(''); } }}>
            <input className="mono" placeholder="Type a badge code" value={manual} onChange={(e) => setManual(e.target.value)} style={{ maxWidth: 220 }} />
            <button className="btn">Look up</button>
          </form>
        </div>

        <div className="stack">
          {error && <p className="note bad">{error}</p>}
          {result?.registration && (
            <div className="stub">
              <div className="stub-accent" />
              <div className="stub-head">
                <p className="eyebrow">{result.note}</p>
                <h2 style={{ margin: '2px 0' }}>{result.registration.fursonaName || result.registration.legalName}</h2>
                <p className="muted small" style={{ margin: 0 }}>{result.registration.legalName}</p>
                <p className="code" style={{ marginTop: 12 }}>{result.registration.code}</p>
                <StatusPill status={result.registration.status} checkedInAt={result.registration.checkedInAt} />
              </div>
              <div className="stub-tear" />
              <div className="stub-foot row">
                <button className="btn sm" onClick={() => printBadge(result.registration.code, settings?.printMode).catch((e) => setError(e.message))}>Reprint badge</button>
                <button className="btn sm ghost" onClick={() => api.post(`/api/admin/checkin/${result.registration.code}/undo`).then(() => setResult(null))}>Undo check-in</button>
              </div>
            </div>
          )}

          <div className="card">
            <p className="eyebrow" style={{ marginBottom: 8 }}>Recent scans</p>
            {log.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing scanned yet.</p>}
            {log.map((l, i) => (
              <div key={i} className="spread small" style={{ padding: '5px 0', borderBottom: '1px solid var(--rule)' }}>
                <span style={{ color: l.ok ? 'var(--go)' : 'var(--stop)' }}>{l.text}</span>
                <span className="muted mono">{l.at.toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
