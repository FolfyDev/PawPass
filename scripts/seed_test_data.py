#!/usr/bin/env python3
"""Fill a running PawPass with a fake event, so there's something to click through.

Creates one "[TEST] ..." event with ticket types, ~40 attendees (most paid,
some owing at the door), a voucher and a discount code, volunteer
shifts, hotels with room blocks, a schedule, vendor tables, merch, and an
incident report. With --live the event is happening today and some people
are already checked in, so the scanner and Overview have live numbers.

Everything goes through the app's own API, signed in as the owner from
.env, so validation, encryption, and audit logging all behave exactly like
real use. Nothing touches the database directly.

If DEV_AUTH=true is set (plain http on localhost only), it also creates
attendee accounts "Test Attendee", "Test Panelist", "Test Artist" and
"Test Dealer" that submit panels, apply for vendor tables, star sessions
and request hotel rooms. Sign in as any of them from the Dev tab on /login
(same name, role "User") to see the attendee side.

Fake emails use the reserved .invalid domain, so even with SMTP configured
no real person can ever get one.

    python3 scripts/seed_test_data.py              # event two weeks out
    python3 scripts/seed_test_data.py --live       # event happening now
    python3 scripts/seed_test_data.py --clean      # delete every [TEST] event

Needs Python 3.9+, nothing to install.
"""

import argparse
import datetime as dt
import http.cookiejar
import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TEST_PREFIX = "[TEST]"

FIRST = ["Alex", "Sam", "Jordan", "Robin", "Casey", "Morgan", "Riley", "Jamie", "Taylor", "Avery",
         "Quinn", "Rowan", "Sky", "Drew", "Reese", "Emerson", "Hayden", "Kai", "Logan", "Parker"]
LAST = ["Vale", "Ortiz", "Kim", "Park", "Nguyen", "Okafor", "Lindqvist", "Moreau", "Haddad", "Silva",
        "Brennan", "Novak", "Achebe", "Tanaka", "Rossi", "Kowalski", "Duarte", "Fischer", "Ibrahim", "Walsh"]
FURSONA = ["Kit", "Rue", "Moss", "Fen", "Ember", "Juniper", "Pip", "Sable", "Wren", "Bramble", "Cinder",
           "Tansy", "Echo", "Nimbus", "Pepper", "Quill", "Rook", "Sorrel", "Thistle", "Vesper", "Zephyr",
           "Ash", "Bolt", "Clover", "Dusk", "Flint", "Gale", "Hazel", "Indigo", "Jasper"]
PANELS = ["Fursuit Making 101", "Drawing Paws and Claws", "Writers' Circle", "Intro to Badge Art",
          "Fursuit Games", "Photography Walk", "Character Design Critique", "Music Production Basics",
          "Costume Repair Clinic", "Late Night Storytelling", "Plushie Sewing", "Dance Competition"]


def read_env():
    """KEY=VALUE pairs from the repo's .env, ignoring comments and quotes."""
    values = {}
    path = ROOT / ".env"
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        values[key.strip()] = value
    return values


class ApiError(Exception):
    def __init__(self, status, message, path):
        super().__init__(f"{status} on {path}: {message}")
        self.status = status


class Client:
    """One signed-in person: their own cookie jar, so the owner and each
    test attendee keep separate sessions."""

    def __init__(self, base):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            with self.opener.open(req, timeout=30) as res:
                text = res.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            try:
                message = json.loads(e.read().decode()).get("error", e.reason)
            except Exception:
                message = e.reason
            raise ApiError(e.code, message, path) from None
        except urllib.error.URLError as e:
            sys.exit(f"Can't reach PawPass at {self.base} ({e.reason}). Is it running? Pass --url if it's somewhere else.")

    def get(self, path): return self.call("GET", path)
    def post(self, path, body=None): return self.call("POST", path, body or {})
    def patch(self, path, body): return self.call("PATCH", path, body)
    def put(self, path, body=None): return self.call("PUT", path, body or {})
    def delete(self, path): return self.call("DELETE", path)


