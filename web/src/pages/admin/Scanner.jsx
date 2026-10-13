import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { printBadge } from '../../lib/print.js';
import { playCheckinSuccess, playCheckinError } from '../../lib/sound.js';
import { runPreflight } from '../../lib/checkin.js';
import { OfflineCheckin, isNetworkError } from '../../lib/offlineCheckin.js';
import { registerOfflineShell } from '../../lib/offlineShell.js';
import { StatusPill, Pill, fmtDate, fmtMoney } from '../../components/Bits.jsx';
import StatusMark from '../../components/StatusMark.jsx';
import { PageSkeleton } from '../../components/Skeleton.jsx';

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
    // The event is kept with the offline copy (and wiped with it on sign-out),
    // so a scanner reloaded without a connection can still open.
    const cacheKey = `pawpass.checkin.event.${eventId}`;
    api.get('/api/admin/events')
      .then((list) => {
        const found = list.find((e) => e.id === eventId) || null;
        try { if (found) localStorage.setItem(cacheKey, JSON.stringify(found)); } catch { /* memory only */ }
        setEvent(found);
      })
      .catch((e) => {
        let cached = null;
        try { cached = isNetworkError(e) ? JSON.parse(localStorage.getItem(cacheKey) || 'null') : null; } catch { /* none */ }
        setEvent(cached);
      });
  }, [eventId]);

  if (event === undefined) return <PageSkeleton />;
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

function ReadyPanel({ mode, direction, eventTitle }) {
  return (
    <div className="ready-panel">
      <StatusMark kind="ready" />
      <h2>{direction === 'EXIT' ? 'Exit Ready' : mode === 'print' ? 'Print Ready' : 'Check-In Ready'}</h2>
      <p>Scan a badge QR code, or type a badge code, for {eventTitle}.</p>
    </div>
  );
}

