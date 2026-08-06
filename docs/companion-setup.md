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

- **Target URL**: `ws://<host>:8484/events/ws` (or `?token=<ONAIR_TOKEN>` appended if a
  token is set - the WS upgrade can't carry a header the way the HTTP actions can, so it
  uses the same `?token=` query-param convention as `GET /events`)
- **Reconnect**: on
- **Feedback JSON Path**: `intended`

Use `intended`, not `confirmed`, for now. `confirmed` reflects whether the LightDriver
acknowledged the change, and until the LightDriver is a real integration (tracked in
issue #6 - it's currently a no-op stub), `confirmed` never means anything the button
should trust. `intended` reflects what was actually requested and is meaningful today.
Revisit this once #6 lands a real driver.

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
