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

run_plugin() { ONAIR_PORT="$PORT" ONAIR_LIGHT_HOST="10.0.0.5" "$PLUGIN"; }
title() { run_plugin | head -1; }

# ---------------------------------------------------------------------------------------
echo "== the service is unreachable =="
# No fake server running yet. This is the highest-severity case: the menu bar must not look
# calm, and must not look blank either.
t="$(title)"
check "does not render an empty title"        "$([[ -n "$t" ]] && echo yes || echo no)" "yes"
check "does not claim a state"                "$(printf '%s' "$t" | grep -cE '○|●')" "0"
check "says something is wrong"               "$(printf '%s' "$t" | grep -c '⚠')" "1"
check "still offers a way to start it"        "$(run_plugin | grep -c 'param1=start')" "1"

/usr/bin/python3 "$SCRATCH/fake.py" "$PORT" "$SCRATCH/state.json" >/dev/null 2>&1 &
FAKE_PID=$!

echo
echo "== busy =="
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":null,"ageSeconds":2,
              "source":"auto:vcrec","confirmed":"on-air","message":null},
 "/public/status": {"state":"on-air","label":"On air","bgcolor":"#c1121f"}}
JSON
sleep 0.4
check "filled marker"                         "$(title | grep -c '●')" "1"
check "shows the row label, upper case"       "$(title | grep -c 'ON AIR')" "1"
check "carries the row colour"                "$(title | grep -c 'color=#c1121f')" "1"

echo
echo "== calm and fresh =="
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":3,
              "source":"auto:vcrec","confirmed":"available","message":null},
 "/public/status": {"state":"available","label":"Available","bgcolor":"#0b6e2e"}}
JSON
check "hollow marker, not filled"             "$(title | grep -c '○')" "1"
check "and not the busy marker"               "$(title | grep -c '●')" "0"

echo
echo "== THE BUSY RULE: calm but STALE must not read as calm =="
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":true,"hold":null,"ageSeconds":400,
              "source":"auto:vcrec","confirmed":"available","message":null},
 "/public/status": {"state":"available","label":"Available","bgcolor":"#0b6e2e"}}
JSON
check "draws NO DATA"                         "$(title | grep -c 'NO DATA')" "1"
check "and no calm marker"                    "$(title | grep -c '○')" "0"

echo "-- and a stale BUSY row is still busy: staleness never makes it calmer --"
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":true,"hold":null,"ageSeconds":400,
              "source":"auto:vcrec","confirmed":"unknown","message":null},
 "/public/status": {"state":"on-air","label":"On air","bgcolor":"#c1121f"}}
JSON
check "stale busy still shows busy"           "$(title | grep -c '●')" "1"

echo
echo "== the reserved unknown row is never calm (D-34) =="
write_state <<'JSON'
{"/status":  {"state":"unknown","busy":true,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:vcrec","confirmed":"unknown","message":null},
 "/public/status": {"state":"unknown","label":"Unknown","bgcolor":"#555555"}}
JSON
check "draws NO DATA"                         "$(title | grep -c 'NO DATA')" "1"

echo
echo "== a pin is reported as a pinned ROW, not a person =="
write_state <<'JSON'
{"/status":  {"state":"on-air","busy":true,"stale":false,"hold":"on-air","ageSeconds":1,
              "source":"human:rocket","confirmed":"on-air","message":null},
 "/public/status": {"state":"on-air","label":"On air","bgcolor":"#c1121f"}}
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
 "/public/status": {"state":"on-air","label":"On|air","bgcolor":"#c1121f"}}
JSON
out="$(run_plugin)"
# The property that matters is NOT that the string `bash=` is absent - SwiftBar only parses
# parameters AFTER a `|`, so injected text on a line with no `|` is inert. What must hold is
# that every parameter-position `bash=` points at our own script. Asserted directly, because
# the weaker "does the string appear" check passes for the wrong reason.
check "every bash= parameter points at onair"  \
  "$(printf '%s' "$out" | grep '|' | grep -oE 'bash=[^ ]+' | grep -vc "bash=.*deploy/onair$")" "0"
check "no pipe survives in the message line"   "$(printf '%s' "$out" | grep 'Message:' | grep -c '|')" "0"
check "so the message line carries no params"  "$(printf '%s' "$out" | grep -c '^Message:.*|')" "0"
check "a newline cannot add a menu line"       "$(printf '%s' "$out" | grep -c '^second line')" "0"
check "a pipe in the label does not split it"  "$(printf '%s' "$out" | head -1 | grep -c 'ON/AIR')" "1"

echo
echo "== a malformed colour never reaches a parameter =="
write_state <<'JSON'
{"/status":  {"state":"available","busy":false,"stale":false,"hold":null,"ageSeconds":1,
              "source":"auto:x","confirmed":"available","message":null},
 "/public/status": {"state":"available","label":"Available","bgcolor":"red; rm -rf /"}}
JSON
check "bad colour is dropped, not passed on"  "$(title | grep -c 'color=')" "0"
check "and the title still renders"           "$(title | grep -c '○ Available')" "1"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
