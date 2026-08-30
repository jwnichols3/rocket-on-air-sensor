#!/bin/bash
# <xbar.title>On Air</xbar.title>
# <xbar.desc>Current state and service control for the on-air light.</xbar.desc>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
#
# A SwiftBar plugin for the on-air light (D-26, #18). It is an ordinary script that prints
# text; SwiftBar runs it every 5 seconds and draws stdout.
#
# THIS IS A RENDERER, so THE CLIENT CONTRACT (D-91, D-92) applies to it exactly as it
# applies to the panel. It must never draw a calm menu bar on evidence it does not have.
# Three conditions, not two: answering, not answering but inside the grace window, and
# given up - the same three pictures the glass draws (D-54, D-57).
#
# THE AWKWARD PART, AND HOW IT IS SOLVED. The contract measures both thresholds from the
# LAST SUCCESSFUL CONTACT, and this plugin has no memory: SwiftBar starts a fresh process
# every five seconds and it dies with its answer. So contact is recorded on disk - the
# timestamp, plus enough of the last reading to keep drawing it. Without that, "the service
# has been down for two minutes" and "for two hours" look identical from in here, and the
# only safe thing a memoryless renderer can do with a failed poll is give up immediately -
# which is exactly the over-eager NO DATA this whole change exists to remove.
#
# It needs NO credential. Every request goes to loopback, where D-24's waiver applies - that
# waiver is the whole reason this plugin is 100 lines and not 300.
#
# SwiftBar gives a plugin a minimal PATH, so everything is called by absolute path.

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
HERE="$(cd -P "$(dirname "$0")" && pwd)"
# Resolved through the symlink SwiftBar loads us by, so `onair` is found in the checkout
# rather than depending on /usr/local/bin being present.
REAL="$(/usr/bin/python3 -c 'import os,sys; print(os.path.dirname(os.path.realpath(sys.argv[1])))' "$0")"
ONAIR="$REAL/../onair"

# EVERY exit path must print something. A blank menu bar is precisely the false OFF this
# plugin exists to prevent, and empty stdout is the easiest way to produce one: on a Mac
# without Command Line Tools `/usr/bin/python3` is a stub that fails, and any unhandled
# exception below yields nothing at all.
#
# Written to a file rather than captured with $( ). macOS ships bash 3.2, which mishandles a
# heredoc inside command substitution - measured, not assumed.
TMP="$(/usr/bin/mktemp -t onair.swiftbar)"
/usr/bin/python3 - "$ONAIR" <<'PY' > "$TMP" 2>/dev/null
import base64, json, os, signal, struct, sys, time, urllib.error, urllib.request, zlib

# A REAL deadline. urlopen(timeout=) bounds each socket operation, NOT the whole run, so a
# server that emits one byte a second holds json.load open forever - measured. SwiftBar
# starts a fresh copy every 5 seconds, so a hung one accumulates. SIGALRM's default action
# terminates the process; nothing has been printed by then (everything is emitted in one
# print at the end), so the wrapper sees empty output and draws the warning.
signal.alarm(4)

# Loopback must not go through a proxy. urlopen honours http_proxy/ALL_PROXY from the
# environment, so a corporate proxy with no no_proxy for 127.0.0.1 would fail every request
# and pin the menu bar on the warning - honest, but wrong.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

ONAIR = os.path.realpath(sys.argv[1])
HOME = os.path.expanduser("~")


