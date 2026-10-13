#!/usr/bin/env python3
"""Fill a running PawPass with a fake event, so there's something to click through.

Creates a main "[TEST] ..." event with ticket types, ~150 attendees (most
paid, some owing at the door, a few cancelled, some on staff vouchers, a
handful of minors with a guardian), answers to its extra questions, a
discount code, volunteer shifts, hotels with room blocks, a schedule, vendor
tables, merch, and incident reports. Alongside it: a small sold-out meetup
with a waitlist, and an event that ended last month (for "Past events" and
analytics). With --live the main event is happening today, some people are
checked in, and the door has a line, so the scanner, Overview and the
public wait estimate have live numbers.

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
    python3 scripts/seed_test_data.py -n 500       # 500 people on the main event
    python3 scripts/seed_test_data.py -n 40 --picnic 30 --past 100 --staff 12
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
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TEST_PREFIX = "[TEST]"

FIRST = ["Alex", "Sam", "Jordan", "Robin", "Casey", "Morgan", "Riley", "Jamie", "Taylor", "Avery",
         "Quinn", "Rowan", "Sky", "Drew", "Reese", "Emerson", "Hayden", "Kai", "Logan", "Parker",
         "Ari", "Blake", "Cam", "Dana", "Eli", "Finley", "Harper", "Jesse", "Lane", "Nico"]
LAST = ["Vale", "Ortiz", "Kim", "Park", "Nguyen", "Okafor", "Lindqvist", "Moreau", "Haddad", "Silva",
        "Brennan", "Novak", "Achebe", "Tanaka", "Rossi", "Kowalski", "Duarte", "Fischer", "Ibrahim", "Walsh",
        "Adeyemi", "Bauer", "Castillo", "Dubois", "Eriksen", "Fong", "Gallo", "Horvat", "Iyer", "Jansen"]
FURSONA = ["Kit", "Rue", "Moss", "Fen", "Ember", "Juniper", "Pip", "Sable", "Wren", "Bramble", "Cinder",
           "Tansy", "Echo", "Nimbus", "Pepper", "Quill", "Rook", "Sorrel", "Thistle", "Vesper", "Zephyr",
           "Ash", "Bolt", "Clover", "Dusk", "Flint", "Gale", "Hazel", "Indigo", "Jasper"]
SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL"]
DIETS = ["", "", "", "", "Vegetarian", "Vegan", "Gluten free", "Nut allergy", "Halal", "No pork"]
PRONOUNS = ["he/him", "she/her", "they/them", "any", "ask me"]
QUESTIONS = [
    {"key": "shirt", "label": "T-shirt size", "type": "select", "required": True, "options": SIZES},
    {"key": "pronouns", "label": "Pronouns", "type": "select", "required": False, "options": PRONOUNS},
    {"key": "diet", "label": "Dietary needs", "type": "text", "required": False},
    {"key": "first_con", "label": "First time at this con?", "type": "checkbox", "required": False},
]
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


def random_answers(rng):
    a = {"shirt": rng.choice(SIZES)}
    if rng.random() < 0.8:
        a["pronouns"] = rng.choice(PRONOUNS)
    diet = rng.choice(DIETS)
    if diet:
        a["diet"] = diet
    if rng.random() < 0.3:
        a["first_con"] = True
    return a


def birth_date(rng, today, minor):
    """A date of birth: 13 to 17 for a minor, otherwise 18 to 60."""
    years = rng.randint(13, 17) if minor else rng.randint(18, 60)
    return f"{today - dt.timedelta(days=years * 365 + rng.randint(30, 330)):%Y-%m-%d}"


def unique_names(rng, count, taken=()):
    """`count` different legal names, none in `taken`. The 900 first/last
    combinations come first; past that they repeat with a number on the end."""
    combos = [f"{f} {l}" for f in FIRST for l in LAST]
    rng.shuffle(combos)
    out, seen, round_ = [], set(taken), 1
    while len(out) < count:
        for name in combos:
            name = name if round_ == 1 else f"{name} {round_}"
            if name not in seen:
                seen.add(name)
                out.append(name)
                if len(out) == count:
                    break
        round_ += 1
    return out


def register_crowd(owner, rng, eid, count, tiers, stamp, label, today, answers=False, ages=False, paid_share=0.7):
    """`count` staff-entered registrations on `tiers` [(tier, weight)], each a
    distinct person. Returns the registrations, each with its tier attached."""
    people = []
    # Distinct names: the app refuses a second registration under the same
    # legal name for one event (that's its duplicate check working).
    for i, legal in enumerate(unique_names(rng, count)):
        fur = f"{rng.choice(FURSONA)}{'' if i < len(FURSONA) else i}"
        tier = rng.choices([t for t, _ in tiers], weights=[w for _, w in tiers])[0]
        body = {"eventId": eid, "legalName": legal, "fursonaName": fur, "email": f"{label}{i}.{stamp}@example.invalid", "ticketTierId": tier["id"]}
        if answers:
            body["answers"] = random_answers(rng)
        if ages:
            minor = rng.random() < 0.08
            body["birthDate"] = birth_date(rng, today, minor)
            if minor and rng.random() < 0.8:
                body["guardianName"] = f"{rng.choice(FIRST)} {legal.split()[-1]}"
        # Most paid at the desk; the rest owe it at the door.
        if tier["priceCents"] and rng.random() < paid_share:
            body["payment"] = {"method": rng.choice(["CASH", "CARD"]), "amount": str(tier["priceCents"] / 100)}
        reg = try_call(f"registration {i}", lambda: owner.post("/api/admin/registrations", body))
        if reg:
            reg["tier"] = tier
            people.append(reg)
    return people


def side_events(args, owner, rng, today, stamp, local):
    """A small free meetup that sold out (so it has a waitlist), and one that ended last month."""
    step("Sold-out meetup with a waitlist")
    d = today + dt.timedelta(days=9)
    meetup = owner.post("/api/admin/events", {
        "title": f"{TEST_PREFIX} Paws in the Park picnic", "slug": f"test-picnic-{stamp}", "timezone": args.timezone,
        "startsAt": local(d, 12), "endsAt": local(d, 17), "venue": "Riverside Park, north lawn",
        "tagline": "Small and free, so it fills up", "capacity": max(1, args.picnic - max(1, args.picnic // 4)), "published": True, "waitlistEnabled": True,
        "tosBody": "Clean up after yourselves.",
    })
    free = owner.post(f"/api/admin/events/{meetup['id']}/tiers", {"name": "Free", "price": "0"})
    crowd = register_crowd(owner, rng, meetup["id"], args.picnic, [(free, 1)], stamp, "picnic", today)
    waiting = sum(1 for p in crowd if p["status"] == "WAITLIST")
    print(f"  {len(crowd) - waiting} confirmed, {waiting} on the waitlist")

    step("Event that ended last month")
    s = today - dt.timedelta(days=38)
    past = owner.post("/api/admin/events", {
        "title": f"{TEST_PREFIX} Winter Howl", "slug": f"test-winter-howl-{stamp}", "timezone": args.timezone,
        "startsAt": local(s, 10), "endsAt": local(s + dt.timedelta(days=1), 22), "venue": "Hilltop Lodge",
        "tagline": "Already happened", "capacity": max(80, args.past + 10), "published": True,
    })
    ga = owner.post(f"/api/admin/events/{past['id']}/tiers", {"name": "Weekend", "price": "35"})
    register_crowd(owner, rng, past["id"], args.past, [(ga, 1)], stamp, "howl", today, paid_share=0.95)
    return [meetup, past]


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
        "capacity": max(300, args.attendees + 50), "published": True,
        "tosBody": "Be excellent to each other. Badges must be visible at all times.",
        "customFields": QUESTIONS,
    })
    eid, slug = event["id"], event["slug"]
    owner.patch(f"/api/admin/events/{eid}", {
        "volunteersEnabled": True, "volunteerInfo": "Check in at the volunteer desk by the main doors 15 minutes before your shift.",
        "hotelsEnabled": True, "hotelInfo": "Book inside the block by the cutoff to get the convention rate.",
        "scheduleEnabled": True,
        "submissionsOpen": True, "submissionInfo": "Panels run 30 to 90 minutes. Tell us what equipment you need.",
        "vendorsOpen": True, "vendorInfo": "Load-in is the morning of day one. Handmade work only in the artist alley.",
        "occupancyLimit": max(120, args.attendees * 3 // 5),
        "ageCheckEnabled": True, "minorAge": 18, "guardianMode": "optional",
    })

    # ---- tickets -------------------------------------------------------------
    step("Ticket types, discount code, voucher")
    weekend = owner.post(f"/api/admin/events/{eid}/tiers", {"name": "Weekend", "price": "45", "capacity": max(150, args.attendees), "description": "All days"})
    middle = days[len(days) // 2]
    day_pass = owner.post(f"/api/admin/events/{eid}/tiers", {"name": f"{middle:%A} pass", "price": "25", "description": f"{middle:%A} only", "validDays": [f"{middle:%Y-%m-%d}"]})
    sponsor = owner.post(f"/api/admin/events/{eid}/tiers", {"name": "Sponsor", "price": "120", "capacity": max(20, args.attendees // 5), "description": "Weekend + sponsor badge ribbon"})
    try_call("discount code", lambda: owner.post(f"/api/admin/events/{eid}/discounts", {"code": "TESTCON20", "percentOff": 20, "maxUses": 50}))
    voucher = try_call("voucher", lambda: owner.post(f"/api/admin/events/{eid}/vouchers", {"code": f"STAFF-{stamp[-6:]}", "badgeTier": "Staff", "maxUses": max(10, args.staff)}))

    # ---- attendees -------------------------------------------------------------
    step(f"{args.attendees} attendees")
    people = register_crowd(owner, rng, eid, args.attendees, [(weekend, 70), (day_pass, 20), (sponsor, 10)],
                            stamp, "attendee", today, answers=True, ages=True)
    # Staff on the voucher: free, guaranteed a spot, badge says "Staff".
    if voucher:
        staff = unique_names(rng, args.staff, taken={p["legalName"] for p in people})
        for n, legal in enumerate(staff):
            reg = try_call("staff voucher", lambda: owner.post("/api/admin/registrations", {
                "eventId": eid, "legalName": legal, "fursonaName": f"Staff{n + 1}", "voucherCode": voucher["code"],
                "answers": random_answers(rng), "birthDate": birth_date(rng, today, False),
            }))
            if reg:
                reg["tier"] = weekend
                people.append(reg)
    # A few change their minds.
    for p in rng.sample(people, k=len(people) // 16):
        if try_call("cancel", lambda: owner.patch(f"/api/admin/registrations/{p['code']}", {"status": "CANCELLED"})):
            p["status"] = "CANCELLED"
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
    step("Incident reports")
    reports = [
        ("Test report: argument in the lobby", "conduct", "MEDIUM", "Lobby", "Two attendees raised voices over a seat. Separated, both calm now."),
        ("Test report: fursuiter overheated", "medical", "HIGH", "Main Stage", "Suiter felt faint after the parade. Headless lounge, water, first aid called."),
        ("Test report: lost phone", "property", "LOW", "Panel Room B", "Black phone in a paw-print case left after the 3pm panel."),
    ]
    for (summary, category, severity, where, details), subject in zip(reports, confirmed):
        inc = try_call("incident", lambda: owner.post("/api/admin/incidents", {
            "eventId": eid, "summary": summary, "category": category, "severity": severity, "location": where, "details": details,
            "people": [{"role": "SUBJECT", "registrationCode": subject["code"]}, {"role": "REPORTER", "name": "Front desk volunteer"}],
        }))
        if inc:
            try_call("incident note", lambda: owner.post(f"/api/admin/incidents/{inc['id']}/notes", {"body": "Followed up in person. Fake note from the seed script."}))

    # ---- check-ins ---------------------------------------------------------------------
    if args.live and weekenders:
        step("Check-ins")
        for p in weekenders[: max(1, len(weekenders) // 2)]:
            try_call("check-in", lambda: owner.post("/api/admin/checkin", {"value": p["code"], "eventId": eid}))
        for p in weekenders[:3]:
            try_call("exit", lambda: owner.post("/api/admin/checkin", {"value": p["code"], "eventId": eid, "direction": "EXIT"}))
        # The public "line at the door" estimate needs a reported line.
        try_call("door line", lambda: owner.put(f"/api/admin/events/{eid}/door-line", {"count": rng.randint(15, 40)}))

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
                "answers": random_answers(rng), "birthDate": birth_date(rng, today, False),
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

    extra = [] if args.no_side_events else side_events(args, owner, rng, today, stamp, local)

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
    cancelled = sum(1 for p in people if p["status"] == "CANCELLED")
    print(f"  Main event: {len(confirmed)} confirmed, {cancelled} cancelled, minors flagged at check-in")
    for e in extra:
        print(f"  Also          {web}/e/{e['slug']}  ({e['title']})")
    if dev_names:
        print(f"  Attendee accounts (sign in from the Dev tab on /login, role User): {', '.join(dev_names)}")
    print(f"  Remove it later with: python3 {Path(__file__).relative_to(ROOT)} --clean")


def ipv4_localhost(url):
    """docker-compose.yml publishes the ports on 127.0.0.1 only, and on Windows
    "localhost" resolves to ::1 first. urllib tries that, and Windows takes
    about 20 seconds to give up on it before trying 127.0.0.1 — on every
    request. Going straight to 127.0.0.1 skips the wait."""
    parts = urllib.parse.urlsplit(url)
    if parts.hostname != "localhost":
        return url
    netloc = "127.0.0.1" + (f":{parts.port}" if parts.port else "")
    return urllib.parse.urlunsplit(parts._replace(netloc=netloc))


def main():
    env = read_env()
    parser = argparse.ArgumentParser(description="Add a fake [TEST] event to a running PawPass, or remove them.")
    parser.add_argument("--url", default=env.get("WEB_URL") or "http://localhost:8080", help="where PawPass's web front end is (default: WEB_URL from .env)")
    parser.add_argument("--email", default=env.get("OWNER_EMAIL"), help="owner email (default: OWNER_EMAIL from .env)")
    parser.add_argument("--password", default=env.get("OWNER_PASSWORD"), help="owner password (default: OWNER_PASSWORD from .env)")
    parser.add_argument("--live", action="store_true", help="make the event happen today, with people already checked in")
    parser.add_argument("-n", "--attendees", "--people", type=int, default=150, metavar="N", help="how many attendees on the main event (default 150)")
    parser.add_argument("--staff", type=int, default=6, metavar="N", help="staff registered with the voucher on the main event (default 6)")
    parser.add_argument("--picnic", type=int, default=17, metavar="N", help="sign-ups for the sold-out meetup; about a quarter end up on the waitlist (default 17)")
    parser.add_argument("--past", type=int, default=45, metavar="N", help="attendees at the event that already happened (default 45)")
    parser.add_argument("--no-side-events", action="store_true", help="only the main event: skip the sold-out meetup and the past event")
    parser.add_argument("--timezone", default="America/New_York", help="the event's timezone (default America/New_York)")
    parser.add_argument("--seed", type=int, default=None, help="random seed, for the same fake data every run")
    parser.add_argument("--no-dev-users", action="store_true", help="skip the attendee accounts even if DEV_AUTH is on")
    parser.add_argument("--clean", action="store_true", help="delete every event whose title starts with [TEST], then stop")
    args = parser.parse_args()
    if not args.email or not args.password:
        sys.exit("No owner credentials: set OWNER_EMAIL and OWNER_PASSWORD in .env, or pass --email and --password.")

    base = ipv4_localhost(args.url.rstrip("/"))
    owner = Client(base)
    user = sign_in_owner(owner, args.email, args.password)
    print(f"Signed in to {base} as {user['displayName']}")
    if args.clean:
        clean(owner)
    else:
        seed(args, base, owner)


if __name__ == "__main__":
    main()
