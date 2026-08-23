# On-air API contract (v1)

The REST API on the receiver (Mac Mini now, Raspberry Pi later - D-4). System's source
of truth for on-air state. Callable by the detector, curl, phone shortcuts, or any
other LAN client. Issue #2 is the originating ticket; decisions D-5..D-7 in CONTEXT.md.

## State model

One state object, persisted to disk atomically, restored on restart:

| Field | Type | Meaning |
|---|---|---|
| `level` | `"available" \| "interruptible" \| "dnd"` | The rung. This is the stored field. Survives restart; on boot the service re-applies it to the light, subject to the ladder rule. |
| `intended` | `"on" \| "off"` | **Derived, read-only, retained for compatibility.** Computed at serialisation as `level === "available" ? "off" : "on"`, so it can never drift. Kept on the wire and on disk for Companion and for a D-14 rollback. Writing it has no effect. |
| `confirmed` | `Level \| "unknown"` | What the light acknowledged, read back from the device itself. `unknown` when the light is unreachable or the panel is not repainting - never guessed. |
| `hold` | `"interruptible" \| "dnd" \| null` | A floor on `level`, set by a human. See "The hold" below. |
| `source` | string | Who wrote the state. `"detector"` is **load-bearing**: it is the one value the hold clamps. Everything else, including an absent `source`, is treated as manual. |
| `updatedAt` | ISO 8601 string | Time of last level write. Refreshed by every `/state`, `/on`, `/off`, `/available`, `/interruptible`, `/dnd` write, including idempotent repeats. |
| `message` | `string \| null` | Optional display message (see `PUT /message`). Independent of level writes - heartbeats never touch it. Absent in pre-message state files, which load as `null`. |

### The ladder

`available(0) < interruptible(1) < dnd(2)`.

> **THE LADDER RULE - the server never lowers `level`, and never asserts a lower rung to
> the device, without fresh evidence (`ageSeconds <= 90`). Raising or matching is always
> allowed. Absence of information never renders below `dnd`.**

Staleness is visible, never acted on: the detector re-sends its state every ~60s as a
heartbeat (client-side convention, not enforced), so a stale `updatedAt` means a dead
detector. The server never auto-changes state on a timer (no TTL) - only an explicit
write lowers the level (invariant: false OFF is worse than false ON). What a stale store
*does* change is whether the server keeps asserting: rather than heartbeat a stale
`available` forever, it withholds the assertion and lets the device's own watchdog trip
into NO DATA. That is withdrawal of a liveness claim, not a state change.

### The hold

A **hold** is a floor on `level`, set by a human, that the detector cannot cross downward.

- A write with `source: "detector"` is clamped up: `effective = max(level, hold)`. A
  detector write can never set or clear the floor.
- Any other source applies its `level` as given and may set (`hold: true`) or clear
  (`hold: false`) the floor. Omitting `hold` leaves it untouched.
- **The floor never blocks escalation.** A detector writing `dnd` against an
  `interruptible` floor gives `dnd`, and the floor survives the escalation - when the
  call ends the level falls back to `interruptible`, not to `available`.
- A manual write to a rung *below* the floor releases the floor. An explicit human
  instruction always wins, and leaving a floor that contradicts the level would let the
  next detector write silently undo it.
- **`hold` may never be `available`** - a floor at the bottom rung is either a no-op or a
  lever for forcing green against the detector. `400`.
- Release is explicit only. Never a TTL, never a decay: the hold is *intent*, like
  `level`, not *evidence*, like `confirmed`.

The hold is why `source` now carries real precedence. In v1 it did not (last write wins),
and with a boolean that was harmless; with three rungs a 60s detector heartbeat would
silently destroy a manual `interruptible` within a minute.

## Endpoints

No URL versioning. All responses are JSON.

### `GET /status`

Returns the state object plus computed staleness:

```json
{
  "level": "dnd",
  "intended": "on",
  "confirmed": "dnd",
  "hold": null,
  "source": "detector",
  "updatedAt": "2026-08-05T21:04:00Z",
  "message": null,
  "ageSeconds": 12
}
```

### `PUT /state`

Canonical write. Idempotent - repeating the same body just refreshes `updatedAt`.

Preferred request: `{"level": "interruptible", "source": "webui"}`.

| Field | Required | Notes |
|---|---|---|
| `level` | one of `level`/`onAir` | One of `available`, `interruptible`, `dnd`. |
| `onAir` | one of `level`/`onAir` | Legacy boolean. `true` maps to **`dnd`**, not `interruptible`: a client that can only say yes/no is telling you it does not know how bad it is, and the ladder says round up. |
| `source` | no | Default `"manual"`. |
| `hold` | no | `true` pins the floor at this request's level; `false` clears it. |

Errors:

- both `level` and `onAir` present and contradictory -> `400 {"error":"level and onAir disagree"}`.
  Never a silent pick.
- neither -> `400 {"error":"body must contain level or onAir"}`.
- `{"level":"available","hold":true}` -> `400`. A floor at the bottom rung is not a hold.

Response: `200` with the same body as `GET /status`, after the write and a LightDriver
attempt. Note the returned `level` may be *higher* than the one requested, if a hold
clamped it.

