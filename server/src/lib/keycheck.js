import { prisma } from './db.js';
import { encryptField, decryptField } from './crypto.js';

/// Setting key holding a value encrypted with ENCRYPTION_KEY. Not part of
/// DEFAULT_SETTINGS, so it's never served publicly or overwritten by an import.
const CHECK_KEY = '__encryption_check';
const CHECK_TEXT = 'pawpass-encryption-check';

export class EncryptionKeyError extends Error {}

/// Makes sure ENCRYPTION_KEY is the key the database was written with,
/// before anything tries (and fails) to read encrypted names and emails.
/// With the wrong key, every such read throws "unable to authenticate data"
/// — far better to stop at startup with an explanation.
///
/// The first run on an existing database has no check value yet, so it tries
/// one real encrypted field instead; if that decrypts (or there's nothing
/// encrypted yet), the check value is written for next time.
export async function verifyEncryptionKey() {
  const row = await prisma.setting.findUnique({ where: { key: CHECK_KEY } });
  if (row) {
    let ok = false;
    try { ok = decryptField(row.value) === CHECK_TEXT; } catch { ok = false; }
    if (!ok) throw new EncryptionKeyError(mismatchMessage());
    return;
  }

  // Raw query: the Prisma extension would decrypt (and throw) on its own.
  const [sample] = await prisma.$queryRaw`SELECT "email" FROM "User" WHERE "email" LIKE 'v1:%' LIMIT 1`;
  if (sample) {
    try { decryptField(sample.email); } catch { throw new EncryptionKeyError(mismatchMessage()); }
  }
  await prisma.setting.create({ data: { key: CHECK_KEY, value: encryptField(CHECK_TEXT) } });
}

function mismatchMessage() {
  return 'Refusing to start: ENCRYPTION_KEY does not match the key this database was encrypted with. ' +
    'Put the original key back in .env. If the data is disposable test data, wipe the database instead ' +
    '(docker compose down -v). Changing the key does not re-encrypt existing data.';
}
