import { api } from './api.js';

/// Offline check-in: a copy of the event's tickets (QR secrets hashed, see
/// /checkin-manifest), checked against the same rules as the server, with
/// scans queued here until the connection comes back.
///
/// The queue is the one thing that must never be lost — those people are
/// already through the door — so it's written to localStorage on every
/// change, and only removed once the server has confirmed each scan.
/// Everything is wrapped so a blocked or full storage just degrades to
/// memory instead of breaking the scanner.

const KEY = (eventId) => `pawpass.checkin.${eventId}`;
const ALL_PREFIX = 'pawpass.checkin.';

function read(eventId) {
  try { return JSON.parse(localStorage.getItem(KEY(eventId)) || 'null'); } catch { return null; }
}
function write(eventId, state) {
  try { localStorage.setItem(KEY(eventId), JSON.stringify(state)); } catch { /* memory only */ }
}

/// Removes every event's offline copy from this browser — on sign-out, so a
/// shared door laptop doesn't keep attendee names around.
export function wipeOfflineCheckin() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k?.startsWith(ALL_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* nothing stored */ }
}

export const dayIn = (date, timeZone) => {
  try { return new Date(date).toLocaleDateString('en-CA', { timeZone }); } catch { return new Date(date).toISOString().slice(0, 10); }
};

