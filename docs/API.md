# API reference

Session is a `pawpass_session` httpOnly cookie. Send `credentials: 'include'`.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` | Branding, wording, which wallet backends are live |
| GET | `/api/events` | Published events |
| GET | `/api/events/:slug` | Event, terms, custom fields, ticket `tiers` on sale, your registration if any |
| POST | `/api/events/:slug/register` | `{ legalName, fursonaName, email, answers, ticketTierId, voucherCode, discountCode, donationCents, friends: [{ name, contact }], acceptedTos }`. A paid tier with Stripe configured returns `status: PENDING_PAYMENT` and a `checkoutUrl` to redirect to |
| POST | `/api/events/:slug/discount` | `{ code, ticketTierId }` — preview the discounted price without using the code |
| POST | `/api/events/:slug/merch/orders` | Signed in, confirmed attendee. `{ items: [{ itemId, quantity }] }` → `checkoutUrl` |
| GET | `/api/events/:slug/volunteer` | Volunteer `info` and upcoming `shifts` with open slots (counts only). 404 unless the event has volunteering on |
| POST | `/api/events/:slug/volunteer/:shiftId` | Signed in. `{ note }`. Refuses full, started, and overlapping shifts |
| GET | `/api/events/:slug/hotels` | Hotels and their active blocks, your live room requests, and a `guestName` to prefill. Booking link and group code are `null` (and `locked: true`) on ticket-holders-only blocks unless you have a confirmed ticket. 404 unless the event has hotels on |
| POST | `/api/events/:slug/room-blocks/:blockId/reservations` | Signed in. `{ checkIn, checkOut, guests, guestName, roommates, note }` — dates are `YYYY-MM-DD`, check-out exclusive. Organizer-managed blocks only; one live room per person per event; closes at the cutoff |
| POST | `/api/stripe/webhook` | Stripe only — signature-verified against `STRIPE_WEBHOOK_SECRET` |
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
| POST | `/api/auth/password` | `{ email, password }`. With two-factor on, returns `{ twoFactor: true, challenge }` instead of a session |
| POST | `/api/auth/password/2fa` | `{ challenge, code }` — a 6-digit code (each works once) or a recovery code. Challenges last 5 minutes |
| POST | `/api/auth/2fa/setup` · `/api/auth/2fa/enable` | Staff with a password. Setup returns `{ secret, otpauthUrl, qr }`; enable takes `{ code }` and returns the recovery codes, once |
| POST | `/api/auth/2fa/disable` · `/api/auth/2fa/recovery-codes` | `{ code }` — a current or recovery code |
| GET | `/api/auth/me` · POST `/api/auth/logout` | |

## Attendee

| Method | Path |
|---|---|
| GET | `/api/my/tickets` |
| GET | `/api/my/tickets/:code/qr.png` |
| GET | `/api/my/tickets/:code/apple.pkpass` |
| GET | `/api/my/tickets/:code/google` |
| POST | `/api/my/tickets/:code/cancel` — `{ note }`. Follows the event's cancel policy; returns `outcome`: `cancelled`, `refunded`, `requested` |
| POST | `/api/my/tickets/:code/pay` — `{ url }` of a Stripe Checkout for a ticket awaiting payment |
| POST | `/api/my/payments/sync` — `{ sessionId }` from the Stripe success redirect; settles it from Stripe |
| GET | `/api/my/merch-orders` · POST `/api/my/merch-orders/:id/pay` |
| GET | `/api/my/tickets/:code/receipt` · `/api/my/merch-orders/:id/receipt` (printable HTML) |
| GET | `/api/my/data` (JSON download of everything held about you) |
| POST | `/api/my/account/delete`: `{ confirm: 'DELETE' }`. Anonymises the account; refused while upcoming tickets or volunteer shifts are live |
| GET | `/api/my/volunteer-shifts` |
| DELETE | `/api/my/volunteer-shifts/:id` — drop a shift; refused once it has started |
| GET | `/api/my/room-reservations` |
| POST | `/api/my/room-reservations/:id/cancel` — refused after the block's cutoff or once the stay has begun (`canCancel`) |

## Admin — requires ADMIN or OWNER

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/admin/events` | |
| GET/PATCH/DELETE | `/api/admin/events/:id` | |
| GET | `/api/admin/events/:id/registrations` | `?q=` `?status=` |
| GET | `/api/admin/events/:id/registrations.csv` | |
| GET | `/api/admin/events/:id/tiers` | Every tier, with seats taken and Stripe sync state |
| POST | `/api/admin/events/:id/tiers` | **Owner only.** `{ name, price, currency, capacity, description, active }` — price in dollars |
| PATCH/DELETE | `/api/admin/tiers/:id` | **Owner only.** Delete refuses a tier anyone registered on |
| POST | `/api/admin/events/:id/tiers/sync` | **Owner only.** Re-push every tier to Stripe |
| POST | `/api/admin/registrations` | Walk-up registration. `{ ..., ticketTierId, payment: { method, amount, note } }` |
| PATCH | `/api/admin/registrations/:code` | |
| POST | `/api/admin/registrations/:code/payments` | Record an in-person payment `{ method, amount, note }` |
| DELETE | `/api/admin/payments/:id` | Remove a mistaken in-person payment (not Stripe ones) |
| POST | `/api/admin/registrations/:code/cancel-request` | **Owner only.** `{ approve }` — approve refunds and cancels |
| POST | `/api/admin/payments/:id/refund` | **Owner only.** `{ amount }` (dollars; omit for all of it). Stripe payments refund to the card |
| GET/POST | `/api/admin/events/:id/discounts` | Discount codes. POST is **owner only**: `{ code, percentOff \| amountOff, maxUses, tierIds, expiresAt }` |
| PATCH/DELETE | `/api/admin/discounts/:id` | **Owner only** |
| POST | `/api/admin/merch-orders/:id/pickup` | `{ pickedUp }` |
| POST | `/api/admin/events/:id/merch-orders/notify-ready` | Tell paid, uncollected pre-order buyers it's ready |
| GET | `/api/admin/registrations/:code/receipt` · `/api/admin/merch-orders/:id/receipt` | Printable receipts |
| GET | `/api/admin/events/:id/reconciliation` | Totals by method: tickets, in-person donations, merch |
| GET | `/api/admin/events/:id/volunteers` | Shifts with their rosters, plus hours per volunteer |
| GET | `/api/admin/events/:id/volunteers.csv` | One row per sign-up |
| POST | `/api/admin/events/:id/shifts` | **Owner only.** `{ role, startsAt, endsAt, slots, location, description }` — times are wall-clock in the event's timezone |
| PATCH/DELETE | `/api/admin/shifts/:id` | **Owner only.** Slots can't go below sign-ups; delete refuses a shift anyone is on |
| POST | `/api/admin/shifts/:id/signups` | `{ who }` — a ticket code or `@telegram` username. Messages them on Telegram |
| PATCH | `/api/admin/volunteer-signups/:id` | `{ attendance }`: `PENDING`, `PRESENT`, `NO_SHOW` |
| DELETE | `/api/admin/volunteer-signups/:id` | Frees the slot and messages them on Telegram |
| GET | `/api/admin/events/:id/hotels` | Hotels → blocks with per-night inventory, pickup totals (`contracted`, `pickedUp`, `pickupPercent`, `required`, `shortfall`), and room requests |
| POST | `/api/admin/events/:id/hotels` | **Owner only.** `{ name, address, url, phone, description }` |
| PATCH/DELETE | `/api/admin/hotels/:id` | **Owner only.** Delete refuses a hotel with live room requests |
| POST | `/api/admin/hotels/:id/blocks` | **Owner only.** `{ name, rate, mode: HOTEL_BOOKED \| ORGANIZER_MANAGED, bookingUrl, groupCode, cutoffAt, maxGuests, attritionPercent, attendeesOnly, active, staffNotes, nights? }` — rate in dollars |
| PATCH/DELETE | `/api/admin/room-blocks/:id` | **Owner only.** Delete refuses a block with live room requests |
| PUT | `/api/admin/room-blocks/:id/nights` | **Owner only.** `{ nights: [{ night, contracted, reportedPickup }] }` replaces the inventory; can't go below rooms already requested |
| GET | `/api/admin/room-blocks/:id/rooming-list.csv` | Live rooms, for sending to the hotel |
| POST | `/api/admin/room-blocks/:id/reservations` | `{ who, checkIn, checkOut, guests, guestName, roommates, staffNote }` — `who` is a ticket code or `@telegram`. Skips the one-room limit and the cutoff, not inventory |
| PATCH | `/api/admin/room-reservations/:id` | `{ confirmationNumber, checkIn, checkOut, guests, guestName, roommates, staffNote, status }` — a confirmation number confirms it and notifies them |
| POST | `/api/admin/room-reservations/:id/cancel` | Releases the nights and notifies them |
| POST | `/api/admin/checkin` | `{ value, eventId, direction: ENTRY \| EXIT, force }` — `value` is a ticket URL, a secret, or a typed code. A refused scan is 409 with `code` (`already_inside`, `wrong_day`, `at_capacity`, `not_inside`, `cancelled`, `waitlist`, `unpaid`, `wrong_event`); `force` overrides the first three |
| POST | `/api/admin/checkin/:code/undo` | Takes back the ticket's latest scan |
| GET | `/api/admin/events/:id/checkin-manifest` | The offline scanner's copy: each ticket's status, day pass and scans; QR secrets only as SHA-256 hashes |
| POST | `/api/admin/events/:id/checkin/sync` | `{ scans: [{ clientId, code, direction, at, force }] }` — offline scans, recorded at their own time and at most once per `clientId`; ones the rules now refuse are recorded and `flagged` |
| GET | `/api/admin/events/:id/attendance` | `today` (`inside`, `entered`, `limit`) and arrivals per day |
| GET | `/api/admin/events/:id/arrivals` | `?since=` — each ticket's first entry today, numbered, for the lobby display |
| GET | `/api/admin/users` | No `q` returns staff only |
| POST | `/api/admin/users/:id/role` | **Owner only.** `{ role }` |
| POST | `/api/admin/users/:id/2fa/reset` | **Owner only.** Turns off someone's two-factor (lost phone) and signs them out everywhere |
| GET/POST | `/api/admin/campaigns` | |
| POST | `/api/admin/campaigns/:id/send` | `{ dryRun }` to count first |
| GET/PUT | `/api/admin/settings` | |
| GET/PUT | `/api/admin/retention` | **Owner only.** `{ months }`: 3, 6, 12, 24, or null (off). Returns the events that are `due` under it |
| POST | `/api/admin/retention/run` | **Owner only.** Clears everything due now |
| POST | `/api/admin/events/:id/purge` | **Owner only.** `{ confirm: <event title> }` — clears one finished event's personal data now |
| GET | `/api/admin/audit` | |

