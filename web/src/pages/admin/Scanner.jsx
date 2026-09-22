import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { printBadge } from '../../lib/print.js';
import { playCheckinSuccess, playCheckinError } from '../../lib/sound.js';
import { runPreflight } from '../../lib/checkin.js';
import { StatusPill, Pill, fmtDate } from '../../components/Bits.jsx';
import StatusMark from '../../components/StatusMark.jsx';

const MODES = {
  checkin: { label: 'Check in', verb: 'Checked in' },
  print: { label: 'Print badge', verb: 'Sent to printer' },
  both: { label: 'Check in and print', verb: 'Checked in and printed' },
};

const CHECK_MARK = { pass: 'ok', warn: 'warn', fail: 'bad' };

/// Loads the event, runs the pre-flight checks, and either shows the gate
/// (when something failed and nobody has overridden it yet) or the scanner.
/// The scanner itself lives in its own component so its hooks never run
/// conditionally. The override lives only in this component's state, on
/// purpose — no storage, so leaving the page (a nav click, a refresh, the
/// back button) always lands back on the gate rather than silently letting
/// a later shift inherit an earlier one's override.
export default function Scanner() {
  const { eventId } = useParams();
  const [event, setEvent] = useState(undefined);
  const [overridden, setOverridden] = useState(false);

  useEffect(() => {
    setEvent(undefined);
    setOverridden(false);
    api.get('/api/admin/events')
      .then((list) => setEvent(list.find((e) => e.id === eventId) || null))
      .catch(() => setEvent(null));
  }, [eventId]);

  if (event === undefined) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;
  if (event === null) {
    return (
      <>
        <p className="note bad">That event could not be found.</p>
        <Link className="btn" to="/admin/scan">Choose an event</Link>
      </>
    );
  }

  const checks = runPreflight(event);
  const hasFail = checks.some((c) => c.level === 'fail');

  if (hasFail && !overridden) {
    return (
      <PreflightGate
        event={event}
        checks={checks}
        onStart={() => setOverridden(true)}
      />
    );
  }

  return <ScannerView key={eventId} event={event} warnings={checks.filter((c) => c.level === 'warn')} overridden={hasFail} />;
}

function PreflightGate({ event, checks, onStart }) {
  const [ack, setAck] = useState(false);
  return (
    <>
      <p className="eyebrow">Door operations</p>
      <h1>Before you start</h1>
      <p className="muted">{event.title} · {fmtDate(event.startsAt, event.timezone)}</p>

      <div className="card" style={{ maxWidth: 560 }}>
        {checks.map((c) => (
          <div key={c.id} className="check-row">
            <StatusMark small kind={CHECK_MARK[c.level]} />
            <span>
              <strong>{c.label}</strong>
              <span className="small muted" style={{ display: 'block' }}>{c.detail}</span>
            </span>
          </div>
        ))}
        <label className="row" style={{ marginTop: 6, paddingTop: 16, borderTop: '1px solid var(--rule)', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 4 }} />
          <span>Override the failed checks and check in for this event anyway</span>
        </label>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <Link className="btn" to="/admin/scan">Choose a different event</Link>
        <button className="btn signal" disabled={!ack} onClick={onStart}>Start check-in</button>
      </div>
    </>
  );
}

function ReadyPanel({ mode, eventTitle }) {
  return (
    <div className="ready-panel">
      <StatusMark kind="ready" />
      <h2>{mode === 'print' ? 'Print Ready' : 'Check-In Ready'}</h2>
      <p>Scan a badge QR code, or type a badge code, for {eventTitle}.</p>
    </div>
  );
}

