# Bitfocus Companion setup

Drive the on-air light from a Companion button and show live status feedback on it, using
only official Bitfocus "generic" connections - no custom Companion module needed. See
`docs/research/2026-08-05-companion-integration.md` for the full option comparison; this
doc is just the config steps for the recommended path (push via `generic-websocket`).

Companion connections to add (search the in-app connection browser): **Generic HTTP**
(actions) and **Generic WebSocket** (status feedback).

## Actions: `generic-http`

Base URL `http://<host>:8484`. Two button actions:

- **On**: Method `POST`, URL `/on?source=companion`
- **Off**: Method `POST`, URL `/off?source=companion`

No body needed. `?source=companion` follows the API's convention for identifying which
client wrote the state (see `docs/api-contract.md`). If `ONAIR_TOKEN` is set on the
service, add a Header field to each action: `{"Authorization": "Bearer <ONAIR_TOKEN>"}`.

**`/on` and `/off` survived v2, and so did `?source=companion`.** They no longer *name* a
state - they resolve through the configured shortcut rows (seeded `on-air` and
`available`), so if you rename or re-point those in the admin UI these buttons follow. An
unset shortcut is a `409` rather than a guess. And an unprefixed `source` on these routes
reads as `human:` (D-41), which a Stream Deck press is, so `?source=companion` becomes
`human:companion` with no change on your side.

To reach a row that is not a shortcut - `recording`, say - use `POST /state/{id}`:

- **Recording**: Method `POST`, URL `/state/recording?source=companion`

## Status feedback: `generic-websocket`

- **Target URL**: `ws://<host>:8484/events/ws?token=<ONAIR_TOKEN>` - the token is
  **required** as of D-23; the bare form now gets a 401. The WS upgrade can't carry a
  header the way the HTTP actions can, so it uses the same `?token=` query-param
  convention as `GET /events`. Read the value with
  `grep '^ONAIR_TOKEN=' ~/.onair/config.env`.
- **Reconnect**: on
- **Feedback JSON Path**: `intended`

Use `intended`, not `confirmed`. `intended` reflects what was actually requested;
`confirmed` reflects what the light itself reported back, which is genuine as of D-21 but
goes to `unknown` whenever the device is unreachable - not what you want a button colour
keyed to.

### ⚠️ `level` is gone. If you built the amber feedback, change it.

Earlier versions of this doc told you to add a second feedback on the `level` JSON path:

```
$(genericwebsocket:level) == "interruptible"     # NO LONGER WORKS
```

**`level` no longer exists.** The three-rung ladder was replaced by an unordered state
table (D-31), and the field on the wire is now `state`, carrying a **row id**. That
expression will silently never match - it will not error, the button will just stop going
amber - so it is worth changing even though nothing looks broken. The replacement:

```
$(genericwebsocket:state) == "interruptible"
```

Wire it to an amber background, ordered *above* the `intended` feedback so it wins.
`interruptible` is a seed row id and is stable; if you rename the row's **label** in the
admin UI the id does not change, which is the whole reason ids exist (D-34).

**The `intended` feedback below keeps working untouched, and always will.** It is derived
from the row's `busy` flag, so a row invented next year that means "the camera is live"
reads as `"on"` without you touching anything. That is the entire point of `intended`
surviving v2 - a client that has never heard of a row still does something correct, and
errs toward red.

## Button feedback

Add feedback **"Variable: Check boolean expression"** to the button, expression:

```
$(genericwebsocket:intended) == "on"
```

(substitute your connection's actual label if you didn't name it `genericwebsocket`).
Wire it to override the Background Color element - e.g. red when true, dark/off color
when false.

## Zero-code fallback

If the WebSocket connection ever proves flaky, skip it: point a Companion "Time
interval" trigger at a `generic-http` `GET /status` action into a custom variable
instead - pure Companion configuration, no code, at the cost of poll-interval-bounded
latency and no built-in staleness detection.
