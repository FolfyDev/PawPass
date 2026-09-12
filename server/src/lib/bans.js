import { prisma } from './db.js';

// NFKC folds visually-identical Unicode variants (e.g. a combining accent vs
// its precomposed character) to the same form, and collapsing internal
// whitespace closes the "Jane  Doe" double-space bypass — both are cheap for
// a banned person to hit by accident, let alone deliberately, if matching
// only trims.
export const norm = (s) => (s || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
export const normHandle = (s) => norm(s).replace(/^@/, '');

export async function findMatchingBan({ legalName, email, telegramId, telegramUsername }) {
  const or = [];
  if (norm(legalName)) or.push({ legalName: { equals: norm(legalName), mode: 'insensitive' } });
  if (norm(email)) or.push({ email: { equals: norm(email), mode: 'insensitive' } });
  if (norm(telegramId)) or.push({ telegramId: norm(telegramId) });
  if (normHandle(telegramUsername)) or.push({ telegramUsername: { equals: normHandle(telegramUsername), mode: 'insensitive' } });
  if (!or.length) return null;
  return prisma.ban.findFirst({ where: { OR: or } });
}
