# Running the test suite

Server only — `web/` has no test suite; `npm run build` there is the closest
thing to a check (confirms the production bundle compiles).

## One-time setup

The suite calls `resetDb()` between tests, which deletes every row in every
table, so it refuses to run unless `DATABASE_URL` points at a database with
`test` in its name. Create one against the same Postgres the dev stack uses:

```bash
docker compose exec -T db psql -U pawpass -d pawpass -c "CREATE DATABASE pawpass_test;"
```

Safe to skip if it already exists (the command just errors, harmlessly).

## Running it

```bash
cd server
DATABASE_URL="postgresql://pawpass:pawpass@127.0.0.1:5432/pawpass_test" npm test
```

Use the same `POSTGRES_USER`/`PASSWORD`/`DB` your `.env` actually has if you
changed them from the defaults.

* **Use `127.0.0.1`, not `localhost`.** On at least this Windows/Docker
  Desktop setup, Prisma fails to connect via `localhost` (`P1001: Can't reach
  database server`) but connects fine via `127.0.0.1`. If you hit that error,
  swap the host in the URL before assuming the DB is actually down.
* `pretest` runs `prisma db push --skip-generate --accept-data-loss` against
  `DATABASE_URL` automatically — this is why it must be the test database and
  nothing else.
* Load tests only: `npm run test:load`.

## What a clean run looks like

33 tests, and as of this writing **5 pre-existing failures that are not
regressions** — don't chase these unless you're specifically fixing them:

| Test | File | Why it fails |
|---|---|---|
| `admin can list, create, and delete bans` | [bans.test.js:69](../server/tests/bans.test.js#L69) | Test creates an `ADMIN`-role staffer, but [admin.js:544](../server/src/routes/admin.js#L544) requires `requireOwner`. Route and test disagree on who should manage bans — needs a product decision, not a code fix. |
| `rejects a ban with no identifying field` | [bans.test.js:88](../server/tests/bans.test.js#L88) | Same cause as above. |
| `requests and redeems an email sign-in code` | [auth.test.js:95](../server/tests/auth.test.js#L95) | `loginLimiter`'s in-memory counter isn't reset between tests. Earlier tests in the same file exhaust its 10-request/15-min budget, so later ones get `429` instead of their expected status. |
| `requesting an email code for an unknown address does not reveal that` | [auth.test.js:111](../server/tests/auth.test.js#L111) | Same cause. |
| `rejects an email code for the wrong address` | [auth.test.js:118](../server/tests/auth.test.js#L118) | Same cause. |

If you see a **different** set of failures, or more than 5, something you
changed broke something — bisect from there. If you see fewer, someone fixed
one of the above (update this table).

## Manual smoke test (nothing here is covered by the automated suite)

Run through this before trusting a build with a real event:

1. Register through the web form (`/e/<slug>`) and through the bot
   (`/register` → `/accept`) — both should reach `/mytickets`.
2. Sign in all three ways: bot login code, Telegram Login Widget (needs
   https + `/setdomain`), staff password.
3. Check in a registration by scanning its QR, then by typing its code
   manually.
4. Print one label to the actual printer on the actual stock you'll use —
   darkness/speed vary by stock, especially clear.
5. If Apple/Google Wallet are configured, add a pass on a real phone.
6. Admin → Backup, then Admin → Restore that same file into a scratch
   instance — the day you actually need restore is the wrong day to discover
   it's broken.
