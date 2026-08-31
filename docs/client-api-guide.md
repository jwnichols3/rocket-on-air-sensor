# Client guide: constructing on-air API calls

How to call the on-air service from your own code. A normative contract sits behind this page
(`docs/api-contract.md` in the repository). **Where the two disagree, the contract wins.** If
anything here does not match what the server actually does, trust the server and report the
page.

Everything below was checked against a running service on 2026-08-28, and revised on 2026-08-29
when holds were removed - those removals are marked where they appear.

---

## 1. Work out what kind of client you are

Your answer picks your routes, your credential and your `source` for the rest of the guide.

| You are | Example | You call | Your `source` |
|---|---|---|---|
| **An automated writer** | a call detector, a calendar sync | `PUT /state` | `auto:<yourname>` |
| **A human-triggered writer** | a shell alias, a phone Shortcut, a Stream Deck button | `POST /state/{id}`, `/on`, `/off` | optional |
| **A renderer** | a panel, a menu bar item, a wall display | `GET /status` + `GET /config/states` | none, you never write |
| **A dumb kiosk** | a browser pointed at a screen | `GET /public/status`, or just `GET /display` | none |

Two of these choices are load-bearing. An automated writer that uses a human route loses its
own name from `source`, which is the only trace it leaves in this system (section 4.1), and a
renderer that reads `/public/status` gets a view that is free to change shape underneath it
(section 7).

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

Both credentials are waived when **every one** of these holds:

- the connection is from loopback
- `Host` names a loopback name on our port
- `Origin` is absent or is exactly ours
- `Sec-Fetch-Site` is absent, `same-origin`, or `none`

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

`auto:` and `human:` carry no different authority. Every accepted write is applied whichever
kind sent it, and no write can block a later one (section 4.4). **The prefix is provenance** -
it is how `GET /status` and every renderer can say who put the light where it is.

The `source` requirement is split by route so neither audience pays for the other's
convenience:

| Route | `source` | If missing or unprefixed |
|---|---|---|
| `PUT /state` | **required, prefixed** | `400` |
| `POST /state/{id}`, `/on`, `/off` | optional | defaults to `human:anonymous` |

An automated client that forgets the prefix on `PUT /state` gets a `400`, which is loud. The
same client pointed at `POST /state/on-air` gets `human:anonymous` and quietly loses its own
name from the one field that would have identified it. **If you are automated, use
`PUT /state`.**

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

Any other top-level key is **accepted and ignored**, including the retired `hold` (removed
2026-08-29). A retired field never vetoes a state assertion: refusing the body would discard
the write and leave the light saying the wrong thing, which is the failure this service exists
to prevent. If you still send `hold`, delete it - it does nothing, and the response will not
carry it back.

Idempotent: repeating the same body refreshes `updatedAt` and nothing else. The response is the
full status object, the same shape as `GET /status`, taken after the write and after the light
attempt.

### 4.3 The convenience routes

For a shell alias, a phone Shortcut, or a Companion button - anywhere a human is behind the
call and a JSON body is a nuisance.

```bash
curl -sS -X POST 'http://127.0.0.1:8484/state/on-air?source=human:shortcut'
curl -sS -X POST 'http://127.0.0.1:8484/on'
curl -sS -X POST 'http://127.0.0.1:8484/off'
```

`/on` and `/off` resolve through configuration rather than naming a row. Out of the box `/on`
is `on-air` and `/off` is `available`, but the owner can point them anywhere. **If the shortcut
is unset you get a `409`, not a guess** - falling back to the first row would mean an unset
`/off` turning the light red.

Query parameter: `?source=`. The retired `?hold=1` / `?hold=0` (removed 2026-08-29) is
**accepted and ignored** rather than rejected, for the reason given in 4.2: a shell alias or
phone Shortcut that still carries it must still be able to turn the light off.

### 4.4 No write outranks another

> **Every write with a valid body is applied. No `source` outranks another, and no earlier
> write can block a later one.**

There is no hold, no pin and no precedence, and the server keeps no memory of who wrote last
beyond the `source` string itself. A person overriding the light mid-meeting is an ordinary
state write; the detector's next write replaces it. That is the guarantee, not a side effect -
the light ends up wherever the most recent writer put it.

What it means for you as an automated writer: your write lands, every time, and nothing on the
server will hold the light away from what you last asserted. Making it stick is still your job,
because the *light* can fail to follow even when the server accepted you - see 4.5.

### 4.5 Confirm your own write

