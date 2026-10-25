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
# Keep this render fixture independent of a signed runtime installed on the test host.
ONAIR_RUNTIME_APP=legacy
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
echo "== server and console release replacement, on a scratch tree =="
SERVER_DIR="$SCRATCH/server"; DIST_DIR="$SERVER_DIR/dist"
DIST_NEXT="$SERVER_DIR/.dist-next"; DIST_PREV="$SERVER_DIR/dist.prev"
DIST_FAILED="$SERVER_DIR/.dist-failed"
ADMIN_DIR="$SERVER_DIR/public/admin"; ADMIN_NEXT="$SERVER_DIR/.admin-next"
ADMIN_PREV="$SERVER_DIR/admin.prev"; ADMIN_FAILED="$SERVER_DIR/.admin-failed"
seed_release() {
  rm -rf "$SERVER_DIR"
  mkdir -p "$DIST_DIR" "$DIST_NEXT" "$ADMIN_DIR" "$ADMIN_NEXT"
  echo good-server > "$DIST_DIR/index.js"; echo good-console > "$ADMIN_DIR/index.html"
  echo broken-server > "$DIST_NEXT/index.js"; echo broken-console > "$ADMIN_NEXT/index.html"
}
seed_release
swap_release_in
check "the staged server is active" "$(cat "$DIST_DIR/index.js")" "broken-server"
check "the matching console is active" "$(cat "$ADMIN_DIR/index.html")" "broken-console"
check "the outgoing server is kept" "$(cat "$DIST_PREV/index.js")" "good-server"
check "the outgoing console is kept" "$(cat "$ADMIN_PREV/index.html")" "good-console"
check "both stage directories are consumed" "$([[ -e "$DIST_NEXT" || -e "$ADMIN_NEXT" ]] && echo present || echo gone)" "gone"
roll_release_back
check "rollback restores the working server" "$(cat "$DIST_DIR/index.js")" "good-server"
check "rollback restores the matching console" "$(cat "$ADMIN_DIR/index.html")" "good-console"
check "the bad server is kept for diagnosis" "$(cat "$DIST_FAILED/index.js")" "broken-server"
check "the bad console is kept for diagnosis" "$(cat "$ADMIN_FAILED/index.html")" "broken-console"
roll_release_back 2>/dev/null
check "rollback without a previous pair reports failure" "$?" "1"
check "a missing previous pair leaves current server alone" "$(cat "$DIST_DIR/index.js")" "good-server"
check "a missing previous pair leaves current console alone" "$(cat "$ADMIN_DIR/index.html")" "good-console"

seed_release
rm -rf "$ADMIN_DIR"
swap_release_in
roll_release_back 2>/dev/null
check "an old server without a console can still be rolled back" "$?" "0"
check "missing old console does not strand the candidate server" "$(cat "$DIST_DIR/index.js")" "good-server"
check "rollback restores the original console absence" "$([[ -e "$ADMIN_DIR" ]] && echo present || echo absent)" "absent"
check "the candidate console is retained for diagnosis" "$(cat "$ADMIN_FAILED/index.html")" "broken-console"

seed_release
rm "$ADMIN_DIR/index.html"
swap_release_in
roll_release_back 2>/dev/null
check "an old console directory without a built bundle can be restored" "$?" "0"
check "rollback retains the original unbuilt console directory" "$([[ -d "$ADMIN_DIR" && ! -e "$ADMIN_DIR/index.html" ]] && echo unbuilt || echo changed)" "unbuilt"
check "unbuilt old console still permits server rollback" "$(cat "$DIST_DIR/index.js")" "good-server"

seed_release
(
  mv() {
    if [[ "$1" == "$ADMIN_NEXT" ]]; then return 1; fi
    command mv "$@"
  }
  swap_release_in
) 2>/dev/null
check "failure after replacing the server is reported, even with errexit disabled" "$?" "1"
check "partial replacement restores server" "$(cat "$DIST_DIR/index.js")" "good-server"
check "partial replacement restores console" "$(cat "$ADMIN_DIR/index.html")" "good-console"
check "candidate server remains available after failed replacement" "$(cat "$DIST_NEXT/index.js")" "broken-server"
check "candidate console remains available after failed replacement" "$(cat "$ADMIN_NEXT/index.html")" "broken-console"