def sign_in_owner(client, email, password):
    try:
        res = client.post("/api/auth/password", {"email": email, "password": password})
    except ApiError as e:
        sys.exit(f"Owner sign-in failed ({e}). Check OWNER_EMAIL/OWNER_PASSWORD in .env, or pass --email/--password.")
    if res.get("twoFactor"):
        code = input("Two-factor code for the owner account: ").strip()
        try:
            client.post("/api/auth/password/2fa", {"challenge": res["challenge"], "code": code})
        except ApiError as e:
            sys.exit(f"Two-factor sign-in failed: {e}")
    me = client.get("/api/auth/me")
    if not me or not me.get("user"):
        sys.exit("Signed in, but the session cookie didn't stick. If PUBLIC_URL in .env is https, the cookie is "
                 "https-only: point --url at the https address instead.")
    if me["user"]["role"] != "OWNER":
        sys.exit(f"{email} isn't an owner account.")
    return me["user"]


def step(label):
    print(f"• {label}")


def try_call(label, fn):
    """Runs one optional piece; a failure is reported and the rest carries on."""
    try:
        return fn()
    except ApiError as e:
        print(f"  ! {label}: {e}")
        return None


def clean(owner):
    events = owner.get("/api/admin/events")
    test = [e for e in events if e["title"].startswith(TEST_PREFIX)]
    if not test:
        print("No [TEST] events to delete.")
        return
    for e in test:
        owner.delete(f"/api/admin/events/{e['id']}")
        print(f"Deleted {e['title']}")


