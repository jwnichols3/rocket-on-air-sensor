#!/usr/bin/env bash
# Native lifecycle and runtime packaging tests, no signing key or live service required.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'native runtime tests: skipped (macOS only)'
  exit 0
fi
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$HERE/mac-runtime/test_runtime.py"

SCRATCH="$(mktemp -d /tmp/onair-runtime-selection.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
ONAIR_CONFIG="$SCRATCH/config.env"
ONAIR_LIB_ONLY=1 . "$HERE/onair"
TARGET_HOME="$SCRATCH"
PLIST_PATH="$SCRATCH/current.plist"
app="$SCRATCH/Applications/On Air Receiver.app"
mkdir -p "$app/Contents/MacOS"
# Only the signature-verifier process is mocked; selection/rendering use real functions.
python3() {
  [[ "$1" == "$HERE/mac-runtime/runtime.py" && "$2" == verify && "$3" == "$app" && "${REJECT_RUNTIME:-0}" == 0 ]]
}
ONAIR_RUNTIME_APP="$app"
[[ "$(service_executable)" == "$app/Contents/MacOS/OnAirReceiver" ]]
render_plist_to "$SCRATCH/signed.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SCRATCH/signed.plist")" == "$app/Contents/MacOS/OnAirReceiver" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :AssociatedBundleIdentifiers:0' "$SCRATCH/signed.plist")" == com.rocket.onair.receiver ]]
cp "$SCRATCH/signed.plist" "$PLIST_PATH"
unset ONAIR_RUNTIME_APP
[[ "$(service_executable)" == "$app/Contents/MacOS/OnAirReceiver" ]]
if plist_is_stale "$PLIST_PATH"; then echo 'FAIL: ordinary update would discard the installed runtime' >&2; exit 1; fi
mv "$app" "$app-away"
if service_executable >/dev/null 2>&1; then echo 'FAIL: missing installed signed runtime fell back to external Node' >&2; exit 1; fi
mv "$app-away" "$app"
ONAIR_RUNTIME_APP=legacy
[[ "$(service_executable)" == "$(command -v node)" ]]
render_plist_to "$SCRATCH/legacy.plist"
cp "$SCRATCH/legacy.plist" "$PLIST_PATH"
unset ONAIR_RUNTIME_APP
[[ "$(service_executable)" == "$(command -v node)" ]]
ONAIR_RUNTIME_APP="$SCRATCH/missing.app"
if service_executable >/dev/null 2>&1; then echo 'FAIL: missing configured runtime was ignored' >&2; exit 1; fi
ONAIR_RUNTIME_APP="$app"
REJECT_RUNTIME=1
if service_executable >/dev/null 2>&1; then echo 'FAIL: failed signature check was ignored' >&2; exit 1; fi
echo 'runtime selection: 9 checks passed'
