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

**Since D-18 the state has three rungs** (`available`, `interruptible`, `dnd`), but
**this config keeps working untouched**: `intended` is now derived, and both
`interruptible` and `dnd` read as `"on"`, so the button goes red for either. That is the
cheap direction of error - a yellow call showing red says "maybe don't" rather than
"come in".

To distinguish the middle rung, add a second feedback on the `level` JSON path:

```
$(genericwebsocket:level) == "interruptible"
```

and wire it to an amber background, ordered *above* the `intended` feedback so it wins.

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
