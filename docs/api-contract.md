# On-air API contract (v2)

The HTTP API on the receiver. The system's source of truth for presence state, and the
only coupling between this project and any client of it.

**This document is written to be implemented against by someone who is not reading our
source.** VCREC - the external detector (D-30) - is exactly that reader: this repo never
imports it, never names it in code, and never depends on its shape. Anything a client
needs to know has to be here.

Decisions: D-31..D-44 in `CONTEXT.md`. Design: `docs/superpowers/specs/2026-08-23-onair-v2-design.md`.

> **What changed from v1.** `level` and the three-rung ladder are gone, replaced by a
> user-editable **state table**. `hold` is a pin, not a floor. `onAir`, `POST /on`,
> `POST /off` and the five hardcoded rung routes are gone or redefined. `ONAIR_TOKEN` is
> now the **passphrase**. `source` has a required shape. **Presentation left the state
> payload** - `label`, `color` and `bgcolor` come from `GET /config/states`, not from a state
> change. Nothing in v1 is production (map #19), so this is a replacement, not a migration.

---

## 1. The state table

Everything the light can say is a row in a user-editable table. A row:

| Field | Type | Rules |
|---|---|---|
| `id` | string | **Immutable.** `^[a-z0-9][a-z0-9-]{0,31}$`, unique. The only addressable handle - the one thing you ever name on the wire. |
| `label` | string | 1..64 chars. The human phrase every renderer draws. **Freely edited by the owner at any time.** Never a key. |
| `color` | string | `#rrggbb`, lowercase. Foreground/text colour. |
| `bgcolor` | string | `#rrggbb`, lowercase. Background colour. |
| `description` | string | 0..200 chars. A comment for humans. **Never load-bearing** - no client may key behaviour off it. |
| `busy` | boolean | Does this state mean the camera may be live. See §3 - this field carries the whole safety model. |
| `order` | integer | 0..999. Display sort hint. **Never on the wire as an address, never an index you can address by.** |

**Rules a client can rely on:**

- `id` never changes. If you store one, it stays valid until the row is deleted.
- `label`, `color`, `bgcolor`, `description`, `busy` and `order` may change under you at
  any time. They reach you **only** through `GET /config/states`, never on a state change.
  Cache them, and re-pull whenever `tableVersion` moves.
- Index/position is **not** an address. There is no "set option 3". Reordering rows is a
  cosmetic change and must never change what any client resolves to.
- **`unknown` always exists.** It cannot be deleted and its `busy` is always `true`.

### Seed table

Shipped defaults, and the owner's to change:

| `order` | `id` | `label` | `busy` | `bgcolor` | `color` |
|---|---|---|---|---|---|
| 0 | `available` | AVAILABLE | false | `#0b6e2e` | `#ffffff` |
| 1 | `on-air` | ON AIR | true | `#c1121f` | `#ffffff` |
| 2 | `interruptible` | INTERRUPTIBLE | false | `#e8a317` | `#1a1a1a` |
| 3 | `recording` | RECORDING | true | `#6a0dad` | `#ffffff` |
| 99 | `unknown` | NO DATA | true | `#1a1a1a` | `#ff00ff` |

There is **no `dnd`** and no ladder. `available < interruptible < dnd` does not exist.

---

## 2. The state object

One object, persisted atomically, restored on restart.

| Field | Type | Meaning |
|---|---|---|
| `state` | string | The row `id` currently asserted. **A reference to a row, not a copy of one.** |
| `busy` | boolean | `table[state].busy`. Carried because it is **semantics, not presentation** - see the rule below. |
| `intended` | `"on"` \| `"off"` | **Derived, read-only.** `busy ? "on" : "off"`. Writing it has no effect. Exists so a client that has never heard of a row invented tomorrow still does something correct. |
| `confirmed` | string \| `"unknown"` | The row `id` the light acknowledged, read back from the device itself. `unknown` when the light is unreachable or the panel is not repainting. **Never guessed.** |
| `hold` | string \| `null` | The pinned row `id`, or `null` for the **auto** regime. See §3. |
| `source` | string | Who wrote it. `kind:label` - see §4. |
| `updatedAt` | ISO 8601 | Time of the last state write, refreshed by idempotent repeats. |
| `ageSeconds` | integer | Computed at read time. |
| `stale` | boolean | `ageSeconds > 90`. Presentation, never a state change. |
| `tableVersion` | integer | The table version in force. Bumped on every config save. |
| `stateResolvedFrom` | string \| absent | Present only when the live row was deleted and the state fell back to `unknown`. Names the dead `id`. |
| `message` | string \| `null` | Optional display message. Independent of state writes - heartbeats never touch it. |

> **PRESENTATION TRAVELS WITH THE PROFILE, NOT WITH THE STATE.**
>
> `label`, `color` and `bgcolor` are **not** in this payload. A state change says only *which
> row* is now current; how that row looks is in the table, which a renderer fetches from
> `GET /config/states` on its own slow schedule. A state write happens many times an hour; the
> table changes a few times a year. Sending the second with the first would put configuration
> data on every heartbeat and weld presentation into the state protocol permanently.
>
> `busy`, `intended` and `confirmed` **do** travel with the state, and the line is deliberate:
> they are **semantics**. `intended` is RFC 3863's carry-along - the basic status that lets a
> consumer which has never heard of a row still do something correct. Colour is not that; it is
> a look.
>
> The two `/public/*` endpoints are the one exception, and they are a **view**, not the state
> contract - see §5.

---

## 3. The safety model

The system exists to say whether a camera is live. One invariant governs everything:

> **False OFF is worse than false ON.** The light saying "not in a call" while Rocket is on
> camera is the failure to avoid.

With an unordered table there is no rank to encode that in, so it is stated directly, over
the `busy` flag.

### THE BUSY RULE

> **The server never moves from a `busy: true` state to a `busy: false` state, and never
> asserts a `busy: false` state to a renderer, on the strength of evidence that is stale
> (`ageSeconds > 90`). Moving to or staying at `busy: true` is always allowed. Absence of
> information never renders calm.**

Consequences a client should expect:

- **Staleness is visible, never acted on.** There is no TTL, no decay and no auto-anything.
  Only an explicit write changes state. `stale` and `ageSeconds` are for you to render.
- What staleness *does* change is whether the server keeps asserting. Rather than heartbeat
  a stale calm state forever, it **withholds the assertion** and lets the device's own
  watchdog trip into NO DATA. That is withdrawal of a liveness claim, not a state change.
- A client that writes state is expected to re-send it every ~60 s as a heartbeat. That is
  a convention, not enforcement.

### THE PIN RULE

A **hold** pins the state. It is set only by a `human:` source, persisted, and released
only by a `human:` source - **never on a timer**.

> **While a hold is set, a write from an `auto:` source is applied only if it moves the
> system from a `busy: false` state to a `busy: true` state. Every other automated write is
> refused (`409`) and the held state stands. A `human:` write always applies; a `human:`
> write naming a state other than the held one releases the hold.**

The one carve-out exists because a pin without it would let a human's "I'm available today"
keep the light calm while the camera is live - which is the invariant violation in a new
costume. It also means:

- Pinning to a `busy: false` row (say `interruptible`) still lets a detector escalate to
  `on-air`, and the pin **survives** that escalation - so when the call ends and the
  detector writes `available`, that write is refused and the light settles back to
  `interruptible`. *"I am interruptible today"* survives a meeting.
- **"Settles back" is literal, and it is the half of the rule that is easy to miss.** A
  refusal does not merely decline the write and leave the escalation standing - that would
  be a false ON that never clears, since the meeting is over and nothing will move the light
  again until a human notices. The `409` response body therefore reports the **held** row,
  the light is driven there, and `source` reads `human:hold`: the pin decided this, and says
  so. A `403` does none of that - an authority fault in the caller is not the pin reaching a
  decision, and it leaves the world exactly as it found it.
- Pinning to a `busy: true` row freezes it against everything automated.
- Pinning to `available` is legal. It cannot force calm against a live camera, so there is
  nothing to prohibit.

---

## 4. `source` is contract

Because the detector is external and we do not read its source, `source` is the only trace
it leaves here - so its shape is part of this contract, not an implementation detail.

```
source := kind ":" label
kind   := "auto" | "human"
label  := free text, 1..32 chars, for display only
```

- `auto:vcrec`, `auto:calendar-sync` - an automated writer. Subject to the pin rule.
- `human:menubar`, `human:ui`, `human:shortcut` - a person. May set, move and clear holds.

**The rule is split by route, so neither audience pays for the other's convenience:**

| Route | `source` | Missing or unprefixed |
|---|---|---|
| `PUT /state` - the canonical write, what an automated client uses | **required, prefixed** | `400` |
| `POST /state/{id}`, `/on`, `/off` - the curl and Shortcuts surface | optional | defaults to `human:anonymous` |

An earlier draft made `source` forgiving everywhere, so an automated writer that forgot the
prefix would silently get human authority and break the owner's holds. That is the wrong
direction to fail in a system whose whole invariant is "false OFF is worse than false ON".
Splitting by route costs nothing: the route a robot reaches for demands the prefix, the
route a human reaches for does not. **If you are writing an automated client, use
`PUT /state` and send `auto:<yourname>`.**

The one legacy value mapped for continuity is the bare string `detector`, read as
`auto:detector`.

---

## 5. Endpoints

No URL versioning. All responses are JSON except `/display` and the admin bundle.

### `GET /status`

The full state object from §2.

```json
{
  "state": "on-air",
  "busy": true,
  "intended": "on",
  "confirmed": "on-air",
  "hold": null,
  "source": "auto:vcrec",
  "updatedAt": "2026-08-23T21:04:00Z",
  "ageSeconds": 12,
  "stale": false,
  "tableVersion": 7,
  "message": null
}
```

### `PUT /state`

The canonical write. Idempotent - repeating the same body just refreshes `updatedAt`.

```json
{ "state": "on-air", "source": "auto:vcrec" }
```

| Field | Required | Notes |
|---|---|---|
| `state` | yes | A row `id` that exists in the current table. |
| `source` | **yes** | Must carry a valid `auto:` or `human:` prefix. `400` otherwise - see §4. |
| `hold` | no | `true` pins at this request's state; `false` releases. Omitting leaves the hold untouched. **`human:` sources only.** |

Errors:

- unknown `state` -> `400 {"error":"unknown state 'x'","validStates":["available","on-air",...]}`.
  **Never accept-and-fall-back** - a typo must not render calm.
- missing `state` -> `400`.
- missing or unprefixed `source` -> `400 {"error":"source must be prefixed auto: or human:"}`.
- `hold` sent by an `auto:` source -> `403`.
- an `auto:` write refused by the pin rule -> `409` with the current status body, so the
  client can see what stands. This is **not** an error to retry; it is the system working.

Response: `200` with the same body as `GET /status`, after the write and the light attempt.

### `POST /state/{id}`

No-body convenience for `curl`, phone Shortcuts and Companion. Sets that row.
`?source=<kind:label>`, `?hold=1`, `?hold=0` as query parameters. Response identical to
`PUT /state`.

**On this route `source` is optional and defaults to `human:anonymous`**, unlike `PUT /state`.
That asymmetry is deliberate - see §4.

### `POST /on` / `POST /off`

Retained, but they no longer name a state - **they resolve through configuration.**
`shortcuts.on` and `shortcuts.off` in the config store each name a row `id` (seeded
`on-air` and `available`). If either is unset, that route returns
`409 {"error":"no shortcut row is configured for /on"}`.

They are explicit rather than derived on purpose. "Fall back to the first row" is a bad
rule when the first row is ON AIR.

> `onAir`, `POST /available`, `POST /interruptible` and `POST /dnd` are **gone.** Use
> `POST /state/{id}`.

### `GET /config/states`

The state table, for renderers and for Companion preset generation. **Passphrase-gated.**
Self-describing so a client can ask what states exist rather than being compiled with them.

```json
{
  "version": 7,
  "updatedAt": "2026-08-23T20:11:04Z",
  "states": [
    { "id":"available", "label":"AVAILABLE", "color":"#ffffff", "bgcolor":"#0b6e2e",
      "busy":false, "order":0, "description":"Free to interrupt. Knock and come in." }
  ]
}
```

Send `If-None-Match: "<version>"` to get a `304` when nothing has changed. The ESP32 polls
this every 300 s, on boot, immediately after being handed an `id` it does not know, and
immediately when it notices `tableVersion` has moved (see below).

**The version nudge.** Polling alone would leave a colour edit up to 5 minutes from the panel,
which feels broken when you just made it in the admin UI. So the server also writes the current
`tableVersion` to a small entity on the device, alongside the state it already writes. A device
seeing a version it does not hold re-pulls at once. This is a *trigger* for a pull, not a push
of the table - the server still sends no configuration on the state path, and still keeps no
device registry beyond the one host it already writes to.

### Driving the ESP32 (measured, 2026-08-24)

Not part of this API - this is the *server's* client relationship with the device - but
recorded here because it is the one place a reader will look.

- `POST http://<device>/text/PresenceKey/set?value=<id>` writes; `GET .../text/PresenceKey`
  reads back.
- **A POST with no `Content-Length` gets `411`.** `esp_http_server` requires the header even
  for an empty body. Node's `fetch` sends `Content-Length: 0` automatically; `curl -X POST`
  does not, so use `curl -d ''`. This is not new and not specific to `text` - the older
  `select` endpoint behaves identically. It looks like a broken endpoint and is not one.
- **An invalid value returns `200` and is silently dropped**, leaving the previous state in
  place. Measured for both over-length and empty writes. **Read-back after a write is
  mandatory**; the write's status code tells you nothing.
- **A misspelt entity gets a `404`; a missing *component* gets no reply at all.**
  `GET /text/Nope` is a clean `404`, because the `text` handler exists and rejects the name.
  `GET /select/Presence` on current firmware yields an *empty reply* (curl exit 52) - the
  `select` component is no longer compiled in, so nothing is registered for that URI prefix.
  A dropped connection here is a stale client, not a broken device. Measured 2026-08-24.

### `GET /public/status` and `GET /public/events`

**Unauthenticated**, deliberately thin, and **the one place the current row is served
already resolved for rendering.**

```json
{ "state":"on-air", "label":"ON AIR", "color":"#ffffff", "bgcolor":"#c1121f",
  "busy":true, "ageSeconds":12, "stale":false, "tableVersion":7 }
```

`GET /public/events` is the same payload as an unauthenticated SSE stream, with the same
connect/change/15s-keep-alive behaviour as `GET /events`. It exists because `/display` and the
landing page are served unauthenticated and therefore cannot read the gated stream.

**Why these carry colour when `GET /status` does not.** They serve two browser pages that hold
no state table and should not fetch one - the whole point of `/display` is that it is a dumb
page you can point a kiosk at. So the server resolves the row for them. That is a **rendering
view of the state**, not the state contract, and no machine client should read it: it has no
`hold`, no `source`, no `confirmed`, and it is free to change shape to suit the two pages.

**A renderer that holds a table must not use these.** The ESP32, Companion and any other
client take the state key from the gated endpoints and the look from `GET /config/states`.

No passphrase, no config, no `hold`, no `source`, no device information. This does disclose
presence to anyone on the LAN; that is accepted (D-27, D-35).

### `PUT /message` / `DELETE /message`

Set or clear the message shown by `/display`. `PUT` body `{"text":"BE QUIET"}` - non-empty,
max 200 chars. `DELETE` is idempotent. Both return the `GET /status` body. The message
persists across restarts, and state writes never modify it.

**A message may never replace the state word or the state colour on any renderer.** It is
always subordinate.

### `GET /events`

Server-sent events. A `status` event with the full status JSON on connect, another on every
successful write, and a keep-alive `status` event every 15 s per connection - a real event,
so a client can detect a dead stream. `ageSeconds` is computed at send time.

A `tableVersion` change also emits a `status` event, so a live client learns the table moved.

### `GET /events/ws`

WebSocket status stream, server-push-only. Hand-rolled, minimal - not a general-purpose
WebSocket server. Same payload, heartbeat and auth semantics as `GET /events`. Accepts
`?passphrase=` on the upgrade.

Inbound frames are ignored except `ping` (answered with `pong`) and `close` (answered with
`close`). Other frames are parsed but discarded, so the frame stream never desyncs.

Intended for Bitfocus Companion's `generic-websocket` module - see `docs/companion-setup.md`.
**A JSON-path feedback on `intended == "on"` keeps working under an arbitrary state table**;
anything keyed to ladder rungs does not.

### `GET /display`

A self-contained HTML tally page for kiosk use. Renders the current row's `label` on its
`bgcolor` in its `color`, live via `/public/events`. Shows a DISCONNECTED overlay when the stream
drops, a stale badge when `stale`, and a client-side watchdog reconnects after ~45 s of
silence even with no socket error. Unauthenticated.

### `GET /admin/*`

The admin surface. Session-token gated, never passphrase-gated. Specified in the design doc
(§ Auth and § Config store), not here - it is the owner's console, not a client contract.

---

## 6. Lifecycle: what happens when the table changes under you

The owner can, at any moment, change the vocabulary three other parts are speaking. Where
that is caught:

| Event | What a client sees |
|---|---|
| A row is renamed (`label` changed) | Nothing breaks. The `id` you hold is still valid. `label` in `GET /status` changes. |
| Rows are reordered | Nothing. `order` is cosmetic and is not an address. |
| A row you are not using is deleted | Nothing. |
| **The live row is deleted** | State resolves to `unknown` - **conspicuous, never calm** - and `GET /status` gains `stateResolvedFrom: "<dead-id>"`. |
| **The pinned row is deleted** | The pin is released in the same operation. |
| **You write an `id` that no longer exists** | `400`, listing the valid ids. Loud, never silent. |
| **A renderer is handed an `id` it does not know** | It must draw the `unknown` appearance. **It must never silently drop it** - a state that degrades to nothing looks exactly like a calm one. |

`tableVersion` in `GET /status` tells you which table was in force. Old versions are not
retained; there is no history store in this system yet.

---

## 7. Light failures are not write failures

A write always succeeds if the body is valid. The state is updated and persisted even when
the light is unreachable; the failure surfaces as `confirmed: "unknown"`. Clients that care
check `confirmed`, not the status code.

---

## 8. Auth

Two credentials, two audiences, and **neither is accepted on the other's routes.**

**The passphrase** is the machine credential. It gates `GET /status`, `PUT /state`,
`POST /state/{id}`, `/on`, `/off`, `/message`, `/events`, `/events/ws` and
`/config/states`.

- `Authorization: Bearer <passphrase>` on anything that can send a header.
- `?passphrase=<passphrase>` where one cannot: `EventSource`, the WebSocket upgrade, a
  remote kiosk navigation. `?token=` is accepted as a deprecated alias.
- After a rotation, **the previous passphrase keeps working for 60 minutes**, so a client
  that has not been updated yet degrades on a schedule rather than instantly.
- An empty configured passphrase is a startup error, never bypassable auth.

**Admin credentials** (user + password) gate only `/admin/*`, via a session bearer token
from `POST /admin/session`. No cookie is issued - a header cannot be forged cross-origin
without a preflight, so CSRF on admin routes is structurally impossible while the write
routes above stay deliberately CORS-simple.

**The local waiver (D-24).** The passphrase and the admin login are both waived when, and
only when, the connection is from loopback **and** `Host` names a loopback name on our port
**and** `Origin` is absent or exactly one of ours - **and never** when `Sec-Fetch-Site` is
present and is anything other than `same-origin` or `none`. `remoteAddress` alone is not
enough: a page served from another address can perform a CORS-simple `POST` against a
loopback port and the server sees `remote: 127.0.0.1`. Measured, both attacks, both now
regression tests.

`POST /admin/factory-reset` always requires the admin password, from any origin, including
loopback.

**Unauthenticated:** `GET /public/status`, `GET /public/events`, `GET /display`, and the admin UI's static bundle
(byte-identical for every caller, and it renders no data of its own).

**Device auth is separate and always has been.** The service authenticates *to* the ESP32
with HTTP basic auth (D-17). That credential is never the passphrase.

---

## 9. Errors

Shape: `{"error": "<human-readable message>"}`, plus context fields where they help
(`validStates` on an unknown state).

| Status | When |
|---|---|
| `400` | Malformed JSON; missing `state`; unknown `state` id; invalid `source` shape |
| `401` | Passphrase or admin session absent/wrong |
| `403` | An `auto:` source attempted to set or clear a hold; `POST /admin/restart` with no passphrase configured |
| `404` | Unknown path |
| `405` | Known path, wrong method |
| `409` | An `auto:` write refused by the pin rule; a config save whose `version` is stale; a rebind that failed and rolled back |
| `507` | A config save that could not be written to disk. The running config is untouched. |

---

## 10. Network

- Default port `8484`. Configurable in the admin UI and by `ONAIR_PORT` in the real
  environment.
- **Loopback is always bound**, and is not a user choice. The bind setting chooses what
  *else* is bound: `all` (default), `loopback`, or `iface:<name>`.
- The interface **name** is stored and re-resolved at every startup. A stored address goes
  stale, and a stale address is a hard startup failure under a `KeepAlive` supervisor.
- A port or bind change **rebinds in place** - no process exit, no supervisor involvement -
  and **rolls back to the previous binding** if the new one fails.
- LAN-only exposure plus the passphrase is the security model. Nothing here is designed to
  face the internet.
