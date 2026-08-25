#!/usr/bin/env bash
# Exercises the parts of `onair update` that carry real risk, with no sudo, nothing
# installed, and /Library untouched.
#
# WHY THIS EXISTS: D-37 moved the service under server/, which means the plist on an
# already-installed host names an entry point that no longer exists. `onair update`
# has to notice and rewrite it. That path runs exactly once, on one machine, and if
# it is wrong the daemon KeepAlive-respawns into a missing file forever - so it needs
# to be provable before it is needed, not after.
#
# Run: deploy/test-update.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# PlistBuddy and plutil are macOS. Skipping is stated out loud rather than passing
# quietly - a green line that checked nothing is worse than a visible gap.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "deploy/test-update.sh: SKIPPED - needs macOS (PlistBuddy, plutil)"
  exit 0
fi
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '       %s\n' "$2"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

# Source the functions without dispatching a verb. `onair` sets -e for its own
# safety, which would abort this script the first time a predicate answers "no" -
# so turn it back off. `-u` stays on.
ONAIR_LIB_ONLY=1 . "$HERE/onair"
set +e +o pipefail

SCRATCH="$(mktemp -d /tmp/onair-test-update.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

make_plist() {  # make_plist FILE NODE ENTRY
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>com.rocket.onair</string>
	<key>ProgramArguments</key><array><string>$2</string><string>$3</string></array>
</dict>
</plist>
PLIST
}

echo "== plist_is_stale =="
NODE="$(command -v node)"

make_plist "$SCRATCH/old.plist" "$NODE" "$APPDIR/dist/index.js"
plist_is_stale "$SCRATCH/old.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>/dev/null
check "an old-shape plist (APPDIR/dist) is stale" "$?" "0"

make_plist "$SCRATCH/new.plist" "$NODE" "$APPDIR/server/dist/index.js"
plist_is_stale "$SCRATCH/new.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>/dev/null
check "a current plist is not stale" "$?" "1"

make_plist "$SCRATCH/oldnode.plist" "/usr/local/bin/node" "$APPDIR/server/dist/index.js"
plist_is_stale "$SCRATCH/oldnode.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>/dev/null
check "a moved node binary is still detected" "$?" "0"

plist_is_stale "$SCRATCH/does-not-exist.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>/dev/null
check "an absent plist is NOT reported stale" "$?" "1"

printf 'not a plist\n' > "$SCRATCH/junk.plist"
plist_is_stale "$SCRATCH/junk.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>/dev/null
check "an unreadable plist is NOT reported stale" "$?" "1"

REASON="$(make_plist "$SCRATCH/old2.plist" "$NODE" "$APPDIR/dist/index.js"; \
          plist_is_stale "$SCRATCH/old2.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>&1 >/dev/null)"
case "$REASON" in
  *"entry point moved"*) ok "it says WHY: $REASON" ;;
  *) bad "it says why" "got [$REASON]" ;;
esac

echo
echo "== render_plist_to: what update would actually install =="
render_plist_to "$SCRATCH/rendered.plist" >/dev/null 2>&1
if [[ -s "$SCRATCH/rendered.plist" ]]; then
  ok "renders and passes plutil -lint"
  ENTRY_OUT="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$SCRATCH/rendered.plist")"
  check "the rendered entry point is the new one" "$ENTRY_OUT" "$APPDIR/server/dist/index.js"
  NODE_OUT="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SCRATCH/rendered.plist")"
  check "the rendered node path is this node" "$NODE_OUT" "$NODE"
  # The whole point: feeding the render back in must settle, not oscillate.
  plist_is_stale "$SCRATCH/rendered.plist" "$NODE" "$APPDIR/server/dist/index.js" 2>/dev/null
  check "re-rendering converges - the fresh plist is not stale" "$?" "1"
  grep -q '@APPDIR@\|@NODE@\|@USER@\|@HOME@' "$SCRATCH/rendered.plist" \
    && bad "no placeholders survive the render" || ok "no placeholders survive the render"
else
  bad "renders and passes plutil -lint" "nothing written"
fi

echo
echo "== swap_dist_in / roll_dist_back, on a scratch tree =="
SERVER_DIR="$SCRATCH/server"; DIST_DIR="$SERVER_DIR/dist"
DIST_NEXT="$SERVER_DIR/.dist-next"; DIST_PREV="$SERVER_DIR/dist.prev"
DIST_FAILED="$SERVER_DIR/.dist-failed"
mkdir -p "$DIST_DIR" "$DIST_NEXT"
echo good > "$DIST_DIR/index.js"
echo broken > "$DIST_NEXT/index.js"

swap_dist_in
check "the staged build is now dist" "$(cat "$DIST_DIR/index.js")" "broken"
check "the outgoing build is kept at dist.prev" "$(cat "$DIST_PREV/index.js")" "good"
check "the staging dir is consumed" "$([[ -e "$DIST_NEXT" ]] && echo present || echo gone)" "gone"

roll_dist_back
check "rollback restores the working build" "$(cat "$DIST_DIR/index.js")" "good"
check "the bad build is kept for diagnosis" "$(cat "$DIST_FAILED/index.js")" "broken"

# The case that must NOT silently look like success: nothing to roll back to.
rm -rf "$DIST_PREV"
roll_dist_back 2>/dev/null
check "rollback with no dist.prev reports failure" "$?" "1"
check "and leaves dist alone rather than deleting it" "$(cat "$DIST_DIR/index.js")" "good"

# A first-ever install has no dist to displace; the swap must still work.
rm -rf "$SERVER_DIR"; mkdir -p "$DIST_NEXT"; echo fresh > "$DIST_NEXT/index.js"
swap_dist_in
check "a first install (no existing dist) still swaps in" "$(cat "$DIST_DIR/index.js")" "fresh"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
