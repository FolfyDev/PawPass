import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { requireAdmin, audit } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { STARTER_TEMPLATE, BADGE_TOKENS, LABEL_PRESETS } from '../badges/template.js';
import { renderBadgePNG, renderSampleSVG, renderBadgeSVG, contextForRegistration } from '../badges/render.js';
import { badgeToZPL, sendToPrinter } from '../badges/zebra.js';

export const badgeRouter = Router();
badgeRouter.use(requireAdmin);

badgeRouter.get('/tokens', (_req, res) => res.json(BADGE_TOKENS));
badgeRouter.get('/presets', (_req, res) => res.json(LABEL_PRESETS));

badgeRouter.get('/templates', async (_req, res) => {
  res.json(await prisma.badgeTemplate.findMany({ orderBy: { createdAt: 'asc' } }));
});

/// New templates start as a blank canvas — the operator builds the layout
/// from scratch. The seeded "Default badge" (STARTER_TEMPLATE) is the only
/// one that ships pre-built; see bootstrap() in index.js.
badgeRouter.post('/templates', async (req, res) => {
  const t = await prisma.badgeTemplate.create({
    data: { elements: [], ...req.body, name: req.body.name || 'Untitled badge' },
  });
  res.json(t);
});

badgeRouter.patch('/templates/:id', async (req, res) => {
  const { name, widthMm, heightMm, dpi, background, elements, isDefault } = req.body;
  if (isDefault) await prisma.badgeTemplate.updateMany({ data: { isDefault: false } });
  const t = await prisma.badgeTemplate.update({
    where: { id: req.params.id },
    data: { name, widthMm, heightMm, dpi, background, elements, isDefault },
  });
  res.json(t);
});

