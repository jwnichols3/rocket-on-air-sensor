# Client guide: constructing on-air API calls

How to call the on-air service from your own code. This is the practical companion to
`docs/api-contract.md`, which is the normative spec. **Where the two disagree, the contract
wins** and this file is the bug.

Everything below was checked against a running service on 2026-08-28.

---

## 1. Work out what kind of client you are

Your answer picks your routes, your credential and your `source` for the rest of the guide.

| You are | Example | You call | Your `source` |
|---|---|---|---|
| **An automated writer** | a call detector, a calendar sync | `PUT /state` | `auto:<yourname>` |
| **A human-triggered writer** | a shell alias, a phone Shortcut, a Stream Deck button | `POST /state/{id}`, `/on`, `/off` | optional |
| **A renderer** | a panel, a menu bar item, a wall display | `GET /status` + `GET /config/states` | none, you never write |
| **A dumb kiosk** | a browser pointed at a screen | `GET /public/status`, or just `GET /display` | none |

Two of these choices are load-bearing and are explained in section 4: an automated writer
that uses a human route silently acquires the authority to override the owner's holds, and a
renderer that reads `/public/status` gets a view that is free to change shape underneath it.

---

## 2. Base URL

- Default port **8484**. Configurable in the admin console and by `ONAIR_PORT`.
- **Loopback is always bound.** `http://127.0.0.1:8484` works on the host machine no matter
  how the bind setting is configured.
- Off-host clients use the LAN address. There is no TLS and no internet exposure; LAN plus
  the passphrase is the whole security model.
- No URL versioning. Every response is JSON except `/display`, `/docs` and the admin bundle.

---

## 3. Credentials

Two credentials that are **never accepted on each other's routes**.

| Route group | Credential |
|---|---|
| `/status`, `/state`, `/state/{id}`, `/on`, `/off`, `/message`, `/events`, `/events/ws`, `/config/states` | **the passphrase** |
| `/admin/*` (except `/admin/session`) | **an admin session token** |
| `/public/status`, `/public/events`, `/display`, `/docs`, `/`, `/admin` | **none** |

### Sending the passphrase

**Use the header wherever you can:**

```
Authorization: Bearer <passphrase>
```

**The query fallback works on GET only:** `?passphrase=<passphrase>`. It exists for the three
places a header is impossible - `EventSource`, the WebSocket upgrade, and a kiosk URL you type
into a browser. It is rejected on writes on purpose, so the credential never lands in server
logs or browser history for the sake of something that did not need it. `?token=` is a
deprecated alias that still works.

### The local waiver: why your first curl succeeded without a passphrase

Both credentials are waived when **all** of these hold:

- the connection is from loopback, **and**
- `Host` names a loopback name on our port, **and**
- `Origin` is absent or is exactly ours, **and**
- `Sec-Fetch-Site` is absent, `same-origin`, or `none`.

Every clause is there because of a measured attack, not a hypothetical: a page served from
another address can perform a CORS-simple `POST` at a loopback port, and the server sees
`remote: 127.0.0.1`. Checking the remote address alone does not protect you.

**Do not build on the waiver if your client might ever move off the host.** Send the
passphrase anyway; it is accepted from loopback too.

### Rotation

After the passphrase is changed, **the previous one keeps working for 60 minutes**. That turns
"every hand-configured client on the LAN broke at once" into a walk around the house. If your
client can surface an auth failure to a human, do it rather than retrying silently for an hour.

### Admin routes

`POST /admin/session` with `{"user":..., "password":...}` returns `{token, expiresAt}`. Send it
as `Authorization: Bearer <token>`. Sessions live 12 hours, slide on use, are in memory only,
and there is no cookie - so a server restart logs you out and page refreshes do not persist.

`POST /admin/factory-reset` always demands the admin password in the body, from any origin,
loopback included.

---

## 4. Writing state

### 4.1 `source` is the thing that catches everyone

```
source := kind ":" label
kind   := "auto" | "human"
label  := free text, 1..32 chars, display only
```

`auto:` writers are subject to the pin rule. `human:` writers are not, and may set and clear
pins. **This is an authority boundary, not a label.**

