# Mac Service Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Run the on-air API as a launchd-supervised task on the Mac Mini with an `onair` CLI, authed admin HTTP routes, and an Admin card on `/ui` (issue #12, D-13).

**Architecture:** System-domain LaunchDaemon supervises `node dist/index.js`; restart-over-HTTP = clean exit + supervisor respawn. Spec: `docs/superpowers/specs/2026-08-06-mac-service-design.md` (authoritative for all requirements; read it first).

**Tech Stack:** TypeScript (Node >= 22, ESM, `.js` import extensions), bash, launchd plist.

## Global Constraints

- Zero production npm dependencies. No new devDependencies either.
- Before every commit: `npm test` (66 passing now; must stay green + new tests) AND `npx tsc --noEmit` must both pass. tsx strips types, so tests alone never prove compilation.
- Error shape everywhere: `{"error":"<message>"}`.
- Auth model (existing, do not change): `ONAIR_TOKEN` optional; when set, all endpoints need `Authorization: Bearer`; read-only GETs also accept `?token=`. Timing-safe comparison via the existing helper in `src/server.ts`.
- Modern launchctl subcommands only (`bootstrap`/`bootout`/`kickstart`/`print`/`enable`/`disable`); never `load`/`unload`.
- Follow existing code style in `src/` and `test/` (node:test, node:assert, existing test helpers for spinning up the server).

---

### Task 1: Admin routes - `GET /admin/health`, `POST /admin/restart`

**Files:** Modify `src/server.ts`, `src/app.ts`, `src/index.ts` (only if needed for wiring), `test/server.test.ts`. Read spec section "Admin routes".

**Interfaces produced:**
- `createApiServer` deps gain: `stateFile?: string` (for writability check) and `exitFn?: () => void` (default `() => process.exit(0)`; tests inject a spy). `createApp` passes its `stateFile` through and leaves `exitFn` defaulted.
- `GET /admin/health` → 200 `{"uptime": <seconds, number>, "pid": <number>, "nodeVersion": process.version, "port": <number>, "stateFileWritable": <boolean>}`. Port = the server's bound port (`server.address()`), falling back to the configured port before listen. `stateFileWritable`: true iff the state file (or, when it does not exist yet, its parent dir) is writable (`fs.accessSync` + `W_OK`, try/catch). Read-only GET: token-gated like `/status`, `?token=` accepted.
- `POST /admin/restart` → when no token is configured: **403** `{"error":"restart requires ONAIR_TOKEN to be configured"}` (remote process-kill must never be open); wrong/missing token: 401 (existing path); else **202** `{"restarting":true}`, then call `exitFn` only after the response has flushed (listen for `res.on('finish'|'close')`, plus a 250ms `setTimeout(...).unref()` fallback) so the 202 always reaches the client. In production `exitFn` triggers the existing graceful close via `process.exit(0)` after `server.close()` best-effort - keep it simple: the supervisor owns recovery.
- Add both paths to the ROUTES table (405 for wrong methods, as existing).

**Steps:** failing tests first (health shape incl. stateFileWritable true and false cases; health token gating incl. `?token=`; restart 403 without configured token; 401 wrong token; 202 with token and exitFn spy called exactly once after response received; 405 on `GET /admin/restart`), then implement, then `npm test` + `npx tsc --noEmit`, update `docs/api-contract.md` (two endpoint sections + 403 row in the error table), commit.

### Task 2: `/ui` Admin card

**Files:** Modify `src/ui.ts`, `test/server.test.ts` (marker tests). Read spec section "/ui Admin card" and the existing card structure in `src/ui.ts`.

**Requirements:** New "Admin" card between Message and Live events. Element ids: `admin-health` (fields: pid, uptime humanized, node version, state file writable), `admin-refresh` (manual refresh), `btn-restart`, `admin-err`. Behavior: poll `GET /admin/health` every 10s (`?token=` when token set) + on SSE reconnect; Restart button disabled until first successful health load; on click: fire-and-forget `POST /admin/restart` (bearer header; never await/parse the body beyond status), switch button to "restarting…", then poll health every 1s until it answers, then re-enable and refresh; a 403 renders a hint in `admin-err`: "set ONAIR_TOKEN to enable remote restart"; other errors render status/text in `admin-err` (never swallowed, same pattern as existing error strips). Match existing dark-theme styles, no new colors beyond the established palette.

**Steps:** marker tests (page contains `btn-restart`, `admin-health`, `/admin/health`), implement, `npm test` + `npx tsc --noEmit`, commit.

### Task 3: `deploy/com.rocket.onair.plist.template` + `deploy/onair` CLI

**Files:** Create `deploy/com.rocket.onair.plist.template`, `deploy/onair` (executable bash). Read spec sections "Deliverables 1-2" - they are the requirements, follow every verb and flag exactly.

**Verification (no unit framework for bash):** `bash -n deploy/onair`; render the template with sed exactly as `install` does (to a scratch dir) and `plutil -lint` the result; run `deploy/onair status` against a locally running server started with a temp state file (`node --import tsx src/index.ts` or `node dist/index.js` after build) to prove the non-sudo path works (supervised: no / responding: yes). Do NOT run any sudo command. Script conventions: `set -euo pipefail`, `usage()` on unknown verb, every mutating verb ends with a health poll (5s, PASS/FAIL print). Commit.

### Task 4: Docs

**Files:** Create `docs/mac-setup.md`; modify `README.md`. Read spec section "Docs". Content per spec: install flow, verb table, sudoers option, reload rule, pinned-node + nvm caveat, pmset note, newsyslog rotation, restart-by-exit symmetry with Pi systemd. Keep README to one short section linking to `docs/mac-setup.md`. Commit.
