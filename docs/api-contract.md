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
| `updatedAt` | ISO 8601 string | Time of last write. Refreshed by every write, including idempotent repeats. |

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

## Light failures are not write failures

A write always succeeds if the body is valid: `intended` is updated and persisted even
when the light is unreachable. The failure surfaces as `confirmed: "unknown"` in the
response and in `GET /status`. Clients that care check `confirmed`.

## Auth

Off by default. If the `ONAIR_TOKEN` env var is set, every endpoint requires
`Authorization: Bearer <token>`; wrong or missing token gets `401`.

## Errors

Shape: `{"error": "<human-readable message>"}`.

| Status | When |
|---|---|
| `400` | Malformed JSON, missing/non-boolean `onAir` |
| `401` | Token configured and absent/wrong |
| `404` | Unknown path |
| `405` | Known path, wrong method |

## Network

- Default port `8484`, override with `ONAIR_PORT`.
- Binds all interfaces; LAN reachability is the point. LAN-only exposure plus the
  optional token is the v1 security model.
