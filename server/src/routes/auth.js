import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { verifyTelegramLogin, issueToken, setSessionCookie, COOKIE, requireUser, requireAdmin, localDevAuthAvailable, redeemLoginCode, redeemEmailCode, LoginCodeError, linkTelegramIdentity, TelegramLinkError, audit } from '../lib/auth.js';
import { loginCode as makeLoginCode } from '../lib/codes.js';
import { blindIndex } from '../lib/crypto.js';
import { sendOtpEmail } from '../lib/mailer.js';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { newSecret, verifyCode, otpauthUrl, newRecoveryCodes, hashRecoveryCode } from '../lib/totp.js';
import { getSettings } from '../lib/settings.js';
import { effectivePermissions } from '../lib/permissions.js';

export const authRouter = Router();

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a while and try again.' },
});

authRouter.get('/config', (_req, res) => {
  res.json({
    telegram: {
      enabled: env.telegram.enabled,
      botUsername: env.telegram.username,

      widgetUsable: env.telegram.enabled && env.publicUrl.startsWith('https'),
    },
    emailCodeEnabled: env.smtp.enabled,
    devAuth: localDevAuthAvailable(),
  });
});


authRouter.post('/telegram', async (req, res) => {
  if (!env.telegram.enabled) return res.status(400).json({ error: 'Telegram sign-in is not configured.' });
  if (!verifyTelegramLogin(req.body)) return res.status(401).json({ error: 'That sign-in could not be verified. Try again.' });

  const { id, username, first_name, last_name, photo_url } = req.body;
  const displayName = [first_name, last_name].filter(Boolean).join(' ') || username || `tg${id}`;

  const user = await prisma.user.upsert({
    where: { telegramId: String(id) },
    create: { telegramId: String(id), telegramUsername: username, telegramPhotoUrl: photo_url, displayName },
    update: { telegramUsername: username, telegramPhotoUrl: photo_url, displayName },
  });

  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
});


/// With two-factor on, a correct password only earns a 5-minute challenge
/// token; /password/2fa trades it plus a code for the session. The token
/// carries tokenVersion, so a logout-everywhere or password change in
/// between voids it.
const CHALLENGE = 'pawpass:2fa';

authRouter.post('/password', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { emailIndex: blindIndex(email) } });
  if (!user?.passwordHash || user.role === 'USER' || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });

  if (user.totpEnabledAt) {
    const challenge = jwt.sign({ sub: user.id, ver: user.tokenVersion, aud: CHALLENGE }, env.jwtSecret, { expiresIn: '5m', algorithm: 'HS256' });
    return res.json({ twoFactor: true, challenge });
  }
  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
});

/// Second step: a 6-digit code from the app, or one of the recovery codes
/// (each works once).
authRouter.post('/password/2fa', loginLimiter, async (req, res) => {
  let payload;
  try { payload = jwt.verify(String(req.body?.challenge || ''), env.jwtSecret, { algorithms: ['HS256'], audience: CHALLENGE }); }
  catch { return res.status(401).json({ error: 'That sign-in took too long. Enter your password again.' }); }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.tokenVersion !== payload.ver || !user.totpEnabledAt || !user.totpSecret)
    return res.status(401).json({ error: 'That sign-in took too long. Enter your password again.' });

  const code = String(req.body?.code || '').trim();
  const step = verifyCode(user.totpSecret, code, { lastStep: user.totpLastStep });
  if (step != null) {
    // Claimed with a compare-and-swap, so the same code sent twice at once
    // still only signs in once.
    const { count } = await prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    if (!count) return res.status(401).json({ error: 'That code was already used. Wait for the next one.' });
  } else {
    const hash = hashRecoveryCode(code);
    if (!code || !user.totpRecoveryHashes.includes(hash)) return res.status(401).json({ error: 'That code isn\'t right. Check your authenticator app and try again.' });
    await prisma.user.update({ where: { id: user.id }, data: { totpRecoveryHashes: user.totpRecoveryHashes.filter((h) => h !== hash) } });
    await audit(user.id, 'auth.2fa.recovery_used', user.id, { left: user.totpRecoveryHashes.length - 1 });
  }
  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
});

