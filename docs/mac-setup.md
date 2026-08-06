# Mac service setup

Run the on-air API on the Mac Mini as a supervised background service that
survives reboots and crashes with no GUI login required. Decision record:
`CONTEXT.md` D-13 (issue #12 has the full bakeoff verdict).

The supervisor is a macOS **LaunchDaemon** (`com.rocket.onair`, system domain,
`UserName=john`, `KeepAlive=true`, `RunAtLoad=true`) running `node
dist/index.js` from a local checkout. `RunAtLoad` brings it up on boot before
any user logs in; `KeepAlive` restarts it if the process ever crashes or
exits unexpectedly. It's administered through the `onair` CLI (wraps
`launchctl`), the `GET /admin/health` / `POST /admin/restart` HTTP routes
(`docs/api-contract.md`), and an Admin card on `/ui`.

## Install

```sh
git clone https://github.com/jwnichols3/rocket-on-air-sensor.git
cd rocket-on-air-sensor
sudo deploy/bootstrap
```

`deploy/bootstrap` checks for git and Node.js 22+, runs `npm ci` and `npm run
build` as the invoking (non-root) user even when called under `sudo`, then
hands off to `onair install` on macOS.

`onair install`:

- creates `~/.onair/logs`
- migrates `~/.onair/cli.env` to `~/.onair/config.env` if the old file exists
  and the new one does not
- runs `onair setup` first, if `~/.onair/config.env` still does not exist
  (asks port/token/state file on a TTY; keeps defaults otherwise)
- resolves `node` from `PATH` and renders `deploy/com.rocket.onair.plist.template`
  into a plist (absolute paths for node, app dir, user, and home only -
  daemons get a bare `PATH` and no shell env, so the plist sets `HOME`
  explicitly; port, token, and state file are not in the plist - the service
  reads them from `~/.onair/config.env` itself)
- lints the rendered plist with `plutil -lint`
- installs it to `/Library/LaunchDaemons/com.rocket.onair.plist`, owned
  `root:wheel`, mode `0644`
- writes a log-rotation entry to `/etc/newsyslog.d/onair.conf`
- symlinks itself to `/usr/local/bin/onair` so `onair <verb>` works from
  anywhere afterward
- `launchctl bootstrap`s the daemon
- polls `/admin/health` for up to 5s and prints `health: PASS`/`FAIL`

Never hand-edit the installed plist - rerun `sudo deploy/bootstrap` (or
`sudo onair install`, on an already-built checkout) instead.

### `--sudoers`

`sudo deploy/bootstrap --sudoers` (forwarded to `onair install --sudoers`;
or run `sudo onair install --sudoers` directly on an already-built checkout)
additionally writes `/etc/sudoers.d/onair`, a NOPASSWD entry scoped to the exact `launchctl`
subcommands the CLI issues against the `com.rocket.onair` label (bootstrap,
bootout, kickstart, kickstart -k, print, enable, disable) - nothing broader.
It's validated with `visudo -cf` before being installed, and install refuses
to proceed if that check fails.

Tradeoff: without `--sudoers`, every mutating `onair` verb prompts for your
password (or needs a cached sudo ticket) each time, and `onair status`
degrades to `supervised: no (state=unknown ...)` when there's no ticket. With `--sudoers`,
anyone with local shell access as your user can restart, stop, or disable the
daemon without a password - scoped to this one launchd label, but still a
standing grant. Remove it with `sudo rm /etc/sudoers.d/onair`.

## Verbs