seed_release
(
  mv() {
    if [[ "$1" == "$ADMIN_NEXT" ]]; then
      # exec avoids an extra shell layer: PPID is the replace_release subshell on Bash 3.2.
      local replace_pid
      replace_pid="$(exec sh -c 'echo "$PPID"')"
      kill -TERM "$replace_pid"
      return 1
    fi
    command mv "$@"
  }
  swap_release_in
) 2>/dev/null
check "TERM during replacement is reported" "$?" "143"
check "TERM restores server" "$(cat "$DIST_DIR/index.js")" "good-server"
check "TERM restores console" "$(cat "$ADMIN_DIR/index.html")" "good-console"

seed_release
swap_release_in
(
  mv() {
    if [[ "$1" == "$ADMIN_PREV" ]]; then return 1; fi
    command mv "$@"
  }
  roll_release_back
) 2>/dev/null
check "a failed rollback reports failure" "$?" "1"
check "failed rollback preserves the active server pair" "$(cat "$DIST_DIR/index.js")" "broken-server"
check "failed rollback preserves the active console pair" "$(cat "$ADMIN_DIR/index.html")" "broken-console"
check "failed rollback retains the previous server for recovery" "$(cat "$DIST_PREV/index.js")" "good-server"
check "failed rollback retains the previous console for recovery" "$(cat "$ADMIN_PREV/index.html")" "good-console"

seed_release
rm -rf "$ADMIN_DIR"
swap_release_in
(
  rm() {
    command rm "$@" || return
    if [[ "$*" == "-f $ADMIN_PREV.absent" ]]; then
      local replace_pid
      replace_pid="$(exec sh -c 'echo "$PPID"')"
      kill -TERM "$replace_pid"
      return 1
    fi
  }
  roll_release_back
) 2>/dev/null
check "TERM after consuming an absence marker reports failed rollback" "$?" "1"
check "interrupted rollback restores the active server" "$(cat "$DIST_DIR/index.js")" "broken-server"
check "interrupted rollback restores the active console" "$(cat "$ADMIN_DIR/index.html")" "broken-console"
check "interrupted rollback retains the previous console absence" "$([[ -f "$ADMIN_PREV.absent" ]] && echo present || echo absent)" "present"
roll_release_back 2>/dev/null
check "rollback can be retried after interruption" "$?" "0"
check "retried rollback restores the old server" "$(cat "$DIST_DIR/index.js")" "good-server"
check "retried rollback restores the old console absence" "$([[ -e "$ADMIN_DIR" ]] && echo present || echo absent)" "absent"

seed_release
rm -rf "$DIST_DIR" "$ADMIN_DIR"
swap_release_in
check "first install without existing artifacts installs server" "$(cat "$DIST_DIR/index.js")" "broken-server"
check "first install without existing artifacts installs console" "$(cat "$ADMIN_DIR/index.html")" "broken-console"
roll_release_back 2>/dev/null
check "a first install has no usable previous server to restore" "$?" "1"
check "no previous server leaves the candidate server intact" "$(cat "$DIST_DIR/index.js")" "broken-server"
check "no previous server leaves the candidate console intact" "$(cat "$ADMIN_DIR/index.html")" "broken-console"

seed_release
rm -rf "$ADMIN_NEXT"
swap_release_in 2>/dev/null
check "an incomplete candidate pair is refused before touching the current pair" "$?" "1"
check "incomplete candidate leaves server unchanged" "$(cat "$DIST_DIR/index.js")" "good-server"
check "incomplete candidate leaves console unchanged" "$(cat "$ADMIN_DIR/index.html")" "good-console"

