# On-air API contract (v2)

The HTTP API on the receiver. The system's source of truth for presence state, and the
only coupling between this project and any client of it.

**This document is written to be implemented against by someone who is not reading our
source.** VCREC - the external detector (D-30) - is exactly that reader: this repo never
imports it, never names it in code, and never depends on its shape. Anything a client
needs to know has to be here.

Decisions: D-31..D-44 and D-126 in `CONTEXT.md`. Design: `docs/superpowers/specs/2026-08-23-onair-v2-design.md`.

> **What changed from v1.** `level` and the three-rung ladder are gone, replaced by a
> user-editable **state table**. `onAir`, `POST /on`, `POST /off` and the five hardcoded
> rung routes are gone or redefined. `ONAIR_TOKEN` is now the **passphrase**. `source` has a
> required shape. **Presentation left the state payload** - `label`, `color` and `bgcolor`
> come from `GET /config/states`, not from a state change. Nothing in v1 is production
> (map #19), so this is a replacement, not a migration.

> **Removed 2026-08-29 (D-126).** The **pin** is gone, and four published things go with it:
> the `hold` field in the state object, the `hold` body field and the `?hold=` query
> parameters on the write routes, the `403` that a write route could return, and the `409`
> that carried a status body. There is no URL versioning here and no deprecation mechanism
> (§5), so a removal is written down rather than staged - this line is the whole of the
> notice. What replaces the rule is in §3; what happens to a client that still sends `hold`
> is in §5 under `PUT /state`.

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
| `source` | string | Who wrote it. `kind:label` - see §4. |
| `updatedAt` | ISO 8601 | **Provenance.** Time of the last state write, refreshed by idempotent repeats. |
| `ageSeconds` | integer | **Provenance.** How long ago that write happened, computed at read time. |
| `tableVersion` | integer | The table version in force. Bumped on every config save. |
| `stateResolvedFrom` | string \| absent | Present only when the live row was deleted and the state fell back to `unknown`. Names the dead `id`. |
| `message` | string \| `null` | Optional display message. Independent of state writes - a state write never touches it. |

> **PRESENTATION TRAVELS WITH THE PROFILE, NOT WITH THE STATE.**
>
> `label`, `color` and `bgcolor` are **not** in this payload. A state change says only *which
> row* is now current; how that row looks is in the table, which a renderer fetches from
> `GET /config/states` on its own slow schedule. A state write happens many times an hour; the
> table changes a few times a year. Sending the second with the first would put configuration
> data on every state write and weld presentation into the state protocol permanently.
>
> `busy`, `intended` and `confirmed` **do** travel with the state, and the line is deliberate:
> they are **semantics**. `intended` is RFC 3863's carry-along - the basic status that lets a
> consumer which has never heard of a row still do something correct. Colour is not that; it is
> a look.
>
> The two `/public/*` endpoints are the one exception, and they are a **view**, not the state
> contract - see §5.

> **`updatedAt` AND `ageSeconds` ARE FACTS, NOT JUDGEMENTS.**
>
> There was a `stale` field here. It is **gone**, not renamed and not deprecated - a field
> still called `stale` beside the real thing is a decoy the next renderer keys on. Nothing on
> the wire tells you what an age *means*, because the server no longer decides: it reports
> when the state was written and leaves the conclusion to you. See the client contract in §3.

---

## 3. The safety model

The system exists to say whether a camera is live. One invariant governs everything:

> **False OFF is worse than false ON.** The light saying "not in a call" while Rocket is on
> camera is the failure to avoid.

With an unordered table there is no rank to encode that in, so it is stated directly, over
the `busy` flag.

### THE BUSY RULE

> **Absence of information never renders calm.**

That is the whole of it, and it is now a **rule about renderers**. It used to have a server
half - the server refused to assert a `busy: false` state once `ageSeconds > 90`, and let the
panel's own watchdog trip. That half is **gone**; what replaced it is below.

**The server latches. It does not decay.**

- While the service runs, **the state is the state**. `state`, `source`, `updatedAt` and
  `message` change only on an **explicit write**. No TTL, no decay, no auto-anything.
- **The server never asserts anything about time.** It reports `updatedAt` and `ageSeconds`
  as provenance and branches on neither. There is no server code path that reads a clock to
  decide what the state IS.
- The reason it can afford this: **the writer is responsible for making a write stick.** A
  detector writes, reads back to validate, and retries until confirmed or out of time. A lost
  write is therefore detected by the writer, not inferred by the server from silence - so
  silence means what a state machine says it means: nothing has changed.
- There is **no ~60 s heartbeat convention.** A client that writes state is *not* expected to
  re-send it on a timer. Re-send until the write is CONFIRMED, then stop.

### THE CLIENT CONTRACT

Every renderer **polls**, and decides for itself when it has lost the server. Three
conditions, not two:

1. **Reachable** - draw the current state, plainly.
2. **Unreachable, inside the grace window** - **keep drawing the last known state**, with a
   visible connection-lost mark: a band, a line of text, an icon. The renderer says what it
   last knew *and* that it is no longer being refreshed. It does not go blank and it does not
   go calm.
3. **Unreachable beyond the timeout and/or retry count** - **NO DATA**.

Both thresholds are measured from the **last successful contact with the server**, and are
**not chained off each other**: two independent numbers, one clock.

| Setting | Default | Meaning |
|---|---|---|
| poll interval | **1000 ms** (range 250..60000) | how often a renderer asks the server |
| connection lost after | **1 minute** | mark the display as no longer refreshing; state unchanged |
| no data after | **30 minutes** | give up on the state entirely -> NO DATA |

All three are **configuration, not constants**. The two thresholds are deliberately far
apart: a meeting runs about thirty minutes, so the state must survive a server outage for at
least that long or the panel goes dark mid-call - while the honesty about not being refreshed
costs nothing and should arrive immediately. There is no per-row branch: every state is
marked unrefreshed after a minute and every state persists for thirty.

**Fail CLOSED when you derive this.** Absent, malformed or unparseable input means *withhold
calm*, never *assume calm*. This is a measured incident, not a precaution: trusting a server
flag once drew a calm menu bar on 27-hour-old evidence.

**What this covers, and what it does not.** It covers server death, network partition and
renderer isolation - all three now produce a visible, escalating loss of confidence at the
renderer. It does **not** cover a dead **writer**: if the detector stops while the state reads
`available`, the server is healthy, every client polls happily, and every panel paints
confident green. That exposure is named rather than hidden, and the fix when it is wanted is
additive - the server reports one more *fact*, when the writer was last seen, and the client
decides what to do with it.

**Push is an optimisation, never a delivery guarantee.** On a state change the server emits
to connected clients and does not error if one misses it; a client that misses a push gets
the change on its **next poll**. Do not build correctness on the stream.

### LAST WRITE WINS

There was a **pin** here until 2026-08-29: a hold a `human:` source set on a state, which
refused automated writes until a human released it. It is gone (D-126). What stands in its
place is a positive rule rather than an absence, because an absence is not a contract - a
document that merely stops mentioning precedence is a document the next implementer puts
precedence back into.

> **Every write with a valid body is applied. No `source` outranks another, and no earlier
> write can block a later one.** A manual override is an ordinary state write; the detector's
> next write replaces it. There is no pin, no hold, no precedence, and no server-side memory
> of who wrote last beyond the `source` string itself.

That is the owner's working pattern turned into a guarantee: the detector drives the light, a
human overrides it mid-meeting, and when the meeting ends the detector's write wins and puts
the light back on its own.

**Do not read the removal as dropping a false-ON guard.** The escalation carve-out and the
"settles back" behaviour that used to be documented here were mitigations *of* the pin, not
protections the pin provided. A refusal drove the light back to the held row, so a detector
re-sending an escalation - which the client contract above requires it to do - was pushed off
it again, mid-call, with the camera live. Deleting the refusal path deletes that failure mode
rather than inheriting it.

**What is genuinely lost, named rather than hidden.** Pinned at a `busy: true` row, an
`auto:` write naming a calm row was refused and the light stayed ON. That was a real
false-OFF protection. It is narrow - it applied only while a human had explicitly pinned, and
only against a detector that was already wrong - and it is removed deliberately, not by
oversight. Since the detector is now the sole authority by design, a wrong detector is a
detector problem.

---

## 4. `source` is contract

Because the detector is external and we do not read its source, `source` is the only trace
it leaves here - so its shape is part of this contract, not an implementation detail.

```
source := kind ":" label
kind   := "auto" | "human"
label  := free text, 1..32 chars, for display only
```

- `auto:vcrec`, `auto:calendar-sync` - an automated writer.
- `human:menubar`, `human:ui`, `human:shortcut` - a person.

**`auto:` and `human:` no longer differ in authority. Nothing a `human:` source may do is
denied to an `auto:` source. The prefix is provenance** - it says who put the light where it
is, and no code path in the service branches on it.

**The rule is still split by route, so neither audience pays for the other's convenience:**

| Route | `source` | Missing or unprefixed |
|---|---|---|
| `PUT /state` - the canonical write, what an automated client uses | **required, prefixed** | `400` |
| `POST /state/{id}`, `/on`, `/off` - the curl and Shortcuts surface | optional | defaults to `human:anonymous` |

The split used to be justified as an authority boundary: an automated writer that forgot the
prefix would silently get human authority and break the owner's holds. That justification
died with the pin (§3), and the shape is kept for a plainer reason. `source` is the only
trace the external detector leaves here (D-30), it is what every renderer displays, and
relaxing the shape of a required field would be a breaking change to a client this repo
cannot edit, for nothing in return. Splitting by route still costs nothing: the route a robot
reaches for demands the prefix, the route a human reaches for does not. **If you are writing
an automated client, use `PUT /state` and send `auto:<yourname>`.**

The one legacy value mapped for continuity is the bare string `detector`, read as
`auto:detector` - **and that mapping lives only on the lenient routes.** It is part of
`coerceSource`, which is what `POST /state/{id}`, `/on` and `/off` call; `PUT /state` parses
strictly and never sees it. So `PUT /state` with `"source":"detector"` is a `400`, exactly
like any other unprefixed value. That is not an oversight: the mapping exists so a v1 client
still *heartbeating* `?source=detector` at the convenience surface keeps reading as a machine,
and an automated client writing the canonical route should be sending `auto:detector` itself.

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
  "source": "auto:vcrec",
  "updatedAt": "2026-08-23T21:04:00Z",
  "ageSeconds": 12,
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

**A `hold` key in the body is accepted and ignored**, whatever its value, and so are the
`?hold=1` / `?hold=0` query parameters on the convenience routes. They were the pin's
controls and the pin is gone (§3, D-126). They are ignored rather than rejected on purpose: a
rejected body means the state write is **discarded**, so refusing a request because it
mentions a retired field would leave the light asserting the old state - a false OFF
manufactured by a field name, on a client we cannot edit in lockstep. **A retired rider must
never veto a state assertion.** Any other unrecognised top-level key is ignored the same way;
this route reads `state` and `source` and nothing else. That is not accept-and-fall-back: the
`state` value itself is still validated loudly, below.

Errors:

- unknown `state` -> `400 {"error":"unknown state 'x'","validStates":["available","on-air",...]}`.
  **Never accept-and-fall-back** - a typo must not render calm.
- missing `state` -> `400`.
- missing or unprefixed `source` -> `400 {"error":"source must be prefixed auto: or human:"}`.
- a body that is not JSON, or over 16 KB -> `400 {"error":"malformed JSON body: ..."}`. The
  size limit fails the read inside the same `try`, so it is a `400` and not a `413`.

**Those four, plus the `401` every gated route can answer, are the 4xx errors this route can
produce.** It cannot answer `403` and it cannot answer `409`: no write is refused any more.

It can still answer `500`. The write persists the new state to the state file before the
light is touched, and a persist that throws - a read-only directory, a full disk, a
`state.json` whose parent has gone away - propagates to the catch-all and becomes
`500 {"error":"internal error: ..."}`. That is not a refused write and it is not the light
failing (§7); it is the server failing to record a write it has *already applied in memory*.
Retry once with backoff, and read `GET /status` before assuming the state did not move.

Response: `200` with the same body as `GET /status`, after the write and the light attempt.

### `POST /state/{id}`

No-body convenience for `curl`, phone Shortcuts and Companion. Sets that row.
`?source=<kind:label>` as a query parameter. `?hold=1` and `?hold=0` are still accepted and
ignored, for the reason given under `PUT /state`. Response identical to `PUT /state`.

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
immediately when it notices `tableVersion` has moved (see below). It also retries every 15 s
until its **first** successful pull and then stops - a board that boots while the server is
down would otherwise sit on `NO CONFIG` for up to five minutes after the server returns.

**The version nudge.** Polling alone would leave a colour edit up to 5 minutes from the panel,
which feels broken when you just made it in the admin UI. So the server also writes the current
`tableVersion` to a small entity on the device. A device seeing a version it does not hold
re-pulls at once. This is a *trigger* for a pull, not a push of the table - the server still
sends no configuration on the state path, and still keeps no device registry beyond the one
host it already writes to.

The nudge fires when the table is saved, and again on the supervisor's poll if that first
attempt did not land. **It does NOT ride along with a state write** (changed 2026-08-30,
D-130): against an unreachable device it was two seconds of every write's latency, for
something advisory that the device re-pulls on its own interval anyway. The consequence is
that a table edit made while the panel is unreachable reaches it at worst one supervisor poll
later than it used to, instead of waiting for the next state write. Nothing on this API's
surface changes.

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
- **`mode: password` does NOT keep a value out of the device's API.** It masks the `state`
  field and writes the raw string to `value`, on every `GET` and every SSE event:
  `{"id":"text/X","value":"<the real secret>","state":"********"}`. Unconditional -
  `web_server.cpp:1421` picks the masked `state`, then `set_json_value` assigns `value`
  regardless. **D-38 asserted the opposite and was wrong** (corrected in D-55). A credential
  on the device must not live in a `text` entity's value at all; the panel keeps the server
  passphrase in a preference blob and its `ServerPassphrase` entity is write-only, reading
  back a constant. Measured 2026-08-25.
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
  "busy":true, "message":null, "ageSeconds":12, "tableVersion":7 }