def read_overlay(key):
    """Resolution order is D-14's, the same one the service itself uses: a real environment
    variable wins over the env overlay, which wins over the config document. Honouring the
    environment is not only correct, it is what makes this script testable without editing
    the operator's config."""
    if os.environ.get(key):
        return os.environ[key]
    try:
        with open(os.path.join(HOME, ".onair", "config.env")) as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def read_document():
    try:
        with open(os.path.join(HOME, ".onair", "config.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


# THE TWO THRESHOLDS (D-92). Ours, on our own clock, measured from the last successful
# contact and NOT chained off each other.
CONNECTION_LOST_S = 60      # 1 minute  - say it is not being refreshed
NO_DATA_S = 1800            # 30 minutes - give up on the state entirely

CONTACT_FILE = os.path.join(HOME, ".onair", "swiftbar-contact.json")


def remember_contact(payload):
    """Record this successful reading, so the NEXT run - which may not get one - knows how
    long we have actually been out of touch and what we last knew.

    Never fatal. A read-only home directory costs us the grace window and nothing else: the
    fallback is to give up immediately, which is the safe direction."""
    try:
        tmp = CONTACT_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, CONTACT_FILE)
    except (OSError, ValueError, TypeError):
        pass


def recall_contact():
    """The last recorded reading, or None.

    FAILS CLOSED, and this is the property #63 was told to keep. It is the descendant of a
    measured incident (D-64.3): trusting the server's own `stale` flag drew a calm menu bar
    on 27-hour-old evidence, because any miss - a rename, version skew, something else on
    the port - read as false, and false meant calm. Absent, unreadable, malformed or
    missing a usable timestamp all mean WITHHOLD CALM here, never assume it.

    Note what is no longer possible: nothing the server sends feeds this decision at all
    now. There is no field left to be absent or wrong - the clock is ours."""
    try:
        with open(CONTACT_FILE) as fh:
            cached = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(cached, dict):
        return None
    at = cached.get("at")
    if isinstance(at, bool) or not isinstance(at, (int, float)):
        return None
    # A timestamp in the future is a clock that moved, not evidence. Refuse it.
    if at > time.time() + 5:
        return None
    if not isinstance(cached.get("status"), dict):
        return None
    return cached


HOST_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-_[]")


def host(value):
    """A hostname reaches an `href=` PARAMETER, and SwiftBar splits parameters on
    whitespace. A host containing spaces therefore becomes further parameters - including
    `bash=`, which is a menu item that runs a command when clicked. Measured: a `light.host`
    of `h bash=/bin/sh param1=-c param2=whoami` produced two working `bash=` parameters.

    `light.host` is validated by the server only as a non-empty string
    (config-store.ts, strOrNull) and is writable through PUT /admin/config, so this is a
    real input, not a hypothetical one. Whitelist, do not blacklist."""
    text = "" if value is None else str(value)
    if not text or len(text) > 64 or any(c not in HOST_OK for c in text):
        return ""
    return text


doc = read_document()
port = read_overlay("ONAIR_PORT") or str(doc.get("port") or 8484)
light = host(read_overlay("ONAIR_LIGHT_HOST") or (doc.get("light") or {}).get("host") or "")
base = "http://127.0.0.1:%s" % port


def get(path):
    # One second, deliberately. This runs every five seconds; a plugin that hangs is a menu
    # bar that freezes, and "the server is slow" and "the server is down" want the same
    # picture anyway.
    try:
        with OPENER.open(base + path, timeout=1) as r:
            # Capped: an endless body cannot be turned into an endless string.
            raw = r.read(65536)
        value = json.loads(raw)
        # A JSON array or scalar is not a status object. Refusing it here means the caller
        # never has to guard .get() - and an unexpected shape draws the warning, not a
        # blank menu bar.
        return value if isinstance(value, dict) else None
    except Exception:
        return None


# TWO requests, because D-42 split semantics from presentation. `/status` carries the state
# and the age; it does NOT carry label or colour.
#
# The LOOK is looked up in the state table, NOT read from /public/status. The contract says
# so in as many words: /public/status is a rendering view for /display and the landing page,
# "free to change shape to suit the two pages", and "a renderer that holds a table must not
# use these ... take the state key from the gated endpoints and the look from
# GET /config/states". Looking the row up by its id is also the only way to get both halves
# for the SAME row. Pairing two status responses could not do that - a write landing between
# them paired one row's `busy` with another row's colour, and the old code could only detect
# that and give up. Both are waived on loopback (D-24).
status = get("/status")
table = get("/config/states")

# THE THREE CONDITIONS (D-91), resolved before anything is drawn.
#
# `contact_lost` and `gave_up` are the only two facts the rest of this script consults about
# liveness, and both are computed from OUR clock against the recorded contact time. Note the
# asymmetry with the old code: a poll that fails is not by itself a verdict. One missed poll
# on a five-second cadence changes nothing; sixty seconds of them puts up the mark.
contact_lost = False
gave_up = False
lost_for = 0
poll_failed = status is None
row_cache = None

if status is not None:
    remember_contact({"at": time.time(), "status": status, "table": table})
else:
    cached = recall_contact()
    if cached is None:
        # No usable memory of ever having contact. We cannot bound how long we have been out
        # of touch, so we do not claim a state. Fail closed.
        gave_up = True
    else:
        lost_for = int(max(0, time.time() - cached["at"]))
        contact_lost = lost_for > CONNECTION_LOST_S
        gave_up = lost_for > NO_DATA_S
        if not gave_up:
            # Condition 2: keep drawing what we last knew. The state has not changed - the
            # server latches it (D-91) - we simply are not hearing it confirmed.
            status = cached["status"]
            row_cache = cached.get("table")
            if table is None and isinstance(row_cache, dict):
                table = row_cache

out = []


def safe(value, limit=120):
    """SwiftBar splits a line on `|` and on newlines, so any value that reaches a menu line
    has to be stripped of both. This is not paranoia: `message` is 200 characters of free
    text (`PUT /message`), and `label` and `source` are operator-supplied too. A pipe in any
    of them would silently turn the rest of the line into parameters and mangle the menu."""
    text = "" if value is None else str(value)
    text = text.replace("|", "/")
    # Collapse ALL whitespace, then strip. Two reasons beyond tidiness: a label of three
    # spaces is legal (the server validates length, never content) and would erase the state
    # word from the title, and a leading `--` makes SwiftBar read the line as a submenu
    # child rather than a top-level item.
    text = " ".join(text.split())
    while text.startswith("-"):
        text = text[1:].lstrip()
    return text[:limit]


HEX = "0123456789abcdefABCDEF"


def hex_color(value):
    """A colour only reaches a SwiftBar parameter if it is exactly #rrggbb. The server
    validates this, so this is the second line of defence, not the first."""
    text = "" if value is None else str(value)
    if len(text) == 7 and text[0] == "#" and all(c in HEX for c in text[1:]):
        return text
    return ""


# ---------------------------------------------------------------------------
# THE MENU BAR ICON
#
# The menu bar shows an ON AIR SIGN, not words. SwiftBar draws an `image=` parameter on the
# menu bar item itself (MenuBarItem.setMenuTitle -> MenuLineParameters.getImage with
# isMenuBarItem: true), so the icon is a base64 PNG this script draws from scratch. There is
# no imaging library here and there does not need to be one: a PNG is a zlib stream wrapped
# in four length-prefixed chunks, and the encoder below is twenty lines of stdlib.
#
# The pHYs chunk claims 144 DPI. AppKit derives an NSImage's point size from its
# representation's resolution, so a 66x22 bitmap that declares 144 DPI is a 33x11 POINT
# image carrying a true 2x representation. That is crisp on a retina display and needs no
# `width=`/`height=` parameters, which would send the bitmap through SwiftBar's
# resizedCopy() and resample it.
#
# THERE IS NO HOVER TEXT, and this is a SwiftBar limitation, not an omission. SwiftBar
# assigns `tooltip` to NSMenuItem - dropdown rows - and never to the status item's button;
# `button?.toolTip` does not appear anywhere in MenuBarItem.swift. The status in words is
# therefore the first row of the dropdown, one click away.

# A 4x5 pixel face, because at menu bar size a real font renders to mud. Drawn at 2 device
# pixels per font pixel, which on a 2x display is exactly one point per font pixel.
FONT = {
    "O": [".##.", "#..#", "#..#", "#..#", ".##."],
    "N": ["#..#", "##.#", "#.##", "#..#", "#..#"],
    "A": [".##.", "#..#", "####", "#..#", "#..#"],
    "I": ["###", ".#.", ".#.", ".#.", "###"],
    "R": ["###.", "#..#", "###.", "#.#.", "#..#"],
    " ": ["..", "..", "..", "..", ".."],
}
SIGN_TEXT = "ON AIR"
# EVERY dimension is even, and every glyph therefore starts on an even column. This bitmap
# is 2x, and a 1x display halves it; even-aligned features halve onto exact pixel
# boundaries instead of straddling them. Rocket's displays are all 1x today, so this is the
# case that has to look right, not the retina one.
SCALE, GAP, PAD_X, PAD_Y, RADIUS, STROKE = 2, 2, 6, 6, 4, 2

# Grey, and NOT the `unknown` row's own colours. That row is #ff00ff on #1a1a1a, which is
# chosen for the panel's glass, where the background is dark by construction; #1a1a1a in the
# menu bar is invisible on a dark menu bar and a black smear on a light one.
NO_DATA_GREY = "#8e8e93"
UNREACHABLE_AMBER = "#e8a317"


def _png(width, height, grid):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"".join(bytes(px) for px in row) for row in grid)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"pHYs", struct.pack(">IIB", 5669, 5669, 1))  # 5669 px/m = 144 DPI
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _rgb(value):
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def sign(fg, bg):
    """An ON AIR sign in the state's own colours, base64 for `image=`.

    `bg` None draws the sign UNLIT: an outline and nothing behind the letters. That is
    reserved for the pictures that are not a state - no data, and no service - so that an
    absence of evidence can never be mistaken for whatever colours the operator has
    configured. It is the menu bar's version of the panel's NO_DATA branch."""
    width = sum(len(FONT[c][0]) * SCALE for c in SIGN_TEXT) + GAP * (len(SIGN_TEXT) - 1) + PAD_X * 2
    height = 5 * SCALE + PAD_Y * 2
    fgc, bgc = _rgb(fg), _rgb(bg) if bg else None
    grid = [[(0, 0, 0, 0)] * width for _ in range(height)]

    def rounded(x, y):
        for cx, cy in ((RADIUS, RADIUS), (width - 1 - RADIUS, RADIUS),
                       (RADIUS, height - 1 - RADIUS), (width - 1 - RADIUS, height - 1 - RADIUS)):
            in_x = x < RADIUS if cx == RADIUS else x > width - 1 - RADIUS
            in_y = y < RADIUS if cy == RADIUS else y > height - 1 - RADIUS
            if in_x and in_y:
                return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2 + 1
        return True

    for y in range(height):
        row = grid[y] = list(grid[y])
        for x in range(width):
            if not rounded(x, y):
                continue
            edge = (x < STROKE or x >= width - STROKE or y < STROKE or y >= height - STROKE
                    or not rounded(x - STROKE, y) or not rounded(x + STROKE, y)
                    or not rounded(x, y - STROKE) or not rounded(x, y + STROKE))
            if edge:
                row[x] = fgc + (255,)
            elif bgc:
                row[x] = bgc + (255,)

    ox = PAD_X
    for ch in SIGN_TEXT:
        glyph = FONT[ch]
        for gy, grow in enumerate(glyph):
            for gx, cell in enumerate(grow):
                if cell != "#":
                    continue
                for sy in range(SCALE):
                    for sx in range(SCALE):
                        grid[PAD_Y + gy * SCALE + sy][ox + gx * SCALE + sx] = fgc + (255,)
        ox += len(glyph[0]) * SCALE + GAP

    return base64.b64encode(_png(width, height, grid)).decode("ascii")

