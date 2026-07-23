import nodemailer from 'nodemailer';
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
