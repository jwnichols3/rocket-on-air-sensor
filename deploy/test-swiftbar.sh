#!/usr/bin/env bash
# Exercises the SwiftBar plugin against a FAKE on-air service, so the real one is untouched.
#
# WHY THIS EXISTS: the plugin is a renderer, so THE BUSY RULE (D-32) applies to it. The
# failure to design against is a menu bar that looks calm when the truth is unknown, stale or
# unreachable - "false OFF is worse than false ON". That is asserted below for all three.
#
# It also pins the output sanitising. `message` is 200 characters of operator text and
# SwiftBar splits a line on `|`, so an unsanitised message could inject menu parameters.
#
# Run: deploy/test-swiftbar.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$HERE/swiftbar/onair.5s.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '       %s\n' "$2"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "deploy/test-swiftbar.sh: SKIPPED - the plugin targets macOS"
  exit 0
fi

SCRATCH="$(mktemp -d /tmp/onair-test-swiftbar.XXXXXX)"
FAKE_PID=""
cleanup() { [[ -n "$FAKE_PID" ]] && kill "$FAKE_PID" 2>/dev/null; wait "$FAKE_PID" 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT

# A free port, so this never collides with the real service on 8484.
PORT="$(/usr/bin/python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"

# --- a fake on-air service, driven by a JSON file on disk -----------------------------
cat > "$SCRATCH/fake.py" <<'FAKE'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        d = json.load(open(STATE))
        body = d.get(self.path.split("?")[0])
        if body is None:
            self.send_response(404); self.end_headers(); return
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
FAKE

write_state() { cat > "$SCRATCH/state.json"; }

# HOME is redirected into the scratch dir. The plugin keeps its last-successful-contact
# record under ~/.onair (D-91: the thresholds are measured from OUR clock, and a process that
# lives five seconds has to write that down somewhere). Without this the suite would both
# read and WRITE the operator's real ~/.onair, and every test below would inherit whatever
# the real menu bar last saw.
export FAKE_HOME="$SCRATCH/home"
mkdir -p "$FAKE_HOME/.onair"
CONTACT="$FAKE_HOME/.onair/swiftbar-contact.json"
forget_contact() { rm -f "$CONTACT"; }
# Rewrite the recorded contact time to N seconds ago, leaving the remembered reading intact.
age_contact() {
  /usr/bin/python3 - "$CONTACT" "$1" <<'AGE'
import json, sys, time
path, secs = sys.argv[1], int(sys.argv[2])
d = json.load(open(path))
d["at"] = time.time() - secs
json.dump(d, open(path, "w"))
AGE
}
run_plugin() { HOME="$FAKE_HOME" ONAIR_PORT="$PORT" ONAIR_LIGHT_HOST="${HOSTILE_HOST:-10.0.0.5}" "$PLUGIN"; }
title() { run_plugin | head -1; }

# --- reading the menu bar icon --------------------------------------------------------
# The menu bar carries an ON AIR SIGN, not words, so these assertions decode the PNG rather
# than grep for a marker character. That is not a workaround; it is the only way to assert
# the property that matters. THE BUSY RULE is about what the operator SEES, and what the
# operator sees is now a picture.
#
# `icon` prints the sign's opaque colours, sorted and deduplicated:
#   one colour  -> the sign is UNLIT. Outline and letters only, nothing behind them. This is
#                  the picture reserved for "no state": no data, no service.
#   two colours -> the sign is LIT, in the row's own `color` on its own `bgcolor`.
# `none` means no image reached the menu bar at all, which is the blank menu bar this plugin
# exists to prevent.
cat > "$SCRATCH/icon.py" <<'ICON'
import base64, re, struct, sys, zlib

line = sys.stdin.readline()
match = re.search(r"image=([A-Za-z0-9+/=]+)", line)
if not match:
    print("none")
    raise SystemExit(0)

data = base64.b64decode(match.group(1))
pos, idat, width, height = 8, b"", 0, 0
while pos < len(data):
    length = struct.unpack(">I", data[pos:pos + 4])[0]
    tag = data[pos + 4:pos + 8]
    if tag == b"IHDR":
        width, height = struct.unpack(">II", data[pos + 8:pos + 16])
    elif tag == b"IDAT":
        idat += data[pos + 8:pos + 8 + length]
    pos += 12 + length

raw = zlib.decompress(idat)
stride, offset, seen = width * 4, 0, set()
for _ in range(height):
    assert raw[offset] == 0, "the encoder must not filter"
    offset += 1
    row = raw[offset:offset + stride]
    offset += stride
    for x in range(width):
        r, g, b, a = row[x * 4:x * 4 + 4]
        if a == 255:
            seen.add("#%02x%02x%02x" % (r, g, b))
print(" ".join(sorted(seen)))
ICON
icon() { run_plugin | head -1 | /usr/bin/python3 "$SCRATCH/icon.py"; }

# ---------------------------------------------------------------------------------------
echo "== the service is unreachable =="
# No fake server running yet. This is the highest-severity case: the menu bar must not look
# calm, and must not look blank either.
t="$(title)"
check "the menu bar is not blank"             "$([[ -n "$t" ]] && echo yes || echo no)" "yes"
check "an icon reaches the menu bar"          "$([[ "$(icon)" == "none" ]] && echo no || echo yes)" "yes"
# ONE colour: the sign is unlit. It cannot be read as any state the operator has configured,
# whatever colours they chose for it.
check "the sign is unlit"                     "$(icon)" "#e8a317"
check "and says so in words on opening"       "$(run_plugin | grep -c '^NO SERVICE')" "1"
check "still offers a way to start it"        "$(run_plugin | grep -c 'param1=start')" "1"

/usr/bin/python3 "$SCRATCH/fake.py" "$PORT" "$SCRATCH/state.json" >/dev/null 2>&1 &
FAKE_PID=$!

echo
echo "== busy =="
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":null,"ageSeconds":2,
              "source":"auto:vcrec","confirmed":"on-air","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"on-air","label":"On air","color":"#ffffff","bgcolor":"#c1121f","busy":false,"order":0}]}}
JSON
sleep 0.4
check "the sign is lit"                       "$(icon)" "#c1121f #ffffff"
check "in the row's own colours, both halves" "$(icon)" "#c1121f #ffffff"
check "and the words are one click away"      "$(run_plugin | grep -c '^ON AIR | size=14')" "1"

echo
echo "== calm and fresh =="
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":3,
              "source":"auto:vcrec","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
check "the sign is lit, in the calm colour"   "$(icon)" "#0b6e2e #ffffff"
check "and it is not the busy colour"         "$(icon | grep -c '#c1121f')" "0"

echo
echo "== THE BUSY RULE: calm but UNREFRESHED must not read as calm =="
# The rule is unchanged; what triggers it moved from the write's age to OUR connection
# (D-91). So the setup is a good reading followed by a link that stops answering, rather
# than a fresh reading carrying a big ageSeconds.
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"hold":null,"ageSeconds":4,
              "source":"auto:vcrec","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
run_plugin >/dev/null
write_state <<'JSON'
[1, 2, 3]
JSON
age_contact 120
check "the sign goes unlit"                   "$(icon)" "#8e8e93"
check "so the calm colour is nowhere on it"   "$(icon | grep -c '#0b6e2e')" "0"
check "and it says NO DATA on opening"        "$(run_plugin | grep -c '^NO DATA')" "1"
forget_contact

echo "-- and an unrefreshed BUSY row is still busy: it never gets calmer --"
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"hold":null,"ageSeconds":4,
              "source":"auto:vcrec","confirmed":"unknown","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"on-air","label":"On air","color":"#ffffff","bgcolor":"#c1121f","busy":false,"order":0}]}}
JSON
run_plugin >/dev/null
write_state <<'JSON'
[1, 2, 3]
JSON
age_contact 120
check "unrefreshed busy is still lit, still red" "$(icon)" "#c1121f #ffffff"
forget_contact

echo
echo "== the reserved unknown row is never calm (D-34) =="
write_state <<'JSON'
{"/status":  {"state":"unknown","busy":true,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:vcrec","confirmed":"unknown","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"unknown","label":"Unknown","color":"#ffffff","bgcolor":"#555555","busy":false,"order":0}]}}
JSON
check "the sign goes unlit"                   "$(icon)" "#8e8e93"
check "even though the row has a colour"      "$(icon | grep -c '#555555')" "0"

