import { env } from '../lib/env.js';

/// Builds a .pkpass for an attendee. Requires an Apple Developer pass type ID
/// and the three PEM files referenced in .env; without them the endpoint
/// reports itself as unconfigured rather than failing at request time.
export async function buildApplePass({ registration, event, settings }) {
  if (!env.apple.enabled) throw new Error('Apple Wallet is not configured on this instance.');
  const { PKPass } = await import('passkit-generator');
  const fs = await import('node:fs/promises');

  const pass = await PKPass.from(
    {
      model: new URL('./apple-model', import.meta.url).pathname,
      certificates: {
        wwdr: await fs.readFile(env.apple.wwdr),
        signerCert: await fs.readFile(env.apple.signerCert),
        signerKey: await fs.readFile(env.apple.signerKey),
        signerKeyPassphrase: env.apple.passphrase || undefined,
      },
    },
    {
      serialNumber: registration.id,
      description: `${event.title} ticket`,
      organizationName: settings.orgName,
      passTypeIdentifier: env.apple.passTypeId,
      teamIdentifier: env.apple.teamId,
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: hexToRgb(event.accentColor || settings.accentColor),
      labelColor: 'rgb(20,20,20)',
    },
  );

  pass.type = 'eventTicket';
  pass.primaryFields.push({ key: 'name', label: 'Attendee', value: registration.fursonaName || registration.legalName });
  pass.secondaryFields.push(
    { key: 'event', label: 'Event', value: event.title },
    { key: 'code', label: 'Code', value: registration.code },
  );
  pass.auxiliaryFields.push(
    { key: 'when', label: 'Starts', value: new Date(event.startsAt).toLocaleString() },
    { key: 'where', label: 'Venue', value: event.venue || '' },
  );
  pass.setBarcodes({
    format: 'PKBarcodeFormatQR',
    message: `${env.publicUrl}/t/${registration.secret}`,
    messageEncoding: 'iso-8859-1',
    altText: registration.code,
  });
  pass.setRelevantDate(new Date(event.startsAt));

  return pass.getAsBuffer();
}

function hexToRgb(hex = '#000000') {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}
