#!/usr/bin/env bash
# Exercises `onair ui`, with no sudo, nothing installed and $HOME untouched.
#
# WHY THIS EXISTS: the verb is mostly printing, but the one piece of logic in it is the
# order the panel's host is resolved in - env overlay first, config document second. That
# order is not arbitrary: the overlay is what the SERVICE would honour (D-14), so resolving
# the document first would print a URL for a device the daemon is not actually driving.
#
# Run: deploy/test-ui.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '       %s\n' "$2"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

ONAIR_LIB_ONLY=1 . "$HERE/onair"
set +e +o pipefail

SCRATCH="$(mktemp -d /tmp/onair-test-ui.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/.onair"
TARGET_HOME="$SCRATCH"
CONFIG_FILE="$SCRATCH/.onair/config.env"
ONAIR_PORT=8484

echo "== no device configured =="
: > "$CONFIG_FILE"
printf '{"light":{}}' > "$SCRATCH/.onair/config.json"
out="$(cmd_ui 2>&1)"
check "prints the console"        "$(printf '%s\n' "$out" | grep -c 'http://localhost:8484/$')" "1"
check "prints the display"        "$(printf '%s\n' "$out" | grep -c '/display')" "1"
check "says so rather than inventing a URL" \
  "$(printf '%s\n' "$out" | grep -c 'no device configured')" "1"

echo
echo "== the document names a device =="
printf '{"light":{"host":"10.0.0.9"}}' > "$SCRATCH/.onair/config.json"
out="$(cmd_ui 2>&1)"
check "panel status page"         "$(printf '%s\n' "$out" | grep -c 'http://10.0.0.9/onair$')" "1"
check "panel config page"         "$(printf '%s\n' "$out" | grep -c 'http://10.0.0.9/onair/config$')" "1"

echo
echo "== the overlay wins over the document =="
# D-14: a value in the overlay is what the SERVICE uses, so it is what the URL must name.
# Getting this backwards would print a plausible URL for the wrong box.
printf 'ONAIR_LIGHT_HOST="10.0.0.99"\n' > "$CONFIG_FILE"
out="$(cmd_ui 2>&1)"
check "the overlay's host is the one printed" \
  "$(printf '%s\n' "$out" | grep -c 'http://10.0.0.99/onair$')" "1"
check "and the document's is not"  "$(printf '%s\n' "$out" | grep -c '10.0.0.9/onair$')" "0"

echo
echo "== a malformed document is not an error =="
# `ui` is what someone runs when they are lost. It must not be the second thing that breaks.
printf 'not json at all' > "$SCRATCH/.onair/config.json"
: > "$CONFIG_FILE"
out="$(cmd_ui 2>&1)"; rc=$?
check "still exits 0"              "$rc" "0"
check "and still prints the console" "$(printf '%s\n' "$out" | grep -c 'http://localhost:8484/$')" "1"

echo
echo "== arguments =="
( cmd_ui --nonsense ) >/dev/null 2>&1
check "an unknown argument is refused" "$?" "1"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
