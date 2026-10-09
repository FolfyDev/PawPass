// Resets the owner login to OWNER_EMAIL / OWNER_PASSWORD from .env.
//
//   docker compose exec server node scripts/reset-owner.js
//
// Those .env values are otherwise only used once, to create the first owner,
// so changing them later does nothing. This rewrites the email (re-encrypted
// and re-indexed with the current ENCRYPTION_KEY, which is what password
// sign-in looks it up by) and the password hash on the existing owner, or
// creates one if there is none. Other sessions for that account are signed out.

import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { blindIndex } from '../src/lib/crypto.js';

async function main() {
  const email = env.owner.email?.trim().toLowerCase();
  const password = env.owner.password;
  if (!email || !password) throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD in .env first.');
  if (password.length < 10) throw new Error('OWNER_PASSWORD must be at least 10 characters.');

  // Only non-encrypted columns are selected, so this works even if the stored
  // email was written with a different ENCRYPTION_KEY.
  const byEmail = await prisma.user.findUnique({ where: { emailIndex: blindIndex(email) }, select: { id: true } });
  const owner = byEmail || await prisma.user.findFirst({ where: { role: 'OWNER' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const passwordHash = await bcrypt.hash(password, 12);

  if (owner) {
    await prisma.user.update({
      where: { id: owner.id },
      data: { email, passwordHash, role: 'OWNER', tokenVersion: { increment: 1 } },
      select: { id: true },
    });
    console.log(`Owner login reset. Sign in at ${env.webUrl}/staff with ${email} and the OWNER_PASSWORD from .env.`);
  } else {
    await prisma.user.create({ data: { email, passwordHash, displayName: 'Owner', role: 'OWNER' }, select: { id: true } });
    console.log(`No owner existed, so one was created. Sign in at ${env.webUrl}/staff with ${email}.`);
  }
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
