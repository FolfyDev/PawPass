# PawPass

Free-ticket event registration for community events. Attendees sign in with
Telegram, register on the web or entirely inside a chat, and get a QR ticket
they can drop into Apple or Google Wallet. Staff scan those QRs to check people
in and print badges straight to a Zebra ZD500.

No payments, no ticket pricing, no Stripe keys. Every ticket is free.

* **Attendee side** — browse events, register, accept the terms, keep the ticket in your wallet app
* **Telegram bot** — `/register` walks through the whole thing and finishes with `/accept`
* **Admin side** — schedule events, scan to check in, design badges, print, mass email, grant admin access
* **Docker + Postgres** — `docker compose up` and you have a working instance

---

## Quick start

```bash
git clone <your fork> pawpass && cd pawpass
cp .env.example .env
# at minimum set: JWT_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, OWNER_EMAIL, OWNER_PASSWORD
docker compose up -d
```

Front end on `http://localhost:8080`, API on `http://localhost:4000`.

On first boot the server creates the tables, seeds the default badge template,
and creates the owner account. If you are recovering from an earlier install
that started with an empty database, either reset the volume with
`docker compose down -v && docker compose up -d`, or push the schema into the
running container:

```bash
docker compose exec server npx prisma db push
docker compose restart server
```

Sign in at `/login` → **Staff with a password?** using `OWNER_EMAIL` /
`OWNER_PASSWORD`, then go to **Account** and link your Telegram so you can use
either door from then on.

### Telegram setup