echo
echo "== a pin is reported as a pinned ROW, not a person =="
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":"on-air","ageSeconds":1,
              "source":"human:rocket","confirmed":"on-air","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"on-air","label":"On air","color":"#ffffff","bgcolor":"#c1121f","busy":false,"order":0}]}}
JSON
check "names the pinned row"                  "$(run_plugin | grep -c 'Pinned to: on-air')" "1"
# reset-state also clears the message and restarts the service - far more than "release".
check "does not offer reset-state as release" "$(run_plugin | grep -c 'param1=reset-state')" "0"

echo
echo "== output injection: message is 200 chars of operator text =="
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":null,"ageSeconds":1,
              "source":"human:a|b","confirmed":"on-air",
              "message":"HI | color=#ff0000 bash=/bin/rm param1=-rf\nsecond line"},
 "/config/states": {"version":1,"states":[
   {"id":"on-air","label":"On|air","color":"#ffffff","bgcolor":"#c1121f","busy":false,"order":0}]}}
JSON
out="$(run_plugin)"
# The property that matters is NOT that the string `bash=` is absent - SwiftBar only parses
# parameters AFTER a `|`, so injected text on a line with no `|` is inert. What must hold is
# that every parameter-position `bash=` points at our own script. Asserted directly, because
# the weaker "does the string appear" check passes for the wrong reason.
check "every bash= parameter points at onair"  \
  "$(printf '%s' "$out" | grep '|' | grep -oE 'bash="[^"]+"' | grep -vc 'deploy/onair"$')" "0"
check "no pipe survives in the message line"   "$(printf '%s' "$out" | grep 'Message:' | grep -c '|')" "0"
check "so the message line carries no params"  "$(printf '%s' "$out" | grep -c '^Message:.*|')" "0"
check "a newline cannot add a menu line"       "$(printf '%s' "$out" | grep -c '^second line')" "0"
check "a pipe in the label cannot split a line" "$(printf '%s' "$out" | grep -c '^ON/AIR | size=14')" "1"

echo
echo "== a malformed colour never reaches a parameter =="
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"red; rm -rf /","busy":false,"order":0}]}}
JSON
# A row this script cannot paint faithfully is one it will not paint. The alternative -
# painting the sign in a default colour - would put a colour on the menu bar that the
# operator never chose, which is a renderer inventing evidence.
check "the sign goes unlit rather than guess" "$(icon)" "#8e8e93"
check "and the menu bar is still not blank"   "$([[ "$(icon)" == "none" ]] && echo no || echo yes)" "yes"
check "the dropdown says why, in words"       "$(run_plugin | grep -c '^NO DATA')" "1"