def line(text, *params):
    out.append(text + ((" | " + " ".join(params)) if params else ""))


if status is None:
    # CONDITION 3, or no memory of ever having had contact. NEVER a calm-looking title. We do
    # not know, and saying so is the only honest answer - a blank or green menu bar here is a
    # false OFF with extra steps. An UNLIT sign in the warning colour: the shape is still the
    # shape, so the menu bar item does not vanish or change size, but nothing about it says a
    # state.
    line("", "image=%s" % sign(UNREACHABLE_AMBER, None))
    line("---")
    line("NO SERVICE", "size=14", "color=%s" % UNREACHABLE_AMBER)
    if lost_for:
        line("No answer for %dm - the last state it reported has been discarded"
             % (lost_for // 60), "color=#ff8f8f")
    line("The on-air service is not answering on %s" % base, "color=#ff8f8f")
    line("Start it", 'bash="%s" param1=start terminal=false refresh=true' % ONAIR)
    line("Restart it", 'bash="%s" param1=restart terminal=false refresh=true' % ONAIR)
    line("Show the log", 'bash="%s" param1=logs terminal=true' % ONAIR)
    print("\n".join(out))
    raise SystemExit(0)

state = safe(status.get("state") or "unknown", 64)
busy = bool(status.get("busy"))
message = safe(status.get("message"), 200)

# `ageSeconds` IS NOW PURELY DISPLAY TEXT. It used to carry the safety decision - a private
# ninety-second threshold and its derivation lived right here - and it carries none of it now.
# A missing or non-numeric value costs a line of the dropdown and nothing else, because the
# liveness verdict was settled above from our own clock and cannot be influenced from the
# wire. That is a stronger version of the property the derivation was protecting.
age = status.get("ageSeconds")
if isinstance(age, bool) or not isinstance(age, (int, float)):
    age = None

# The row is matched on the RAW id from /status, not on the sanitised copy: `safe()` rewrites
# `|` and collapses whitespace, which is right for a menu line and wrong for a lookup key.
raw_state = status.get("state")
row = {}
for candidate in (table or {}).get("states") or []:
    if isinstance(candidate, dict) and candidate.get("id") == raw_state:
        row = candidate
        break
label = safe(row.get("label"), 64) or state
# Both halves of the operator's own indicator: `color` on `bgcolor`, the same pair the panel
# paints on the glass and the admin console edits.
fg = hex_color(row.get("color"))
bgcolor = hex_color(row.get("bgcolor"))

# The same three-way decision the panel makes, in the same order (compute_view, D-57), with
# the trigger moved from the write's age to OUR connection.
#
# The asymmetry is unchanged and is the same one the admin console draws (D-82): an
# unrefreshed CALM row loses its colours, an unrefreshed BUSY row keeps them. Draining a
# busy signal weakens it, and false OFF is worse than false ON.
if state == "unknown" or (contact_lost and not busy) or not (fg and bgcolor):
    # A claim we are no longer hearing confirmed cannot support a calm menu bar. The sign is
    # drawn UNLIT, so an absence of evidence cannot be mistaken for a configured state
    # whatever colours that state was given. A row this script cannot paint faithfully - no
    # colours, or no row at all - lands here too: a sign it cannot paint truthfully is one it
    # will not paint.
    headline, headline_colour = "NO DATA", "#e8a317"
    line("", "image=%s" % sign(NO_DATA_GREY, None))
else:
    headline, headline_colour = label.upper(), bgcolor
    line("", "image=%s" % sign(fg, bgcolor))

line("---")
# The menu bar item carries no hover text - SwiftBar has no tooltip on the status item's
# button - so the state in words is the first row of the dropdown instead.
line(headline, "size=14", "color=%s" % headline_colour)
# Prefixed, so an operator-supplied label can never be the first thing on the line.
line("State: %s  (%s)" % (label, state), "size=13")
line("Busy: %s" % ("yes" if busy else "no"))
if contact_lost:
    # Said in words, first, because the picture alone cannot distinguish "the state is calm"
    # from "the last thing I heard was calm, a while ago".
    line("NOT REFRESHING - no answer for %ds" % lost_for, "color=#e8a317")
    line("This is the last state the service reported, not a current reading.", "size=12",
         "color=#e8a317")
elif poll_failed:
    # Inside the grace window the PICTURE deliberately does not move - one missed poll on a
    # five-second cadence means nothing. The dropdown still says it, because a diagnostic
    # line costs nothing and someone opening the menu is asking exactly this question.
    line("This poll got no answer; showing the last reading.", "size=12", "color=#8b959e")
if age is None:
    line("Last write: unknown")
else:
    when = "%ds ago" % int(age) if age < 120 else "%dm ago" % int(age // 60)
    line("Last write: %s" % when)
src = safe(status.get("source"), 64)
if src:
    line("Source: %s" % src)
# NOTHING IS DRAWN FROM `hold` (D-126). The field is retired: no pin, no hold, no
# precedence - the last write wins, so there is no held row to name. This block is deleted
# rather than left keyed on a field that never arrives, because recall_contact() replays a
# CACHED /status body for up to thirty minutes, and a cached body from before the retirement
# still carries `hold`. An `if hold:` here would draw "Pinned to: X" from that cache, hours
# after the concept stopped existing.
confirmed = safe(status.get("confirmed"), 64)
line("Light says: %s" % (confirmed if confirmed else "unknown"))
if message:
    # A SEPARATE LINE, never the title. D-5's rule, restated in the contract: "a message may
    # never replace the state word or the state colour on any renderer."
    line("Message: %s" % message)

line("---")
line("Admin console", "href=%s/" % base)
line("Public display", "href=%s/display" % base)
if light:
    line("Panel status", "href=http://%s/onair" % light)
    line("Panel settings", "href=http://%s/onair/config" % light)

health = get("/admin/health")
if health:
    line("---")
    line("About", "size=12", "color=#8b959e")
    line("port %s · pid %s · node %s" % (
        health.get("port", "?"), health.get("pid", "?"), safe(health.get("nodeVersion"), 16)),
        "size=12", "color=#8b959e")
    up = health.get("uptime")
    if isinstance(up, (int, float)):
        line("up %dh %dm" % (int(up // 3600), int((up % 3600) // 60)), "size=12", "color=#8b959e")
    if health.get("stateFileWritable") is False:
        line("STATE FILE NOT WRITABLE", "color=#ff8f8f")

line("---")
# Without the sudoers rule these shell out to plain `sudo` with no TTY and no output
# surface, so they fail INVISIBLY. Say so rather than offering a control that quietly does
# nothing. /etc/sudoers.d is world-traversable, so this check works unprivileged.
if not os.path.exists("/etc/sudoers.d/onair"):
    line("Service control needs: sudo onair sudoers", "color=#e8a317")
line("Restart the service", 'bash="%s" param1=restart terminal=false refresh=true' % ONAIR)
line("Stop the service", 'bash="%s" param1=stop terminal=false refresh=true' % ONAIR)
line("Show the log", 'bash="%s" param1=logs terminal=true' % ONAIR)
line("Refresh now", "refresh=true")

print("\n".join(out))
PY

if [ -s "$TMP" ]; then
  /bin/cat "$TMP"
else
  printf '%s\n' "⚠ on-air? | color=#e8a317"
  printf '%s\n' "---"
  printf '%s\n' "The menu bar plugin could not run."
  printf '%s\n' "It cannot say whether you are on air, so it will not guess."
  printf '%s\n' "Run it in a terminal to see why | bash=$REAL/onair.5s.sh terminal=true"
fi
/bin/rm -f "$TMP"