The rule is split by route so neither audience pays for the other's convenience:

| Route | `source` | If missing or unprefixed |
|---|---|---|
| `PUT /state` | **required, prefixed** | `400` |
| `POST /state/{id}`, `/on`, `/off` | optional | defaults to `human:anonymous` |

An automated client that forgets the prefix on `PUT /state` gets a `400`, which is loud. The
same client pointed at `POST /state/on-air` gets **human authority** and quietly overrides the
owner's holds. **If you are automated, use `PUT /state`.**

The bare legacy string `detector` is mapped to `auto:detector` for continuity. Nothing else is.

### 4.2 `PUT /state` - the canonical write

```bash
curl -sS -X PUT http://127.0.0.1:8484/state \
  -H 'Authorization: Bearer <passphrase>' \
  -H 'content-type: application/json' \
  -d '{"state":"on-air","source":"auto:vcrec"}'
```

| Field | Required | Notes |
|---|---|---|
| `state` | yes | A row `id` present in the current table. |
| `source` | yes | Prefixed `auto:` or `human:`. |
| `hold` | no | `true` pins, `false` releases, omitted leaves it alone. **`human:` only.** |

Idempotent: repeating the same body refreshes `updatedAt` and nothing else. The response is the
full status object, the same shape as `GET /status`, taken after the write and after the light
attempt.

### 4.3 The convenience routes

For a shell alias, a phone Shortcut, or a Companion button - anywhere a human is behind the
call and a JSON body is a nuisance.

```bash
curl -sS -X POST 'http://127.0.0.1:8484/state/on-air?source=human:shortcut'
curl -sS -X POST 'http://127.0.0.1:8484/on'
curl -sS -X POST 'http://127.0.0.1:8484/off?hold=1'
```

`/on` and `/off` resolve through configuration rather than naming a row. Out of the box `/on`
is `on-air` and `/off` is `available`, but the owner can point them anywhere. **If the shortcut
is unset you get a `409`, not a guess** - falling back to the first row would mean an unset
`/off` turning the light red.

Query parameters: `?source=`, `?hold=1`, `?hold=0`. Anything else in `hold` is ignored rather
than rejected.

### 4.4 Holds

A hold pins the state. Set and cleared only by a `human:` source, persisted, **never released
on a timer**.

> While a hold is set, a write from an `auto:` source is applied only if it moves the system
> from a `busy: false` state to a `busy: true` state. Every other automated write is refused
> with `409` and the held state stands.

The carve-out is the whole design: without it, "I am available today" would hold the light calm
while the camera is live. What it means for you as an automated writer:

- Your escalation to a busy state **will** land even against a pin. That is intended.
- Your later de-escalation **will** be refused with a `409`, and the server settles the light
  back to the held row with `source: human:hold`.
- **A `409` is not an error and not a retry signal.** It is the system working. Read the status
  body that comes with it and carry on. Retrying will not help and only adds noise.
- A `403` on a hold means your `source` is `auto:` and you tried to touch the pin. That is a
  bug in your client. Fix the call; do not retry.

### 4.5 Confirm your own write

**The server latches and never decays.** There is no TTL, no heartbeat convention, and no
expectation that you re-send state on a timer. The flip side is that **making a write stick is
your job**: write, read back, retry until confirmed or until you run out of time. A lost write
is caught by the writer, never inferred by the server from silence.

Two different fields, two different questions:

- `state` - did the server accept my write? Present in the write's own response.
- `confirmed` - did the **light** acknowledge it, read back from the device? `unknown` when the
  device is unreachable or not repainting. Never guessed.

A write with a valid body **always succeeds** even when the light is dead. The light failure
surfaces as `confirmed: "unknown"`, not as a status code. If you care about the glass, check
`confirmed`; if you only care that the system recorded your intent, the response is enough.

```bash
# write, then confirm the light agrees, giving up after ~10s
curl -sS -X PUT "$BASE/state" -H "Authorization: Bearer $PASS" \
  -H 'content-type: application/json' -d '{"state":"on-air","source":"auto:vcrec"}' >/dev/null
for _ in $(seq 20); do
  [ "$(curl -sS "$BASE/status" -H "Authorization: Bearer $PASS" \
       | sed -n 's/.*"confirmed":"\([^"]*\)".*/\1/p')" = "on-air" ] && exit 0
  sleep 0.5
done
echo "light never confirmed on-air" >&2; exit 1
```

