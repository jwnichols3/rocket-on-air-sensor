# Evolvable host install - config-file-first, setup wizard, bootstrap, update

Issue #13; decision D-14. Approved by Rocket 2026-08-06 including the interactive
setup requirement ("one command to install, a setup process with questions,
re-runnable to make changes"). Evidence base:
`docs/research/2026-08-06-host-install-simplification.md`.

## Constraints (binding)

- Zero production npm dependencies. No new devDependencies.
- The service must start with sensible defaults when no config file exists.
- Real environment variables always win over the config file (Node's documented
  `loadEnvFile` precedence - do not fight it, document it).
- The plist and the systemd unit carry NO `ONAIR_*` configuration after this
  change. Only host-layout placeholders remain: `@NODE@`, `@APPDIR@`, `@USER@`,
  `@HOME@` (plist keeps `HOME` in EnvironmentVariables - daemons have none).
- The CLI never sources a config file as shell (no `eval`, no `source`) - parse
  `KEY=value` lines with grep/cut and strip surrounding quotes.
- `config.env` is written atomically, owned by the target user, mode 0600 (it can
  hold the token).
- Never break a running install: `onair update` restarts last, after a validated
  build, and rolls back on health failure.
- Interactive prompts only on a TTY; every flow must work non-interactively
  (current values or defaults, no hang).

## Deliverable 1: config loader (`src/config.ts` + wiring)

- New `src/config.ts`: `export function loadConfig(path?: string): void` -
  resolves `path ?? process.env.ONAIR_CONFIG ?? join(homedir(), '.onair',
  'config.env')`, calls `process.loadEnvFile(resolved)`, catches and ignores
  `ENOENT` only (rethrow anything else).
- `src/index.ts` calls `loadConfig()` before any `ONAIR_*` read.
- File format: Node's env-file format (`KEY=value`, `#` comments, optional
  quotes).
- Tests (unit, `test/config.test.ts` + one spawn test in the existing style):
  values load from the file; a real env var wins over the file; missing file is
  silent; malformed lines are ignored; `ONAIR_CONFIG` overrides the path;
  non-ENOENT error (e.g. path is a directory) throws.

## Deliverable 2: static plist + safe CLI config read (`deploy/`)

- `deploy/com.rocket.onair.plist.template`: remove `@PORT@`/`@STATE_FILE@`
  placeholders and the `ONAIR_PORT`/`ONAIR_STATE_FILE` entries; EnvironmentVariables
  keeps only `HOME`. Remove the PlistBuddy `ONAIR_TOKEN` append from
  `cmd_install`.
- `deploy/onair`: replace the `cli.env` sourcing block with a `read_config`
  helper: for each of `ONAIR_PORT`, `ONAIR_TOKEN`, `ONAIR_STATE_FILE`, real env
  wins; else last matching `^KEY=` line from the config file (path:
  `$ONAIR_CONFIG` or `$TARGET_HOME/.onair/config.env`), quotes stripped. Works
  identically under sudo (no code execution hazard - the root-skip guard
  becomes unnecessary and is removed).
- Migration: if `cli.env` exists and `config.env` does not, `install`/`setup`
  copies it to `config.env` (0600) and prints one line saying so. `cli.env` is
  no longer read.
- Verification: rendered plist contains no `ONAIR_` string; `plutil -lint` OK;
  `bash -n`.

## Deliverable 3: `onair setup` (the wizard)

- New verb `setup [--non-interactive]`. Flow:
  1. Read current effective values (read_config over existing `config.env`,
     else defaults: port 8484, no token, default state file).
  2. If stdin is a TTY and `--non-interactive` not given, ask three questions,
     each showing the current value as the default (Enter keeps it):
     - Port (validate integer 1-65535, re-ask on invalid).
     - Token: `[k]eep / [g]enerate / [e]nter / [n]one` (generate uses
       `uuidgen`, lowercased; default is keep, or none when unset).
     - State file path.
  3. Write `config.env` atomically (temp file + `install -o "$TARGET_USER" -m
     0600`), with a header comment naming the file's purpose and the precedence
     rule.
  4. If the daemon is loaded: restart + health poll, print PASS/FAIL. If not
     loaded and invoked standalone: print the install command. (When `install`
     calls setup, install continues to bootstrap as before.)
