# Bitfocus Companion setup

Two ways to drive the on-air light from a Stream Deck. **Use the module.** The
generic-connection path is kept below as a fallback, corrected - the version of it that
shipped before #44 described wiring that cannot work.

---

# 1. The module (recommended)

`companion-module/` in this repo. Sideloaded rather than installed from the store: it is
specific to this system and upstream submission is deliberately out of scope.

**What it gives you that the generic path does not:** presets per state, generated from
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

**Upgrading an existing install has two separate steps.** Import adds the package version;
it does not guarantee any connection starts using it. Confirm the version under
**Modules → Rocket: On-Air light**, then open the target connection and change **Module
Version** to that version. Reload the connection page first if its version list is stale.
Save the selection and verify the connection recovers.

For module 0.7.3 and later, inspect the live `module_version` and `module_commit` variables.
Compare them with the packaged build identity and the release commit. A version visible in
the Modules list proves installation, while these variables are supplied by the running
instance. A modified or unknown build must not be described as a clean release.

Buttons already placed on a surface retain their action/feedback IDs. They are copies, so
preset-definition changes do not retrofit their styles or extra feedbacks. Preserve custom
controls deliberately. Existing **Light health** copies are protected by the broadened
`light_not_confirming` feedback: loss of Receiver contact or no data activates their navy
NO ACK style rather than leaving them green. Re-create a copy from the 0.7.3 preset if you
want its more precise NOT REFRESHING, NO DATA, and ASLEEP styles. Healthy intentional sleep
remains non-faulting. Existing state-cycle and sleep/wake controls retain their bindings.

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

The admin console at `http://<host>:8484/` shows the document passphrase unless an environment
override is active. When overridden, it names the winning variable instead. Use that effective
credential from the Receiver's environment/config overlay; the inactive document value will
not authenticate the module.

## What you get

**Presets**, under **States** - one per row, captioned with the row's `label` and coloured
with its `color` on `bgcolor`, verbatim. Each one ships with the connection marks already
attached, so a deck straight out of the box meets the client contract without hand-wiring.

Each state preset has graphic and words-only variants under **States** and **States (words)**.
The same groups include a state-cycle button. **Panel** and **Panel (words)** contain sleep,
wake, and sleep/wake toggle controls. **Utility** contains **Light health** and **Refresh table**.

**Actions**

| Action | What it does |
|---|---|
| Set state | `POST /state/{id}?source=companion`. The dropdown is the live table; a custom value is allowed |
| Cycle to the next state | `POST /cycle`; the Receiver advances the selected ring in its write queue |
| Panel sleep | Requests `POST /panel/sleep`; a busy panel may remain lit |
| Panel wake | Requests `POST /panel/wake` |
| Panel sleep/wake toggle | `POST /panel/toggle`; the Receiver reads the glass and chooses the opposite |
| Refresh the state table now | re-reads `GET /config/states` |

**Feedbacks**

| Feedback | True when | Default look |
|---|---|---|
| Receiver state is | the Receiver reports that state, independently of physical confirmation | white on red |
| Busy | the current row is busy. The server's own flag, not a colour test - THE BUSY RULE (D-32) is what it means | white on red |
| Not refreshing | the server has not answered for longer than the configured window. The state shown is the last one it reported | **black on amber** |
| No data | the server has been silent long enough that the module has given the state up | **the reserved row's own colours**, as you set them |
| Light not confirming | Receiver contact is lost/no data, or physical confirmation is absent without intentional sleep. The system admitting ignorance, not a claim the light is wrong | **white on navy** |
| Light disagrees | the light acknowledges a row the server did not ask for | **black on white** |
| Panel asleep | the panel is deliberately dark, from a schedule or manual sleep | preset-specific |

Connection loss, no data, lack of confirmation, and disagreement have distinct presentations
because they describe different evidence and need different diagnosis. Intentional sleep is
healthy and is reported separately; it must not trigger a hardware-failure alarm.

**Variables**: `state`, `label`, `busy`, `confirmed`, `confirmed_reason`, `source`, `connection`,
`seconds_since_contact`, `age_seconds`, `table_version`, `module_version`, `module_commit`,
`receiver_instance_id`, `status_sequence`, `diagnostic_status`, `last_command`, and
`last_command_status`. Ordering variables show the accepted Receiver epoch and highest sequence;
they are empty when connected to a legacy Receiver.

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
- **API 2 presets support Linked or Copy placement on Companion 5.1.1.** Existing copied
  buttons remain copies until deliberately migrated. Linked references follow preset
  updates. Preserve customizations and stable row IDs when converting existing controls.
- **A button bound to a row the server no longer has says so.** The server answers `400` with
  the list of ids that would have worked, and the module logs it:
  `set state "deleted-row" failed: unknown state 'deleted-row' - valid states: available, on-air, ...`
- **`apiVersion` is declared by the module, not derived from `@companion-module/base`.** The
  manifest declares `2.2.0`, matching the implementation and Companion 5.1.1 support. The host must support that API.
  Do not change the declaration to a package version or a newer API without migrating and
  testing the module implementation.
- **Panel controls use the Receiver relay.** Sleep, wake, and toggle actions do not address
  a panel directly. The toggle icon reflects current glass state, not an assumed result of
  the last press. Night-schedule configuration remains device-local.

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


## Reliability in module 0.7.3

Late requests from a previous connection cannot update the current connection. A delayed
poll/write response does not replace a status accepted while that request was in flight,
and table pulls are coordinated. The contact-age variable keeps advancing during an outage,
not just when a threshold is crossed. The generated Light health preset explicitly handles
connection loss, no data, and intentional sleep instead of leaving a healthy default visible.
Existing copied health buttons also stop showing green on lost contact/no data through the
compatible broadening of `light_not_confirming`; all feedback IDs are preserved.

## API 2 and linked controls

The current module uses API 2.2 on Companion 5.1.1, with an ESM entrypoint, API 2 variable
and preset definitions, and a tested action-option upgrade script. Existing cycle and
sleep/wake action IDs and feedback IDs are retained. Legacy custom `set_state` values that
interpolate variables are migrated to expressions; ordinary cycle/toggle options stay intact.

Back up controls before converting them to linked references. For `state_cycle`, preserve
the selected ring using the preset's `cycle_states` local-variable override. `panel_toggle`
needs no option override. Keep the original controls available for rollback, and validate
state changes and physical panel confirmation before retiring those originals.

The new Utility preset **Receiver and panel diagnostics** separates READY, ASLEEP,
RECEIVER OFFLINE, and panel warnings. It includes module version and last-command outcome.
A command marked accepted or delivered is not a substitute for physical confirmation.