def seed(args, base, owner):
    rng = random.Random(args.seed)
    tz = ZoneInfo(args.timezone)
    now = dt.datetime.now(tz)
    today = now.date()
    if args.live:
        start = dt.datetime.combine(today - dt.timedelta(days=1), dt.time(10, 0))
        end = dt.datetime.combine(today + dt.timedelta(days=1), dt.time(22, 0))
    else:
        start = dt.datetime.combine(today + dt.timedelta(days=14), dt.time(10, 0))
        end = dt.datetime.combine(today + dt.timedelta(days=16), dt.time(18, 0))
    days = [start.date() + dt.timedelta(days=i) for i in range((end.date() - start.date()).days + 1)]
    local = lambda d, h, m=0: f"{d:%Y-%m-%d}T{h:02d}:{m:02d}"  # datetime-local, read in the event's timezone
    stamp = now.strftime("%Y%m%d-%H%M%S")

    # ---- event -------------------------------------------------------------
    step("Event")
    event = owner.post("/api/admin/events", {
        "title": f"{TEST_PREFIX} Fuzzy Fest {now:%b %d %H:%M}",
        "slug": f"test-fuzzy-fest-{stamp}",
        "timezone": args.timezone,
        "startsAt": local(start, start.hour), "endsAt": local(end, end.hour),
        "venue": "Riverside Convention Center",
        "tagline": "Fake data for trying things out",
        "description": "This event was made by scripts/seed_test_data.py. Delete it with --clean.",
        "capacity": 200, "published": True,
        "tosBody": "Be excellent to each other. Badges must be visible at all times.",
    })
    eid, slug = event["id"], event["slug"]
    owner.patch(f"/api/admin/events/{eid}", {
        "volunteersEnabled": True, "volunteerInfo": "Check in at the volunteer desk by the main doors 15 minutes before your shift.",
        "hotelsEnabled": True, "hotelInfo": "Book inside the block by the cutoff to get the convention rate.",
        "scheduleEnabled": True,
        "submissionsOpen": True, "submissionInfo": "Panels run 30 to 90 minutes. Tell us what equipment you need.",
        "vendorsOpen": True, "vendorInfo": "Load-in is the morning of day one. Handmade work only in the artist alley.",
        "occupancyLimit": 120,
    })

    # ---- tickets -------------------------------------------------------------
    step("Ticket types, discount code, voucher")
    weekend = owner.post(f"/api/admin/events/{eid}/tiers", {"name": "Weekend", "price": "45", "capacity": 150, "description": "All days"})
    middle = days[len(days) // 2]
    day_pass = owner.post(f"/api/admin/events/{eid}/tiers", {"name": f"{middle:%A} pass", "price": "25", "description": f"{middle:%A} only", "validDays": [f"{middle:%Y-%m-%d}"]})
    sponsor = owner.post(f"/api/admin/events/{eid}/tiers", {"name": "Sponsor", "price": "120", "capacity": 20, "description": "Weekend + sponsor badge ribbon"})
    try_call("discount code", lambda: owner.post(f"/api/admin/events/{eid}/discounts", {"code": "TESTCON20", "percentOff": 20, "maxUses": 50}))
    try_call("voucher", lambda: owner.post(f"/api/admin/events/{eid}/vouchers", {"code": f"STAFF-{stamp[-6:]}", "badgeTier": "Staff", "maxUses": 10}))

    # ---- attendees -------------------------------------------------------------
    step(f"{args.attendees} attendees")
    tiers = [(weekend, 70), (day_pass, 20), (sponsor, 10)]
    people = []
    # Distinct names: the app refuses a second registration under the same
    # legal name for one event (that's its duplicate check working).
    names = rng.sample([f"{f} {l}" for f in FIRST for l in LAST], k=min(args.attendees, len(FIRST) * len(LAST)))
    for i, legal in enumerate(names):
        fur = f"{rng.choice(FURSONA)}{'' if i < len(FURSONA) else i}"
        tier = rng.choices([t for t, _ in tiers], weights=[w for _, w in tiers])[0]
        price = tier["priceCents"] / 100
        body = {"eventId": eid, "legalName": legal, "fursonaName": fur, "email": f"attendee{i}.{stamp}@example.invalid", "ticketTierId": tier["id"]}
        # Most paid at the desk; the rest owe it at the door.
        if rng.random() < 0.7:
            body["payment"] = {"method": rng.choice(["CASH", "CARD"]), "amount": str(price)}
        reg = try_call(f"registration {i}", lambda: owner.post("/api/admin/registrations", body))
        if reg:
            reg["tier"] = tier
            people.append(reg)
    confirmed = [p for p in people if p["status"] == "CONFIRMED"]
    weekenders = [p for p in confirmed if p["tier"]["id"] in (weekend["id"], sponsor["id"])]

    # ---- volunteers ------------------------------------------------------------
    step("Volunteer shifts")
    shift_ids = []
    roles = [("Door crew", "Main entrance", 4), ("Registration desk", "Lobby", 3), ("Merch table", "Hall B", 2), ("Con ops runner", "Ops office", 2)]
    for d in days:
        for hour in (10, 13):
            for role, where, slots in roles:
                s = try_call("shift", lambda: owner.post(f"/api/admin/events/{eid}/shifts", {
                    "role": role, "location": where, "slots": slots,
                    "startsAt": local(d, hour), "endsAt": local(d, hour + 3),
                }))
                if s:
                    shift_ids.append(s)
    # One shift each for some attendees, so nobody double-books themselves.
    helpers = rng.sample(confirmed, k=min(len(confirmed), len(shift_ids)))
    for person, shift in zip(helpers[: len(shift_ids) // 2], rng.sample(shift_ids, k=len(shift_ids) // 2)):
        signup = try_call("volunteer", lambda: owner.post(f"/api/admin/shifts/{shift['id']}/signups", {"who": person["code"]}))
        if signup and args.live and rng.random() < 0.5:
            try_call("attendance", lambda: owner.patch(f"/api/admin/volunteer-signups/{signup['id']}", {"attendance": rng.choice(["PRESENT", "PRESENT", "NO_SHOW"])}))

    # ---- hotels ---------------------------------------------------------------
    step("Hotels and room blocks")
    nights = [f"{d:%Y-%m-%d}" for d in days[:-1]] or [f"{days[0]:%Y-%m-%d}"]
    grand = owner.post(f"/api/admin/events/{eid}/hotels", {"name": "Grand Riverside Hotel", "address": "100 River St", "phone": "(555) 010-2000", "url": "https://example.com", "description": "Connected to the venue by skybridge."})
    owner.post(f"/api/admin/hotels/{grand['id']}/blocks", {
        "name": "Double Queen", "rate": "159", "mode": "HOTEL_BOOKED", "groupCode": "FUZZYFEST", "bookingUrl": "https://example.com/book",
        "attritionPercent": 80, "cutoffAt": local(start.date() - dt.timedelta(days=7), 23, 59),
        "nights": [{"night": n, "contracted": 30, "reportedPickup": rng.randint(12, 27)} for n in nights],
    })
    king = owner.post(f"/api/admin/hotels/{grand['id']}/blocks", {
        "name": "King", "rate": "149", "mode": "ORGANIZER_MANAGED", "maxGuests": 2, "attritionPercent": 80,
        "nights": [{"night": n, "contracted": 8} for n in nights],
    })
    inn = owner.post(f"/api/admin/events/{eid}/hotels", {"name": "Harbor Inn", "address": "22 Dock Ave"})
    owner.post(f"/api/admin/hotels/{inn['id']}/blocks", {
        "name": "Standard", "rate": "119", "mode": "HOTEL_BOOKED", "attendeesOnly": False, "bookingUrl": "https://example.com/inn",
        "nights": [{"night": n, "contracted": 10, "reportedPickup": 10} for n in nights],
    })
    for i, person in enumerate(rng.sample(confirmed, k=min(5, len(confirmed)))):
        room = try_call("room", lambda: owner.post(f"/api/admin/room-blocks/{king['id']}/reservations", {
            "who": person["code"], "checkIn": nights[0], "checkOut": f"{dt.date.fromisoformat(nights[-1]) + dt.timedelta(days=1):%Y-%m-%d}", "guests": 2,
        }))
        if room and i < 2:
            try_call("confirm room", lambda: owner.patch(f"/api/admin/room-reservations/{room['id']}", {"confirmationNumber": f"GR-{rng.randint(10000, 99999)}"}))

    # ---- schedule ---------------------------------------------------------------
    step("Schedule")
    rooms = [owner.post(f"/api/admin/events/{eid}/rooms", {"name": n, "capacity": c})
             for n, c in [("Main Stage", 300), ("Panel Room A", 80), ("Panel Room B", 60), ("Art Room", 40)]]
    sessions = []
    titles = iter(rng.sample(PANELS, k=len(PANELS)) * 3)
    for d in days:
        if d == days[0]:
            sessions.append(owner.post(f"/api/admin/events/{eid}/sessions", {"title": "Opening Ceremonies", "roomId": rooms[0]["id"], "startsAt": local(d, 11), "endsAt": local(d, 12), "published": True, "hosts": "The con chairs"}))
        for hour in (13, 15):
            for room in rooms[1:]:
                s = try_call("session", lambda: owner.post(f"/api/admin/events/{eid}/sessions", {
                    "title": next(titles), "roomId": room["id"], "startsAt": local(d, hour), "endsAt": local(d, hour + 1, 30),
                    "hosts": f"{rng.choice(FURSONA)} & {rng.choice(FURSONA)}", "published": rng.random() < 0.85,
                    "track": rng.choice(["Art", "Craft", "Social", None]),
                    "description": "A fake session made by the seed script.",
                }))
                if s:
                    sessions.append(s)
        sessions.append(owner.post(f"/api/admin/events/{eid}/sessions", {"title": "Dance", "roomId": rooms[0]["id"], "startsAt": local(d, 20), "endsAt": local(d, 23, 30), "published": True, "track": "Social"}))
    owner.post(f"/api/admin/events/{eid}/sessions", {"title": "Fursuit parade (time TBD)", "description": "Unscheduled draft."})

    # ---- vendors, merch -----------------------------------------------------------
    step("Vendor tables and merch")
    full = owner.post(f"/api/admin/events/{eid}/vendor-tables", {"area": "DEALERS_DEN", "name": "Full table", "price": "150", "quantity": 10})
    owner.post(f"/api/admin/events/{eid}/vendor-tables", {"area": "DEALERS_DEN", "name": "Half table", "price": "80", "quantity": 10})
    alley = owner.post(f"/api/admin/events/{eid}/vendor-tables", {"area": "ARTIST_ALLEY", "name": "Alley spot", "price": "0", "quantity": 20})
    for name, price, count in [("Event T-shirt", 25, 60), ("Sticker pack", 5, 200), ("Plush mascot", 35, 25)]:
        item = owner.post(f"/api/admin/events/{eid}/merch", {"name": name, "price": price, "maxCount": count})
        for _ in range(rng.randint(2, 6)):
            try_call("merch sale", lambda: owner.post(f"/api/admin/merch/{item['id']}/sale", {"quantity": rng.randint(1, 2), "paymentMethod": rng.choice(["CASH", "CARD"])}))

    # ---- incident -------------------------------------------------------------------
    step("Incident report")
    if confirmed:
        try_call("incident", lambda: owner.post("/api/admin/incidents", {
            "eventId": eid, "summary": "Test report: argument in the lobby", "category": "conduct", "severity": "MEDIUM",
            "location": "Lobby", "details": "Fake incident made by the seed script.",
            "people": [{"role": "SUBJECT", "registrationCode": confirmed[0]["code"]}, {"role": "REPORTER", "name": "Front desk volunteer"}],
        }))

    # ---- check-ins ---------------------------------------------------------------------
    if args.live and weekenders:
        step("Check-ins")
        for p in weekenders[: max(1, len(weekenders) // 2)]:
            try_call("check-in", lambda: owner.post("/api/admin/checkin", {"value": p["code"], "eventId": eid}))
        for p in weekenders[:3]:
            try_call("exit", lambda: owner.post("/api/admin/checkin", {"value": p["code"], "eventId": eid, "direction": "EXIT"}))

    # ---- attendee accounts (needs DEV_AUTH) -----------------------------------------------
    dev_names = []
    if args.no_dev_users:
        pass
    elif not (owner.get("/api/auth/config") or {}).get("devAuth"):
        print("  (DEV_AUTH is off, so no attendee accounts: panels, vendor applications, stars and room requests\n"
              "   from attendees were skipped. Set DEV_AUTH=true in .env, restart, and run again to get them.)")
    else:
        step("Attendee accounts")
        published = [s for s in sessions if s and s.get("published")]
        for name, panel, vendor in [
            ("Test Attendee", None, None),
            ("Test Panelist", "Building Your First Fursuit Head", None),
            ("Test Artist", None, ("ARTIST_ALLEY", alley, "Moonlit Sketches", "Commissions, prints and badges.")),
            ("Test Dealer", None, ("DEALERS_DEN", full, "Fuzzy Pins Co.", "Enamel pins, stickers and keychains.")),
        ]:
            dev = Client(base)
            dev.post("/api/auth/dev", {"name": name, "role": "USER"})
            dev_names.append(name)
            telegram = "dev-" + "".join(c if c.isalnum() else "-" for c in name.lower())
            reg = try_call(f"{name} ticket", lambda: owner.post("/api/admin/registrations", {
                "eventId": eid, "telegramId": telegram, "legalName": f"{name} Person", "fursonaName": name.split()[-1],
                "ticketTierId": weekend["id"], "payment": {"method": "CARD", "amount": "45"},
            }))
            for s in rng.sample(published, k=min(4, len(published))):
                try_call("star", lambda: dev.put(f"/api/my/stars/{s['id']}"))
            if panel:
                try_call("panel", lambda: dev.post(f"/api/events/{slug}/submissions", {
                    "title": panel, "description": "Foam carving, eyes, and fur for complete beginners.", "hosts": name, "lengthMinutes": 90,
                    "availability": "Any afternoon", "notes": "Needs a projector",
                }))
            if vendor:
                area, table, biz, what = vendor
                try_call("vendor application", lambda: dev.post(f"/api/events/{slug}/vendors", {
                    "area": area, "tableTypeId": table["id"], "businessName": biz, "description": what,
                    "portfolioUrls": ["https://example.com/portfolio"],
                }))
            if name == "Test Attendee" and reg:
                try_call("room request", lambda: dev.post(f"/api/events/{slug}/room-blocks/{king['id']}/reservations", {
                    "checkIn": nights[0], "checkOut": f"{dt.date.fromisoformat(nights[0]) + dt.timedelta(days=1):%Y-%m-%d}",
                    "guests": 1, "guestName": "Test Attendee Person",
                }))
                if shift_ids:
                    try_call("volunteer sign-up", lambda: dev.post(f"/api/events/{slug}/volunteer/{shift_ids[-1]['id']}", {"note": "Happy to help anywhere"}))

    # ---- summary -------------------------------------------------------------------------
    web = args.url.rstrip("/")
    print()
    print(f"Done: {event['title']}")
    print(f"  Overview      {web}/admin/events/{eid}")
    print(f"  Public page   {web}/e/{slug}")
    print(f"  Schedule      {web}/e/{slug}/schedule")
    print(f"  Vendors       {web}/e/{slug}/vendors")
    print(f"  Submit panel  {web}/e/{slug}/submit")
    print(f"  Check-in      {web}/admin/scan/{eid}")
    if confirmed:
        print(f"  Ticket codes to scan or look up: {', '.join(p['code'] for p in confirmed[:5])}")
    print(f"  Discount code TESTCON20 (20% off)")
    if dev_names:
        print(f"  Attendee accounts (sign in from the Dev tab on /login, role User): {', '.join(dev_names)}")
    print(f"  Remove it later with: python3 {Path(__file__).relative_to(ROOT)} --clean")


def main():
    env = read_env()
    parser = argparse.ArgumentParser(description="Add a fake [TEST] event to a running PawPass, or remove them.")
    parser.add_argument("--url", default=env.get("WEB_URL") or "http://localhost:8080", help="where PawPass's web front end is (default: WEB_URL from .env)")
    parser.add_argument("--email", default=env.get("OWNER_EMAIL"), help="owner email (default: OWNER_EMAIL from .env)")
    parser.add_argument("--password", default=env.get("OWNER_PASSWORD"), help="owner password (default: OWNER_PASSWORD from .env)")
    parser.add_argument("--live", action="store_true", help="make the event happen today, with people already checked in")
    parser.add_argument("--attendees", type=int, default=40, help="how many attendees (default 40)")
    parser.add_argument("--timezone", default="America/New_York", help="the event's timezone (default America/New_York)")
    parser.add_argument("--seed", type=int, default=None, help="random seed, for the same fake data every run")
    parser.add_argument("--no-dev-users", action="store_true", help="skip the attendee accounts even if DEV_AUTH is on")
    parser.add_argument("--clean", action="store_true", help="delete every event whose title starts with [TEST], then stop")
    args = parser.parse_args()
    if not args.email or not args.password:
        sys.exit("No owner credentials: set OWNER_EMAIL and OWNER_PASSWORD in .env, or pass --email and --password.")

    base = args.url.rstrip("/")
    owner = Client(base)
    user = sign_in_owner(owner, args.email, args.password)
    print(f"Signed in to {base} as {user['displayName']}")
    if args.clean:
        clean(owner)
    else:
        seed(args, base, owner)


if __name__ == "__main__":
    main()
