# Bitfocus Companion setup

Two ways to drive the on-air light from a Stream Deck. **Use the module.** The
generic-connection path is kept below as a fallback, corrected - the version of it that
shipped before #44 described wiring that cannot work.

---

# 1. The module (recommended)

`companion-module/` in this repo. Sideloaded rather than installed from the store: it is
specific to this system and upstream submission is deliberately out of scope.

**What it gives you that the generic path does not:** one preset per state, generated from
the server's own table. Drag them onto a Stream Deck and they already carry the right
caption and the right colours, because both come from `GET /config/states`. Add a state on
the server and its button appears - no Companion restart, no re-wiring.

## Build and package

```sh
npm run package --workspace companion-module
```

That bundles `companion-module/dist/` and writes the sideload tarball to
`companion-module/pkg/rocket-onair-<version>.tgz`. **Use this rather than running `tar`
yourself.** Two details break the import, neither of them looks like a packaging problem, and
both were measured rather than guessed - the script sets them and then checks the tarball to
prove it:

- **`COPYFILE_DISABLE=1` is required on macOS.** Without it `tar` writes AppleDouble
  `._*` entries, and the first of them is `._.` - a file with ONE path component. Companion
  extracts with `strip: 1` and no ignore filter, so that name strips to nothing and the
  install dies with `EISDIR` pointing at the module directory.
- **The tarball needs a real top-level directory** (`rocket-onair`), not `.`, and it must
  contain the directory entries. Companion finds the manifest by taking the first
  DIRECTORY entry as the prefix to trim; with no directory entries it never finds
  `companion/manifest.json` and reports "Doesn't look like a valid module".

## Install it in Companion

**Modules -> Import custom module**, and choose the `.tgz`.

Importing custom modules is only permitted from the local machine, so do it from a browser
on the Companion host, or over an SSH tunnel:

```sh
ssh -f -N -L 18000:127.0.0.1:8000 john@<companion-host>
```

Then open `http://127.0.0.1:18000` and import there.

**Upgrading an existing install** is the same import: Companion replaces the module in place
and restarts the connection. Buttons already on a surface keep working - preset ids are keyed
on the immutable row `id` (D-31), so nothing on the deck is re-bound. What you gain after an
upgrade are the new actions and feedbacks; **buttons placed before the upgrade do not
retroactively gain the new connection marks**, because a placed button is a one-time copy of
the preset. Re-drag a state preset if you want the marks on an old button.

## Configure the connection

Add a connection of type **rocket-onair** and set:

| Field | Default | Value |
|---|---|---|
| Host | `localhost` | the on-air server, e.g. `rocket-studio-m1.local` |
| Port | `8484` | |
| Passphrase | - | from `~/.onair/config.json`, under `auth.passphrase` |
| Say "not refreshing" after | `60000` ms | see **Losing the server** |
| Give the state up after | `1800000` ms | see **Losing the server** |
| Poll `GET /status` every | `1000` ms | the contract's cadence (range 250..60000) |
| Reconnect a silent stream after | `45000` ms | three of the server's 15 s keep-alives |
| Give a write up after | `20000` ms | see **Slow writes are not failed writes** |

**The passphrase is required, not optional.** This module holds a state table, and
`docs/api-contract.md` is explicit that a table-holder reads the gated endpoints rather than
`/public/*` - the public pair is a *rendering* view for two dumb browser pages, free to
change shape, with no `confirmed` and no `source`. Companion normally runs on a
different host from the server anyway, where D-24's loopback waiver does not apply and the
passphrase was already mandatory.

The easiest place to read the passphrase is the admin console at `http://<host>:8484/`.

## What you get

**Presets**, under **States** - one per row, captioned with the row's `label` and coloured
with its `color` on `bgcolor`, verbatim. Each one ships with the connection marks already
attached, so a deck straight out of the box meets the client contract without hand-wiring.

Under **Utility**: **Light health** and **Refresh table**.

**Actions**

| Action | What it does |
|---|---|
| Set state | `POST /state/{id}?source=companion`. The dropdown is the live table; a custom value is allowed |
| Refresh the state table now | re-reads `GET /config/states` |

**Feedbacks**

| Feedback | True when | Default look |
|---|---|---|
| State is | the light is showing that state | white on red |
| Busy | the current row is busy. The server's own flag, not a colour test - THE BUSY RULE (D-32) is what it means | white on red |
| Not refreshing | the server has not answered for longer than the configured window. The state shown is the last one it reported | **black on amber** |
| No data | the server has been silent long enough that the module has given the state up | **the reserved row's own colours**, as you set them |
| Light not confirming | `confirmed` reads `unknown`: the panel is unreachable or frozen. The server admitting ignorance, not a claim the light is wrong | **white on navy** |
| Light disagrees | the light acknowledges a row the server did not ask for | **black on white** |