badgeRouter.delete('/templates/:id', async (req, res) => {
  await prisma.badgeTemplate.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

badgeRouter.post('/templates/:id/duplicate', async (req, res) => {
  const src = await prisma.badgeTemplate.findUnique({ where: { id: req.params.id } });
  if (!src) return res.status(404).json({ error: 'Template not found.' });
  const { id, createdAt, isDefault, ...rest } = src;
  res.json(await prisma.badgeTemplate.create({ data: { ...rest, name: `${src.name} copy` } }));
});

/// Live preview for the designer. Accepts an unsaved template body so the
/// canvas can update as the operator drags things around.
badgeRouter.post('/preview.svg', async (req, res) => {
  const svg = await renderSampleSVG(req.body.template || STARTER_TEMPLATE, req.body.overrides);
  res.type('image/svg+xml').send(svg);
});

/// Accepts either a clean badge code or a raw scanned value — a QR payload
/// is the full `.../t/<secret>` URL, not the code — same flexible match
/// /print already does, so any caller (browser-print included) can hand
/// this whatever a camera or a manual code entry produced.
async function resolve(raw) {
  const secret = raw.split('/').pop();
  const reg = await prisma.registration.findFirst({
    where: { OR: [{ secret }, { code: raw.toUpperCase() }] },
    include: { event: { include: { badgeTemplate: true } } },
  });
  if (!reg) return null;
  const template =
    reg.event.badgeTemplate ||
    (await prisma.badgeTemplate.findFirst({ where: { isDefault: true } })) ||
    STARTER_TEMPLATE;
  const settings = await getSettings();
  return { reg, template, ctx: contextForRegistration(reg, reg.event, settings, env.publicUrl) };
}

badgeRouter.get('/registration/:code.png', async (req, res) => {
  const r = await resolve(req.params.code);
  if (!r) return res.status(404).json({ error: 'Ticket not found.' });
  res.type('png').send(await renderBadgePNG(r.template, r.ctx));
});

badgeRouter.get('/registration/:code.svg', async (req, res) => {
  const r = await resolve(req.params.code);
  if (!r) return res.status(404).json({ error: 'Ticket not found.' });
  res.type('image/svg+xml').send(await renderBadgeSVG(r.template, r.ctx));
});

badgeRouter.get('/registration/:code.zpl', async (req, res) => {
  const r = await resolve(req.params.code);
  if (!r) return res.status(404).json({ error: 'Ticket not found.' });
  res.type('text/plain').send(await badgeToZPL(r.template, r.ctx, req.query));
});

/// Browser-print bookkeeping: there's no TCP handshake to confirm a job was
/// accepted like /print has, so the frontend calls this right after handing
/// the badge image to the OS print dialog — best-effort, same as /print's
/// own guarantee really (a successful send doesn't confirm the label came out).
badgeRouter.post('/registration/:code/printed', async (req, res) => {
  const raw = req.params.code;
  const reg = await prisma.registration.findFirst({ where: { OR: [{ secret: raw }, { code: raw.toUpperCase() }] } });
  if (!reg) return res.status(404).json({ error: 'Ticket not found.' });
  const updated = await prisma.registration.update({
    where: { id: reg.id },
    data: { badgePrintedAt: new Date(), printCount: { increment: 1 } },
  });
  await audit(req.user.id, 'badge.print', reg.id, { code: reg.code, via: 'browser' });
  res.json({ ok: true, code: updated.code, printCount: updated.printCount });
});

/// Scan-to-print: the badge desk scans a QR, this renders and pushes the job
/// straight to the ZD500 over port 9100.
badgeRouter.post('/print', async (req, res) => {
  const raw = String(req.body.value || req.body.code || '').trim();
  const secret = raw.split('/').pop();
  const found = await prisma.registration.findFirst({ where: { OR: [{ secret }, { code: raw.toUpperCase() }] } });
  if (!found) return res.status(404).json({ error: 'No ticket matches that code.' });

  const r = await resolve(found.code);
  const zpl = await badgeToZPL(r.template, r.ctx, {
    copies: req.body.copies || 1,
    darkness: req.body.darkness,
    speed: req.body.speed,
    dpi: req.body.dpi,
  });

  const host = req.body.printerHost || env.zebra.host;
  try {
    await sendToPrinter(zpl, host, req.body.printerPort || env.zebra.port);
  } catch (e) {
    return res.status(502).json({ error: `Printer at ${host} did not accept the job: ${e.message}` });
  }

  const updated = await prisma.registration.update({
    where: { id: found.id },
    data: { badgePrintedAt: new Date(), printCount: { increment: 1 } },
  });
  await audit(req.user.id, 'badge.print', found.id, { code: found.code });
  res.json({ ok: true, code: updated.code, printCount: updated.printCount });
});

/// Batch print, e.g. everyone checked in but not yet badged.
badgeRouter.post('/print-batch', async (req, res) => {
  const regs = await prisma.registration.findMany({
    where: {
      eventId: req.body.eventId,
      status: 'CONFIRMED',
      ...(req.body.onlyUnprinted ? { badgePrintedAt: null } : {}),
      ...(req.body.onlyCheckedIn ? { checkedInAt: { not: null } } : {}),
    },
    orderBy: { legalName: 'asc' },
  });
  const results = [];
  for (const reg of regs) {
    const r = await resolve(reg.code);
    try {
      await sendToPrinter(await badgeToZPL(r.template, r.ctx, req.body), req.body.printerHost, req.body.printerPort);
      await prisma.registration.update({
        where: { id: reg.id },
        data: { badgePrintedAt: new Date(), printCount: { increment: 1 } },
      });
      results.push({ code: reg.code, ok: true });
    } catch (e) {
      results.push({ code: reg.code, ok: false, error: e.message });
    }
  }
  await audit(req.user.id, 'badge.print_batch', req.body.eventId, { count: results.length });
  res.json({ printed: results.filter((r) => r.ok).length, results });
});

badgeRouter.get('/printer', (_req, res) =>
  res.json({ host: env.zebra.host, port: env.zebra.port, dpi: env.zebra.dpi }));
