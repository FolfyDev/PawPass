import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { prisma } from './db.js';
import { env } from './env.js';
import { getSettings } from './settings.js';

let transport;
function getTransport() {
  if (!env.smtp.enabled) throw new Error('SMTP is not configured on this instance.');
  transport ||= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure || env.smtp.port === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  return transport;
}

const AUDIENCE = {
  all: { status: { in: ['CONFIRMED', 'WAITLIST'] } },
  checked_in: { status: 'CONFIRMED', checkedInAt: { not: null } },
  not_checked_in: { status: 'CONFIRMED', checkedInAt: null },
  waitlist: { status: 'WAITLIST' },
};

export async function sendOtpEmail(email, code) {
  const tx = getTransport();
  await tx.sendMail({
    from: env.smtp.from,
    to: email,
    subject: `Your sign-in code: ${code}`,
    text: `Your sign-in code is ${code}. It works once and expires in ${env.loginCodeTtlMinutes} minutes.\n\nIf you didn't request this, you can ignore this email.`,
  });
}

/// Sent right after a registration is created (web, bot, or admin walk-up —
/// see the three call sites in registrations.js's callers). Fire-and-forget
/// from the caller's side, same as sendOtpEmail: a missing/broken SMTP setup
/// should never fail the registration itself.
export async function sendRegistrationConfirmation(reg, event, settings) {
  if (!reg.email) return;
  const tx = getTransport();
  const name = reg.fursonaName || reg.legalName;
  const eventDate = event?.startsAt ? new Date(event.startsAt).toDateString() : '';
  const qrPayload = `${env.webUrl}/t/${reg.secret}`;
  const qrPng = await QRCode.toBuffer(qrPayload, { type: 'png', margin: 1, width: 240 });

  const statusLine = reg.status === 'WAITLIST' ? 'You are on the waitlist for' : 'You are registered for';

  await tx.sendMail({
    from: env.smtp.from,
    to: reg.email,
    subject: `${statusLine} ${event?.title || settings.orgName}`,
    text:
      `${statusLine} ${event?.title || settings.orgName}${eventDate ? ` (${eventDate})` : ''}.\n\n` +
      `Name: ${name}\n` +
      `Badge code: ${reg.code}\n\n` +
      `Bring the QR attached to this email to check in, or view it any time at ${env.webUrl}/tickets.`,
    html:
      `<p>${statusLine} <strong>${event?.title || settings.orgName}</strong>${eventDate ? ` (${eventDate})` : ''}.</p>` +
      `<p>Name: <strong>${name}</strong><br>Badge code: <strong>${reg.code}</strong></p>` +
      `<p><img src="cid:regqr" alt="Check-in QR code" width="240" height="240"></p>` +
      `<p>Bring this QR to check in, or view your ticket any time at <a href="${env.webUrl}/tickets">${env.webUrl}/tickets</a>.</p>`,
    attachments: [{ filename: 'ticket-qr.png', content: qrPng, cid: 'regqr' }],
  });
}

export function personalize(text, { reg, event, settings }) {
  return text
    .replaceAll('{{fursona_name}}', reg.fursonaName || reg.legalName)
    .replaceAll('{{legal_name}}', reg.legalName)
    .replaceAll('{{code}}', reg.code)
    .replaceAll('{{event_title}}', event?.title || settings.orgName)
    .replaceAll('{{ticket_url}}', `${env.webUrl}/tickets`)
    .replaceAll('{{org_name}}', settings.orgName);
}

export async function sendCampaign(id, { dryRun } = {}) {
  const campaign = await prisma.emailCampaign.findUnique({ where: { id }, include: { event: true } });
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.sentAt) throw new Error('This campaign was already sent.');

  const settings = await getSettings();
  const recipients = await prisma.registration.findMany({
    where: {
      ...(campaign.eventId ? { eventId: campaign.eventId } : {}),
      ...(AUDIENCE[campaign.audience] || AUDIENCE.all),
      email: { not: null },
    },
    include: { event: true },
  });

  if (dryRun) return { dryRun: true, recipients: recipients.length };

  const tx = getTransport();
  let sent = 0;
  for (const reg of recipients) {
    const vars = { reg, event: reg.event, settings };
    try {
      await tx.sendMail({
        from: env.smtp.from,
        to: reg.email,
        subject: personalize(campaign.subject, vars),
        text: personalize(campaign.body, vars),
      });
      sent++;
    } catch (e) {
      console.error('mail failed', reg.email, e.message);
    }
  }

  await prisma.emailCampaign.update({ where: { id }, data: { sentAt: new Date(), sentCount: sent } });
  return { sent, recipients: recipients.length };
}