**Known limitation.** `confirmed` currently tracks the panel's repaint counter, which keeps
advancing while the backlight is off - so `confirmed` can read healthy while the glass is dark.
Tracked as issue #82. Do not treat `confirmed` as proof that a human can see anything.

---

## 5. Reading state

### `GET /status`

```bash
curl -sS http://127.0.0.1:8484/status -H 'Authorization: Bearer <passphrase>'
```

```json
{"state":"available","confirmed":"available","hold":null,"source":"human:admin",
 "updatedAt":"2026-08-28T00:37:22.080Z","message":null,"busy":false,
 "intended":"off","ageSeconds":53529,"tableVersion":11}
```

| Field | Use it for |
|---|---|
| `state` | The row id in force. **A reference to a row, never a copy of one.** |
| `busy` | Does this state mean the camera may be live. Semantics, not presentation. |
| `intended` | `busy ? "on" : "off"`. Derived and read-only. Key your logic here if you want to survive a row invented next year without a code change. |
| `confirmed` | The row the light acknowledged. See 4.5. |
| `hold` | The pinned row, or `null`. |
| `source` | Who wrote it. |
| `updatedAt`, `ageSeconds` | **Provenance. Facts, not judgements.** |
| `tableVersion` | Bumped on every config save. A change means refetch the table. |
| `stateResolvedFrom` | Present only when the live row was deleted and the state fell back to `unknown`. Names the dead id. |
| `message` | Optional display text. Independent of state; a state write never touches it. |

**`label`, `color` and `bgcolor` are deliberately not here.** A state change says which row is
current; how that row looks comes from `GET /config/states` on your own slow schedule. See
section 7.

**There is no `stale` field.** There used to be, and it was removed rather than renamed,
because a field still called `stale` beside the real thing is a decoy the next renderer keys
on. The server reports when the state was written and refuses to tell you what that means.

### The client contract: three conditions, not two

Every renderer polls and decides for itself when it has lost the server.

1. **Reachable** - draw the current state, plainly.
2. **Unreachable, inside the grace window** - **keep drawing the last known state** with a
   visible connection-lost mark. Say what you last knew *and* that you are no longer being
   refreshed. Do not go blank. Do not go calm.
3. **Unreachable past the timeout** - **NO DATA**.

| Setting | Default | Meaning |
|---|---|---|
| poll interval | 1000 ms (250..60000) | how often you ask |
| connection lost after | 1 minute | mark the display unrefreshed; state unchanged |
| no data after | 30 minutes | give up on the state entirely |

Both thresholds run from **the last successful contact**, as two independent numbers on one
clock. They are not chained. They are far apart on purpose: a meeting runs about half an hour,
so the state has to outlive a server outage or the panel goes dark mid-call, while the honesty
about not being refreshed costs nothing and should arrive immediately.

Make all three configuration, not constants.

### Fail closed

> **Absence of information never renders calm.**

Absent, malformed or unparseable input means **withhold calm**, never **assume calm**. This is
a measured incident, not a precaution: trusting a server flag once drew a calm menu bar on
27-hour-old evidence.

The failure this system exists to prevent is a **false OFF** - the light saying "not in a call"
while the camera is live. When you are unsure, err loud.

**What this does not cover.** A dead *writer*. If your detector dies while the state reads
`available`, the server is healthy, every poll succeeds and every panel paints confident green.
That exposure is named rather than hidden. If you are writing a detector, this is your problem
to own.

---

## 6. Streams

### `GET /events` (SSE)

A `status` event carrying the full status JSON on connect, another on every successful write,
and a keep-alive every 15 s. The keep-alive is a **real** `status` event, not a comment, so
silence is unambiguous evidence of a dead stream. A `tableVersion` change emits one too.

