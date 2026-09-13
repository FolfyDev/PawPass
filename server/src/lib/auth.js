import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from './env.js';
import { prisma } from './db.js';
import { blindIndex } from './crypto.js';

export const COOKIE = 'pawpass_session';
const SESSION_MS = 24 * 3600 * 1000;

export function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, ver: user.tokenVersion }, env.jwtSecret, { expiresIn: '1d', algorithm: 'HS256' });
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.publicUrl.startsWith('https'),
    maxAge: SESSION_MS,
  });
}

export class LoginCodeError extends Error {}

export async function redeemLoginCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) throw new LoginCodeError('Enter the code the bot sent you.');

  const row = await prisma.loginCode.findUnique({ where: { code } });
  const ageMinutes = row ? (Date.now() - row.createdAt.getTime()) / 60000 : Infinity;
  if (!row || row.usedAt || ageMinutes > env.loginCodeTtlMinutes)
    throw new LoginCodeError('That code is not valid any more. Send /login to the bot for a fresh one.');

  await prisma.loginCode.update({ where: { code }, data: { usedAt: new Date() } });

  const user = await prisma.user.findUnique({ where: { telegramId: row.telegramId } });
  if (!user) throw new LoginCodeError('That Telegram account is not known here. Send /start to the bot first.');
  return user;
}

export async function redeemEmailCode(rawEmail, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const emailIndex = blindIndex(rawEmail);
  if (!code || !emailIndex) throw new LoginCodeError('Enter the code we emailed you.');

  const row = await prisma.emailLoginCode.findUnique({ where: { code } });
  const ageMinutes = row ? (Date.now() - row.createdAt.getTime()) / 60000 : Infinity;
  if (!row || row.usedAt || row.emailIndex !== emailIndex || ageMinutes > env.loginCodeTtlMinutes)
    throw new LoginCodeError('That code is not valid any more. Request a fresh one.');

  await prisma.emailLoginCode.update({ where: { code }, data: { usedAt: new Date() } });

  const user = await prisma.user.findUnique({ where: { emailIndex } });
  if (!user) throw new LoginCodeError('That email is not known here.');
  return user;
}

export class TelegramLinkError extends Error {}

/// Attaches `telegramId` to `targetUser`. The tricky part: literally any
/// Telegram interaction — even just running /login to fetch a linking code —
/// auto-creates a bare shell User row for that id (see load() in
/// bot/index.js), so "a User already has this telegramId" is not by itself a
/// real conflict. A shell with zero registrations is just bot plumbing and
/// gets quietly repointed onto targetUser; a shell (or account) that actually
/// has registrations is a genuine second identity and gets rejected, with
/// the admin "combine registrations" tool as the intended way to resolve it.
///
/// `telegramUsernameHint` is only used when there's no existing User row for
/// this telegramId to source a username from (e.g. the Login Widget flow,
/// which hands over a username directly and may be the very first contact
/// this telegramId has ever had with the app).
export async function linkTelegramIdentity(targetUser, telegramId, telegramUsernameHint) {
  const taken = await prisma.user.findUnique({ where: { telegramId } });
  if (!taken || taken.id === targetUser.id) {
    return prisma.user.update({
      where: { id: targetUser.id },
      data: { telegramId, telegramUsername: taken?.telegramUsername ?? telegramUsernameHint ?? null },
    });
  }

  const regCount = await prisma.registration.count({ where: { userId: taken.id } });
  if (regCount > 0)
    throw new TelegramLinkError('That Telegram username or email is already in use by another account.');

  // Empty shell — safe to repoint. telegramId is @unique, so the old holder
  // has to be cleared before the new one can take it; Postgres checks unique
  // constraints immediately, not at transaction end, so this has to be two
  // separate statements in the transaction, in this order, not one combined
  // update.
  const username = taken.telegramUsername;
  const [, user] = await prisma.$transaction([
    prisma.user.update({ where: { id: taken.id }, data: { telegramId: null, telegramUsername: null } }),
    prisma.user.update({ where: { id: targetUser.id }, data: { telegramId, telegramUsername: username } }),
  ]);
  return user;
}

/// Verifies the hash Telegram signs Login Widget payloads with.
export function verifyTelegramLogin(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(env.telegram.token).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (hmac !== hash) return false;
  // Reject replays older than a day.
  return Date.now() / 1000 - Number(rest.auth_date) < 86400;
}

export async function loadUser(req, _res, next) {
  const token = req.cookies?.[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (token) {
    try {
      const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      // A token issued before the user's last logout/password-change carries
      // a stale `ver` — treat it the same as no session at all.
      req.user = user && user.tokenVersion === payload.ver ? user : null;
    } catch {
      req.user = null;
    }
  }
  next();
}

export const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Sign in to continue.' });

export const requireAdmin = (req, res, next) =>
  req.user && (req.user.role === 'ADMIN' || req.user.role === 'OWNER')
    ? next()
    : res.status(403).json({ error: 'Staff access only.' });

export const requireOwner = (req, res, next) =>
  req.user?.role === 'OWNER' ? next() : res.status(403).json({ error: 'Owner access only.' });


export function localDevAuthAvailable() {
  if (!env.devAuth) return false;
  try {
    const u = new URL(env.publicUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname);
    return u.protocol === 'http:' && loopback;
  } catch {
    return false;
  }
}

export async function audit(actorId, action, target, meta = {}) {
  await prisma.auditLog.create({ data: { actorId, action, target, meta } });
}
