import crypto from 'node:crypto';
import { env } from './env.js';

const keyMaterial = Buffer.from(env.encryptionKey, 'utf8');
const encKey = crypto.hkdfSync('sha256', keyMaterial, Buffer.alloc(0), 'pawpass:field-encryption', 32);
const indexKey = crypto.hkdfSync('sha256', keyMaterial, Buffer.alloc(0), 'pawpass:blind-index', 32);

export function encryptField(value) {
  if (value === null || value === undefined) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptField(stored) {
  if (stored === null || stored === undefined) return stored;
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return stored;
  const [, ivB64, ciphertextB64, tagB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

export function blindIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHmac('sha256', indexKey).update(normalized).digest('hex');
}

export function encryptJson(value) {
  if (value === null || value === undefined) return value;
  return encryptField(JSON.stringify(value));
}

export function decryptJson(stored, fallback = {}) {
  if (stored === null || stored === undefined || stored === '') return fallback;
  const decrypted = decryptField(stored);
  try {
    return JSON.parse(decrypted);
  } catch {
    return fallback;
  }
}
