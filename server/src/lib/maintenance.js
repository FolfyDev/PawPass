import { getSettings } from './settings.js';

/// Maintenance mode (settings page): the public site stays up and readable,
/// but nobody new can sign up for anything. Staff are unaffected, and so is
/// anything that undoes a commitment (cancel, withdraw, delete account).

const DEFAULT_MESSAGE = 'Registration is paused for maintenance. Please check back soon.';

/// The message to show while maintenance mode is on, otherwise null.
export async function maintenanceMessage() {
  const s = await getSettings();
  return s.maintenanceMode ? (String(s.maintenanceMessage || '').trim() || DEFAULT_MESSAGE) : null;
}

const isStaff = (user) => !!user && (user.role === 'ADMIN' || user.role === 'OWNER');

/// Public requests (paths relative to /api) that start something new or pay
/// for it. Registrations and merch orders are also refused inside
/// createRegistration / createMerchOrder, which covers the bot.
const BLOCKED = [
  /^\/events\/[^/]+\/(register|volunteer|room-blocks|merch|submissions|vendors)(\/|$)/,
  /^\/my\/.+\/(pay|transfer)$/,
];

export async function maintenanceGuard(req, res, next) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD' || isStaff(req.user)) return next();
    if (!BLOCKED.some((re) => re.test(req.path))) return next();
    const message = await maintenanceMessage();
    if (message) return res.status(503).json({ error: message, maintenance: true });
    next();
  } catch (e) { next(e); }
}
