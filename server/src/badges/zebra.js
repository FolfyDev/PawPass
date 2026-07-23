import net from 'node:net';
import sharp from 'sharp';
import { env } from '../lib/env.js';
import { renderBadgeSVG } from './render.js';

/// Converts a badge into a ^GFA bitmap ZPL job. The ZD500 prints whatever
/// raster we hand it, so we render the template exactly as designed and
/// threshold it to 1-bit rather than trying to map elements onto ZPL commands.
export async function badgeToZPL(template, ctx, opts = {}) {
  const dpi = opts.dpi || env.zebra.dpi || 300;
  const svg = await renderBadgeSVG({ ...template, dpi }, ctx);

  const widthPx = Math.round((template.widthMm / 25.4) * dpi);
  const heightPx = Math.round((template.heightMm / 25.4) * dpi);
  // ZPL rows must be a whole number of bytes.
  const bytesPerRow = Math.ceil(widthPx / 8);
  const paddedWidth = bytesPerRow * 8;

  const raw = await sharp(Buffer.from(svg))
    .flatten({ background: '#ffffff' })
    .resize(widthPx, heightPx, { fit: 'fill' })
    .extend({ right: paddedWidth - widthPx, background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer();

  const threshold = opts.threshold ?? 128;
  const bits = Buffer.alloc(bytesPerRow * heightPx, 0);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < paddedWidth; x++) {
      // In ZPL a set bit prints black.
      if (raw[y * paddedWidth + x] < threshold) {
        bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  const hex = bits.toString('hex').toUpperCase();
  const total = bits.length;
  const darkness = opts.darkness ?? 20;
  const speed = opts.speed ?? 3;

  return [
    '^XA',
    `^MD${darkness}`,
    `^PR${speed}`,
    `^PW${paddedWidth}`,
    `^LL${heightPx}`,
    '^LH0,0',
    `^FO0,0^GFA,${total},${total},${bytesPerRow},${hex}^FS`,
    `^PQ${opts.copies || 1}`,
    '^XZ',
  ].join('\n');
}

/// Sends a job straight to the printer's raw TCP port (9100).
export function sendToPrinter(zpl, host = env.zebra.host, port = env.zebra.port) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('No printer host configured.'));
    const socket = net.createConnection({ host, port, timeout: 8000 }, () => {
      socket.write(zpl, () => socket.end());
    });
    socket.on('close', () => resolve(true));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Printer did not respond.')); });
    socket.on('error', reject);
  });
}
