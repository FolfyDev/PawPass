import fs from 'fs/promises';
import path from 'path';
import { prisma } from './db.js';
import { blindIndex } from './crypto.js';
import { audit } from './auth.js';

export class AccountError extends Error {}

/// Everything PawPass holds about a person, decrypted, as plain JSON — the
/// "download my data" the privacy policy promises.
export async function exportAccount(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const regs = await prisma.registration.findMany({
    where: { userId },
    include: { event: true, payments: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  const orders = await prisma.merchOrder.findMany({
    where: { userId },
    include: { event: true, items: true, payments: true },
    orderBy: { createdAt: 'asc' },
  });
  const pay = (p) => ({
    method: p.method, status: p.status, amount: p.amountCents / 100, refunded: p.amountRefundedCents / 100,
    currency: p.currency, paidAt: p.paidAt, stripeReference: p.stripePaymentIntentId,
  });
  return {
    exportedAt: new Date().toISOString(),
    account: {
      displayName: user.displayName, legalName: user.legalName, fursonaName: user.fursonaName, email: user.email,
      telegramId: user.telegramId, telegramUsername: user.telegramUsername, role: user.role, createdAt: user.createdAt,
    },
    registrations: regs.map((r) => ({
      event: r.event.title, eventStartsAt: r.event.startsAt, code: r.code, status: r.status, ticket: r.tierName,
      legalName: r.legalName, fursonaName: r.fursonaName, email: r.email, answers: r.answers, rsvp: r.rsvp,
      badgeTier: r.badgeTier, checkedInAt: r.checkedInAt, registeredAt: r.createdAt, termsAcceptedAt: r.tosAcceptedAt,
      payments: r.payments.map(pay),
    })),
    merchPreorders: orders.map((o) => ({
      event: o.event.title, status: o.status, pickedUpAt: o.pickedUpAt, orderedAt: o.createdAt,
      items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.unitPriceCents / 100 })),
      payments: o.payments.map(pay),
    })),
  };
}

/// "Delete my account". Payment records have to be kept for bookkeeping, so
/// rather than deleting rows this strips everything that identifies the
/// person: names, email, Telegram, answers. The account can't be signed into
/// again (no email, no Telegram, sessions revoked).
///
/// Refused while they still have a live ticket or pre-order for an event
/// that hasn't ended. Cancelling first keeps refunds and seats straight.
/// Staff accounts are refused too, so an owner can't lock everyone out.
export async function deleteAccount(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AccountError('Account not found.');
  if (user.role !== 'USER') throw new AccountError('Staff accounts have to be removed by another owner.');

  const now = new Date();
  const live = await prisma.registration.findMany({
    where: { userId, status: { not: 'CANCELLED' }, event: { endsAt: { gt: now } } },
    include: { event: true },
  });
  if (live.length) {
    throw new AccountError(`Cancel your ticket${live.length === 1 ? '' : 's'} first: ${[...new Set(live.map((r) => r.event.title))].join(', ')}.`);
  }
  const orders = await prisma.merchOrder.count({
    where: { userId, OR: [{ status: 'PENDING' }, { status: 'PAID', pickedUpAt: null, event: { endsAt: { gt: now } } }] },
  });
  if (orders) throw new AccountError('You have a pre-order waiting. Pick it up or ask the organizers to refund it first.');

  await prisma.$transaction(async (tx) => {
    for (const reg of await tx.registration.findMany({ where: { userId }, select: { id: true } })) {
      await tx.registration.update({
        where: { id: reg.id },
        data: { legalName: 'Deleted user', fursonaName: '', email: null, answers: {}, cancelRequestNote: null },
      });
    }
    if (user.telegramId) {
      await tx.loginCode.deleteMany({ where: { telegramId: user.telegramId } });
      await tx.botSession.deleteMany({ where: { telegramId: user.telegramId } });
    }
    if (user.email) await tx.emailLoginCode.deleteMany({ where: { emailIndex: blindIndex(user.email) } });
    await tx.user.update({
      where: { id: userId },
      data: {
        displayName: 'Deleted user', legalName: null, fursonaName: null, email: null,
        telegramId: null, telegramUsername: null, telegramPhotoUrl: null, passwordHash: null,
        tokenVersion: { increment: 1 },
      },
    });
  });

  if (user.telegramId) {
    await fs.unlink(path.join(process.cwd(), 'uploads', `tg-${user.telegramId}.webp`)).catch(() => {});
  }
  await audit(null, 'user.self_delete', userId, {});
}
