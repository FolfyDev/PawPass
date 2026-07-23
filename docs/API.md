# API reference

Session is a `pawpass_session` httpOnly cookie. Send `credentials: 'include'`.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` | Branding, wording, which wallet backends are live |
| GET | `/api/events` | Published events |
| GET | `/api/events/:slug` | Event, terms, custom fields, your registration if any |
| POST | `/api/events/:slug/register` | `{ legalName, fursonaName, email, answers, acceptedTos }` |
| GET | `/t/:secret` | The URL inside every QR — human-readable landing page |

## Auth

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/config` | Whether Telegram sign-in is available |
| POST | `/api/auth/telegram` | Login Widget payload; hash verified server-side |
| POST | `/api/auth/telegram-code` | `{ code }` from the bot's `/login` — works over plain http |
| POST | `/api/auth/dev` | `{ name, role }` — local development only, 404 otherwise |
| POST | `/api/auth/password` | Staff only — attendee rows have no hash |
| POST | `/api/auth/link-telegram` | Attach Telegram to the signed-in account |
| POST | `/api/auth/set-password` | Staff only |
| GET | `/api/auth/me` · POST `/api/auth/logout` | |

## Attendee

| Method | Path |
|---|---|
| GET | `/api/my/tickets` |
| GET | `/api/my/tickets/:code/qr.png` |
| GET | `/api/my/tickets/:code/apple.pkpass` |
| GET | `/api/my/tickets/:code/google` |
| POST | `/api/my/tickets/:code/cancel` |

## Admin — requires ADMIN or OWNER

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/admin/events` | |
| GET/PATCH/DELETE | `/api/admin/events/:id` | |
| GET | `/api/admin/events/:id/registrations` | `?q=` `?status=` |
| GET | `/api/admin/events/:id/registrations.csv` | |
| POST | `/api/admin/registrations` | Walk-up registration |
| PATCH | `/api/admin/registrations/:code` | |
| POST | `/api/admin/checkin` | `{ value }` — a ticket URL, a secret, or a typed code |
| POST | `/api/admin/checkin/:code/undo` | |
| GET | `/api/admin/users` | No `q` returns staff only |
| POST | `/api/admin/users/:id/role` | **Owner only.** `{ role }` |
| GET/POST | `/api/admin/campaigns` | |
| POST | `/api/admin/campaigns/:id/send` | `{ dryRun }` to count first |
| GET/PUT | `/api/admin/settings` | |
| GET | `/api/admin/audit` | |

## Badges — requires ADMIN or OWNER

| Method | Path | Notes |
|---|---|---|
| GET | `/api/badges/tokens` | Token list with sample values |
| GET/POST | `/api/badges/templates` | |
| PATCH/DELETE | `/api/badges/templates/:id` | |
| POST | `/api/badges/templates/:id/duplicate` | |
| POST | `/api/badges/preview.svg` | Renders an unsaved template |
| GET | `/api/badges/registration/:code.png` · `.svg` · `.zpl` | |
| POST | `/api/badges/print` | `{ value \| code, copies, darkness, speed, printerHost }` |
| POST | `/api/badges/print-batch` | `{ eventId, onlyUnprinted, onlyCheckedIn }` |
| GET | `/api/badges/printer` | Configured printer address and dpi |
