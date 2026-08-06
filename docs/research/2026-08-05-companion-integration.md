# Integrating Bitfocus Companion with the on-air API

2026-08-05

## Summary

- Current stable is **Companion v5.0.3** (GitHub API, published 2026-08-05). Docs live at
  `companion.free/user-guide/v5.0/` and, for the in-development edge, `.../beta/`; source-of-truth
  markdown is `docs/user-guide/` in the `bitfocus/companion` repo.
- Both actions and status feedback are achievable with **zero custom module code**, using two
  official Bitfocus-maintained "generic" connections: `generic-http` for `POST /on` / `POST /off`,
  and either `generic-http` (polling) or `generic-websocket` (push) for status feedback into a
  button via Companion's v5.0 expression/feedback system.
- Best latency/effort tradeoff: add a small WebSocket broadcast to our existing status-broadcast
  code (it already drives the SSE hub) and point Companion's official `generic-websocket` module at
  it. Near-instant feedback, no bridge process, no custom Companion module ever written.

## Options compared

| Path | On/Off actions | Status feedback mechanism | Latency | Effort (our side) | Maintenance |
|---|---|---|---|---|---|
| **A. Push via WebSocket** (recommended) | `generic-http` POST actions | `generic-websocket` connects to a new WS endpoint on our service; module feedback writes incoming JSON into a module variable; button expression/feedback reads it | Near-instant (network RTT, no poll) | Add a `ws` broadcast alongside existing SSE hub (~30-60 LOC) | Low - reuses existing state-broadcast code path |
| **B. Poll via generic-http + Companion trigger** | `generic-http` POST actions | Companion "Time interval" trigger fires a `generic-http` GET `/status` action into a custom variable; feedback reads it | Bounded by poll interval (commonly 1-5s; no documented floor) | **None** - pure Companion configuration | Low, but stale-on-disconnect risk (see below) |
| **C. Push via Companion's own HTTP API** | `generic-http` POST actions | Small bridge process subscribes to our `GET /events` SSE and `POST`s each change to Companion's `POST /api/custom-variable/<name>/value` | Near-instant | Small standalone bridge script/process (~30 LOC) that must know Companion's host:port | Low, but is a second long-running process to keep alive |
| **D. Custom companion-module** (fallback) | Custom action handlers | Custom feedback + variables, driven by the module's own SSE/HTTP client code | Near-instant | TypeScript module using `@companion-module/base`; more boilerplate, packaging, versioning | Higher - a codebase to keep working across Companion SDK updates |

Options A-C all use only official/generic Companion capabilities. D is the fallback if A-C prove
insufficient in practice.

## Per-option notes

### A. Push via `generic-websocket` (recommended)

- The module connects out to any `ws://` or `wss://` URL, has a feedback **"Update variable with
  value from WebSocket message"** that copies an incoming message (or a JSON-path within it) into a
  module variable, and reconnects automatically on failure.
  - Claim: exact config fields (Target URL, Reconnect, Feedback Prefix/Suffix, Ping Interval, JSON
    Path support with simple paths only e.g. `root/1/name`) and the built-in `lastDataReceived`
    variable (a timestamp updated on every incoming message, useful for staleness detection).
  - Source: https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/companion/HELP.md
  - Accessed: 2026-08-05.
  - Claim: current module version `2.3.1`, depends on `@companion-module/base ~1.12.0`.
  - Source: https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/package.json
  - Accessed: 2026-08-05.
  - Claim: module is listed as an official Bitfocus connection in the module directory.
  - Source: https://bitfocus.io/connections/generic-websocket
  - Accessed: 2026-08-05.
- Companion v5.0's feedback/expression system redraws a button "whenever any variable it uses
  changes" - no polling on Companion's side once the WS message arrives.
  - Claim: element properties can be expressions referencing `$(connectionlabel:variable)` /
    `$(custom:variable)`, and recompute automatically on variable change; the built-in feedback
    is now literally called **"Variable: Check boolean expression"**, supporting ternaries like
    `$(custom:onair) == "on" ? "#CC0000" : "#222222"`.
  - Source: https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/3_config/buttons/creating/feedbacks.md
    and https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/4_expressions/index.md
  - Accessed: 2026-08-05.
