#!/usr/bin/env bash
# Exercises `onair setup`, with no sudo, nothing installed and $HOME untouched.
#
# WHY THIS EXISTS: `setup` rewrites ~/.onair/config.env, and that file is an
# env OVERLAY (D-50) whose ONAIR_TOKEN overrides auth.passphrase in the config document
# (D-14, server/src/app.ts). Writing a token here pinned the passphrase, so a rotation done
# in the admin console survived only until the next restart (#47).
#
# Measuring that turned up a worse, older bug in the same function: it rewrote the file from
# scratch, so one run DELETED every key it did not know about. Against a copy of this
# host's real overlay that meant ONAIR_LIGHT_HOST/ENTITY/USER/PASS - the four lines that
# actually hold the device credential here (D-56).
#
# Three properties pinned below, all of the same shape: `setup` must never WRITE an
# ONAIR_TOKEN line, must never DELETE one somebody put there on purpose, and must never
# delete anything else either.
#
# Run: deploy/test-setup.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '       %s\n' "$2"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

ONAIR_LIB_ONLY=1 . "$HERE/onair"
set +e +o pipefail

SCRATCH="$(mktemp -d /tmp/onair-test-setup.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

# Point the whole thing at scratch. TARGET_USER stays the real one so `install -o` works
# without privilege; nothing here writes outside $SCRATCH.
TARGET_HOME="$SCRATCH"
CONFIG_FILE="$SCRATCH/.onair/config.env"

# The daemon is down, so setup prints its advice and does not try to restart anything.
health_check_once() { return 1; }

run_setup() { ( cmd_setup --non-interactive ) >/dev/null 2>&1; }
# grep -c prints its count AND exits 1 when the count is zero; `|| true` swallows the
# status without adding a second line of output.
token_lines() { grep -c '^ONAIR_TOKEN=' "$CONFIG_FILE" 2>/dev/null || true; }

echo "== a fresh host =="
rm -rf "$SCRATCH/.onair"
ONAIR_PORT=8484 run_setup
check "writes the port"                 "$(grep -c '^ONAIR_PORT=' "$CONFIG_FILE")" "1"
check "writes the state file"           "$(grep -c '^ONAIR_STATE_FILE=' "$CONFIG_FILE")" "1"
check "writes NO token line"            "$(token_lines)" "0"
check "and says where the passphrase actually lives" \
  "$(grep -c 'config.json' "$CONFIG_FILE")" "1"

echo
echo "== a host that already overrides the passphrase on purpose =="
rm -rf "$SCRATCH/.onair"; mkdir -p "$SCRATCH/.onair"
printf 'ONAIR_PORT="9999"\nONAIR_TOKEN="deliberate-escape-hatch"\n' > "$CONFIG_FILE"
ONAIR_PORT=8484 run_setup
check "the existing token line survives" "$(token_lines)" "1"
check "byte for byte" \
  "$(grep '^ONAIR_TOKEN=' "$CONFIG_FILE")" 'ONAIR_TOKEN="deliberate-escape-hatch"'
check "and the file says what such a line does" \
  "$(grep -c 'keep reverting a rotation' "$CONFIG_FILE")" "1"

echo
echo "== keys setup does not own are not collateral =="
rm -rf "$SCRATCH/.onair"; mkdir -p "$SCRATCH/.onair"
cat > "$CONFIG_FILE" <<'PRE'
# a comment the operator wrote
ONAIR_PORT="9999"
ONAIR_LIGHT_HOST="10.42.12.77"
ONAIR_LIGHT_USER="rocket"
ONAIR_LIGHT_PASS="not-a-real-one"
ONAIR_LIGHT_ENTITY="PresenceKey"
PRE
ONAIR_PORT=8484 run_setup
for k in ONAIR_LIGHT_HOST ONAIR_LIGHT_USER ONAIR_LIGHT_PASS ONAIR_LIGHT_ENTITY; do
  check "$k survives"                   "$(grep -c "^$k=" "$CONFIG_FILE")" "1"
done
check "so does the operator's comment"  "$(grep -c "a comment the operator wrote" "$CONFIG_FILE")" "1"
check "the managed port is rewritten"   "$(grep '^ONAIR_PORT=' "$CONFIG_FILE")" 'ONAIR_PORT="8484"'
check "and not duplicated"              "$(grep -c '^ONAIR_PORT=' "$CONFIG_FILE")" "1"

# Idempotence, asserted on the WHOLE FILE and not just the marker. The earlier version
# counted `managed by`, which appears once - while the ten-line header ABOVE the marker was
# appended again on every run, because the marker-based strip could not reach it. The file
# grew by ten lines a run and the test was green. Compare bytes.
ONAIR_PORT=8484 run_setup
before="$(cat "$CONFIG_FILE")"
ONAIR_PORT=8484 run_setup
ONAIR_PORT=8484 run_setup
check "three more runs change nothing at all" \
  "$([[ "$before" == "$(cat "$CONFIG_FILE")" ]] && echo identical || echo CHANGED)" "identical"
check "one header, not one per run"     "$(grep -c 'the onair ENV OVERLAY' "$CONFIG_FILE")" "1"
check "one managed marker"              "$(grep -c 'managed by' "$CONFIG_FILE")" "1"
check "nor the carried keys"            "$(grep -c '^ONAIR_LIGHT_HOST=' "$CONFIG_FILE")" "1"

echo
echo "== the environment must not leak into the file =="
# read_config prefers a real env var. If setup carried the token forward through it, a
# token exported for one invocation would become permanent - a per-run override silently
# promoted to a stored one.
rm -rf "$SCRATCH/.onair"
ONAIR_PORT=8484 ONAIR_TOKEN="exported-for-this-shell-only" run_setup
check "an exported ONAIR_TOKEN is not written to disk" "$(token_lines)" "0"

echo
echo "== the first-run path install depends on =="
# cmd_install calls this when config.env is absent. It must write the file and return
# WITHOUT restarting anything - install does its own bootstrap afterwards.
rm -rf "$SCRATCH/.onair"
( ONAIR_PORT=8484 cmd_setup __internal_from_install__ ) >/dev/null 2>&1
check "returns 0 for install"           "$?" "0"
check "and left a config behind"        "$(grep -c '^ONAIR_PORT=' "$CONFIG_FILE")" "1"
check "still with no token line"        "$(token_lines)" "0"

echo
echo "== the help text no longer advertises the overlay as the front door =="
check "setup is not described as asking about a token" \
  "$(usage 2>&1 | grep -c 'port/token/state file')" "0"
check "and the overlay is named as an overlay" \
  "$(usage 2>&1 | grep -ci 'overlay')" "2"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