function ScannerView({ event, warnings, overridden }) {
  const { settings } = useSession();
  const eventId = event.id;
  const [mode, setMode] = useState('both');
  const [scanning, setScanning] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [problem, setProblem] = useState('');
  const [manual, setManual] = useState('');
  const [log, setLog] = useState([]);
  const readerRef = useRef(null);
  const busy = useRef(false);
  const handleRef = useRef(null);

  useEffect(() => () => { readerRef.current?.stop().catch(() => {}); }, []);

  const addLog = (text, ok) => setLog((l) => [{ at: new Date(), text, ok }, ...l].slice(0, 12));

  const handle = async (value) => {
    if (busy.current) return;
    busy.current = true;
    setProblem('');
    setOutcome(null);
    try {
      let reg = null;

      if (mode !== 'print') {
        let r;
        try {
          r = await api.post('/api/admin/checkin', { value, eventId });
        } catch (e) {
          const rejected = e.data?.registration || null;
          setOutcome({ kind: 'rejected', ok: false, headline: 'Check-In Failed', detail: e.message, registration: rejected, scanned: value });
          playCheckinError();
          addLog(rejected ? `${rejected.code} · ${e.message}` : e.message, false);
          return;
        }
        reg = r.registration;

        if (r.already) {
          const at = new Date(reg.checkedInAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          setOutcome({ kind: 'already', ok: false, headline: 'Check-In Failed', detail: `Already checked in at ${at}.`, registration: reg, scanned: value, canReprint: true });
          playCheckinError();
          addLog(`${reg.code} · already checked in`, false);
          return;
        }
        playCheckinSuccess();
      }

      let printed = null;
      let printError = '';
      if (mode !== 'checkin') {
        try { printed = await printBadge(value, settings?.printMode); }
        catch (e) { printError = e.message; }
      }

      if (mode === 'print' && printError) {
        setOutcome({ kind: 'print-failed', ok: false, headline: 'Unable to print badge', detail: printError, registration: null, scanned: value });
        playCheckinError();
        addLog(printError, false);
        return;
      }

      setOutcome({
        kind: 'ok',
        ok: true,
        headline: mode === 'print' ? 'Badge sent to printer' : printError ? 'Checked in' : MODES[mode].verb,
        detail: mode === 'print' && printed?.code ? `${printed.code}, copy ${printed.printCount}` : '',
        registration: reg,
        scanned: value,
        printError,
        notice: reg && reg.tier === 'DONATION' && !reg.paymentMethod ? 'No donation payment has been recorded for this person yet.' : '',
        canReprint: !!reg,
        canUndo: mode !== 'print' && !!reg,
      });
      addLog(reg ? `${reg.code} · ${reg.fursonaName || reg.legalName}` : value, true);
      if (navigator.vibrate) navigator.vibrate(40);
    } finally {
      setTimeout(() => { busy.current = false; }, 1200);
    }
  };
  // The camera callback is registered once, so it has to read the latest
  // handler (and therefore the latest mode) through a ref.
  handleRef.current = handle;

  const start = async () => {
    setProblem('');
    const reader = new Html5Qrcode('reader');
    readerRef.current = reader;
    try {
      await reader.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, (v) => handleRef.current(v), () => {});
      setScanning(true);
    } catch (e) {
      setProblem(`Camera unavailable: ${e.message}. Type the badge code instead.`);
    }
  };

  const stop = async () => { await readerRef.current?.stop().catch(() => {}); setScanning(false); };

  const reg = outcome?.registration;

  return (
    <>
      <p className="eyebrow">Door operations</p>
      <h1>Check in &amp; print</h1>

      <div className="spread" style={{ marginBottom: 16 }}>
        <p style={{ margin: 0 }}>
          <strong>{event.title}</strong>{' '}
          <span className="muted small">· {fmtDate(event.startsAt, event.timezone)}</span>{' '}
          {overridden && <Pill tone="wait">Override active</Pill>}
        </p>
        <Link className="btn sm" to="/admin/scan">Change event</Link>
      </div>

      {warnings.map((w) => <p key={w.id} className="note" style={{ marginBottom: 12 }}>{w.detail}</p>)}

      <div className="row" style={{ marginBottom: 16 }}>
        {Object.entries(MODES).map(([k, m]) => (
          <button key={k} className={`btn sm ${mode === k ? 'primary' : ''}`} onClick={() => setMode(k)}>{m.label}</button>
        ))}
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
          {problem && <p className="note bad">{problem}</p>}

          {outcome ? (
            <div className="stub">
              <div className="stub-accent" style={{ background: outcome.ok ? '#0f7a52' : '#c02626' }} />
              <div className="stub-head">
                <div className="outcome-head">
                  <StatusMark kind={outcome.ok ? 'ok' : 'bad'} />
                  <div>
                    <h2>{outcome.headline}</h2>
                    {outcome.detail && <p className="muted small" style={{ margin: '3px 0 0' }}>{outcome.detail}</p>}
                  </div>
                </div>

                {reg ? (
                  <div style={{ marginTop: 18 }}>
                    <h3 style={{ margin: 0 }}>{reg.fursonaName || reg.legalName}</h3>
                    <p className="muted small" style={{ margin: '2px 0 0' }}>{reg.legalName}</p>
                    <p className="code" style={{ marginTop: 10 }}>{reg.code}</p>
                    <StatusPill status={reg.status} checkedInAt={reg.checkedInAt} />
                  </div>
                ) : (
                  <p className="mono small muted" style={{ marginTop: 14, wordBreak: 'break-all' }}>{outcome.scanned}</p>
                )}

                {outcome.notice && <p className="note" style={{ marginTop: 14 }}>{outcome.notice}</p>}
                {outcome.printError && <p className="note bad" style={{ marginTop: 14 }}>The badge did not print: {outcome.printError}</p>}
              </div>

              {(outcome.canReprint || outcome.canUndo) && (
                <>
                  <div className="stub-tear" />
                  <div className="stub-foot row">
                    {outcome.canReprint && (
                      <button className="btn sm" onClick={() => printBadge(reg.code, settings?.printMode).catch((e) => setProblem(e.message))}>Reprint badge</button>
                    )}
                    {outcome.canUndo && (
                      <button className="btn sm ghost" onClick={() => api.post(`/api/admin/checkin/${reg.code}/undo`).then(() => setOutcome(null)).catch((e) => setProblem(e.message))}>Undo check-in</button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <ReadyPanel mode={mode} eventTitle={event.title} />
          )}

          <div className="card">
            <p className="eyebrow" style={{ marginBottom: 8 }}>Recent scans</p>
            {log.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing scanned yet.</p>}
            {log.map((l, i) => (
              <div key={i} className="spread small" style={{ padding: '5px 0', borderBottom: '1px solid var(--rule)', flexWrap: 'nowrap', alignItems: 'baseline' }}>
                <span style={{ color: l.ok ? 'var(--go)' : 'var(--stop)', minWidth: 0 }}>{l.text}</span>
                <span className="muted mono" style={{ whiteSpace: 'nowrap' }}>{l.at.toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