const SYNC_MS = 15_000;
const REFRESH_MS = 5 * 60_000;
// Rules staff may wave someone past ("Let in anyway"). Cancelled, unpaid,
// and waitlisted tickets are never overridable.
const OVERRIDABLE = ['wrong_day', 'already_inside', 'at_capacity'];
const timeOf = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/// Today's numbers plus the connection/offline-copy status, above the scanner.
function DoorStatus({ today, online, store, syncing, onRefresh, onSync }) {
  const limit = today?.limit;
  const nearLimit = limit && today.inside >= limit * 0.9;
  return (
    <div className="card door-status">
      <div className="door-stats">
        <div><span className="eyebrow">Today</span><strong>{today ? new Date(`${today.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '…'}</strong></div>
        <div><span className="eyebrow">Arrived</span><strong>{today?.entered ?? '…'}</strong></div>
        <div>
          <span className="eyebrow">Inside now</span>
          <strong style={nearLimit ? { color: today.inside >= limit ? 'var(--stop)' : 'var(--signal)' } : undefined}>
            {today?.inside ?? '…'}{limit ? <span className="muted small"> / {limit}</span> : null}
          </strong>
        </div>
      </div>
      {nearLimit && (
        <p className={`note ${today.inside >= limit ? 'bad' : ''}`} style={{ margin: 0 }}>
          {today.inside >= limit ? `At the occupancy limit of ${limit}. New entries are refused until someone leaves (or you let them in anyway).` : `Close to the occupancy limit (${today.inside} of ${limit}).`}
        </p>
      )}
      <div className="spread small" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 8 }}>
          {online ? <Pill tone="go">Online</Pill> : <Pill tone="wait">Offline</Pill>}
          {store.ready
            ? <span className="muted">Offline copy: {store.manifest.tickets.length} tickets, updated {timeOf(store.manifest.generatedAt)}</span>
            : <span className="muted">No offline copy yet</span>}
          {store.queue.length > 0 && <strong style={{ color: 'var(--signal)' }}>{store.queue.length} scan{store.queue.length === 1 ? '' : 's'} waiting to sync</strong>}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {store.queue.length > 0 && <button className="btn sm" disabled={!online || syncing} onClick={onSync}>{syncing ? 'Syncing…' : 'Sync now'}</button>}
          <button className="btn sm ghost" disabled={!online} onClick={onRefresh}>Refresh offline copy</button>
        </span>
      </div>
    </div>
  );
}

function ScannerView({ event, warnings, overridden }) {
  const { settings } = useSession();
  const eventId = event.id;
  const store = useMemo(() => new OfflineCheckin(eventId), [eventId]);
  const [, rerender] = useState(0);
  const [mode, setMode] = useState('both');
  const [direction, setDirection] = useState('ENTRY');
  const [scanning, setScanning] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [problem, setProblem] = useState('');
  const [manual, setManual] = useState('');
  const [log, setLog] = useState([]);
  const [today, setToday] = useState(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [syncing, setSyncing] = useState(false);
  const [syncNotes, setSyncNotes] = useState([]);
  const readerRef = useRef(null);
  const busy = useRef(false);
  const handleRef = useRef(null);

  useEffect(() => () => { readerRef.current?.stop().catch(() => {}); }, []);
  useEffect(() => store.onChange(() => rerender((n) => n + 1)), [store]);

  const addLog = (text, ok) => setLog((l) => [{ at: new Date(), text, ok }, ...l].slice(0, 12));

  const goOffline = () => { setOnline(false); if (store.ready) setToday(store.counts()); };

  const refreshCopy = () => store.refresh().then(() => setOnline(true)).catch((e) => { if (isNetworkError(e)) goOffline(); });

  // Reconnecting fires the browser's online event and often the retry timer
  // together; only the first caller syncs and reports.
  const syncingRef = useRef(false);
  const sync = async () => {
    if (!store.queue.length || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const r = await store.sync();
      setOnline(true);
      if (r.today) setToday(r.today);
      if (r.flagged.length || r.failed.length) setSyncNotes((n) => [...r.flagged, ...r.failed, ...n].slice(0, 20));
      if (r.synced) addLog(`Synced ${r.synced} offline scan${r.synced === 1 ? '' : 's'}`, true);
    } catch (e) {
      if (isNetworkError(e)) goOffline();
      else setProblem(e.status === 401 ? 'Your session ended, so offline scans can\'t sync. Sign in again; they\'re kept on this device until then.' : `Sync failed: ${e.message}`);
    } finally { syncingRef.current = false; setSyncing(false); }
  };

  // Download the offline copy and today's numbers up front, then keep
  // syncing queued scans and refreshing the copy in the background.
  useEffect(() => {
    registerOfflineShell();
    refreshCopy();
    api.get(`/api/admin/events/${eventId}/attendance`).then((a) => setToday(a.today)).catch((e) => { if (isNetworkError(e)) goOffline(); });
    const tick = setInterval(() => { if (store.queue.length) sync(); }, SYNC_MS);
    const refresh = setInterval(() => { if (!store.queue.length) refreshCopy(); }, REFRESH_MS);
    const back = () => { setOnline(true); sync(); };
    window.addEventListener('online', back);
    window.addEventListener('offline', goOffline);
    return () => { clearInterval(tick); clearInterval(refresh); window.removeEventListener('online', back); window.removeEventListener('offline', goOffline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const reject = (value, message, reg, code, offline = false) => {
    setOutcome({
      kind: 'rejected', ok: false, headline: direction === 'EXIT' ? 'Exit Failed' : 'Check-In Failed', detail: message,
      registration: reg, scanned: value, canOverride: direction === 'ENTRY' && OVERRIDABLE.includes(code), offline,
      canReprint: !offline && !!reg && code === 'already_inside',
    });
    playCheckinError();
    addLog(reg ? `${reg.code} · ${message}` : message, false);
  };

  /// The offline path: same rules, checked against the local copy.
  const handleOffline = async (value, force) => {
    if (!store.ready) {
      setProblem('No connection, and this scanner has no offline copy of the tickets yet. Reconnect, or type codes into a scanner that has one.');
      playCheckinError();
      return;
    }
    const r = await store.scan(value, direction, force);
    setToday(store.counts());
    const reg = r.ticket && { code: r.ticket.code, fursonaName: r.ticket.name, legalName: r.ticket.legalName, status: r.ticket.status, checkedInAt: r.ticket.checkedInAt, tierName: r.ticket.tierName };
    if (!r.ok) return reject(value, r.problem.message, reg, r.problem.code, true);
    playCheckinSuccess();
    setOutcome({
      kind: 'ok', ok: true, offline: true, registration: reg, scanned: value,
      headline: direction === 'EXIT' ? 'Checked out' : r.firstVisit ? 'Checked in' : 'Welcome back',
      detail: 'Saved on this device. It syncs when the connection is back.',
      notice: mode !== 'checkin' && direction === 'ENTRY' && r.firstVisit ? 'Badges can\'t print while offline. Reprint this one once you\'re back online.' : '',
    });
    addLog(`${reg.code} · ${reg.fursonaName || reg.legalName} (offline)`, true);
  };

  // `deliberate` is a typed code or a button press. The busy pause only
  // exists to stop the camera reading one badge twice, so it never
  // swallows something staff did on purpose.
  const handle = async (value, { force = false, deliberate = false } = {}) => {
    if (busy.current && !deliberate) return;
    busy.current = true;
    setProblem('');
    setOutcome(null);
    try {
      if (mode === 'print' && direction === 'ENTRY') {
        try {
          const printed = await printBadge(value, settings?.printMode);
          setOutcome({ kind: 'ok', ok: true, headline: 'Badge sent to printer', detail: printed?.code ? `${printed.code}, copy ${printed.printCount}` : '', registration: null, scanned: value });
          addLog(printed?.code || value, true);
        } catch (e) {
          setOutcome({ kind: 'print-failed', ok: false, headline: 'Unable to print badge', detail: e.message, registration: null, scanned: value });
          playCheckinError();
          addLog(e.message, false);
        }
        return;
      }

      let r;
      try {
        r = await api.post('/api/admin/checkin', { value, eventId, direction, force });
        setOnline(true);
      } catch (e) {
        if (isNetworkError(e)) { goOffline(); return await handleOffline(value, force); }
        if (e.data?.today) setToday(e.data.today);
        return reject(value, e.message, e.data?.registration || null, e.data?.code);
      }

      const reg = r.registration;
      setToday(r.today);
      store.remember(reg.code, r.scan);
      playCheckinSuccess();

      // Badges print on the first arrival only, not every morning of a
      // multi-day event.
      let printError = '';
      const shouldPrint = mode === 'both' && direction === 'ENTRY' && r.firstVisit;
      if (shouldPrint) {
        try { await printBadge(value, settings?.printMode); } catch (e) { printError = e.message; }
      }

      setOutcome({
        kind: 'ok', ok: true, registration: reg, scanned: value, printError,
        headline: direction === 'EXIT' ? 'Checked out' : !r.firstVisit ? 'Welcome back' : shouldPrint && !printError ? MODES.both.verb : 'Checked in',
        detail: r.scan.overridden ? 'Let in by override.' : direction === 'ENTRY' && !r.firstVisit && mode === 'both' ? 'Already has a badge, so nothing printed.' : '',
        notice: reg.balanceDueCents > 0 ? `${reg.tierName || 'Ticket'}: ${fmtMoney(reg.balanceDueCents, reg.currency)} still to collect.` : '',
        canReprint: true, canUndo: true,
      });
      addLog(`${reg.code} · ${reg.fursonaName || reg.legalName}${direction === 'EXIT' ? ' (out)' : ''}`, true);
      if (navigator.vibrate) navigator.vibrate(40);
    } finally {
      setTimeout(() => { busy.current = false; }, 1200);
    }
  };
  // The camera callback is registered once, so it has to read the latest
  // handler (and therefore the latest mode) through a ref.
  handleRef.current = handle;

  const undo = async (reg) => {
    try {
      await api.post(`/api/admin/checkin/${reg.code}/undo`);
      store.forgetLast(reg.code);
      setOutcome(null);
      api.get(`/api/admin/events/${eventId}/attendance`).then((a) => setToday(a.today)).catch(() => {});
    } catch (e) { setProblem(isNetworkError(e) ? 'Undo needs a connection.' : e.message); }
  };

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
        <div className="row">
          <Link className="btn sm" to={`/admin/scan/${eventId}/display`} target="_blank" rel="noreferrer">Open display ↗</Link>
          <Link className="btn sm" to="/admin/scan">Change event</Link>
        </div>
      </div>

      {warnings.map((w) => <p key={w.id} className="note" style={{ marginBottom: 12 }}>{w.detail}</p>)}

      <DoorStatus today={today} online={online} store={store} syncing={syncing} onRefresh={refreshCopy} onSync={sync} />

      {syncNotes.length > 0 && (
        <div className="note" style={{ margin: '12px 0' }}>
          <strong>Follow up on these offline scans</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{syncNotes.map((n, i) => <li key={i} className="small">{n}</li>)}</ul>
          <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setSyncNotes([])}>Dismiss</button>
        </div>
      )}

      <div className="row" style={{ margin: '16px 0', gap: 16 }}>
        <div className="segmented" role="group" aria-label="Scan direction">
          <button type="button" className={direction === 'ENTRY' ? 'selected' : ''} onClick={() => setDirection('ENTRY')}>Entry</button>
          <button type="button" className={direction === 'EXIT' ? 'selected' : ''} onClick={() => setDirection('EXIT')}>Exit</button>
        </div>
        {direction === 'ENTRY' && (
          <div className="row">
            {Object.entries(MODES).map(([k, m]) => (
              <button key={k} className={`btn sm ${mode === k ? 'primary' : ''}`} onClick={() => setMode(k)}>{m.label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <div className="scanner"><div id="reader" style={{ width: '100%' }} />{scanning && <div className="reticle" />}</div>
          <div className="row">
            {scanning ? <button className="btn" onClick={stop}>Stop camera</button>
                      : <button className="btn signal" onClick={start}>Start camera</button>}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) { handle(manual.trim(), { deliberate: true }); setManual(''); } }}>
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
                    <p className="muted small" style={{ margin: '2px 0 0' }}>{reg.legalName}{reg.tierName ? ` · ${reg.tierName}` : ''}</p>
                    <p className="code" style={{ marginTop: 10 }}>{reg.code}</p>
                    <StatusPill status={reg.status} checkedInAt={reg.checkedInAt} />
                  </div>
                ) : (
                  <p className="mono small muted" style={{ marginTop: 14, wordBreak: 'break-all' }}>{outcome.scanned}</p>
                )}

                {outcome.notice && <p className="note" style={{ marginTop: 14 }}>{outcome.notice}</p>}
                {outcome.printError && <p className="note bad" style={{ marginTop: 14 }}>The badge did not print: {outcome.printError}</p>}
              </div>

              {(outcome.canReprint || outcome.canUndo || outcome.canOverride) && (
                <>
                  <div className="stub-tear" />
                  <div className="stub-foot row">
                    {outcome.canOverride && (
                      <button className="btn sm signal" onClick={() => handle(outcome.scanned, { force: true, deliberate: true })}>Let in anyway</button>
                    )}
                    {outcome.canReprint && online && (
                      <button className="btn sm" onClick={() => printBadge(reg.code, settings?.printMode).catch((e) => setProblem(e.message))}>Reprint badge</button>
                    )}
                    {outcome.canUndo && online && (
                      <button className="btn sm ghost" onClick={() => undo(reg)}>Undo {direction === 'EXIT' ? 'exit' : 'check-in'}</button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <ReadyPanel mode={mode} direction={direction} eventTitle={event.title} />
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
