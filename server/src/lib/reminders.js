import { prisma } from './db.js';
import { env } from './env.js';
import { formatInTimeZone } from './tz.js';
import { notifyPerson } from './payments.js';

/// Reminders, by Telegram and/or email (whichever the person has). Each one
/// is claimed with a compare-and-swap on its "sent at" column before it goes
/// out, so overlapping runs never send the same reminder twice. Run from the
/// payment sweeper's once-a-minute tick (lib/payments.js).

const money = (cents, currency = 'usd') => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

/// "Your held spot expires in a few minutes" — for checkouts that are about
/// to lapse unpaid.
export async function sendHoldReminders(now = new Date()) {
  const due = await prisma.payment.findMany({
    where: {
      method: 'STRIPE', status: 'PENDING', holdReminderSentAt: null,
      expiresAt: { gt: new Date(now.getTime() + 60_000), lte: new Date(now.getTime() + 5 * 60_000) },
    },
    include: { registration: { include: { user: true, event: true } }, merchOrder: { include: { user: true, event: true } } },
    take: 50,
  });
  for (const p of due) {
    const claimed = await prisma.payment.updateMany({ where: { id: p.id, holdReminderSentAt: null }, data: { holdReminderSentAt: now } });
    if (!claimed.count) continue;
    const minutes = Math.max(1, Math.round((p.expiresAt - now) / 60_000));
    const thing = p.registration ? `spot for ${p.registration.event.title}` : `pre-order for ${p.merchOrder.event.title}`;
    const owner = p.registration ?? p.merchOrder;
    await notifyPerson({
      user: owner.user,
      email: p.registration?.email || owner.user.email,
      subject: `Your held ${thing} expires soon`,
      text: `Your held ${thing} expires in about ${minutes} minutes. Pay ${money(p.amountCents, p.currency)} to keep it: ${env.webUrl}/tickets`,
    }).catch((e) => console.error('hold reminder failed', p.id, e.message));
  }
}

/// "<Event> is tomorrow" for every confirmed attendee, sent once, about a
/// day ahead. Includes any paid pre-orders waiting at the merch table.
export async function sendEventReminders(now = new Date()) {
  const events = await prisma.event.findMany({
    where: { published: true, startsAt: { gt: new Date(now.getTime() + 20 * 3600_000), lte: new Date(now.getTime() + 26 * 3600_000) } },
  });
  for (const event of events) {
    const regs = await prisma.registration.findMany({
      where: { eventId: event.id, status: 'CONFIRMED', eventReminderSentAt: null },
      include: { user: true },
      take: 100,
    });
    for (const reg of regs) {
      const claimed = await prisma.registration.updateMany({ where: { id: reg.id, eventReminderSentAt: null }, data: { eventReminderSentAt: now } });
      if (!claimed.count) continue;
      const orders = await prisma.merchOrder.findMany({
        where: { eventId: event.id, userId: reg.userId, status: 'PAID', pickedUpAt: null },
        include: { items: true },
      });
      const pickup = orders.flatMap((o) => o.items.map((i) => `${i.quantity} × ${i.name}`));
      await notifyPerson({
        user: reg.user,
        email: reg.email || reg.user.email,
        subject: `${event.title} is tomorrow`,
        text: `${event.title} is tomorrow: ${formatInTimeZone(event.startsAt, event.timezone)}${event.venue ? `, ${event.venue}` : ''}.\n\n` +
          `Badge code: ${reg.code}\nBring the QR from ${env.webUrl}/tickets to check in.` +
          (pickup.length ? `\n\nYour pre-order is waiting at the merch table: ${pickup.join(', ')}.` : ''),
      }).catch((e) => console.error('event reminder failed', reg.id, e.message));
    }
  }
}

