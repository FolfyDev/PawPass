import sharp from 'sharp';
import QRCode from 'qrcode';
import bwipjs from 'bwip-js';
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

function specialQualifier(reg, event) {
  const fields = Array.isArray(event?.customFields) ? event.customFields : [];
  const field = fields.find((f) => f.type === 'qualifier');
  if (!field) return '';
  const chosen = reg.answers?.[field.key];
  const picked = Array.isArray(chosen) ? chosen : (chosen ? [chosen] : []);
  return (field.options || []).find((o) => picked.includes(o)) || '';
}

export function contextForRegistration(reg, event, settings, publicUrl) {
  const accent = event?.accentColor || settings.accentColor;
  const fursonaName = reg.fursonaName || reg.legalName;
  const tierName = reg.badgeTier || reg.tierName || 'Attendee';
  return {
    '{{fursona_name}}': fursonaName,
    '{{legal_name}}': reg.legalName,
    '{{code}}': reg.code,
    '{{event_title}}': event?.title || settings.orgName,
    '{{event_dates}}': event ? new Date(event.startsAt).toDateString() : '',
    '{{venue}}': event?.venue || '',
    '{{badge_line}}': reg.status === 'WAITLIST' ? 'Waitlist' : 'Attendee',
    '{{qr_payload}}': `${publicUrl}/t/${reg.secret}`,
    '{{accent}}': accent,
    '{{tier_name}}': tierName,
    '{{badge_tier}}': reg.badgeTier || '',
    '{{badge_number}}': reg.badgeNumber != null ? String(reg.badgeNumber) : '',
    ...Object.fromEntries(
      Object.entries(reg.answers || {}).map(([k, v]) => [`{{${k}}}`, v]),
    ),
   
    '{{special_qualifier}}': specialQualifier(reg, event),

    '{{badge_payload}}': `${reg.code}|${tierName}|${fursonaName}`,
  };
}

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

  const floorSize = size * MIN_SCALE;
  const keep = Math.max(1, Math.floor((str.length * box * FIT_MARGIN) / (emWidth * floorSize)));
  return { size: floorSize, text: `${str.slice(0, keep - 1).trimEnd()}\u2026` };
}


function embedSquareSvg(svg, x, y, w) {
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  const side = vb ? Number(vb[1]) : 33;
  return `<g transform="translate(${x},${y}) scale(${w / side})">${inner}</g>`;
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
      parts.push(embedSquareSvg(svg, x, y, w));
    } else if (el.type === 'aztec') {
      const value = fillTokens(el.value, ctx) || ' ';
      const svg = bwipjs.toSVG({
        bcid: el.compact ? 'azteccodecompact' : 'azteccode',
        text: value,
        scale: 1,
        barcolor: (fillTokens(el.dark, ctx) || '#000000').replace('#', ''),
        backgroundcolor: (fillTokens(el.light, ctx) || '#FFFFFF').replace('#', ''),
      });
      parts.push(embedSquareSvg(svg, x, y, w));
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