/// Starts setup: a fresh secret, held as pending until /2fa/enable sees a
/// code from it. Signed-in staff with a password only.
authRouter.post('/2fa/setup', requireAdmin, async (req, res) => {
  if (!req.user.passwordHash) return res.status(400).json({ error: 'Set a password first. Two-factor protects password sign-in.' });
  const secret = newSecret();
  await prisma.user.update({ where: { id: req.user.id }, data: { totpPendingSecret: secret } });
  const settings = await getSettings();
  const url = otpauthUrl(secret, req.user.email || req.user.displayName, settings.orgName || 'PawPass');
  res.json({ secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
});

authRouter.post('/2fa/enable', requireAdmin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.totpPendingSecret) return res.status(400).json({ error: 'Start setup again.' });
  const step = verifyCode(user.totpPendingSecret, req.body?.code);
  if (step == null) return res.status(400).json({ error: 'That code doesn\'t match. Check the app shows PawPass and try the newest code.' });
  const codes = newRecoveryCodes();
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step,
      totpRecoveryHashes: codes.map(hashRecoveryCode),
    },
  });
  await audit(user.id, 'auth.2fa.enable', user.id, {});
  // The only time the recovery codes are ever shown.
  res.json({ user: publicUser(updated), recoveryCodes: codes });
});

/// Turning it off, or replacing the recovery codes, needs a current code
/// (or a recovery code), not just the session.
async function checkCurrentCode(user, code) {
  if (verifyCode(user.totpSecret, code) != null) return true;
  const hash = hashRecoveryCode(code);
  return Boolean(code) && user.totpRecoveryHashes.includes(hash);
}

authRouter.post('/2fa/disable', requireAdmin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.totpEnabledAt) return res.status(400).json({ error: 'Two-factor is already off.' });
  if (!(await checkCurrentCode(user, String(req.body?.code || '').trim()))) return res.status(400).json({ error: 'That code isn\'t right.' });
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [] },
  });
  await audit(user.id, 'auth.2fa.disable', user.id, {});
  res.json({ user: publicUser(updated) });
});

authRouter.post('/2fa/recovery-codes', requireAdmin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.totpEnabledAt) return res.status(400).json({ error: 'Turn on two-factor first.' });
  if (!(await checkCurrentCode(user, String(req.body?.code || '').trim()))) return res.status(400).json({ error: 'That code isn\'t right.' });
  const codes = newRecoveryCodes();
  await prisma.user.update({ where: { id: user.id }, data: { totpRecoveryHashes: codes.map(hashRecoveryCode) } });
  await audit(user.id, 'auth.2fa.recovery_regenerated', user.id, {});
  res.json({ recoveryCodes: codes });
});

authRouter.post('/logout', async (req, res) => {

  if (req.user) await prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } });
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});


authRouter.post('/link-telegram', requireUser, async (req, res) => {
  if (!verifyTelegramLogin(req.body)) return res.status(401).json({ error: 'That link could not be verified.' });
  try {
    const user = await linkTelegramIdentity(req.user, String(req.body.id), req.body.username);
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e instanceof TelegramLinkError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

authRouter.post('/link-telegram-code', requireUser, loginLimiter, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter the code the bot sent you.' });

  const row = await prisma.loginCode.findUnique({ where: { code } });
  const ageMinutes = row ? (Date.now() - row.createdAt.getTime()) / 60000 : Infinity;
  if (!row || row.usedAt || ageMinutes > env.loginCodeTtlMinutes)
    return res.status(401).json({ error: 'That code is not valid any more. Send /login to the bot for a fresh one.' });
  await prisma.loginCode.update({ where: { code }, data: { usedAt: new Date() } });

  try {
    const user = await linkTelegramIdentity(req.user, row.telegramId);
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e instanceof TelegramLinkError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

/// Staff only — end users sign in with an email code or Telegram, never a
/// password (see /password above and /email-code below).
authRouter.post('/set-password', requireAdmin, async (req, res) => {
  const { email, password } = req.body || {};
  if (!password || String(password).length < 10)
    return res.status(400).json({ error: 'Use at least 10 characters.' });
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        email: email ? String(email).toLowerCase() : req.user.email,
        passwordHash: await bcrypt.hash(String(password), 12),
        tokenVersion: { increment: 1 },
      },
    });

    setSessionCookie(res, issueToken(user));
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'That email is already in use by another account.' });
    throw e;
  }
});


