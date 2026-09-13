import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const bool = (v) => v === 'true' || v === '1';

export const env = {
  port: Number(process.env.SERVER_PORT || 4000),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:4000',
  webUrl: process.env.WEB_URL || 'http://localhost:8080',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  encryptionKey: process.env.ENCRYPTION_KEY || 'insecure-dev-encryption-key-change-me',
  devAuth: bool(process.env.DEV_AUTH),
  loginCodeTtlMinutes: Number(process.env.LOGIN_CODE_TTL_MINUTES || 10),
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/New_York',
  legal: {
    entityName: process.env.LEGAL_ENTITY_NAME || '',
    contactEmail: process.env.LEGAL_CONTACT_EMAIL || '',
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    username: process.env.TELEGRAM_BOT_USERNAME || '',
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  },
  owner: {
    email: process.env.OWNER_EMAIL || '',
    password: process.env.OWNER_PASSWORD || '',
    telegramId: process.env.OWNER_TELEGRAM_ID || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@example.com',
    secure: bool(process.env.SMTP_SECURE),
    enabled: Boolean(process.env.SMTP_HOST),
  },
  zebra: {
    host: process.env.ZEBRA_HOST || '',
    port: Number(process.env.ZEBRA_PORT || 9100),
    dpi: Number(process.env.ZEBRA_DPI || 300),
      mode: process.env.ZEBRA_PRINT_MODE === 'browser' ? 'browser' : 'network',
  },
  apple: {
    passTypeId: process.env.APPLE_PASS_TYPE_ID || '',
    teamId: process.env.APPLE_TEAM_ID || '',
    wwdr: process.env.APPLE_WWDR_CERT || '',
    signerCert: process.env.APPLE_SIGNER_CERT || '',
    signerKey: process.env.APPLE_SIGNER_KEY || '',
    passphrase: process.env.APPLE_SIGNER_KEY_PASSPHRASE || '',
    get enabled() {
      return Boolean(this.passTypeId && this.teamId && this.signerCert);
    },
  },
  google: {
    issuerId: process.env.GOOGLE_ISSUER_ID || '',
    serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    get enabled() {
      return Boolean(this.issuerId && this.serviceAccount);
    },
  },
    turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    secretKey: process.env.TURNSTILE_SECRET_KEY || '',
    get enabled() {
      return Boolean(this.siteKey && this.secretKey);
    },
  },
};