1. Message [@BotFather](https://t.me/botfather) → `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`
2. Put the bot's username (no `@`) in `TELEGRAM_BOT_USERNAME`
3. Optional, production only: `/setdomain` to enable the blue Login Widget button — see below

The bot itself works immediately with just the token. It uses long polling, so
it needs no domain, no webhook, and no certificate.

---

## Testing locally without a domain or SSL

You do not need to expose anything to the internet. There are three ways in and
the sign-in page shows whichever ones are available:

**1. A code from the bot** — the recommended local path, and fine in production
too. Message your bot, send `/login`, and it replies with a one-time code like
`K4M2-9XQ7`. Enter it on `/login` under **Code from the bot**. This is plain
HTTP-friendly, needs no registered domain, and authenticates you as your real
Telegram account, so the whole attendee flow behaves exactly as it will live.
Codes are single-use and expire after `LOGIN_CODE_TTL_MINUTES`.

**2. Dev sign-in** — set `DEV_AUTH=true` and a **Dev** tab appears where you can
mint a throwaway account with any role in one click. Useful for exercising the
admin side before you have a bot at all. The endpoint refuses to respond unless
`PUBLIC_URL` is plain `http` on a loopback host, so turning this on
accidentally in production does nothing.

**3. Staff password** — the seeded owner from `OWNER_EMAIL` / `OWNER_PASSWORD`
works locally with no Telegram involvement.

Registration through the bot — `/register` through `/accept` — works fully
offline. So does check-in, badge rendering, and printing.

One thing that genuinely needs https: **the camera in the check-in scanner.**
Browsers only grant camera access on https or on `localhost`, so a phone
pointed at your laptop's LAN address will be refused by the browser, not by
this app. Test the scanner on the machine itself, or put a tunnel in front of
it. The manual "type a badge code" box next to the scanner works everywhere and
takes the same path through the code.

### Why the Login Widget cannot work locally

The blue "Log in with Telegram" button is served by Telegram, and Telegram will
only render it on a domain you have registered against your bot. It requires a
real public hostname over https; `localhost`, an IP address, and any http URL
are all rejected. That is a Telegram restriction, not something this app can
work around. The code flow exists precisely so you are not blocked by it.

If you do want to test the widget itself before deploying, put a tunnel in
front of the dev server (`cloudflared tunnel --url http://localhost:8080` or
ngrok), set `WEB_URL` and `PUBLIC_URL` to the https tunnel hostname, restart,
and register that hostname with `/setdomain`.

### When /setdomain "does nothing"

BotFather's `/setdomain` is a three-step conversation, and it fails silently at
several points:

1. Send `/setdomain` **in a direct message to @BotFather**, not in any group
2. It replies with a keyboard of your bots — **pick the bot**. If you have one bot it may skip this
3. Only then send the domain

What it silently rejects:

* `localhost`, `127.0.0.1`, or any IP address
* anything with a port, e.g. `https://example.com:8080`
* `http://` URLs — https only
* a path, e.g. `https://example.com/login` — send the origin only

Send it as `https://reg.example.com` and nothing else on the line. The domain
must match where the browser actually loads the page, subdomain included:
registering `example.com` will not authorise `reg.example.com`.

If BotFather still does not answer, send `/cancel` first — you were probably
mid-conversation in another command, which makes it ignore the new one.

---

## How access works

| | Sign-in | Granted by |
|---|---|---|
| Attendee | Telegram only | Automatic on first sign-in |
| Admin | Telegram **or** email + password | An owner elevates them |
| Owner | Telegram **or** email + password | Seeded from `.env`, or another owner |

Attendee accounts have no password hash at all, so there is no second door into
them. An admin's Telegram and password identities are the same row in the
database — linking is done from **Account**, and either method lands in the same
session.

To grant access: the person signs in with Telegram once, then an owner opens
**Admin → Staff**, searches for them, and clicks **Make admin**. Removing access
is the same screen. Owners cannot change their own role, so an instance can
never end up with zero owners.

---

## Registering

### On the web

`/e/<slug>` collects the legal name, the fursona name, an optional email, and
any extra questions the organiser added. Submitting opens the event's terms in a
sheet — registration only happens when the attendee accepts inside that sheet,
and the accepted text is fingerprinted onto the record.

### In Telegram

```
/register        pick an event
                 → full legal name
                 → fursona name        (/skip to reuse the legal name)
                 → email               (/skip)
                 → each extra question the organiser configured
                 → the event's terms, in full
/accept          agree and finish — the code comes straight back
/mytickets       codes and status
/cancel          stop at any point
```

The bot and the web form share one code path, so capacity, waitlists,
registration windows, and duplicate checks behave identically.

---

## Badges

The default template is a **clear rectangular label** applied to a pre-printed
hard badge. It carries exactly three things:

* the fursona name, set large and left-aligned
* the registration number underneath it, in mono
* a QR of that same registration number, square, on the left

Everything else — the event name, colour bands, artwork — belongs on the hard
badge you print in advance. The label only adds what changes per person.

Default stock is **2.25 × 1.25 in** (57.15 × 31.75 mm). The designer has a
stock dropdown for the other common Zebra dies (3 × 1, 3 × 2, 4 × 2, 4 × 1), or
type any width and height.

### Clear stock means black only

On clear labels the printer lays ink where the design is dark and leaves the
stock transparent everywhere else, so whatever is printed on the hard badge
shows through. The template therefore uses a white background and pure black
elements. **Adding coloured fills will print as muddy grey blocks that hide the
badge underneath** — keep it black on white unless you switch to opaque stock.

### Long names

Names are measured, not estimated: the renderer rasterises the string, measures
the actual glyph width, and scales the type down until it sits inside its
column with a safety margin. A name too long even at the minimum legible size
is truncated with an ellipsis. Nothing runs off the die. Turn this off per
element by unchecking **Shrink long names to fit**.

### What the QR encodes

The label QR contains the bare registration number, e.g. `K4M2-9XQ7`. That is
what you asked for and it keeps the code readable by any scanner, but it is
worth knowing that a badge code is guessable in a way that a wallet QR is not —
the wallet pass encodes a long random secret instead. Both resolve at check-in.
If you would rather the label carry the unguessable form, change the QR
element's value to `{{qr_payload}}` in the designer.

### Elements and tokens

Element types: `text`, `qr`, `rect`, `line`, `image`.

Tokens work in any text element, QR payload, or fill colour:

```
{{fursona_name}}  {{legal_name}}   {{code}}       {{event_title}}
{{event_dates}}   {{venue}}        {{badge_line}} {{qr_payload}}
{{accent}}        {{your_custom_field_key}}
```

Templates are per-event (set one on the event editor) with an instance-wide
default as a fallback.

### Printing to the ZD500

Set `ZEBRA_HOST` and `ZEBRA_DPI` in `.env`. The renderer produces the label at
the printer's native resolution, thresholds it to 1-bit, and sends it as a
`^GFA` raster job to port 9100. Rasterising rather than mapping to native ZPL
commands is what makes arbitrary layouts, fonts, and fitted text work.

* **Scan to print** — Admin → Check in & print, mode "Check in and print". One scan checks the person in and drops their label.
* **Single reprint** — the Print button on any attendee row.
* **Batch** — `POST /api/badges/print-batch` with `{ eventId, onlyUnprinted: true }`.
* **Raw ZPL** — `GET /api/badges/registration/:code.zpl` if you want to pipe it somewhere yourself.

Prints are counted per registration, so a reprint is visible rather than silent.

## Wallet passes

Both are optional; the buttons only appear when the instance is configured.

**Apple** needs a Pass Type ID from your Apple Developer account. Put
`wwdr.pem`, `signerCert.pem`, and `signerKey.pem` in `./certs` and fill in
`APPLE_*`. You also need a pass model directory at
`server/src/wallet/apple-model` containing `icon.png`, `icon@2x.png`, and
`logo.png`.

**Google** needs a Google Wallet issuer ID and a service account key at
`./certs/google-wallet.json`. Fill in `GOOGLE_*`.

Without either, attendees just screenshot the QR — check-in works the same.

---

## Making it yours

The project is built so a fork does not have to touch application logic:

| What | Where |
|---|---|
| Colours, type, spacing, the ticket-stub motif | `web/src/theme.css` — every value is a CSS custom property |
| All user-facing wording | Admin → Settings, stored in the database |
| Badge layouts | Admin → Badge designer, stored as JSON |
| Registration questions | Per event, on the event editor — the bot picks them up automatically |
| Terms text | Per event |
| Infrastructure | `.env` |

Adding a badge element type means one case in `server/src/badges/render.js` and
one entry in `NEW_ELEMENT` in `web/src/pages/admin/Badges.jsx`. Adding a bot step
means one state in `server/src/bot/index.js`.

---

## Layout

```
server/
  prisma/schema.prisma        data model
  src/lib/                    auth, settings, registration rules, mail
  src/routes/                 auth · public · admin · badges
  src/badges/                 template vocabulary, SVG renderer, ZPL encoder
  src/bot/                    Telegram registration flow
  src/wallet/                 Apple + Google pass builders
web/
  src/theme.css               the whole visual system
  src/pages/                  attendee pages
  src/pages/admin/            staff pages
```

## Local development

```bash
# terminal 1
docker compose up db
cd server && npm install && npx prisma db push && npm run dev

# terminal 2
cd web && npm install && npm run dev     # proxies /api to :4000
```

## Before you run this at a real event

* Put it behind HTTPS. Telegram's Login Widget requires it, and so do wallet passes.
* Back up the Postgres volume.
* Test one label end to end on the actual printer, stuck to a real hard badge. Thermal darkness and speed vary by stock, especially on clear — tune with `darkness` and `speed` on the print call.
* Check your die size against the roll. The template ships at 2.25 × 1.25 in; a mismatch shifts every label.
* Decide what your terms actually say. The field is empty on a fresh install for a reason.

## License

MIT.
