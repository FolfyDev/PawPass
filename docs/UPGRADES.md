# Upgrade runbook (shipping changes to a live instance)

Use this any time you deploy new code to a PawPass instance that already has
real data in it — a bug fix, a new feature, a schema change, all the same.

Avoid deploying while check-in is actively running at an event. A few
seconds of downtime during a deploy is normally fine; doing it mid-rush at
the door is not.

## Step 1 — back up

Two layers, both worth doing — they cover different failure modes.

**App-level (fast, portable, covers the data you'd actually need to recover
a botched upgrade):**

Admin → **Backup** (owner only) downloads a zip of every row PawPass manages
plus the `uploads` folder. Equivalent via API:

```bash
curl -b "pawpass_session=<your session cookie>" \
  https://reg.yourdomain.com/api/admin/backup -o pawpass-backup-$(date +%F).zip
```

This does **not** include `.env` or `./certs` — back those up separately,
they rarely change but you'll want them if the box itself is lost:

```bash
cp .env .env.backup-$(date +%F)
cp -r certs certs.backup-$(date +%F)
```

**Infra-level (covers the app-level backup itself being wrong, or a restore
bug):**

```bash
docker compose exec -T db pg_dump -U pawpass pawpass > backup-$(date +%F).sql
```

Copy both off the box (S3, rsync elsewhere) — a backup that lives only on
the same disk as the database doesn't protect against disk failure.

## Step 2 — get the new code

```bash
git pull                      # or merge/checkout the branch you're shipping
```

Read the diff for `server/prisma/schema.prisma` specifically — if it
changed, treat this as a schema-changing upgrade (see the callout below).

## Step 3 — rebuild and restart

```bash
docker compose build
docker compose up -d
```

You do **not** need a separate migration step. `server`'s
[docker-entrypoint.sh](../server/docker-entrypoint.sh) runs
[scripts/migrate.js](../server/scripts/migrate.js) on every container start,
which applies any new migration in `server/prisma/migrations/` with `prisma
migrate deploy`. Already-applied migrations are skipped, so a restart with no
schema change does nothing.

## Step 4 — verify

```bash
docker compose ps                    # server and web both "healthy"
docker compose logs --tail=50 server # no errors since restart
```

Then, in the browser: sign in as staff, and specifically exercise whatever
you just changed. Don't just confirm the app loads — a page rendering is not
the same as the feature working.

## If something's wrong

**Code is broken, data is fine** — roll back the code and restart:

```bash
git checkout <previous-commit-or-tag>
docker compose build
docker compose up -d
```

Careful if a migration ran between the two commits: rolling the code back
does **not** roll the schema back, and older code may not run against the
newer schema. In particular, v2 code cannot be rolled back to v1 that way —
the v2 migration drops the v1 donation columns. If the schema changed,
restore the Step 1 backup instead:

```bash
docker compose exec -T db psql -U pawpass -d pawpass < backup-<date>.sql
```

**Data is wrong (bad migration, botched restore, accidental deletion)** —
restore from Step 1: either the `pg_dump` above, or Admin → **Restore** with
the app-level zip (owner only; this replaces every row PawPass manages, so
it's the same weight as the `psql` restore, just friendlier).

Never run `prisma db push --force-reset` or `npm run db:reset` against a
production database — both wipe every table on purpose. They exist for
local development only.

## Database versions

The schema is versioned in `server/prisma/migrations/`, one folder per change:

| Migration | What it is |
|---|---|
| `0001_v1_baseline` | The final PawPass v1 schema, exactly. |
| `0002_v2_ticket_tiers_stripe` | v2: configurable ticket tiers synced to Stripe, a `Payment` ledger, and seat holds during checkout. Converts v1 data in place (below). |
| `0003_payments_addons` | Donation add-on, discount codes, tier sale windows, Stripe fees, merch pre-orders. Additive only; no data conversion. |
| `0004_cancel_policy` | Per-event cancellation policy for paid tickets (auto-refund or request), and pending cancellation requests. Additive only; existing events start on "request". |
| `0005_reminders_group_tickets` | Reminder timestamps and "buy for friends" (a ticket can point at the buyer's registration). Additive only. |
| `0006_event_emails` | Automatic "know before you go" and thank-you messages per event. Additive only; both start off. |

v1 instances never had a migration history — they were kept in sync with
`prisma db push`. The first time a v2 container starts against one,
`scripts/migrate.js` notices (tables exist, no `_prisma_migrations`), syncs it
to the frozen v1 schema in `prisma/legacy/v1.prisma` in case it was pushed
from an older v1 commit, marks `0001` as applied, then runs `0002`. You'll see
"Found a v1 database with no migration history" in the server log once; after
that it's ordinary `migrate deploy`.

### What the v1 → v2 upgrade does to your data

* Every event gets an **Attendee** tier (free, on sale) standing in for v1's
  free option — unless it was a "require payment" event nobody registered on
  for free.
* Every event that had a PayPal donation tier gets that tier carried over
  under its v1 name, **not on sale and at $0**. v1 never knew what people paid
  through PayPal, so set a real price on the **Tickets** tab and tick
  "On sale" to sell it again (through Stripe, or at the door).
* **An event that required payment has no ticket on sale after the upgrade,
  so registration is closed until you do that.** Check those events first.
* Registrations keep their tier (and badges keep printing the same tier name);
  voucher redemptions have no tier, as in v2.
* Every payment staff recorded (method, amount, note) becomes a paid
  `Payment` row, in cents.

Old backup zips (version 1) still restore: Admin → Restore converts them the
same way before loading them.

### Adding the next migration

1. Edit `server/prisma/schema.prisma`.
2. With a scratch Postgres database for Prisma's shadow DB, generate the SQL:
   `SHADOW_DATABASE_URL=postgresql://…/pawpass_shadow npm run db:diff`
3. Save it as `server/prisma/migrations/0003_<name>/migration.sql`. If data has
   to move, edit it into create → copy → drop order like `0002` does.
4. If a backed-up model changed shape, bump `BACKUP_VERSION` in
   `server/src/lib/backup.js` and add the matching upgrade step there.

Never edit a migration that has already shipped, and never edit
`prisma/legacy/v1.prisma`.

## Stripe

If `ENCRYPTION_KEY` doesn't match the key the database was written with, the
server now refuses to start and says so, instead of failing on every read.

Optional. Without `STRIPE_SECRET_KEY`, paid tiers are paid at the door (staff
record it at the kiosk or in the attendee editor) and nothing talks to Stripe.

To turn it on:

1. Set `STRIPE_SECRET_KEY` in `.env` (a restricted key needs write access to
   Products, Prices, and Checkout Sessions).
2. In the Stripe dashboard → Developers → Webhooks, add an endpoint at
   `${PUBLIC_URL}/api/stripe/webhook` for `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, and
   `charge.refunded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Restart, then on each event's **Tickets** tab press **Resync with Stripe**
   to push existing paid tiers.

Card details only ever go to Stripe's hosted checkout page; PawPass stores
Stripe's IDs and the payment status, nothing else. Refunds are issued from the
Stripe dashboard; a full refund cancels the ticket here automatically.

For local testing, `stripe listen --forward-to localhost:4000/api/stripe/webhook`
prints a webhook secret to use instead.
