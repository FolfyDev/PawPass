import { prisma } from './db.js';
import { env } from './env.js';

/// Instance options an owner can change on the settings page instead of in
/// .env. .env stays the default: a blank value here means "use .env". Saved
/// values are written straight into `env`, so code that reads env.* picks
/// them up at once, no restart.
///
/// Its own Setting row, not DEFAULT_SETTINGS: that one is served publicly,
/// and printer addresses and reply-to inboxes don't belong there. Secrets
/// (API keys, passwords, the bot token) stay in .env only.

const KEY = 'instanceConfig';

const text = (max) => (v) => String(v).trim().slice(0, max);
const int = (min, max, what) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
};
const email = (what) => (v) => {
  const s = String(v).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error(`${what} must be an email address.`);
  return s;
};

/// key → [read from env, write to env, validate]. Validators get non-blank
/// input and return the stored value, or throw a message for the owner.
const FIELDS = {
  defaultTimezone: [() => env.defaultTimezone, (v) => { env.defaultTimezone = v; }, (v) => {
    const zone = String(v).trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { throw new Error(`"${zone}" isn't a time zone. Use a name like America/New_York.`); }
    return zone;
  }],
  legalEntityName: [() => env.legal.entityName, (v) => { env.legal.entityName = v; }, text(200)],
  legalContactEmail: [() => env.legal.contactEmail, (v) => { env.legal.contactEmail = v; }, email('The legal contact')],
  emailFromName: [() => env.smtp.fromName, (v) => { env.smtp.fromName = v; }, (v) => text(100)(v).replace(/["<>\r\n]/g, '')],
  emailReplyTo: [() => env.smtp.replyTo, (v) => { env.smtp.replyTo = v; }, email('The reply-to address')],
  emailFooter: [() => env.smtp.footer, (v) => { env.smtp.footer = v; }, (v) => String(v).replace(/\r\n/g, '\n').trim().slice(0, 2000)],
  zebraHost: [() => env.zebra.host, (v) => { env.zebra.host = v; }, (v) => {
    const host = String(v).trim();
    if (!/^[\w.-]+$/.test(host)) throw new Error('The printer address must be a host name or IP address.');
    return host;
  }],
  zebraPort: [() => env.zebra.port, (v) => { env.zebra.port = v; }, int(1, 65535, 'The printer port')],
  zebraDpi: [() => env.zebra.dpi, (v) => { env.zebra.dpi = v; }, (v) => {
    const dpi = Number(v);
    if (![203, 300, 600].includes(dpi)) throw new Error('The printer resolution must be 203, 300 or 600 dpi.');
    return dpi;
  }],
  checkoutMinutes: [() => env.stripe.checkoutMinutes, (v) => { env.stripe.checkoutMinutes = v; }, int(30, 1440, 'The checkout hold')],
  loginCodeTtlMinutes: [() => env.loginCodeTtlMinutes, (v) => { env.loginCodeTtlMinutes = v; }, int(2, 60, 'Login code lifetime')],
};

/// What .env said at startup, before any saved value replaced it.
const FROM_ENV = Object.fromEntries(Object.entries(FIELDS).map(([k, [get]]) => [k, get()]));

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

async function stored() {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return row?.value && typeof row.value === 'object' ? row.value : {};
}

function apply(saved) {
  for (const [k, [, set, check]] of Object.entries(FIELDS)) {
    let v = FROM_ENV[k];
    if (!blank(saved[k])) {
      try { v = check(saved[k]); } catch { /* a bad stored value falls back to .env */ }
    }
    set(v);
  }
}

/// On startup, before anything reads these.
export async function loadInstanceConfig() {
  apply(await stored());
}

/// For the settings page: what's saved, and what .env would give otherwise.
export async function getInstanceConfig() {
  const saved = await stored();
  return {
    saved: Object.fromEntries(Object.keys(FIELDS).map((k) => [k, blank(saved[k]) ? '' : saved[k]])),
    fromEnv: FROM_ENV,
  };
}

/// Only known keys; blank clears back to .env. Throws a message for the owner.
export async function setInstanceConfig(patch) {
  const next = { ...(await stored()) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in FIELDS)) continue;
    if (blank(v)) delete next[k];
    else next[k] = FIELDS[k][2](v);
  }
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
  apply(next);
  return getInstanceConfig();
}
