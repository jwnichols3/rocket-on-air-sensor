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

# EVERY exit path must print something. A blank menu bar is precisely the false OFF this
# plugin exists to prevent, and empty stdout is the easiest way to produce one: on a Mac
# without Command Line Tools `/usr/bin/python3` is a stub that fails, and any unhandled
# exception below yields nothing at all.
#
# Written to a file rather than captured with $( ). macOS ships bash 3.2, which mishandles a
# heredoc inside command substitution - measured, not assumed.
TMP="$(/usr/bin/mktemp -t onair.swiftbar)"
/usr/bin/python3 - "$ONAIR" <<'PY' > "$TMP" 2>/dev/null
import json, os, signal, sys, urllib.request, urllib.error

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


def line(text, *params):
    out.append(text + ((" | " + " ".join(params)) if params else ""))


if status is None:
    # NEVER a calm-looking title. We do not know, and saying so is the only honest answer -
    # a blank or green menu bar here is a false OFF with extra steps.
    line("⚠ on-air?", "color=#e8a317")
    line("---")
    line("The on-air service is not answering on %s" % base, "color=#ff8f8f")
    line("Start it", 'bash="%s" param1=start terminal=false refresh=true' % ONAIR)
    line("Restart it", 'bash="%s" param1=restart terminal=false refresh=true' % ONAIR)
    line("Show the log", 'bash="%s" param1=logs terminal=true' % ONAIR)
    print("\n".join(out))
    raise SystemExit(0)

state = safe(status.get("state") or "unknown", 64)
busy = bool(status.get("busy"))
hold = safe(status.get("hold"), 64)
message = safe(status.get("message"), 200)

# STALENESS IS DERIVED, NOT TRUSTED. The contract defines it as ageSeconds > 90, and the
# reference renderer computes it rather than reading a flag (onair_table.h, compute_view).
# Trusting `stale` fails OPEN on the calm side: any miss - a field rename, version skew,
# something else answering the port - reads as false, and false means calm. Measured:
# ageSeconds 99999 with no `stale` key drew a calm menu bar on 27-hour-old evidence.
#
# A missing or non-numeric ageSeconds is STALE. Of the two guesses only the calm one can be
# a false OFF.
STALE_SECONDS = 90
age = status.get("ageSeconds")
if isinstance(age, bool) or not isinstance(age, (int, float)):
    stale = True
    age = None
else:
    stale = age > STALE_SECONDS

# The two payloads are two requests, so a state change between them would pair one row's
# `busy` with another row's colour. Presentation is used only when both agree on the row.
same_row = bool(public) and public.get("state") == status.get("state")
label = safe((public or {}).get("label") if same_row else None, 64) or state
bgcolor = hex_color(public.get("bgcolor")) if same_row else ""

# The same three-way decision the panel makes, in the same order (compute_view, D-57).
if state == "unknown" or (stale and not busy):
    # Stale evidence cannot support a calm claim. THE BUSY RULE.
    line("NO DATA", "color=#e8a317")
elif busy:
    line("● %s" % label.upper(), *(["color=%s" % bgcolor] if bgcolor else []))
else:
    line("○ %s" % label, *(["color=%s" % bgcolor] if bgcolor else []))

line("---")
# Prefixed, so an operator-supplied label can never be the first thing on the line.
line("State: %s  (%s)" % (label, state), "size=13")
line("Busy: %s" % ("yes" if busy else "no"))
if age is None:
    line("Last write: unknown  (stale)", "color=#e8a317")
else:
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