```js
// EventSource cannot send headers, which is what ?passphrase= is for.
const es = new EventSource(`${base}/events?passphrase=${encodeURIComponent(pass)}`);
es.addEventListener('status', (e) => render(JSON.parse(e.data)));
```

### `GET /events/ws` (WebSocket)

Same payload, heartbeat and auth as `/events`, **server-push-only**. Accepts `?passphrase=` on
the upgrade. Inbound frames are ignored except `ping` and `close`. It is hand-rolled and
minimal, aimed at Companion's `generic-websocket` module - not a general-purpose WS server.

A JSON-path feedback on `intended == "on"` keeps working under any state table. Anything keyed
to specific row names does not.

### Push is an optimisation, never a delivery guarantee

The server emits on change and does not error if you miss it. A client that misses a push gets
the change on its **next poll**. **Do not build correctness on the stream.** If your client has
no poll loop behind the socket, it is wrong.

---

## 7. Appearance: `GET /config/states`

The state table is self-describing. **Ask what states exist rather than compiling them in.**

```bash
curl -sS http://127.0.0.1:8484/config/states -H 'Authorization: Bearer <passphrase>'
```

```json
{"version":11,"updatedAt":"2026-08-28T00:37:22.080Z","states":[
  {"id":"available","label":"AVAILABLE","color":"#ffffff","bgcolor":"#0b6e2e",
   "description":"","busy":false,"order":0},
  {"id":"on-air","label":"ON AIR","color":"#ffffff","bgcolor":"#c1121f",
   "description":"","busy":true,"order":1}
]}
```

| Field | Notes |
|---|---|
| `id` | Immutable. **The only addressable handle.** `^[a-z0-9][a-z0-9-]{0,31}$`. |
| `label` | The phrase you draw. Freely edited by the owner, never a key. |
| `color`, `bgcolor` | `#rrggbb`, lowercase. |
| `busy` | Carries the safety model. |
| `order` | A display sort hint. **Never an address.** Do not index by it, do not compare rungs. |
| `description` | A comment for humans. Never load-bearing. |

**Fetch it on a slow schedule** - it changes a few times a year, while state changes many times
an hour. The response carries an `ETag` of the version; send `If-None-Match` and the steady
state costs a header instead of a table. The ESP32 polls this every 300 s.

```
GET /config/states  ->  200, ETag: "11"
GET /config/states  with  If-None-Match: "11"  ->  304
```

Refetch when `tableVersion` in a status payload no longer matches the `version` you hold.

**`unknown` is reserved.** It cannot be deleted, its `busy` is forced `true`, and every
dangling reference resolves to it. It carries no rank - nothing is ordered against it. If the
row you were showing is deleted, the state resolves to `unknown` and `stateResolvedFrom` names
what died.

### The `/public/*` exception

`GET /public/status` and `GET /public/events` are **unauthenticated** and serve the current row
**already resolved for rendering** - `label`, `color` and `bgcolor` included.

```json
{"state":"available","label":"AVAILABLE","color":"#ffffff","bgcolor":"#0b6e2e",
 "busy":false,"message":null,"ageSeconds":53529,"tableVersion":11}
```

They exist for `/display` and the landing page, which hold no table and should not fetch one.
**They are a rendering view, not the state contract.** No `hold`, no `source`, no `confirmed`,
and free to change shape to suit those two pages.

**If your client holds a table, do not read these.** Take the key from the gated routes and the
look from `GET /config/states`.

---

## 8. Messages

```bash
curl -sS -X PUT http://127.0.0.1:8484/message -H 'Authorization: Bearer <passphrase>' \
  -H 'content-type: application/json' -d '{"text":"BE QUIET"}'
curl -sS -X DELETE http://127.0.0.1:8484/message -H 'Authorization: Bearer <passphrase>'
```

Non-empty, max 200 characters. `DELETE` is idempotent. Both return the status body. The message
persists across restarts and state writes never touch it.

**A message may never replace or obscure the state word or the state colour on any renderer.**
It is always subordinate.

---

## 9. Errors, and what to do about each

Shape is `{"error": "<message>"}`, plus context fields where they help.