- `install` runs setup first when `config.env` does not exist (interactive only
  on a TTY). Re-running `setup` any time reconfigures and restarts - the plist
  is untouched by design.
- Non-TTY / `--non-interactive`: keep current values (or defaults), still write
  the file, still restart if loaded.

## Deliverable 4: `deploy/bootstrap` + Pi unit

- `deploy/bootstrap` (bash, `main()` wrapper, `set -euo pipefail`): from the
  repo checkout, (1) check `node --version` >= 22 and git present, with clear
  errors; (2) run `npm ci` and `npm run build` as the invoking (non-root) user -
  when running under sudo, drop to `$SUDO_USER` for both; (3) dispatch:
  - macOS: `exec deploy/onair install "$@"`.
  - Linux with systemd: render `deploy/onair.service.template` (`@NODE@`,
    `@APPDIR@`, `@USER@`), `systemd-analyze verify` when available, install to
    `/etc/systemd/system/onair.service`, `daemon-reload`, `enable --now`,
    health-poll (same curl loop as the Mac).
- `deploy/onair.service.template` replaces the static `deploy/onair.service`:
  `ExecStart=@NODE@ @APPDIR@/dist/index.js` (local checkout - no `npx github:`),
  `WorkingDirectory=@APPDIR@`, `User=@USER@`, `EnvironmentFile=-@HOME@/.onair/config.env`,
  `Restart=always`, `RestartSec=5`. Delete the old `onair.service`.
- Fresh install on either host: `git clone <repo>` + `sudo deploy/bootstrap`.

## Deliverable 5: `onair update`

- New verb `update [--check-only|--dry-run] [--yes]`:
  1. Refuse on a dirty tree (`git diff --quiet` both staged and unstaged), list
     the dirty files.
  2. `git fetch --quiet origin`; if `git rev-parse @` == `@{u}` and `dist/` is
     current, print "Everything is up to date." and exit 0.
  3. `--check-only`/`--dry-run`: print `git log --oneline @..@{u}` and exit 0.
  4. Confirm unless `--yes` (TTY only; non-TTY implies `--yes`).
  5. `git merge --ff-only @{u}`; `npm ci` (as the non-root user).
  6. Build to `.dist-next` (`npx tsc --outDir .dist-next`); on success swap:
     `rm -rf dist.prev; mv dist dist.prev; mv .dist-next dist`.
  7. Mac only: if the node path inside the installed plist differs from
     `command -v node` (resolved), re-render + `reload`; else plain `restart`.
  8. Health-poll; on FAIL restore `dist.prev` to `dist`, restart again, exit
     non-zero printing the failing health output.
  - A `trap` restores `dist` if interrupted between swap steps. `.dist-next`
    and `dist.prev` go into `.gitignore`.

## Deliverable 6: docs

- `INSTALL.md` Layer 1 rewritten (STE, glossary terms): two-command install for
  both hosts, the setup Q&A, "change configuration = `onair setup` (or edit
  `~/.onair/config.env`) then restart", `onair update` for updates.
- `docs/mac-setup.md`: config.env section replaces cli.env; the reload-after-
  env-change rule shrinks to "only host-layout changes (node path, moved
  checkout) need `install` + `reload`"; new setup/update verb rows.
- `docs/pi-setup.md`: checkout-based unit, bootstrap flow, `/etc/onair.env`
  note removed in favor of `~/.onair/config.env` via EnvironmentFile.
- README: verb list gains `setup`/`update`; install pointer stays INSTALL.md.

## Testing

- `npm test`: config loader tests (Deliverable 1) plus existing 73 stay green;
  `npx tsc --noEmit` clean.
- Script checks (no sudo in CI/dev): `bash -n` both scripts; rendered plist
  static + lint; rendered unit contains no `npx`; `setup --non-interactive`
  against a temp `ONAIR_CONFIG`/`TARGET_HOME` writes a 0600 file with correct
  content and round-trips values; `read_config` precedence (env beats file).
- Live acceptance on the Mini (sudo, Rocket or guided): re-run
  `sudo deploy/bootstrap`, `onair setup` change port and back, `onair update`
  no-op + rollback demo.

## Out of scope

Ansible (deferred per D-14), pinned Node tarball (combination 2 - separate
ticket if wanted), LaunchAgent for the Detector (future, noted in research),
`curl | bash` hosted installer.
