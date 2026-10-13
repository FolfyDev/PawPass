import crypto from 'node:crypto';

/// Time-based one-time passwords (RFC 6238, the 6-digit codes in Google
/// Authenticator, 1Password, Aegis, ...). SHA-1, 30-second steps, 6 digits:
/// the defaults every authenticator app assumes when it scans the QR.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const n = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/// Checks a code against the current step and one either side (phone
/// clocks drift). Returns the step it matched so the caller can refuse it
/// next time — a code works once, even inside its 30 seconds.
export function verifyCode(secret, code, { lastStep = null, now = Date.now() } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return s;
  }
  return null;
}

export const otpauthUrl = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

/// One-time recovery codes for a lost phone, like "K7QF-2MXP". Only their
/// hashes are stored.
export function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

export const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z2-7]/g, '')).digest('hex');
