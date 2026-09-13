import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { verifyTelegramLogin, issueToken, setSessionCookie, COOKIE, requireUser, requireAdmin, localDevAuthAvailable, redeemLoginCode, redeemEmailCode, LoginCodeError, linkTelegramIdentity, TelegramLinkError } from '../lib/auth.js';
import { loginCode as makeLoginCode } from '../lib/codes.js';
import { blindIndex } from '../lib/crypto.js';
import { sendOtpEmail } from '../lib/mailer.js';

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
      // The Login Widget needs an https domain registered with BotFather.
      // Over plain http, or on localhost, the code flow is the way in.
      widgetUsable: env.telegram.enabled && env.publicUrl.startsWith('https'),
    },
    emailCodeEnabled: env.smtp.enabled,
    devAuth: localDevAuthAvailable(),
  });
});

/// Telegram Login Widget callback. Attendees use this exclusively; staff may
/// use it too because their accounts are linked by Telegram ID.
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

/// Email + password sign-in, for any account that has one set — staff and
/// regular members alike. Members get a password by registering for an event
/// as a guest (see public.js) or by adding one from the Account page; either
/// way, an account with no passwordHash simply can't use this door.
authRouter.post('/password', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { emailIndex: blindIndex(email) } });
  if (!user?.passwordHash || user.role === 'USER' || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });

  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', async (req, res) => {
  // Bumping tokenVersion invalidates this account's token everywhere, not
  // just this browser — clearing the cookie alone wouldn't stop a copy of
  // the token being reused elsewhere until it naturally expired.
  if (req.user) await prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } });
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

/// Lets an admin who signed in with a password attach their Telegram account,
/// and vice versa, so the two doors lead to one identity.
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

/// Same idea, but for someone who'd rather not load Telegram's widget
/// script — they message the bot for a one-time code (the same one /login
/// uses to sign in) and paste it here instead.
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
    // Re-issue so this browser's own session survives the bump above — only
    // a token from *before* this change (e.g. on another device) is meant
    // to stop working.
    setSessionCookie(res, issueToken(user));
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'That email is already in use by another account.' });
    throw e;
  }
});

/// Any signed-in user can update the email their account uses for guest
/// registration lookups and sign-in codes — this is the end-user equivalent
/// of /set-password, minus the password.
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

/// Local development only. Creates or reuses a throwaway account so the whole
/// app can be exercised with no bot, no domain, and no certificates.
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
});
