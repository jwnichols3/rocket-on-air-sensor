# Mac service management design - LaunchDaemon + `onair` CLI + admin routes

Issue #12; decision D-13 (judged bakeoff, 2026-08-06). Run the on-air API as a
supervised task on the Mac Mini that survives reboots and crashes with no GUI
login, administered via a CLI, HTTP admin routes, and an Admin card on `/ui`.

## Constraints (binding)

- Zero production npm dependencies. New code: TypeScript in `src/`, bash + plist
  template in `deploy/`.
- Supervisor is macOS launchd, system domain: `/Library/LaunchDaemons/com.rocket.onair.plist`,
  `UserName=john`, `KeepAlive=true`, `RunAtLoad=true`.
- Absolute paths everywhere in the plist (daemons get bare PATH, no HOME):
  node binary resolved at install time (`/opt/homebrew/bin/node` on the Mini),
  `EnvironmentVariables` carries `HOME` and absolute `ONAIR_STATE_FILE`.
- Modern launchctl subcommands only: `bootstrap`, `bootout`, `kickstart [-k]`,
  `print`, `enable`, `disable`. Never legacy `load`/`unload`.
- `kickstart -k` does not re-read the plist: `reload` (bootout+bootstrap) is a
  distinct verb and the script says why when used.
- Plist is rendered from a template by `onair install`, installed root:wheel 0644,
  linted with `plutil -lint`. Never hand-edited.
- Log rotation via a shipped `/etc/newsyslog.d/onair.conf` entry.
- The daemon runs a local checkout (`node dist/index.js`), never `npx github:`.

## Deliverables

### 1. `deploy/com.rocket.onair.plist.template`

XML plist with `@NODE@`, `@APPDIR@`, `@USER@`, `@HOME@`, `@PORT@`, `@STATE_FILE@`
placeholders. Keys: Label, ProgramArguments `[@NODE@, @APPDIR@/dist/index.js]`,
UserName, KeepAlive true, RunAtLoad true, WorkingDirectory `@APPDIR@`,
EnvironmentVariables {HOME, ONAIR_PORT, ONAIR_STATE_FILE} (ONAIR_TOKEN appended
by install only when set in the environment), StandardOutPath/StandardErrorPath
`@HOME@/.onair/logs/onair.log`.

### 2. `deploy/onair` (bash CLI, ~150 lines)

`LABEL=com.rocket.onair`, `T=system/$LABEL`. Verbs:

- `install` - mkdir -p `~/.onair/logs`; render template (sed); `plutil -lint`;
  `sudo install -o root -g wheel -m 0644` to `/Library/LaunchDaemons`; write
  newsyslog entry; symlink itself to `/usr/local/bin/onair`; bootstrap; health
  poll. `--sudoers` flag additionally writes a NOPASSWD entry scoped to the
  exact launchctl commands+label (validated with `visudo -cf` before install).
- `uninstall` - bootout; remove plist, newsyslog entry, symlink.
- `start` - bootstrap if not loaded, else `kickstart`.
- `stop` - bootout + print "returns at next boot; use `onair disable` for
  persistent off".
- `restart` - `kickstart -k`.
- `reload` - bootout + bootstrap + print why this exists.
- `status` - parse `launchctl print` (state, PID, last exit status, disabled
  bit) + `curl -fsS -m 2 http://localhost:$PORT/admin/health`; two-layer
  answer: `supervised: yes/no`, `responding: yes/no`.
- `logs [-f]` - tail the log file.
- `reset-state` - if API responds: `POST /off` + `DELETE /message`; else
  `rm` the state file; then `restart`.
- `disable` / `enable` - `launchctl disable|enable $T` (+ start on enable).

Every mutating verb polls `/admin/health` up to 5s and prints PASS/FAIL.
Reads `ONAIR_PORT` (default 8484) and `ONAIR_TOKEN` from env or
`~/.onair/cli.env` (sourced if present) so status/health work with auth on.

### 3. Admin routes (`src/server.ts`, ~60 LOC)

- `GET /admin/health` - 200 `{uptime, pid, nodeVersion, port, stateFileWritable}`.
  Read-only: token-gated like other GETs (`?token=` accepted) when auth is on.
- `POST /admin/restart` - **403 when `ONAIR_TOKEN` is not configured** (the one
  endpoint that refuses to exist without auth - remote process-kill must not be
  open); 401 on wrong/missing token; else 202 `{"restarting":true}`, then after
  the response flushes: `process.exit(0)` (no `server.close()` - atomic
  tmp+rename state persistence means no in-flight write can be corrupted by an
  abrupt exit, so the extra close-then-exit step buys nothing). KeepAlive
  respawns; identical under Pi systemd `Restart=always`. Exit must be deferred
  (`res.on('finish'|'close', ...)`) so the 202 reaches the client.
- Contract doc updated; error table gains 403.

### 4. `/ui` Admin card (`src/ui.ts`, ~40 lines)

Card between Message and Live events: health fields (pid, uptime, node version,
state file writable) polled from `/admin/health` every 10s + on SSE reconnect;
Restart button - confirm-free but disabled until health has loaded; fire-and-
forget POST (never awaits the body), then polls `/admin/health` until it
answers again, showing "restarting…" state; renders 403 hint ("set ONAIR_TOKEN
to enable remote restart") when restart is unavailable.

### 5. Docs

- README: Mac service section (install one-liner: `git clone && npm install &&
  npm run build && sudo deploy/onair install`), verb table.
- `docs/mac-setup.md`: full setup incl. sudoers option, reload-after-env-change
  rule, pinned-node caveat (`brew upgrade node` → path fine via symlink; nvm
  unusable), pmset note (already `sleep 0` on the Mini), log rotation.
- `docs/api-contract.md`: `/admin/health`, `/admin/restart`.

## Testing

- Unit/integration (npm test): admin routes - health shape, token gating,
  restart 403-without-token, 401-wrong-token, 202-with-token (exit stubbed via
  injectable `exitFn` dep), /ui contains Admin card markers.
- `bash -n deploy/onair` + `plutil -lint` on a rendered plist in CI-less local
  check (part of implementer verification, scripted in tests where possible).
- Live acceptance on the Mini (controller, needs sudo - may hand to Rocket):
  install, kill -9 respawn, `onair restart`, `/ui` restart round-trip, crash-loop
  sim, reboot check deferred to Rocket.

## Out of scope

SwiftBar plugin (deferred), Pi changes beyond none-needed (restart-by-exit
already works under systemd), FileVault handling (verified off).
