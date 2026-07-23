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
  askFursonaName: true,
  fursonaNameLabel: 'Fursona name',
  legalNameLabel: 'Full legal name',
  legalNameHelp: 'Must match the photo ID you bring to check-in.',
  ticketFooter: 'Show this code at the door.',
  welcomeMessage: 'Welcome! Pick an event below to register.',
  botWelcome: 'Hi! I can get you registered in about thirty seconds. Send /register to start.',
};

export async function getSettings() {
  const rows = await prisma.setting.findMany();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch) {
  await prisma.$transaction(
    Object.entries(patch).map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
  return getSettings();
}
