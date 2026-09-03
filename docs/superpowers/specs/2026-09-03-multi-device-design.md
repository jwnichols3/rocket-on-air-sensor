# Several on-air lights, one authoritative

Design, 2026-09-03. Implements **stage 3 of
[#57](https://github.com/jwnichols3/rocket-on-air-sensor/issues/57)** - the only stage of that
ticket never built - under the ruling already recorded in **D-87**.

## Problem

The server drives exactly one light. `config.light` is a flat object with no id, `makeDriver`
builds exactly one `EsphomeTextDriver`, and the supervisor holds one driver and writes one
`confirmed` onto one global state object. Rocket has two boards on the LAN - a CrowPanel 7
at `10.42.14.239` and an Elegoo at `10.42.12.77` - and can drive only one of them at a time,
by editing a config file or an env var.

He wants to add and edit several devices from the admin console.

## What was already decided, and is not reopened here

- **D-87**: `confirmed` cannot mean "every panel agreed". A bench board that is off for weeks
  would make an AND over all panels permanently false and the system would report a fault as
  its resting state. **One authoritative panel for `confirmed`, all others best-effort.**
- **D-38 / D-63**: renderers are dumb and plural, and the config PULL direction is already
  plural - any panel holding the passphrase may fetch `GET /config/states`. Only the state
  PUSH direction is singular. This design changes only the push direction.
- **D-14 / D-79**: the env overlay outranks the config document, because that is the
  documented way to point a box at a different light over SSH when its own UI is unreachable.
- **D-36**: `validateConfig` is THE one validation function and the admin UI has no
  privileged path into it.

Confirmed with Rocket on 2026-09-03: one primary with the rest best-effort; a device row
carrying identity, connection and role; and the env overlay applying to the primary only.

## Design

### 1. `FanOutDriver` - the composite (new, `server/src/fanout-driver.ts`)

`LightDriver` is already a per-device interface with no statics and no globals, and
`EsphomeTextDriver` already keeps every piece of host, credential and retry state per
instance. N instances work today; nothing holds them.

So the fan-out is a `LightDriver` that owns other `LightDriver`s:

| call | behaviour |
|---|---|
| `host` | the primary's host |
| `set(id)` | issue to the primary and every enabled secondary **in parallel**; resolve as soon as the **primary** answers; return the primary's answer |
| `read` / `repainted` / `glassDark` | **primary only** |
| `setPanelSleep(on)` | fan out; return the primary's result |
| `setTableVersion(v)` | fan out, best-effort |

**`supervise.ts`, `state.ts` and the wire contract do not change.** That is the point of
D-87's shape: "one authoritative, the rest best-effort" is expressible as a driver, so
`confirmed` keeps meaning a genuine device read from the panel that matters, and no surface
downstream learns that a second panel exists.

**The fan-out is parallel, and that is load-bearing rather than tidy.** `writeChain`
(`app.ts:215-227`) is ONE queue shared by every HTTP write and the supervisor tick, so all
device I/O in the process serialises through it. #68 measured **6.4 s for one write against a
dead panel**. Fanning out in series would put that 6.4 s per dead secondary inside the queue
every caller waits on, which is #68 reintroduced through the side door.

A secondary whose previous write is still in flight is **skipped**, not queued behind itself,
so a permanently dead board cannot accumulate work. Secondary outcomes settle in the
background through `allSettled` into the health map below; a secondary rejection can never
change what `set()` returned.

**Failure logging is on the EDGE, not the tick** - first failure after success, first success
after failure, each naming the host. That is D-109's discipline and it is exactly what
[#59](https://github.com/jwnichols3/rocket-on-air-sensor/issues/59) asked for: 915 identical
lines that could not say *when* a panel went away or *which one*.

### 2. Reconfigure in place, because today a saved edit does nothing

`driver` is a `const` in `createApp` (`app.ts:178`), captured by closure in both `makeServer`
and the supervisor, and **`applyConfig` never rebuilds it** (`app.ts:280-352`: it rotates the
passphrase, saves the file, swaps the state table, nudges the version, rebinds listeners - and
never touches the driver).

**That is a live defect today, not a new one.** Change the device address in the admin console
right now and you get a `200`, a persisted file, and a process that goes on talking to the old
panel until someone restarts the daemon. It is the same silent-success shape as D-79's
overridden field and D-100's stale binary.

For this feature it is fatal: adding a device in the UI would do nothing until a restart.

The fix is the smallest one available. `FanOutDriver` gains `reconfigure(devices)` and becomes
the **stable object** - nothing captured by any closure changes, so `makeServer` and the
supervisor need no rebuild path at all. `applyConfig` calls it when the resolved device list
has moved. Drivers for departed devices are disposed; drivers for unchanged devices are
**kept**, so a save does not reset the retry and frame-counter state of a panel nobody edited.

A driver injected through `opts.driver` is never reconfigured, which is what keeps the ~18
test files that inject their own driver working untouched.

### 3. Schema

`OnAirConfig` gains `devices: DeviceRow[]`:

```
id        immutable slug, ID_PATTERN, like a state row
label     human phrase, freely editable
host, entity, username, password
enabled   written to only when true
primary   exactly one enabled row is true - the one `confirmed` describes
order     display sort hint, presentation only
```

`light` stays exactly as it is, as a **read-only projection of the primary device**. That
keeps all 43 source references and every existing test working untouched, and it is the
difference between a contained change and a rewrite.

The precedence is one rule, stated once, and it is also the migration:

> **If a payload carries `devices`, `devices` wins and `light` is recomputed from the primary
> row. If it carries no `devices`, `light` wins and one row is synthesised from it.**

A payload with `devices` is a new client and its `light` is stale by construction; a payload
without is an old client or an old file. Neither case can silently lose an edit, and no
version branch is needed - which matters, because **`config.version` is a save counter, not a
schema version** (it drives optimistic concurrency and `tableVersion`, and `validateConfig`
never branches on it). There is no migration mechanism in this repo to extend, and this needs
none: the forgiving-defaults style of `validateConfig` is the mechanism.

`validateConfig` gains real errors for devices - unique ids, `ID_PATTERN` on the slug, and
exactly one primary, which must itself be `enabled`. A primary that is disabled is a
contradiction rather than a preference: it is the row `confirmed` describes, so switching it
off would leave `confirmed` describing a panel the server has agreed not to write to.

**An EMPTY device list is legal and means no light**, which is exactly today's behaviour when
`light.host` is `null` - `makeDriver` returns `undefined` and `NoopDriver` takes over. The
"exactly one primary" rule therefore applies only to a non-empty list, and `light` projects to
`host: null` from an empty one. Getting this wrong would make a fresh install fail validation
before its first device is typed in.

Note `validateConfig` currently **cannot produce an error for `light` at all**
(`config-store.ts:86-92` coerces silently, unlike `states`, `shortcuts` and `auth`), so this
is a strengthening rather than a new pattern.

### 4. Env overlay

`ONAIR_LIGHT_HOST` / `_ENTITY` / `_USER` / `_PASS` override **the primary row only**. The
`ENV_OVERRIDABLE` keys stay `light.host` and friends, so `effectiveLight()` remains the one
expression of that precedence (D-79) and the console's existing read-only override rendering
lands on the primary row with no new mechanism. Secondary devices are document-only.

This matters concretely: the live daemon is running with `config.json` naming `10.42.12.77`
and `config.env` naming `10.42.14.239`. The overlay is not hypothetical here; it is what is
driving the panel today.

### 5. A bad secondary must not kill the service

Boot runs `verifyEntity()` and a `DriverConfigError` propagates and stops the daemon
(`app.ts:191-211`) - correct for the one panel that matters, because a wrong entity name is a
deploy bug and must be loud.

With a list, **only the primary keeps that power.** A secondary with a mistyped entity name is
logged, marked unhealthy and skipped. Otherwise a typo typed into the console bricks the
daemon at its next restart, which is a false OFF with extra steps.

### 6. UI

`#sec-device` becomes a list, built on the **states editor pattern it already has**: three
commit levels (`editing` / `draft` in sessionStorage / `live`), dirtiness computed by
`JSON.stringify` diff rather than tracked, `createElement` and never `innerHTML`, deletions
kept visible as `.deleted .staged` rows with Undo, and the canonical
`saveDraft(); renderRows(); renderCommit(); renderRail();` after every mutation.

Ordering follows the states editor exactly: a numeric `order` field, id as tiebreak. **No
drag-reorder**, because the precedent has none and inventing one here would be the only
gesture of its kind in the console.

Each row keeps the two `panelLink` links it has today, still gated on `HOSTISH` so an
operator-set string can never become a `javascript:` href, and still following the
**env-effective** host for the primary rather than the document's - "a field that lies can be
re-read; a link that lies gets clicked" (D-79, #55).

Saves through the existing whole-document `PUT /admin/config`. **No new write route.**

The section keeps the name **Device connection**, not "Light" (D-78), and the browser test
asserting the word "Light" appears nowhere on screen stays green.

**A poll must never rebuild nodes** (`app.js:911-931`). Two silent bugs came from violating
that (#50, #54) and both have browser tests; the device list obeys the same rule as the state
rows - rebuild only when nothing is open for editing.

### 7. One route change, and it is not optional

`GET /admin/health` gains a `devices` array: `id`, `label`, `host`, `primary`, `enabled`,
`reachable`, `lastOkAt`, `lastError`. Device reachability is currently exposed nowhere except
through `confirmed` / `confirmedReason`, which describe the primary alone.

A console that lists two panels and cannot say which one is dead is a console that lies, and
#59 is the ticket that says so. It goes on `/admin/health` rather than a new route because
that is the existing home for "how is this service actually doing".

## What does not change

Firmware, in any way. `PresenceKey`, `TableVersion`, `Night` and `PanelSleep` are declared in
the shared `onair-core.yaml` with **un-interpolated names**, identical on both boards, which is
the asymmetry that lets one driver class address N hosts. The device -> server leg is
configured on the panel itself (`ServerHost`, `ServerPort`, `ServerPassphrase`) and the panel
pulls the table, so the server still keeps no device registry for the pull direction.

Also unchanged: `supervise.ts`, `state.ts`, `OnAirState`, `StatusBody`, `GET /status`,
`GET /public/status`, `/display`, the SSE and WS bodies, `GET /config/states`, and the
Companion module.

## Hazards this design is written against

- **A save that reports success and changes nothing.** Section 2. The most likely way to ship
  this feature broken is to add the list, see a `200`, and never notice the process is still
  driving one panel.
- **A dead secondary stalling every write.** Section 1, and #68 is the measurement.
- **Vacuous tests.** Every behavioural claim below turns a *named* test red when reverted.
  A conversion nobody has watched go red is not a test.
- **Measuring the old firmware.** The Elegoo has not been flashed since `Build` was added, so
  its running image has no `Build` sensor at all. Recorded before the flash: `GET
  /text_sensor/Build` returns **404**. That is a genuine absent-before / present-after marker
  rather than one invented afterwards.

## Verification

**Unit, each mutation-tested to a named red test:**

- a throwing secondary does not change what `set()` returns
- a disabled device is never written to
- `read` / `repainted` / `glassDark` touch the primary and no one else
- a secondary with a write in flight is skipped rather than queued
- `reconfigure` keeps the driver instance for an unchanged device and disposes a departed one
- migration: a document with no `devices` yields one primary row; a document with `devices`
  ignores a stale `light`; duplicate ids, a bad slug and zero-or-two primaries each fail
  validation with a named message

**Browser:** the six existing tests written against the single `light` shape are rewritten
against the list, not deleted. A device row survives a poll as the same attached node with its
listener still firing.

**Live, on the hardware:**

1. Record `Build` on both boards before touching anything.
2. Compile and flash `configs/elegoo-esp32.yaml` to `10.42.12.77`. Never foreground
   `make flash` or `esphome logs`; `upload` alone does not compile, so compile first.
3. Confirm `GET /text_sensor/Build` moves from **404** to a version string past the 60 s
   `PENDING_VERIFY` window - an image inside that window silently reverts.
4. Add the Elegoo as a second device in the console, save, and write a state **without
   restarting the daemon** - which is the assertion section 2 exists for.
5. Watch **both** panels change.
6. Pull the secondary and confirm `confirmed` still tracks the CrowPanel, `/admin/health`
   marks the Elegoo unreachable, and one edge line names the host.

`npm run verify` at the root is the gate and must be green, including `esphome config` over
both board YAMLs.

## Out of scope

- Per-device night schedule or brightness. D-111 puts those on the panel's own page
  deliberately and this design does not reverse it.
- Per-device `confirmed` on the wire. D-87 rules it out and nothing here asks for it.
- A second Elegoo. `device_name` is a build-time substitution, so two identical boards would
  collide on hostname and mDNS and would need a second YAML. Not needed for two boards of
  different types.
