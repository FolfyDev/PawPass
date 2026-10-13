import { prisma } from './db.js';

/// Everything an operator might want to rebrand without touching code.
export const DEFAULT_SETTINGS = {
  orgName: 'PawPass',
  tagline: 'Registration for community events',
  supportEmail: '',
  supportTelegram: '',
  accentColor: '#FF5B04',
  inkColor: '#0E1116',
  logoUrl: '',
  useLightBanner: false,
  logoUrlLight: '',
  askFursonaName: true,
  fursonaNameLabel: 'Fursona name',
  legalNameLabel: 'Preferred name',
  legalNameHelp: 'Must match the photo ID you bring to check-in.',
  ticketFooter: 'Show this code at the door.',
  welcomeMessage: 'Welcome! Pick an event below to register.',
  botWelcome: 'Hi! I can get you registered in about thirty seconds. Send /register to start.',
};

const KNOWN = Object.keys(DEFAULT_SETTINGS);

/// Only the keys in DEFAULT_SETTINGS — this is served publicly at
/// /api/settings, so anything else stored in the table (internal keys like
/// the encryption check, or junk from an old import) never leaks out.
export async function getSettings() {
  const rows = await prisma.setting.findMany({ where: { key: { in: KNOWN } } });
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

/// Unknown keys are ignored, same reason as above.
export async function setSettings(patch) {
  await prisma.$transaction(
    Object.entries(patch).filter(([key]) => KNOWN.includes(key)).map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
  return getSettings();
}
