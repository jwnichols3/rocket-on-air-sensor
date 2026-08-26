#!/usr/bin/env bash
# Exercises the sudoers rule GENERATOR, with no root and nothing installed.
#
# WHY THIS EXISTS: this rule grants passwordless root. The single property that makes it
# acceptable is that it is narrow - seven exact launchctl subcommands against one label and
# one plist path, no wildcards. That property is asserted here, because a rule that quietly
# widened would look identical in review.
#
# It also pins the reason `onair sudoers` exists as its own verb: `install --sudoers` runs
# `launchctl bootstrap` first, which fails on an already-loaded service under `set -e`, so
# the rule was unreachable on the one host that needed it.
#
# Run: deploy/test-sudoers.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '       %s\n' "$2"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

ONAIR_LIB_ONLY=1 . "$HERE/onair"
set +e +o pipefail

SCRATCH="$(mktemp -d /tmp/onair-test-sudoers.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
RULE="$SCRATCH/onair.sudoers"

render_sudoers "$RULE"
check "renders, and visudo accepts it" "$?" "0"

echo
echo "== the scope, which is the whole safety argument =="
check "grants to the target user, not ALL"    "$(grep -c "^$TARGET_USER ALL=(root) NOPASSWD:" "$RULE")" "1"
check "names launchctl by absolute path"      "$(grep -c "$LAUNCHCTL" "$RULE")" "7"
check "exactly seven subcommands"             "$(grep -oE "$LAUNCHCTL [a-z]+" "$RULE" | wc -l | tr -d ' ')" "7"
check "no wildcard anywhere"                  "$(grep -c '\*' "$RULE")" "0"
check "no shell escape (no ALL as a command)" "$(grep -cE 'NOPASSWD:[[:space:]]*ALL' "$RULE")" "0"
check "every rule targets this label only"    "$(grep -cE "(system/)?$LABEL" "$RULE")" "8"

for verb in bootstrap bootout kickstart print enable disable; do
  check "permits $verb" "$(grep -c "$LAUNCHCTL $verb" "$RULE")" "$([[ $verb == kickstart ]] && echo 2 || echo 1)"
done

echo
echo "== things it must NOT permit =="
for verb in load unload remove submit setenv; do
  check "does not permit $verb" "$(grep -c "$LAUNCHCTL $verb" "$RULE")" "0"
done

echo
echo "== SYNTAX IS NOT SCOPE: a truncated rule is BROADER, and visudo cannot tell =="
# In sudoers, a command with NO arguments matches ANY arguments. So a write that stops after
# the command path grants `launchctl bootstrap system /tmp/anything.plist` - root code
# execution - and `visudo -cf` reports it as parsed OK. A partial write is therefore the
# dangerous outcome, not the safe one, which is the opposite of the usual intuition.
TRUNC="$SCRATCH/truncated"
printf '%s\n' "$TARGET_USER ALL=(root) NOPASSWD: $LAUNCHCTL" > "$TRUNC"
visudo -cf "$TRUNC" >/dev/null 2>&1
check "visudo ACCEPTS the truncated rule"      "$?" "0"
sudoers_is_narrow "$TRUNC" 2>/dev/null
check "and the scope check REJECTS it"         "$?" "1"

# The same shape, but truncated mid-list rather than at the first command.
printf '%s\n' "$TARGET_USER ALL=(root) NOPASSWD: $LAUNCHCTL bootstrap system $PLIST_PATH, \\" > "$TRUNC"
printf '%s\n' "  $LAUNCHCTL bootout $T" >> "$TRUNC"
sudoers_is_narrow "$TRUNC" 2>/dev/null
check "a short but valid rule is rejected too" "$?" "1"

printf '%s\n' "$TARGET_USER ALL=(root) NOPASSWD: ALL" > "$TRUNC"
sudoers_is_narrow "$TRUNC" 2>/dev/null
check "NOPASSWD: ALL is rejected"              "$?" "1"

printf '%s\n' "$TARGET_USER ALL=(root) NOPASSWD: $LAUNCHCTL bootstrap system *" > "$TRUNC"
sudoers_is_narrow "$TRUNC" 2>/dev/null
check "a wildcard is rejected"                 "$?" "1"

sudoers_is_narrow "$RULE" 2>/dev/null
check "the real rendered rule passes"          "$?" "0"

echo
echo "== render_sudoers checks the write, not just the result =="
# An unchecked `cat >` is how a truncated rule gets written in the first place - a full disk,
# a full /tmp. Rendering into a path that cannot be written must fail, not fall through.
render_sudoers "$SCRATCH/no-such-dir/rule" 2>/dev/null
check "an unwritable destination fails"        "$?" "1"

echo
echo "== the verb refuses to run unprivileged =="
# Non-root must not silently do nothing, and must not try. It exits, so run it in a subshell.
out="$( (cmd_sudoers) 2>&1 )"; rc=$?
check "exits non-zero without root"           "$rc" "1"
check "and says how to run it"                "$(printf '%s' "$out" | grep -c "sudo onair sudoers")" "1"

echo
echo "-- $PASS passed, $FAIL failed --"
[[ "$FAIL" -eq 0 ]]