| Verb | Behavior |
|---|---|
| `install [--sudoers]` | Migrate `cli.env`, run `setup` if `config.env` doesn't exist, render plist, lint, install, write newsyslog conf, symlink `onair` into `/usr/local/bin`, bootstrap, health-poll. |
| `setup [--non-interactive]` | Interactive Q&A for port/token/state file (or keeps current values, non-interactively); writes `~/.onair/config.env` (`0600`); restarts if the daemon is up. Re-runnable any time. |
| `uninstall` | Bootout (if loaded), remove plist/newsyslog conf/sudoers file/symlink, health-poll (failure expected/ignored). |
| `start` | `kickstart` if already loaded, else `bootstrap`. Health-polls. |
| `stop` | `bootout`. Prints that it returns at next boot (`RunAtLoad`); use `disable` for persistent off. Health-polls (failure expected/ignored). |
| `restart` | `kickstart -k`. Health-polls. |
| `reload` | `bootout` + `bootstrap` (prints why - see below). Health-polls. |
| `status` | Two-layer report: `supervised:` from `launchctl print` (state, pid, last exit, disabled bit) and `responding:` from `GET /admin/health`. Only fails (exit 1) if both layers are down. |
| `logs [-f]` | Tail last 100 lines of `~/.onair/logs/onair.log`, or follow with `-f`. |
| `reset-state` | If the API responds: `POST /off` + `DELETE /message` over HTTP; else `rm` the state file directly. Then `kickstart -k` and health-poll. |
| `disable` | `launchctl disable` (persists across reboot). Health-polls (failure expected/ignored). |
| `enable` | `launchctl enable`, then runs `start`. |
| `update [--check-only\|--dry-run] [--yes]` | Fetch, fast-forward the checkout, `npm ci`, rebuild, swap in the new `dist`, restart (reload if the node path changed), health-poll; rolls back to the previous build on failed health. `--check-only`/`--dry-run` only lists pending commits. `--yes` skips the confirm prompt (implied when stdin isn't a TTY). Refuses a dirty tree or a checkout with no upstream branch. |

Every mutating verb polls `/admin/health` for up to 5s afterward and prints
`health: PASS` or `health: FAIL`.

## Reload after host-layout changes

Config changes (port, token, state file) never need a reload. The service
reads `~/.onair/config.env` itself at startup, and `onair setup` restarts it
for you (a plain restart is enough - the plist itself does not change).

Only host-layout changes need `onair install` + `onair reload`: the node
path changed (e.g. a new Homebrew install location), or the checkout moved
to a different directory. `onair update` already handles the node-path case
itself - it reloads only when the path baked into the plist no longer
matches `command -v node`, otherwise it restarts.

`kickstart -k` (what `onair restart` runs) restarts the *process* but does
not make launchd re-read the plist from disk. `onair reload` does bootout +
bootstrap, so a re-rendered plist actually takes effect.

## `~/.onair/config.env`

The service reads `ONAIR_PORT`, `ONAIR_TOKEN`, and `ONAIR_STATE_FILE` from
`~/.onair/config.env` itself at startup (`src/config.ts`, Node's
`process.loadEnvFile`). The `onair` CLI reads the same file, with the same
precedence, to talk to the running API and manage it (health checks,
`reset-state`'s direct-file fallback, building the sudoers scope, etc). A
real environment variable always wins over the file; override the file's
path with `ONAIR_CONFIG`.

Change values with `onair setup` (asks port/token/state file, shows the
current value as the default, restarts the daemon if it's running) or by
hand-editing the file and running `onair restart`. `onair setup` writes the
file atomically, owned by your user, mode `0600` (it can hold the token).

Format: `KEY="value"` lines, `#` comments allowed. Example
`~/.onair/config.env`:

```sh
ONAIR_PORT="8484"
ONAIR_TOKEN="some-secret-value"
ONAIR_STATE_FILE="/Users/john/.onair/state.json"
```

### Migration from `cli.env`

Earlier versions used `~/.onair/cli.env` (sourced as shell). `onair install`
and `onair setup` each copy it to `config.env` (mode `0600`) the first time
either runs, if `config.env` doesn't exist yet, and print one line saying
so. `cli.env` is not read after that.

## Pinned node / nvm caveat

`onair install` resolves `node` via `command -v node` **at install time** and
bakes that absolute path into the plist (`@NODE@`). Daemons get a bare
`PATH`, so a bare `node` in `ProgramArguments` wouldn't resolve at all - it
has to be absolute.

- **Homebrew node** (`/opt/homebrew/bin/node`): this is a stable symlink that
  `brew upgrade node` repoints to the new version in place. The path baked
  into the plist keeps working after an upgrade with no reinstall needed.
- **nvm**: unusable for the daemon. nvm's `node` lives under a
  version-specific path (`~/.nvm/versions/node/vX.Y.Z/bin/node`) selected by
  shell init scripts the daemon never runs. If you install with an nvm
  `node` on `PATH`, the plist gets pinned to that one version's literal path,
  and it breaks the moment nvm's default changes or that version is
  uninstalled. Use Homebrew's node for anything driving this daemon.

## pmset

The Mac must not go to sleep, or the daemon (and everything else) stops
answering. Check and set:

```sh
pmset -g | grep sleep
sudo pmset -a sleep 0
```

The Mini this was verified on already has `sleep 0` set; this is a checklist
item for a fresh machine, not a step this repo's tooling does for you.

## Logs

`~/.onair/logs/onair.log` (both stdout and stderr, per the plist's
`StandardOutPath`/`StandardErrorPath`). `onair install` also ships a
log-rotation entry to `/etc/newsyslog.d/onair.conf` (5 rotations, 10000KB
threshold, compressed with `J`) so the file doesn't grow unbounded. View with
`onair logs` or `onair logs -f`.

## Restart-by-exit symmetry

`POST /admin/restart` doesn't restart anything itself - it just exits the
process cleanly (`202 {"restarting": true}` is sent first, then, once that
response has flushed, the process calls `process.exit(0)` - no
`server.close()`, nothing else to shut down). The supervisor is what actually brings
it back: launchd's `KeepAlive` here, systemd's `Restart=always` on the Pi
(`docs/pi-setup.md`). Same admin route, same mechanism, same behavior on
either machine - "restart" is universally "exit and let the supervisor
notice."

## `/ui` Admin card

`http://<host>:8484/ui` has an Admin card showing health fields (pid, uptime,
node version, state file writable) polled from `/admin/health` every 10s and
on SSE reconnect, plus a Restart button. The button is always enabled once
the first health poll succeeds, regardless of whether `ONAIR_TOKEN` is
configured - `POST /admin/restart` returns 403 without one (the one endpoint
that refuses to exist unauthenticated, since it's a remote process-kill).
Only after a click gets that 403 does the card show a "set `ONAIR_TOKEN` to
enable remote restart" hint in its error strip; the button itself is
unaffected and stays clickable.

## Troubleshooting

- **`onair status` looks wrong / partial** - remember it's two independent
  answers. `supervised: no, responding: yes` means something's answering on
  the port but launchd isn't tracking it (e.g. you ran `node dist/index.js`
  by hand, or `onair status` had no sudo ticket and can't see launchd state -
  check for `disabled=unknown state=unknown`). `supervised: yes, responding:
  no` means launchd has it loaded but it's not answering - check `onair logs`
  for a crash right after start.
- **Crash loop** - `onair status` will show a low/negative uptime and a
  changing pid across repeated checks, plus `last-exit` non-zero. Check
  `onair logs` for the actual error; `KeepAlive` keeps respawning it
  regardless, so it won't fail closed on its own.
- **`Bootstrap failed: 5` (or similar `launchctl` errno)** - almost always a
  permissions/ownership problem: the plist isn't `root:wheel 0644`, or you're
  not running the command as root/via sudo. Re-run `sudo deploy/onair
  install` rather than hand-fixing permissions.
- **Plist edited (or reinstalled) but behavior unchanged** - this is the
  `kickstart -k` vs plist re-read issue above. Run `onair reload`, not
  `onair restart`.