const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/// Same rules as scanProblem() in server/src/lib/checkins.js. Keep in step.
export function scanProblem({ status, validDays = [], tierName }, direction, day, scansToday, force = false, timeZone = undefined) {
  if (status === 'CANCELLED') return { code: 'cancelled', message: 'This ticket was cancelled.' };
  if (status === 'WAITLIST') return { code: 'waitlist', message: 'This registration is on the waitlist and has no confirmed spot.' };
  if (status === 'PENDING_PAYMENT') return { code: 'unpaid', message: 'This ticket\'s online payment never completed.' };
  const last = scansToday[scansToday.length - 1];
  const inside = last?.direction === 'ENTRY';
  if (direction === 'EXIT') {
    return inside ? null : { code: 'not_inside', message: 'This ticket isn\'t checked in right now, so it can\'t be scanned out.' };
  }
  if (force) return null;
  if (validDays.length && !validDays.includes(day)) {
    return { code: 'wrong_day', message: `${tierName || 'This ticket'} is only valid on ${validDays.map(dayLabel).join(', ')}.` };
  }
  if (inside) {
    const at = new Date(last.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
    return { code: 'already_inside', message: `Already checked in today at ${at}, with no exit since.` };
  }
  return null;
}

async function sha256(text) {
  // crypto.subtle only exists on https/localhost — the same places the
  // camera works. Without it, typed badge codes still match.
  if (!globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export class OfflineCheckin {
  constructor(eventId) {
    this.eventId = eventId;
    const saved = read(eventId);
    this.manifest = saved?.manifest || null;
    this.queue = saved?.queue || [];
    this.listeners = new Set();
  }

  save() {
    write(this.eventId, { manifest: this.manifest, queue: this.queue });
    for (const fn of this.listeners) fn(this);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get ready() { return !!this.manifest; }

  async refresh() {
    const manifest = await api.get(`/api/admin/events/${this.eventId}/checkin-manifest`);
    // Scans still queued here aren't in the server's copy yet; keep them.
    for (const q of this.queue) {
      const t = manifest.tickets.find((x) => x.code === q.code);
      if (t) t.scans.push({ day: q.day, direction: q.direction, at: q.at });
    }
    this.manifest = manifest;
    this.save();
  }

  async find(value) {
    if (!this.manifest) return null;
    const primary = String(value || '').trim().split('|')[0].trim();
    const code = primary.toUpperCase();
    const byCode = this.manifest.tickets.find((t) => t.code === code);
    if (byCode) return byCode;
    const hash = await sha256(primary.split('/').pop());
    return hash ? this.manifest.tickets.find((t) => t.secretHash === hash) || null : null;
  }

  today() { return dayIn(new Date(), this.manifest?.timezone); }

  /// Checks one scan against the local copy and, if allowed, queues it.
  /// Returns { ok, ticket, problem }.
  async scan(value, direction = 'ENTRY', force = false) {
    const ticket = await this.find(value);
    if (!ticket) return { ok: false, ticket: null, problem: { code: 'not_found', message: 'No ticket matches that code in the offline copy.' } };
    const day = this.today();
    const scansToday = ticket.scans.filter((s) => s.day === day);
    let problem = scanProblem(ticket, direction, day, scansToday, force, this.manifest.timezone);
    const { inside, limit } = this.counts();
    if (!problem && direction === 'ENTRY' && !force && limit && inside >= limit) {
      problem = { code: 'at_capacity', message: `At the occupancy limit of ${limit}. Wait for someone to leave, or let them in anyway.` };
    }
    if (problem) return { ok: false, ticket, problem };
    const at = new Date().toISOString();
    const firstVisit = direction === 'ENTRY' && !ticket.checkedInAt;
    ticket.scans.push({ day, direction, at });
    if (firstVisit) ticket.checkedInAt = at;
    this.queue.push({ clientId: newId(), code: ticket.code, direction, at, day, force });
    this.save();
    return { ok: true, ticket, problem: null, firstVisit };
  }

  /// Notes a scan the server already recorded, so the local copy knows
  /// who's inside if the connection drops later.
  remember(code, scan) {
    const t = this.manifest?.tickets.find((x) => x.code === code);
    if (!t || !scan) return;
    t.scans.push({ day: scan.day, direction: scan.direction, at: scan.at });
    if (scan.direction === 'ENTRY' && !t.checkedInAt) t.checkedInAt = scan.at;
    this.save();
  }

  /// Takes back the newest local scan for a ticket (after an online undo).
  forgetLast(code) {
    const t = this.manifest?.tickets.find((x) => x.code === code);
    if (!t?.scans.length) return;
    t.scans.pop();
    if (!t.scans.some((s) => s.direction === 'ENTRY')) t.checkedInAt = null;
    this.save();
  }

  /// Counts from the local copy, for the header while offline.
  counts() {
    const day = this.today();
    let inside = 0;
    let entered = 0;
    for (const t of this.manifest?.tickets || []) {
      const s = t.scans.filter((x) => x.day === day);
      if (s.some((x) => x.direction === 'ENTRY')) entered += 1;
      if (s[s.length - 1]?.direction === 'ENTRY') inside += 1;
    }
    return { day, inside, entered, limit: this.manifest?.occupancyLimit ?? null };
  }

  /// Sends queued scans. Network failures leave the queue alone; scans the
  /// server confirmed (or already had) come off it. Returns the server's
  /// follow-up flags and any scans it couldn't record.
  async sync() {
    // One sync at a time: the reconnect event and the retry timer often
    // fire together.
    if (this.syncing) return this.syncing;
    this.syncing = this.syncOnce().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async syncOnce() {
    if (!this.queue.length) return { synced: 0, flagged: [], failed: [] };
    const batch = this.queue.slice(0, 500);
    const res = await api.post(`/api/admin/events/${this.eventId}/checkin/sync`, {
      scans: batch.map(({ clientId, code, direction, at, force }) => ({ clientId, code, direction, at, force })),
    });
    const done = new Set();
    let synced = 0;
    const flagged = [];
    const failed = [];
    for (const r of res.results) {
      if (r.ok) {
        // "Duplicate" means the server already had it — a browser or proxy
        // replayed the request after a network change. From here it's
        // delivered either way.
        done.add(r.clientId);
        synced += 1;
        if (r.flagged && !r.duplicate) flagged.push(r.flagged);
      }
      else {
        // The server will never accept these (bad record, unknown code), so
        // retrying forever helps nobody. Drop and report them.
        done.add(r.clientId);
        const q = batch.find((x) => x.clientId === r.clientId);
        failed.push(`${q?.code || '?'}: ${r.error}`);
      }
    }
    this.queue = this.queue.filter((q) => !done.has(q.clientId));
    this.save();
    return { synced, flagged, failed, today: res.today };
  }
}

/// Network failure (offline, DNS, server down) as opposed to the server
/// answering with an error. Only the former falls back to offline mode.
export const isNetworkError = (e) => e && e.status === undefined;
