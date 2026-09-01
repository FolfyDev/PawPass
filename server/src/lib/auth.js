import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from './env.js';
import { prisma } from './db.js';

export const COOKIE = 'pawpass_session';

export function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, { expiresIn: '30d' });
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.publicUrl.startsWith('https'),
    maxAge: 30 * 24 * 3600 * 1000,
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
      const payload = jwt.verify(token, env.jwtSecret);
      req.user = await prisma.user.findUnique({ where: { id: payload.sub } });
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

/// The dev bypass is gated on the deployment obviously being local: the flag
/// must be on, the public URL must be plain HTTP, and it must point at a
/// loopback address. Flipping DEV_AUTH on a real host does nothing.
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
