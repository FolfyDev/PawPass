# Deployment runbook (first-time, production)

For local/offline testing, use the [README](../README.md) instead — this
runbook assumes a real domain and a real event.

## 1. Prerequisites

* A host with Docker + Docker Compose (a 2GB VPS is plenty — DigitalOcean,
  Hetzner, Lightsail, etc.)
* A domain or subdomain you control, e.g. `reg.yourdomain.com`
* A Telegram bot token from [@BotFather](https://t.me/botfather)

## 2. Get the code and generate secrets

```bash
git clone <your fork> pawpass && cd pawpass
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # run twice
```

Use the two generated values for `JWT_SECRET` and `ENCRYPTION_KEY` in `.env`.
Don't reuse one value for both. **Write `ENCRYPTION_KEY` down somewhere
outside this server** (password manager, offline note) — it's the only thing
that decrypts stored legal names/emails, it's not in the database, and losing
it makes that data permanently unreadable.

## 3. Fill in `.env` for production

At minimum:

| Variable | Production value |
|---|---|
| `PUBLIC_URL` | `https://reg.yourdomain.com` (must be https, must match the real domain) |
| `WEB_URL` | same origin as `PUBLIC_URL` unless API and front end are split |
| `JWT_SECRET` / `ENCRYPTION_KEY` | the two generated values above |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` | from BotFather |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | a real password — this seeds the first owner account on boot |
| `DEV_AUTH` | `false` (it self-disables off plain-http-localhost anyway, but be explicit) |

The server **refuses to start** if `JWT_SECRET`/`ENCRYPTION_KEY` are left at
their placeholder defaults or under 32 characters, unless `PUBLIC_URL` looks
like local dev — so a misconfigured prod deploy fails loudly at boot instead
of running insecurely.

## 4. Put HTTPS in front of it

Only the `web` container (port 8080) needs to be reachable from the internet;
`server` and `db` are already bound to `127.0.0.1` in
[docker-compose.yml](../docker-compose.yml).

**Option A — Cloudflare Tunnel** (no inbound ports to manage):

```bash
cloudflared tunnel login
cloudflared tunnel create pawpass
cp cloudflared/config.example.yml cloudflared/config.yml   # fill in hostname + credentials path
cloudflared tunnel route dns pawpass reg.yourdomain.com
```

Run `cloudflared` as a systemd service pointed at `http://localhost:8080`.

**Option B — Caddy reverse proxy** (automatic Let's Encrypt):

```
reg.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Either way, once traffic reaches `reg.yourdomain.com` over https, come back
and register that exact hostname with BotFather — this only enables the blue
in-Telegram "Log in with Telegram" button; the bot itself and the `/login`
code flow both work without it.

```
/setdomain  →  pick your bot  →  https://reg.yourdomain.com
```

Send the origin only — no path, no port, no `http://`. It rejects
`localhost`/IPs/http silently, and the domain must match exactly (registering
`yourdomain.com` does not authorise `reg.yourdomain.com`). If BotFather
doesn't respond at all, send `/cancel` first — you're probably mid-conversation
in another command.

## 5. First boot

```bash
docker compose up -d --build
docker compose ps        # both server and web should show "healthy" within ~30s
```

On first boot the server creates its tables, seeds the default badge
template, and creates the owner account from `OWNER_EMAIL`/`OWNER_PASSWORD`.
Watch it happen:

```bash
docker compose logs -f server
```

You're looking for `Seeded owner account: ...` and `API on :4000` with no
errors above them.

If `docker compose ps` shows a container `unhealthy` and staying that way —
plain Docker Compose does **not** auto-restart on a failed healthcheck by
itself, it just reports the status. Read the logs to see why, fix it, and
`docker compose up -d` again. (If you want actual auto-restart-on-unhealthy,
add a watchdog sidecar like `willfarrell/autoheal` — not included by
default.)

## 6. Post-boot checklist

1. Visit `https://reg.yourdomain.com/healthz` via the API host, or just load
   the front end — confirm it renders.
2. Sign in at `/login` → **Staff with a password?** using `OWNER_EMAIL` /
   `OWNER_PASSWORD`.
3. Go to **Account** and change the password immediately, then link your
   Telegram so you have both doors in.
4. If you use Zebra printing, Apple/Google Wallet, or SMTP — fill in those
   `.env` vars now and `docker compose up -d` again to pick them up.
5. Run the manual smoke test in [TESTING.md](TESTING.md) end to end,
   including one label printed on the real printer/stock.
6. Take a first backup (see [UPGRADES.md](UPGRADES.md#step-1--back-up)) so
   you have a known-good baseline before real registrations start landing.

## If it doesn't come up

Check, in order: `docker compose logs server` for the actual crash reason,
`.env` for a typo in `DATABASE_URL`-adjacent vars (`POSTGRES_USER/PASSWORD/DB`
must match between the `db` and `server` service definitions — they do by
default via the same `.env`), and that the domain in `PUBLIC_URL`/`WEB_URL`
actually resolves to this host over https before blaming the app.