echo
echo "== a failed update restores the server AND the console =="
UPDATE_ROOT="$SCRATCH/update-workflow"
mkdir -p "$UPDATE_ROOT/server/dist" "$UPDATE_ROOT/server/public/admin" "$UPDATE_ROOT/admin-ui"
echo working-server > "$UPDATE_ROOT/server/dist/index.js"
echo working-console > "$UPDATE_ROOT/server/public/admin/index.html"
(
  SERVER_DIR="$UPDATE_ROOT/server"
  DIST_DIR="$SERVER_DIR/dist"; DIST_NEXT="$SERVER_DIR/.dist-next"
  DIST_PREV="$SERVER_DIR/dist.prev"; DIST_FAILED="$SERVER_DIR/.dist-failed"
  ADMIN_DIR="$SERVER_DIR/public/admin"; ADMIN_NEXT="$SERVER_DIR/.admin-next"
  ADMIN_PREV="$SERVER_DIR/admin.prev"; ADMIN_FAILED="$SERVER_DIR/.admin-failed"
  APPDIR="$UPDATE_ROOT"
  git_u() {
    case "$*" in
      'rev-parse --is-inside-work-tree') echo true ;;
      'rev-parse --abbrev-ref --symbolic-full-name @{u}') echo origin/main ;;
      'rev-parse @'|'rev-parse @{u}') echo same-commit ;;
      *) return 0 ;;
    esac
  }
  dist_is_current() { return 1; }
  run_as_invoking_user() {
    case "$*" in
      'npm ci --ignore-scripts') return 0 ;;
      'npx tsc -p tsconfig.json --outDir .dist-next')
        mkdir -p "$DIST_NEXT"; echo broken-server > "$DIST_NEXT/index.js" ;;
      'npm run build --workspace admin-ui')
        mkdir -p "$ADMIN_DIR"; echo broken-console > "$ADMIN_DIR/index.html" ;;
      'node admin-ui/build.mjs --out-dir '*)
        mkdir -p "$ADMIN_NEXT"; echo broken-console > "$ADMIN_NEXT/index.html" ;;
      'node server/tools/gen-build-info.mjs '*)
        echo '{"commit":"new-build"}' > "$DIST_NEXT/build-info.json" ;;
      *) echo "unexpected build command: $*" >&2; return 1 ;;
    esac
  }
  apply_restart_for_update() { return 1; }
  cmd_update --yes
) > "$SCRATCH/workflow.log" 2>&1
check "the update reports its failed health check" "$?" "1"
check "failed health restores server" "$(cat "$UPDATE_ROOT/server/dist/index.js")" "working-server"
check "failed health restores matching console" "$(cat "$UPDATE_ROOT/server/public/admin/index.html")" "working-console"

echo
echo "== freshness covers both source trees and build metadata =="
FRESH_ROOT="$SCRATCH/freshness"
(
  APPDIR="$FRESH_ROOT"; SERVER_DIR="$APPDIR/server"; DIST_DIR="$SERVER_DIR/dist"
  ADMIN_DIR="$SERVER_DIR/public/admin"
  mkdir -p "$SERVER_DIR/src" "$SERVER_DIR/tools" "$DIST_DIR" "$ADMIN_DIR" "$APPDIR/admin-ui/src"
  touch "$SERVER_DIR/src/app.ts" "$SERVER_DIR/tools/gen-build-info.mjs" "$SERVER_DIR/package.json" \
    "$SERVER_DIR/tsconfig.json" "$APPDIR/package.json" "$APPDIR/package-lock.json" \
    "$APPDIR/admin-ui/src/app.js" "$APPDIR/admin-ui/build.mjs" "$APPDIR/admin-ui/package.json"
  find "$FRESH_ROOT" -type f -exec touch -t 202001010000 {} +
  touch "$DIST_DIR/index.js" "$DIST_DIR/build-info.json" "$ADMIN_DIR/index.html"
  dist_is_current || exit 1
  touch -t 203001010000 "$APPDIR/admin-ui/src/app.js"
  if dist_is_current; then exit 2; fi
  touch -t 202001010000 "$APPDIR/admin-ui/src/app.js"
  touch -t 203001010000 "$SERVER_DIR/tools/gen-build-info.mjs"
  if dist_is_current; then exit 3; fi
  touch -t 202001010000 "$SERVER_DIR/tools/gen-build-info.mjs"
  rm "$ADMIN_DIR/index.html"
  if dist_is_current; then exit 4; fi
) 2>/dev/null
check "fresh artifacts pass; changed UI/generator and missing bundle require rebuilding" "$?" "0"

node "$HERE/../admin-ui/build.mjs" --out-dir "$SCRATCH/console stage" > "$SCRATCH/admin-build.log" 2>&1
check "admin builder accepts an explicit stage path with spaces" "$?" "0"
check "admin builder writes the candidate bundle at that path" "$([[ -s "$SCRATCH/console stage/index.html" ]] && echo yes || echo no)" "yes"
node "$HERE/../admin-ui/build.mjs" --out-dir > "$SCRATCH/admin-invalid.log" 2>&1
check "admin builder rejects an incomplete output argument" "$?" "1"
echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