echo
echo "== the host is a parameter value, so it is a command-injection surface =="
# `light.host` is validated by the server only as a non-empty string and is writable via
# PUT /admin/config. It lands in an `href=` PARAMETER, and SwiftBar splits parameters on
# whitespace - so spaces in it become further parameters, including `bash=`.
#
# THE FIXTURE IS THE POINT. This suite already asserted "every bash= points at onair", and
# that assertion was correct - it just never saw a hostile host, because run_plugin
# hardcoded a safe one. An assertion is only as good as the worst input it is given.
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
out="$(HOSTILE_HOST='h bash=/bin/sh param1=-c param2=whoami terminal=false' run_plugin)"
check "no injected bash= parameter"           \
  "$(printf '%s' "$out" | grep '|' | grep -oE 'bash="[^"]+"' | grep -vc 'deploy/onair')" "0"
check "the hostile host is dropped entirely"  "$(printf '%s' "$out" | grep -c 'Panel status')" "0"
# Anchored: the settings link ends in /onair/config and matches a bare substring too.
check "a good host is still linked"           "$(run_plugin | grep -c 'href=http://10.0.0.5/onair$')" "1"

echo
echo "== a dead renderer says so; it never goes blank =="
# Blank IS the false OFF. Any unhandled exception, or a /usr/bin/python3 that is a stub on a
# Mac without Command Line Tools, would otherwise emit nothing at all.

# First establish contact on a good reading, so there is something to hold.
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"hold":null,"ageSeconds":3,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
run_plugin >/dev/null

write_state <<'JSON'
[1, 2, 3]
JSON
# The fake serves whatever is in the file, so /status now answers with an ARRAY. An array is
# not a status object, so `get()` refuses it and this counts as a FAILED POLL - not as
# contact. Something is answering the port and it is not the on-air service.
out="$(run_plugin)"
check "still prints a title"                  "$([[ -n "$out" ]] && echo yes || echo no)" "yes"
check "an icon still reaches the menu bar"    "$([[ "$(icon)" == "none" ]] && echo no || echo yes)" "yes"
# CONDITION 2 (D-91). One failed poll does not move the picture - the state is latched at the
# server and we heard it three seconds ago. Giving up here is the over-eager NO DATA this
# whole change removes.
check "the last known state is HELD"          "$(icon)" "#0b6e2e #ffffff"
check "and the dropdown says the poll failed" "$(printf '%s' "$out" | grep -c 'This poll got no answer')" "1"
check "but it does NOT claim to be current"   "$(printf '%s' "$out" | grep -c '^NO SERVICE')" "0"

# ...and once the grace window passes, the same dead renderer escalates.
age_contact 120
check "past a minute it says NOT REFRESHING"  "$(run_plugin | grep -c '^NOT REFRESHING')" "1"
check "and a CALM row goes unlit"             "$(icon)" "#8e8e93"

# ...and past the second threshold it stops claiming a state at all.
age_contact 1900
check "past thirty minutes it gives up"       "$(run_plugin | grep -c '^NO SERVICE')" "1"
check "and says how long it has been"         "$(run_plugin | grep -c 'has been discarded')" "1"
check "the sign is the unreachable one"       "$(icon)" "#e8a317"

# FAIL CLOSED: with no usable memory of contact there is no way to bound how long we have
# been out of touch, so no state is claimed. This is D-64.3's lesson moved somewhere it
# cannot be undone by anything the server sends.
forget_contact
check "no contact record means NO SERVICE"    "$(run_plugin | grep -c '^NO SERVICE')" "1"
check "and the sign is unlit"                 "$(icon)" "#e8a317"

# A record from the FUTURE is a clock that moved, not evidence of contact.
printf '{"at": 99999999999, "status": {"state":"available","busy":false}}' > "$CONTACT"
check "a future-dated record is refused"      "$(run_plugin | grep -c '^NO SERVICE')" "1"
printf 'not json at all' > "$CONTACT"
check "an unreadable record is refused"       "$(run_plugin | grep -c '^NO SERVICE')" "1"
forget_contact

echo
echo "== liveness is OUR CLOCK, never anything the server says (D-91) =="
# THE HEADLINE. The plugin used to derive `ageSeconds > 90` and go grey on it, so a calm
# state nobody had rewritten in an hour drew NO DATA while the service was healthy and
# answering every five seconds. It is the state. Draw it.
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"hold":null,"ageSeconds":99999,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
check "a 27-hour-old write on a LIVE link is drawn" "$(icon)" "#0b6e2e #ffffff"
check "and nothing claims it is not refreshing"     "$(run_plugin | grep -c '^NOT REFRESHING')" "0"

# ageSeconds is display text now and carries no decision, so its absence costs a dropdown
# line and cannot change the picture.
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"hold":null,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
check "a MISSING ageSeconds changes nothing"        "$(icon)" "#0b6e2e #ffffff"
check "it just says the write time is unknown"      "$(run_plugin | grep -c '^Last write: unknown')" "1"

# There is no `stale` field on the wire any more. One arriving - from version skew, or from
# something else answering the port - must not be able to influence anything.
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":true,"hold":null,"ageSeconds":4,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
check "a resurrected stale flag is ignored"         "$(icon)" "#0b6e2e #ffffff"
check "no bare 90 threshold survives in the plugin" "$(grep -c 'STALE_SECONDS' "$PLUGIN")" "0"

# THE ASYMMETRY SURVIVES (D-82), with the trigger moved to the connection: an unrefreshed
# CALM row loses its colours, an unrefreshed BUSY row keeps them. Draining a busy signal
# weakens it, and false OFF is worse than false ON.
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"hold":null,"ageSeconds":4,
              "source":"auto:x","confirmed":"on-air","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"on-air","label":"On Air","color":"#ffffff","bgcolor":"#c1121f","busy":true,"order":0}]}}
JSON
run_plugin >/dev/null
write_state <<'JSON'
[1, 2, 3]
JSON
age_contact 120
check "an unrefreshed BUSY row KEEPS its colours"   "$(icon)" "#c1121f #ffffff"
check "and is still marked in words"                "$(run_plugin | grep -c '^NOT REFRESHING')" "1"
forget_contact

echo
echo "== the look is looked up by row id, never borrowed =="
# The state and the colours arrive in two different responses, so the risk is pairing one
# row's semantics with another row's paint. The old renderer read the colours from
# /public/status and could only DETECT a mismatch and give up. Matching the row by its id in
# the table makes the mismatch impossible instead of merely visible - and it is what the
# contract tells a client with a table to do.
#
# Here /status names a row the table does not contain at all.
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"on-air","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
check "no colour is borrowed from another row" "$(icon | grep -c '#0b6e2e')" "0"
check "the sign goes unlit instead"            "$(icon)" "#8e8e93"
check "and the dropdown falls back to the id"  "$(run_plugin | grep -c 'State: on-air')" "1"

# ...and the row is matched on id, not on position, so reordering the table cannot repaint
# the sign. `on-air` is last here and its colours must still be the ones that are drawn.
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"on-air","message":null},
 "/config/states": {"version":9,"states":[
   {"id":"recording","label":"Recording","color":"#ffffff","bgcolor":"#6a0dad","busy":true,"order":0},
   {"id":"available","label":"Available","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":1},
   {"id":"on-air","label":"On air","color":"#1a1a1a","bgcolor":"#c1121f","busy":true,"order":2}]}}
