// Brings the database up to the current schema on every container start (see
// docker-entrypoint.sh). Safe to re-run: every step is a no-op once applied.
//
// PawPass v1 never had a migration history; every instance was created and
// kept in sync with `prisma db push`. v2 introduced prisma/migrations, with
// 0001_v1_baseline describing the final v1 schema exactly. So before handing
// off to `prisma migrate deploy`, this works out which of three states the
// database is in:
//
//   empty                 -> deploy runs every migration from scratch.
//   has _prisma_migrations -> already adopted; deploy applies anything new.
//   v1, pushed            -> first sync it to the frozen v1 schema (in case it
//                            was pushed from an older v1 commit), mark the
//                            baseline as applied, then deploy runs 0002+,
//                            which converts the v1 data into the v2 shape.
//
// A database someone already `db push`ed with a newer schema (local dev) is
// detected by the tables later migrations create (MARKERS) and adopted
// without re-running them.

import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

const BASELINE = '0001_v1_baseline';
/// Each later migration and a table (or table + column) it creates — how a
/// `db push`ed dev database reveals which migrations its schema already includes.
const MARKERS = [
  ['0002_v2_ticket_tiers_stripe', 'TicketTier'],
  ['0003_payments_addons', 'DiscountCode'],
  ['0004_cancel_policy', 'Event', 'cancelPolicy'],
];

const prisma = new PrismaClient();
const prismaCli = (...args) => execFileSync('npx', ['prisma', ...args], { stdio: 'inherit' });

async function tableExists(name) {
  const [row] = await prisma.$queryRaw`SELECT to_regclass(${`public."${name}"`}) IS NOT NULL AS "exists"`;
  return row.exists;
}

async function columnExists(table, column) {
  const [row] = await prisma.$queryRaw`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}) AS "exists"`;
  return row.exists;
}

async function probe() {
  try {
    const pushed = [];
    for (const [migration, table, column] of MARKERS) {
      if (column ? await columnExists(table, column) : await tableExists(table)) pushed.push(migration);
    }
    return {
      adopted: await tableExists('_prisma_migrations'),
      hasData: await tableExists('Event'),
      pushed,
    };
  } catch (e) {
    // P1003: the database itself doesn't exist yet — `migrate deploy` creates it.
    if (e.errorCode === 'P1003' || /does not exist/.test(e.message)) return { adopted: false, hasData: false, pushed: [] };
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const { adopted, hasData, pushed } = await probe();

  if (!adopted && hasData) {
    if (pushed.length) {
      console.log('Found a v2 database created by `prisma db push` — adopting it into the migration history.');
      prismaCli('migrate', 'resolve', '--applied', BASELINE);
      for (const migration of pushed) prismaCli('migrate', 'resolve', '--applied', migration);
    } else {
      console.log('Found a v1 database with no migration history — syncing it to the final v1 schema, then upgrading to v2.');
      // No --accept-data-loss: if an older v1 database somehow can't reach the
      // final v1 shape without dropping data, stop here instead of guessing.
      prismaCli('db', 'push', '--schema', 'prisma/legacy/v1.prisma', '--skip-generate');
      prismaCli('migrate', 'resolve', '--applied', BASELINE);
    }
  }

  console.log('Applying migrations…');
  prismaCli('migrate', 'deploy');
}

main().catch(async (e) => {
  console.error('Database migration failed:', e.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
