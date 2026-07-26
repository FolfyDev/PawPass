import sharp from 'sharp';
import QRCode from 'qrcode';
import { BADGE_TOKENS } from './template.js';

const MM_PER_INCH = 25.4;
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fillTokens(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = ctx[`{{${key}}}`] ?? ctx[key];
    return v === undefined ? m : String(v);
  });
}

export function contextForRegistration(reg, event, settings, publicUrl) {
  const accent = event?.accentColor || settings.accentColor;
  return {
    '{{fursona_name}}': reg.fursonaName || reg.legalName,
    '{{legal_name}}': reg.legalName,
    '{{code}}': reg.code,
    '{{event_title}}': event?.title || settings.orgName,
    '{{event_dates}}': event ? new Date(event.startsAt).toDateString() : '',
    '{{venue}}': event?.venue || '',
    '{{badge_line}}': reg.status === 'WAITLIST' ? 'Waitlist' : 'Attendee',
    '{{qr_payload}}': `${publicUrl}/t/${reg.secret}`,
    '{{accent}}': accent,
    '{{tier_name}}': reg.badgeTier || (reg.tier === 'DONATION' ? (event?.donationTierName || 'Supporter') : 'Free'),
    '{{badge_tier}}': reg.badgeTier || '',
    '{{badge_number}}': reg.badgeNumber != null ? String(reg.badgeNumber) : '',
    ...Object.fromEntries(
      Object.entries(reg.answers || {}).map(([k, v]) => [`{{${k}}}`, v]),
    ),
  };
}

/// Text fitting is measured, not estimated. The SVG rasteriser we render
/// through does not honour textLength, and font metrics vary between the
/// container's installed faces, so the only trustworthy width is the one that
/// actually comes off the renderer.
///
/// Width scales linearly with font size, so one measurement at a reference
/// size gives the ratio for every size. Results are cached per string, which
/// matters when a batch print runs the same template hundreds of times.
const REF = 100;
const widthCache = new Map();

async function measureWidth(text, el) {
  const key = `${el.font}|${el.weight}|${el.letterSpacing || 0}|${text}`;
  if (widthCache.has(key)) return widthCache.get(key);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="300">
<rect width="6000" height="300" fill="#fff"/>
<text x="20" y="220" font-family="${esc(el.font || 'DejaVu Sans')}" font-size="${REF}" font-weight="${el.weight || 400}" letter-spacing="${(el.letterSpacing || 0) * (REF / 10)}" fill="#000">${esc(text)}</text></svg>`;

  const { data, info } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
  let maxX = 20;
  for (let y = 0; y < info.height; y++) {
    const row = y * info.width;
    for (let x = info.width - 1; x > maxX; x--) {
      if (data[row + x] < 128) { maxX = x; break; }
    }
  }
  const emWidth = (maxX - 20) / REF; // width in multiples of the font size
  widthCache.set(key, emWidth);
  return emWidth;
}

/// Returns the size to draw at and, in the pathological case, a shortened
/// string. Long fursona names are the normal case on a label this narrow, not
/// the edge case.
///
/// The linear model is slightly optimistic at small sizes because glyph
/// hinting rounds advances up, so a 6% margin is held back. On a clear label
/// stuck to a pre-printed badge there is no bleed area to absorb a mistake.
const FIT_MARGIN = 0.94;
const MIN_SCALE = 0.2;

async function fitText(text, el, px) {
  const size = px(el.size);
  const str = String(text);
  if (!el.fit || !str.trim()) return { size, text: str };

  const box = px(el.w);
  const emWidth = await measureWidth(str, el);
  const natural = emWidth * size;
  if (natural <= box) return { size, text: str };

  const scale = (box / natural) * FIT_MARGIN;
  if (scale >= MIN_SCALE) return { size: size * scale, text: str };

  // Even at the smallest legible size it will not fit, so trim it. A truncated
  // name still scans and still gets the person through the door; ink running
  // off the die does not.
  const floorSize = size * MIN_SCALE;
  const keep = Math.max(1, Math.floor((str.length * box * FIT_MARGIN) / (emWidth * floorSize)));
  return { size: floorSize, text: `${str.slice(0, keep - 1).trimEnd()}\u2026` };
}

export async function renderBadgeSVG(template, ctx) {
  const dpi = template.dpi || 300;
  const px = (mm) => (mm / MM_PER_INCH) * dpi;
  const W = Math.round(px(template.widthMm));
  const H = Math.round(px(template.heightMm));
  const parts = [];
  const defs = [];

  for (const el of template.elements || []) {
    const x = px(el.x), y = px(el.y), w = px(el.w), h = px(el.h);
    const fill = fillTokens(el.fill, ctx);
    const color = fillTokens(el.color, ctx);

    if (el.type === 'rect' || el.type === 'line') {
      parts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(h, 1)}" rx="${px(el.radius || 0)}" fill="${esc(fill || '#FFFFFF')}" ${el.opacity ? `opacity="${el.opacity}"` : ''}/>`,
      );
    } else if (el.type === 'text') {
      const raw = fillTokens(el.text, ctx);
      const text = el.uppercase ? String(raw).toUpperCase() : String(raw);
      const fitted = await fitText(text, el, px);
      const size = fitted.size;
      const anchor = el.align === 'center' ? 'middle' : el.align === 'right' ? 'end' : 'start';
      const tx = el.align === 'center' ? x + w / 2 : el.align === 'right' ? x + w : x;
      const spacing = px(el.letterSpacing || 0);
      let textEl = `<text x="${tx}" y="${y + size}" font-family="${esc(el.font || 'DejaVu Sans')}" font-size="${size}" font-weight="${el.weight || 400}" fill="${esc(color || '#000')}" text-anchor="${anchor}" letter-spacing="${spacing}">${esc(fitted.text)}</text>`;
      if (el.rotate) {
        textEl = `<g transform="rotate(${el.rotate} ${x + w / 2} ${y + h / 2})">${textEl}</g>`;
      }
      parts.push(textEl);
    } else if (el.type === 'qr') {
      const value = fillTokens(el.value, ctx) || ' ';
      const svg = await QRCode.toString(value, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: el.ecc || 'M',
        color: { dark: fillTokens(el.dark, ctx) || '#000000', light: fillTokens(el.light, ctx) || '#FFFFFF' },
      });
      const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      const side = vb ? Number(vb[1]) : 33;
      parts.push(`<g transform="translate(${x},${y}) scale(${w / side})">${inner}</g>`);
    } else if (el.type === 'image' && el.href) {
      parts.push(
        `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${esc(fillTokens(el.href, ctx))}" preserveAspectRatio="${el.fitMode || 'xMidYMid meet'}"/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>${defs.join('')}</defs>
<rect width="${W}" height="${H}" fill="${esc(fillTokens(template.background, ctx) || '#FFFFFF')}"/>
${parts.join('\n')}
</svg>`;
}

export async function renderBadgePNG(template, ctx) {
  const svg = await renderBadgeSVG(template, ctx);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function renderSampleSVG(template, overrides = {}) {
  return renderBadgeSVG(template, { ...BADGE_TOKENS, ...overrides });
}
