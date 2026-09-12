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

You do **not** need a separate `prisma db push` step. `server`'s
[docker-entrypoint.sh](../server/docker-entrypoint.sh) already runs schema
sync automatically on every container start — `prisma migrate deploy` if a
`prisma/migrations/` directory exists, otherwise `prisma db push
--skip-generate`. Today this repo has no migrations directory, so every
restart re-syncs the schema via `db push`, which is exactly why Step 1
matters: `db push` can silently drop a column or table on a destructive
schema change, with no migration history to roll back through.

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

Careful if the schema changed between the two commits: rolling the code back
does **not** roll the schema back, and the entrypoint's `db push` on restart
will resync to whatever `schema.prisma` says in the commit you just checked
out — which may itself drop columns the newer code had added. If the schema
changed, restore the Step 1 backup instead of trusting `db push` to reverse
it:

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

## A note on migrations

The entrypoint already prefers real migrations the moment a
`prisma/migrations/` directory exists — nothing else needs to change to
switch over. That gives rollback history for schema changes, at the cost of
needing the *first* migration to be baselined carefully against a database
that already has data in it (getting that wrong is the kind of mistake that
goes badly). Worth doing before your next real schema change; not done as
part of this runbook.