/// Staff pressed "Tell buyers it's ready" on the Merch tab: every paid,
/// not-yet-collected pre-order that hasn't been told yet. Returns how many.
export async function notifyPreordersReady(eventId, now = new Date()) {
  const orders = await prisma.merchOrder.findMany({
    where: { eventId, status: 'PAID', pickedUpAt: null, readyNotifiedAt: null },
    include: { items: true, user: true, event: true },
  });
  let sent = 0;
  for (const o of orders) {
    const claimed = await prisma.merchOrder.updateMany({ where: { id: o.id, readyNotifiedAt: null }, data: { readyNotifiedAt: now } });
    if (!claimed.count) continue;
    await notifyPerson({
      user: o.user,
      email: o.user.email,
      subject: `Your ${o.event.title} pre-order is ready`,
      text: `Your pre-order is ready to pick up at the ${o.event.title} merch table: ${o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}.`,
    }).catch((e) => console.error('pre-order ready notice failed', o.id, e.message));
    sent++;
  }
  return sent;
}

/* ------------------------------------------------ per-event messages ---- */

/// The organizer's own text with the usual tokens filled in.
async function fill(text, reg, event) {
  const { personalize } = await import('./mailer.js');
  const { getSettings } = await import('./settings.js');
  return personalize(text, { reg, event, settings: await getSettings() });
}

/// "Know before you go": sent once to every confirmed attendee, starting
/// kbygDaysBefore days before the event. Always ends with the essentials
/// (when, where, badge code, ticket link) under the organizer's message.
export async function sendKnowBeforeYouGo(now = new Date()) {
  const events = await prisma.event.findMany({ where: { published: true, kbygEnabled: true, startsAt: { gt: now } } });
  for (const event of events) {
    if (event.startsAt.getTime() - event.kbygDaysBefore * 24 * 3600_000 > now.getTime()) continue;
    const regs = await prisma.registration.findMany({
      where: { eventId: event.id, status: 'CONFIRMED', kbygSentAt: null },
      include: { user: true },
      take: 100,
    });
    for (const reg of regs) {
      const claimed = await prisma.registration.updateMany({ where: { id: reg.id, kbygSentAt: null }, data: { kbygSentAt: now } });
      if (!claimed.count) continue;
      const intro = event.kbygMessage.trim() ? `${await fill(event.kbygMessage.trim(), reg, event)}\n\n` : '';
      await notifyPerson({
        user: reg.user,
        email: reg.email || reg.user.email,
        subject: `Know before you go: ${event.title}`,
        text: `${intro}${event.title}: ${formatInTimeZone(event.startsAt, event.timezone)}${event.venue ? `, ${event.venue}` : ''}.\n` +
          `Badge code: ${reg.code}\nYour ticket: ${env.webUrl}/tickets`,
      }).catch((e) => console.error('know-before-you-go failed', reg.id, e.message));
    }
  }
}

/// Thank-you after the event ends, with the feedback link if there is one.
/// Goes to people who checked in, or to every confirmed attendee if the
/// event didn't use check-in. Only within 2 days of the end, so turning it on
/// later doesn't message people about an event long past.
export async function sendThankYous(now = new Date()) {
  const events = await prisma.event.findMany({
    where: { thanksEnabled: true, endsAt: { lte: now, gt: new Date(now.getTime() - 2 * 24 * 3600_000) } },
  });
  for (const event of events) {
    const usedCheckIn = (await prisma.registration.count({ where: { eventId: event.id, checkedInAt: { not: null } } })) > 0;
    const regs = await prisma.registration.findMany({
      where: { eventId: event.id, status: 'CONFIRMED', thanksSentAt: null, ...(usedCheckIn ? { checkedInAt: { not: null } } : {}) },
      include: { user: true },
      take: 100,
    });
    for (const reg of regs) {
      const claimed = await prisma.registration.updateMany({ where: { id: reg.id, thanksSentAt: null }, data: { thanksSentAt: now } });
      if (!claimed.count) continue;
      const body = event.thanksMessage.trim() || 'Thanks for coming to {{event_title}}!';
      await notifyPerson({
        user: reg.user,
        email: reg.email || reg.user.email,
        subject: `Thanks for coming to ${event.title}`,
        text: (await fill(body, reg, event)) + (event.feedbackUrl ? `\n\nTell us how it went: ${event.feedbackUrl}` : ''),
      }).catch((e) => console.error('thank-you failed', reg.id, e.message));
    }
  }
}
