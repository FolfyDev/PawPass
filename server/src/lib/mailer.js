import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { prisma } from './db.js';
import { env } from './env.js';
import { getSettings } from './settings.js';
import { escapeHtml } from './html.js';

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

/// Every email goes through here: the sender name and reply-to from the
/// settings page (lib/instance.js), and the footer on everything except
/// sign-in codes.
function send(message, { footer = true } = {}) {
  const extra = footer && env.smtp.footer;
  return getTransport().sendMail({
    ...message,
    from: env.smtp.fromName ? { name: env.smtp.fromName, address: env.smtp.from } : env.smtp.from,
    replyTo: env.smtp.replyTo || undefined,
    text: extra ? `${message.text}\n\n--\n${extra}` : message.text,
    html: message.html && extra
      ? `${message.html}<hr><p style="color:#666;font-size:13px">${escapeHtml(extra).replace(/\n/g, '<br>')}</p>`
      : message.html,
  });
}

/// For the settings page's status card: can we log in to the SMTP server?
export async function verifySmtp() {
  try { await getTransport().verify(); } catch (e) { throw new Error(smtpHint(e)); }
}

/// The usual SMTP mistakes, in words an owner can act on.
export function smtpHint(e) {
  const m = String(e?.message || e);
  if (/wrong version number/i.test(m))
    return `Port ${env.smtp.port} doesn't start with TLS. For port 587 set SMTP_SECURE=false (it upgrades to TLS on its own); for port 465 set SMTP_SECURE=true.`;
  if (/Invalid login|535|Username and Password not accepted/i.test(m))
    return 'The mail server rejected the username or password. For Gmail, use an app password, not your normal one.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return `Can't find a server called ${env.smtp.host}. Check SMTP_HOST.`;
  if (/ECONNREFUSED|ETIMEDOUT|Greeting never received/i.test(m)) return `Nothing answered at ${env.smtp.host}:${env.smtp.port}. Check SMTP_HOST and SMTP_PORT.`;
  return m.trim();
}

/// "Send test email" on the settings page, footer included so it can be checked.
export async function sendTestEmail(to) {
  await getTransport().verify().catch((e) => { throw new Error(smtpHint(e)); });
  await send({
    to,
    subject: 'PawPass test email',
    text: 'This is a test email from PawPass. If you got it, email sending works.',
  });
}

const AUDIENCE = {
  all: { status: { in: ['CONFIRMED', 'WAITLIST'] } },
  checked_in: { status: 'CONFIRMED', checkedInAt: { not: null } },
  not_checked_in: { status: 'CONFIRMED', checkedInAt: null },
  waitlist: { status: 'WAITLIST' },
};

export async function sendOtpEmail(email, code) {
  await send({
    to: email,
    subject: `Your sign-in code: ${code}`,
    text: `Your sign-in code is ${code}. It works once and expires in ${env.loginCodeTtlMinutes} minutes.\n\nIf you didn't request this, you can ignore this email.`,
  }, { footer: false });
}

/// A short plain-text notice (refunds, cancellation decisions). Callers
/// decide whether a missing SMTP config is worth reporting.
export async function sendNoticeEmail(to, subject, text) {
  if (!to) return;
  await send({ to, subject, text });
}

export async function sendRegistrationConfirmation(reg, event, settings) {
  if (!reg.email) return;
  getTransport();
  const name = reg.fursonaName || reg.legalName;
  const eventDate = event?.startsAt ? new Date(event.startsAt).toDateString() : '';
  const qrPayload = `${env.webUrl}/t/${reg.secret}`;
  const qrPng = await QRCode.toBuffer(qrPayload, { type: 'png', margin: 1, width: 240 });

  const statusLine = reg.status === 'WAITLIST' ? 'You are on the waitlist for' : 'You are registered for';

  await send({
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

  getTransport();
  let sent = 0;
  for (const reg of recipients) {
    const vars = { reg, event: reg.event, settings };
    try {
      await send({
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
