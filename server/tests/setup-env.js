// Loaded before every test file (`--import` in package.json's test scripts),
// ahead of src/lib/env.js. dotenv never overrides a variable that's already
// set, so these win over whatever the developer's own .env says.
//
// Without this the suite behaves differently on every machine: an https
// PUBLIC_URL made every signed-in request fail, and a configured SMTP_HOST or
// bot token meant a test run could email or message real people. Tests that
// need Stripe set env.stripe themselves (see payments.test.js).
Object.assign(process.env, {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:4000',
  WEB_URL: 'http://localhost:8080',
  DEV_AUTH: '',
  SMTP_HOST: '',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_BOT_USERNAME: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  TURNSTILE_SITE_KEY: '',
  TURNSTILE_SECRET_KEY: '',
});
