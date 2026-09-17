# PawPass

Self-hosted, free-ticket event registration for community events. Attendees
sign in with an emailed code or Telegram, register on the web or entirely
inside a chat, and get a QR ticket for Apple/Google Wallet. Staff scan those
QRs to check people in and print badges straight to a Zebra ZD500.

No payments, no ticket pricing, no Stripe keys — every ticket is free.

## Features

- **Attendee side** — browse events, register, accept the terms, keep the ticket in your wallet app
- **Telegram bot** — `/register` walks through the whole thing and finishes with `/accept`
- **Admin side** — schedule events, scan to check in, design badges, print, mass email
- **Site-wide bans** — block someone from registering for any event, with attempt logging
- **Analytics** — owner-only dashboard: signups over time, status/channel breakdowns
- **Two staff roles** — Owner (full control) and Admin (day-of operations only)
- **Encrypted at rest** — names, emails, and custom-question answers are encrypted in the database
- **Docker + Postgres** — `docker compose up` and you have a working instance

---

## Quick start

```bash
git clone <your fork> pawpass && cd pawpass
cp .env.example .env
# at minimum set: JWT_SECRET, ENCRYPTION_KEY, TELEGRAM_BOT_TOKEN,
# TELEGRAM_BOT_USERNAME, OWNER_EMAIL, OWNER_PASSWORD
docker compose up -d
```

Front end on `http://localhost:8080`. Only that port needs to be public —
the API and database stay on `127.0.0.1` even in the Docker network.

On first boot the server creates the tables, seeds the default badge
template, and creates the owner account. Sign in at `/login` → **Staff with
a password?** using `OWNER_EMAIL`/`OWNER_PASSWORD`, then link your Telegram
under **Account** so you have both doors in.

Deploying somewhere real? See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for
HTTPS, secrets, and a first-boot checklist.

### Telegram setup

1. Message [@BotFather](https://t.me/botfather) → `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`
2. Put the bot's username (no `@`) in `TELEGRAM_BOT_USERNAME`

The bot works immediately with just the token — long polling, no domain, no
webhook, no certificate needed.

### Testing locally, no domain or SSL required

The `/login` page only shows sign-in methods that are actually configured:

- **Code from the bot** — message your bot, send `/login`, get a one-time
  code. Works over plain HTTP, authenticates as your real Telegram account.
- **Dev sign-in** — set `DEV_AUTH=true` for a one-click throwaway account of
  any role. Only responds when `PUBLIC_URL` is plain http on localhost, so it
  can't accidentally turn on in production.
- **Staff password** — the seeded owner account works with no Telegram involved.

Registration, check-in, badge rendering, and printing all work fully
offline. The one thing that genuinely needs HTTPS is **the check-in
scanner's camera** (a browser restriction, not this app) — test it on the
machine itself, or use the manual code-entry box next to it.

---

## How accounts & access work

| | Signs in with | Notes |
|---|---|---|
| Attendee | Emailed code, or Telegram | No password exists for these accounts at all |
| Admin | Password or Telegram | Day-to-day: check-in, printing, walk-up registration, email. Read-only on events/staff/bans; no access to settings, analytics, audit log, or backup |
| Owner | Password or Telegram | Everything, including granting/revoking staff access |

Sessions expire after **1 day**. Legal names, emails, and custom-question
answers are **encrypted at rest** — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
for generating and safeguarding `ENCRYPTION_KEY`. The emailed-code option only
appears once SMTP is set in `.env`; without it, Telegram is the only way in
for attendees.

To grant staff access: they sign in with Telegram once, then an owner opens
**Admin → Staff**, searches for them, and clicks **Make admin**.

---

## Registering

**On the web** — `/e/<slug>` collects a legal name, fursona name, optional
email, and any extra questions the organizer added, then opens the event's
terms in a sheet. Registration only completes on accept.

**In Telegram:**

```
/register   pick an event → name → fursona name → email → extra questions → terms
/accept     agree and finish — the code comes straight back
/mytickets  codes and status
/cancel     stop at any point
```

The bot and the web form share one code path, so capacity, waitlists, and
duplicate checks behave identically either way.

---

## Badges

The default template is a **clear label** applied to a pre-printed hard
badge: fursona name, registration code, and a QR — black on white only
(clear stock can't print color; it'll show as muddy grey). Names are
auto-shrunk to fit, never overflow.

Templates are edited visually in **Admin → Badge designer**, support custom
elements and `{{tokens}}`, and are per-event with an instance-wide fallback.
Printing goes out as rasterized ZPL to a Zebra ZD500 over the network — set
`ZEBRA_HOST`/`ZEBRA_DPI` in `.env`. Scan-to-print, single reprints, and batch
printing are all in the admin scanner/attendees pages.

## Wallet passes

Apple and Google Wallet are both optional — the buttons only show up once
configured (`APPLE_*`/`GOOGLE_*` in `.env`, certs in `./certs`). Without
either, attendees just screenshot the QR; check-in works the same either way.

---

## Making it yours

| What | Where |
|---|---|
| Colors, type, spacing | `web/src/theme.css` — every value is a CSS custom property |
| All user-facing wording | Admin → Settings |
| Badge layouts | Admin → Badge designer |
| Registration questions & terms | Per event, on the event editor |
| Infrastructure | `.env` |

## Layout

```
server/
  prisma/schema.prisma   data model
  src/lib/                auth, settings, registration rules, encryption, mail
  src/routes/             auth · public · admin · badges
  src/badges/              template vocabulary, SVG renderer, ZPL encoder
  src/bot/                 Telegram registration flow
  src/wallet/              Apple + Google pass builders
web/
  src/theme.css            the whole visual system
  src/pages/               attendee pages
  src/pages/admin/         staff pages
```

## Local development

```bash
# terminal 1
docker compose up db
cd server && npm install && npx prisma db push && npm run dev

# terminal 2
cd web && npm install && npm run dev     # proxies /api to :4000
```

## Further reading

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — first production deploy, HTTPS, secrets
- [docs/TESTING.md](docs/TESTING.md) — running the test suite, manual smoke test
- [docs/API.md](docs/API.md) — full endpoint reference
- [docs/UPGRADES.md](docs/UPGRADES.md) — backing up and deploying to a live instance

## License

MIT.
