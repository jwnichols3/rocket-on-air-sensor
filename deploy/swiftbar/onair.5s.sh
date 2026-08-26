#!/bin/bash
# <xbar.title>On Air</xbar.title>
# <xbar.desc>Current state, hold, and service control for the on-air light.</xbar.desc>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
#
# A SwiftBar plugin for the on-air light (D-26, #18). It is an ordinary script that prints
# text; SwiftBar runs it every 5 seconds and draws stdout.
#
# THIS IS A RENDERER, so THE BUSY RULE (D-32) applies to it exactly as it applies to the
# panel. It must never draw a calm menu bar on evidence it does not have. Unreachable, stale
# and calm are three different pictures here for the same reason they are three different
# pictures on the glass (D-54, D-57).
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

/usr/bin/python3 - "$ONAIR" <<'PY'
import json, os, sys, urllib.request, urllib.error

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


doc = read_document()
port = read_overlay("ONAIR_PORT") or str(doc.get("port") or 8484)
light = read_overlay("ONAIR_LIGHT_HOST") or (doc.get("light") or {}).get("host") or ""
base = "http://127.0.0.1:%s" % port


def get(path):
    # One second, deliberately. This runs every five seconds; a plugin that hangs is a menu
    # bar that freezes, and "the server is slow" and "the server is down" want the same
    # picture anyway.
    try:
        with urllib.request.urlopen(base + path, timeout=1) as r:
            return json.load(r)
    except Exception:
        return None


# TWO views, because D-42 split them. `/status` carries the semantics and the hold; it does
# NOT carry label or colour. `/public/status` is resolved for rendering and carries the
# presentation. Both are waived on loopback.
status = get("/status")
public = get("/public/status")

out = []


def safe(value, limit=120):
    """SwiftBar splits a line on `|` and on newlines, so any value that reaches a menu line
    has to be stripped of both. This is not paranoia: `message` is 200 characters of free
    text (`PUT /message`), and `label` and `source` are operator-supplied too. A pipe in any
    of them would silently turn the rest of the line into parameters and mangle the menu."""
    text = "" if value is None else str(value)
    text = text.replace("|", "/").replace("\n", " ").replace("\r", " ")
    return text[:limit]


HEX = "0123456789abcdefABCDEF"


def hex_color(value):
    """A colour only reaches a SwiftBar parameter if it is exactly #rrggbb. The server
    validates this, so this is the second line of defence, not the first."""
    text = "" if value is None else str(value)
    if len(text) == 7 and text[0] == "#" and all(c in HEX for c in text[1:]):
        return text
    return ""


def line(text, *params):
    out.append(text + ((" | " + " ".join(params)) if params else ""))


if status is None:
    # NEVER a calm-looking title. We do not know, and saying so is the only honest answer -
    # a blank or green menu bar here is a false OFF with extra steps.
    line("⚠ on-air?", "color=#e8a317")
    line("---")
    line("The on-air service is not answering on %s" % base, "color=#ff8f8f")
    line("Start it", "bash=%s param1=start terminal=false refresh=true" % ONAIR)
    line("Restart it", "bash=%s param1=restart terminal=false refresh=true" % ONAIR)
    line("Show the log", "bash=%s param1=logs terminal=true" % ONAIR)
    print("\n".join(out))
    raise SystemExit(0)

state = safe(status.get("state") or "unknown", 64)
busy = bool(status.get("busy"))
stale = bool(status.get("stale"))
hold = safe(status.get("hold"), 64)
label = safe((public or {}).get("label") or state, 64)
bgcolor = hex_color((public or {}).get("bgcolor"))
message = safe(status.get("message"), 200)

# The same three-way decision the panel makes, in the same order (compute_view, D-57).
if state == "unknown" or (stale and not busy):
    # Stale evidence cannot support a calm claim. THE BUSY RULE.
    line("NO DATA", "color=#e8a317")
elif busy:
    line("● %s" % label.upper(), *(["color=%s" % bgcolor] if bgcolor else []))
else:
    line("○ %s" % label, *(["color=%s" % bgcolor] if bgcolor else []))

line("---")
line("%s  (%s)" % (label, state), "size=13")
line("Busy: %s" % ("yes" if busy else "no"))
age = status.get("ageSeconds")
if isinstance(age, (int, float)):
    when = "%ds ago" % int(age) if age < 120 else "%dm ago" % int(age // 60)
    line("Last write: %s%s" % (when, "  (stale)" if stale else ""))
src = safe(status.get("source"), 64)
if src:
    line("Source: %s" % src)
if hold:
    # `hold` is the PINNED ROW ID, not who pinned it (state.ts: `hold: string | null`).
    # "Held by" read as a person and was wrong.
    line("Pinned to: %s" % hold, "color=#e8a317")
    # Releasing a pin is a `PUT /state` with `hold: false` and a `human:` source. The CLI has
    # no verb for it, and `reset-state` is NOT that verb - it also clears the message and
    # restarts the service. Offering it here would have been a much bigger hammer than the
    # label implied, so this links to the console instead.
    line("Release it in the console", "href=%s/" % base)
else:
    line("Hold: none")
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
line("Restart the service", "bash=%s param1=restart terminal=false refresh=true" % ONAIR)
line("Stop the service", "bash=%s param1=stop terminal=false refresh=true" % ONAIR)
line("Show the log", "bash=%s param1=logs terminal=true" % ONAIR)
line("Refresh now", "refresh=true")

print("\n".join(out))
PY