**The server latches and never decays.** There is no TTL, no heartbeat convention, and no
expectation that you re-send state on a timer. The flip side is that **making a write stick is
your job**: write, read back, retry until confirmed or until you run out of time. A lost write
is caught by the writer, never inferred by the server from silence.

Two different fields, two different questions:

- `state` - did the server accept my write? Present in the write's own response.
- `confirmed` - did the **light** acknowledge it, read back from the device? Never guessed.
  `confirmed` is always a row id. When the device is unreachable, is not repainting, or has its
  glass deliberately dark, it reads `unknown` - which is **also a real row a light can
  legitimately be displaying**, so this one field cannot tell the two apart. Read
  `confirmed: "unknown"` as *not confirmed*, never as *the light is showing the unknown row*.
- `confirmedReason` - **why** `confirmed` is unknown, when the server knows: `asleep`,
  `not-repainting` or `unreachable`. Absent whenever the server cannot name a reason.

  **`asleep` is not a fault.** The panel can be scheduled to go black overnight, and while it
  is dark there are simply no pixels to confirm. A client that escalates on `asleep` alarms
  for eight hours every night, which teaches its operator to ignore it. Escalate on the other
  two. And treat an **absent** reason as unexplained rather than as fine - reading absence as
  reassurance is a false OK, which fails the same way a false OFF does.

## Darkening the panel

`POST /panel/sleep` and `POST /panel/wake` turn the panel's glass off and on. Both answer
`200 {"ok":true,"delivered":<bool>,"asked":"sleep"|"wake"}`.

`delivered` says the command reached the device - **not** that the glass went dark. Read
`confirmedReason` on the next `GET /status` for that; a dark panel reports `asleep`.

Three things end a sleep, and the third will surprise you if you have not been told:
`POST /panel/wake`, the panel's own scheduled wake time, and **any busy row**. The panel
refuses to darken while the current row is busy, however it was asked - so a sleep pressed
during a call does nothing, and a call starting while it is asleep lights it. `delivered:true`
with the panel still lit is correct, not an error.

`POST /panel/toggle` is the one-button form: it reads the glass and sends the opposite. It
answers with `asked` set to whichever command it chose and `wasDark` set to the reading it
took. It keeps no memory between presses, so a sleep refused by a busy row leaves the next
press still meaning sleep - and a panel already dark on its schedule wakes, which is what
pressing a button at a dark panel means. If it cannot read the glass it assumes lit and
sends sleep.

The nightly schedule itself - when it sleeps, when it wakes, how dark - is configured on the
panel and is not on this API.

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
Do not treat `confirmed` as proof that a human can see anything.

---

## 5. Reading state

### `GET /status`

```bash
curl -sS http://127.0.0.1:8484/status -H 'Authorization: Bearer <passphrase>'
```

```json
{"state":"available","confirmed":"available","source":"human:admin",
 "updatedAt":"2026-08-28T00:37:22.080Z","message":null,"busy":false,
 "intended":"off","ageSeconds":53529,"tableVersion":11}
```

| Field | Use it for |
|---|---|
| `state` | The row id in force. A reference to a row, never a copy of one. |
| `busy` | Does this state mean the camera may be live. Semantics, not presentation. |
| `intended` | `busy ? "on" : "off"`. Derived and read-only. Key your logic here if you want to survive a row invented next year without a code change. |
| `confirmed` | The row the light acknowledged. See 4.5. |
| `source` | Who wrote it. Provenance only - see 4.1. |
| `updatedAt`, `ageSeconds` | When the state was last written, and how long ago. The server never judges whether that is too old. You do. |
| `tableVersion` | Bumped on every config save. A change means refetch the table. |
| `stateResolvedFrom` | Present only when the live row was deleted and the state fell back to `unknown`. Names the dead id. |
| `message` | Optional display text. Independent of state; a state write never touches it. |

**`label`, `color` and `bgcolor` are deliberately not here.** A state change says which row is
current; how that row looks comes from `GET /config/states` on your own slow schedule. See
section 7.

**The server never tells you whether the state is fresh, and it never will.** It reports when
the state was written and refuses to draw a conclusion from it. There is no `stale` flag to key
on, and asking for one is asking the server to make your display's judgement for you. Freshness
is a judgement about *your* connection, on *your* clock, and it is yours to make.

### The client contract: three conditions, not two

Every renderer polls and decides for itself when it has lost the server.

1. **Reachable** - draw the current state, plainly.
2. **Unreachable, inside the grace window** - **keep drawing the last known state** with a
   visible connection-lost mark. Say what you last knew *and* that you are no longer being
   refreshed. Do not go blank, and do not go **calm** - calm here means any rendering a
   passer-by reads as "not in a call": green, grey, blank or dark.