authRouter.post('/email', requireUser, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { email } });
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'That email is already in use by another account.' });
    throw e;
  }
});


authRouter.post('/fursona-name', requireUser, async (req, res) => {
  const fursonaName = String(req.body?.fursonaName || '').trim();
  if (!fursonaName) return res.status(400).json({ error: 'Enter a badge name.' });
  const [user] = await prisma.$transaction([
    prisma.user.update({ where: { id: req.user.id }, data: { fursonaName } }),
    prisma.registration.updateMany({ where: { userId: req.user.id }, data: { fursonaName } }),
  ]);
  res.json({ user: publicUser(user) });
});

authRouter.post('/email-code/request', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const emailIndex = blindIndex(email);
  const user = await prisma.user.findUnique({ where: { emailIndex } });
  if (user) {
    const code = makeLoginCode();
    await prisma.emailLoginCode.create({ data: { code, emailIndex } });
    await prisma.emailLoginCode.updateMany({
      where: { emailIndex, usedAt: null, code: { not: code } },
      data: { usedAt: new Date() },
    });
    await sendOtpEmail(email, code).catch((e) => console.error('otp email failed', email, e.message));
  }
  res.json({ ok: true });
});

authRouter.post('/email-code/verify', loginLimiter, async (req, res) => {
  try {
    const user = await redeemEmailCode(req.body?.email, req.body?.code);
    setSessionCookie(res, issueToken(user));
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e instanceof LoginCodeError) return res.status(401).json({ error: e.message });
    throw e;
  }
});

authRouter.post('/telegram-code', loginLimiter, async (req, res) => {
  try {
    const user = await redeemLoginCode(req.body.code);
    setSessionCookie(res, issueToken(user));
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e instanceof LoginCodeError) return res.status(401).json({ error: e.message });
    throw e;
  }
});


authRouter.post('/dev', async (req, res) => {
  if (!localDevAuthAvailable())
    return res.status(404).json({ error: 'Not available.' });

  const name = String(req.body.name || 'Dev User').slice(0, 60);
  const role = ['USER', 'ADMIN', 'OWNER'].includes(req.body.role) ? req.body.role : 'USER';
  const telegramId = `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  const user = await prisma.user.upsert({
    where: { telegramId },
    create: { telegramId, displayName: name, telegramUsername: telegramId, role },
    update: { role },
  });

  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
});

export const publicUser = (u) => ({
  id: u.id,
  displayName: u.displayName,
  telegramUsername: u.telegramUsername,
  telegramId: u.telegramId,
  email: u.email,
  role: u.role,
  legalName: u.legalName,
  fursonaName: u.fursonaName,
  hasPassword: Boolean(u.passwordHash),
  // Only meaningful with the user's groups loaded (WITH_GROUPS), as /me does.
  permissions: u.staffGroups || u.role !== 'ADMIN' ? [...effectivePermissions(u)] : undefined,
  hasTwoFactor: Boolean(u.totpEnabledAt),
  recoveryCodesLeft: u.totpEnabledAt ? u.totpRecoveryHashes.length : null,
});
