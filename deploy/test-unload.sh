#!/usr/bin/env bash
# Exercise launchd's asynchronous removal without touching a real service.
set -euo pipefail
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d /tmp/onair-unload-tests.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
ONAIR_CONFIG="$SCRATCH/none.env"
ONAIR_LIB_ONLY=1 . "$HERE/onair"
printf '0\n' > "$SCRATCH/polls"
sudo_launchctl() {
  [[ "$1" == print ]] || return 99
  local n
  n="$(cat "$SCRATCH/polls")"
  n=$((n+1)); printf '%s\n' "$n" > "$SCRATCH/polls"
  if (( n < 3 )); then echo 'state = SIGTERMed'; return 0; fi
  echo 'Bad request. Could not find service "com.rocket.onair" in domain for system' >&2
  return 113
}
wait_for_unload
[[ "$(cat "$SCRATCH/polls")" == 3 ]]
echo 'ok: waits through removal before accepting absent service'
sudo_launchctl() { echo 'Operation not permitted' >&2; return 1; }
if wait_for_unload >/dev/null 2>&1; then echo 'FAIL: permission failure was mistaken for removal' >&2; exit 1; fi
echo 'ok: permission failure is not absence'
if wait_for_unload 0 >/dev/null 2>&1; then echo 'FAIL: timeout was ignored' >&2; exit 1; fi
echo 'ok: bounded timeout returns failure'
