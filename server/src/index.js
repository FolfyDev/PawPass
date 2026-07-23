import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import path from 'path';
import { env } from './lib/env.js';
import { prisma } from './lib/db.js';
import { loadUser } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { badgeRouter } from './routes/badges.js';
import { createBot } from './bot/index.js';
import { STARTER_TEMPLATE } from './badges/template.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: [env.webUrl], credentials: true }));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(loadUser);
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api', publicRouter);
app.use('/api/admin', adminRouter);
app.use('/api/badges', badgeRouter);

/// Short URL encoded in every QR. Scanners that are just cameras land here and
/// get a human-readable page; the staff scanner posts the URL to /api/admin/checkin.
app.get('/t/:secret', async (req, res) => {
  const reg = await prisma.registration.findUnique({
    where: { secret: req.params.secret },
    include: { event: true },
  });
  if (!reg) return res.status(404).send('Ticket not found.');
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${reg.code}</title>
<body style="font-family:system-ui;background:#0E1116;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><p style="letter-spacing:.2em;color:#9AA4B2;font-size:12px;text-transform:uppercase">${reg.event.title}</p>
<h1 style="font-family:ui-monospace,monospace;font-size:38px;margin:.2em 0">${reg.code}</h1>
<p style="color:#9AA4B2">${reg.fursonaName || reg.legalName} · ${reg.status}</p>
<a href="${env.webUrl}/tickets" style="color:${reg.event.accentColor}">Open your ticket</a></div></body>`);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

async function bootstrap() {
  // Seed the starter badge template once.
  if ((await prisma.badgeTemplate.count()) === 0) {
    await prisma.badgeTemplate.create({ data: { ...STARTER_TEMPLATE, isDefault: true } });
  }
  // Seed the owner account so a fresh install has a way in.
  if ((await prisma.user.count({ where: { role: 'OWNER' } })) === 0 && env.owner.email) {
    await prisma.user.create({
      data: {
        email: env.owner.email.toLowerCase(),
        passwordHash: await bcrypt.hash(env.owner.password || 'change-me-now', 12),
        telegramId: env.owner.telegramId || null,
        displayName: 'Owner',
        role: 'OWNER',
      },
    });
    console.log(`Seeded owner account: ${env.owner.email}`);
  }
}

bootstrap().then(() => {
  app.listen(env.port, () => console.log(`API on :${env.port}`));
  const bot = createBot();
  if (bot) {
    bot.start({ onStart: (i) => console.log(`Telegram bot @${i.username} running`) });
  } else {
    console.log('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
  }
});
