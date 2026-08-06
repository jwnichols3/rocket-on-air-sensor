# Simplifying and future-proofing the host install

2026-08-06

Research question: simplify the whole host install/setup process (Layer 1 of `INSTALL.md`) and make
it *evolvable* - when a new env var, a new port, a moved path, a node upgrade, or the Pi migration
arrives, the operator should not have to re-learn or re-run a fragile multi-step dance.

Constraints taken as given: zero production npm deps in the service (hard rule); ops tooling
negotiable but biased to boring/native; hosts are a Mac Mini (launchd, primary) and later a
Raspberry Pi (systemd); single owner, home LAN.

## Summary

- **The single highest-value change is to stop baking config into the plist.** Node's own
  `process.loadEnvFile()` / `--env-file` were **promoted out of experimental in v22.21.0 and
  v24.10.0** ([PR 59925](https://github.com/nodejs/node/pull/59925)). The service can read
  `~/.onair/config.env` itself at startup with six lines of dependency-free code. The plist then
  contains no `ONAIR_*` values at all, becomes static, and a config change collapses from
  *edit cli.env, re-run `sudo deploy/onair install`, `onair reload`* to **edit one file, `onair
  restart`**. The `restart`-vs-`reload` trap - currently the most-documented footgun in
  `docs/mac-setup.md` - disappears entirely because there is no longer a plist change to re-read.
- This is what well-run daemons already do. Caddy's shipped unit hardcodes `--config
  /etc/caddy/Caddyfile` and never changes when config does; Tailscale's unit reads
  `EnvironmentFile=/etc/default/tailscaled`; Homebrew services reads a per-formula `.env` whose
  "Changes take effect on the next `brew services restart` and persist across upgrades." Sources
  below, all verbatim.
- **The second gap is the missing `onair update` verb.** Updating today is four manual commands with
  no health gate and no rollback. Pi-hole's structural lesson is the one to copy: there is exactly
  one install implementation, and `update` is a cheap change-detector that re-invokes it.
- **Do not ship a compiled binary.** Node SEA is Stability 1.1 ("not recommended in production") in
  every shipping line, is CommonJS-only in both LTS lines so this ESM service cannot use it without
  Node 26 or a transpile, does not bundle (so it would add a bundler to a zero-dep repo), and
  measures **137 MiB** on darwin-arm64 to deliver a ~20 KB payload. Measured, not estimated.
- **Move the Pi off `npx github:` at boot.** It re-resolves the git ref on every start, so a dead
  router at boot means the light does not come up - and it fails with **exit 128 and zero bytes of
  output**. It also silently adopts whatever is on `main`. Both verified experimentally.
- **Ansible, Nix, Docker, and systemd portable services are all ceremony at this scale**, though
  Ansible is the only one that structurally solves the evolvability problem and is worth revisiting
  if the host count or plist count grows.
- **An architectural finding that should be recorded in `CONTEXT.md` before any tooling is chosen:**
  a LaunchDaemon has no user session, so it cannot run AppleScript against the logged-in user's apps
  and cannot hold TCC (camera/mic) grants. The future Detector almost certainly needs a
  **LaunchAgent**, alongside the LaunchDaemon for the API. That means the Mac will need *two* job
  definitions, which raises the value of templating and is a bigger evolvability requirement than
  the three env vars.

### Approach comparison

| # | Approach | Fresh install | Code update | Config change | Evolvability | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Config-file-first** (`process.loadEnvFile`) | unchanged | unchanged | **1 edit + restart** | plist becomes static; new env vars need no tooling change at all | **Adopt now** |
| 2 | **`deploy/bootstrap` + `onair update` verb** | 2 commands | **1 command**, health-gated, rollback | - | one install implementation to keep working | **Adopt now** |
| 3 | Node SEA / `bun build --compile` | download 1 binary | replace binary | - | freezes runtime, but 137 MiB/release + experimental | **No** |
| 4 | npm global / `npx` at boot | 1 command | restart | - | git-spec global install is **broken today**; npx is unreliable at boot | **No** (move Pi off it) |
| 5 | Ansible / nix-darwin / Makefile | playbook run | playbook run | edit vars + run | Ansible's `template` + `notify` genuinely solves it | **Defer** (Ansible), **No** (Nix) |
| 6 | Docker / systemd portable services | - | - | - | - | **No** (Docker architecturally disqualified on the Mac) |

### Steps to accomplish each task

Counting operator actions, current vs recommended (combination A from the ranking).

| Task | Today | Recommended | Change |
|---|---|---|---|
| (a) Fresh install, Mac | `git clone`, `npm install`, `npm run build`, `sudo deploy/onair install` (4) | `git clone`, `sudo deploy/bootstrap` (2) | -2 |
| (b) Code update | `git pull`, `npm install`, `npm run build`, `onair restart` (4, no health gate, no rollback) | `onair update` (1, health-gated, auto-rollback) | -3 |
| (c) Config change | edit `cli.env`, `sudo deploy/onair install`, `onair reload` (3, and using `restart` here silently does nothing) | edit `config.env`, `onair restart` (2, no wrong-verb trap) | -1, and removes a footgun |
| (d) Pi migration | edit unit `User=`, `daemon-reload`, `enable --now`, plus npx-at-boot fragility | `git clone`, `sudo deploy/bootstrap` (2) - same two commands as the Mac | same verbs on both hosts |

The largest wins are (b) and (c). (c)'s step count only drops by one, but it eliminates the class of
failure where the operator runs the right-looking command (`onair restart`) and nothing happens.

---

## 1. Config-file-first: the service reads its own config

### Node's env-file support is stable, native, and zero-dependency

This is the load-bearing fact for the whole recommendation, so it is worth stating precisely.

- `--env-file`: "Added in: v20.6.0", and the changes block records `v24.10.0, v22.21.0 - The
  --env-file flag is no longer experimental."
  Source: https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/cli.md and
  https://nodejs.org/docs/latest-v26.x/api/cli.html
- `process.loadEnvFile(path)`: added `v21.7.0`/`v20.12.0`, changes block records
  `v24.10.0`, `v22.21.0 - This API is no longer experimental.` (PR 59925). Default path is `'./.env'`.
  Source: https://raw.githubusercontent.com/nodejs/node/v26.x/doc/api/process.md and
  https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/process.md
- `util.parseEnv(content)` carries the identical history block - useful if the `onair` CLI ever
  wants to read the same file without sourcing it as shell.
  Source: https://raw.githubusercontent.com/nodejs/node/v26.x/doc/api/util.md
- `--env-file-if-exists` (added v22.9.0, also de-experimentalised in v22.21.0/v24.10.0): "Behavior is
  the same as `--env-file`, but an error is not thrown if the file does not exist."

Both LTS lines and Current therefore have a stable, built-in dotenv. The functions have existed since
v20.12/v21.7, so they work on any Node 22.x; only the stability label changed in 22.21.0. Nothing to
add to `package.json`, so the zero-production-dependency rule is untouched.

**File format, verbatim from the docs:** one `KEY=value` per line; "Any text after a `#` is treated
as a comment"; "Values can start and end with the following quotes: `` ` ``, `"` or `'`. They are
omitted from the values."; multi-line values supported since v21.7.0/v20.12.0; "Export keyword before
a key is ignored."

**Precedence, verbatim:** "If the same variable is defined in the environment and in the file, the
value from the environment takes precedence."

### Verified on this machine (node v26.6.0)

```
$ node -e "console.log(typeof process.loadEnvFile, typeof (require('node:util')).parseEnv)"
function function
```

Precedence confirmed empirically for `loadEnvFile` (the docs state it only for `--env-file`):

```
### file exists, no preexisting env
config file: ./cfg.env
  ONAIR_PORT       = 9090
### a real env var still wins
$ CFG=./cfg.env ONAIR_PORT=1234 node svc.mjs
  ONAIR_PORT       = 1234
### malformed line does not crash the daemon
$ printf 'this is not a env line\nONAIR_PORT=5555\n' > bad.env
  ONAIR_PORT       = 5555
### missing file throws ENOENT (must be caught)
loadEnvFile THREW: ENOENT - ENOENT: no such file or directory
```

### The gotcha that decides the implementation

Because **the real environment wins over the file**, the plist's current `EnvironmentVariables` block
would *defeat* the config file. `deploy/com.rocket.onair.plist.template` today sets `ONAIR_PORT` and
`ONAIR_STATE_FILE` there; if left in place, editing `config.env` would appear to do nothing - a worse
footgun than the one being removed.

So the change is a pair:

1. Strip `ONAIR_PORT` and `ONAIR_STATE_FILE` from the plist template's `EnvironmentVariables`,
   leaving only `HOME`. Drop the `@PORT@` and `@STATE_FILE@` placeholders. The `ONAIR_TOKEN`
   PlistBuddy append in `cmd_install` (`deploy/onair:174-178`) goes away too - the token moves into
   `config.env`, which is a strict improvement since it stops a secret being written into a
   world-readable `0644` file under `/Library/LaunchDaemons`.
2. Add the loader to `src/index.ts`, ahead of the existing `process.env` reads at lines 15-17:

```ts
// Config precedence: real env > ~/.onair/config.env > defaults below.
const configPath = process.env.ONAIR_CONFIG ?? join(homedir(), '.onair', 'config.env');
try {
  process.loadEnvFile(configPath);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
```

The remaining plist placeholders are `@NODE@`, `@APPDIR@`, `@USER@`, `@HOME@` - all of which are
*host layout*, not *config*. They change when you move the checkout or upgrade node, not when you
change a setting. That is the right split, and it is what makes the design evolvable: **a new env var
added to the service in future requires no change to the plist, the template, the installer, or the
CLI.** Today, every new env var requires touching all four.

Secondary benefit: `deploy/onair` currently refuses to source `cli.env` under sudo precisely because
"sourcing it as root would execute arbitrary user-controlled code with root privileges"
(`deploy/onair:41-44`). A `KEY=value` file parsed by Node rather than sourced by bash removes that
hazard class. The CLI can read it with `util.parseEnv` via a one-line `node -e`, or with a
`grep`/`cut` that does not evaluate anything.

### What comparable daemons do (all primary sources)

**Caddy** - the shipped unit hardcodes the config path and never changes when config does:

```ini
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
```
Source: https://raw.githubusercontent.com/caddyserver/dist/master/init/caddy.service

The documented change workflow is "you can edit your configuration with `nano`, `vi`, or your
preferred editor: `sudo nano /etc/caddy/Caddyfile`" then "you can gracefully reload Caddy after making
any changes: `sudo systemctl reload caddy`". For unit-level changes it says "The best way to override
aspects of the service files is with this command: `sudo systemctl edit caddy`".
Source: https://caddyserver.com/docs/running

**Tailscale** - env file plus variable substitution, and it uses `StateDirectory` rather than a
hand-managed state path:

```ini
EnvironmentFile=/etc/default/tailscaled
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${PORT} $FLAGS
Restart=on-failure
StateDirectory=tailscale
StateDirectoryMode=0700
```
Source: https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscaled/tailscaled.service

The env file it ships is two settings with comments, nothing more:
```
PORT="41641"
FLAGS=""
```
Source: https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscaled/tailscaled.defaults

**Homebrew services** - the closest analogue, because it faces the same launchd problem. Formulae
declare a `service do ... end` block with keys `run`, `run_type`, `keep_alive`,
`environment_variables`, `working_dir`, `log_path`, `error_log_path`, and Homebrew generates the
`.plist` on macOS and `.service` on Linux from it
(https://docs.brew.sh/Formula-Cookbook). Crucially, config is a *separate* file the operator owns:

> "Environment variables can be added or overridden for a service by creating
> `$HOMEBREW_USER_CONFIG_HOME/services/<formula>.env` (defaults to `~/.homebrew/services/<formula>.env`).
> The file uses `KEY=value` format, one per line; lines starting with `#` are comments. Changes take
> effect on the next `brew services restart` and persist across upgrades."

Source: https://docs.brew.sh/Manpage

Note the shape: generated service file + operator-owned `.env` + "changes take effect on the next
restart". That is exactly the proposal. The one improvement available here is that because *our*
service is the thing reading the file, not the supervisor, we do not even need to regenerate the
plist the way `brew services` does.

### On the Pi, use the native mechanism

systemd has this built in. From `systemd.exec.xml`:

> "The argument passed should be an absolute filename or wildcard expression. If the file does not
> exist, cannot be read, or contains invalid content, the service will fail to start. **To make the
> file optional, prefix the path with `-`, which causes all errors related to the file to be silently
> ignored.**" ... "Settings from these files override settings made with `Environment=`."

So the unit gets `EnvironmentFile=-/etc/onair.env` and nothing else changes. Note this and the Node
loader are complementary, not redundant: with both, the Pi works identically whether the operator
edits `/etc/onair.env` (systemd injects it) or `~/.onair/config.env` (the service reads it). Pick one
and document it; `EnvironmentFile=-` is the more idiomatic choice on Linux.

Also worth adopting on the Pi, same man page:

- `StateDirectory=onair` creates `/var/lib/onair` "including their parents", chowns it to `User=`,
  sets `$STATE_DIRECTORY`, and the directories "are not removed when the unit is stopped". This can
  back `ONAIR_STATE_FILE`'s default and deletes the mkdir/chown dance from install.
- `DynamicUser=yes` removes the `User=pi` hardcode that `deploy/onair.service` already complains
  about in its own comment. Caveat from the docs: "UID/GIDs are recycled after a unit is terminated",
  harmless for a service that owns only its own `StateDirectory`.
- `systemd-analyze verify` detects "commands listed in `ExecStart=` and similar which are not found
  in the system or not executable" - the Linux counterpart to the existing `plutil -lint` gate.

### macOS asymmetry, stated honestly

launchd has **no** `EnvironmentFile` and no drop-in mechanism. `launchd.plist(5)` offers only
`EnvironmentVariables`, "a dictionary of strings ... used to specify additional environmental
variables to be set before running the job". This is precisely why the config-file-first design is
more valuable on the Mac than on the Pi: on Linux the supervisor can read a config file for you, on
macOS only the application can. Having the Node process load its own config is the *only* way to get
a genuinely static plist.

**Risk:** the service must not fail closed when `config.env` is absent or malformed. The `ENOENT`
catch above handles absence; the docs' "lines without an `=` separator ... will be ignored" handles
malformed lines, verified above. A file with a bad *value* (e.g. `ONAIR_PORT=abc`) still exits 1 via
the existing `parsePort` guard, and `KeepAlive` will crash-loop it - same as today. Worth a
`onair config check` verb that parses the file and prints the effective values before restarting.

---

## 2. A bootstrap script and an `onair update` verb

### Fresh install: `deploy/bootstrap`, not `curl | bash`

**`curl | bash` is not the right fit for this repo.** The prerequisite argument is decisive: the
machine must already have git and Node >= 22 because `tsc` runs at install time, and the operator is
also the developer. The entire value proposition of a piped installer is "you have nothing, and I
will get you to a working state without you cloning anything" - Tailscale ships distro packages,
Homebrew bootstraps its own git checkout, pi-hole installs apt packages. None of those is this
situation: here, the install *is* a git checkout.

It also costs something real: a second install path to keep working. If the hosted script clones the
repo it lives in, the logic exists twice unless it is a thin shim. Pi-hole's structural lesson - one
install implementation - applies.

If a one-liner is wanted later, make the hosted script a shim that clones and then `exec`s
`deploy/bootstrap`, so there is still exactly one implementation.

Recommended shape:

```sh
git clone https://github.com/jwnichols3/rocket-on-air-sensor.git ~/code/rocket-on-air-sensor
cd ~/code/rocket-on-air-sensor && sudo deploy/bootstrap
```

where `bootstrap` is `npm ci && npm run build && exec deploy/onair install "$@"`. Note `npm ci`, not
`npm install`: reproducible from the committed lockfile, and it removes cruft.

On the security posture, pi-hole's own docs concede the criticism rather than dismiss it: "Piping to
`bash` is a controversial topic, as it prevents you from reading code that is about to run on your
system... If you would prefer to review the code before installation, we provide these alternative
installation methods" (https://docs.pi-hole.net/main/basic-install/). The one hazard unique to the
pipe is partial execution of a truncated download, and it has a free fix that Tailscale documents in
its own script:

```sh
# All the code is wrapped in a main function that gets called at the
# bottom of the file, so that a truncated partial download doesn't end
# up executing half a script.
main() {
```
Source: https://tailscale.com/install.sh

### Techniques worth stealing, and ceremony to skip

From reading Tailscale's, Homebrew's, and pi-hole's installers in full:

**Worth adopting (cheap, real):**

| Technique | Notes |
|---|---|
| `main() { ... }; main "$@"` | Truncation guard. Costs nothing, makes the file structurally reviewable. |
| Check existing state before acting | The core idempotency primitive. Homebrew builds arrays of only the outstanding work (`exists_but_not_writable`, `file_not_owned`, `user_only_chmod`) and prints the plan before executing - a de-facto dry-run. `deploy/onair` already does this with `is_loaded`. |
| `mktemp` + `install(1)` for final placement | Pi-hole uses `install -o ... -m ...` for *every* file, never `cp`. `deploy/onair` already does this for the plist. Keep it as the rule. |
| Validate the artifact before installing it | `plutil -lint` here is the exact analogue of pi-hole's `sha1sum --status --quiet -c` before it touches `/usr/bin/pihole-FTL`. Never install an unvalidated artifact. |
| Explicit `SUDO=` variable | Tailscale: `if [ "$(id -u)" = 0 ]; then SUDO=""; elif type sudo; then SUDO="sudo"; ...` then every privileged line is `$SUDO cmd`. One-liner, prevents half-root installs. |
| `--dry-run` on the update verb | ~10 lines. Both `tailscale update` and `brew upgrade` ship it. |
| Health-check after every mutating verb | Already present as `mutating_health_poll`, and it is the highest-value safety feature in the whole script. |

**Ceremony at this scale:** OS/distro/arch detection matrices (two targets, four lines of `uname`);
server-side "is this platform supported" endpoints; GPG keyring management; `retry N` with
exponential backoff (a home LAN failure should fail loudly, not retry); the
`CI`/`INTERACTIVE`/`NONINTERACTIVE` triple-state and `SUDO_ASKPASS`; termios-saving `getc` prompts
(`[[ -t 0 ]] && read -r -p` is enough).

One nuance worth knowing: Homebrew's documented command is `/bin/bash -c "$(curl -fsSL ...)"`, **not**
`curl | bash`, because command substitution keeps stdin on the terminal so its confirmation prompt
works. A true pipe trips its `[[ ! -t 0 ]]` branch and silently goes non-interactive.

### The `update` verb

All three comparables share one shape: a cheap read-only detection phase, an explicit no-op exit when
current, a dry-run mode, and the actual work delegated to the same code path as install.

- `tailscale update`: "Update the Tailscale client version to the latest version, or to a different
  version", with `--dry-run` ("Show what update would do, without performing the update and without
  prompting to start the update") and `--yes`. Source: https://tailscale.com/kb/1080/cli
- `brew` splits the two: `brew update` "Fetch the newest version of Homebrew and all formulae from
  GitHub"; `brew upgrade` "Upgrade outdated, unpinned packages", with `-n, --dry-run`.
  Source: https://docs.brew.sh/Manpage
- `pihole -up` fetches, compares `git describe --abbrev=0 --tags master` against `origin/master`,
  prints per-component status, exits 0 with "Everything is up to date!" when there is nothing to do,
  and otherwise **re-runs the installer** as `basic-install.sh --repair --unattended`. It supports
  `--check-only`. Source: `advanced/Scripts/update.sh` and
  `automated install/basic-install.sh` in https://github.com/pi-hole/pi-hole,
  https://docs.pi-hole.net/main/update/

Proposed: `onair update [--check-only] [--dry-run] [--yes]`

1. **Refuse on a dirty tree.** `git diff --quiet && git diff --cached --quiet`, else abort listing the
   files. Do *not* copy pi-hole's `git stash --all` - their checkout in `/etc/.pihole` is not meant to
   be edited, yours is your dev tree. Silently stashing a single owner's work in progress is worse
   than stopping.
2. **Detect.** `git fetch --quiet origin`, compare `git rev-parse @` with `@{u}`. Equal and `dist/`
   newer than `src/` means print "Everything is up to date" and exit 0.
3. **`--check-only` / `--dry-run` exit here**, printing `git log --oneline @..@{u}`.
4. **Apply.** `git merge --ff-only @{u}` - never a merge commit, fails loudly on divergence. Then
   `npm ci`.
5. **Build to a scratch dir, then swap.** `npx tsc --outDir .dist-next`, validate, then
   `rm -rf dist.prev && mv dist dist.prev && mv .dist-next dist`. This is pi-hole's
   mktemp-verify-install sequence applied to a directory: `dist/` is never in an intermediate state.
6. **Restart and health-check.** `onair restart` already health-polls.
7. **Roll back on failure.** Restore `dist.prev`, restart, exit non-zero with the failing health body.

Failure modes and the mitigation each maps to:

| Failure mode | Mitigation |
|---|---|
| Dirty working tree - `git pull` conflicts mid-update | Step 1: hard refuse, list files |
| Diverged branch - accidental merge commit | Step 4: `--ff-only` |
| Build failure leaves a broken `dist/` and the daemon restarts into it | Step 5: build to `.dist-next`, swap only on success |
| Compiles but does not run; launchd `KeepAlive` crash-loops it forever | Step 6 health poll, step 7 rollback |
| Dependency drift between Mac and Pi | `npm ci` from the committed lockfile |
| **Node upgraded under you, `@NODE@` in the plist now stale** | `update` should compare `command -v node` against the value in the installed plist and re-render + re-bootstrap if they differ. Cheap `grep`, real failure class |
| Half-applied update after Ctrl-C | `trap` restoring `dist.prev` if `.dist-next` exists |

The ordering rule worth writing down: git and npm changes are reversible, the daemon restart is not,
so restart last, after the build has been validated. Pi-hole follows exactly this - `stop_service`
runs only after the sha1 check passes.

---

## 3. Node SEA and `bun build --compile`

The pitch is real - one binary path in the plist forever, no Node on the hosts - but the evidence
does not support it here. Everything below was built and measured, not inferred.

### Node SEA is not ready and does not fit this service

**Stability has not moved in three major lines.** "Stability: 1.1 - Active development" in Node 22,
24, and 26 (https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html,
`/latest-v24.x/`, `/latest-v26.x/`). Stability 1 means, verbatim from
https://nodejs.org/api/documentation.html: "The feature is not subject to semantic versioning rules.
Non-backward compatible changes or removal may occur in any future release. **Use of the feature is
not recommended in production environments.**"

**This service is ESM, and SEA is CommonJS-only in both LTS lines.** Verbatim from the v22 and v24
pages: "The single executable application feature currently only supports running a single embedded
script using the **CommonJS** module system." ESM support arrived in v25.7.0 via
https://github.com/nodejs/node/pull/61813 and the v26 page now reads "supports running a single
embedded script using the CommonJS or the ECMAScript Modules module system". Node 26 is Current, not
LTS until Oct 2026. So adopting SEA today means pinning to Current or transpiling this ESM codebase
to CJS.

**SEA does not bundle.** Verbatim: "In the injected main script, module loading does not read from
the file system. By default, both `require()` and `import` statements would only be able to load the
built-in modules. Attempting to load a module that can only be found in the file system will throw an
error." The docs' answer is "Users can bundle their application into a standalone JavaScript file to
inject into the executable." For ~10 source files that means adding esbuild or rollup to a repo whose
stated selling point is zero dependencies. Build-time only, but still a new moving part.

**Measured sizes** (Node v26.6.0, this hardware):

| Artifact | Size |
|---|---|
| SEA, darwin-arm64 | **137.1 MiB** |
| SEA, linux-arm64 | **141.5 MiB** |
| Bun 1.3.14 compile, darwin-arm64 | 60.5 MiB |
| Bun 1.3.14 compile, linux-arm64 | 89.4 MiB |
| The actual application | ~20 KB |

Roughly 280 MiB of release assets per version. Startup showed no benefit: `real 0.03s` for both plain
`node tiny.mjs` and the SEA, five runs each.

**Two silent-failure landmines found by building it:**

1. An unsigned arm64 SEA is **SIGKILLed instantly with no output** (`exit=137`). After
   `codesign --sign - onair` it runs. Ad-hoc signing is sufficient for a locally built launchd daemon
   - no Developer ID, no notarization. Apple DTS states the underlying rule: "Apple silicon Macs will
   not run unsigned code... If it didn't do that, your program wouldn't start at all"
   (https://developer.apple.com/forums/thread/732767). Forget the codesign step in CI and launchd
   reports only a crash loop.
2. **Homebrew's node has SEA compiled out** (it is built against a shared `libnode.dylib`):
   `node --build-sea sea-config.json` returns `node: Single executable application is disabled.` You
   must use an official nodejs.org build. This would bite immediately, since `docs/mac-setup.md`
   already recommends Homebrew node for the daemon.

**Cross-compilation does work.** Point `"executable"` at the target platform's node binary and set
`useCodeCache` and `useSnapshot` to false - the docs require this: "When generating cross-platform
SEAs (e.g., generating a SEA for linux-x64 on darwin-arm64), useCodeCache and useSnapshot must be set
to false to avoid generating incompatible executables." A valid linux-arm64 ELF was produced from
this Mac. In any case CI makes it moot: `macos-latest`/`macos-15` are Apple Silicon and
`ubuntu-24.04-arm` is generally available, and "Use of the standard GitHub-hosted runners is free and
unlimited on public repositories"
(https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

### Bun is the better binary, if a binary is ever wanted

`bun build ./src/index.ts --compile --outfile onair` compiles TypeScript directly with no `tsc` or
bundler step, officially cross-compiles (`--target=bun-linux-arm64`, verified: it downloaded the
aarch64 runtime and emitted a valid ARM64 ELF in about a second), ad-hoc signs itself on macOS
(`flags=0x20002(adhoc,linker-signed)` - one fewer thing to get wrong than SEA), and needs nothing
installed on the target. Source: https://bun.com/docs/bundler/executables. Bun's own docs are candid
about size: "Overall though, Bun's binary is still way too big and we need to make it smaller."

The real cost is that the daemon would then run **the Bun runtime, not Node**, so production stops
matching `node dist/index.js` in dev. For this service's surface that is low risk - Bun documents
`node:http`, `node:fs` and `node:os` as "Fully implemented"
(https://bun.com/docs/runtime/nodejs-apis) - but `node:child_process` is marked partial, which
matters if the future Detector shells out to `lsof`, `log stream`, or `osascript`.

`vercel/pkg` is dead: "This repository was archived by the owner on Jan 13, 2024" and "pkg has been
deprecated with 5.8.1 as the last release" (https://github.com/vercel/pkg).

### What gets the benefit without the cost

The genuine benefit being chased is not "no Node on the host" - that is one `brew install node` and
one `apt install nodejs` over the project's life. It is **runtime stability**: a `brew upgrade` should
not move the interpreter under a plist that hardcodes `@NODE@`.

That is fully solved for free by unpacking a pinned official Node tarball to a fixed absolute path
(`/usr/local/lib/onair/node/bin/node`) and pointing the plist at it, with the app at
`/usr/local/lib/onair/current/` as a symlink you flip on upgrade. Frozen runtime, stable path,
rollback is `ln -sfn`, release artifact is ~20 KB of platform-independent JavaScript, and the release
workflow is `tsc`, `tar czf`, `gh release create` on a single runner. No bundler, no codesigning, no
experimental features, no matrix CI.

**Verdict: no binary.** If a single-file install ever becomes genuinely necessary (say the Pi gets
reflashed often), use `bun build --compile`, not SEA.

---

## 4. npm-based delivery

### `npm install -g` from a git spec is broken for this repo today

Not a theoretical objection - it was run. macOS, node v26.6.0, npm 11.18.0, Homebrew prefix, no
`.npmrc`:

```
$ npm install -g github:jwnichols3/rocket-on-air-sensor
npm error git dep preparation failed
npm error   command sh -c npm run build
npm error   > tsc
npm error   sh: tsc: command not found
npm error code 127
```

Nothing is installed. The cause is that `--global` mode leaks into the git-dependency preparation
step, so devDependencies are omitted and `typescript` never lands in the clone's `node_modules/.bin`.
The same specifier installs correctly *non-globally* (`npm install github:jwnichols3/...` in a scratch
project produces a built `dist/` and a `.bin/onair-api` symlink), which is why the Pi's `npx` path
happens to work.

npm's `prepare` behavior for git deps is documented - "If the package being installed contains a
`prepare` script, its `dependencies` and `devDependencies` will be installed, and the prepare script
will be run, before the package is packaged and installed"
(https://docs.npmjs.com/cli/v11/using-npm/scripts) - so this is a bug or a deliberate global-mode
narrowing, but either way it is the current behavior.

Separately, npm 11.18 now warns: `npm warn allow-scripts 1 package has install scripts not yet
covered by allowScripts: onair-api@0.1.0 (prepare: npm run build)`. `allow-scripts` is documented as
gating "install-time lifecycle scripts ... and `prepare` for non-registry dependencies"
(https://docs.npmjs.com/cli/v11/using-npm/config). Today a warning; if the default ever flips, every
build-on-install delivery path breaks. Worth designing away from.

The viable npm form is a **prebuilt release tarball**, which skips git and skips `prepare` entirely:

```sh
sudo npm install -g https://github.com/jwnichols3/rocket-on-air-sensor/releases/download/v0.2.0/onair-api-0.2.0.tgz
```

Deterministic, pinned by URL, offline-cacheable. Cost: a `npm pack` step in CI.

**Global bin path caveat.** `npm prefix -g` here is `/opt/homebrew`, which is version-independent, so
`brew upgrade node` leaves `/opt/homebrew/bin/*` in place. With nvm the prefix is
`~/.nvm/versions/node/vX.Y.Z` and global bins do *not* follow a node upgrade - any absolute path baked
into a plist breaks silently. This matches the existing nvm warning in `docs/mac-setup.md` and
generalises it: never bake a version-dependent prefix into a daemon definition.

### `npx github:` at boot is the weakest link in the current design

Three findings, all verified.

**It re-resolves the git ref on every single run.** npm's own source
(https://raw.githubusercontent.com/npm/cli/latest/workspaces/libnpmexec/lib/index.js) fetches the
manifest with `preferOnline: true` and, for any non-registry spec, requires that manifest before it
can decide the cache is valid:

```js
const manifest = await getManifest(spec, flatOptions)
...
if (node.package.resolved === manifest._resolved || ...) {
  // we have a package by the same name and the same resolved destination, nothing to add.
```

Resolving a git manifest contacts the remote. Confirmed by controlled experiment with a fully
populated `_npx` cache and the remote then made unreachable:

```
run 1: RAN v1     # cold cache
run 2: RAN v1     # warm cache, still contacts remote
remote removed:
run 3: EXIT=128, zero bytes on stdout AND stderr
remote restored + new commit:
run 4: RAN v2     # silently upgraded to new HEAD, no user action
```

So no network at boot means **the on-air light does not come up, and the only diagnostic is an exit
code**. And every restart silently adopts whatever is on `main`, including a commit pushed sixty
seconds ago.

**`After=network-online.target` does not save this.** From systemd's own document
(https://systemd.io/NETWORK_ONLINE/): it "actively waits until the network is 'up', where the
definition of 'up' is defined by the network management software. Usually it indicates a configured,
routable IP address of some kind", it "will time out after 90s", and DNS is explicitly not
guaranteed - the document's own remedy for "the name can be resolved over DNS and the appropriate
route has been established" is a custom `until ping -c 1 example.com` unit. It also notes the target
"means that the network connectivity has been reached, not that it is currently available".

**The start limiter can leave the unit permanently failed.** Defaults are
`DefaultStartLimitIntervalSec=10s` and `DefaultStartLimitBurst=5`
(`systemd-system.conf`), and from `systemd.unit`: "units which are configured for `Restart=`, and
which reach the start limit are not attempted to be restarted anymore ... `systemctl reset-failed`
will cause the restart rate counter for a service to be flushed". With `RestartSec=5` five attempts
span ~20s and usually dodge the 10s window, but a fast-failing `npx` (exit 128 arrives in well under a
second on NXDOMAIN or no route) can burn five starts inside 10s and leave the unit `failed` until
someone SSHes in. On a headless Pi that is an unattended-boot outage needing manual recovery - the
worst possible failure mode for an on-air light. The existing comment in `deploy/onair.service` is
right that `StartLimitIntervalSec=0` disables the limit, but that converts "permanently failed" into
"retries forever without succeeding".

### Ranking for the Pi

1. **Git checkout with a built `dist/` and `ExecStart=/usr/bin/node /opt/onair/dist/index.js`.** The
   only option with zero network dependency at start. Survives a dead router, a slow DHCP lease,
   GitHub being down, and a bad commit. Updates become the deliberate, health-gated `onair update`.
   It also makes both hosts use the same verbs, which is a real operational win.
2. **npm global from a prebuilt release tarball.** Offline-safe at boot, pinned by URL, immune to the
   `allow-scripts` trend. Costs a CI packing step. Rank this first if you ever want to install on a
   machine with no dev toolchain.
3. **`npx --yes github:` at boot.** Last, for the reasons above. Keep it documented only as a
   throwaway "try it on a fresh Pi in 30 seconds" demo, never as the installed unit.

Minimal unit change:

```ini
[Service]
Type=simple
WorkingDirectory=/opt/onair
EnvironmentFile=-/etc/onair.env
ExecStart=/usr/bin/node /opt/onair/dist/index.js
DynamicUser=yes
StateDirectory=onair
Restart=always
RestartSec=5
```

Drop `After=`/`Wants=network-online.target` unless the service binds a specific address rather than
the wildcard - systemd's guidance is that wildcard binds "are unconditionally available".

---

## 5. Declarative host config tools

### Ansible: the only option that structurally solves the problem, and still not worth it yet

The mechanism that matters is `ansible.builtin.template` plus a `notify` handler. Handlers "only run
when notified", and fire only when the notifying task reports **changed**
(https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_handlers.html). That is exactly the
"config changed, so re-render the unit and restart the daemon, otherwise do nothing" loop - the stated
evolvability goal - with no bespoke bash. `template` also supports `validate` ("The validation command
to run before copying the updated file into the final destination"), which on the Pi means gating on
`systemd-analyze verify %s`, and it "Can run in check_mode and return changed status prediction
without modifying target".

For launchd there is no first-party module; `ansible.builtin.service` documents its supported init
systems as "BSD init, OpenRC, SysV, Solaris SMF, systemd, upstart" - launchd is absent.
`community.general.launchd` exists and documents that "started/stopped are idempotent actions that do
not run commands unless necessary. launchd does not support restarted nor reloaded natively" (it
emulates them with an unload/load cycle) and has a `force_stop` parameter specifically for
`KeepAlive: true` jobs, which this service uses. It manages the *job*, not the plist file - you still
render the plist with `template`.

Realistic size: an `inventory.ini` of two lines, a `site.yml` of ~40 lines, and the two templates that
already exist. About 60 lines of YAML replacing 378 lines of bash.

**What kills it today is the Python floor.** ansible-core 2.18 and 2.19 both require **Python
3.11-3.13 on the control node**
(https://docs.ansible.com/ansible-core/devel/reference_appendices/release_and_maintenance.html), and
this Mac's `/usr/bin/python3` is **3.9.6**. So Ansible means installing and maintaining a separate
Python toolchain, plus a `community.general` collection dependency, plus an ansible-core with an
~18-month support window (2.17 EOL Nov 2025, 2.18 EOL May 2026), plus the documented macOS
`OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` workaround
(https://docs.ansible.com/ansible/latest/reference_appendices/faq.html). For someone touching this
twice a year, the probability that `ansible-playbook` simply runs on the second touch is meaningfully
below 1.

**Verdict: defer.** Revisit at four or more hosts, or when the Mac needs three or more job
definitions. The LaunchDaemon-plus-LaunchAgent finding below moves that day closer than it looks.

### Nix / nix-darwin: elegant, and far too much machinery

nix-darwin's `launchd.daemons.<name>` is a typed 1:1 mapping onto `launchd.plist(5)` -
`serviceConfig.Label`, `.ProgramArguments`, `.KeepAlive`, `.RunAtLoad`, `.EnvironmentVariables`, plus
`command`, `environment`, `path` (https://nix-darwin.github.io/nix-darwin/manual/). NixOS's
`systemd.services.<name>` uses **literally the same option names and descriptions**
(https://raw.githubusercontent.com/NixOS/nixpkgs/master/nixos/lib/systemd-unit-options.nix). That
cross-platform symmetry is the genuinely attractive part, and `darwin-rebuild --rollback` /
`--list-generations` are real atomic rollback.

Against it: flakes remain experimental - "Experimental features are considered unstable, which means
that they can be changed or removed at any time"
(https://nix.dev/manual/nix/latest/development/experimental-features) - while nix-darwin's own README
says "Despite being an experimental feature in Nix currently, nix-darwin recommends that beginners use
flakes". The macOS install "will create a new APFS volume for your Nix store" and "creates system
users and a system service for the Nix daemon"
(https://nix.dev/manual/nix/stable/installation/installing-binary). Store growth becomes a permanent
`nix-collect-garbage` chore. And on the Pi it means replacing Raspberry Pi OS with NixOS - aarch64 is
well supported with a real binary cache (https://wiki.nixos.org/wiki/NixOS_on_ARM) but you would be
re-solving every future hardware dependency (GPIO, libcamera, vendor userland) in Nix packaging.

For a three-env-var service maintained by one person twice a year, this maximises the chance that the
*tooling*, not the service, is what is broken when you come back. **No.** (home-manager is irrelevant
here - this is a root LaunchDaemon, not dotfiles.)

### Makefile: cosmetic for the ops verbs

Make gives one thing bash does not: timestamp-driven dependency logic, useful for exactly one rule
here (`/Library/LaunchDaemons/....plist: deploy/....plist.template` - re-render only when the template
changes, a poor-man's Ansible handler). Standard verbs are a real GNU convention
(https://www.gnu.org/software/make/manual/html_node/Standard-Targets.html).

But 6 of the 11 existing subcommands (`logs`, `status`, `reset-state`, `enable`, `disable`, `restart`)
have no file-dependency semantics at all - they are pure verbs, and make gives them nothing that
`case "$1" in` does not, at the cost of `.PHONY` boilerplate for each
(https://www.gnu.org/software/make/manual/html_node/Phony-Targets.html). Two further constraints:
`/usr/bin/make` on this Mac is **GNU Make 3.81 (2006)**, since Apple does not ship 4.x; and make reads
"the makefile in the current directory", so `sudo make install` from `~` fails while `sudo onair
status` works from anywhere. For a tool you invoke at 2am when the light is stuck on, a symlinked CLI
on `PATH` beats a repo-relative target.

**Verdict:** keep `deploy/onair`. Optionally add a thin Makefile for `build`/`test`/`clean` only.

---

## 6. Other options considered

### Docker / OrbStack: architecturally disqualified on the Mac

Docker's own documentation states that Docker Desktop uses VMMs "to power the **Linux VM** that runs
containers" (https://docs.docker.com/desktop/features/vmm/). OrbStack likewise "uses a lightweight
Linux virtual machine with a shared kernel" (https://docs.orbstack.dev/architecture). Everything in
that VM sees a Linux kernel, a Linux PID namespace, and a Linux filesystem. Therefore:

- `lsof` in the container lists the VM's descriptors, not the Mac's.
- `log stream` (macOS unified logging) does not exist there.
- `osascript` / AppleScript does not exist there.
- Camera and mic in-use state comes from CoreMedia/CoreAudio, which has no Linux-VM surface.

**The future Detector cannot work in a container on the Mac.** Since the Detector is the point of the
product on that host, containerising only the API would split the system across a VM boundary for no
benefit. Supporting evidence for where the boundary sits: Docker Desktop's host networking doc notes
"Only Linux containers are supported" (https://docs.docker.com/engine/network/drivers/host/) - "host"
means the Linux VM.

On the Pi, Compose restart policies (`always`, `unless-stopped`, `on-failure`,
https://docs.docker.com/reference/compose-file/services/#restart) duplicate the `Restart=always` the
unit already has, while adding a daemon, an arm64 image pipeline, and a ~50-150 MB Node base image to
a zero-dependency service. Resource baseline on the Mac is also non-trivial: Docker Desktop requires
"At least 4 GB of RAM" and its memory setting defaults to "50% of your host's memory". **Verdict: no.**

### systemd portable services: over-engineering

"A portable service is ultimately just an OS tree, either inside of a directory, or inside a raw disk
image containing a Linux file system" (https://systemd.io/PORTABLE_SERVICES/). Shipping one requires
building a tree containing the runtime, an `os-release`, a `machine-id`, and mountpoint directories
for `/proc/ /sys/ /dev/ /run/ /tmp/ /var/tmp/`, then rebuilding it on every code change. They exist to
bundle multi-service payloads with sandboxing onto fleets you do not control. One Pi, one service.
**No.**

### The macOS finding that should change the architecture

Apple's daemon/agent documentation: "A user agent is essentially identical to a daemon, but is
specific to a given logged-in user and executes only while that user is logged in", with plists in
`/Library/LaunchDaemons` versus `/Library/LaunchAgents`
(https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
`launchd.plist(5)` reinforces it: `UserName`/`GroupName` are "only applicable for services that are
loaded into the privileged system domain", and `LimitLoadToSessionType` "only applies to jobs which
are agents. There are no distinct sessions in the privileged system context."

Consequence: a LaunchDaemon has **no user session**. It cannot drive AppleScript against the logged-in
user's apps, and TCC permissions (camera, mic, Screen Recording, Full Disk Access) are per-user and
prompt in a GUI session. The likely end state is therefore **a LaunchDaemon for the HTTP API** (binds
the port, survives logout) **plus a LaunchAgent for the Detector** (has session context and TCC
grants), talking over localhost.

That doubles the templating requirement on the Mac and is a larger evolvability pressure than the
three env vars this research started from. It is worth recording in `CONTEXT.md` as a decision input
before the tooling is finalised - and it is the main thing that would eventually justify Ansible.

### Smaller items

- **`just`** (https://just.systems/man/en/) fixes make's warts ("a command runner, not a build system,
  so it avoids much of make's complexity and idiosyncrasies", no `.PHONY`) but is a new binary on both
  hosts and keeps the repo-checkout constraint. Lateral move.
- **`mise`** (https://mise.jdx.dev/) is a good way to pin Node >= 22 in the *dev shell*. Keep it out
  of `ExecStart`/`ProgramArguments` - daemons must get absolute paths, not version-manager shims.
- **systemd user services** plus `loginctl enable-linger` ("allows users who are not logged in to run
  long-running services") would avoid sudo for restarts on the Pi, but adds a step that is easy to
  forget on a rebuild and is asymmetric with the Mac's LaunchDaemon. Stay with a system service.

---

## Recommended combinations

### 1. Config-file-first + `bootstrap`/`update` verbs, keeping the bash CLI (recommended)

Adopt approach 1 and approach 2, change nothing else.

- (a) Fresh install: `git clone` then `sudo deploy/bootstrap`. Two commands, both hosts.
- (b) Code update: `onair update`, health-gated with rollback.
- (c) Config change: edit `~/.onair/config.env`, `onair restart`. No re-render, no `reload` trap.
- (d) Pi migration: same two commands, plus `EnvironmentFile=-/etc/onair.env`, `StateDirectory=onair`,
  `DynamicUser=yes` in a static unit.

**Why it ranks first on evolvability-per-maintenance-burden:** it adds zero new tools, zero
dependencies, and zero new languages, while removing the two structural problems - config coupled to
the supervisor definition, and no single update verb. The evolvability test is the honest one: adding
a fourth env var next month currently means touching the template, the installer's `sed` pipeline, the
CLI's config block, and two docs. Afterwards it means adding one line to `src/index.ts` and one line
to a config file. Estimated effort: half a day.

### 2. The above, plus a pinned Node runtime at a fixed path

Everything from combination 1, plus unpacking an official Node tarball to
`/usr/local/lib/onair/node/` and pointing `@NODE@` at it, so `brew upgrade` cannot move the
interpreter under the daemon. Optionally publish a `dist/` tarball per release so a host can be
provisioned without a build toolchain.

**Why second:** it closes the last real drift risk that combination 1 leaves open (the nvm/Homebrew
`@NODE@` problem `docs/mac-setup.md` already documents at length), and it captures most of the value
people chase with SEA - a frozen runtime at a stable path - for none of the cost. It is second only
because it adds a provisioning step and a release artifact to maintain, and the drift risk is
currently mitigated by documentation and by Homebrew's stable symlink.

### 3. The above, plus Ansible once the Mac needs two jobs

If the LaunchDaemon-plus-LaunchAgent split lands, or a third host appears, move the rendering into a
small playbook: `template` for each plist and the unit, `notify` handlers for reload, `validate:
systemd-analyze verify %s` on the Pi. Keep `deploy/onair` as the day-to-day ops CLI - Ansible would
own *installation*, not `logs`/`status`/`restart`.

**Why third:** it is the only approach that structurally guarantees "config changed, therefore restart,
otherwise do nothing", but the Python 3.11+ entry fee on a Mac shipping Python 3.9.6 is a real,
recurring cost that is not justified by two hosts and three env vars today.

Not recommended in any combination: Node SEA, `npx` at boot, Docker on the Mac, Nix, systemd portable
services.

### Where the current approach is already near-optimal

This should be said plainly, because most of `deploy/onair` should not be touched. Read against
Homebrew's, Tailscale's, and pi-hole's installers, it already does the things those get right:

- **Atomic installation via `mktemp` + `install -o root -g wheel -m 0644`** rather than `cp`. This is
  exactly pi-hole's pattern for every file it places.
- **Validating the rendered artifact before installing it** (`plutil -lint`), the structural analogue
  of pi-hole's `sha1sum -c` gate before it overwrites `pihole-FTL`.
- **Health-polling after every mutating verb**, with the `stateFileWritable:false` check so a
  root-owned `~/.onair` cannot report PASS while writes silently fail. None of the three comparables
  does anything this good; it is the best feature in the script.
- **Two-layer `status`** (supervised vs responding) that only fails when both are down.
- **Resolving the real checkout through the `/usr/local/bin/onair` symlink**, and deriving
  `TARGET_USER` from `SUDO_USER` so `sudo` does not leave a root-owned state directory - a bug class
  pi-hole handles with the same care.
- **Refusing to source `cli.env` as root.** Correct, and the config-file change makes the hazard
  disappear rather than merely guarding it.
- **Scoping the optional sudoers grant to exact launchctl subcommands** and validating with
  `visudo -cf` before installing.

The problems are not in the script's craft. They are two design choices: config lives in the plist
(so changing it requires re-rendering and a reload most people will get wrong), and there is no
`update` verb. Fix those two and the existing script is a good tool.

---

## Sources

Node.js
- https://nodejs.org/docs/latest-v26.x/api/cli.html - `--env-file`, `--env-file-if-exists`
- https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/cli.md - v22 history blocks
- https://raw.githubusercontent.com/nodejs/node/v26.x/doc/api/process.md - `process.loadEnvFile`
- https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/process.md
- https://raw.githubusercontent.com/nodejs/node/v26.x/doc/api/util.md - `util.parseEnv`
- https://github.com/nodejs/node/pull/59925 - de-experimentalisation PR
- https://nodejs.org/api/single-executable-applications.html and the v22/v24 equivalents
- https://nodejs.org/api/documentation.html - stability index definitions
- https://github.com/nodejs/node/pull/61813 - SEA ESM entry point
- https://github.com/nodejs/postject

Daemon config prior art
- https://raw.githubusercontent.com/caddyserver/dist/master/init/caddy.service
- https://caddyserver.com/docs/running
- https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscaled/tailscaled.service
- https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscaled/tailscaled.defaults
- https://docs.brew.sh/Formula-Cookbook - `service do ... end` DSL
- https://docs.brew.sh/Manpage - `brew services`, `<formula>.env`, `brew update` vs `brew upgrade`

Installers
- https://tailscale.com/install.sh
- https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh
- https://github.com/pi-hole/pi-hole - `automated install/basic-install.sh`, `advanced/Scripts/update.sh`
- https://docs.pi-hole.net/main/basic-install/ , https://docs.pi-hole.net/main/update/
- https://tailscale.com/kb/1080/cli - `tailscale update --dry-run`

npm
- https://docs.npmjs.com/cli/v11/commands/npm-install , `/npx` , `/npm-cache` , `/npm-prefix`
- https://docs.npmjs.com/cli/v11/using-npm/scripts - `prepare` for git deps
- https://docs.npmjs.com/cli/v11/using-npm/config - `allow-scripts`
- https://docs.npmjs.com/cli/v11/configuring-npm/folders - global prefix
- https://raw.githubusercontent.com/npm/cli/latest/workspaces/libnpmexec/lib/index.js - npx cache logic

systemd / launchd
- https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml - `EnvironmentFile=`, `StateDirectory=`, `DynamicUser=`
- https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml - start rate limiting
- https://github.com/systemd/systemd/blob/main/man/systemd-system.conf.xml - limit defaults
- https://systemd.io/NETWORK_ONLINE/
- https://systemd.io/PORTABLE_SERVICES/ and the `portablectl` man page
- `man launchd.plist` (local, macOS 25.6.0)
- https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- https://developer.apple.com/forums/thread/732767 - Apple silicon unsigned-code rule

Other tooling
- https://bun.com/docs/bundler/executables , https://bun.com/docs/runtime/nodejs-apis
- https://github.com/vercel/pkg - archived
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_handlers.html
- https://docs.ansible.com/ansible/latest/collections/community/general/launchd_module.html
- https://docs.ansible.com/ansible-core/devel/reference_appendices/release_and_maintenance.html
- https://nix-darwin.github.io/nix-darwin/manual/ , https://wiki.nixos.org/wiki/NixOS_on_ARM
- https://nix.dev/manual/nix/latest/development/experimental-features
- https://docs.docker.com/desktop/features/vmm/ , https://docs.orbstack.dev/architecture
- https://www.gnu.org/software/make/manual/ , https://just.systems/man/en/ , https://mise.jdx.dev/

Measurements in this document were taken on the Mac Mini itself (Darwin 25.6.0, arm64, node v26.6.0,
npm 11.18.0, GNU Make 3.81, /usr/bin/python3 3.9.6) on 2026-08-06.