## Schedule & panel submissions

Owners turn each on per event (`scheduleEnabled`, `submissionsOpen`, `submissionsCloseAt`, `submissionInfo` on PATCH `/api/admin/events/:id`). Admins build the schedule and review submissions.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/events/:slug/schedule` | Published sessions with a time, rooms, days, and the viewer's `starred` session IDs |
| PUT/DELETE | `/api/my/stars/:sessionId` | Signed in |
| GET | `/api/events/:slug/submissions` | Whether it's `accepting`, the guidelines, and the viewer's own submissions |
| POST | `/api/events/:slug/submissions` | Signed in. `{ title, description, hosts, lengthMinutes, availability, notes }` |
| PATCH | `/api/my/submissions/:id` · POST `/api/my/submissions/:id/withdraw` | While it's still waiting on a decision |
| GET | `/api/admin/events/:id/schedule` | Everything, drafts and unscheduled included, with star counts |
| GET | `/api/admin/events/:id/schedule.csv` | |
| POST | `/api/admin/events/:id/rooms` · PATCH/DELETE `/api/admin/rooms/:id` | Deleting a room leaves its sessions without one |
| POST | `/api/admin/events/:id/sessions` · PATCH/DELETE `/api/admin/sessions/:id` | `{ title, hosts, track, roomId, startsAt, endsAt, description, published }` — times in the event's timezone; both or neither; a room can't be double-booked |
| GET | `/api/admin/events/:id/submissions` | `?status=` |
| PATCH | `/api/admin/submissions/:id` | `{ reviewNote }` (staff only) |
| POST | `/api/admin/submissions/:id/decision` | `{ decision: ACCEPTED \| DECLINED, message }` — accepting creates an unscheduled draft session; the submitter is told |

## Dealers' den & artist alley

Owners set table types and fees and open applications (`vendorsOpen`, `vendorsCloseAt`, `vendorInfo` on PATCH `/api/admin/events/:id`). Admins review, assign table numbers, and record payments.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/events/:slug/vendors` | Whether it's `accepting`, guidelines, active table types, `payOnline`, and the viewer's applications |
| POST | `/api/events/:slug/vendors` | Signed in. `{ area: DEALERS_DEN \| ARTIST_ALLEY, tableTypeId, businessName, description, portfolioUrls, assistants, notes }` — one live application per area |
| GET | `/api/my/vendor-applications` | |
| PATCH | `/api/my/vendor-applications/:id` · POST `.../withdraw` | While waiting on a decision |
| POST | `/api/my/vendor-applications/:id/pay` | `{ url }` of a Stripe Checkout for the table fee |
| GET | `/api/admin/events/:id/vendors` · `/api/admin/events/:id/vendors.csv` | Table types with how many are given out, and every application |
| POST | `/api/admin/events/:id/vendor-tables` · PATCH/DELETE `/api/admin/vendor-tables/:id` | **Owner only.** `{ area, name, price, quantity, description, active }` — price in dollars |
| POST | `/api/admin/vendor-applications/:id/decision` | `{ decision: ACCEPTED \| WAITLISTED \| DECLINED, tableTypeId, message }` — accepting takes a table (never past `quantity`) and fixes the fee; free tables are confirmed at once |
| PATCH | `/api/admin/vendor-applications/:id` | `{ tableNumber, reviewNote }` |
| POST | `/api/admin/vendor-applications/:id/payments` | `{ method, amount, note }` — confirms the table once the fee is covered |
| POST | `/api/admin/vendor-applications/:id/cancel` | `{ message }` — releases the table and closes any open checkout; refund paid fees separately |

## Incidents — requires ADMIN or OWNER

Owners see every report; an admin only sees reports they filed (any other ID is a 404).
Details, outcome, people, and notes are encrypted at rest.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/incidents` | `?eventId=` `?status=OPEN\|RESOLVED` `?q=` (searches summaries only) |
| POST | `/api/admin/incidents` | `{ eventId, occurredAt, location, category, severity, summary, details, people: [{ role, registrationCode, name, contact }] }` |
| GET/PATCH | `/api/admin/incidents/:id` | Only owners can set `status` or `resolution`; the filer can edit while it's open |
| DELETE | `/api/admin/incidents/:id` | **Owner only.** Bans made from it stay |
| POST | `/api/admin/incidents/:id/notes` | `{ body }` |
| POST | `/api/admin/incidents/:id/people` | `{ role: SUBJECT \| REPORTER \| WITNESS, registrationCode, name, contact }` |
| DELETE | `/api/admin/incidents/:id/people/:personId` | **Owner only** |
| POST | `/api/admin/incidents/:id/people/:personId/ban` | **Owner only.** `{ reason }` — bans by their ticket's identity, linked to the report |

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