### `POST /available` / `POST /interruptible` / `POST /dnd`

No-body conveniences for curl and phone shortcuts. Each sets its own rung with `source`
`"manual"`; override with `?source=<name>`. Add `?hold=1` to pin the floor there, or
`?hold=0` to release it. Response identical to `PUT /state`.

### `POST /on` / `POST /off`

Retained unchanged for existing shortcuts. `/on` is `dnd`, `/off` is `available`.

### `PUT /message` / `DELETE /message`

Set or clear the display message shown by `/display`. `PUT` body: `{"text": "BE
QUIET"}` - `text` must be a non-empty string, max 200 chars (400 otherwise). `DELETE`
is idempotent. Both respond 200 with the same body as `GET /status`. Message persists
across restarts; on-air writes and detector heartbeats never modify it.

### `GET /events`

Server-sent events (`text/event-stream`): a `status` event with the full status JSON
on connect, another on every successful write (state or message), and a keep-alive
`status` event every 15s per connection - a real event, so clients can detect a dead
stream, with `ageSeconds` computed at send time.

### `GET /events/ws`

WebSocket status stream, server-push-only - a hand-rolled minimal implementation (zero
dependencies), not a general-purpose WebSocket server. Same payload, heartbeat, and
auth semantics as `GET /events`: the full status JSON as a text frame on connect,
another on every successful write, and a heartbeat text frame every 15s per
connection. Honors `?token=` the same way `GET /events` does (see Auth below).

Inbound messages from the client are ignored - the server never needs to receive
application data over this connection. The two client control frames it does honor:
a `ping` gets a `pong` echoing the payload, and a `close` gets a `close` reply before
the socket is torn down. Any other inbound frame is silently ignored (but still
parsed, so it doesn't desync the frame stream).

Intended for Bitfocus Companion's `generic-websocket` module - see
`docs/companion-setup.md`.

### `GET /display`

A self-contained HTML tally page (inline CSS/JS) for fullscreen/kiosk use. Renders ON
AIR (red) / OFF AIR (dark) live via `/events`; a set message replaces the wordmark
text but never the state color; shows a DISCONNECTED overlay when the stream drops
and a stale badge when detector-sourced state exceeds 5 minutes of age. A client-side
watchdog also shows the overlay after ~45s of silence even without a socket error
(e.g. a dead TCP connection with no RST), and reconnects automatically.

### `GET /ui`

A self-contained dark control-panel page (inline CSS/JS): live state pill + connection
status driven by `/events`, ON/OFF buttons, message set/clear, a capped live event
feed, and an API console with one row per endpoint (editable JSON body where
applicable, response pane, copy-as-curl). Holds no server state - the page is a
function of the last `/events` payload plus per-row response data. Same token
handling as `/display` (`?token=` on the GET); the page itself sends the bearer
header on writes when a token is entered into the page.

### `GET /admin/health`

Liveness/health check for the launchd/systemd supervisor and the `/ui` Admin card.
Read-only: token-gated like other GETs (`?token=` accepted).

```json
{
  "uptime": 123.4,
  "pid": 4821,
  "nodeVersion": "v22.9.0",
  "port": 8484,
  "stateFileWritable": true
}
```

`uptime` is process uptime in seconds. `port` is the server's actual bound port.
`stateFileWritable` is true iff the state file (or, when it doesn't exist yet, its
parent directory) is writable.

### `POST /admin/restart`

Triggers a graceful process exit so the supervisor (launchd `KeepAlive`, systemd
`Restart=always`) respawns the service. The one endpoint that refuses to exist
without auth, since it's a remote process-kill: **403** `{"error": "restart
requires ONAIR_TOKEN to be configured"}` when `ONAIR_TOKEN` isn't set, regardless
of any token supplied. When a token is configured, normal auth applies (401 on
wrong/missing token). On success: `202 {"restarting": true}`, and the process
exits only after the response has been flushed to the client.

## Light failures are not write failures

A write always succeeds if the body is valid: `intended` is updated and persisted even
when the light is unreachable. The failure surfaces as `confirmed: "unknown"` in the
response and in `GET /status`. Clients that care check `confirmed`.

## Auth

Off by default. If the `ONAIR_TOKEN` env var is set, every endpoint requires
`Authorization: Bearer <token>`; wrong or missing token gets `401`. Because
`EventSource` cannot set headers, the read-only GETs (`/status`, `/events`,
`/display`, `/ui`) also accept `?token=<token>`; writes accept the header only. An empty
`ONAIR_TOKEN` is a startup error, never bypassable auth.

## Errors

Shape: `{"error": "<human-readable message>"}`.

| Status | When |
|---|---|
| `400` | Malformed JSON, missing/non-boolean `onAir` |
| `401` | Token configured and absent/wrong |
| `403` | `POST /admin/restart` called with no `ONAIR_TOKEN` configured |
| `404` | Unknown path |
| `405` | Known path, wrong method |

## Network

- Default port `8484`, override with `ONAIR_PORT`.
- Binds all interfaces; LAN reachability is the point. LAN-only exposure plus the
  optional token is the v1 security model.
