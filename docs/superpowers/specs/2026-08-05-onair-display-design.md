# On-air Display Page + Message API Design

Interim tally light: a browser page served by the on-air API, shown fullscreen on a
small screen by a Raspberry Pi in kiosk mode, until real light hardware lands (#1/#6).
Approved by Rocket 2026-08-05.

## Goal

`http://<host>:8484/display` renders the current on-air state live (sub-second via
SSE), plus optional custom messages, with honest failure overlays.

## Contract additions (docs/api-contract.md is updated to match)

### Message resource

A display message is separate from on-air state: different writers, different
lifetime, and the detector's heartbeat re-PUTs of `/state` must never clobber it.

- `PUT /message` body `{"text": "BE QUIET"}` → 200 with status body. `text` must be a
  non-empty string, max 200 chars; otherwise 400.
- `DELETE /message` → 200 with status body. Idempotent (deleting no message is fine).
- `GET /status` (and every SSE event) gains `message: string | null`.
- Message persists in the same state file. Backward compatibility: state files written
  before this feature lack the field - the shape guard treats absent `message` as
  `null` (no migration needed).
- Auth: writes require the Bearer header, same as `/state`.

### SSE endpoint

- `GET /events` responds `200 text/event-stream` and never completes.
- On connect: one `status` event carrying the same JSON as `GET /status`.
- On every successful write (`/state`, `/on`, `/off`, `/message` set or clear): one
  `status` event to every open connection, `ageSeconds` computed at send time.
- Keep-alive comment line (`:hb`) every 15s per connection.
- Connection cleanup on client disconnect; server shutdown closes all streams.

### Display page

- `GET /display` → 200 `text/html`, a single self-contained page (inline CSS/JS, no
  external resources, no build step - the HTML lives as a template string in
  `src/display.ts` so it ships inside `dist/`).

### Auth for GETs

`EventSource` cannot set request headers. When `ONAIR_TOKEN` is set, the read-only
GET endpoints (`/status`, `/events`, `/display`) accept `?token=<token>` as an
alternative to the Bearer header. Writes accept the header only.

## Display behavior

- Full viewport, no chrome. ON: red background (#c00-family), "ON AIR" wordmark.
  OFF: near-black background, dim "OFF AIR".
- **Safety invariant: background color always reflects on-air state.** A message
  replaces the wordmark text only - it can never hide ON AIR's red.
- Message set → show message text (fits by scaling down for longer text).
- SSE stream drops → prominent "DISCONNECTED" overlay; `EventSource` auto-reconnects;
  overlay clears on the next event.
- `source === "detector"` and `ageSeconds > 300` → small "stale" badge (detector may
  be dead; state may be outdated). Client-side constant, not a server concern.
- The page holds no state of its own: render is a pure function of the last received
  status JSON (plus connection health).

## Implementation shape

- `src/state.ts`: `message: string | null` joins `OnAirState`; `setMessage` /
  `clearMessage` on `StateStore`; `write()` (on-air writes) leaves `message` alone;
  shape guard accepts absent field as null.
- `src/sse.ts`: connection registry - `attach(res)` (headers + snapshot + heartbeat
  timer), `broadcast(status)`, `closeAll()`. Independent of HTTP routing; unit-testable.
- `src/server.ts`: routes for `/message` (PUT/DELETE), `/events`, `/display`; message
  writes go through the existing write queue; broadcast after each queued write
  completes; `?token=` acceptance on GETs.
- `src/display.ts`: exported `DISPLAY_HTML` string.
- `src/app.ts`: wire `closeAll()` into `close()` so shutdown doesn't hang on open
  streams.

## Testing

- Unit: message set/clear/persist round-trip; absent-`message` state file loads as
  null; 400 on empty/oversized/missing text.
- Integration (real server + fetch): `/events` streaming read asserts
  snapshot-on-connect and event-after-write; `/display` returns HTML containing the
  SSE wiring; `?token=` accepted on GETs and rejected on writes when token set;
  heartbeat write does not clear an existing message.

## Out of scope

Colors per source, multiple display variants, sounds, the real LED/tally driver (#6),
kiosk-mode provisioning of the Pi (goes with #4 packaging when it happens).