```

`message` is here for the reason D-9 forces it to be: a message may never replace or obscure
the state word, but `/display` is served unauthenticated and so cannot read the gated stream,
which leaves this as the only way the text reaches the page. It discloses nothing the panel on
the wall is not already showing. Those eight keys are the whole payload.

`GET /public/events` is the same payload as an unauthenticated SSE stream, with the same
connect/change/15s-keep-alive behaviour as `GET /events`. It exists because `/display` and the
landing page are served unauthenticated and therefore cannot read the gated stream.

**Why these carry colour when `GET /status` does not.** They serve two browser pages that hold
no state table and should not fetch one - the whole point of `/display` is that it is a dumb
page you can point a kiosk at. So the server resolves the row for them. That is a **rendering
view of the state**, not the state contract, and no machine client should read it: it has no
`source`, no `confirmed`, and it is free to change shape to suit the two pages.

**A renderer that holds a table must not use these.** The ESP32, Companion and any other
client take the state key from the gated endpoints and the look from `GET /config/states`.

No passphrase, no config, no `source`, no device information. This does disclose
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
`bgcolor` in its `color`, live via `/public/events`. It implements the §3 client contract:
a connection-lost mark once contact lapses, the last known state held behind it, and NO DATA
once the second threshold passes. A client-side watchdog fires on silence even with no socket
error. Unauthenticated.

### `GET /admin/*`

The admin surface. Session-token gated, never passphrase-gated. Specified in the design doc
(§ Auth and § Config store), not here - it is the owner's console, not a client contract.

One field of `GET /admin/config` is worth stating here, because it is about the wire and not
about the console:

```json
{
  "config": { "...": "the document" },
  "env": {
    "overrides": [{ "key": "light.host", "variable": "ONAIR_LIGHT_HOST" }],
    "effective": { "host": "10.42.12.77", "entity": "PresenceKey" }
  }
}
```

`env.overrides` names the config keys the **environment overlay is currently outranking**, and
the variable doing it. **Names only, never values** - `ONAIR_LIGHT_PASS` is a device credential
and a list of names serves every caller while a list of values serves none (D-79).

`env.effective` carries the device settings **actually in force** - the overlay over the
document, the same resolution `makeDriver` uses. A consumer that wants to reach the panel must
use `env.effective.host` and not `config.light.host`, which may not be the box the service is
driving.

`effective` carries **`host` and `entity` only**. `username` and `password` are a device
credential and are never reported as effective values; an overridden credential is named in
`overrides` and nothing more, which is enough to say where it is set.

---

## 6. Lifecycle: what happens when the table changes under you

The owner can, at any moment, change the vocabulary three other parts are speaking. Where
that is caught:

| Event | What a client sees |
|---|---|
| A row is renamed (`label` changed) | Nothing breaks. The `id` you hold is still valid. The new label reaches you on your next `GET /config/states`, **never on a state change** - `label` is not in the status payload at all (§2). |
| Rows are reordered | Nothing. `order` is cosmetic and is not an address. |
| A row you are not using is deleted | Nothing. |
| **The live row is deleted** | State resolves to `unknown` - **conspicuous, never calm** - and `GET /status` gains `stateResolvedFrom: "<dead-id>"`. |
| **You write an `id` that no longer exists** | `400`, listing the valid ids. Loud, never silent. |
| **A renderer is handed an `id` it does not know** | It must draw the `unknown` appearance. **It must never silently drop it** - a state that degrades to nothing looks exactly like a calm one. |

`tableVersion` in `GET /status` tells you which table was in force. Old versions are not
retained; there is no history store in this system yet.

---

## 7. Light failures are not write failures

A write always succeeds if the body is valid **and the state file can be written**. The state
is updated and persisted even when the light is unreachable; the failure surfaces as
`confirmed: "unknown"`. Clients that care check `confirmed`, not the status code.

The one exception is worth stating plainly, because it is the only way a valid body does not
get a `200`: the in-memory write happens *before* the persist, so a persist that throws
answers `500` with the new state already live and un-persisted (§5, `PUT /state`). The light
is not the failure mode there - the disk is.

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
| `403` | `POST /admin/restart`, which in the shipped service is **unconditional** (the route requires `ServerDeps.token`, which `app.ts` never supplies; configuring the passphrase does not satisfy it); `POST /admin/factory-reset` without the admin password |
| `404` | Unknown path |
| `405` | Known path, wrong method |
| `409` | A config save whose `version` is stale; a config save that failed to write for a reason other than disk-full; a rebind that failed and was rolled back; `POST /on` or `/off` with no shortcut row configured |
| `500` | Anything that throws out of a route and reaches the catch-all - in practice a state or message write whose persist to the state file failed. The in-memory state has already moved (§7). |
| `507` | A config save that could not be written to disk. The running config is untouched. |

**`403` is admin-only.** No state-write route can produce one; both causes are on the admin
surface. It is never retryable - the next identical request fails identically.

**No error response carries a status object.** The extra fields an error body can carry are
exactly three, and none is state: `validStates` on an unknown state id, `problems` on a config
document that failed validation (`400 {"error":"invalid config","problems":[...]}`), and the
live `config` document on a config save that was refused or failed. Until 2026-08-29 the pin's
refusal merged the whole state object into a `409` and into a `403`, and a `409` from a write
route meant *the system working, read it and carry on*. That response is gone with the pin
(D-126). A `409` now always means a person has to change something - an unset shortcut row,
or a config document someone else moved underneath you - so **surface it and do not retry
it**. A client that reads `.state` off a `409` gets `undefined`, always.

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
