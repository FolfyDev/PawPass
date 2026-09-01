// Must be imported before any router is created (auth/public/admin/badges
// below all call Router() at module load time) — it patches Express 4's
// Router so a throw or rejection inside an `async` handler reaches the error
// middleware below instead of becoming an unhandled rejection that crashes
// the whole process.
import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
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
import { escapeHtml } from './lib/html.js';

/// A default JWT secret means anyone can forge a session (including an
/// OWNER one) just by reading this file — refuse to boot with it anywhere
/// that isn't plainly a local dev box, the same loopback+http check
/// localDevAuthAvailable() uses for the dev sign-in bypass.
function isLocalDev() {
  try {
    const u = new URL(env.publicUrl);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch {
    return false;
  }
}
if (env.jwtSecret === 'dev-secret-change-me' && !isLocalDev()) {
  console.error('Refusing to start: JWT_SECRET is still the default. Set a long random value in .env before deploying.');
  process.exit(1);
}
if ((env.owner.password || 'change-me-now') === 'change-me-now' && !isLocalDev()) {
  console.warn('Warning: OWNER_PASSWORD is unset or default — change it from the Account page immediately after first sign-in.');
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  // This is a JSON API plus one hand-rolled HTML page (/t/:secret, built with
  // inline style="" attributes) — helmet's default CSP is meant for
  // full HTML apps and would break that page's styling for no benefit here.
  contentSecurityPolicy: false,
  // /uploads (logos/banners) is fetched as an <img src> from the separate
  // web origin — the default same-origin policy would silently block that.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: [env.webUrl], credentials: true }));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(loadUser);
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/// Generated from WEB_URL rather than shipped as static files, so the domain
/// stays correct without rebuilding the web image — see nginx.conf, which
/// proxies both paths here instead of serving them from the SPA build.
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /tickets\n\nSitemap: ${env.webUrl}/sitemap.xml\n`);
});

app.get('/sitemap.xml', async (_req, res) => {
  const events = await prisma.event.findMany({ where: { published: true }, select: { slug: true, updatedAt: true } });
  const staticUrls = [
    { loc: '/', priority: '1.0' },
    { loc: '/login', priority: '0.3' },
    { loc: '/legal/terms', priority: '0.2' },
    { loc: '/legal/privacy', priority: '0.2' },
  ];
  const urls = [
    ...staticUrls.map((u) => `  <url><loc>${env.webUrl}${u.loc}</loc><priority>${u.priority}</priority></url>`),
    ...events.map((e) => `  <url><loc>${env.webUrl}/e/${e.slug}</loc><lastmod>${e.updatedAt.toISOString().slice(0, 10)}</lastmod><priority>0.8</priority></url>`),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
});

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
  // reg.code/status are server-generated and reg.event fields are admin-set,
  // but fursonaName/legalName come straight from the attendee's own
  // registration form — interpolating them unescaped would let anyone who
  // scans a QR or opens this link run script in this page's origin.
  const name = escapeHtml(reg.fursonaName || reg.legalName);
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(reg.event.accentColor) ? reg.event.accentColor : '#FF5B04';
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(reg.code)}</title>
<body style="font-family:system-ui;background:#0E1116;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><p style="letter-spacing:.2em;color:#9AA4B2;font-size:12px;text-transform:uppercase">${escapeHtml(reg.event.title)}</p>
<h1 style="font-family:ui-monospace,monospace;font-size:38px;margin:.2em 0">${escapeHtml(reg.code)}</h1>
<p style="color:#9AA4B2">${name} · ${escapeHtml(reg.status)}</p>
<a href="${escapeHtml(env.webUrl)}/tickets" style="color:${accent}">Open your ticket</a></div></body>`);
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