- `generic-websocket`'s config has no auth-header field (only User-Agent spoofing and a hex
  keep-alive ping) - a token would have to travel as a URL query param, matching our existing
  `?token=` convention for `EventSource`-style clients.
  - Claim: no header/auth config field documented in HELP.md.
  - Source: same HELP.md as above.
  - Accessed: 2026-08-05.
- Disconnect behavior: the module reconnects automatically; `lastDataReceived` lets a trigger/
  feedback detect staleness (mirrors our own `/display` watchdog pattern) if we want a "stale"
  indicator on the button later. Companion does not natively gray out a feedback on WS disconnect;
  that would need an explicit expression combining the state variable with `lastDataReceived` age.

### B. Poll via `generic-http` + Companion trigger

- `generic-http` (official Bitfocus module) sends GET/POST/PUT/PATCH/DELETE with headers, body,
  and Content-Type, and can store a JSON response body (parsed, not just stringified) or the HTTP
  status code into a custom variable.
  - Claim: exact action/feedback matrix, config fields (Base URL, Proxy, TLS validation,
    lenient/strict parser), and that **only** the "Image from URL" feedback polls on an interval -
    plain GET/POST/etc. actions run once per invocation, not on a timer.
  - Source: https://raw.githubusercontent.com/bitfocus/companion-module-generic-http/master/companion/HELP.md
  - Accessed: 2026-08-05.
  - Claim: current module version `3.1.0` (`package.json`), depends on `@companion-module/base ~2.0.4`.
  - Source: https://raw.githubusercontent.com/bitfocus/companion-module-generic-http/master/package.json
  - Accessed: 2026-08-05.
