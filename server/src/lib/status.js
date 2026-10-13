import net from 'net';
import { env } from './env.js';
import { getStripe } from './stripe.js';
import { verifySmtp } from './mailer.js';
import { botStatus } from './botStatus.js';

/// The settings page's connection status card: each outside service as
/// 'ok', 'off' (not set up in .env) or 'error', with a line saying why.
/// Run on demand, each check capped at a few seconds.

const TIMEOUT = 8000;
const within = (p, ms = TIMEOUT) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('No answer in time.')), ms))]);

async function stripe() {
  const client = getStripe();
  if (!client) return { state: 'off', detail: 'No STRIPE_SECRET_KEY. Paid tickets are paid at the door.' };
  try {
    // Products are what PawPass writes, so the key has to reach them anyway.
    await within(client.products.list({ limit: 1 }));
  } catch (e) {
    return { state: 'error', detail: `Stripe refused the key: ${e.message}` };
  }
  if (!env.stripe.webhookSecret) return { state: 'error', detail: 'The key works, but STRIPE_WEBHOOK_SECRET is missing, so paid tickets never confirm.' };
  return { state: 'ok', detail: 'API key works and a webhook secret is set.' };
}

async function email() {
  if (!env.smtp.enabled) return { state: 'off', detail: 'No SMTP_HOST. Confirmations and sign-in codes by email are off.' };
  try {
    await within(verifySmtp());
    return { state: 'ok', detail: `Signed in to ${env.smtp.host}:${env.smtp.port}. Sending as ${env.smtp.from}.` };
  } catch (e) {
    return { state: 'error', detail: e.message };
  }
}

function telegram() {
  if (!env.telegram.enabled) return { state: 'off', detail: 'No TELEGRAM_BOT_TOKEN. Telegram sign-in and the bot are off.' };
  const s = botStatus();
  if (s.state === 'running') return { state: 'ok', detail: `@${s.username} is running.` };
  if (s.state === 'starting') return { state: 'error', detail: 'The bot is still connecting to Telegram.' };
  const conflict = /409|terminated by other getUpdates/i.test(s.error || '');
  return {
    state: 'error',
    detail: conflict
      ? 'Stopped: another server is using the same bot token. Only one can run the bot; stop the other one or give it its own bot, then restart this server.'
      : `Stopped${s.error ? `: ${s.error}` : ''}. Restart the server to try again.`,
  };
}

async function turnstile() {
  if (!env.turnstile.enabled) return { state: 'off', detail: 'No Turnstile keys. Forms have no bot check.' };
  try {
    // A dummy answer: Turnstile rejects it either way, but says whether the secret itself is valid.
    const params = new URLSearchParams({ secret: env.turnstile.secretKey, response: 'status-check' });
    const res = await within(fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: params }));
    const codes = (await res.json())['error-codes'] || [];
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret'))
      return { state: 'error', detail: 'Cloudflare says TURNSTILE_SECRET_KEY is not valid.' };
    return { state: 'ok', detail: 'Cloudflare accepts the secret key.' };
  } catch (e) {
    return { state: 'error', detail: `Couldn't reach Cloudflare: ${e.message}` };
  }
}

export function printerReachable(host = env.zebra.host, port = env.zebra.port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 4000 });
    socket.once('connect', () => { socket.end(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('No answer in time.')); });
    socket.once('error', reject);
  });
}

async function printer() {
  if (env.zebra.mode === 'browser') return { state: 'off', detail: 'Badges print from the browser (ZEBRA_PRINT_MODE=browser).' };
  if (!env.zebra.host) return { state: 'off', detail: 'No printer address. Set one under Badge printer.' };
  try {
    await printerReachable();
    return { state: 'ok', detail: `${env.zebra.host}:${env.zebra.port} accepts connections.` };
  } catch (e) {
    return { state: 'error', detail: `Can't reach ${env.zebra.host}:${env.zebra.port}: ${e.message}` };
  }
}

export async function connectionStatus() {
  const checks = [['stripe', 'Stripe', stripe], ['email', 'Email', email], ['telegram', 'Telegram bot', telegram], ['turnstile', 'Turnstile', turnstile], ['printer', 'Badge printer', printer]];
  const results = await Promise.all(checks.map(async ([key, label, check]) => {
    try { return { key, label, ...(await check()) }; } catch (e) { return { key, label, state: 'error', detail: e.message }; }
  }));
  return { checkedAt: new Date(), services: results };
}
