# On-air API contract (v1)

The REST API on the receiver (Mac Mini now, Raspberry Pi later - D-4). System's source
of truth for on-air state. Callable by the detector, curl, phone shortcuts, or any
other LAN client. Issue #2 is the originating ticket; decisions D-5..D-7 in CONTEXT.md.

## State model

One state object, persisted to disk atomically, restored on restart:

| Field | Type | Meaning |
|---|---|---|
| `intended` | `"on" \| "off"` | What the API was last told. Survives restart; on boot the service re-applies it to the light. |
| `confirmed` | `"on" \| "off" \| "unknown"` | What the light acknowledged via the LightDriver. `unknown` when the driver has no feedback or the light is unreachable - never guessed. |
| `source` | string | Who wrote the state. Conventions: `"detector"`, `"manual"`. Free-form; no precedence semantics in v1 (last write wins). |
| `updatedAt` | ISO 8601 string | Time of last on-air write. Refreshed by every `/state`, `/on`, `/off` write, including idempotent repeats. |
| `message` | `string \| null` | Optional display message (see `PUT /message`). Independent of on-air writes - heartbeats never touch it. Absent in pre-message state files, which load as `null`. |

Staleness is visible, never acted on: the detector re-sends its state every ~60s as a
heartbeat (client-side convention, not enforced), so a stale `updatedAt` means a dead
detector. The server never auto-changes state (no TTL) - only an explicit write turns
the light off (invariant: false OFF is worse than false ON).

## Endpoints

No URL versioning. All responses are JSON.

### `GET /status`

Returns the state object plus computed staleness:

```json
{
  "intended": "on",
  "confirmed": "unknown",
  "source": "detector",
  "updatedAt": "2026-08-05T21:04:00Z",
  "ageSeconds": 12
}
```

### `PUT /state`

Canonical write. Idempotent - repeating the same body just refreshes `updatedAt`.

Request: `{"onAir": true, "source": "detector"}` - `onAir` required boolean, `source`
optional string (default `"manual"`).

Response: `200` with the same body as `GET /status`, after the write and a LightDriver
attempt.

### `POST /on` / `POST /off`

No-body conveniences for curl and phone shortcuts. Equivalent to `PUT /state` with
`onAir` true/false and `source` `"manual"`; override with `?source=<name>`.
Response identical to `PUT /state`.

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
