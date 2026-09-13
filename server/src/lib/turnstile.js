import { env } from './env.js';

export async function verifyTurnstile(token, remoteIp) {
  if (!env.turnstile.enabled) return true;
  if (!token) return false;
  const params = new URLSearchParams({ secret: env.turnstile.secretKey, response: token });
  if (remoteIp) params.set('remoteip', remoteIp);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: params });
    const data = await res.json();
    return Boolean(data.success);
  } catch (e) {
    console.error('turnstile verify failed', e.message);
    return false;
  }
}
