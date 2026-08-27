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

## Build and install

```sh
npm run build --workspace companion-module
```

That produces `companion-module/dist/`, which is the module: one bundled `main.js`, a
`package.json`, and `companion/manifest.json`.

Package it and install it. **Both of these details matter and neither is obvious:**

```sh
cd companion-module
rm -rf /tmp/onair-stage && mkdir -p /tmp/onair-stage
cp -R dist /tmp/onair-stage/rocket-onair
COPYFILE_DISABLE=1 tar -czf /tmp/rocket-onair.tgz -C /tmp/onair-stage rocket-onair
```

- **`COPYFILE_DISABLE=1` is required on macOS.** Without it `tar` writes AppleDouble
  `._*` entries, and the first of them is `._.` - a file with ONE path component. Companion
  extracts with `strip: 1` and no ignore filter, so that name strips to nothing and the
  install dies with `EISDIR` pointing at the module directory. Measured, not guessed.
- **The tarball needs a real top-level directory** (`rocket-onair`), not `.`, and it must
  contain the directory entries. Companion finds the manifest by taking the first
  DIRECTORY entry as the prefix to trim; with no directory entries it never finds
  `companion/manifest.json` and reports "Doesn't look like a valid module".

Then in Companion: **Modules -> Import custom module**, and choose the `.tgz`.

Importing custom modules is only permitted from the local machine, so do it from a browser
on the Companion host, or over an SSH tunnel:

```sh
ssh -f -N -L 18000:127.0.0.1:8000 john@<companion-host>
```

## Configure the connection

Add a connection of type **rocket-onair** and set:

| Field | Value |
|---|---|
| Host | the on-air server, e.g. `rocket-studio-m1.local` |
| Port | `8484` |
| Passphrase | from `~/.onair/config.json`, under `auth.passphrase` |

**The passphrase is required, not optional.** This module holds a state table, and
`docs/api-contract.md` is explicit that a table-holder reads the gated endpoints rather than
`/public/*` - the public pair is a *rendering* view for two dumb browser pages, free to
change shape, with no `confirmed`, no `hold` and no `source`. Companion normally runs on a
different host from the server anyway, where D-24's loopback waiver does not apply and the
passphrase was already mandatory.

The easiest place to read the passphrase is the admin console at `http://<host>:8484/`.

## What you get

**Presets**, under the category **States** - one per row, captioned with the row's `label`
and coloured with its `color` on `bgcolor`, verbatim. Plus a **Refresh table** utility button.

**Actions**

| Action | What it does |
|---|---|
| Set state | `POST /state/{id}?source=companion`. The dropdown is the live table; a custom value is allowed |
| Refresh the state table now | re-reads `GET /config/states` |

**Feedbacks**

| Feedback | True when |
|---|---|
| State is | the light is showing that state |
| Busy | the current row is busy. This is the server's own flag, not a colour test - THE BUSY RULE (D-32) is what it means |
| Not refreshing | the server has not answered for longer than the configured window. The state shown is the last one it reported, not a current reading |
| No data | the server has been silent long enough that the module has given the state up entirely |

**Variables**: `state`, `label`, `busy`, `confirmed`, `hold`, `source`, `connection`,
`seconds_since_contact`, `age_seconds`, `table_version`.

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
| Say "not refreshing" after | 60000 ms | The last known state is still shown. `Not refreshing` goes true. |
| Give the state up after | 1800000 ms | `state` becomes `unknown`, `label` becomes `NO DATA`, `No data` goes true. |

Thirty minutes is deliberate: a meeting runs about that long, so the state has to survive a
server restart without the buttons going dark mid-call. One minute is also deliberate - the
honesty costs nothing and should arrive immediately.

**When the module gives up, `busy` reads `yes`, not `no`.** The reserved `unknown` row carries
`busy: true` (D-34) because every degenerate path in this system lands on a conspicuous state
rather than a calm one. A stream deck going dark because the server died would be a false OFF
on a physical control, which is the exact failure this product exists to prevent.

## Things worth knowing

- **Presets regenerate when the table changes.** The module watches `tableVersion` on the
  status stream; when it moves it re-reads the table and re-publishes definitions. No restart.
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