| Status | Cause | What your client should do |
|---|---|---|
| `400` | Malformed JSON, missing `state`, unknown state id, bad `source` shape | **Fix the call.** Never retry unchanged. An unknown id returns `validStates` - use it. |
| `401` | Passphrase or session absent or wrong | Surface it to a human. Do not hammer. Check whether a rotation is in its 60-minute grace. |
| `403` | An `auto:` source tried to set or clear a hold; `/admin/restart` with no token configured | **A bug in your client.** Fix the `source`. The state was left untouched. |
| `404` | Unknown path | Fix the URL. |
| `405` | Right path, wrong method | Fix the method. `PUT /state`, `POST /state/{id}`. |
| `409` | The pin rule refused an automated write; a stale config `version`; a failed rebind | **Not an error.** Read the status body attached to it. Do not retry. |
| `501` | A route whose backing store is not wired up | Configuration problem on the server, not yours. |
| `507` | A config save could not reach disk | The running config is untouched. Report it. |
| `500` | Internal, including a request body over 16 KB | Retry once with backoff; if it repeats, report it. |

An unknown state id is a `400` that **lists the valid ids** and never falls back to a default.
A typo that resolved to something would eventually resolve to something calm, and that is the
invariant violation this whole system exists to prevent.

---

## 10. Two worked examples

### A minimal automated writer

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="${ONAIR_BASE:-http://127.0.0.1:8484}"
PASS="${ONAIR_PASSPHRASE:?set ONAIR_PASSPHRASE}"

write() {  # write <state-id>
  local code body
  body=$(curl -sS -w '\n%{http_code}' -X PUT "$BASE/state" \
    -H "Authorization: Bearer $PASS" -H 'content-type: application/json' \
    -d "{\"state\":\"$1\",\"source\":\"auto:mydetector\"}")
  code=${body##*$'\n'}
  case "$code" in
    200) return 0 ;;
    409) echo "held; the pin refused this write - not retrying" >&2; return 0 ;;
    400|403) echo "client bug: ${body%$'\n'*}" >&2; return 2 ;;
    *)   echo "transient: $code" >&2; return 1 ;;
  esac
}

write on-air || true
```

Note what it does **not** do: no heartbeat, no retry on `409`, no retry on `400`.

### A minimal renderer

```js
const BASE = 'http://onair.local:8484', PASS = '...';
const POLL_MS = 1000, LOST_MS = 60_000, NODATA_MS = 30 * 60_000;

let table = new Map(), tableVersion = -1, lastOk = Date.now(), last = null;

async function get(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${PASS}` } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function refreshTable() {
  const t = await get('/config/states');
  table = new Map(t.states.map((s) => [s.id, s]));
  tableVersion = t.version;
}

async function tick() {
  try {
    const s = await get('/status');
    lastOk = Date.now();
    last = s;
    if (s.tableVersion !== tableVersion) await refreshTable();
  } catch {
    // Deliberately swallowed: the age of lastOk is the only thing that decides what we draw.
  }
  const age = Date.now() - lastOk;
  if (last === null || age > NODATA_MS) return drawNoData();          // condition 3
  // A missing row resolves to `unknown`, never to a default that might be calm.
  drawState(table.get(last.state) ?? table.get('unknown'), age > LOST_MS);  // 1 and 2
}

await refreshTable();
setInterval(tick, POLL_MS);
```

---

## 11. Checklist before you ship a client

- [ ] Automated writer? You use `PUT /state` with an `auto:` prefixed `source`.
- [ ] You treat `409` as the system working, not as a retry signal.
- [ ] You never retry a `400` or a `403` unchanged.
- [ ] You confirm your own writes rather than assuming they landed, and you stop once
      confirmed rather than heartbeating.
- [ ] You fetch the table from `GET /config/states` instead of hardcoding state ids, labels or
      colours, and you refetch when `tableVersion` moves.
- [ ] You address rows by `id` and never by `order`.
- [ ] Renderer? You implement all three conditions, including the middle one.
- [ ] Every unknown, malformed or missing value in your client renders **not calm**.
- [ ] You poll. Any stream you use is an optimisation on top of that poll.
- [ ] Your passphrase travels in a header on everything except `EventSource` and the WS upgrade.
