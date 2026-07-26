import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { verifyTelegramLogin, issueToken, setSessionCookie, COOKIE, requireUser, localDevAuthAvailable } from '../lib/auth.js';
import { loginCode as makeLoginCode } from '../lib/codes.js';

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({
    telegram: {
      enabled: env.telegram.enabled,
      botUsername: env.telegram.username,
      // The Login Widget needs an https domain registered with BotFather.
      // Over plain http, or on localhost, the code flow is the way in.
      widgetUsable: env.telegram.enabled && env.publicUrl.startsWith('https'),
    },
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
authRouter.post('/password', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { email: String(email || '').toLowerCase() } });
  if (!user?.passwordHash || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });

  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
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
  const taken = await prisma.user.findUnique({ where: { telegramId: String(req.body.id) } });
  if (taken && taken.id !== req.user.id)
    return res.status(409).json({ error: 'That Telegram account is already linked to another user.' });
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { telegramId: String(req.body.id), telegramUsername: req.body.username },
  });
  res.json({ user: publicUser(user) });
});

authRouter.post('/set-password', requireUser, async (req, res) => {
  const { email, password } = req.body || {};
  if (!password || String(password).length < 10)
    return res.status(400).json({ error: 'Use at least 10 characters.' });
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        email: email ? String(email).toLowerCase() : req.user.email,
        passwordHash: await bcrypt.hash(String(password), 12),
      },
    });
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'That email is already in use by another account.' });
    throw e;
  }
});

/// Sign in with a code the bot handed out. Works over plain HTTP and needs no
/// registered domain, so this is the local-testing path — and a reasonable
/// production path for anyone who dislikes the widget's third-party script.
authRouter.post('/telegram-code', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter the code the bot sent you.' });

  const row = await prisma.loginCode.findUnique({ where: { code } });
  const ageMinutes = row ? (Date.now() - row.createdAt.getTime()) / 60000 : Infinity;
  if (!row || row.usedAt || ageMinutes > env.loginCodeTtlMinutes)
    return res.status(401).json({ error: 'That code is not valid any more. Send /login to the bot for a fresh one.' });

  await prisma.loginCode.update({ where: { code }, data: { usedAt: new Date() } });

  const user = await prisma.user.findUnique({ where: { telegramId: row.telegramId } });
  if (!user) return res.status(404).json({ error: 'That Telegram account is not known here. Send /start to the bot first.' });

  setSessionCookie(res, issueToken(user));
  res.json({ user: publicUser(user) });
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
