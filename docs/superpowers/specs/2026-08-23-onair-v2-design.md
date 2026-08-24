# On-Air v2 design

**Status:** decided. Every question on map [#19](https://github.com/jwnichols3/rocket-on-air-sensor/issues/19) is answered; nothing here is waiting on a conversation.
**Decisions:** D-28..D-41 in `CONTEXT.md`. **Wire contract:** `docs/api-contract.md` (v2).
**Source memo:** `docs/2026-08-23-onair-v2-wayfinder-brief.md`.

This document is what the SDD pipeline writes per-part implementation specs from. It fixes
the state table, the state semantics, the config store, the auth model, the monorepo
layout, the ESP32's config pull, and what the Companion research means for the server. It
does not implement anything.

> **How this was decided.** Rocket delegated the whole map to one autonomous agent run and
> waived the usual grilling conversations. Every choice here is the agent's, recorded in
> `CONTEXT.md` as normal and Rocket's to overturn. Taste calls are flagged inline as
> **[taste]** and collected in §10.

---

## 1. What v2 is

v1 is a light with three hardcoded rungs. v2 is a **configurable presence system**: the
owner defines what the light can say, and four parts render or drive that definition.

```
                       ~/.onair/config.json          ~/.onair/state.json
                       (knowledge: the table,        (operational: current
                        credentials, network)         state + hold)
                                 |                            |
   admin-ui/  ---- PUT /admin/config ---->  server/  <---------+
   (SPA, staged edits)                        |  |
                                              |  +--- push state, read back --> firmware/
   companion-module/ -- WS + /config/states --+  |         (ESP32, ESPHome)
   (presets from the table)                     |               |
                                                +<-- GET /config/states (pull, 300s) --+
   VCREC (external, D-30) -- PUT /state ---------+
```

Four surfaces, one contract. **The contract is the only coupling** - which matters most for
VCREC, whose source this repo never reads.

**The three moves, and what each cost:**

1. **States stop being hardcoded.** This breaks D-18's ladder, and with it D-19's hold and
   D-18's `intended` projection. §2 and §3.
2. **The server becomes a macOS product** - background service (D-13, unchanged), SwiftBar
   menu bar (D-26, unchanged), and a real admin UI with its own build. §5 and §6.
3. **The device and Companion follow the table.** §7 and §8.

---

## 2. The state table

Full schema, seeds and validation: `docs/api-contract.md` §1. What matters here is *why*
the shape is what it is.

**Identity is an immutable slug; the number the owner reached for is display order.**
Rocket described "the state ID" as `0, 1, 2, 3, 4 ... all the way up to whatever" - but his
own example put `interruptible` (2) *above* `on-air` (1), which is backwards for any rank.
Five independent threads converged on splitting identity from label: Type Object, Matter's
`ModeOptionStruct`, HA's `unique_id`, openHAB's `{value,label}`, and - decisively - the fact
that a Companion preset dragged onto a Stream Deck button is a **one-time copy** in 5.0.x,
so the button permanently carries whatever `id` it was created with.

**The phrase is honoured, not discarded.** Rocket wanted "the word or phrase that would be
sent with the state". It *is* sent - `label` travels alongside `id` in every status response
(openHAB's self-describing shape). It is simply not the key.

**One safety attribute, not two.** The obvious move was a `severity` ordinal, since every
surveyed system that resolves competing writers uses an explicit ordering. It is not built.
The `busy` boolean carries the entire safety axis - it defines `intended`, it is what the
staleness rule is written over, and it is the one thing that can break a pin. Add a
precedence ordinal only when a second automated writer actually competes; there is one
(D-30), and at that point max-merge gives order-independence for free.

**Colour is on the wire, against every surveyed precedent.** No presence system does this,
because federation forces client-side theming. This system is not federated - one owner, N
dumb renderers he also owns, none of which can carry a sitemap. Accepted cost, taken
knowingly: **presentation is welded into the wire protocol permanently.**

**One reserved row, `unknown`.** Undeletable, `busy: true`, conspicuous. It is a Null
Object, not a rung - nothing is ordered against it. It exists because the fallback for a
dangling reference must not be `available`: a delete that silently resolves to the calm
state is the system's primary invariant violated while wearing a maintenance-operation
costume. HA's `options[0]` fallback is the same trap - *"'fall back to the first row' is a
bad rule if the first row is ON AIR."*

**Vocabulary is fixed.** Adopt *state table*, *row*, *id*, *label*, *registry* /
*registration policy*, and Fowler's *knowledge level* vs *operational level*. Ban *state
machine*, *statechart*, *transition*, *guard*, *event* - there are no transitions here, a
complete graph carries zero information, and the words invite a contributor to invent some.
Also ban *taxonomy*, *traits*, and *entity* at row level. `select` and `option` are ESPHome
transport words only. This resolves the one recorded disagreement between the two vocabulary
surveys in favour of the ban.

---

## 3. State semantics

### The invariant, stated directly

Every load-bearing word in D-6/D-18's staleness rule was an ordering word ("lowers",
"raises", "below"), so the rule could not survive the table. It is restated over `busy`:

> **THE BUSY RULE - the server never moves from a `busy: true` state to a `busy: false`
> state, and never asserts a `busy: false` state to a renderer, on the strength of evidence
> that is stale (`ageSeconds > 90`). Moving to or staying at `busy: true` is always allowed.
> Absence of information never renders calm.**

Note what stopped needing a rule. D-18 had to special-case `dnd -> interruptible` decay as a
new failure its own words did not cover. Under the busy rule, `busy:true -> busy:true` moves
need no clause: they only happen on a write, and a write is fresh evidence by definition.

Everything D-6 established survives: staleness is **visible, never acted on**; no TTL, no
decay, no auto-raise; the server withholds an assertion rather than heartbeating a stale
calm state, which is withdrawal of a liveness claim rather than a state change.

### Hold is a pin with one carve-out

D-19's floor is meaningless over an unordered set. A **naive** pin is also wrong, and there
is production evidence: Microsoft Teams ships `user-preferred state > session-level states`,
so a Teams user who prefers `Available` and then joins a call shows **Available** - the
precise failure D-19 named. Teams can afford a wrong-but-chosen chat status; a light whose
only job is to say whether a camera is live cannot.

> **THE PIN RULE - while a hold is set, a write from an `auto:` source is applied only if it
> moves the system from a `busy: false` state to a `busy: true` state. Every other automated
> write is refused (`409`) and the held state stands. A `human:` write always applies; a
> `human:` write naming a state other than the held one releases the hold.**

The carve-out reproduces every behaviour D-19 wanted - including *"I am interruptible today"*
surviving a meeting - and drops the wart it carried: **a pin at `available` is now legal**,
where D-19 made it a `400`, because a pin at a calm state can no longer force calm against a
live camera. D-21.2's self-contradiction rule survives restated: `state: X, hold: Y` is
unreachable.

Release is explicit only, and only a `human:` source may set, move or clear a pin. Teams'
severity-scaled hold expiry is recorded as a **conflict, not an adoption** - D-6 and D-19
both forbid TTLs and that stands.

### `intended` survives, on a forward argument

`intended` is now `table[state].busy ? "on" : "off"`. Four unrelated sources argued for the
per-row flag - RFC 3863 (PIDF) requires extended status values to *carry* the basic
`open`/`closed` alongside them; Type Object says a type object carries per-type data; HA
splits capability from state; and the existing Companion wiring keys off `$.intended`.

The framing matters. D-18 kept `intended` for **backward** compatibility with consumers the
map says are abandonable. PIDF's argument is **forward**: the whole point of a user-editable
table is that the state set changes *after* the consumers ship, and the flag is what makes a
row invented tomorrow safe for a client written last month. That argument does not weaken as
old consumers die, so D-18's "separate, later, boring ticket" to delete `intended` is
**cancelled**.

Free consequence: the phase-1 Companion websocket wiring keeps working with zero code and
zero config changes. That answers the map's fog item about whether to keep it alive
deliberately - yes, and it costs nothing.

### `source` is contract

Under D-30 the detector is entirely external, so `source` is the only trace it leaves here.
Shape is `kind:label` with `kind` in `{auto, human}`. An absent or unprefixed `source` reads
as `human:`, which keeps `curl` and phone Shortcuts working with no ceremony - and is the
**unsafe** default, so the contract says in bold that an automated writer omitting `auto:`
gets human authority and will break pins. **[taste]** - failing loud on an unprefixed source
would be safer and would break every existing manual client.

### Lifecycle

Adopt HA's containment asymmetry wholesale: **degrade quietly on the state, fail loudly on
the command.** One correction - HA logs its live-delete fallback as a warning, which on a
physical light means the panel changes colour with no explanation, so here it surfaces in
`GET /status` (`stateResolvedFrom`) and in the admin UI, not only in a log.

Full table in `docs/api-contract.md` §6. The two rules worth repeating: **a write naming an
unknown id is `400`, never accept-and-fall-back**, and **a renderer handed an unknown id
draws `unknown` conspicuously, never silently drops it** - the XMPP failure, where a custom
state degrades to *nothing*, which on this panel looks exactly like calm.

**Index is never an address.** HA's options are positional with no identity, so index is a de
facto second address that silently resolves to the wrong thing after a reorder, with nothing
erroring because every index stays valid. A Stream Deck button bound to "option 3" is that
failure. `order` is cosmetic; `id` is the only handle.

**Table versioning** is a monotonic integer stamped into `GET /status`. Old versions are not
retained - this system has no history store, so there is nothing to reinterpret. The stamp
exists so a history store can add snapshots later without a migration. Recorded as decided
and scoped, not overlooked.

---

## 4. Monorepo layout

```
/                     CONTEXT.md  CLAUDE.md  README.md  INSTALL.md
                      package.json (workspaces)  docs/  deploy/
  server/             package "onair-api" - bin, src/ test/ dist/ tsconfig*.json
  admin-ui/           package "onair-admin-ui" - builds to server/public/admin/
  firmware/           ESPHome - pyproject.toml uv.lock Makefile configs/
  companion-module/   package "companion-module-rocket-onair" - @companion-module/base ~2.1.3
```

Flat top-level directories, not `packages/` or `apps/` - two of the four are not npm
packages. npm workspaces cover the three Node parts; `firmware/` is a sibling with its own
uv toolchain, reached from root scripts, because pretending it is a package is what would
make it second-class.

**`npm run verify` at the root is the single gate:** three test suites, three typechecks,
plus `esphome config` on the firmware YAML - which validates the build with no hardware and
no flash.

**The installer promise, and its cost.** D-13's plist supervises `node dist/index.js`;
moving that to `server/dist/` changes a path D-14 built the config-file-first design to
avoid changing. Read precisely, D-14 promised the plist never changes **for a config
change** - a restructure is an update, and `onair update` exists to carry updates,
health-gated with automatic rollback. The layout change ships with a plist rewrite performed
by `onair update`. **Cost accepted:** one installed host, nothing in production, and a failed
update rolls back. A root `dist/index.js` shim was rejected - permanent cruft, forever, to
dodge a one-time migration on one machine, and it leaves two plausible entry points for
every future reader.

The root package is `private: true` with no `bin`, so `npx github:` stops resolving an
executable. D-15 had already demoted that to "a throwaway demo, never an install or boot
path"; this finishes it. `deploy/get-onair` + `deploy/bootstrap` remain the install path,
unaffected.

Firmware comes in as **files, not history** - five of them, plus the ESPHome `2026.8.0` pin
and its warning. `secrets.yaml` does not come across. `jwnichols3/rocket-esp32` is left
exactly as it is.

**No CI**, and deliberately not invented. `npm run verify` before any commit that touches
source is this repo's existing bar.

---

## 5. Auth

Two credentials, two audiences, and neither is accepted on the other's routes.

| Credential | Gates | Presented by |
|---|---|---|
| **Passphrase** (replaces `ONAIR_TOKEN`) | data routes | ESP32, Companion, VCREC, kiosk |
| **Admin user + password** (`rocket` / `ESP32`) | `/admin/*` only, via a session token | a person |

That is a sharpening of D-27, not a reversal. D-27 rejected splitting the *data* credential
into read and write halves and that stands - there is one passphrase, no read/write split.
This is a different axis: "read and write state" versus "reconfigure the system, including
rotating the passphrase."

**D-24's Origin waiver grants a full admin session**, carried over verbatim and unweakened.
One carve-out: **factory reset always requires the admin password, from any origin.**
Everything else an admin session can do is recoverable; factory reset on a box across the
house is the lockout path. Revealing the passphrase is deliberately *not* carved out - Rocket
has to read it to type it into three places.

**No cookie.** D-23's CSRF objection does not evaporate because there is now a login form.
The SPA holds a session token in memory only and sends it as a bearer header, so CSRF on
admin routes is *structurally impossible* rather than defended against, and the write routes
stay deliberately CORS-simple. Cost: a refresh logs you out - invisible at home, because the
waiver re-establishes silently. Sessions are 12 h sliding, in memory. **[taste]**

**Rotation has a 60-minute grace window** during which the previous passphrase still works,
plus a checklist naming the hand-configured clients. That turns a simultaneous outage into a
walk around the house.

**Factory reset regenerates the passphrase at random and shows it once** rather than
resetting it to a default - a known default passphrase would be a documented LAN backdoor.
The brief said reset returns credentials to defaults but never named a default passphrase,
so this fills a blank. **[taste]**, and flagged in §10 because the brief's words were "both".

**D-25's reasoning survives; its subject changes.** `/ui` retires into the admin UI. The
admin UI ships as a static bundle served **unauthenticated** (byte-identical, zero
interpolation, discloses nothing) and every byte of data it renders comes from gated routes -
unauthenticated shell plus gated data, not gated wholesale. `GET /public/status` is added,
deliberately thin, because the landing page Rocket described cannot exist without it.

**Multi-user admin: decided, not built.** "Change that or add a new one" is read as
editability, which is delivered. A second account on a single-user machine adds a user store,
a session table and a reset path to protect nothing D-24 does not already cover.

**Device auth stays separate and stays compile-time.** ESPHome's `web_server: auth:` has no
runtime API, so the device half cannot move into a UI; the server's copy moves into the
config store.

---

## 6. Config store and the admin UI

**One document: `~/.onair/config.json`, 0600.** Port, bind mode, passphrase, admin
credentials, device credentials, shortcut rows, state table. `config.env` retires as the
config *source* and survives as an env overlay - real environment variables still win, which
is D-14's rule and the break-glass path over SSH. The plist still carries no `ONAIR_*`.

**Config and state never share a file.** `config.json` is knowledge level, slow, user-owned.
`state.json` is operational, fast, service-owned.

**One write path, enforced by construction.** HA demonstrates the two-writer trap *inside a
single application* - `set_options` mutates memory and never touches storage, so it silently
does not survive a restart, while UI editing goes through a different path entirely. Here the
admin UI has **no privileged path**: it calls the same `PUT /admin/config` any other client
would, through one validation function and one atomic write.

**Never fail closed.** An unparseable config at startup logs loudly, binds **loopback only**,
serves the admin UI, and shows a repair screen with the parse error and the raw text. That is
aimed at the failure the map named: a config save that leaves the service unable to start on
a machine Rocket is not sitting in front of.

**Bind is a mode, not an address** - `all` / `loopback` / `iface:<name>` - and **loopback is
always bound and is never a user choice.** Measured: a single-LAN bind makes `127.0.0.1`
return `ECONNREFUSED`, which would switch off D-24's waiver and therefore the local admin
surface, from the page that switched it off. Store the interface *name*, re-resolve every
startup; a stale stored address is `EADDRNOTAVAIL`, which under `KeepAlive` is a crash loop.

**Staged edits live in the browser** - client draft, mirrored to `sessionStorage`. No
server-side draft: it would add a second lifetime, a second write path, and a "whose draft is
this" question for two tabs, to hold something the browser already holds.

Three commit levels, and the prototype (D-39) sharpened one of them:

| Control | Effect |
|---|---|
| **Save row** | stages the row into the local draft |
| **Cancel** (while editing) | abandons the edit session, back to the row's **last staged** value |
| **Revert** (on a staged row) | drops the row back to **live** |
| **Save configuration** | the only thing that reaches the service |

Cancel and Revert are two controls on purpose: collapsing them loses the ability to abandon a
typo without also discarding a change staged ten minutes ago.

**One save button, and the server decides what it costs.** Everything except `port` and
`bind` applies live. A `port`/`bind` change **rebinds in place** - no exit, no supervisor -
and **rolls back to the previous binding** on failure, returning `409`. Strictly better than
"restart and hope", and it is what makes a config UI safe from across the house.

**Concurrency is optimistic** - `PUT /admin/config` carries the version it was based on; a
mismatch is `409` with the current document. A hand-edit made while the service is running is
overwritten by the next UI save, documented plainly rather than defended against.

**The UI shape** is settled by the prototype: one page with a section rail (Status, States,
Admin settings, Network, Light), a commit bar in the header that never scrolls away, and a
**live WCAG contrast ratio on every row's own colours**. That last one turns "is this
readable across the room" into an instant answer instead of a firmware round trip, and it is
the most valuable thing on the page. Prototype:
`docs/prototypes/2026-08-23-admin-state-table.html`.

---

## 7. The ESP32

**A factual correction the brief carried.** It says pull *"matches how the device already
polls `GET /status` (D-17)"*. The device does not poll - D-17 and D-27 are explicit that the
**server is the HTTP client of the device**. The brief's *ruling* stands; its premise does
not. Resolved as:

> **State stays PUSH (server -> device). Config becomes PULL (device -> server).**

Different directions, so they cannot share a request - which decisively answers the
one-endpoint-or-two question. State push is measured at 120 ms median set-to-confirm (D-22)
and `confirmed` needs the server to read the device anyway; polling would be a latency
regression for nothing. Config pull keeps the server **stateless about devices** - no
registry, no reachability requirement, no retry logic.

**`select` becomes `text`.** ESPHome's `select` options are compile-time YAML with no runtime
API, so a user-editable table would mean a reflash per row. The real argument is ownership,
though: a `select` asserts the *firmware* owns the valid set; here the server owns it and the
panel is a renderer, which `text` encodes correctly. Verified against the pinned **2026.8.0**
source, not `dev`:

| Fact | Where |
|---|---|
| `POST /text/<Name>/set?value=<v>` -> `200` | `web_server.cpp` `handle_text_request` (this shape was previously unverified) |
| `GET /text/<Name>` -> `{id, value, state, min_length, max_length, pattern}` | same |
| **Respond-before-apply**, identical to `select` | `DEFER_ACTION(call, call.perform())` before `request->send(200)` - **so D-22.3's re-read across the gap carries over unchanged** |
| `max_length` default 255 | `text/__init__.py` |
| `mode: password` masks state to `********` | `web_server.cpp` `text_json_` |
| template `text` supports `restore_value: true` | `template/text/__init__.py` |

Cost: `select` gave free rejection of unknown options at the device; `text` does not.
**Validation moves to the server**, where the lifecycle rules already put it.

**Colour reaches the device through the config pull, not the state write** - which dissolves
the "no single ESPHome entity can carry a row" problem entirely. The state write is one
opaque key; the table arrives separately and rarely.

**Config pull:** `GET /config/states`, passphrase-gated, every **300 s** **[taste]**, on
boot, and immediately after being handed an unknown id. `If-None-Match: "<version>"` makes
the steady state a `304`. `http_request`'s `max_response_buffer_size` defaults to 1 kB and
must be raised (8 kB).

**What is buildable, and what is not.** Rocket's device page splits in two:

- **Ships in v2:** connection settings - which server, which port, which passphrase - as
  template `text` / `number` / `switch` entities with `restore_value: true`, `mode: password`
  on the passphrase, served at the device's own IP through the existing `web_server` behind
  D-17's basic auth. That is his actual list, behind a login, at the device's address.
- **Not configurable from YAML:** a bespoke page with its own login form and an editable grid.
  `web_server` is not a web framework, and no amount of YAML makes it one.
- **But see D-40** - that is a limit of the *YAML surface*, not of the platform. An ESPHome
  **external component** can register arbitrary HTTP handlers on the same server and port via
  `web_server_base::add_handler()`, inheriting D-17's basic auth, and can persist a table as
  an NVS blob well inside the ~19 KB practical ceiling. `captive_portal` does the first of
  those in-tree. The device page and local overrides are **a chunk of C++, not a firmware
  track change.**

**v2 still ships auto-only, and the device still does not persist the table** - it holds it in
RAM and pulls on boot, rendering `unknown` / `NO CONFIG` until the first successful pull, which
is correct under the invariant anyway. That is now a **scheduling** decision rather than a
platform limit, which is a materially different thing to record.

**Custom mode ships as one bit** for v2: a `switch` where `auto` pulls and follows and `custom`
freezes the table last pulled and stops pulling. Four lines of YAML, and it answers the real
question behind the ask. The full device-served editor is
[#33](https://github.com/jwnichols3/rocket-on-air-sensor/issues/33), rescoped by D-40 from
"needs different firmware" to "needs an external component".

**Unreachable server:** state pushes stop -> the existing watchdog trips to NO DATA; config
pulls fail -> keep the RAM table; no table at all -> `unknown` / `NO CONFIG`. Never calm, at
any point.

**Stale table on the device:** handed an id it does not know, it renders `unknown`
conspicuously **and triggers an immediate re-pull**, self-healing in one round trip.

---

## 8. Companion

The module is **out of scope to build** (map #19). What the research means for what the
server must expose, which is in scope:

- **Presets do regenerate at runtime.** The definition setters are repeatedly callable and
  diff-patched to the UI; three upstream modules do exactly this. So a module can rebuild its
  preset set from `GET /config/states` whenever `tableVersion` moves.
- **Ids must be stable across regeneration.** A placed button is a one-time *copy* in 5.0.x,
  so it permanently holds the id it was created with. That is a hard requirement satisfied by
  D-31's immutable `id`, and it pays forward: unreleased 5.1 adds live-linked preset
  references (defaulting to on, gated on 2.0+ modules), which turns "drag it again after every
  table edit" into "it just updates" - exactly what Rocket asked for.
- **`CompanionPresetGroupTemplate`** generates a series of buttons from a matrix of values -
  near purpose-built for one preset per row. Adopting Companion's field names `text`, `color`
  and `bgcolor` **verbatim** makes preset generation a field copy rather than a translation.
- **Pin `@companion-module/base` to `~2.1.3`**, not `^2`.
- **Sideloading is real** by two paths: an *Import module package* `.tgz` (unpacked above the
  per-release config dir, so it **survives a Companion upgrade**; refused from a non-local
  browser client, which is fine on the desktop app) and the documented developer-modules
  folder with hot reload.
- **The server needs nothing new for phase 1.** `GET /events/ws` survives intact and its
  `$.intended == "on"` feedback keeps working under an arbitrary table (§3). What breaks is
  only what was keyed to rungs.
- **Untested against a running Companion 5** - the research machine has 4.1.4, never launched.

---

## 9. Not covered

Named so the pipeline does not silently assume it:

- **Building the Companion module.** Out of scope on the map. Upstream submission explicitly
  ruled out.
- **The colour lamp renderer** (D-20). Still deferred. The table's colour fields are the first
  thing it would consume, and they now exist.
- **Device-side table editing** - [#33](https://github.com/jwnichols3/rocket-on-air-sensor/issues/33).
  Buildable as an ESPHome external component (D-40); deferred on effort, not on feasibility.
- **A history store.** `tableVersion` is stamped so one can be added without a migration, but
  nothing records state over time today.
- **CI.** No pipeline. `npm run verify` is the gate.
- **Detector integration.** VCREC has to map Zoom/Meet call state onto an arbitrary table; how
  it does that is its own project's problem (D-30). This contract is written to be legible to
  it, which is the whole of this repo's obligation.
- **Migration.** There is none, and none is needed - nothing is production (map #19), so the
  running system is replaced rather than migrated.
- **Everything from the two lost walks.** Rocket: *"there's way more than this than that."*
  The memo is a partial reconstruction of a 45-minute talk.

---

## 10. Taste calls, for review

Every one of these is a default the agent picked because there was no technical answer. They
are the ones worth a minute of Rocket's attention.

| Call | What was picked | Why |
|---|---|---|
| Seed palette hex values | green/red/amber/purple + magenta-on-black for `unknown` | Distinct at a glance; `unknown` deliberately matches nothing else. Red/green is the known accessibility problem, mitigated by every renderer drawing the label. |
| `on-air` and `recording` as separate rows | separate | They give a passer-by different instructions. Having both is the point of v2. |
| `dnd` dropped from the seeds | dropped | Not in Rocket's list; `on-air` covers it; re-adding is one row in the UI. |
| Row field named `busy` | `busy` | Not `intended` (it is a property, not an intention) and not `onAir` (`on-air` is a row id). |
| `source` requirement | **required and prefixed on `PUT /state`, optional on the convenience routes** (D-41) | An earlier draft was forgiving everywhere, which let a robot silently gain human authority. Rocket confirmed VCREC is not written yet, so there was no ergonomics cost to getting it right. |
| Factory reset regenerates the passphrase | random, shown once | A known default passphrase is a LAN backdoor. The brief said "both to defaults" but never named a default passphrase. |
| Admin session lifetime | 12 h sliding, memory only | Invisible at home under the waiver; one login away from home. |
| Rotation grace window | 60 minutes | Long enough to walk the house, short enough not to be a second credential. |
| ESP32 config poll interval | 300 s + `If-None-Match` | "Within one poll interval" without polling a monthly-changing table. |
| Max rows | 64 | Panel sanity and Companion preset count. Arbitrary. |
| Duplicate labels | warn, do not block | Confusing, not dangerous. |
| Admin UI section order and names | Status / States / Admin settings / Network / Light | Live readout first, then the thing he actually came for. |
| "Busy / Calm" as the toggle wording | that | Reads better than "on/off" next to a light that is literally on or off. |
| Passphrase shown in plaintext | shown | He has to read it to type it into three other places. |
