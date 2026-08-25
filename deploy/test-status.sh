#!/usr/bin/env bash
# Exercises `onair status`, with no sudo, nothing installed and /Library untouched.
#
# WHY THIS EXISTS: `status` is the thing an agent, a supervisor script or a person at 2am
# asks whether the daemon is alive, and it has an EXIT CODE that other things act on. It
# reported a live, launchd-supervised service as `supervised: no` whenever it could not
# get a sudo ticket (#45) - not a display bug, because that string is half the failure
# condition. The distinction it now draws (asked-and-no vs could-not-ask) is exactly the
# kind that rots silently, so it is pinned here.
#
# Run: deploy/test-status.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '       %s\n' "$2"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

# Source the functions without dispatching a verb. `onair` sets -e for its own safety,
# which would abort this script the first time a predicate answers "no".
ONAIR_LIB_ONLY=1 . "$HERE/onair"
set +e +o pipefail

# --- stubs -------------------------------------------------------------------------
# A shell function shadows the external command, so cmd_status's `sudo -n ...` lands here
# without the test needing any privilege at all.
SUDO_MODE=ok
sudo() {
  case "$SUDO_MODE" in
    ok)
      cat <<'PRINT'
system/com.rocket.onair = {
	state = running
	pid = 4242
	last exit code = 0
	disabled = 0
}
PRINT
      return 0 ;;
    noticket)
      # What sudo -n actually says with no cached ticket. The `sudo: ` prefix is the
      # signal; the rest of the sentence is not matched on, deliberately.
      echo "sudo: a password is required" >&2
      return 1 ;;
    notloaded)
      # sudo ran fine; launchctl answered. No `sudo: ` anywhere.
      echo "Could not find service \"com.rocket.onair\" in domain for system" >&2
      return 113 ;;
  esac
}

RESPONDING=0
health_check_once() { return "$RESPONDING"; }

status_line() { SUDO_MODE="$1" RESPONDING="$2" cmd_status 2>/dev/null | sed -n '1p'; }
status_code() { SUDO_MODE="$1" RESPONDING="$2" cmd_status >/dev/null 2>&1; echo "$?"; }
# 0 = healthy for health_check_once's return-code convention.

echo "== the three supervision states =="

check "sudo answers and launchd knows the job -> yes" \
  "$(status_line ok 0 | cut -d' ' -f1-2)" "supervised: yes"

check "the detail fields are read from launchctl print" \
  "$(status_line ok 0)" "supervised: yes (state=running pid=4242 last-exit=0 disabled=no)"

check "sudo could not be used -> unknown, not no" \
  "$(status_line noticket 0 | cut -d' ' -f1-3)" "supervised: unknown -"

check "and it says how to fix it" \
  "$(status_line noticket 0 | grep -c -- '--sudoers')" "1"

check "unknown prints no made-up detail fields" \
  "$(status_line noticket 0 | grep -c 'pid=')" "0"

check "sudo worked and launchd said no -> no" \
  "$(status_line notloaded 0 | cut -d' ' -f1-2)" "supervised: no"

echo
echo "== the exit code, which is what other things act on =="

check "supervised and responding" "$(status_code ok 0)" "0"
check "supervised but not responding is still 0 (unchanged)" "$(status_code ok 1)" "0"
check "not supervised but responding is healthy - something ran it by hand" \
  "$(status_code notloaded 0)" "0"
check "not supervised and not responding fails" "$(status_code notloaded 1)" "1"
# The regression that matters: before #45 this path reported `no` and returned 1 for the
# right answer by the wrong route. It must still return 1 now that it reports `unknown`.
check "could-not-ask and not responding still fails" "$(status_code noticket 1)" "1"
check "could-not-ask but responding is not a failure" "$(status_code noticket 0)" "0"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
