import bcrypt from 'bcryptjs';
import { prisma } from '../../src/lib/db.js';
import { blindIndex } from '../../src/lib/crypto.js';

// Every test file imports this module before touching the app, so this is
// the one place to flag "we're in the test suite" — the registration rate
// limiter checks it to let the concurrency/load tests fire bursts of
// requests no real attendee ever would.
process.env.NODE_ENV = 'test';

function assertTestDatabase() {
  const url = process.env.DATABASE_URL || '';
  let dbName = '';
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    dbName = '';
  }
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run: DATABASE_URL points at "${dbName || '(unknown)'}", which does not look like a test database. `
      + 'This suite calls resetDb(), which deletes every row in every table. '
      + 'Point DATABASE_URL at a database with "test" in its name, e.g.: '
      + 'DATABASE_URL=postgresql://pawpass:pawpass@localhost:5432/pawpass_test npm test',
    );
  }
}

assertTestDatabase();

const CLEAR_ORDER = [
  'auditLog',
  'ban',
  'sale',
  'donation',
  'stripeEvent',
  'payment',
  'registration',
  'ticketTier',
  'merchItem',
  'voucherCode',
  'emailCampaign',
  'loginCode',
  'emailLoginCode',
  'botSession',
  'event',
  'badgeTemplate',
  'user',
  'setting',
];

export async function resetDb() {
  await prisma.$transaction(CLEAR_ORDER.map((model) => prisma[model].deleteMany({})));
}

export async function closeDb() {
  await prisma.$disconnect();
}

let seq = 0;
const next = () => ++seq;

/// Every event needs at least one active ticket tier to accept
/// registrations; by default it gets one free "Attendee" tier, same as a v1
/// event after the v2 migration. Pass `tiers` to replace it ([] for none).
/// The created tiers come back on `event.ticketTiers`, in the order given.
export async function createEvent(overrides = {}, { tiers = [{ name: 'Attendee' }] } = {}) {
  const n = next();
  const now = new Date();
  const event = await prisma.event.create({
    data: {
      slug: `test-event-${n}-${Date.now()}`,
      title: `Test Event ${n}`,
      startsAt: new Date(now.getTime() + 3600_000),
      endsAt: new Date(now.getTime() + 7200_000),
      published: true,
      ...overrides,
    },
  });
  event.ticketTiers = [];
  for (const [i, t] of tiers.entries()) {
    event.ticketTiers.push(await prisma.ticketTier.create({ data: { eventId: event.id, sortOrder: i, ...t } }));
  }
  return event;
}

export function createUser(overrides = {}) {
  const n = next();
  return prisma.user.create({
    data: {
      displayName: `Test User ${n}`,
      ...overrides,
    },
  });
}

export async function createStaff({ role = 'ADMIN', password = 'staff-password-123', ...overrides } = {}) {
  const n = next();
  const user = await prisma.user.create({
    data: {
      displayName: `Staff ${n}`,
      email: `staff${n}-${Date.now()}@test.pawpass`,
      passwordHash: bcrypt.hashSync(password, 4),
      role,
      ...overrides,
    },
  });
  return { user, password };
}

export function createVoucher(eventId, overrides = {}) {
  const n = next();
  return prisma.voucherCode.create({
    data: {
      eventId,
      code: `TESTVOUCHER${n}`,
      badgeTier: 'Organizer',
      maxUses: 1,
      ...overrides,
    },
  });
}

export function createBan(overrides = {}) {
  return prisma.ban.create({ data: { reason: 'test ban', ...overrides } });
}

export function createLoginCode(overrides = {}) {
  const n = next();
  return prisma.loginCode.create({
    data: {
      code: `TEST${n}CODE`,
      telegramId: `tg-${n}`,
      ...overrides,
    },
  });
}

export function nextEmail() {
  return `attendee${next()}-${Date.now()}@test.pawpass`;
}

export function createEmailLoginCode(email, overrides = {}) {
  const n = next();
  return prisma.emailLoginCode.create({
    data: {
      code: `TEST${n}MAIL`,
      emailIndex: blindIndex(email),
      ...overrides,
    },
  });
}