3. **Unreachable past the timeout** - stop asserting a state at all. Show whatever your
   display's equivalent of "no data" is. Never the last state, and never anything calm.

| Setting | Default | Meaning |
|---|---|---|
| poll interval | 1000 ms (250..60000) | how often you ask |
| connection lost after | 1 minute | mark the display unrefreshed; state unchanged |
| no data after | 30 minutes | give up on the state entirely |

Both thresholds run from the last successful contact, as **two independent numbers on one
clock** - the second does not start when the first expires. They are far apart on purpose: a
meeting runs about half an hour, so the state has to outlive a server outage or the panel goes
dark mid-call, while the honesty about not being refreshed costs nothing and should arrive
immediately.

Make all three configuration, not constants.

### Fail closed

> **Absence of information never renders calm.**

Absent, malformed or unparseable input means **withhold calm**, never **assume calm**. This is
not a precaution: a client that trusted a freshness signal instead of its own clock once drew a
calm menu bar on 27-hour-old evidence.

The failure this system exists to prevent is a **false OFF** - the light saying "not in a call"
while the camera is live. When you are unsure, err loud.

**What this does not cover.** A dead *writer*. If your detector dies while the state reads
`available`, the server is healthy, every poll succeeds and every panel paints confident green.
If you are writing a detector, this is your problem to own.

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

Key your logic on `intended` rather than on row ids and it survives any state table the owner
builds; anything keyed to specific row names does not. In Bitfocus Companion specifically, that
means a JSON-path feedback on `intended == "on"`.

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
| `order` | A display sort hint, and nothing more. **Never an address.** Sort by it if you like; do not index by it, and never read a higher `order` as a more serious state. |
| `description` | A comment for humans. Never load-bearing. |

**Fetch it on a slow schedule** - it changes a few times a year, while state changes many times
an hour. The response carries an `ETag` of the version; send `If-None-Match` and the steady
state costs a header instead of a table. Every 300 s is a sensible interval.

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
**They are a rendering view, not the state contract.** No `source`, no `confirmed`, and free to
change shape to suit those two pages.

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

---

## 9. Errors, and what to do about each

Shape is `{"error": "<message>"}`, plus context fields where they help.

| Status | Cause | What your client should do |
|---|---|---|
| `400` | Malformed JSON, a body over 16 KB, missing `state`, unknown state id, bad `source` shape | **Fix the call.** Never retry unchanged. An unknown id returns `validStates` - use it. |
| `401` | Passphrase or session absent or wrong | Surface it to a human. Do not hammer. Check whether a rotation is in its 60-minute grace. |
| `403` | `POST /admin/restart` **always**, in the shipped service - the route wants a server-side token the service never wires up, and setting the passphrase does not supply it. Or `POST /admin/factory-reset` without the admin password | An authority or server-configuration problem, never a transient one. Surface it; never retry unchanged. **No state-write route returns `403`.** |
| `404` | Unknown path | Fix the URL. |
| `405` | Right path, wrong method | Fix the method. `PUT /state`, `POST /state/{id}`. |
| `409` | `/on` or `/off` with no shortcut row configured | The body is `{"error":...}` and nothing else. Only a person can fix it. Surface it; do not retry. |
| `409` | A config save carrying a stale `version` | Refetch, re-apply your change, submit once more. |
| `409` | A config save that failed to write for a reason other than a full disk | The running config is untouched. Not yours to fix; report it. |
| `409` | A port or bind change whose rebind failed and was rolled back | The service is still on the previous binding and still answering. Surface it; the new binding is what needs fixing. |
| `500` | An internal server fault - in practice a write whose persist to the state file failed | Retry once with backoff; if it repeats, report it. Read `GET /status` first: the in-memory state has already moved. |
| `501` | A route whose backing store is not wired up | Configuration problem on the server, not yours. |
| `507` | A config save could not reach disk | The running config is untouched. Report it. |

**No `409` carries a status body**, and no state-write route can produce one. Every `409` is
`{"error":...}` (the three config-save ones add the live `config`), so a client that reads
`.state` off a `409` gets `undefined`, always. A `409` now means a person has to change
something - an unset shortcut row, a config document someone else moved, a config that would
not write, or a binding that would not open. Surface it.

**This inverted on 2026-08-29.** Until then a `409` could also mean an automated write had been
refused by the pin rule, it carried the full status merged in, and it was documented here as
the system working rather than as a failure. The pin is gone; a client still treating `409` as
success will silently swallow a real misconfiguration.

