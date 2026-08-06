# Evolvable Host Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Config-file-first service config, `onair setup` wizard, `deploy/bootstrap`, `onair update` (issue #13, D-14).

**Architecture:** The service reads `~/.onair/config.env` itself at startup; the plist/unit becomes static; the wizard rewrites one file and restarts. Spec: `docs/superpowers/specs/2026-08-06-host-install-evolvable-design.md` - authoritative for every requirement; each task names its spec section.

**Tech Stack:** TypeScript (Node >= 22 ESM, `.js` import extensions), bash (macOS /bin/bash 3.2-compatible), launchd plist, systemd unit.

## Global Constraints

- Zero production npm dependencies; no new devDependencies.
- Before every commit: `npm test` AND `npx tsc --noEmit` both pass.
- Real env vars win over the config file (Node `loadEnvFile` semantics).
- Plist/unit carry no `ONAIR_*` config; only `@NODE@ @APPDIR@ @USER@ @HOME@`.
- CLI never sources/evals config files; grep/cut parse only.
- `config.env` written atomically, target-user-owned, 0600.
- Prompts only on a TTY; every flow works non-interactively without hanging.
- Modern launchctl subcommands only; bash 3.2 compatible (no bash-4-isms).
- NEVER run sudo during implementation or verification.

---

### Task 1: Config loader

**Files:** Create `src/config.ts`, `test/config.test.ts`. Modify `src/index.ts`.
**Spec section:** Deliverable 1.
**Interfaces produced:** `loadConfig(path?: string): void` from `src/config.ts`.
TDD: failing tests first (file loads; real env wins; ENOENT silent; malformed
line ignored; `ONAIR_CONFIG` override; directory-as-path throws), minimal
implementation, `src/index.ts` calls `loadConfig()` before any `ONAIR_*` read.
Commit.

### Task 2: Static plist + safe CLI config read

**Files:** Modify `deploy/com.rocket.onair.plist.template`, `deploy/onair`.
**Spec section:** Deliverable 2. Read the current script fully first.
Remove `@PORT@`/`@STATE_FILE@`/token-append; add `read_config` (env-first,
grep/cut, quote-strip, `$ONAIR_CONFIG` override); cli.env one-time migration;
delete the root-skip sourcing guard. Verify: `bash -n`; render + `plutil
-lint`; rendered plist has no `ONAIR_` string; `read_config` precedence checked
against a temp file both as plain user paths. Commit.

### Task 3: `onair setup` wizard

**Files:** Modify `deploy/onair`.
**Spec section:** Deliverable 3 - implement the flow exactly (questions,
defaults shown, validation, token k/g/e/n, atomic 0600 write, restart+poll when
loaded, install-triggers-setup-when-no-config, `--non-interactive`).
Verify without sudo: `printf` piped answers through the TTY-less path plus
`--non-interactive` round-trips against temp `ONAIR_CONFIG`; file mode 0600;
values preserved on re-run; port validation re-asks (test the validate function
via bash directly if interactive re-ask is impractical to script). Commit.

### Task 4: `deploy/bootstrap` + Pi unit template

**Files:** Create `deploy/bootstrap`, `deploy/onair.service.template`. Delete
`deploy/onair.service`.
**Spec section:** Deliverable 4 - node>=22/git checks, npm ci + build as
`$SUDO_USER` when under sudo, macOS exec into `onair install`, Linux systemd
render/verify/install/enable/health-poll.
Verify: `bash -n`; run `deploy/bootstrap` DRY on macOS up to (not including)
the exec by a `--build-only` flag (add it: stops after build - also useful to
operators); rendered unit from the template contains no `npx` and passes a
grep-based sanity check; `npm test` still green. Commit.

### Task 5: `onair update`

**Files:** Modify `deploy/onair`, `.gitignore` (`.dist-next`, `dist.prev`).
**Spec section:** Deliverable 5 - all 8 steps, `--check-only`/`--dry-run`/
`--yes`, interrupt trap, node-path staleness re-render (Mac), rollback on
failed health.
Verify without sudo and without touching the real service: exercise the git
logic in a scratch clone pair (origin + checkout) in the scratchpad dir - dirty
-tree refusal, up-to-date exit 0, check-only listing, ff-only apply, dist swap
and dist.prev creation; simulate health failure by pointing the health URL at a
dead port (`ONAIR_PORT=1` in env for the poll) to observe rollback of `dist`.
Commit.

### Task 6: Docs

**Files:** Modify `INSTALL.md`, `docs/mac-setup.md`, `docs/pi-setup.md`,
`README.md`.
**Spec section:** Deliverable 6. STE + CONTEXT.md glossary (the repo standard
for these files); document only what the scripts actually do - cross-check
every command against the final `deploy/onair`, `deploy/bootstrap`, unit
template. Commit.
