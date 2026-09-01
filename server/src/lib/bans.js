import { prisma } from './db.js';

const norm = (s) => (s || '').trim();
const normHandle = (s) => norm(s).replace(/^@/, '');

/// Finds a ban matching any of the given identifiers — legal name and email
/// compare case-insensitively (same convention as findOrCreateHeadlessUser's
/// duplicate check), Telegram username tolerates a leading "@". At least one
/// non-empty identifier is required; called with none of them matches nothing.
export async function findMatchingBan({ legalName, email, telegramId, telegramUsername }) {
  const or = [];
  if (norm(legalName)) or.push({ legalName: { equals: norm(legalName), mode: 'insensitive' } });
  if (norm(email)) or.push({ email: { equals: norm(email), mode: 'insensitive' } });
  if (norm(telegramId)) or.push({ telegramId: norm(telegramId) });
  if (normHandle(telegramUsername)) or.push({ telegramUsername: { equals: normHandle(telegramUsername), mode: 'insensitive' } });
  if (!or.length) return null;
  return prisma.ban.findFirst({ where: { OR: or } });
}