A body over 16 KB is a `400`, not a `413` and not a `500`: the read fails inside the same
parse that would have rejected bad JSON, so it arrives as
`malformed JSON body: request body too large`. There is no size at which retrying helps.

An unknown state id is a `400` that **lists the valid ids** and never falls back to a default.
A typo that resolved to a row would resolve to whatever that row means, and the whole point of
this system is that nothing gets to guess.

---

## 10. Two worked examples

### A minimal automated writer

It writes, it confirms, and it retries only what retrying can fix.

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="${ONAIR_BASE:-http://127.0.0.1:8484}"
PASS="${ONAIR_PASSPHRASE:?set ONAIR_PASSPHRASE}"
AUTH=(-H "Authorization: Bearer $PASS")

# 0 accepted | 1 transient, retry | 2 never retry: our bug, or something a person must fix
write() {
  local body code rc=0
  body=$(curl -sS -m 5 -w '\n%{http_code}' -X PUT "$BASE/state" "${AUTH[@]}" \
    -H 'content-type: application/json' \
    -d "{\"state\":\"$1\",\"source\":\"auto:mydetector\"}") || rc=$?
  [ "$rc" = 0 ] || { echo "curl failed ($rc)" >&2; return 1; }
  code=${body##*$'\n'}
  case "$code" in
    200)         return 0 ;;
    409)         echo "a person must fix this: ${body%$'\n'*}" >&2; return 2 ;;
    400|401|403) echo "not retryable: ${body%$'\n'*}" >&2; return 2 ;;
    *)           echo "transient: HTTP $code" >&2; return 1 ;;
  esac
}

confirmed() {
  curl -sS -m 5 "$BASE/status" "${AUTH[@]}" \
    | sed -n 's/.*"confirmed":"\([^"]*\)".*/\1/p'
}

# The write is not finished until the LIGHT agrees. Nothing here runs on a timer
# afterwards: once confirmed, stop.
set_state() {
  local attempt rc i
  for attempt in 1 2 3; do
    rc=0; write "$1" || rc=$?
    case $rc in
      2) return 2 ;;                              # identical retry fails identically
      1) sleep $((attempt * 2)); continue ;;
    esac
    for ((i = 0; i < 20; i++)); do
      if [ "$(confirmed)" = "$1" ]; then return 0; fi
      sleep 0.5
    done
    echo "wrote $1, but the light never confirmed it" >&2
  done
  return 1
}

set_state on-air
```

`400`, `401` and `403` are never retried: the next identical request fails identically. A
`409` is not retried either, and it **is** a failure - something a person configured is wrong,
so it is surfaced rather than swallowed. `PUT /state` cannot return `409` at all, but the arm
costs one line and classifying an unexpected code as transient would retry it forever.

### A minimal renderer

```js
// Configuration, not constants: all three thresholds have to be settable.
const cfg = {
  base: 'http://onair.local:8484', pass: '...',
  pollMs: 1000, lostMs: 60_000, noDataMs: 30 * 60_000,
};

let table = new Map(), tableVersion = -1, lastOk = 0, last = null, authError = null;

async function get(path) {
  const r = await fetch(cfg.base + path, { headers: { Authorization: `Bearer ${cfg.pass}` } });
  if (!r.ok) throw Object.assign(new Error(`${path} -> ${r.status}`), { status: r.status });
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
    // Contact is what resets the clock, and /status alone is contact.
    lastOk = Date.now(); last = s; authError = null;
    if (s.tableVersion !== tableVersion) await refreshTable();
  } catch (e) {
    // A wrong passphrase is not a network problem and waiting will never fix it. Without
    // this branch it reads as "connected" for a minute and "connection lost" for 29 more,
    // and never once mentions the credential.
    if (e.status === 401) authError = 'check the passphrase';
  }
  const age = Date.now() - lastOk;
  // No table means no row can be resolved, so this is NO DATA - never a default that
  // might be calm.
  if (last === null || table.size === 0 || age > cfg.noDataMs) return drawNoData(authError);
  drawState(table.get(last.state) ?? table.get('unknown'), age > cfg.lostMs, authError);
}

// Boots even when the server is ALREADY down. A top-level `await refreshTable()` that
// throws takes the whole script with it - no interval, no first paint, a permanently
// blank display - which is exactly the condition the display exists to report.
refreshTable().catch(() => {});
setInterval(tick, cfg.pollMs);
tick();
```

---

## 11. Checklist before you ship a client

- [ ] Automated writer? You use `PUT /state` with an `auto:` prefixed `source`.
- [ ] You surface a `409` to a person rather than retrying it - it means something configured
      is wrong, not something transient.
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