JSON
check "the row's own colours, from anywhere in the table" "$(icon)" "#1a1a1a #c1121f"

echo
echo "== labels are operator text, and land at column 0 =="
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"   ","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
# A label of three spaces is legal - the server validates length, never content - and would
# otherwise erase the state word from the menu bar entirely.
check "a whitespace label falls back to the id" "$(run_plugin | grep -c '^AVAILABLE | size=14')" "1"
check "and the sign is unaffected either way"   "$(icon)" "#0b6e2e #ffffff"

write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"available","message":null},
 "/config/states": {"version":1,"states":[
   {"id":"available","label":"--Sub","color":"#ffffff","bgcolor":"#0b6e2e","busy":false,"order":0}]}}
JSON
# SwiftBar reads a leading `--` as a submenu child rather than a top-level line.
# `---` is SwiftBar's own separator. What must not appear is a line starting with exactly
# two dashes, which SwiftBar reads as a submenu child.
check "no menu line begins with --"            "$(run_plugin | grep -cE '^--([^-]|$)')" "0"

echo
echo "== the icon is small, and it is a 2x bitmap =="
# The FOOTPRINT is a requirement, not a detail: the sign replaced words precisely because
# words took too much room in the menu bar. A menu bar item is about 22 points tall, so the
# sign has to stay well inside that and stay narrower than the label it replaced.
#
# The pHYs chunk is what makes the point size half the pixel size. Lose it and AppKit reads
# the bitmap at 72 DPI, the sign doubles to 64x22 POINTS, and it is suddenly the widest
# thing in the menu bar.
cat > "$SCRATCH/geom.py" <<'GEOM'
import base64, re, struct, sys

match = re.search(r"image=([A-Za-z0-9+/=]+)", sys.stdin.readline())
data = base64.b64decode(match.group(1))
pos, size, dpi = 8, None, None
while pos < len(data):
    length = struct.unpack(">I", data[pos:pos + 4])[0]
    tag = data[pos + 4:pos + 8]
    if tag == b"IHDR":
        size = struct.unpack(">II", data[pos + 8:pos + 16])
    elif tag == b"pHYs":
        px_per_m, _, unit = struct.unpack(">IIB", data[pos + 8:pos + 17])
        dpi = round(px_per_m * 0.0254) if unit == 1 else None
    pos += 12 + length
scale = 2 if dpi == 144 else 1
print("%dx%d px @ %s dpi = %dx%d pt" % (size[0], size[1], dpi, size[0] // scale, size[1] // scale))
GEOM
geom() { run_plugin | head -1 | /usr/bin/python3 "$SCRATCH/geom.py"; }
check "a 2x bitmap that declares its own scale" "$(geom)" "64x22 px @ 144 dpi = 32x11 pt"

echo
echo "== the action paths survive a checkout containing a space =="
check "bash= values are quoted"                "$(run_plugin | grep -c 'bash="')" "3"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