The last four are the "something is off" family and they have **four deliberately distinct
looks**. An operator who cannot tell them apart at a glance has four feedbacks that mean one
thing - and they have four different fixes: wait, restart the server, check the panel's power,
check who else is writing to the panel.

**Variables**: `state`, `label`, `busy`, `confirmed`, `source`, `connection`,
`seconds_since_contact`, `age_seconds`, `table_version`.

## Slow writes are not failed writes

A state write drives the physical light before it answers. Issue #68 measured, against a panel
that was powered off, `POST /state/{id}` blocking for **6.4 s** and `PUT /state` for
**13.2 s** - and **both writes succeeded**. The module's old 5 s ceiling turned those into a
red instance and a "set state failed" log while the state was live on the server.

The default is now **20 s**, which clears the measured worst case with margin, and it is a
config field for anyone on a slower link. A write that runs out of time is reported as an
**unknown outcome**, not a failure:

```
set state "on-air": no answer within 20000 ms. The write may still have succeeded - the
next poll will say. Not retrying: the server latches.
```

It does not retry. The write may well have landed - both of #68's did - and a second write
against a latching server buys nothing. Section 7 of the contract: clients that care check
`confirmed`, not the status code.

## ⚠️ BREAKING CHANGE (0.3.0): the pin is gone

**If any of your buttons use the `Pin the current state` or `Release the hold` actions, the
`A hold is in force` or `Held to this state` feedbacks, or the `$(hold)` / `$(hold_label)`
variables, they will stop working and you have to re-bind them by hand.** Regenerating the
presets does not touch buttons already on a deck: PIN and UNPIN are gone from the Utility
category, but the copies you placed are still there, and a button whose action no longer
exists does nothing when pressed.

A **hold** pinned the state and refused writes that disagreed with it. It is retired
everywhere - module, server and contract (D-126) - and the rule that replaces it is **last
write wins**: every write is applied, no `source` outranks another, and no earlier write can
block a later one. That is the workflow the pin was in the way of - override the light by hand
mid-meeting, and the detector's next write puts it back when the meeting ends.

The **Hold** option on `Set state` goes with it. A button placed before the upgrade still
carries a `Hold` value in its saved options; the module ignores it and sends an ordinary state
write, so those buttons keep working and need no attention.

## ⚠️ BREAKING CHANGE: `stale` is gone

**If any of your buttons use the `Stale` feedback or the `$(stale)` variable, they will stop
working and you have to re-bind them.** There is no alias and that is deliberate: a variable
that silently resolves to nothing on a stream deck is worse than one that is loudly absent,
and an alias sitting beside the real thing is a decoy the next layout keys on.

`stale` meant *"the server has no fresh evidence for this state"*. **The server no longer makes
that judgement** (D-91). It latches state and never decays it, so a state nobody has rewritten
for three hours is simply the state - and the question an operator actually needs answered is
not *how old is this write* but *am I still hearing from the server at all*.

| Was | Now |
|---|---|
| `Stale` feedback | `Not refreshing` feedback, or `No data` for the harder case |
| `$(stale)` = `yes`/`no` | `$(connection)` = `ok` / `not refreshing` / `no data` |
| - | `$(seconds_since_contact)`, if you want to show the number |

`$(age_seconds)` still exists and still means seconds since the last WRITE. It is **provenance
only** now: nothing in the module reads it to decide anything, and neither should a button that
is trying to say whether the reading can be trusted. Use `$(connection)` for that.

## Losing the server

The module judges its own connection, on its own clock, with two thresholds in the instance
config. Both are measured from **the last time the server answered**, and they are independent -
the second is not counted from the first.

| Setting | Default | What happens |
|---|---|---|
| Say "not refreshing" after | 60000 ms | The last known state is still shown. `Not refreshing` goes true. Companion's own connection light goes **amber**. |
| Give the state up after | 1800000 ms | `state` becomes the reserved row, `No data` goes true, and the connection light goes **red**. |

Thirty minutes is deliberate: a meeting runs about that long, so the state has to survive a
server restart without the buttons going dark mid-call. One minute is also deliberate - the
honesty costs nothing and should arrive immediately.

**When the module gives up, `busy` reads `yes`, not `no`.** The reserved `unknown` row carries
`busy: true` (D-34) because every degenerate path in this system lands on a conspicuous state
rather than a calm one. A stream deck going dark because the server died would be a false OFF
on a physical control, which is the exact failure this product exists to prevent.

