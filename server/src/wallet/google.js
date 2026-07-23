import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';

/// Returns an "Add to Google Wallet" save link. Google accepts a signed JWT
/// containing the object inline, so no pre-provisioning call is needed for a
/// first deployment — the class is created on first save.
export function googleSaveUrl({ registration, event, settings }) {
  if (!env.google.enabled) throw new Error('Google Wallet is not configured on this instance.');
  const sa = JSON.parse(fs.readFileSync(env.google.serviceAccount, 'utf8'));
  const classId = `${env.google.issuerId}.${event.slug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const objectId = `${env.google.issuerId}.${registration.id}`;

  const eventClass = {
    id: classId,
    issuerName: settings.orgName,
    eventName: { defaultValue: { language: 'en-US', value: event.title } },
    venue: {
      name: { defaultValue: { language: 'en-US', value: event.venue || settings.orgName } },
      address: { defaultValue: { language: 'en-US', value: event.venue || '' } },
    },
    dateTime: { start: new Date(event.startsAt).toISOString() },
    reviewStatus: 'UNDER_REVIEW',
  };

  const eventObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    hexBackgroundColor: event.accentColor || settings.accentColor,
    ticketHolderName: registration.fursonaName || registration.legalName,
    ticketNumber: registration.code,
    barcode: { type: 'QR_CODE', value: `${env.publicUrl}/t/${registration.secret}`, alternateText: registration.code },
  };

  const claims = {
    iss: sa.client_email,
    aud: 'google',
    typ: 'savetowallet',
    origins: [env.webUrl],
    payload: { eventTicketClasses: [eventClass], eventTicketObjects: [eventObject] },
  };

  const token = jwt.sign(claims, sa.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}
