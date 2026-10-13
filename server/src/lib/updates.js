import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from './db.js';
import { env } from './env.js';
import { APP_VERSION } from './version.js';

/// "Is there a newer PawPass?" for the owner's settings page. Reads the
/// public GitHub releases of env.updates.repo; nothing about this instance
/// is sent. Upgrading stays a manual step on the host (docs/UPGRADES.md):
/// the server container has no Docker or host access, on purpose.
///
/// Channels: 'main' follows normal releases only, 'dev' also takes
/// pre-releases (built from the Dev branch). The owner's choice lives in its
/// own Setting row, not DEFAULT_SETTINGS, which is served publicly.

const KEY = 'updateChannel';
export const CHANNELS = ['main', 'dev'];
const CHECK_EVERY = 6 * 3600_000;
const MIN_REFRESH = 60_000;
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

const VERSION = /^v?(\d+(?:\.\d+)*)$/;
/// Numeric parts of a tag like 2026.1.0.0 (or v2026.1.0.0); null if it isn't one.
const parts = (tag) => VERSION.exec(String(tag).trim())?.[1].split('.').map(Number) || null;
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export async function getChannel() {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return CHANNELS.includes(row?.value?.channel) ? row.value.channel : 'main';
}

export async function setChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new Error('Choose main or dev.');
  const value = { channel };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return channel;
}

const github = async (url) => {
  const res = await fetch(`https://api.github.com/repos/${env.updates.repo}${url}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PawPass update check' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate limiting update checks. Try again in a while.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json();
};

/// Last good list of releases, newest version first, shared by every request.
let releases = { list: null, checkedAt: 0, error: null };

async function loadReleases(force) {
  const age = Date.now() - releases.checkedAt;
  if (releases.list && age < (force ? MIN_REFRESH : CHECK_EVERY)) return releases;
  try {
    const raw = await github('/releases?per_page=50');
    if (!raw) throw new Error(`No repository called ${env.updates.repo} on GitHub.`);
    const list = raw
      .filter((r) => !r.draft && parts(r.tag_name))
      .map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        prerelease: Boolean(r.prerelease),
        publishedAt: r.published_at,
        // Release notes are shown as plain text, never as HTML.
        notes: String(r.body || '').slice(0, 4000),
        url: `https://github.com/${env.updates.repo}/releases/tag/${encodeURIComponent(r.tag_name)}`,
      }))
      .sort((a, b) => compareVersions(b.tag, a.tag));
    releases = { list, checkedAt: Date.now(), error: null };
  } catch (e) {
    // Keep showing the last good answer if there is one.
    releases = { ...releases, checkedAt: Date.now(), error: e.name === 'TimeoutError' ? 'GitHub took too long to answer.' : e.message };
  }
  return releases;
}

/// Migration folders in a release, from its tag. None (404) is a release
/// that set its schema up with `prisma db push`. Tags don't move, so once
/// per tag per process.
const releaseMigrations = new Map();
async function migrationsIn(tag) {
  if (!releaseMigrations.has(tag)) {
    const p = github(`/contents/server/prisma/migrations?ref=${encodeURIComponent(tag)}`)
      .then((items) => (items || []).filter((i) => i.type === 'dir').map((i) => i.name));
    releaseMigrations.set(tag, p);
    p.catch(() => releaseMigrations.delete(tag));
  }
  return releaseMigrations.get(tag);
}

const localMigrations = async () =>
  (await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

/// What the settings page shows.
///   status: 'behind'  — `target` is newer than this build
///           'current' — this build is the newest release on the channel
///           'ahead'   — this build is newer than anything released on the channel
///           'unknown' — checking is off, failed, or there are no releases
/// For 'ahead', `unreleasedMigrations` are schema changes in this build that
/// aren't in `target`, so going back to that release isn't possible.
export async function updateStatus({ force = false } = {}) {
  const channel = await getChannel();
  const base = { current: APP_VERSION, channel, repo: env.updates.repo, enabled: env.updates.enabled };
  if (!env.updates.enabled) return { ...base, status: 'unknown', error: null, checkedAt: null };

  const { list, checkedAt, error } = await loadReleases(force);
  const pool = (list || []).filter((r) => channel === 'dev' || !r.prerelease);
  const target = pool[0] || null;
  const latestStable = (list || []).find((r) => !r.prerelease) || null;
  const out = { ...base, error, checkedAt: checkedAt ? new Date(checkedAt) : null, target, latestStable };
  if (!target) return { ...out, status: 'unknown' };

  const cmp = compareVersions(APP_VERSION, target.tag);
  if (cmp < 0) {
    // Everything between here and the target, so skipped releases' notes show too.
    const between = pool.filter((r) => compareVersions(r.tag, APP_VERSION) > 0);
    return { ...out, status: 'behind', between };
  }
  if (cmp === 0) return { ...out, status: 'current' };

  let unreleasedMigrations = null;
  try {
    const released = new Set(await migrationsIn(target.tag));
    unreleasedMigrations = (await localMigrations()).filter((m) => !released.has(m));
  } catch { /* shown as "couldn't compare" */ }
  return { ...out, status: 'ahead', unreleasedMigrations };
}