**The reserved row's label and colours are yours.** Relabel `unknown` to `SERVER GONE` in the
admin console and the Stream Deck says SERVER GONE, in the colours you picked. Nothing about
that row's appearance is hardcoded in the module any more (#75).

## Poll, stream and recovery

**The poll is the correctness path; the stream is the fast path.** The module polls
`GET /status` on the contract's cadence and holds an SSE connection to `GET /events` at the
same time. The stream is why a Stream Deck reacts instantly; the poll is why the deck is
right.

Three things follow, and all three were missing before #72:

- **A cold read on startup.** The deck shows the state as soon as the connection comes up,
  rather than waiting for the server's next state change - which on a quiet afternoon could
  be hours.
- **A silent stream gets reconnected.** The server sends a keep-alive every 15 s "so a client
  can detect a dead stream". A socket that is open and delivering nothing throws no error and
  used to freeze the module until the OS gave up on it. The watchdog aborts and reconnects
  after three missed keep-alives.
- **Recovery needs no operator.** When the server comes back the poll finds it, the marks
  clear, and the connection light goes green again. Nobody has to reload the instance.

## Things worth knowing

- **Presets regenerate when the table changes.** The module watches `tableVersion` on the
  status stream and on every poll; when it moves it re-reads the table and re-publishes
  definitions. No restart.
- **A placed button is a one-time copy in Companion 5.0.x.** It keeps the preset id it was
  created with, which is why preset ids are keyed on the immutable row id (D-31) and never on
  an index (D-34). A button survives rows being renamed or reordered.
- **A button bound to a row the server no longer has says so.** The server answers `400` with
  the list of ids that would have worked, and the module logs it:
  `set state "deleted-row" failed: unknown state 'deleted-row' - valid states: available, on-air, ...`
- **`apiVersion` is declared by the module, not derived from `@companion-module/base`.** The
  manifest declares `1.14.0`, which this Companion implements. Do not "fix" it to the base
  package's version - `2.1.3` asks for an API newer than Companion 5.0.3 has, and the module
  will not load.
- **There are no panel night/wake buttons.** Tickets #85 and #86 would add them, and #85 is
  explicitly not to be built without Rocket's yes - the module never addresses the panel
  directly, so it needs a server relay first.

---

# 2. Fallback: generic connections, no module

Kept because it needs nothing built. **The pre-#44 version of this section was wrong in two
ways**; both are corrected here.

Add **Generic HTTP** (actions) and **Generic WebSocket** (status).

## Actions: `generic-http`

Base URL `http://<host>:8484`. Two actions:

- **On**: `POST` `/on?source=companion`
- **Off**: `POST` `/off?source=companion`

Add a header to each: `{"Authorization": "Bearer <passphrase>"}`. Note the option id is
`contenttype` in lower case, and the header field takes a JSON object.

## Status: `generic-websocket`

Target URL: `ws://<host>:8484/events/ws?passphrase=<passphrase>`

The passphrase goes in the query string because a WebSocket upgrade cannot carry a header.

### CORRECTION 1: the module publishes no payload variables on its own

`generic-websocket` publishes exactly one variable by itself: `lastDataReceived`. **Payload
variables are created by a feedback, and you name them.**

Add the feedback **"Update variable with value from WebSocket message"** with:

| Option | Value |
|---|---|
| JSON Path | `intended` |
| Variable | `intended` |

`updateVariables()` creates one variable per subscribed feedback, named exactly what you put
in **Variable**. No feedback, no variable.

### CORRECTION 2: the variable prefix is the CONNECTION LABEL

Not the module id. If you label the connection `onair`, the expression is `$(onair:intended)`
- not `$(genericwebsocket:intended)`. The earlier version of this doc used the module id
throughout, including inside its own warning box about a renamed field, so the replacement it
offered was also wrong.

### Colour a button from it

Add the internal feedback **Variable: Check value**, with:

| Option | Value |
|---|---|
| Variable | `onair:intended` - a **bare name**, not `$(...)`; it is wrapped internally |
| Operation | `eq` |
| Value | `on` |

## Why the module is better

The fallback hard-codes two states. It cannot show you `interruptible` or `recording`, it
does not know a row's colours, and every state you add on the server needs hand-wiring here.

It is also **not a renderer that meets the client contract**, and cannot be made into one. It
holds no clock of its own, so it cannot mark the display as no longer refreshing at one minute
and give the state up at thirty; it reads `intended` off a socket and shows whatever arrived
last, forever. A `generic-websocket` button on a dead server is calm and confident, which is
the exact failure mode section 3 exists to prevent. Use it to get going, not to go on air.