- Periodic polling therefore has to come from Companion's own **Triggers** feature ("Time interval"
  event type) calling the `generic-http` GET action repeatedly.
  - Claim: Trigger event types include "Time interval", "At random time interval", "On variable
    change"; trigger actions can be any button action, including a connection's HTTP action.
  - Source: https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/3_config/triggers.md
  - Accessed: 2026-08-05.
  - **Uncertain**: the docs describe the trigger types but don't state a minimum interval or its
    unit (ms vs. s). A related GitHub issue (`bitfocus/companion#3153`, "Request: Documentation of
    trigger events", open as of access) confirms this area is under-documented upstream. Verify
    the floor empirically in the Companion UI before committing to a specific interval.
- Reliability caveat: if our API is unreachable, the GET action just fails; the custom variable
  keeps its last value with nothing forcing it stale, and there's no built-in equivalent of our own
  `/display` "disconnected" watchdog for this path. `generic-http` does put the *connection* into
  an error state on a failed request, which is visible on the Connections page, but that's a
  separate signal from the button's feedback color.
  - Claim: "A request that returns a non-success status code (or fails outright) sets the
    connection status to an error state."
  - Source: HELP.md above.
  - Accessed: 2026-08-05.

### C. Push via Companion's own HTTP remote-control API

- Companion exposes a documented HTTP API on the **same host:port as its admin UI** (default port
  `8000`) for both reading and writing custom variables and driving button style directly - an
  external service (like ours) can push without Companion polling anything.
  - Claim: `POST /api/custom-variable/<name>/value` (query `?value=` or body, `text/plain` or
    `application/json`, supports object/array/boolean/number/null values, not just strings);
    `GET /api/custom-variable/<name>/value`; also direct button style pushes:
    `POST /api/location/<page>/<row>/<column>/style` with `bgcolor`/`color`/`text` in query or JSON
    body - meaning we could bypass custom variables entirely and set the button's background color
    straight from our service on every state change.
  - Source: https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/5_remote-control/http-remote-control.md
  - Accessed: 2026-08-05.
  - Claim: default admin port is `8000`, binds all interfaces by default.
  - Source: https://companion.free/user-guide/beta/getting-started/server-configuration/ (via fetch)
  - Accessed: 2026-08-05.
  - Claim: no auth token/header is documented for this API; Companion's security model for it is
    LAN trust plus an optional "Remote Access" protocol toggle for TCP/UDP - the HTTP API itself
    isn't listed under a separate enable/disable toggle in Settings > Protocols, i.e. it's on
    whenever the admin server is reachable.
  - Source: https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/security.md
    and https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/3_config/settings.md
  - Accessed: 2026-08-05.
- This requires a small standalone bridge (subscribe to our `GET /events`, POST to Companion on
  each change) that must be told Companion's IP - a second thing to keep running, versus Option A
  where Companion initiates the connection to us and our config never needs to know about Companion.
  Functionally equivalent latency to Option A; listed mainly because it needs no change to our own
  HTTP surface at all (just a script), if adding a WS endpoint to the service is undesirable.

### D. Custom `companion-module` (fallback)

- SDK is `@companion-module/base` (current stable **v2.1.2**, published 2026-07-13), TypeScript or
  JavaScript, scaffolded from `companion-module-template-ts` / `-js`. A module extends the base
  class and implements `init`, `configUpdated`, action/feedback/variable definitions, and
  `destroy`.
  - Source: https://api.github.com/repos/bitfocus/companion-module-base/releases (GitHub API) and
    https://companion.free/for-developers/module-development/module-development-101/
  - Accessed: 2026-08-05.
- Local development/sideloading does **not** require publishing: set a "Developer modules path" in
  Companion settings (e.g. `/opt/companion-module-dev/`) and Companion loads any module found in a
  subfolder there, overriding the bundled version if the module ID matches; alternatively upload a
  built `.tgz` as a private/custom module.
  - Source: https://github.com/bitfocus/companion/wiki/How-to-use-a-module-that-is-not-included-in-Companion-build
  - Accessed: 2026-08-05.
- Since our service already speaks SSE, a custom module's `init()` could open a persistent SSE
  connection directly (Node's `fetch`/`EventSource` polyfill or `undici`) and update variables/
  feedbacks per message - marginally lower latency than option A/C only in that it skips the extra
  hop through a "generic" module's variable-copy feedback, but at the cost of writing and
  versioning real module code. Given options A and B already meet the requirement, this is not
  worth building unless A/B prove unreliable in practice.

### Question 5 - WebSocket/SSE built into Companion core

- Companion core does not consume SSE itself; there is no core "listen to an SSE URL" feature.
  WebSocket/SSE support in the ecosystem comes from **modules**: the official `generic-websocket`
  module (a WS *client* Companion connects out with) is the closest built-in fit for our use case.
  Some third-party modules use SSE internally (found evidence of at least one doing so), but that's
  module-specific code, not a Companion core capability - confirms **no** generic "point Companion
  at an SSE URL" feature exists out of the box, which is why Option A uses WebSocket (has an
  official generic module) rather than SSE (does not).
  - Source: HELP.md/README review of `generic-websocket` and `generic-http` above; absence of any
    SSE-related entry in `docs/user-guide/5_remote-control/` (`artnet-dmx-control.md`,
    `emberplus-control.md`, `http-remote-control.md`, `osc-control.md`, `rosstalk-control.md`,
    `satellite.md`, `tcp-udp.md` - no SSE file).
  - Source: https://api.github.com/repos/bitfocus/companion/contents/docs/user-guide/5_remote-control
  - Accessed: 2026-08-05.

## Recommendation

**Primary: Option A (push via `generic-websocket`)** for status feedback, plus `generic-http` for
the on/off actions. Concretely:

1. **On our side**, add a `ws` (or equivalent) broadcast to the service's existing status-change
   code path - the same code that already emits SSE `status` events on connect/change/15s
   heartbeat should also push the same JSON payload to any connected WebSocket clients, and send
   the current status immediately on WS connect (mirroring the SSE "status event on connect"
   behavior). Accept `?token=` on the WS upgrade request when `ONAIR_TOKEN` is set, consistent with
   the existing `EventSource` carve-out in `docs/api-contract.md`. This is on the order of 30-60
   lines given the SSE hub already exists.
2. **In Companion**, add a `generic-websocket` connection pointed at `ws://<mac-host>:8484/<new-ws-path>`,
   add its "Update variable with value from WebSocket message" feedback (JSON path `confirmed` or
   `intended` depending on which the button should reflect) to write into a module variable.
3. Add a second `generic-http` connection (Base URL `http://<mac-host>:8484`) for actions: one
   button action `POST /on?source=companion`, another `POST /off?source=companion`. If
   `ONAIR_TOKEN` is set, add header `{"Authorization": "Bearer <token>"}` in the action's Header
   field.
4. On the on-air button, use the v5.0 feedback **"Variable: Check boolean expression"** (or a
   direct expression on the Background element's Color) with something like
   `$(genericwebsocket:confirmed) == "on"` to drive red/dark, and optionally a second
   feedback/expression against `$(genericwebsocket:lastDataReceived)` age to show a "stale" state if
   the WS drops for a while.

**No new custom module should be written.** If, after trying this, WS proves flaky in practice (or
the WS endpoint feels like scope creep), fall back to **Option B** (pure Companion trigger + poll,
zero code on our side, at the cost of a poll-interval-bounded latency and no stale detection) before
reaching for Option D.

## Dev details for the ticket

- Companion connections to add: `generic-http` (actions) and `generic-websocket` (status), both
  official Bitfocus modules, addable from Companion's in-app connection browser (search "Generic
  HTTP" / "Generic WebSocket").
- New endpoint needed on our service: a WebSocket upgrade route (suggest `GET /events/ws` to sit
  next to the existing `GET /events` SSE route) that:
  - Sends the current status object immediately on connect (same shape as `GET /status`).
  - Broadcasts on every write (state or message change) and on the existing 15s heartbeat, reusing
    the SSE hub's broadcast call site.
  - Honors `?token=` the same way `GET /events` already does.
  - This is the only change to `docs/api-contract.md` needed; document it alongside the existing
    `GET /events` section once implemented.
- `generic-http` action config for on/off: Method POST, URL `http://<host>:8484/on` (and `/off`),
  no body, optional Header `{"Authorization": "Bearer <ONAIR_TOKEN>"}` if a token is configured.
  `?source=companion` appended to the URL per the API contract's convention for identifying writers.
- `generic-websocket` config: Target URL `ws://<host>:8484/events/ws` (or `wss://` if TLS is ever
  added), Reconnect on, Feedback JSON Path `confirmed` (or `intended`, per which field the button
  should track - `confirmed` matches what the light actually did; `intended` matches what was
  last requested even if the light hasn't confirmed).
- Button feedback: "Variable: Check boolean expression", expression
  `$(genericwebsocket:confirmed) == "on"` (module label may differ per connection naming), style
  override on Background Color element.

## Uncertain

- Exact minimum/floor for Companion's "Time interval" trigger event (Option B) - not documented in
  the primary-source `triggers.md`; a related GitHub issue confirms the gap. Verify in-app if
  Option B is ever pursued.
- Whether `generic-http` and `generic-websocket` ship pre-bundled with every Companion install or
  require a one-time add from the in-app module browser (both are official `bitfocus`-org modules
  listed on `bitfocus.io/connections/`, but bundling-vs-on-demand-download wasn't confirmed from a
  primary source in this pass).
- Historical GitHub issues (e.g. `bitfocus/companion#3188`, `#3224`) reported the older "Check
  Value" feedback not firing reliably in Companion 3.4.x/4.x. Companion 5.0 rebuilt the
  feedback/expression system (confirmed from `feedbacks.md`), so these specific reports likely
  predate the fix, but this wasn't independently re-verified against 5.0.3 by testing.
- `generic-websocket`'s JSON Path option only supports "simple paths" (e.g. `root/1/name`), per its
  own HELP.md - our flat `{"intended":...,"confirmed":...}` status object should path-select fine
  (e.g. `confirmed`), but wasn't tested end-to-end against a running Companion instance.

## Sources

- https://api.github.com/repos/bitfocus/companion/releases (GitHub API, accessed 2026-08-05) - version ground truth
- https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/5_remote-control/http-remote-control.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/3_config/triggers.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/3_config/buttons/creating/feedbacks.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/4_expressions/index.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/security.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion/main/docs/user-guide/3_config/settings.md (accessed 2026-08-05)
- https://companion.free/user-guide/beta/getting-started/server-configuration/ (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion-module-generic-http/master/companion/HELP.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion-module-generic-http/master/companion/manifest.json (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion-module-generic-http/master/package.json (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/companion/HELP.md (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/companion/manifest.json (accessed 2026-08-05)
- https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/package.json (accessed 2026-08-05)
- https://api.github.com/repos/bitfocus/companion-module-base/releases (GitHub API, accessed 2026-08-05)
- https://github.com/bitfocus/companion/wiki/How-to-use-a-module-that-is-not-included-in-Companion-build (accessed 2026-08-05)
- https://companion.free/for-developers/module-development/module-development-101/ (accessed 2026-08-05)
- https://bitfocus.io/connections/generic-http and https://bitfocus.io/connections/generic-websocket (accessed 2026-08-05)
- https://github.com/bitfocus/companion/issues/3153, #3188, #3224, #27 (companion-module-generic-http) - context for open documentation/reliability gaps (accessed 2026-08-05)
