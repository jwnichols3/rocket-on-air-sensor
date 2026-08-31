# Context

## Problem

Rocket wants a physical on-air light that turns on automatically when he is in a Zoom or
Google Meet call, and off when the call ends. The light lives on/near another computer or
device elsewhere in the house, so the sensing machine must send a message across the
network.

## Architecture sketch

Hand-drawn diagram: `docs/diagrams/on-air-sensor-sketch.png` (ingested 2026-08-05).

```
Laptop (work Mac)                    Receiver (Raspberry Pi)          On-air light
+------------------+                 +----------------------+         +-----------+
| Zoom  \           send message     | REST API service     |  BT /   | tally /   |
| Meet  --> Detector ==============> | - set ON / OFF       | =====>  | busylight |
|                  |    (network)    | - query status       |  Wi-Fi  | (battery) |
+------------------+                 +----------------------+         +-----------+
  turn ON when call launched            ^ also accepts manual
  turn OFF when call closed               on/off + status queries
                                          from any client
```

Key constraint driving the split: **the light-control logic must NOT live on the work
computer.** The work Mac only ever sends "call started / call ended" signals. Everything
else (state, light control, API) lives on the receiver.

## Requirements

- Detector (work Mac): fire ON when a Zoom/Meet call launches, OFF when it closes.
- Receiver (Mac Mini now, Raspberry Pi later - D-4): hosts a REST API that is the
  system's source of truth.
  - Endpoint to set on-air state ON/OFF (used by the detector AND usable manually,
    independent of any call sensing).
  - Endpoint to query current on-air status.
- Light: connects to the Pi over Wi-Fi or Bluetooth (MUST - no GPIO wiring). Preferred:
  battery operated, so there is no mains cord at the light's location. Bonus: the product
  family offers both a wireless and a wired variant, ideally behind the same API. Extra
  credit: the device can be **polled** for its actual on/off state - a genuine device
  read, not an echo of the last write - so `confirmed` reflects reality, not intent.
  Full option slate: `docs/research/2026-08-10-onair-light-hardware-slate.md`.
- Distribution to the Pi should be dead simple - `npx <pkg>` or similar one-command
  install/run. Publishing to Rocket's GitHub (jwnichols3) is available if needed.
- Rocket has Raspberry Pis on hand and can give SSH access to one for development.

## Domain glossary

- **Detector** - an *external* client that decides "call in progress: yes/no" and writes
  the result to the On-air API. Since D-30 it lives outside this repo entirely (the VCREC
  project); nothing here imports it or knows its shape. It is distinguished on the wire only
  by `source` on a write.
- **Receiver** - the role of the device/computer that receives the state change and
  drives the light. Mac Mini first (development), Raspberry Pi as the long-term host
  (D-4). Never the work Mac.
- **On-air light** - the physical light or display. Since D-16: a DIY ESP32 running
  ESPHome, driving an SH1106 OLED today and a colour lamp later (D-20). Since D-28/D-37 the
  firmware lives in `firmware/` in this repo.
- **State table** - the user-editable set of rows defining everything the light can say
  (D-31). Fowler's **knowledge level**: rules, not facts. Registration policy: first come
  first served, registrant is the LAN admin via the admin UI. **Replaces the ladder.**
  *Not* "option table" and *not* "config" - the user is defining what the light means, not
  filling a dropdown.
- **Row** - one entry in the state table: `id`, `label`, `color`, `bgcolor`, `description`,
  `busy`, `order` (D-31).
- **`id`** - a row's immutable slug. The **only** addressable handle: the one thing clients,
  Companion buttons and the device name on the wire. Never renumbered, never renamed
  (D-31/D-34).
- **`label`** - a row's human phrase, freely editable, drawn by every renderer and carried
  alongside the `id` in every status response. **Never a key.**
- **`busy`** - a per-row boolean: does this state mean the camera may be live. Carries the
  entire safety axis - it defines `intended`, and it is what the staleness rule is written
  over (D-31/D-32/D-33).
- **`order`** - a row's display sort hint. Presentation only. **Never on the wire, never an
  address** (D-31/D-34).
- **Profile refresh** - Rocket's phrase for the config pull: a renderer fetching the state
  table from `GET /config/states` on its own slow schedule (D-38). *"Profile" is a button
  label, not a domain word* - the thing itself is the **state table**. The rule it enforces
  (D-42): **presentation travels with the profile, semantics travel with the state.** `label`,
  `color` and `bgcolor` never ride on a state change; `busy`, `intended` and `confirmed` do.
- **Current state** - the operational level: a **reference to a row**, not a copy of one
  (Type Object). Stored as an `id`.
- **Last write wins** - the precedence rule, and there is no other (D-126). Every write with a
  valid body is applied; no `source` outranks another and no earlier write can block a later
  one. A manual override is an ordinary state write, and the detector's next write replaces it.
- **`source`** - `kind:label`, where `kind` is `auto` or `human`. Wire contract, because
  under D-30 it is the only trace the detector leaves here. An absent or unprefixed `source`
  reads as `human:`. **Provenance, not authority** (D-126): it says who wrote, and nothing in
  the system behaves differently because of it.
- **On-air API** - the REST service on the receiver: set state, query state, serve and edit
  config. The system's source of truth, callable by the detector or any other client.
  Contract: `docs/api-contract.md`.
- **Intended state** - a derived two-value projection, `table[state].busy ? "on" : "off"`
  (D-33). Read-only on the wire; kept so a consumer that has never heard of a row invented
  tomorrow still does something correct.
- **Confirmed state** - the row `id` the light acknowledged, read back from the device
  itself, or `unknown`. Never guessed.
- **`unknown`** - the one reserved row (D-34). Undeletable, `busy: true`, conspicuous. Where
  every dangling reference resolves, and what any renderer draws when handed an `id` it does
  not know. A Null Object, not a rung.
- **Passphrase** - the machine-to-machine credential (D-35, replacing `ONAIR_TOKEN`). Gates
  data routes. Presented by the ESP32, Companion and VCREC.
- **Admin credentials** - the human credential (D-35). Gate the admin UI and nothing else.
- **Gone words.** `level` and the ladder (`available < interruptible < dnd`) no longer exist.
  Neither does `dnd` as a shipped state. Since D-126, neither does the **hold**: `hold` as a
  wire field, and `pin` / `pinned` / `unpin` as a state concept, are gone from code and docs,
  and so is `auto` as the name of a regime. Banned in code and docs: `state machine`,
  `statechart`, `transition`, `guard`, `event`, `taxonomy`, `traits`; `select` and `option`
  are ESPHome transport words only.
  Carve-outs, because these are different words that merely look alike: the firmware's
  `onair::held()` accessor and its `struct Held` (the panel's own singleton, nothing to do with
  the retired hold), `threshold`, prose like "holds a table", the ESPHome version pin, and GPIO
  pins.

## Invariants (draft)

- False OFF is worse than false ON: the light saying "not in a call" while Rocket is on
  camera is the failure mode to avoid.
- The system must recover state after either end restarts (no stuck-on light).
- Local network only is acceptable for v1; no cloud dependency required.

## Open questions

- [x] Sensing mechanism: **out of this repo's scope, see D-30.** Zoom/Meet detection is
      VCREC's job; it will be evolved to push events to this server against
      `docs/api-contract.md`. Issue #5 leaves scope with it.
- [x] Light hardware: **resolved 2026-08-23, see D-16.** DIY ESP32 (Elegoo EL-KIT-032)
      running ESPHome, firmware in `jwnichols3/rocket-esp32`. The road there:
      `docs/research/2026-08-10-onair-light-hardware-slate.md` (17 ranked buy options),
      `docs/research/2026-08-20-esp32-diy-light.md` (build-vs-buy, verdict build), and
      `docs/research/2026-08-22-wall-indicator.md` (what is readable at 20 ft). The two
      structural tensions the slate found - battery XOR genuine `confirmed`, and battery
      XOR latency - are dissolved rather than resolved: a USB-powered board whose firmware
      we write is always-awake, sub-second and honestly readable.
- [x] REST API shape: endpoints, auth, port, state model - resolved, see
      `docs/api-contract.md` and D-5..D-7.
- [x] Light behavior: **re-resolved 2026-08-23 by On-Air v2, see D-31..D-34.** D-18's three
      rungs are gone; the state set is a **user-editable state table**, seeded with
      `available` / `on-air` / `interruptible` / `recording` plus a reserved `unknown` row.
      States are still renderer-agnostic - the mono OLED and a future colour lamp are two
      renderers of one row. Colour is now a field on the row and reaches the device through
      the config pull (D-38). Colour mapping and the accessibility problem with red/green are
      in `docs/research/2026-08-22-wall-indicator.md`; the admin UI shows a live WCAG contrast
      ratio per row so a bad pair is caught at edit time (D-39).
- [x] Pi packaging: npx one-command install + systemd unit - resolved, see D-10 and
      `docs/pi-setup.md`.
- [x] How does the API confirm the light actually changed vs just recording intent?
      **resolved 2026-08-23, see D-17/D-18.** `confirmed` becomes a real `GET` of the
      device's own state, plus a frame counter so it describes pixels rather than a
      variable. Two traps drove the design: the device's write returns `200` *before*
      applying the value and silently drops invalid options, so read-back is mandatory; and
      it decays to `unknown` on stale evidence, closing a live gap where no code path could
      return `confirmed` to `unknown` without another write.

## Decisions

> **Supersession index (2026-08-23, extended 2026-08-29).** On-Air v2 rewrote the state model,
> and D-126 then retired the hold. Read this before reading any decision below it - several are
> still written in a vocabulary the system no longer uses.
>
> | Decision | Fate |
> |---|---|
> | **D-5** contract v1 state model | **Amended** by D-31/D-32/D-33, rewritten in `docs/api-contract.md` v2, and **shipped** by D-48. `level`, `onAir` and the rung routes are gone; `/on` and `/off` survive but resolve through shortcut rows. |
> | **D-6** no TTL / staleness visible, never acted on | **Intact in principle; its rule is restated** by D-32's BUSY RULE. No TTL, no decay, no auto-raise - all confirmed. |
> | **D-7** optional `ONAIR_TOKEN` | **Superseded** by D-35, **shipped** by D-51. It is the passphrase now; the env var still works as an override. |
> | **D-9** `/display` browser tally | **Intact**, and **rebuilt** by D-52: it holds no vocabulary at all now and renders any row from the table, off `GET /public/events`. Its message rule survives unchanged. |
> | **D-10** `npx github:` distribution | **Amended** by D-15 then D-37, and **executed** by D-47: the root package is now `private` with no `bin`, so the `npx github:` path no longer resolves an executable. `deploy/get-onair` is the install path. |
> | **D-11** hand-rolled WebSocket | **Intact and deployed.** The zero-dependency rule that justified it was never a rule (D-29); the code is not revisited. Its feedback wiring survives v2 because of D-33. |
> | **D-12** light hardware on hold | Already superseded by D-16/D-18/D-21. |
> | **D-13** LaunchDaemon supervision | **Intact**, but the plist's `ProgramArguments` path changes once with D-37's layout, carried by `onair update` - built and tested in D-47, and **not yet applied on this host** (it needs one sudo run). |
> | **D-14** config-file-first install | **Amended** by D-36, **shipped** by D-50. `config.env` retires as the config source and survives as an env overlay. The claim that the plist carries no `ONAIR_*` was **not true on this host** - it carries `ONAIR_PORT` and `ONAIR_STATE_FILE`, which D-47's re-render removes. See D-50. |
> | **D-16** firmware in a separate repo | **Reversed** by D-28, implemented by D-37 and **done** in D-47. Firmware lives in `firmware/`. The ESPHome `2026.8.0` pin and its warning survive. |
> | **D-17** device transport over plain HTTP | **Intact**, **amended** by D-38: the device entity moves from `select` to `text`. Basic auth stays mandatory and stays separate from the passphrase. |
> | **D-18** three-rung ladder | **Superseded** by D-31 (table), D-32 (busy rule), D-33 (`intended`), and **deleted from the code** by D-48. `level`, `onAir` and the rung routes no longer exist. |
> | **D-19** hold as a floor | **Superseded** by D-32, **shipped** by D-49, and **retired outright** by D-126. There is no floor and no pin; the last valid write wins. |
> | **D-21.1** reconciliation merges only on contradiction | **Intact in spirit**, restated over `busy` rather than rungs. |
> | **D-21.2** a manual write below the floor releases the floor | **Superseded** by D-32, shipped in D-48/D-49, and **moot since D-126**: with nothing to release, a manual write is just a write. |
> | **D-22** ESP32 integration live and accepted | **Intact.** All three sub-findings survive; D-22.3 (a write is not confirmed by the next read) is re-verified against `text` in D-38. D-22.1's `Render` sensor gains a fifth branch in D-46. |
> | **D-23** `ONAIR_TOKEN` set on this host | **Superseded** by D-35 and D-51. The value now lives in `config.json`'s `auth` block; the env var overrides it. |
> | **D-24** loopback alone does not authenticate; `Origin` does | **Survives, unweakened**, cited verbatim by D-35 and **implemented clause by clause** in D-51. Both measured attacks are regression tests, at the unit level and over HTTP. |
> | **D-25** `/ui` and `/display` unauthenticated | **Amended** by D-35, **executed** by D-52 and **completed** by D-53: `/ui` is a `404`; `/display` and the admin console's shell are unauthenticated and byte-identical for every caller. |
> | **D-26** SwiftBar, not a native app | **Survives**, confirmed. |
> | **D-27** one credential, no read/write split | **Carried forward** onto the passphrase by D-35, shipped in D-51, and sharpened: the split that *does* exist is machine credential vs human admin credential, which is a different axis. |
> | **D-30** the detector is decoupled | **Intact**, and load-bearing: it is why `source` is wire contract in D-32. |
> | **D-32** unprefixed `source` reads as `human:` | **Amended** by D-41: required and prefixed on `PUT /state`, optional on the convenience routes. The grammar survives D-126; what it means does not. `auto:` and `human:` are provenance now, so an unprefixed `source` mislabels a writer and breaks nothing. |
> | **D-32** THE PIN RULE (hold as a pin, with the `busy: false -> busy: true` carve-out) | **Retired** by D-126. There is no hold, no pin, no `409` on a state write and no escalation carve-out. THE BUSY RULE from the same decision is **intact** - it never depended on the pin. |
> | **D-38** ESPHome cannot serve a custom device page or persist a table | **Corrected** by D-40. It can, via an external component. D-38's architecture stands; only its feasibility verdict was wrong. Its `select`->`text` half is proven by D-44 and **shipped** by D-46; the `select` no longer exists. Its **config-pull half is shipped by D-54**, which also removes the last hardcoded row list from the firmware. Its claim that `mode: password` keeps a value out of the device's REST API is **factually wrong and corrected by D-55** - a second feasibility-shaped error in the same decision. |
> | **D-40** ESPHome CAN serve a custom page, via an external component | **Narrowed** by D-57. The verdict was right and the mechanism was not: `web_server_base::add_handler()` registers a handler on the server ESPHome already runs, so the page needed two headers and no component. D-40's evidence - the `add_handler` / `canHandle` surface, `captive_portal` using it in-tree - is exactly what made that possible, and its NVS-persistence half is **shipped** by D-57 for the overlay only. |
> | **D-55**'s operational note, *"rotating it in the admin console is cheap ... it is on the review list"* | **Retired** by D-61. The defaults are the product, the way a router's are. The first-run change is the operator's step, not remediation, and it is not an open item to keep raising. |
> | **D-31** "colour is on the wire" | **Narrowed** by D-42: colour is in the profile (`GET /config/states`), never on a state change. Presentation travels with the profile, semantics with the state. |
> | **D-42** presentation travels with the profile; the version nudge | **Shipped** by D-53 (server payload) and D-54 (the nudge, and the device end of the pull). The nudge fires on a state write *and* on a config save. |
> | **D-49** the pin refuses and the held state stands | **Retired** by D-126, along with `judgeWrite()`, the `409` settle-back and the `human:hold` source value. Read its closing line - *"the pin is what the system falls back TO, not merely a veto"* - as a description of the refusal path, not of an invariant: D-126 deletes the refusal, and the false ON that sentence guards against goes with it. |
> | **D-120** a Companion press stays `human:`, and the pin it drops is announced | **Retired** by D-126. No press can drop a pin, so the `leave`/`pin`/`release` option, `pin_current_state`, `release_hold`, the two hold feedbacks, `$(hold)`/`$(hold_label)` and the PIN/UNPIN presets all go. Its load-bearing half survives as a general rule: `POST /state/{id}` always SETS the row named in the path. Module `0.2.0` -> `0.3.0`; buttons already placed on a deck are orphaned. |
> | **D-118** *"`409` is three different things and only one carries a status body"* | **Inverted** by D-126. There are four `409`s now, none of them a write refusal and **none carrying a status body**: an unset `/on`/`/off` shortcut row, a stale config `version`, a config save that failed for a reason other than disk-full, and a rebind that rolled back. Every one means a person must change something. D-118's other two corrections (the 16 KB `400`, the `403` rows) stand; its `holdFromQuery` note describes a function that no longer exists. |
> | **D-133** *"Two buttons, not one toggle"* | **Amended** by D-134. The reasoning was sound about a toggle that remembers its own PRESSES, and that toggle is still not built. `POST /panel/toggle` reads the glass on every press and holds no state, so the objection - that "asked to sleep" and "is asleep" come apart - does not reach it. Both one-way buttons survive unchanged. |
> | Every decision that **enumerates `hold` as a wire field** - D-30, D-32, D-35, D-36, D-48, D-51, D-52, D-63, D-75, D-91, D-121, D-122 | **Read them without it.** The bodies are left alone on purpose - a decision is a record of what was decided, not a description of today - but `hold` is off the wire, out of the state object and out of the persisted file since D-126, so every list of payload fields, every "factory reset clears the hold", and D-51's *"`/display` needs `message` and `hold`"* is one item shorter - D-52 had already taken the HELD badge off that page. Nothing else in any of them moves. |

- **D-1 (2026-08-05)** Receiver is a Raspberry Pi hosting a REST API; the work Mac runs
  only a thin detector that calls that API. Rationale: light-control logic must not
  live on the work computer.
- **D-2 (2026-08-05)** Build order: REST API core first (on a non-work computer),
  detector integration later as a separate module/plugin that calls the API.
- **D-3 (2026-08-05)** Manual control is a first-class requirement: the API must allow
  setting and querying on-air state independent of any call sensing.
- **D-4 (2026-08-05)** "Receiver" is a role, not a device. Develop and run the API on
  the Mac Mini first (fast iteration, local troubleshooting); once working, package it
  for the Raspberry Pi as the long-term host. Amends D-1: the Pi is the eventual
  deployment target, not the only host. D-1's rationale is unchanged - the Mac Mini is
  not the work computer.
- **D-5 (2026-08-05)** API contract v1 (full spec: `docs/api-contract.md`): canonical
  idempotent `PUT /state` plus no-body `POST /on`/`POST /off` conveniences for manual
  control; `GET /status`. State distinguishes intended vs confirmed; writes succeed
  even when the light is unreachable (surfaced as `confirmed: unknown`).
- **D-6 (2026-08-05)** No TTL/auto-OFF. Detector heartbeats by re-sending state
  (~60s, client-side convention); staleness is visible via `updatedAt`/`ageSeconds`
  but never acted on. Only an explicit write turns the light off. Rationale: false
  OFF is worse than false ON; "no stuck-on light" is met by manual OFF + visible
  staleness.
  **Amended by D-18** and restated on the ladder: *the server never lowers `level`, and
  never asserts a lower rung to the light, without fresh evidence (`ageSeconds <= 90`).
  Raising or matching is always allowed. Staleness remains visible and never acted on.*
  The original wording forbade only downgrades that end at the bottom, so on a three-rung
  ladder `dnd -> interruptible` on a timer was a brand-new failure its words did not cover
  but its rationale plainly forbids.
- **D-7 (2026-08-05)** Auth: optional shared bearer token (`ONAIR_TOKEN` env var),
  off by default; LAN-only exposure is the baseline security model. Port 8484.
- **D-8 (2026-08-05)** Runtime: Node.js + TypeScript. Confirmed via a judged LLM
  bakeoff (Node/Python/Go advocate briefs + judge; full verdict on issue #3).
  Decisive weight: reliability of AI-agent-driven development (compiler feedback,
  ecosystem). Revisit triggers: if the chosen light is BLE and a Pi hardware spike
  shows Node BLE libraries unreliable vs Python's bleak -> Python; if cold-machine
  install simplicity becomes dominant -> Go (static binary).
- **D-9 (2026-08-05)** Interim light: a browser tally page served by the API
  (`GET /display`, Pi in kiosk mode on a small screen) until real hardware lands.
  Adds to the contract: a `message` resource (`PUT`/`DELETE /message`) independent of
  on-air state so heartbeats can't clobber it, and SSE (`GET /events`) for live
  updates. Safety rule: the display's background color always reflects on-air state;
  a message can never hide ON AIR. Spec:
  `docs/superpowers/specs/2026-08-05-onair-display-design.md`.
  **Amended by D-18/D-21:** the page now has **four** appearances (`available`,
  `interruptible`, `dnd`, `unknown`), and the message rule extends to all of them - a
  message renders as a subordinate line and may never replace the state word. The page also
  now ships as `unknown`/NO DATA rather than asserting OFF AIR before any data arrives.
- **D-10 (2026-08-05)** Distribution: `npx --yes github:jwnichols3/rocket-on-air-sensor`
  (npm `bin` + `prepare` build; no npm publish), systemd unit template in `deploy/`,
  setup + kiosk doc in `docs/pi-setup.md`. Tradeoffs accepted for a home project:
  needs git+network at (re)start and builds on install; pin a tag/commit when
  reproducibility matters. Kiosk Pi can point at any host's `/display` - it does not
  need to run the API itself.
- **D-11 (2026-08-05)** WebSocket status endpoint (`GET /events/ws`, for Bitfocus
  Companion's generic-websocket module) is hand-rolled rather than adding a `ws`
  dependency: usage is server-push-only, which keeps the implementation small and
  preserves the zero-production-dependency rule. Limits documented in code: inbound
  frames ignored except ping/close. Research: `docs/research/2026-08-05-companion-integration.md`;
  Companion config: `docs/companion-setup.md`.
- **D-12 (2026-08-05)** Light hardware is ON HOLD: the `/display` browser page (D-9)
  is the light, not just an interim. #1 (hardware pick) and #6 (LED driver) are
  parked; the hardware research doc stands ready for whenever this reopens.
  Consequence: `confirmed` stays `"unknown"` (no-op driver), so all status feedback
  (display, Companion) keys off `intended`.
  Note (2026-08-10, no decision changed): the second research pass
  (`docs/research/2026-08-10-onair-light-hardware-slate.md`) falsifies the premise behind
  that consequence - a genuine `confirmed` is now buyable for ~$15 (Athom Tasmota plug,
  `GET /cm?cmnd=Power`) or ~$28 (Shelly 1 Gen4, `Switch.GetStatus` -> `output`). The hold
  stands until Rocket picks hardware; #1 and #6 stay parked.
  **Superseded by D-16/D-18/D-21 (2026-08-23):** hardware is chosen and built (DIY ESP32),
  `confirmed` is a genuine device read, and status feedback keys off `level`, with
  `intended` retained as a derived field for compatibility.
- **D-13 (2026-08-06)** Mac Mini service management: a system-domain **LaunchDaemon**
  (`com.rocket.onair`, `UserName=john`, `KeepAlive`) supervising `node dist/index.js`
  from a local checkout - chosen over pm2/brew-services/LaunchAgent via a judged
  3-advocate bakeoff (issue #12 has the full verdict). Admin interface is layered:
  an `onair` shell CLI wrapping launchctl (the only layer that can cold-start a dead
  service), authed `GET /admin/health` + `POST /admin/restart` routes (restart =
  exit cleanly, supervisor respawns - identical under Pi systemd), and an Admin card
  on `/ui`. Zero new dependencies; symmetric with `deploy/onair.service`. Revisit
  if: FileVault gets enabled (verified OFF 2026-08-06), a permanent GUI login makes
  the LaunchAgent+menu-bar path attractive, or real multi-process needs emerge.
- **D-14 (2026-08-06)** Host install is config-file-first and wizard-driven: the
  service reads `~/.onair/config.env` itself at startup (Node's stable
  `process.loadEnvFile`; real env still wins), so the plist/unit carries no
  `ONAIR_*` config and never changes after install. Fresh install is `git clone` +
  `sudo deploy/bootstrap` on both hosts; install runs an interactive `onair setup`
  Q&A (port, token, state file) that is re-runnable anytime to change config
  (rewrite file + restart - no re-render, no reload trap). `onair update` is the
  single health-gated update verb with automatic rollback. The Pi unit drops
  `npx github:` at boot (network-dependent start, verified exit-128-silent failure)
  for a local checkout. Research: `docs/research/2026-08-06-host-install-simplification.md`.
  Rejected there with evidence: Node SEA/compiled binaries, Docker on the Mac,
  Nix, Ansible (deferred until the Mac needs multiple launchd jobs).
- **D-15 (2026-08-06)** One-line install: `curl -fsSL .../deploy/get-onair | bash` -
  a thin self-contained shim that clones the repo to a stable home
  (`~/code/rocket-on-air-sensor`, `ONAIR_DIR` overrides) and hands off to
  `deploy/bootstrap`, which self-escalates (per-command sudo, prompted once) so no
  command is typed with a `sudo` prefix. The shim reconnects stdin to `/dev/tty`
  when piped so the setup wizard still asks its questions (the Homebrew lesson).
  npx-based install rejected: the npx cache is not a stable home for a plist to
  point at, and it double-builds; amends D-10 - `npx github:` remains only a
  throwaway demo, never an install or boot path.
- **D-16 (2026-08-23)** Light hardware: **DIY ESP32** - the Elegoo EL-KIT-032 DevKit board
  running **ESPHome** on `framework: esp-idf`, with an SH1106 128x64 mono OLED. Lifts the
  D-12 hold; #1 and #6 unpark. Firmware lives in its own **private** repo,
  `jwnichols3/rocket-esp32` (`~/code/esp32`), not in this one - it already existed as a
  working lab with its own uv/Makefile toolchain, so D-19's "`firmware/` in this repo"
  proposal from `docs/research/2026-08-20-esp32-diy-light.md` is **rejected in favour of the
  split that already happened**. The wire contract stays here in `docs/api-contract.md`,
  which is what survives the split in both directions. Chosen over the 2026-08-10 slate's
  Athom WLED Slim ($11.85) because it is the only option that is always-awake, sub-second and
  honestly readable at once, and because Rocket wants agent-built firmware. ESPHome is pinned
  to `2026.8.0` in `pyproject.toml`: the REST URL scheme **changed in that release** (the
  entity *name* replaced `domain-object_id`), so an unreviewed bump silently breaks every
  driver URL. Re-run the wire transcript after any bump.
- **D-17 (2026-08-23)** Device transport: **plain HTTP on port 80** via ESPHome's
  `web_server` (`version: 2`, no `local:`), served by ESP-IDF's `esp_http_server` - no
  framework switch, +26 KB flash, measured 51.2% total. `POST /select/Presence/set?option=X`
  to write, `GET /select/Presence` to read. The native API (6053) stays enabled for
  `make logs` / `make flash` only. Rejected: the native API as the driver transport - it
  would cost ~600 lines of hand-rolled Noise crypto against ~110 lines of `fetch`, and D-11
  authorises hand-rolling *small* things, which this is not. **Basic auth is mandatory**
  (`type: basic` written out explicitly - the default flips to digest in ESPHome 2027.1.0):
  the write is a CORS *simple request*, so without auth any web page Rocket visits can force
  `available` on the device, and `confirmed` would faithfully vouch for it. This credential
  is separate from D-7's `ONAIR_TOKEN` - that guards clients->API, this guards API->device.
  Two facts the driver must respect: the write's `200` is sent *before* the value is applied
  and invalid options are silently dropped, so **read-back is mandatory**; and an unmatched
  URL closes the socket with no HTTP response, surfacing as `ECONNRESET`, which looks exactly
  like a dead device.
- **D-18 (2026-08-23)** State model: **three rungs on a ladder** -
  `available(0) < interruptible(1) < dnd(2)` - stored as one field `level`. Names are
  semantic, not colours: the mono OLED and a future colour lamp are two renderers of the same
  state. `intended` survives as a **derived, read-only projection** (`level === 'available'
  ? 'off' : 'on'`) kept on the wire *and* on disk, so Bitfocus Companion (D-11), week-old
  kiosk tabs (D-9/D-10) and a D-14 rollback all keep working; removing it is a separate,
  later, boring ticket. **Amends D-6**, and the amendment is written on the ladder rather
  than as "no auto-GREEN", because on three rungs a `dnd -> interruptible` decay is a new
  failure D-6's words do not cover but its rationale plainly forbids:
  > **The server never lowers `level`, and never asserts a lower rung to the device, without
  > fresh evidence (`ageSeconds <= 90`). Raising or matching is always allowed. Absence of
  > information never renders below `dnd`.**
  Auto-*raising* on staleness is also rejected: it manufactures a state nobody asserted, is
  sticky, and staleness already has a home in this system - presentation (the STALE badge),
  not state. **Amends D-12**: its "`confirmed` stays `unknown`" consequence is retired -
  `confirmed` becomes a real device read plus a frame counter, so it describes pixels rather
  than a variable.
- **D-19 (2026-08-23)** **Manual hold**, built in v1 rather than deferred (Rocket's call,
  2026-08-23, against the recommendation to defer until the detector exists). A manual write
  may set a **hold**, which is a **floor on `level`**, persisted, and visible in
  `GET /status` and on the device. Rules: writes with `source: "detector"` may **raise** the
  level above the floor but may **never lower it below** the floor; manual and direct API
  writes always apply and may move or clear the floor. The floor deliberately does not block
  escalation - blocking a detector's `dnd` would leave the light saying "come in" while
  Rocket is on camera, which is the invariant violation in a new costume. The floor
  **persists through** an escalation, so when a call ends and the detector writes
  `available`, the hold blocks that lowering and the light settles back to the held rung -
  "I am interruptible today" survives a meeting. **Release is explicit only, never a TTL**,
  consistent with D-6. The hold is intent, like `intended`, so it never decays like
  `confirmed` does. This gives `source` (`docs/api-contract.md`) real precedence semantics
  for the first time; the contract's "no precedence semantics in v1 (last write wins)" line
  must be updated.
- **D-20 (2026-08-23)** Renderers: the colour lamp, when it lands, is a **second renderer on
  the same ESP32**, not a second device - the OLED sits on I2C and a WS2812 strip on the RMT
  peripheral with no conflict, GPIO4 is free, and it costs extra YAML with **zero new
  TypeScript**. The state model is renderer-agnostic by construction (D-18), so this is a
  firmware-only change. Deferred until the HTTP integration works end to end: a renderer
  cannot be debugged before there is state to render. Research:
  `docs/research/2026-08-22-wall-indicator.md` - which also establishes that **no OLED at any
  price reaches 20 ft** (the market ceiling is a 5.5" 256x64 at ~11.9 ft), so the wall
  indicator for the stairs is a colour glow and the OLED is the close-range readout.
- **D-21 (2026-08-23)** **Step 1 of the ESP32 integration is implemented** on branch
  `three-state-esp32` (spec: `docs/superpowers/specs/2026-08-22-esp32-integration-design.md`,
  repo delta a-j; handoff: `docs/superpowers/plans/2026-08-23-esp32-integration-handoff.md`).
  `npm test` 145/145, `npx tsc --noEmit` clean, `/display` and `/ui` verified in a real
  browser. Two corrections to the written design were required and are the decision here:
  1. **Reconciliation merges only on contradiction.** The spec resolved a loaded state file
     as `higher(level, intended)` unconditionally. Because `levelToOnOff('interruptible')`
     is `'on'`, that promoted **every `interruptible` file to `dnd` on restart** - the
     middle rung could never survive a restart, which would have silently gutted D-19 the
     first time the service was restarted. The rule is now: when `level` and `intended`
     agree the file is self-consistent and `level` is authoritative; take the higher rung
     **only when they contradict each other**, which is exactly the rolled-back-binary case
     the merge existed for.
  2. **A manual write below the floor releases the floor.** D-19 said other sources apply
     their level "as given", which left `level: available, hold: interruptible` reachable -
     a floor above the level, contradicting itself in `GET /status`, and armed to yank the
     light back to yellow on the next detector write. An explicit human instruction wins:
     asking for a lower rung by hand clears the hold.
- **D-22 (2026-08-23)** **The ESP32 integration is live and accepted.** All ten steps of
  the spec are done; the acceptance transcript is on issue #6, which is closed. The
  service on 8484 (D-13 LaunchDaemon) now drives the real light; `confirmed` is a genuine
  device read. Soak over 61 minutes: 240/240 polls, 240/240 API-device agreement, zero
  frame-counter resets (so zero reboots across four missed 15-minute windows - the proof
  that `api: reboot_timeout: 0s` works), median set->confirm 120 ms, zero unprovoked
  supervisor deferrals. Three decisions fall out of doing it:
  1. **The device publishes what it drew.** A `Render` text sensor exposes which branch
     the display lambda took, so `GET /text_sensor/Render` reports what is on the glass.
     `confirmed` can now mean "the panel drew this", not "a variable holds this". This was
     added because the one state that matters most - a stale `available` refusing to
     render calm - is on screen only between the device going stale and the next
     heartbeat, so an observer glancing at the panel reliably sees the wrong thing and
     concludes the branch is broken. That happened, and cost a round trip to disprove.
  2. **Deferring to the device must adopt the device.** Refusing to push a stale lower
     rung DOWN is right (D-6/D-18), but leaving `level` untouched afterwards strands every
     other renderer on the old value forever. Both the boot path and the supervisor now
     adopt the rung they defer to; raising is always ladder-legal.
  3. **A write is not confirmed by the next read.** `web_server` answers the POST before
     applying the value, so a read-back issued immediately can return the value just
     overwritten. The driver re-reads across that gap. Observed live, not theorised.
  Operational note: `onair restart` needs sudo with a TTY. An agent can cycle the daemon
  by killing the process and letting `KeepAlive` respawn it against a rebuilt `dist/`.
- **D-23 (2026-08-23)** **`ONAIR_TOKEN` is now set on this host, and the API is no longer
  unauthenticated.** D-7 left the token optional with "LAN-only exposure is the baseline
  security model", which was defensible while the light was a browser page. It stopped
  being defensible the moment the API drove real hardware: `POST /available` carries no
  body and no `Content-Type`, so it is a **CORS simple request** - any page Rocket visits
  could fire it and force the light green while he was on camera. Verified before the
  change: `POST /available` with `Origin: https://evil.example` returned `200`. This is
  the same "remote false-green primitive" argument that D-17 used to justify basic auth on
  the *device*, and closing it there while leaving it open on the server achieved nothing,
  because the server holds the device credentials and relays faithfully. The token lives in
  `~/.onair/config.env` (0600), not in the plist. Consequences: the Companion websocket URL
  and the `/display` kiosk URL both need `?token=`; both docs updated.
  Also fixed alongside: **`repainted()` must distinguish "cannot tell" from "frozen".** The
  device republishes `Frames` on its own 5s interval and the supervisor polls at 5s, so two
  consecutive reads routinely see the same value. Reporting that as a stuck panel dropped
  `confirmed` to `unknown` on a healthy display - observed 3 times in a 61-minute soak. An
  unchanged counter now returns `null` until it has been static longer than any plausible
  publish interval; a counter that goes *backwards* reads as a reboot, which is a repaint,
  not 20 seconds of frozen panel.
  **Known limitation, accepted (2026-08-23):** the token travels in a **URL query string**
  for `GET /events`, `GET /display`, `GET /ui` and the WebSocket upgrade. This is not a
  choice - `EventSource` and `WebSocket` cannot set an `Authorization` header, and neither
  can a top-level document navigation. An automated review flagged it and proposed
  scrubbing the token with `history.replaceState` after load; that was tried and
  **reverted**, because the document request for `/ui` is itself gated, so a scrubbed URL
  turns the browser refresh button into a logout. Mitigation taken instead:
  `<meta name="referrer" content="no-referrer">` on both pages, so the token never leaks
  via `document.referrer`. The residual exposure is browser history and the address bar
  during a screen share. Removing it properly needs one of: (a) a session cookie set on a
  valid query-token GET, which brings CSRF back into scope on a server whose write routes
  are deliberately CORS-simple, or (b) serving `/ui` and `/display` unauthenticated - they
  interpolate no state and are identical for every caller - while keeping every DATA route
  gated. **(b) is the cheaper and probably correct answer; it is a policy change and has
  not been made unilaterally.**
- **D-24 (2026-08-23)** **Loopback alone does not authenticate. `Origin` does.** The owner
  proposed waiving auth for localhost, on the reasoning that "it is localhost, so that is
  not a security hole". **Measured, and the premise is false:** a page served from a
  different address performed `POST /available` (no body, no `Content-Type`, so a CORS
  simple request needing no preflight) against a loopback port, and the server saw
  `remote: 127.0.0.1` with `origin: http://10.42.14.189:9099`. A `remoteAddress` check
  passes that attack. Repeating it from a different **port on the same host** returned
  `Sec-Fetch-Site: same-site`, so rejecting only `cross-site` also fails - a port is not
  part of a "site". `Origin` was present and wrong in both cases. **Ruling: the token is
  waived only when the connection is from loopback AND `Host` names a loopback name on our
  port AND `Origin` is either absent or exactly one of ours; and never when `Sec-Fetch-Site`
  is present and is anything other than `same-origin` or `none`.** Explicitly NOT protected:
  malware already running as this user (it can read `~/.onair/config.env` and take the token,
  so demanding one buys nothing), and a second human account on this Mac (accepted; single-user
  machine - **revisit if that changes**). The two attacks become regression tests.
- **D-25 (2026-08-23)** **`/ui` and `/display` are served unauthenticated; every data route
  stays gated.** Both are single template strings with **zero `${}` interpolations**, so they
  are byte-identical for every caller and disclose nothing. Gating them bought no
  confidentiality and cost three real things: the token in the address bar and browser
  history, a `401` on refresh (a top-level navigation cannot carry an `Authorization`
  header), and a raw-JSON error page that is a dead end for a human. This supersedes the
  recommendation recorded in D-23, which flagged it and left it for Rocket to decide.
- **D-26 (2026-08-23)** **Menu bar control is a SwiftBar plugin, not a native app.** The
  privileged half already exists and is merely uninstalled: `onair install --sudoers` writes
  a narrowly scoped `/etc/sudoers.d/onair` (seven `launchctl` subcommands, this label and
  plist only, `visudo -cf` validated). With it present, a menu bar tool needs no privilege
  machinery - it shells out to `onair`. A native Swift `MenuBarExtra` was rejected: Xcode or
  a hand-rolled build, an app bundle and a login-item registration, to arrive at something
  that shells out to `onair` anyway. Accepted cost: SwiftBar is a third-party app to install
  once (`brew install --cask swiftbar`, MIT, actively maintained, macOS 26 compatible).
- **D-27 (2026-08-23)** **One token, not a read/write split - for now.** The owner asked
  whether network access should be read-only. Establishing the fact he was unsure about:
  **the ESP32 is not a client of this API** - the service is an HTTP client of the *device*
  (`src/esphome-driver.ts`), so nothing needs a token to reach the light. Inbound clients are
  the two pages, SSE, the WebSocket, Companion and phone Shortcuts. Since control is what
  happens locally (and D-24 covers it), and the network consumers that would take a read-only
  credential live on the same LAN already trusted, a split adds config surface and revocation
  complexity for little gain. **Revisit if** the kiosk moves somewhere physically untrusted,
  or anything is exposed beyond the LAN. `?token=` stays available for `EventSource`, the
  WebSocket and the remote kiosk, none of which can send a header - after D-24/D-25 it is
  needed only off-machine.

- **D-28 (2026-08-23)** **Monorepo: all four parts live in this repo.** On-Air v2 has four
  surfaces - the server, the admin UI, the ESP32 firmware, and a Bitfocus Companion module -
  and all of them are directories here, not separate repos. **Reverses D-16's split.** D-16
  put the firmware in a private `jwnichols3/rocket-esp32` on the reasoning that it "already
  existed as a working lab with its own uv/Makefile toolchain, so the split already
  happened". Rocket's ruling (2026-08-23): that repo was set up "as an example, not
  necessarily to store things in", and he is "fine replicating whatever we need for making
  the ESP32 work locally". What D-16 got right survives: `docs/api-contract.md` is the wire
  contract and is what holds the parts apart. What changes is that the seam is now a
  directory boundary rather than a repo boundary, which is cheaper to keep honest - a
  contract change and its two implementations land in one diff.
- **D-29 (2026-08-23)** **Dependency policy: minimal, necessary, trusted - not zero.** The
  "zero production npm dependencies" hard rule this repo has enforced since day one **was
  never decided by anyone.** Traced 2026-08-23: it entered as a `Tech Stack:` line in the
  first plan (`docs/superpowers/plans/2026-08-05-onair-api-service.md`), was copied forward
  verbatim into every subsequent plan and spec, and D-11 then cited it as pre-existing
  ("preserves the zero-production-dependency rule") rather than establishing it - laundering
  a copied line into a decision that later work treated as binding. It appears in no
  `CLAUDE.md`. Rocket's actual rule: a dependency earns its place by being genuinely
  necessary and coming from a source worth trusting. Recorded in `CLAUDE.md`; every older
  doc asserting the zero rule is superseded. Consequence for v2: the Companion module may
  take `@companion-module/base` and the admin UI may take a frontend toolchain without
  either being an exception to anything. D-11's hand-rolled WebSocket is **not** revisited -
  it works and is deployed; the rule that justified it is simply no longer a rule.
- **D-30 (2026-08-23)** **The detector is decoupled entirely; it is a client, not a
  component.** Zoom/Meet sensing is done by a separate existing project (VCREC), which will
  be evolved to push events to this server. This repo never imports it, never names it in
  code, and never depends on its shape. **Amends D-2** (which sequenced "detector
  integration later as a separate module/plugin"): there is no detector module in this repo
  at all, later or otherwise. Consequence: `docs/api-contract.md` must be legible enough to
  be written against by a client whose source we are not reading - the contract is the only
  coupling. `CONTEXT.md`'s open question on the sensing mechanism, and issue #5, leave this
  repo's scope. `source` on a write keeps its meaning (an automated writer vs a human), which
  is what hold semantics are defined over; that is now the only trace the detector leaves
  here.

- **D-31 (2026-08-23)** **The state table: row schema, identity and seeds.** Resolves
  [#20](https://github.com/jwnichols3/rocket-on-air-sensor/issues/20). **Supersedes D-18's
  ladder.** The state set is a user-editable **state table** (the domain word - not "option
  table", not "config"; the user is defining what the light *means*, not filling a
  dropdown). Registration policy, in RFC 8126's sense: *first come first served; the
  registrant is the LAN admin via the admin UI.*
  **Identity is an immutable slug `id`**, `^[a-z0-9][a-z0-9-]{0,31}$`, unique, assigned at
  creation and never editable thereafter. Rocket reached for a numeric ID ("0, 1, 2, 3, 4
  ... all the way up to whatever"); that number becomes **`order`, a presentation-only sort
  hint** which may be renumbered freely and **never appears on the wire as an address**.
  Five independent threads converged on the ID/label split (Type Object; Matter's
  `ModeOptionStruct`; HA's `unique_id`; openHAB's `{value,label}`; Companion 5.0.x's
  one-time preset *copy*, which permanently freezes into a placed button whatever id it was
  created with). The last of those makes it a hard requirement rather than a nicety, and it
  pays forward: Companion 5.1's live-linked preset references turn "drag it again after
  every edit" into "it just updates" *only* if ids are stable across regeneration.
  **Rocket's "phrase that would be sent with the state" is honoured, not discarded:** the
  `label` travels *alongside* the id in every status response (openHAB's self-describing
  shape), so the phrase is on the wire - just not as the key.
  **Row schema:**
  | Field | Type | Rules |
  |---|---|---|
  | `id` | string | Immutable slug. `^[a-z0-9][a-z0-9-]{0,31}$`. Unique. The only addressable handle. |
  | `label` | string | 1..64 chars trimmed. Freely editable. Duplicates warn, never block. |
  | `color` | string | `#rrggbb`. Foreground/text. **Companion's field name, verbatim.** |
  | `bgcolor` | string | `#rrggbb`. Background. **Companion's field name, verbatim.** |
  | `description` | string | 0..200. A comment for humans. **Never load-bearing** (RFC 3863's warning about `<note>`). |
  | `busy` | boolean | Does this state mean "camera may be live, do not interrupt". Required; **new rows default `true`** (fail safe). See D-33. |
  | `order` | integer | 0..999. Display order only. Ties break by `id`. |
  Table rules: at most 64 rows; at least one; the reserved `unknown` row must be present
  (D-34); duplicate `id` is `400`. Colours normalise to lowercase on save.
  **No `severity` ordinal.** The safety axis is carried by the `busy` boolean alone (see
  D-32), which is the research's own recommendation - start with the boolean and add a
  precedence ordinal only when a second automated writer actually competes, at which point
  max-merge gives order-independence for free. There is one automated writer (VCREC, D-30).
  **Colour is on the wire, deliberately and against every surveyed precedent.** No presence
  system puts colour in the protocol, because a federated system must let a stranger's
  client theme the status. This system is not federated - one owner, N dumb renderers he
  also owns, none of which can carry a sitemap. Accepted cost: presentation is welded into
  the wire contract permanently.
  **Seed rows** (Rocket's list, plus the reserved row):
  | `order` | `id` | `label` | `busy` | `bgcolor` | `color` |
  |---|---|---|---|---|---|
  | 0 | `available` | AVAILABLE | false | `#0b6e2e` | `#ffffff` |
  | 1 | `on-air` | ON AIR | true | `#c1121f` | `#ffffff` |
  | 2 | `interruptible` | INTERRUPTIBLE | false | `#e8a317` | `#1a1a1a` |
  | 3 | `recording` | RECORDING | true | `#6a0dad` | `#ffffff` |
  | 99 | `unknown` | NO DATA | true | `#1a1a1a` | `#ff00ff` |
  Two sub-decisions inside the seed: **`dnd` does not survive** - it is not in Rocket's list,
  `on-air` covers it, and it is his to re-add; and **`on-air` and `recording` are distinct
  rows**, because they give a passer-by different instructions (camera live: do not enter;
  audio live: do not make noise), and having both is the entire point of v2.
  **Vocabulary.** Adopt: *state table*, *row*, *id*, *label*, *registry/registration policy*,
  and Fowler's **knowledge level** (the table) vs **operational level** (live state + hold).
  Banned: *state machine*, *statechart*, *transition*, *guard*, *event* - there are no
  transitions here, a complete graph carries zero information, and the words invite a
  contributor to invent some. Also banned at row level: *taxonomy* (the set is flat),
  *traits* (ESPHome's word, welded to "immutable, compile-time" - the exact property being
  escaped), *entity* (the panel is an entity; rows are not). `select`/`option` are confined
  to the ESPHome transport layer and are not domain words. This resolves the one recorded
  disagreement between the two vocabulary surveys in favour of the generic-patterns report.
- **D-32 (2026-08-23)** **Hold is a pin with one escape hatch, and the ladder rule is
  rewritten over `busy`.** Resolves
  [#26](https://github.com/jwnichols3/rocket-on-air-sensor/issues/26). **Supersedes D-19 and
  D-21.2, and rewrites D-6/D-18's staleness rule.** A floor over an unordered set is
  meaningless, so hold-as-floor is gone. A *naive* pin is also wrong, and there is production
  evidence: Microsoft Teams ships hold-as-pin (`user-preferred state > session-level states`),
  so a Teams user who prefers `Available` and then joins a call shows **Available** - the
  precise failure D-19 named. Teams can afford a wrong-but-chosen chat status; a light whose
  only job is to say whether a camera is live cannot.
  > **THE PIN RULE - while a hold is set, a write from an automated source is applied only if
  > it moves the system from a `busy: false` state to a `busy: true` state. Every other
  > automated write is refused (`409`) and the held state stands. Manual writes always apply;
  > a manual write naming a state other than the held one releases the hold.**
  That single carve-out reproduces every behaviour D-19 wanted and drops the wart it carried.
  Pinned to `interruptible` (`busy: false`), a detector `on-air` escalation is allowed, the
  pin survives it, and the end-of-call `available` is refused - so *"I am interruptible
  today"* survives a meeting, exactly as D-19 intended. Pinned to `recording` (`busy: true`),
  nothing automated moves it at all. And **a pin at `available` is now legal** (D-19 made it a
  `400`), because a pin at a calm state still cannot force calm against a live camera - the
  reason for the old prohibition has been designed out.
  > **THE BUSY RULE (replaces THE LADDER RULE) - the server never moves from a `busy: true`
  > state to a `busy: false` state, and never asserts a `busy: false` state to a renderer, on
  > the strength of evidence that is stale (`ageSeconds > 90`). Moving to or staying at
  > `busy: true` is always allowed. Absence of information never renders calm.**
  Every ordering word is gone and the invariant it protects ("false OFF is worse than false
  ON") is stated directly instead of encoded in a rank. `busy: true -> busy: true` changes,
  which the ladder rule had to special-case as the `dnd -> interruptible` decay, need no rule:
  they only ever happen on a write, and a write is fresh evidence by definition. As before,
  staleness is *visible*, never acted on: rather than heartbeat a stale calm state forever the
  server withholds the assertion and lets the device watchdog trip to NO DATA. That is
  withdrawal of a liveness claim, not a state change. No TTL, no decay, no auto-raise -
  confirming D-6.
  **`source` becomes contract, not an implementation detail** - under D-30 it is the only
  trace the detector leaves in this system. It is `kind:label`, where `kind` is `auto` or
  `human` and `label` is free text for display (`auto:vcrec`, `human:menubar`). An absent or
  unprefixed `source` is read as `human:` - which keeps curl, phone Shortcuts and the legacy
  `webui` working, and is the *unsafe* default, so `docs/api-contract.md` states in bold that
  **an automated writer which omits `auto:` is treated as a human and will break pins.** The
  one legacy value mapped for continuity is `detector` -> `auto:detector`.
  **Release is explicit only, never a TTL** (confirming D-6 and D-19), and **only a `human:`
  source may set, move or clear a pin.** Teams' severity-scaled hold expiry (1 day for
  DND/Busy, 7 otherwise) is recorded as a **conflict, not an adoption**. Slack's `auto` is
  adopted as the *word* for the released regime in the UI and menu bar; the wire keeps
  `hold: true|false` on a write and `hold: "<id>" | null` on a read. Slack's provenance split
  is adopted too: `GET /status` reports `source` and `hold` together, so any client can always
  tell whether the current state was held or detected.
- **D-33 (2026-08-23)** **`intended` survives, re-derived from a per-row `busy` flag.**
  Resolves [#27](https://github.com/jwnichols3/rocket-on-air-sensor/issues/27). **Amends
  D-18.** The projection `level === 'available' ? 'off' : 'on'` has no definition over an
  arbitrary table, so it is replaced by `intended = table[state].busy ? 'on' : 'off'`. The
  flag lives on the row; the derived field keeps its name on the wire.
  Four unrelated sources argued for the per-row flag: **RFC 3863 (PIDF)** requires every
  extended status value to *carry* the basic `open`/`closed` alongside it, so a consumer that
  has never heard of the value still does something correct; **Type Object** says a type
  object carries per-type data; **HA's capability-attribute split** models what a thing *can*
  be separately from what it *is*; and **the existing Companion wiring** keys its feedback off
  `$.intended == "on"`, so keeping the flag keeps the only Companion integration that exists
  working with zero config changes until a module is built.
  That last one inverts the framing the ticket was written with. D-18 kept `intended` for
  *backward* compatibility with consumers the map's Notes say are abandonable. PIDF's argument
  is **forward**-looking and does not weaken as those consumers die: the whole point of a
  user-editable table is that the state set changes *after* the consumers ship, and the flag is
  what makes a row invented tomorrow safe for a client written last month. So this is **not**
  D-18's "separate, later, boring ticket" to delete `intended`; that ticket is cancelled.
  Naming: the row field is **`busy`**, not `intended` - on a row it is a property of the state,
  not an intention - and not `onAir`, because `on-air` is a seed row `id` and reusing the
  phrase as a field name invites exactly the confusion this decision exists to prevent. The
  wire field stays `intended` because renaming it buys nothing and costs the Companion wiring.
- **D-34 (2026-08-23)** **State lifecycle: one reserved row, and identity that cannot rot.**
  Resolves [#28](https://github.com/jwnichols3/rocket-on-air-sensor/issues/28).
  **Renumbering dissolves.** `id` is immutable, `order` is presentation-only and freely
  renumbered, and **index never appears on the wire or in a Companion preset**. That last
  clause is load-bearing and free now: HA's options are positional with no identity, so index
  is a de facto second address - reorder the rows and an index-based caller silently resolves
  to something else, with nothing erroring because every index is still valid. A Stream Deck
  button bound to "option 3" is that failure exactly.
  **Renaming the `label` is always safe** and is not a breaking change, because the label was
  never the key. **Changing an `id` is not offered** - the UI has no id field after creation;
  changing identity is delete-plus-create, which is what it actually is. HA is the cautionary
  tale here, not the template: its `input_select` options are bare strings, so a rename is not
  modelled as a rename at all - one string vanishes, another appears, nothing is migrated,
  nothing is warned. The stable per-row id is the fix HA never applied.
  **One reserved row: `unknown`.** It cannot be deleted, its `busy` is forced `true`, and it is
  where every dangling reference resolves. Its `label`, colours and description are editable
  like any other row. This is a Null Object, not a ladder in disguise: it carries no rank and
  nothing is ordered against it. Both prior-art threads insisted the fallback must not be
  `available` ("a delete that silently resolves to the calm state is the invariant violation
  wearing a maintenance-operation costume"), and HA's `options[0]` fallback is the same trap -
  *"'fall back to the first row' is a bad rule if the first row is ON AIR."* Naming the
  fallback explicitly, and making it conspicuous rather than calm, answers both.
  **Deletion is allowed, never silent.** Deleting the row that is currently live is permitted;
  on save the live state resolves to `unknown`, `GET /status` reports
  `stateResolvedFrom: "<dead-id>"`, and the admin UI warns before the save that the row is live
  right now. Deleting the pinned row releases the pin in the same operation, with the same
  warning. HA's containment asymmetry is adopted wholesale - **degrade quietly on the state,
  fail loudly on the command** - with one correction: HA logs its live-delete fallback as a
  *warning*, which on a physical light means the panel changes colour with no explanation, so
  here it is surfaced in `GET /status` and on the admin UI, not only in a log.
  **A write naming an unknown `id` is `400`**, listing the valid ids. Never accept-and-fall-back:
  that would let a typo render calm. **A renderer handed an id it does not know renders the
  `unknown` appearance** - conspicuous, never calm, and never silently dropped. That last
  clause is aimed at XMPP's rule that unknown extensions MUST be ignored, which degrades a
  custom state to *nothing*; that is the failure mode to design against.
  **Table versioning.** The table carries a monotonic integer `version`, bumped on every master
  save, and `GET /status` stamps `tableVersion`. **Old versions are not retained.** Renaming a
  row does change the meaning of every past record - HA takes this seriously enough that
  `InputSelect` deliberately subtracts `SelectEntity`'s history exclusion, putting the option
  list back into recorded history precisely because for a *user-editable* list the option list
  *is* history. The honest position here: this system has no history store at all (the state
  file holds current state only), so there is nothing to reinterpret; the stamp exists so that
  when a history store lands, "which table was in force" is already recorded. Snapshotting old
  tables is explicitly deferred, not overlooked.
- **D-35 (2026-08-23)** **One auth model, two credentials, two audiences.** Resolves
  [#25](https://github.com/jwnichols3/rocket-on-air-sensor/issues/25). **Supersedes D-7 and
  D-23; retires `/ui`; amends D-25.**
  **The passphrase replaces `ONAIR_TOKEN`**, same role - the machine-to-machine credential
  presented by the ESP32, Companion and the detector - but stored in the structured config
  store (D-36) and editable in the admin UI rather than only in an env file. Presented as
  `Authorization: Bearer <passphrase>`, or `?passphrase=` where a header is impossible
  (`EventSource`, the WebSocket upgrade, a remote kiosk navigation). `?token=` is accepted as
  a deprecated alias so nothing on the LAN breaks the day this lands. `ONAIR_PASSPHRASE` in
  the real environment still wins over the file, which is D-14's rule and the break-glass path.
  **Admin credentials are separate**: default user `rocket`, default password `ESP32`,
  literally as spoken - Rocket's call, made with the exposure explained. A change-me nag on
  first login; no forced change. They gate the human-facing admin UI and nothing else.
  **Two different trust questions, and the split is the point.** The passphrase says "you may
  read and write state." The admin session says "you may reconfigure the system, including
  rotating the passphrase." **Admin routes accept only a session token; data routes accept
  only the passphrase. Neither credential is ever accepted on the other's routes.** That is a
  sharpening of D-27, not a reversal of it: D-27 rejected splitting the *data* credential into
  read and write halves, and that still stands - there is one passphrase, no read/write split.
  **D-24's Origin waiver grants a full admin session.** Rocket asked not to type a password at
  home and chose neither extreme; the waiver is what he chose. Its ruling is carried over
  verbatim and unweakened: waived only when the connection is from loopback **and** `Host`
  names a loopback name on our port **and** `Origin` is absent or exactly one of ours, and
  never when `Sec-Fetch-Site` is present and is anything other than `same-origin` or `none`.
  The two measured attacks stay as regression tests. **One carve-out: factory reset always
  requires the admin password, from any origin, including loopback.** Everything else an admin
  session can do is recoverable; a factory reset on a box across the house is the lockout path,
  and one password prompt in its lifetime is a fair price. Revealing the passphrase in the UI
  is deliberately *not* carved out - Rocket has to read it to type it into the ESP32 and
  Companion, and demanding a password each time defeats the thing he asked for.
  **Session mechanics: no cookie.** D-23's objection does not evaporate because there is now a
  login form - a cookie brings CSRF back into scope on a server whose write routes are
  deliberately CORS-simple. Instead the admin UI is an SPA that holds a session token **in
  memory only** and sends it as `Authorization: Bearer <sessionToken>` on every fetch. A
  header cannot be forged cross-origin without a preflight, so CSRF on admin routes is
  structurally impossible rather than defended against. Cost: a page refresh logs you out -
  which at home is invisible, because the SPA immediately re-establishes under the D-24 waiver
  with no prompt. `POST /admin/session` accepts either nothing (waiver applies) or
  `{user, password}`. Sessions live 12 hours, sliding, in memory only; a service restart logs
  everyone out and at home the re-establish is silent.
  **Rotation has a grace window.** Changing the passphrase rewrites the config store and
  breaks every machine client at once - inherent, not fixable. Two mitigations: the admin UI
  shows a rotation checklist naming the hand-configured clients (ESP32, Companion) *before* it
  applies, and **the previous passphrase keeps working for 60 minutes after a rotation**, with
  the countdown visible in the admin UI. That converts a simultaneous outage into a walk
  around the house.
  **Factory reset** (`POST /admin/factory-reset`, admin password in the body, always): admin
  credentials return to `rocket`/`ESP32`; **the passphrase is regenerated at random and shown
  once in the response**, because a *known default* passphrase would be a documented LAN
  backdoor - the brief said reset returns credentials to defaults but never named a default
  passphrase, so this fills a blank rather than contradicting one; the state table returns to
  the seed rows; the hold is cleared; live state becomes `unknown`; `bind` returns to `all`
  and the port to 8484. A clean install produces the same result from nothing.
  **D-25's reasoning survives; its subject changes.** `/ui` is **retired** and folded into the
  new admin UI. The new admin UI is not byte-identical for every caller in the way `/ui` was -
  it renders config - so the split is made explicit: **the admin UI ships as a static bundle
  served unauthenticated (byte-identical for everyone, zero interpolation, discloses nothing),
  and every byte of data it renders comes from gated routes.** That is D-25's argument applied
  correctly to an app instead of a page, and it answers the ticket's question: unauthenticated
  shell plus gated data, not gated wholesale.
  **`GET /public/status` is added, unauthenticated and deliberately thin**:
  `{state, label, color, bgcolor, busy, ageSeconds, stale}` and nothing else - no passphrase,
  no config, no hold, no source, no device detail. It is what the memo's unauthenticated
  landing page asks for (*"is it active? what's it currently sending out?"*) and what
  `/display` needs to render colours now that colours live in config. It does disclose
  presence to anyone on the LAN; D-27 already accepted that LAN read consumers are trusted,
  and the landing page Rocket described cannot exist without it.
  **Device auth stays separate and stays compile-time.** D-17's basic auth on the ESP32 is
  confirmed unchanged: that credential guards API-to-device, the passphrase guards
  clients-to-API, and they are never the same value. ESPHome's `web_server: auth:` is
  compile-time YAML with no runtime API, so the device half cannot move into a UI; the
  *server's copy* of it moves into the config store under `device.username` / `device.password`
  and is editable in the admin UI, where it was previously in `config.env`.
  **Multi-user admin is decided: not built.** Rocket's *"change that or add a new one"* is read
  as editability, which is delivered. A second admin account on a single-user machine adds a
  user store, a per-user session table and a password-reset path to protect nothing D-24 does
  not already cover. Closes that item from the map's "Not yet specified"; revisit if a second
  human ever administers this box - the same trigger D-24 already carries.
- **D-36 (2026-08-23)** **Config is one structured file, edits are staged in the browser, and
  the service never fails closed.** Resolves
  [#29](https://github.com/jwnichols3/rocket-on-air-sensor/issues/29). **Amends D-14.**
  **Storage: `~/.onair/config.json`, 0600, one document.** It holds the port, the bind mode,
  the passphrase, the admin credentials, the device credentials, the shortcut rows, and the
  state table. `config.env` **retires as the config source** but is still loaded if present, as
  an env overlay only - real environment variables still win, which is D-14's rule and the
  documented way to unbrick a box over SSH. The whole file is hand-editable JSON, which is the
  answer to "readable and editable by hand, on a Pi, over SSH, with no UI". D-14's actual
  promise - **the plist carries no `ONAIR_*` config and never changes for a config change** -
  is unaffected: the service still finds its own config.
  **Config and state never share a file.** `~/.onair/config.json` is knowledge level, slow,
  user-owned. `~/.onair/state.json` is operational level, fast, service-owned. Different
  lifetimes, different writers, different files - permanently.
  **One write path, enforced by construction.** Home Assistant demonstrates the two-writer trap
  *inside a single application*: `input_select`'s `set_options` service mutates memory and never
  touches the storage collection, so it silently does not survive a restart, while UI editing
  goes through an entirely separate path. Two writers, two lifetimes, no reconciliation. The
  rule here: **the admin UI has no privileged path.** It calls the same `PUT /admin/config`
  every other client would, through one validation function and one atomic write (temp file,
  `fsync`, `rename`). There is no second way in.
  **Failure handling.** Atomic rename means the file on disk is either wholly the old document
  or wholly the new one, never half. `ENOSPC` returns `507` with the running config untouched.
  **On startup, an unparseable or invalid config file does not stop the service**: it logs
  loudly, binds **loopback only**, serves the admin UI, and presents a repair screen showing the
  parse error and the raw text, with fix-or-reset. That is the generalisation of the network
  research's "never fail closed", and it is aimed directly at the failure this ticket names -
  *a config save that leaves the service unable to start, on a machine Rocket is not sitting in
  front of.*
  **Bind mode, absorbed from the network-interface research (#22).** `bind` is a **mode**, not
  an address: `all` (default, `::` dual-stack) / `loopback` / `iface:<name>`. **Loopback is
  always bound and is never a user choice** - the picker chooses what *else* to bind. Measured:
  binding a single LAN address makes `127.0.0.1` return `ECONNREFUSED`, which would silently
  disable D-24's waiver and therefore the admin surface, from a UI whose purpose is
  administration. Two `http.Server` objects sharing one handler bind two addresses on one port,
  measured working. The interface **name** is stored and re-resolved at every startup; a stored
  address goes stale and `EADDRNOTAVAIL` under D-13's `KeepAlive` is a crash-loop. A missing
  interface at boot binds loopback, starts, warns, and retries.
  **Editing model: the draft lives in the browser.** Client-side only, mirrored to
  `sessionStorage` so a reload does not lose it. No server-side draft resource - that would add
  a second lifetime, a second write path and a "whose draft is this" question for two tabs,
  and the browser already holds the draft. Three commit levels, matching what Rocket described:
  a row being edited is *editing*; a row saved into the draft is *staged*, badged, and diffed
  against live; the page-level **Save configuration** button is the only thing that reaches the
  server. Row cancel reverts that row to live and drops it from the draft; **Discard all** drops
  everything; leaving with staged changes fires `beforeunload`.
  **One save button, and the server decides what that costs.** Everything except `port` and
  `bind` applies live. If `port` or `bind` changed, the server **rebinds in place** - closes the
  listeners, opens new ones, never exits, never involves the supervisor. **If the new binding
  fails it rolls back to the previous one, keeps running, and returns `409` naming the error.**
  That is strictly better than "restart and hope" and it is what makes a config UI safe to use
  from across the house.
  **Concurrency: optimistic.** `PUT /admin/config` carries the `version` it was based on; a
  mismatch is `409` with the current document, and the UI shows what changed underneath.
  **A hand-edit made while the service is running is overwritten by the next UI save** - the
  running service is the only writer it knows about. Documented plainly rather than defended
  against: stop the service before hand-editing, or lose the edit.
  **Factory reset** wipes the table back to the seed rows, clears the hold, sets live state to
  `unknown`, and resets credentials per D-35.
- **D-37 (2026-08-23)** **Monorepo layout: four flat directories, three npm workspaces, one
  verify command.** Resolves
  [#24](https://github.com/jwnichols3/rocket-on-air-sensor/issues/24). **Implements D-28;
  amends D-10 and D-13.**
  ```
  /                     CONTEXT.md  CLAUDE.md  README.md  package.json (workspaces)  docs/  deploy/
    server/             the Node service - package "onair-api", bin, src/ test/ dist/ tsconfig*.json
    admin-ui/           the SPA - package "onair-admin-ui", builds to server/public/admin/
    firmware/           ESPHome - pyproject.toml uv.lock Makefile configs/
    companion-module/   package "companion-module-rocket-onair", @companion-module/base ~2.1.3
  ```
  **Flat top-level directories, not `packages/` or `apps/`.** Two of the four are not npm
  packages and `apps/firmware` would be a lie. Four names that say what they are.
  **npm workspaces cover the three Node parts only.** `firmware/` is a sibling with its own uv
  toolchain, driven from root scripts (`npm run firmware:config` -> `make -C firmware config`).
  That is the answer to "must not make the non-Node parts second-class": it is not a workspace
  because it is not a package, but it is reachable from the same command surface. **`npm run
  verify` at the root is the single gate** - all three workspaces' tests, all three
  typechecks, plus `esphome config` on the firmware YAML, which validates the build with no
  hardware and no flash. Today's `npm test` (145 server tests) becomes `npm test -w server`
  and is included.
  **What moves:** `src/`, `test/`, `dist/`, `tsconfig.json`, `tsconfig.test.json` -> `server/`.
  **What stays:** `CONTEXT.md`, `CLAUDE.md`, `README.md`, `INSTALL.md`, `docs/`, `deploy/` -
  repo-wide by nature.
  **The installer promise, and what breaking it costs.** D-13's plist supervises
  `node dist/index.js` from a checkout at `~/code/rocket-on-air-sensor`, and D-14 built the
  config-file-first design so the plist would never change after install. Moving `dist/` to
  `server/dist/` is a change to that path. Reading the promise precisely: D-14 promised the
  plist never changes **for a config change**. A repo restructure is not a config change - it
  is an update, and `onair update` (D-14) exists to carry updates, health-gated with automatic
  rollback. **Decision: the layout change ships with a plist rewrite performed by
  `onair update`**, which detects an old-shape `ProgramArguments` and rewrites it before
  restarting. There is exactly one installed host, nothing is production (D-22 notwithstanding
  - the map's Notes are explicit), and a failed update rolls back. Cost accepted.
  A root-level `dist/index.js` shim that re-exports `server/dist/index.js` was considered as a
  way to avoid touching the plist at all. **Rejected:** three lines of permanent cruft, at the
  root, forever, to avoid a one-time migration on a single machine - and it would leave two
  plausible entry points for every future reader to disambiguate.
  **Package identity.** `server/` keeps `onair-api` and its `bin`. The **root package is
  `private: true` with no `bin`**, which means `npx --yes github:jwnichols3/rocket-on-air-sensor`
  no longer resolves an executable. **That path is formally retired** - D-15 had already
  demoted it to "a throwaway demo, never an install or boot path", so this amends D-10 by
  finishing what D-15 started rather than by taking anything away.
  **Firmware import: copy, no history.** `configs/elegoo-esp32.yaml`, `Makefile`,
  `pyproject.toml`, `uv.lock` and `secrets.yaml.example` come across as files. `secrets.yaml`
  does not (gitignored, and it holds the D-17 device credentials). History in the other repo is
  a lab log, not this project's provenance, and a subtree import would drag an unrelated
  toolchain history into a repo whose log is currently readable end to end. The ESPHome pin to
  `2026.8.0` comes with it, comment intact - D-16's warning that the REST URL scheme changed in
  that release still applies to every driver URL. **`jwnichols3/rocket-esp32` is left exactly as
  it is** - not archived, not deleted; it was set up as a lab and it can stay one. A README
  pointer here is the only change, and it is the only change this run is willing to make to a
  repo outside this one.
  **CI: none, and deliberately not invented.** There is no CI today. `npm run verify` is the
  gate, run by a human or an agent before a commit that touches source, which is this repo's
  existing bar. Adding GitHub Actions is a separate decision with its own costs (secrets for
  the ESPHome build, a runner that cannot flash hardware) and it is out of this map's scope.
- **D-38 (2026-08-23)** **State pushes, config pulls, and the device's `select` becomes a
  `text`.** Resolves [#30](https://github.com/jwnichols3/rocket-on-air-sensor/issues/30).
  **Amends D-17 and D-22; corrects a factual error in the wayfinder brief.**
  **The brief is wrong about the current system and the correction is load-bearing.** It says
  pull *"matches how the device already polls `GET /status` (D-17)"*. The device does not poll.
  D-17 and D-27 are explicit that **the server is the HTTP client of the device** - it writes
  the state and reads it back, which is what makes `confirmed` a genuine device read. The
  brief's *ruling* (pull, for config) is a deliberate choice and stands; its premise about
  today's behaviour does not. Resolving them:
  > **State stays PUSH (server -> device). Config becomes PULL (device -> server).**
  They are not the same direction, so they cannot be the same request - which decisively
  answers the ticket's "one endpoint or two". State push is live, measured at 120 ms median
  set-to-confirm (D-22), and `confirmed` requires the server to read the device anyway;
  converting it to a poll would be a pure latency regression for nothing. Config pull keeps the
  server **stateless about devices** - no registry, no reachability requirement, no retry logic
  - which is what the brief actually wanted. Both directions are hand-configured: the server
  holds one device host (as today), the device holds one server host.
  **The device's state entity changes from `select` to `text`.** ESPHome's template `select`
  options are compile-time YAML: *"Traits are set once at startup and valid for the lifetime of
  the program"*, options are baked in at codegen as `const char *` into flash, and the complete
  action set navigates without adding, removing or renaming. A user-editable table would mean a
  reflash per row, which is not a product. **The ownership argument is the real one, though:** a
  `select` asserts that *the firmware owns the set of valid states*. In this architecture the
  server owns the set and the panel is a renderer. `text` encodes that correctly.
  Verified against the pinned ESPHome **2026.8.0** source in
  `esphome/components/web_server/web_server.cpp` and `text/__init__.py`, not against `dev`:
  - `POST /text/<Name>/set?value=<key>` -> `200`. `GET /text/<Name>` ->
    `{"id","value","state","min_length","max_length","pattern"}`. The unverified endpoint shape
    the research flagged is now **confirmed**.
  - `handle_text_request` wraps the call in `DEFER_ACTION(call, call.perform())` and sends the
    `200` **before** applying - byte for byte the same respond-before-apply behaviour as
    `select`. **So D-22.3 carries over unchanged: a write is not confirmed by the next read,
    and the driver must re-read across the gap.**
  - `max_length` defaults to **255**, which is far more than a slug needs.
  - `mode: password` masks the value to `********` in the JSON, so a passphrase entered on the
    device is not readable from its own REST API.
  Cost, stated plainly: `select` gave free rejection of unknown options at the device; `text`
  does not. **Validation moves to the server**, where D-34 already put it.
  **Colour reaches the device through the config pull, not the state write.** That dissolves the
  schema-versus-firmware tension #20 surfaced: no single ESPHome entity can carry a row, and it
  does not have to. The state write is one opaque key; the table, with `label`, `color` and
  `bgcolor`, arrives separately and rarely.
  **Config pull: `GET /config/states`, passphrase-gated, every 300 s and on boot**, plus
  immediately whenever the device is handed a key its table does not contain. `If-None-Match:
  "<version>"` makes the steady state a `304`. Five minutes is "if the server changes you
  change" at a cadence nobody notices, without polling a table that changes monthly; the number
  is a taste call. `http_request`'s `max_response_buffer_size` defaults to 1 kB and must be
  raised (8 kB) for a 64-row table.
  **Feasibility, and the part that is not buildable.** The device-served page Rocket described
  splits cleanly in two:
  - **Buildable, and ships in v2:** the connection settings - which server, which port, which
    passphrase - as template `text` / `number` / `switch` entities with `restore_value: true`
    (NVS-persisted across reboots), `mode: password` on the passphrase, all served at the
    device's own IP through the existing `web_server` behind D-17's basic auth. That is
    Rocket's actual list, behind a login, at the device's address.
  - **Not buildable in stock ESPHome:** a bespoke page with its own login form and an editable
    state-table grid. `web_server` serves a fixed dashboard plus entity REST endpoints; it is
    not a web framework. What ships is ESPHome's own dashboard listing those entities.
  - **Not buildable: a persisted local table.** ESPHome restoring string globals are capped at
    `max_restore_data_length` <= **254 bytes** (verified: `cv.int_range(0, 254)` in
    `globals/__init__.py`), which a multi-row table exceeds; sharding across globals to fake it
    is exactly the kind of cleverness that rots. **So the device does not persist the table.**
    It holds it in RAM and pulls on boot. Before its first successful pull it renders the
    `unknown` appearance with `NO CONFIG` - which is correct under the invariant anyway, so the
    missing persistence costs nothing real.
  **Custom mode is cut down to one bit, honestly.** Full local overrides need flash-persisted
  structured config and an editable grid on the device, which means leaving ESPHome for
  hand-written firmware - **a much larger decision than this ticket, and not one to make as a
  side effect.** What ships is a `switch`: `auto` (default) pulls and follows; `custom` freezes
  the table last pulled and stops pulling. That is buildable in four lines of YAML and it
  answers the real question behind the ask - *"the server changed and I do not want to follow it
  right now."* The editable-table-on-device vision gets its own ticket.
  **Unreachable server.** State pushes stop arriving -> the device's existing staleness watchdog
  trips to NO DATA, as it already does. Config pulls fail -> it keeps the table in RAM. No table
  at all (fresh boot, server down) -> `unknown` appearance, `NO CONFIG` on the panel. Never
  calm, at any point in that sequence.
  **Server-side lifecycle events while the device holds a stale table** (#28 from the device's
  side): the server pushes a key the device does not know -> the device renders `unknown`
  conspicuously **and triggers an immediate config re-pull**, so it self-heals within one round
  trip instead of waiting out the 300 s interval.
  **What dies with `select`:** the `GET /select/Presence?detail=all` trick for reading the
  firmware's compiled option list and warning that firmware is stale. It is not replaced and
  does not need to be - the entire point is that the device no longer declares a set of states.
- **D-39 (2026-08-23)** **The admin UI shape, settled by building it.** Resolves
  [#31](https://github.com/jwnichols3/rocket-on-air-sensor/issues/31). Prototype:
  `docs/prototypes/2026-08-23-admin-state-table.html` (throwaway; it informs the spec and does
  not become it). Published to click on:
  https://claude.ai/code/artifact/92558b8a-42f9-4389-b726-3e2413e213c1
  **One page with a section rail, not tabs** - Status, States, Admin settings, Network, Light.
  Tabs imply peers; these are one configuration document with a live readout at the top of it.
  **The commit bar is in the header and never scrolls away**, carrying the staged count,
  Discard all, and **Save configuration**. Two-level commit is unusual and easy to make
  confusing, and the thing that makes it legible is that the second level is *always visible* -
  you can see, at every moment, that there is something staged and that it has not been applied.
  **Three commit levels, three distinct affordances** - and building it surfaced a distinction
  prose had missed. *Cancel* while editing abandons the edit session and returns the row to its
  **last staged** value. *Revert* on a staged row is a separate button that drops the row back
  to **live**. Collapsing them into one control loses the ability to abandon a typo without
  also throwing away a change staged ten minutes ago.
  **The live swatch carries a contrast ratio, and that is the single most valuable thing on the
  page.** Every row renders its own label on its own background with a WCAG ratio and an AA
  verdict, and a failing pair raises a banner on the row. Legibility across a room is a real
  constraint (`docs/research/2026-08-22-wall-indicator.md`), and it turns out to be checkable
  the instant a colour changes rather than after a firmware round trip. The editor also shows
  a full panel mock at the SH1106's proportions.
  **The id is visible, monospace, and visibly locked** on every row, with the label immediately
  beside it. Making the immutability *visible* is what stops someone expecting a rename to
  rebind their Companion buttons. A new row's id is auto-slugged from the label as it is typed
  and frozen when the row is staged.
  **Deleting a live or pinned row opens a confirm that says what will actually happen** - the
  state resolves to `unknown`, `GET /status` reports where it came from, the pin releases,
  bound Companion buttons start getting `400` - and it still only *stages* the delete.
  **The unauthenticated landing page is a tally, not a dashboard.** Big state word on the state
  colour, description under it, five facts (service running, currently sending, written by, last
  write age, hold), and a log-in button. It is exactly `GET /public/status` rendered, which is
  what keeps D-35's thin-public-read honest - if the page needs a field the endpoint does not
  have, that is a decision, not an oversight.
  **Verified by driving it**, not by looking at it: five rows render with correct contrast
  ratios; a bad hex blocks the row save with an inline error; renaming a row leaves the id
  untouched; adding a row auto-slugs `Deep Work` to `deep-work`; the reserved row has no delete
  control; deleting the live row stages, then on save resolves live state to `unknown` and
  reports `stateResolvedFrom`; revert un-stages one row without touching the others; the remote
  toggle demands the admin password while the at-the-Mac state opens with no prompt; all five
  sections render; light and dark both resolve. One real bug was found and fixed this way - the
  staged counter double-counted deletions.
  **Taste calls made in the prototype, all on the review list:** the section order and names, the
  seed palette's exact hex values, "Busy / Calm" as the wording for the `busy` toggle, and the
  decision to show the passphrase in plaintext on the Admin page rather than behind a reveal.
- **D-40 (2026-08-24)** **Correction: a real device web interface and a persisted local table
  ARE buildable inside ESPHome. D-38's feasibility verdict was scoped too narrowly.**
  Rocket pushed back on the "not buildable" finding - *"I have to assume there is a webserver
  solution for the esp32"* - and he was right. D-38 asked "what can `web_server` be configured
  to do from YAML", and the honest answer to *that* question is "not this". The question it
  should have asked is "what can an **ESPHome external component** do", which is a supported,
  documented extension mechanism, and the answer there is "essentially all of it". Recording
  the mistake as well as the fix, because the failure mode - taking a component's YAML surface
  for the platform's ceiling - will recur otherwise.
  **Verified against the pinned ESPHome 2026.8.0 source and Espressif's docs:**
  - `web_server_base` exposes **`add_handler(AsyncWebHandler *)`** and
    `add_handler_without_auth(...)` (`web_server_base.h:158,166`). `add_handler()` is
    documented as the variant that **respects web server authentication**, so a custom page
    inherits D-17's mandatory basic auth for free rather than re-implementing it.
  - **`captive_portal` uses exactly this in-tree** (`captive_portal.cpp:82`), which is the
    existence proof that the extension point is real and supported rather than incidental.
  - **The interface is unified across frameworks.** `web_server_idf` defines its own
    `AsyncWebHandler` with the same `canHandle`/`handleRequest` shape
    (`web_server_idf.h:244`), and dispatches to registered handlers
    (`web_server_idf.cpp:244,262`). So this works on `framework: esp-idf`, which is what D-17
    pinned. Both classes are in ESPHome's published API docs.
  - **The 254-byte limit is a YAML schema limit, not a platform limit.** It is
    `cv.int_range(0, 254)` on `globals:`'s `max_restore_data_length`. ESPHome's own NVS path
    calls `nvs_set_blob(key, save.data.data(), save.data.size())` with no such cap
    (`esp32/preferences.cpp:233`); the 255-word ceiling nearby applies only to the **RTC**
    backend used across deep sleep, which this always-awake device never uses.
  - **`nvs_set_blob` allows 508,000 bytes, or 97.6% of the partition minus 4000, whichever is
    lower** (Espressif docs). The default ESP32 NVS partition is 24 KB, so the practical
    ceiling is roughly 19 KB against a 64-row table at well under 5 KB. Espressif warn that
    page fragmentation can fail a large blob write even when overall space looks sufficient -
    so a write must be checked, not assumed.
  - **ESPHome supports custom partition tables** (`esp32: partitions:`, `esp32/__init__.py`),
    so a LittleFS/SPIFFS data partition is available if the blob ever stops being enough.
  **The options, ranked, with what each costs:**
  1. **External component + NVS blob (recommended).** A C++ component in `firmware/` that
     implements `AsyncWebHandler`, registers via `add_handler()`, serves a real config page on
     the device's own IP and port 80 behind the existing basic auth, and persists the table as
     one preference blob. Stays entirely on ESPHome, so OTA, `make logs`, the display lambda,
     the frame counter (D-22) and the whole existing toolchain keep working. Cost: hand-written
     C++ compiled into the firmware, and an HTML page to maintain in a second place.
  2. **Same, but LittleFS/SPIFFS** if the page or table outgrows a blob. Adds a custom
     partition table and a filesystem to the failure surface. Only if 1 proves too small.
  3. **Hand-written ESP-IDF firmware.** What D-38 assumed was required. Now clearly the *last*
     resort: it would mean rebuilding the display driver, Wi-Fi/OTA, the entity REST surface
     the D-17 driver depends on, and D-22's liveness signal, all of which ESPHome provides.
  4. **Server-only editing** (v2's shipped default). Still a legitimate choice, and now a
     genuine one rather than a limitation dressed up as a decision.
  **What changes in the design:** D-38's *architecture* is untouched and still right - state
  pushes, config pulls, `select` -> `text`, colour via the config pull, `unknown`/`NO CONFIG`
  before the first pull. What changes is that **"custom mode is cut because ESPHome cannot"
  becomes "custom mode is deferred because it is a chunk of work"** - an honest scheduling
  call rather than a platform limit. [#33](https://github.com/jwnichols3/rocket-on-air-sensor/issues/33)
  is rescoped and reopened accordingly.
- **D-41 (2026-08-24)** **`source` is required and prefixed on `PUT /state`, and optional on
  the convenience routes.** Amends D-32. D-32 made an absent or unprefixed `source` read as
  `human:` everywhere, and flagged on the review list that this is the unsafe direction - an
  automated writer that forgets the prefix silently gets human authority and breaks the
  owner's holds. Rocket's answer removed the reason for the compromise: **VCREC has not been
  written yet and will not be until this spec is finished**, so there is no automated client
  whose ergonomics need protecting. Splitting the rule by route now costs nothing and gets
  both halves right:
  - **`PUT /state`** - the canonical write, what an automated client uses - **requires** a
    `source` carrying a valid `auto:` or `human:` prefix. `400` otherwise.
  - **`POST /state/{id}`, `/on`, `/off`** - the curl and phone-Shortcuts surface - keep
    `source` optional, defaulting to `human:anonymous`.
  A robot reaching for the machine route must declare itself; a human reaching for the
  convenience route still types nothing. The failure direction now matches the system's
  invariant instead of working against it.
- **D-42 (2026-08-24)** **Presentation travels with the profile; semantics travel with the
  state.** Rocket's call, amending D-31 and the v2 contract as first drafted. D-31 accepted
  "colour is on the wire" wholesale and D-38 then routed colour to the device through the
  config pull - but the contract as written *also* denormalised `label`, `color` and `bgcolor`
  into every `GET /status` response and every SSE/WebSocket push. Rocket: *"I agree we
  shouldn't send the color with the state... I would like the profile refresh capability or
  auto profile to load the configuration from the server onto the destination. And in that
  case we would send the information. But that should only happen every so often, not with
  every state change, right?"* Correct, and the inconsistency was ours.
  **The line, and why it falls where it does:**
  - **Out of the state payload:** `label`, `color`, `bgcolor`. A state change says only *which
    row* is current. A state write happens many times an hour; the table changes a few times a
    year. Carrying the second on the first puts configuration data on every heartbeat.
  - **Still in the state payload:** `busy`, `intended`, `confirmed`. These are **semantics, not
    presentation** - `intended` is RFC 3863's carry-along, the basic status that lets a consumer
    which has never heard of a row still act correctly (D-33). A look is not that.
  This also removes most of the cost D-31 accepted knowingly. Colour is no longer welded into
  the state protocol; it lives in a versioned configuration document, which is a far cheaper
  thing to change later.
  **It surfaced a real bug in the first draft, which is the second reason this decision
  exists.** `/display` is served unauthenticated (D-25/D-35) but was told to read the
  passphrase-gated `GET /events`. It could not have worked. Fixed by adding **`GET
  /public/events`** - an unauthenticated SSE stream carrying the `/public/status` payload.
  **The two `/public/*` endpoints are the deliberate exception**, and they are named as a
  *rendering view*, not the state contract: they serve two browser pages that hold no table and
  must not fetch one, so the server resolves the row for them. Any client that holds a table -
  the ESP32, Companion, VCREC - takes the key from the gated endpoints and the look from
  `GET /config/states`. Stated in the contract so nobody reads `/public/status` and thinks it
  is the machine interface.
  **The version nudge.** Polling alone leaves a colour edit up to 300 s from the panel, which
  feels broken when it was just made in the admin UI. So the server writes the current
  `tableVersion` to a small entity on the device alongside the state it already writes, and a
  device seeing a version it does not hold re-pulls at once. That is a **trigger for a pull,
  not a push of the table**: no configuration travels on the state path, and the server still
  keeps no device registry beyond the one host it already writes to. Cost is one integer on a
  path that already exists.
  **Vocabulary.** Rocket's *"profile refresh"* and *"auto profile"* name the config pull and
  D-38's `auto` mode. **"Profile" is not adopted as a second domain word** - the thing is still
  the **state table** (D-31), and a synonym for it is exactly what the vocabulary discipline
  exists to prevent. "Refresh profile from server" is a good *button label* on the device page,
  and it is used there.
- **D-43 (2026-08-24)** **Factory reset returns the passphrase to a fixed default, not a random
  one.** Rocket's call, overriding the recommendation in D-35. The concern was raised twice -
  a documented default passphrase is a LAN backdoor known to anyone who has read this repo -
  and he decided; it is his machine, his LAN, and his risk to take. Recorded rather than
  re-argued.
  **The default is `onair`.** No default passphrase was ever spoken, so this is a filled blank
  rather than a recorded value, and it is on the review list. It is deliberately **not** `ESP32`:
  reusing the admin password would collapse the two-credential separation that D-35 exists to
  create, which would be a much larger change than the one being asked for.
  **One mitigation, consistent with a choice Rocket already made rather than fighting this
  one:** the admin UI shows a change-me nag for the passphrase exactly as it does for the admin
  password (D-35), and does not force a change. Same treatment, same reasoning, no new argument.
- **D-44 (2026-08-24)** **The `text` transport is proven on real hardware, and the board taught
  us three things the source did not.** Confirms D-38's central bet before anything depends on
  it. Method: a `PresenceKey` template `text` added **alongside** the existing `Presence`
  select and flashed OTA to the live device, so the light kept working throughout - expand
  before contract. Firmware 51.2% -> 51.6% flash; the entity costs ~0.4%.
  **The premise holds.** `POST /text/PresenceKey/set?value=focus-block` -> `200`, and a
  read-back returns `focus-block`. A key no firmware ever compiled is stored and served. That
  is the whole of D-38's argument, and it is now measured rather than inferred.
  **Three findings that change what gets written down:**
  1. **A bare `curl -X POST` gets `411 Client must specify Content-Length`** - and **this is
     not new and not `text`-specific**: the shipped `select` endpoint does exactly the same.
     `esp_http_server` demands a `Content-Length` on POST; Node's `fetch` sends
     `Content-Length: 0` automatically, which is the only reason the production driver has
     ever worked. Nobody had hit it because nobody had driven this endpoint from `curl`. It
     goes in the docs as a gotcha - `curl -d ''` is the fix - because the failure looks like a
     broken endpoint rather than a missing header.
  2. **A length violation returns `200` and is silently dropped.** An 80-character write
     against `max_length: 64` returned `200` and left the previous value in place. This is
     D-17's "invalid options are silently dropped, still 200" trap reproduced on the new
     transport for a *different* cause. **So read-back remains mandatory under `text`**, and
     the reason is now length rather than enum membership. D-22.3 survives the transport change
     on its own merits.
  3. **An empty write was accepted**, storing `""`. That is worse than it looks: `""` is not a
     state, and a panel rendering nothing reads exactly like a panel rendering calm - the
     invariant violation this system exists to prevent, arriving through a typo. Fixed by
     `min_length: 1`, re-flashed and re-verified: an empty write now returns `200` and is
     silently dropped, leaving the previous value. Loud rejection is not on offer, which is
     the third independent argument for mandatory read-back.
  **Two smaller notes.** `mode` is a **required** option on template `text` (config fails
  without it); `mode: password` would mask the value in the JSON and is therefore wrong here,
  since the driver must read it back. And the state entity keeps `on_value` wired to
  `last_write_ms`, so the staleness machinery works identically on the new transport.
  **One thing deliberately not claimed.** The respond-before-apply gap (D-22.3) **was not
  observed** - 0 of 12 write-then-immediately-read pairs caught it, and a `text` entity with
  `optimistic: true` may well apply synchronously where `select` did not. That is a
  non-observation of a race, not a disproof, and it is far too cheap to keep the driver's
  re-read to justify removing it on this evidence. `restore_value` across a reboot was also
  **not** exercised in this run.
  Firmware change committed locally in `~/code/esp32` and **not pushed**; it moves into
  `firmware/` with D-37.
- **D-45 (2026-08-24)** **The Companion module is the next push, gated on a tested v2 API.**
  Rocket's scope call: *"Companion module - next push, once the API is well defined and
  tested."* It is therefore **not** in the v2 build backlog (#35..#43), and the map already had
  building it out of scope.
  **The gate is concrete, not a feeling.** "Well defined" is done - `docs/api-contract.md` is
  v2 and `GET /config/states` is specified. "Tested" means the server tickets have shipped and
  soaked, so the gate is **#40 closed** (the last server ticket; the config store and auth it
  depends on are its own blockers). The module's ticket carries that as a real blocking edge so
  it cannot reach the frontier early.
  **Phase 1 is finished and is not waiting on this.** D-11 built `GET /events/ws`, it is live
  (D-22), and the #21 research confirmed the transport survives v2 intact - so the existing
  zero-code generic-websocket wiring keeps working, which D-33 preserved deliberately. What was
  never exercised is the **Companion side**: the research machine has 4.1.4 and it has never
  been launched. That untested half is absorbed into the module ticket rather than left as a
  separate open thread.
  **One thing must not silently rot in the meantime.** `docs/companion-setup.md` documents a
  `level == "interruptible"` feedback, and `level` ceases to exist the moment the state table
  lands. That doc is now an acceptance criterion on the server ticket that deletes the field,
  so the wiring Rocket may be running is not quietly falsified by a merge. The `?source=`
  values in it survive untouched: an unprefixed `source` on a convenience route reads as
  `human:` (D-41), and a Stream Deck press is a human.
- **D-46 (2026-08-24)** **The `select` is gone. The panel renders whatever key it is handed,
  and says so when it cannot.** Resolves
  [#35](https://github.com/jwnichols3/rocket-on-air-sensor/issues/35). This is the *contract*
  half of D-38, whose expand half was D-44; both halves are now on the live board.
  **What moved.** The driver writes `POST /text/PresenceKey/set?value=<key>` and reads back
  `GET /text/PresenceKey`; `EsphomeSelectDriver` is `EsphomeTextDriver`; the display lambda
  branches on the text value rather than a select index; the `select:` block is out of the
  YAML. The device now declares no set of valid states at all, which is the point.
  **The cutover kept the light lit, and the ordering is the reason.** Both entities were
  already sitting at `dnd`, so: point `ONAIR_LIGHT_ENTITY` at `PresenceKey`, deploy the
  server, *then* flash. In the window between the two, the server drove `text` while the old
  firmware still rendered `select` - and because both held `dnd`, the glass never changed.
  Measured mid-window: `text/PresenceKey` = `interruptible`, `select/Presence` = `dnd`, panel
  `ON AIR`. Reversing the order would have pointed the server at an entity the panel was not
  reading, which is the same false-calm risk this system exists to prevent.
  **Three findings from doing it:**
  1. **A removed component does not 404 - it answers nothing at all.** `GET /select/Presence`
     now yields an *empty reply* (curl 52), not a `404`, because with no `select` component
     compiled in there is no handler registered for that URI prefix. `GET /text/Nope` still
     `404`s, since the `text` handler exists and rejects the name. So `verifyEntity()` still
     catches the failure it was written for - a **misspelt entity name** - but a server
     pointed at firmware missing the whole component sees "unreachable", not a config error.
     Left as is: that skew now surfaces as `confirmed: unknown`, which is where D-38 put it.
  2. **The startup option-list check is deleted, not replaced.** `select` could be asked for
     its compiled options, and the service refused to start on a mismatch. `text` has no such
     list by design, so firmware/server skew is no longer detectable at boot. It shows up as
     a read-back that does not match. That is a real loss of a loud early failure, accepted
     deliberately as the price D-38 already named.
  3. **`restore_value` survives a reflash.** Not exercised in D-44, exercised here: the board
     came back from OTA holding `interruptible` and drew `BUSY` without being written to.
  **The UNKNOWN KEY branch, and one taste call.** A key the build cannot draw gets a solid
  inverted header reading `UNKNOWN KEY`, the offending key printed underneath **left-aligned**
  so a long key clips its tail rather than its identifying head, and a hatched footer. It is
  deliberately *not* the `NO DATA` appearance: stale-and-therefore-untrusted and
  server-said-something-I-cannot-draw are different faults and must not look alike from across
  the room. `Render` gains a fifth value, `UNKNOWN KEY`, so the branch is readable over HTTP.
  Measured: `POST value=focus-block` -> stored, panel drew `UNKNOWN KEY`.
  **Soak, held against D-22's numbers.** 35 min at a 15 s cadence, which spans two of the
  15-minute windows whose absence proved `api: reboot_timeout: 0s` works: **139/139 polls,
  139/139 API-device agreement, 139/139 panel branch correct, zero frame-counter resets, zero
  supervisor deferrals, zero new lines in the service log.** Median set->confirm **89 ms**
  over 20 writes (min 51, max 543) against D-22's 120 ms on `select` - faster, though a
  three-quarter-length soak on one evening's RF conditions is not grounds to claim `text` is
  the reason. **No regression.** Shorter than D-22's 61 min, stated plainly: the reboot proof
  needs whole 15-minute windows and two of them is the smallest honest number.
  **The recognised set stays hardcoded until the config pull lands.** This build draws `dnd`,
  `interruptible` and `available` and treats everything else as unknown. That is not the end
  state - [#43](https://github.com/jwnichols3/rocket-on-air-sensor/issues/43) replaces the
  hardcoded triple with the pulled table - but a firmware that recognised nothing would render
  `UNKNOWN KEY` for every state the server can currently send, which is not shippable.
- **D-47 (2026-08-24)** **The four-part layout is in, `npm run verify` is the gate, and
  `onair update` carries the plist across.** Resolves
  [#36](https://github.com/jwnichols3/rocket-on-air-sensor/issues/36). **Implements D-37;
  D-37's reasoning stands unchanged** - this records what implementing it actually cost and
  the three things it turned up.
  **What moved.** `src/ test/ dist/ tsconfig*.json package.json` -> `server/` (as `git mv`, so
  the history follows). `firmware/` holds the ESPHome lab imported from `rocket-esp32` as files
  with no history, minus `secrets.yaml`. Root `package.json` is `private: true`, has no `bin`,
  and names three workspaces. `deploy/`, `docs/` and the root docs stay put.
  **`npm run verify` is real, and proven to fail.** It runs every workspace typecheck, every
  workspace test (152), the deploy-path tests (19), and `esphome config`. All four failure
  modes were deliberately induced and each one failed the gate: a bogus firmware component
  (exit 2), a missing `secrets.yaml` (exit 2, naming the file), a type error in `server/src`
  (exit 1, naming the line). **The firmware step fails rather than skips** when the venv or
  secrets are absent. A `verify` that quietly skipped the only check covering the device would
  be worse than having no gate, because it would read as green.
  **Three findings:**
  1. **A latent bug in the plist check, found by writing its test.** `plist_is_stale` originally
     read `ProgramArguments` with `PlistBuddy ... || true` and treated a non-empty result as the
     installed path. **PlistBuddy writes `Error Reading File:` to STDOUT and exits 1** - so a
     corrupt plist yields a *non-empty* string that compares unequal to the wanted path and is
     indistinguishable from a stale one. The original code would have answered "stale" for an
     unreadable plist and sent `update` off to do a **privileged re-render on the strength of a
     parse error**. Now branches on exit status. This was not on anyone's list; it fell out of
     asking "what does this do with a file that is not a plist".
  2. **The two staleness causes are one rule, not two.** The node binary moving (a Homebrew
     upgrade, already handled) and the entry point moving (this ticket) end identically: launchd
     execs a path that is not there and `KeepAlive` respawns into the same failure forever. They
     are now one predicate with two branches and a stated reason, rather than two special cases.
     **The re-render must be followed by `bootout`+`bootstrap`, not `kickstart`** - `kickstart`
     does not re-read the plist, so it would relaunch into the same wrong path.
  3. **`sudo` is the wall an agent cannot climb, so the risky path was made testable instead.**
     `render_plist` and every `launchctl` call need root, and there is no sudoers rule on this
     host. Rather than claim the migration works, `deploy/onair` grew an `ONAIR_LIB_ONLY=1`
     source seam and a split of `render_plist` into a pure `render_plist_to DEST` plus the
     privileged install. `deploy/test-update.sh` then exercises the whole risky surface with no
     sudo and `/Library` untouched: stale/current/moved-node/absent/corrupt plists, a
     byte-for-byte render whose output is fed back in to prove the check **converges** rather
     than oscillates, and the dist swap and rollback on a scratch tree including the
     nothing-to-roll-back-to case. 19 assertions, in `npm run verify`. **The detection was also
     run against the real installed plist on this host**, which correctly reports stale and
     names the right replacement path.
  **The live daemon is deliberately left one step behind.** The installed plist still names
  `$APPDIR/dist/index.js`, and the pre-move root `dist/` is still on disk (gitignored), so the
  running service and any `KeepAlive` respawn keep working - through a reboot. #36 changed no
  runtime source, so that build is functionally identical to the new one. **The migration
  completes when Rocket runs `sudo deploy/onair update`**, which is the one step in this ticket
  an agent cannot perform. Chosen over the alternative - symlinking root `dist/` at
  `server/dist/` - because D-37 rejected a root-level shim by name, and a "temporary" symlink at
  the exact path a permanent one was rejected at is how permanent cruft arrives.
  **Two taste calls.** (a) `admin-ui/` and `companion-module/` ship as a `package.json` plus a
  README naming the ticket that fills them. A workspace list is a claim about the repo; three
  names that all resolve makes it true today rather than aspirational, and it means #42 and #44
  do not have to touch root config. They declare no scripts, so `--if-present` skips them and
  `verify` does not pretend to have checked anything there. (b) `make -C firmware config` is the
  canonical target name D-37 specified; the lab's `validate` survives as an alias, because
  muscle memory is cheap to honour and a removed target is a confusing failure.
  **One thing corrected in passing.** `README.md` still claimed "zero production npm
  dependencies", which D-29 retired and `CLAUDE.md` already flags as never having been a rule.
  Left in place it would keep being cited. Now says what D-29 says.
- **D-48 (2026-08-24)** **The ladder is gone from the server. The table is on the wire, and
  the live light never stopped telling the truth.** Resolves
  [#37](https://github.com/jwnichols3/rocket-on-air-sensor/issues/37). Implements D-31, D-33,
  D-34, D-41, D-42 and contract §1, §2, §5.
  **What the wire says now.** `state` (a row id), `busy`, `intended`, `confirmed`, `hold`,
  `source`, `updatedAt`, `ageSeconds`, `stale`, `tableVersion`, `message`, and
  `stateResolvedFrom` only when the live row was deleted. `level` and `onAir` are gone;
  `POST /available|interruptible|dnd` are gone and `POST /state/{id}` replaces them; `/on` and
  `/off` resolve through shortcut rows and are `409` when unset. Every derived field is
  computed at serialisation, so none of them can drift from `state`. **No `label`, `color` or
  `bgcolor` anywhere on the state payload** (D-42), enforced by a test that enumerates them.
  **The ladder rule became the busy rule, and the substitution is exact.** "Never lower the
  rung without fresh evidence" is now "never go calm without fresh evidence" -
  `RANK[want] >= RANK[got] || fresh` became `table.busy(want) || !stale`. There is no rank left
  and there does not need to be: `busy` was always the only thing rank encoded that mattered.
  `StateTable.busy()` **defaults to `true` for an id it does not hold**, which is the safety
  model in one line - an id nobody recognises must never read as calm.
  **A one-time v1 migration, and why it is not D-34's fallback.** D-34 says an id that is not
  in the table resolves to `unknown`. That is right for a row the owner *deleted* and wrong for
  `level: "dnd"` in the live state file: that is the same meaning in the old vocabulary, not a
  dangling reference, and resolving it to NO DATA would have flipped the panel to the fault
  appearance on the upgrade restart. `dnd -> on-air`, both `busy`, meaning preserved, logged
  out loud. Observed on the live host: `[onair] migrated v1 state file: dnd -> on-air`.
  **Expand-then-contract on the device, again, and it paid for itself twice.** The firmware
  learned the five seed rows **while still recognising `dnd`**, and was flashed before the
  server restarted. The cutover was therefore invisible on the glass - the panel drew ON AIR
  from `dnd` before, and ON AIR from `on-air` after, with no flash of `UNKNOWN KEY` in between.
  The alias also **insures the rollback**: the v1 binary writes `dnd` again, and a rolled-back
  server must not blind the panel. It goes with the rest of the hardcoded block in #43.
  **The panel's branch is chosen by `busy`, not by a rung.** Every busy row gets the solid-block
  appearance and is told apart by its **label**, which is the row's rather than the firmware's -
  so `recording` needed no new appearance, only a new label. The false-calm guard is now
  `stale && known && !row_busy`, deliberately restating the server's rule on the device so the
  panel stays safe even if the server heartbeats something it should not.
  **`intended` earned its keep, visibly.** `/display` has never heard of `recording`. Handed it,
  the page fell back through `intended` to ON AIR on red - not to nothing, and not to calm.
  That is RFC 3863's carry-along working exactly as D-33 argued it would, checked in a browser
  rather than asserted. **A state that degrades to nothing looks exactly like a calm one**, and
  this is the mechanism that prevents it.
  **Two things done outside the ticket's letter, both to avoid breaking something quietly.**
  (a) `/ui` was repointed at `POST /state/{id}` and taught to read `state`. Its buttons posted
  to routes this ticket deletes, so leaving it alone would have handed Rocket a control panel
  whose every button `404`s until #41 retires the page. It is still hardcoded to three seed
  rows, and says so in a comment. (b) `/display` now reads `state` first. It would have
  *worked* untouched - the `intended` fallback saw to that - but it would have silently
  collapsed to two states, and the four-line fix is cheaper than the confusion.
  **The pin rule is NOT here.** `StateStore.write` records and releases a pin (including "a
  human write naming another state releases it"), and reports it. Deciding whether an `auto:`
  write is *refused* while a pin is set is #38. Stated plainly because it is a real gap in the
  meantime: **a pin currently does not refuse anything.** The escalation carve-out and the
  `409` land with #38.
  **Measured on the real light.** All five seed rows drove end to end - API -> device key ->
  panel label - at 61-290 ms; an unknown id `400`s and lists the valid ids without ever
  reaching the light; an unprefixed `source` on `PUT /state` `400`s; the three rung routes
  `404`; `/on` and `/off` resolve to `on-air` and `available`; `?source=companion` becomes
  `human:companion`. 170 server tests, 19 deploy tests, `esphome config`, all green.
  **One operational note that will confuse the next reader.** The build is deployed to **both**
  `server/dist/` and the repo-root `dist/`, because #36's plist migration has not been run yet
  and the installed plist still launches `$APPDIR/dist/index.js`. That is the deploy target the
  running system names, so building the current code into it is deploying, not shimming. Once
  `sudo deploy/onair update` runs, the root `dist/` is garbage and should be deleted.
- **D-49 (2026-08-24)** **The pin refuses, and the held state stands - the second half of that
  sentence was nearly missed.** Resolves
  [#38](https://github.com/jwnichols3/rocket-on-air-sensor/issues/38). Implements D-32 and
  contract §3.
  **What shipped.** `judgeWrite()` is the pin rule as one pure function: an `auto:` write while
  pinned applies only when it moves `busy: false -> busy: true`; everything else is `409`; a
  `human:` write always applies; any source that is not `human:` touching `hold` at all is
  `403`. **The `403` is checked first**, deliberately - an `auto:` source trying to *release* a
  pin has an authority problem, and answering `409` would tell it to back off and wait when
  what it needs to do is fix its `source`. The busy rule was already in the supervisor from
  D-48; this ticket added the edges - the 90 s boundary, "a stale BUSY state IS still
  heartbeated", "no auto-raise", "no TTL" - as tests rather than as new code.
  **The bug worth recording, and how it surfaced.** The first implementation refused the write
  and stopped there. The live transcript then read: pin `interruptible`, detector escalates to
  `on-air`, call ends, detector's `available` is refused - **and the light stayed ON AIR.**
  Every unit test passed. D-32's sentence is *"refused (`409`) and the held state stands"*, and
  the contract spells out *"the light settles back to `interruptible`"*; the code implemented
  the first clause and not the second. Left alone that is a **false ON that never clears**: the
  meeting is over, and nothing will move the light again until a human notices - which is the
  precise failure this system exists to prevent, arriving through the mechanism meant to
  prevent it. **The pin is what the system falls back TO, not merely a veto.**
  It was caught by reading a real transcript against the spec sentence, not by a test - the
  tests asserted what the code did. That is the argument for running the thing and reading the
  output even when the suite is green.
  **So a `409` now settles the system at the held row**, drives the light there, and records
  `source: human:hold` - the pin decided this, and says so. A `403` does none of that and
  leaves the world exactly as it found it. A refusal already at the held row re-drives nothing.
  **Attribution is a taste call.** `human:hold` rather than keeping the refused writer's source
  or the source that set the pin. The settle-back is a human instruction being carried out, so
  it is `human:`; naming it `hold` makes the event log read *"INTERRUPTIBLE human:hold"*, which
  is what actually happened.
  **One small correction in passing.** `/display`'s staleness check was
  `source === 'detector' && age > 300`. Every detector source has been prefixed `auto:` since
  D-41, so that condition had **stopped matching anything at all** - the page could never go
  stale. It now trusts the server's `stale` field and only extends it forward between events,
  which is the only thing a page with no clock of its own can usefully add.
  **Measured on the real light**, end to end: pin -> escalate -> refuse -> settle back, with
  the panel following each step (INTERRUPTIBLE, ON AIR, INTERRUPTIBLE), then release and a
  clean automated `available`. 199 server tests, 19 deploy tests, `esphome config`, all green.
- **D-50 (2026-08-24)** **Config is a document the service can survive.** Resolves
  [#39](https://github.com/jwnichols3/rocket-on-air-sensor/issues/39). Implements D-36 and
  contract §5 (`GET /config/states`), §10.
  **What shipped.** `~/.onair/config.json`, 0600, holding version, port, bind mode, the state
  table, the shortcut rows, the device credentials and a reserved `auth` block. One validation
  function, one atomic write (temp file created 0600 *before* any content, `fsync`, `rename`),
  one apply path - the admin UI has no privileged route, it calls the same `PUT /admin/config`
  anything else would. `GET /config/states` serves the versioned table with an `ETag` and
  honours `If-None-Match`. Saves are optimistic on `version`; a stale base is `409` **with the
  current document**, so the UI can show what moved underneath rather than overwrite it.
  **`config.env` is retired as the config source and survives as an env overlay**, because a
  real environment variable winning over the file is D-14's rule and the documented way to
  unbrick a box over SSH. On first boot the document is **written out**, seeded from the env
  where present: a config file that does not exist until you use a UI is not "hand-editable, on
  a Pi, over SSH, with no UI". A file that failed to *load* is never overwritten - that is what
  the repair view is for, and clobbering it would destroy the thing the owner needs to read.
  **A deadlock, found by a test that hung.** `applyConfig` awaited the old listeners closing
  before binding the new ones. But a rebind is triggered *by a request*, and that request is
  itself one of the in-flight connections: `close()` waits for the response to be sent, and the
  response waits for `close()` to return. It hung for exactly as long as the test timeout, in
  three tests at once. **This was not a test artifact** - the same deadlock would have hit the
  first time anyone changed the port from the admin UI, which is the only way that route is
  ever going to be called. Fixed by not awaiting: the listening socket shuts immediately either
  way, which is all a rebind needs, and the old sockets are swept a second later once our own
  response has flushed.
  **A test that wrote into `$HOME`, found by deploying.** `config.test.ts` spawns the *real*
  service to prove the config file is read before `ONAIR_PORT`. It set `ONAIR_CONFIG` (the env
  overlay path) but not `ONAIR_CONFIG_FILE` - which did not matter until this ticket made the
  service **write** a document on first boot. It then wrote `~/.onair/config.json` on the
  development machine, with the test's port and no device. Found because deploying showed a
  config file that already existed and was wrong. Fixed, plus a test that asserts the document
  lands where it was told, plus both spawned-service tests moved off hardcoded ports - a fixed
  port is a flake by construction, and one of them duly failed once on an orphan of my own.
  **The trap that leaves behind, and it is live.** The installed plist carries
  `ONAIR_PORT=8484` and `ONAIR_STATE_FILE` in `EnvironmentVariables`, which the **template does
  not**. So when `sudo deploy/onair update` re-renders it (D-47), those variables **disappear**,
  and the port stops coming from the environment and starts coming from the document. The
  polluted document said `18473`. The service would have moved port on the next restart, on the
  one host that exists. The document has been corrected on the host to `8484` with the real
  device settings, so the migration is now safe - but the general shape is worth stating:
  **retiring an env var means the file it falls back to had better be right first.**
  This also means D-14's promise - *the plist carries no `ONAIR_*` config* - becomes true again
  after that update, having quietly not been true on this host.
  **Never fail closed, and it is tested rather than asserted.** An unparseable or invalid config
  logs every error, binds **loopback only**, starts on defaults, and serves `/admin/repair` - a
  self-contained page that renders the errors and the raw text **server-side**, because a
  diagnosis that only appears if a second request succeeds is the wrong way round on a page
  whose entire job is "something is broken". Saving from it is the repair. With a healthy config
  the route is a `404`, which is the honest answer.
  **Rebind rolls back.** A port or bind change closes and re-opens in place; a failure restores
  the previous binding and answers `409`, and if even that fails it falls back to loopback. It
  never exits - under `KeepAlive` a process exit on a bad address is a crash-loop, and "restart
  and hope" is not safe to invoke from across the house. Proven by pointing the service at an
  occupied port and watching it keep serving on the old one.
  **Loopback is always bound**, in every mode, including `iface:<name>` and including a name
  that does not resolve. Binding only a LAN address makes `127.0.0.1` refuse, which would
  disable the admin surface from the UI whose only purpose is administration.
  **Measured live**: `ETag "1"` -> `304`; a label edit -> version 2, `ETag "2"`, table live
  immediately; the same document resubmitted -> `409` naming both versions. 236 server tests,
  19 deploy tests, `esphome config`, green.
- **D-51 (2026-08-24)** **Two credentials, two audiences, and the waiver that makes both
  invisible at home.** Resolves
  [#40](https://github.com/jwnichols3/rocket-on-air-sensor/issues/40). Implements D-35, D-43
  and contract §8, and carries D-24 forward unweakened.
  **What shipped.** The passphrase (default `onair`, D-43) gates every data route; the admin
  user/password (`rocket`/`ESP32`, D-35) gate `/admin/*` through an in-memory bearer session
  with **no cookie**. `POST /admin/session` takes either nothing (the waiver applies) or
  `{user, password}`. **Neither credential is accepted on the other's routes**, tested in both
  directions. `ONAIR_PASSPHRASE`/`ONAIR_TOKEN` in the real environment is folded in as the
  passphrase rather than gating separately, so there is exactly one credential in play instead
  of two gates that could disagree - and every client on the LAN kept working across the deploy.
  **D-24 is implemented clause by clause, and both measured attacks are regression tests** at
  the unit level and over HTTP. Verified on the live service: a foreign `Origin` from loopback
  is `401`, and another port on the same host with `Sec-Fetch-Site: same-site` is `401`, while
  a genuine local request needs no credential at all. Each clause is separately tested, so
  none of them can be dropped as "redundant" later.
  **Query credentials are GET-only.** `?passphrase=` exists for the three places a header is
  impossible - `EventSource`, the WebSocket upgrade, a remote kiosk navigation - and all three
  are GETs. Allowing it on a write would put the credential in server logs and browser history
  for the sake of nothing that needs it. `?token=` survives as the deprecated alias.
  **A bug that would have silently discarded credential changes.** `rotate()` first took the
  new passphrase and returned `{...liveAuth, passphrase}`. That threw away any admin password
  submitted in the same save: the request answered `200`, the file kept the old password, and
  the sessions were not invalidated - a change you would believe had happened. It now takes and
  returns whole blocks. **Anything that merges credentials has to merge all of them or none.**
  Found because a test asserted that changing the admin password logs everyone out, and it did
  not.
  **A migration trap caught before deploying, not after.** The config document shipped one
  release with `auth: { passphrase: null }` as a reserved field. The new validator rejected
  `null` as an empty credential - which would have put the live host into the repair view,
  **bound to loopback, taking the light off the LAN to complain about a field meaning "not
  configured"**. Absent (`undefined` or `null`) now means "take the default"; empty (`""` or
  whitespace) is still an error, because that is someone typing nothing into a credential
  field. The distinction is the whole of it.
  **Factory reset keeps the device credentials.** D-35 lists what a reset restores and does not
  mention them. They were compiled into the firmware (D-17) and are not ours to forget: a reset
  that silently dropped them would take the light offline with no error, which is the opposite
  of what someone reaching for a factory reset wants. Everything else goes back - credentials,
  the seed table, the hold, `unknown`, `bind: all`, port 8484 - and every session dies.
  **The one carve-out holds:** the admin password is demanded from any origin, including
  loopback, and the waiver does not cover it.
  **The live document is now self-sufficient.** Its `auth` block was written out explicitly
  rather than left implicit, because with it absent, removing `ONAIR_TOKEN` from `config.env`
  would silently drop the passphrase to the shipped default - a security change with no visible
  symptom. Same shape as the D-50 trap, caught the same way: **retiring an env var means the
  file it falls back to had better be right first.**
  **`/display` was deliberately left on `/events`.** It needs `message` and `hold`, which the
  thin public view does not carry, and half-migrating it would trade a working page for a
  broken one. It keeps working unauthenticated at the kiosk via `?token=`, and locally via the
  waiver. Moving it to `/public/events` belongs with #41, which rebuilds it.
  **272 server tests, 19 deploy tests, `esphome config`, green.** The light never went dark.
- **D-52 (2026-08-25)** **`/display` holds no vocabulary, and `/ui` is gone.** Resolves
  [#41](https://github.com/jwnichols3/rocket-on-air-sensor/issues/41). Implements D-42 and
  D-25/D-35; D-9's rules are intact.
  **The page no longer knows any states.** No hardcoded appearances, no list of ids, no CSS
  class per rung - the server resolves the current row and sends `label`, `color` and
  `bgcolor` already worked out. A test asserts that no row name appears anywhere in the page,
  including in a comment, because anything it recognised by name would be a row it could draw
  and another it could not. Proven in a browser with a row invented minutes earlier: `deep-work`
  rendered `DEEP WORK` in the owner's `#0b0b0b` on `#7cc4ff`, with the message subordinate
  underneath, then switched live to `ON AIR` on `#c1121f` with no reload.
  **`message` was added to the public view, and that is a decision rather than an oversight.**
  D-35 specified the thin payload without it, but `/display` is served unauthenticated and
  therefore cannot read the gated stream, and D-9 requires the message. It discloses nothing
  the panel on the wall does not already show. `hold` was **not** added: D-35 excluded it
  deliberately, so the HELD badge is gone from `/display` and lives on the admin landing page
  (#42), which reads gated data. A passer-by does not need to know whether a state was pinned.
  **A state with no row borrows the RESERVED row's look**, rather than a colour compiled into
  the page. `unknown` cannot be deleted (D-34), so it is always available, and the owner may
  have restyled it - checked, by renaming it and watching the fallback follow.
  **A silent bug only a browser could catch.** The rewritten page used `es.onmessage`. The SSE
  hub sends `event: status`, a **named** event, and `onmessage` only receives unnamed ones. So
  the page connected, the server streamed, and it sat on its opening `NO DATA` appearance
  forever - **no error, nothing in the console, and every test passing**, because the tests
  exercise the endpoint and not the page's script. This is exactly the class of failure the
  live-Chrome check exists for, and it is the second time this repo has been saved by looking
  at the thing. Now asserted structurally: the page must use `addEventListener('status')` and
  must not use `onmessage`.
  **A test-harness fix worth more than the ticket.** `server.test.ts` leaked a listening server
  whenever an assertion threw before its `await h.close()`, so a five-second failure was
  reported after seventeen minutes of hanging. It has bitten twice. The file now sweeps every
  harness it opened in an `after()` hook; a deliberately-broken test that leaks now reports in
  **0 s**, measured. The same shape as the note already in the ops memory, made structural.
  **`/ui` is retired, not moved.** A `404`, deliberately: there is no equivalent page at another
  path, and a redirect would send a bookmark somewhere that answers a different question. Its
  Admin card and controls arrive in the admin UI (#42). **Between this ticket and that one
  there is no browser control surface at all** - `curl` and the Stream Deck are the manual
  paths. Stated plainly because it is a real gap, taken because #41 is specified to remove the
  page and #42 was the next ticket in the same run.
  283 server tests, 19 deploy tests, `esphome config`, green.
- **D-53 (2026-08-25)** **The admin console, built and driven.** Resolves
  [#42](https://github.com/jwnichols3/rocket-on-air-sensor/issues/42). Implements D-39, D-36
  and D-35.
  **`admin-ui/` has a real build, and it is thirty lines.** `src/index.html`, `src/app.css`,
  `src/app.js` are inlined into one self-contained `server/public/admin/index.html`. A bundler
  would be a dependency, a config file and a lockfile entry to serve one page with no imports
  and no framework; the whole build is read three files, substitute two placeholders, write
  one. The output is self-contained for the same reason `/display` is - the page has to render
  when the thing it would fetch assets from is the thing that is broken.
  **Served at `/` and `/admin`, unauthenticated and byte-identical for everyone.** Tested as
  byte-identity rather than by grepping for credential strings, because that cannot work here:
  the default passphrase is `onair`, a substring of the product's own name, and the default
  admin password is `ESP32`, the name of the hardware. What matters is not which strings are
  absent but that the bytes do not vary with who asked. Logged out, the page is D-39's landing
  tally - a tally, not a dashboard.
  **`onair update` rebuilds the console.** It is a static asset under `server/public`, not part
  of `dist`, so it is rebuilt in place rather than staged. Skipping it would have left an
  update serving yesterday's console with no symptom except that a fix did not appear.
  **Two bugs that only a browser could find, both silent.**
  1. **`var status` at top level binds `window.status`**, a legacy *string* property. So
     `status = someObject` stored `"[object Object]"` - truthy, and with no fields. The page
     rendered as `connecting...` forever with a single exception in the console and nothing
     else. Renamed to `liveStatus`.
  2. **The five-second status poll rebuilt every row node**, which swapped the DOM out from
     under whatever the user was doing. Typing went into an input that no longer existed a
     moment later; a click on `Edit` landed on a button detached between mousedown and click,
     so the handler never ran. **Neither produced an error.** The page simply did not respond,
     which is indistinguishable from a slow one. Rows are now rebuilt only when the LIVE badge
     actually moves, and never while a row is open.
  Both are now regression tests, and both are the same lesson as D-52's `onmessage`: **the
  tests exercise the endpoints; only driving the page exercises the page.** Three times in this
  run now.
  **The commit model, and the distinction the prototype surfaced.** *Cancel* while editing
  returns the row to its **last staged** value; *Revert* is a separate control that drops it to
  **live**. Collapsing them loses the ability to abandon a typo without also throwing away a
  change staged ten minutes ago. Verified by driving it: edit -> stage -> `1 staged` and the
  save button enables -> Revert -> back to live and the count clears.
  **Contrast is the most valuable thing on the page, and it earns that live.** Setting
  `interruptible` to `#3a3a3a` dropped it to **1.53:1 fails AA** in red with a row banner, and
  the panel mock went barely legible at the SH1106's proportions - before saving, and without a
  firmware round trip.
  **No rationale prose ships**, per Rocket's note on the prototype. A test greps the shipped
  page (comments stripped) for the tells of explanatory writing. The reasoning lives in the
  source comments and here.
  **Deleting a live row says what will actually happen** - the state resolves to `unknown`,
  `GET /status` reports where it fell back from, bound Companion buttons start getting `400` -
  and the button reads **"Stage the delete"**, because it still only stages.
  **A taste call, on the review list:** the section order is Status, States, Admin settings,
  Network, Light, and the `busy` toggle reads "Busy - the camera may be live" / "Calm". The
  passphrase is shown in plaintext (D-39's call, unchanged): it has to be read to be typed into
  the ESP32 and Companion, and a reveal control would only add a click to that.
  300 server tests, 19 deploy tests, `esphome config`, green.

- **D-54 (2026-08-25)** **The panel holds no vocabulary: the table is pulled, and colour
  reaches a 1-bit display through shape.** Resolves
  [#43](https://github.com/jwnichols3/rocket-on-air-sensor/issues/43). Implements D-38's
  config pull and D-42's version nudge; **removes the last hardcoded row list from the
  firmware.**
  The device pulls `GET /config/states` on Wi-Fi connect, every 300 s, immediately on a key
  its table does not contain, and immediately on a `tableVersion` it does not hold. Steady
  state is a `304` on `If-None-Match`, echoing the server's own ETag bytes back rather than
  re-deriving them. The buffer is D-38's 8 kB, and the number now has a measurement under
  it: the seeded five-row table is **645 bytes on the wire**, so a row costs ~129 bytes and
  8 kB covers ~60 rows. It is not free headroom - `HttpRequestSendAction::play` allocates
  the whole buffer on every request, so sizing it for a hypothetical maximum table would
  churn it every 300 s for nothing. A body that exactly fills the buffer is reported as
  truncated rather than as a parse failure, because those have different fixes.
  **Parsing is all-or-nothing and an empty `states` array is a failure, not an empty table.**
  A bad pull leaves the previous table untouched; the server always seeds at least the
  reserved `unknown` row, so zero rows means we misread the body. `NO CONFIG` is its own
  branch on the glass, distinct from `NO DATA`: `NO DATA` means the server stopped talking
  about *state*, `NO CONFIG` means we have never heard the *vocabulary*. Different cause,
  different fix, different picture.
  **The table is deliberately RAM-only.** ESPHome's restoring globals cap at 254 bytes,
  which a table exceeds - but persisting it would be wrong anyway, since a table the device
  cannot vouch for is exactly what `NO CONFIG` exists for. A reboot re-pulls, and a **15 s
  retry runs until the first success and then stops**: without it a board that booted while
  the server was down would sit on a blank-looking panel for up to five minutes after the
  server came back. Measured: the `on_connect` pull sometimes fails, because association is
  not a usable route - DHCP may not have finished - and delaying by a fixed amount would be
  guessing at someone else's DHCP server.
  **Colour, on a 1-bit panel, picks the CALM shape.** Two calm rows are identical in
  semantics and differ only in presentation, so the shape has to come from presentation.
  Lit pixels are what this display has instead of colour, so a brighter background gets more
  of them: `luminance(bgcolor) >= 128` draws the ink-heavy double frame, below it the open
  ring. On the seeded table this is **byte-identical to the old hardcoded look** -
  `interruptible` (#e8a317, luma 167) heavy, `available` (#0b6e2e, luma 73) light - which is
  the point: it reproduces the design without the firmware knowing either row's name.
  **Colour gets no vote near a busy row.** Shape there stays keyed on `busy`, because a dark
  red and a dark green have near-identical luma and a false OFF is the one error that
  matters. That is the same reason an unknown key is assumed busy.
  **Freeze means freeze.** `AutoProfile: off` gates the 300 s interval, the version nudge and
  the unknown-key self-heal. It does **not** gate the boot pull (a frozen board has no table
  to freeze - the table is not persisted - so gating it would strand the panel on `NO
  CONFIG`), and it does not gate the Refresh button or a passphrase change, which are people
  asking rather than the server asking. A freeze **survives a reboot**: `RESTORE_DEFAULT_ON`
  restores the stored value and only defaults on when nothing is stored. Kept that way
  deliberately - freezing is a decision and a power cut does not change the operator's mind,
  and it is not a safety question, because state still pushes while frozen.
  **A plain header, not an external component.** `firmware/configs/onair_table.h` is a
  struct, a lookup and a parser. Forced detail worth recording: ESPHome emits an `includes:`
  file **after** the block that instantiates `GlobalsComponent<T>`, so a `globals:` entry
  whose C++ type comes from the include does not compile. The held table therefore lives in
  a function-local static behind an inline accessor, which needs no declaration order at all.
  What an external component would buy - a device-served config page, an NVS-persisted table
  - is D-40's ground and stays [#33](https://github.com/jwnichols3/rocket-on-air-sensor/issues/33).
  **Also gone with the hardcoded rows:** the `dnd` alias that carried the v1->v2 cutover, and
  `PresenceKey`'s `initial_value: "dnd"`, which now lands on the reserved `unknown` row so a
  restored value is a row this panel recognises.
  **The version nudge, server side.** `LightDriver.setTableVersion?` is optional, is not read
  back (it is advisory; the pull carries the table, and paying three extra reads on every
  state write for it is the wrong trade), stops after one `404` (firmware older than this
  has no such entity and would otherwise log on every write), and never caches a version it
  failed to send. It fires on a state write **and on a config save** - without the second, a
  pure presentation edit reaches the panel only when something else happens to write state,
  which on a quiet afternoon is hours.
  Live: a colour edit with no state write reached the glass in about three seconds; a key
  the table lacked drew `UNKNOWN KEY`, triggered a pull, and the supervisor healed it;
  frozen, the device ignored a nudge to v8 and stayed on v7 until the button was pressed.

- **D-55 (2026-08-25)** **Correction: `mode: password` does not keep a value out of the
  device's REST API. D-38 asserted that it does, and it does not.**
  D-38 said *"`mode: password` masks the value in the JSON, so a passphrase entered on the
  device is not readable from its own REST API"*, and #43's acceptance criteria were written
  from that. **Measured on the pinned ESPHome 2026.8.0, on the live board:**
  ```
  GET /text/ServerPassphrase
  {"id":"text/ServerPassphrase","value":"<the real passphrase>","state":"********"}
  ```
  `web_server.cpp:1421` picks a masked string for `state`; `set_json_value` then assigns the
  **raw** `value` unconditionally, on every read and every SSE event. There is no detail
  level or mode that suppresses it.
  **Why this is not cosmetic.** The device's basic auth is the DEVICE credential (D-17). The
  passphrase is the SERVER credential (D-35). Serving the second from behind the first
  collapses the separation those two decisions exist to maintain: anyone who can read the
  panel's own API gets the credential for every gated route on the server.
  **The fix: no entity holds the secret.** `ServerPassphrase` is write-only - a `lambda:`
  makes its value the constant `********` and a `set_action` is the only way in. Persistence
  moves to an NVS preference blob in `onair_table.h`, where a stored value beats the
  compiled-in `!secret` so a rotation survives a reflash. Verified after: `value` and
  `state` both read `********`, at `?detail=all` too.
  **The general lesson, and it is the same one D-40 recorded:** a component's YAML surface
  was taken for a guarantee about its behaviour. `mode: password` is a UI hint about how to
  render an input; reading it as an access-control property was the error. Check what the
  component *serialises*, not what its option is called.
  **Operational note for Rocket, not a code change:** the live passphrase was readable from
  the device between the first flash of #43 and this fix, and it appeared in plaintext in
  the session log that found it. Rotating it in the admin console is cheap - D-35's 60-minute
  grace window exists exactly so the detector, Companion and the panel do not all break at
  once - and it is on the review list rather than done, because it is a live-credential
  change that is Rocket's to make.

- **D-56 (2026-08-25)** **One default login for the whole product.** Rocket's call:
  *"it is super confusing to have two different default user/pw combos. please make the
  default user/pw for the esp32 the same as the admin console."* The panel's `web_server`
  auth moves from `onair` + a random per-device password to **`rocket` / `ESP32`**, which is
  `DEFAULT_ADMIN_USER` / `DEFAULT_ADMIN_PASSWORD` in `server/src/auth.ts`.
  **What this costs, stated rather than buried:** `ESP32` is published in a public repo, so a
  strong per-device secret is replaced by a known one. Two things make that acceptable and
  they are both load-bearing. The panel is a LAN device driving a light, so the blast radius
  of its web UI is the light. And **the credential that actually matters is a different one**
  - the server passphrase gates every data route, is not a default on this host, and as of
  D-55 is not readable from the panel at all. This decision does not touch it.
  **It does NOT collapse D-35's two audiences.** Those are still two credentials for two
  jobs; they merely start life at the same default value, the way a product ships one
  default rather than two. `web_server_password` remains a secret in `secrets.yaml`, so a
  per-device password is a one-line change plus `light.password` in the config document.
  **A wrinkle worth knowing:** the console's credential is editable at runtime and the
  panel's is compiled in, so changing the admin password in the console does **not** change
  the panel's - they match as shipped and can diverge afterwards. Making them track each
  other would mean the server pushing a credential to the device, which is exactly the
  coupling D-55 just removed.
  **Not changed:** `fallback_ap_password` (WPA needs 8 characters; `ESP32` is five) and
  `api_encryption_key`. Neither is a login anyone types.
  Migration is a reflash plus `light.username`/`light.password` in `~/.onair/config.json`
  **and** the `ONAIR_LIGHT_USER`/`ONAIR_LIGHT_PASS` lines in `config.env`, which override the
  document (D-14) and would otherwise silently keep the old credential. Verified after:
  `rocket:ESP32` → 200, `onair:ESP32` → 401, and a write round-tripped to
  `confirmed: on-air` then `confirmed: available`, which is the device answering.

- **D-57 (2026-08-25)** **The panel serves its own two pages, and a local override is
  presentation and nothing else.** Resolves
  [#33](https://github.com/jwnichols3/rocket-on-air-sensor/issues/33), the last of D-38's
  device-side architecture and the last open ticket on the v2 backlog.
  `GET /onair` is open and read-only; `GET`/`POST /onair/config` sits behind the device's
  own basic auth. Both are `AsyncWebHandler`s on the `web_server` ESPHome already runs on
  port 80 - **no second listener, no second port and no second credential.**
  **D-40 was right that this was possible and wrong about what it needed.** It recorded
  that a device-served page required an external component. It required two headers:
  `web_server_base::add_handler()` and `add_handler_without_auth()` take any handler at any
  time, and a handler registered after `init()` attaches to the running server. `on_boot`
  at priority `-100` runs after every component setup, and `web_server`'s priority is
  `WIFI - 1`, so the server is up by then. This is the third time in this project that a
  component's *surface* was read as a statement about its *architecture*; D-40 and D-55 are
  the other two, and the lesson has not changed.
  **The overlay, and why `busy` is not a field in it.** The device holds the pulled table
  (RAM only, D-54) and, separately, a sparse `row id -> {label?, color?, bgcolor?}` overlay
  in NVS. `effective(id)` merges them at lookup. `busy` is **absent from the Override
  struct**, which is a stronger guarantee than validating it away: an override that could
  set a busy row calm would draw a calm shape while the server believed the row was busy -
  a false OFF, the one failure this system exists to prevent - and a field the struct does
  not have cannot be set by a malformed POST, a corrupted record, or an edit six months
  from now that forgot why the check was there. Row **membership** is the server's for a
  milder version of the same reason: the server addresses states, so a row invented locally
  could never be selected. A `busy` parameter on a save is **refused with a message**, not
  ignored, because silently dropping it would let a caller believe it had been applied.
  **ONE rendering decision, not two.** `compute_view()` moved out of the display lambda
  into `onair_table.h`, and the glass and the status page both call it. Staleness, THE BUSY
  RULE, the `unknown` landing row and the luminance choice all live there now. A status
  page that could say "available" while the panel beside it said `NO DATA` would be worse
  than no status page, and the only way to guarantee that permanently is for there to be
  one function. `onair::Shape`'s values ARE the `Render` sensor's branch numbers, so that
  entity keeps working and now takes its names from the same table the page prints.
  **The overlay persists and the table still does not - measured, in the same window.**
  A reflash, then polling `/onair` every 200 ms: at t+4.5 s the page read `NO CONFIG`,
  `profile: none held`, `overrides: 1 row(s) locally`; at t+4.8 s the pull landed and it
  read `v9, 5 rows`. That is both halves of the invariant in one transcript - an overlay is
  not a vocabulary, and a boot that has not reached the server still has nothing to say.
  **The save is proved, not assumed.** Espressif warn a blob write can fail on page
  fragmentation with space apparently free, and ESPHome's `save()` only *queues* - the
  `nvs_set_blob` happens in `sync()`. The authority is therefore the **read-back**:
  `sync()` clears the pending-save cache, so the `load()` after it is a real flash read.
  `sync()`'s own return value is not trusted for the verdict, because it flushes every
  pending preference and answers false if *anyone's* failed.
  **The handlers run on esp-idf's httpd task, not the main loop.** That one fact shapes the
  whole of `onair_page.h`. Reads take a mutex - `table = next` on a pull is a vector move
  that would pull the strings out from under a concurrent reader - and **writes are staged
  and applied by the main loop**, with the HTTP task blocking on the result for up to 3 s.
  Blocking the browser's task rather than the display's is the right way round. Nothing in
  the page touches an ESPHome component API directly, which is also why "Refresh profile
  from server" sets a one-shot flag that a 100 ms interval turns into `script.execute`.
  **The login is the browser's prompt, not a form.** `add_handler()` puts the config page
  behind `web_server`'s own auth middleware, so following "Configure" raises the standard
  credential dialog. A styled form would mean this code owning a session and a cookie,
  which brings D-23's CSRF objection back onto a device with no CSRF defences. Flagged as a
  taste call rather than assumed.
  **A dormant override is kept and shown.** An override whose row the server has since
  removed still applies to nothing; it is listed as `dormant` with its own Clear button.
  Dropping it silently is the failure mode D-45 named, and it costs one line to not have.
  **The passphrase is not on either page** and is not offered for setting there. D-55 put
  it outside the entity system; duplicating a write-only credential field onto a page about
  presentation would invite exactly the confusion D-55 came out of.
  Live, on the board: an override of `available` to `FREE` on `#ffffff` flipped the calm
  shape from `CALM LIGHT` to `CALM HEAVY` (luma 73 -> 255 across the 128 line, D-54's rule
  doing what it says); four malformed saves - `busy` submitted, an invented row, `blue` as
  a colour, a 65-character label - all returned `400` with a readable reason and left the
  stored override untouched; `/onair/config` answered `401` without a credential and with a
  wrong one; a temporary server row was added, overridden, removed, and the override
  reported itself dormant; Clear all restored `AVAILABLE` / `#0b6e2e` / `CALM LIGHT`
  exactly. The server config was left byte-identical apart from its version (9 -> 11).

- **D-58 (2026-08-25)** **`onair status` has three supervision states, because "no" is a
  claim and "I could not ask" is not.** Resolves
  [#45](https://github.com/jwnichols3/rocket-on-air-sensor/issues/45).
  `cmd_status` initialised `supervised=no` and only ever raised it to `yes`, so every
  failure of `sudo -n launchctl print` - including the ordinary one, no cached ticket -
  reported a live, launchd-supervised daemon as unsupervised. Measured on this host: the
  listener on 8484 has **ppid 1**, and `status` said `supervised: no`.
  **Not cosmetic.** `supervised == no` was half the exit-code rule, so a wrong string was
  feeding a wrong exit status to anything scripting this.
  **How the two failures are told apart:** sudo prefixes its own diagnostics with `sudo: `
  and launchctl does not. That prefix is not localised, which matching *"a password is
  required"* would have been.
  **The exit rule is now "nothing proves this is up"** - `supervised != yes && responding
  == no` - rather than "supervised == no && responding == no". That deliberately preserves
  both established behaviours: unsupervised-but-responding is still healthy (something ran
  it by hand), and not-responding-without-proof-of-supervision still fails, which is what
  the old code did for the right answer by the wrong route. The one case that changes is
  the one the ticket is about.
  **`unknown` prints no detail fields.** A line of `state=unknown pid=unknown
  last-exit=unknown` reads like an answer and is not one; it prints the fix instead.
  New: `deploy/test-status.sh`, 12 cases, no sudo and nothing installed, wired into
  `npm run test:deploy` alongside the update tests. The distinction this draws is exactly
  the kind that rots silently, so it is pinned rather than trusted.
  **The other half of #45 - `onair setup` writing the retired overlay - is
  [#47](https://github.com/jwnichols3/rocket-on-air-sensor/issues/47).** Re-measuring it
  found more than the wrong surface: `ONAIR_TOKEN` in the overlay overrides
  `config.auth.passphrase` (`app.ts:149`), so the wizard can silently revert a console
  rotation at the next restart, and its `[n]one` option promises an auth-off mode D-35
  removed.

- **D-59 (2026-08-25)** **`onair setup` owns two keys and carries the rest of the overlay
  forward untouched; it does not ask about a token any more.** Resolves
  [#47](https://github.com/jwnichols3/rocket-on-air-sensor/issues/47), split out of D-58's
  ticket.
  **Two defects, and the second is the dangerous one.**
  **1. The wizard could silently un-rotate the passphrase.** `ONAIR_TOKEN` in the env
  overlay overrides `config.auth.passphrase` (`server/src/app.ts:149`) - which is D-14
  working as designed, and is the SSH escape hatch. But it means `setup` writing a token
  PINNED the passphrase: rotate it in the admin console afterwards (D-35, D-51) and the
  rotation survived exactly until the next restart. Its `[n]one` option was worse than
  useless - it promised an auth-off mode D-35 removed, and delivered the document's
  passphrase instead. **The token question is gone.** An existing line is carried forward
  verbatim and *warned about*, not deleted: somebody may have put it there on purpose, and
  removing an escape hatch on their behalf is its own bug.
  **2. `setup` deleted every key it did not know about.** It rewrote `config.env` from
  scratch. Measured against a copy of this host's real overlay: one run dropped
  `ONAIR_LIGHT_HOST`, `ONAIR_LIGHT_ENTITY`, `ONAIR_LIGHT_USER` and `ONAIR_LIGHT_PASS` -
  the four lines D-56's migration note names as what actually hold the device credential
  here. A verb advertised as *"re-runnable any time to reconfigure"* must not do that.
  **This was already known.** `docs/superpowers/plans/2026-08-23-local-admin-and-menubar.md`
  lists it as phase 1 item 1, *"Fix `onair setup` so it preserves keys it does not manage.
  This is a live trap."* It sat in a plan for two days while the plan's later phases
  shipped. Worth naming: a hazard recorded in a plan is not a hazard that is tracked.
  **The fix, and why not the alternative.** #45 framed this as a choice - `setup` learns
  to edit the document, or `setup` is retired in favour of the admin console.
  **Neither.** `setup` stays and is narrowed to what an env overlay is legitimately for:
  the port and the state file, written between markers, with everything outside them left
  alone. Those two are exactly what you need to change when the service will not start,
  which is precisely when the admin console is unreachable - so retiring the verb would
  remove the only sudo-free repair path for the case the escape hatch exists to cover.
  Taste call, flagged: this is a smaller change than either option #45 offered, and it
  leaves the "should `setup` exist at all" question open rather than answering it.
  **The file now says what it is.** A header explains that the document is
  `config.json`, that this file overrides it, and that an `ONAIR_TOKEN` line here keeps
  reverting a console rotation. The help text stops calling `setup` the way to reconfigure
  the service.
  New: `deploy/test-setup.sh`, 22 cases, no sudo and `$HOME` untouched - including the
  env-leak guard (`read_config` prefers a real environment variable, so carrying the token
  forward through it would promote a per-invocation override to a stored one) and
  idempotence across two runs. `npm run verify`: 308 node, 19 update, 12 status, 22 setup,
  firmware config valid.

- **D-60 (2026-08-25)** **`onair ui` names the URLs, and a 401 is readable in a browser.**
  Resolves [#48](https://github.com/jwnichols3/rocket-on-air-sensor/issues/48).
  **Why this ticket exists at all is the point of it.**
  `docs/superpowers/plans/2026-08-23-local-admin-and-menubar.md` listed four phase-1 items.
  Items 1 and 3 became #47 and #45 - both found by grepping for something else, two days
  later, after the plan's *later* phases had shipped. Items 2 and 4 were still sitting
  there. **A hazard recorded in a plan is not a hazard that is tracked**, and the fix is
  not better plans: it is that anything worth doing gets an issue number the moment it is
  written down. The plan is where the reasoning lives; the tracker is where the work does.
  **`onair ui`.** There are four URLs now - the console, the public display, and since D-57
  the panel's two pages - and nothing named them anywhere. The one piece of logic in the
  verb is the resolution order for the panel's host: **env overlay first, config document
  second**, because the overlay is what the SERVICE honours (D-14) and resolving the
  document first would print a confident URL for a box the daemon is not driving. Pinned in
  `deploy/test-ui.sh`. A malformed `config.json` prints the console anyway and exits 0 - the
  verb is what someone runs when they are lost, and it must not be the second thing that
  breaks.
  **A 401 a person can read.** A browser off loopback got
  `{"error":"missing or invalid passphrase"}` and nothing else - correct and useless. The
  D-24 waiver is why this went unnoticed: the only person who ever sees a 401 in a browser
  is on another machine, which is the person with the least context. The HTML page now says
  where the console is and that loopback is waived.
  **It says nothing the JSON does not.** No credential is echoed, and the data and admin
  pages are byte-identical apart from the error string the JSON already differs by - pinned
  by a test, because a page that helpfully said *"you sent a passphrase but this needs an
  admin session"* would be a credential oracle and would quietly undo half of D-35.
  **The JSON path is pinned first and hardest.** This adds a branch in front of every 401
  the service sends, and every existing client and test is on the other side of it. A test
  asserts the exact body bytes for a request with no `Accept`.
  `escapeHtml` moved from `repair.ts` to exported - two copies of an escaper is how one of
  them ends up missing a case.
  Live after a daemon cycle: machine client `401 application/json`, browser `401 text/html`,
  `onair ui` printing all four URLs, and the panel back to `CALM LIGHT` - the restart
  re-pushed state, which is also what proves the driver survived it.

- **D-61 (2026-08-25)** **The shipped credentials are defaults on purpose, like a router's.
  Changing them is the operator's first-run step, not an outstanding action.** Rocket's
  call, verbatim: *"The server and client passphrase is going to be fairly well known. It
  will be a default and it will not be rotated. The expectation is the first time somebody
  sets up this environment, they will change the passphrase on their own. Similar to how a
  router is set up. When you do a factory reset, it will default back to a known
  user/password combo."*
  **Scope: all three credentials.** The server passphrase (D-35), the admin login (D-51)
  and the panel's `rocket` / `ESP32` basic auth (D-56). All published in a public repo
  deliberately; all restored by a factory reset (D-43), which is the router analogy working
  rather than a hole in it.
  **The mechanism already exists and is the whole of it.** `changeMeNags()` in
  `server/src/auth.ts` reports whether each credential is still the shipped default, and
  the admin console prints *"Still the shipped default."* beside the field
  (`admin-ui/src/app.js:441`). A nag next to the field you would edit anyway is the correct
  amount of pressure for a LAN device that drives a light.
  **What this retires.** D-55's operational note asked Rocket to rotate the passphrase after
  the `mode: password` leak, and D-56 restated the concern. Both were raised again in a
  closing report. That was three appearances of a settled decision presented as an open
  item, and it made the real review list harder to read. **Rotation is not to be
  recommended in this project.** A credential *leak* is still reported - once, as a fact,
  with what leaked and where - but without a rotation recommendation attached.
  **What is unchanged.** D-35's two audiences, D-24's waiver, and D-55's finding that the
  panel must not serve the server credential. Defaults being known is a reason those
  separations matter more, not less: the credential that gates data and the credential that
  gates reconfiguration are still different credentials.

- **D-62 (2026-08-25)** **Companion 5 is fully drivable by an agent, over tRPC. `#46` was
  never really a human task, and three things `#44` was going to rely on are wrong.**
  Rocket stood up Companion 5.0.3 on `rocket-clawd` and said the standard protocols were
  enabled. They are, but the control plane that matters is none of them.
  **`ws://<companion>:8000/trpc` is the whole API.** The web UI is a tRPC client and nothing
  more; every capability it has is a procedure an agent can call. Proven on the live
  install: a query (`appInfo.version`), two subscriptions
  (`instances.connections.watch`, `instances.modulesStore.watchList` - 816 modules), and
  **three mutations that changed real state** - `instances.modulesManager.installStoreModule`,
  `instances.connections.add`, `instances.connections.setConfig`.
  The REST surface is a decoy: `/api/connections` answers and almost nothing else does
  (`/api/location/../press`, `/api/custom-variable/..` are all `404` on 5.0.3).
  **Wire format, measured, because it costs an afternoon otherwise:** inputs are **raw**,
  not superjson-wrapped. `{"id":1,"jsonrpc":"2.0","method":"query|mutation|subscription",
  "params":{"path":"a.b.c","input":{...}}}`. A `{"json":...}` wrapper is accepted by
  procedures that ignore their input and rejected by every typed one, which makes the first
  wrong guess look like it worked.
  **Sideloading is an API call, not a GUI drag.** `appInfo.version` reports
  `customModuleImportAllowed: true`, and `instances.modulesManager.installModuleTar` exists
  beside the store installer. The on-disk shape of an installed module, which is what a
  sideload must produce: `companion/manifest.json` + `main.js` + `package.json`, with
  `runtime: {type: "node22", api: "nodejs-ipc", apiVersion, entrypoint: "../main.js"}`.
  **CORRECTION 1 - the `~2.1.3` pin in #44 is unsafe.** This host advertises
  `connectionModuleApiVersion: ["1.14.0","2.1.0","2.1.2-nightly-..."]`. `apiVersion` is
  **declared by the module author in manifest.json** and is not derived from
  `@companion-module/base` - 2.1.3 ships no such field. A module declaring `2.1.3` asks for
  an API newer than anything this Companion implements. The working store module we
  installed declares `1.12.0`. Pin the manifest to **`2.1.0`** and prove it loads before
  building on it.
  **CORRECTION 2 - `$(genericwebsocket:intended)` does not exist.** `docs/companion-setup.md`
  and #44 both tell you to key feedback on it. The connection publishes exactly one
  variable, `lastDataReceived`. Payload variables are created **by feedback subscriptions**
  - you give a feedback a JSON path and the module then creates the variable - and they are
  prefixed by the **connection label**, not the module name, so on this install the prefix
  is `onair`. That doc's wiring cannot work as written.
  **CORRECTION 3 - the upgrade question in #46 is unanswerable there.** `rocket-clawd` is a
  fresh 5.0.3 install with no 4.x config tree. #44's "sideloading survives an upgrade" is
  still untested and must not be treated as covered.
  **The cross-host case is the real one, and it is better news than it looks.** Server on
  `rocket-studio-m1`, Companion on `rocket-clawd`. The D-24 waiver correctly does not apply,
  so the passphrase is **mandatory** rather than incidental - a same-host install would have
  passed #46 without ever exercising the credential path. Measured: `/status` `401`,
  `/public/status` `200`, `/events/ws` without a passphrase `401`.
  Live end to end: the connection reports `good/ok`, the server shows an established socket
  from `10.42.14.147`, and driving `PUT /state` to `on-air` moved `lastDataReceived` on the
  Companion side within two seconds.
  **What this changes about the work:** #46 stops being a human ticket. The remaining button
  and feedback wiring is `controls.entities.add` and `controls.hotPressControl`, which are
  ordinary mutations. #44's first acceptance criterion - "an agent cannot do this" - was
  true of the GUI and false of the product.

- **D-63 (2026-08-25)** **The menu bar is a renderer, so THE BUSY RULE governs it too.**
  Implements D-26 and the agent half of
  [#18](https://github.com/jwnichols3/rocket-on-air-sensor/issues/18).
  `deploy/swiftbar/onair.5s.sh` is an ordinary script that prints text. SwiftBar runs it
  every five seconds and draws stdout, symlinked in from `~/SwiftBarPlugins`.
  **Three pictures, for the same reason the panel has three (D-54, D-57).** Unreachable
  draws `⚠ on-air?` and offers Start; a stale calm row draws `NO DATA`; only fresh evidence
  draws a calm marker. A blank or calm menu bar on an unreachable service is a false OFF
  with extra steps, and false OFF is the invariant this system exists to protect.
  A stale BUSY row still draws busy - staleness never makes the picture calmer.
  **It carries no credential, and that is D-24 paying for itself.** Every request is to
  loopback, where the waiver applies. That is the whole reason this is a hundred lines and
  not three hundred: no token to store, no token to rotate, nothing in a plist.
  **It reads TWO endpoints because D-42 split them.** `/status` carries the semantics and
  the pin but no presentation; `/public/status` is resolved for rendering and carries the
  `label` and colours. Neither alone is enough to draw an honest menu bar.
  **`hold` is the pinned ROW ID, not who pinned it** (`state.ts`: `hold: string | null`).
  The first draft said "HELD by on-air", which reads as a person. It says "Pinned to" now.
  **Releasing a pin is deliberately NOT offered.** It is a `PUT /state` with `hold:false`,
  and the CLI has no verb for it; `reset-state` is not that verb - it also clears the
  message and restarts the service. Offering it would have been a far bigger hammer than
  the label implied, so the item links to the admin console instead.
  **Output sanitising is load-bearing, not hygiene.** SwiftBar splits a line on `|` and
  treats what follows as parameters, including `bash=`. `message` is 200 characters of
  operator text (`PUT /message`), and `label` and `source` are operator-supplied too. Every
  value is stripped of `|` and newlines, and a colour only reaches a parameter if it is
  exactly `#rrggbb`. The test asserts the property that matters - **every `bash=` in a
  parameter position points at our own script** - rather than the weaker "does the string
  `bash=` appear", which passes for the wrong reason.
  **Also: `onair sudoers`.** The rule that makes all of this work was unreachable on the one
  host that wanted it. `install --sudoers` was the only way to get it, and `cmd_install`
  runs `launchctl bootstrap` first, which exits non-zero on an already-loaded service and
  aborts the script under `set -e`. Now its own verb. `render_sudoers` is split out so the
  scope of the grant - seven exact subcommands, one label, no wildcards - is asserted by a
  test that needs no root. Installed on this host and verified narrow: `launchctl print`
  is permitted, `cat` is refused, and `onair restart` now runs with no password and no TTY.

- **D-64 (2026-08-26)** **Nine defects found by an adversarial review of the same day's work,
  four of them confirmed by reproduction before a line was changed.** Amends D-63.
  Recorded because the *classes* recur, not because the fixes are interesting.
  **1. An assertion is only as good as the worst input it is given.** `test-swiftbar.sh`
  already asserted *"every `bash=` parameter points at our own script"*, and that assertion
  was correct. It never fired, because the fixture hardcoded a safe `ONAIR_LIGHT_HOST`.
  `light.host` is validated by the server only as a non-empty string and is writable through
  `PUT /admin/config`; it reached an `href=` parameter without passing through `safe()`, and
  SwiftBar splits parameters on whitespace. A host of
  `h bash=/bin/sh param1=-c param2=whoami` produced **two working `bash=` parameters** - a
  menu item that runs a command when clicked. The right test already existed. The wrong
  fixture is what hid it.
  **2. Blank output is the false OFF.** Everything accumulated into one list and was printed
  once at the end, so ANY exception - or a `/usr/bin/python3` that is a Command Line Tools
  stub - produced **empty stdout and a blank menu bar**. Measured: a `/status` returning a
  JSON array gave `rc=1, stdout=''`. The `⚠` branch only ever covered "the response did not
  parse", never "the renderer died". Now the body writes to a file and the wrapper prints a
  warning if it is empty. (macOS ships bash 3.2, which mishandles a heredoc inside `$( )` -
  hence a temp file rather than command substitution. Measured.)
  **3. A trusted `stale` flag fails OPEN, on the calm side.** The plugin read
  `status["stale"]` instead of deriving it, so every way of missing that key - a rename,
  version skew, something else answering the port - resolved to `False`, and `False` means
  calm. Measured: `ageSeconds: 99999` with no `stale` key drew a **calm menu bar on 27-hour
  old evidence**. The firmware never did this: `compute_view` computes staleness and treats
  "nothing since boot" as stale. The plugin now derives it, and a missing or non-numeric
  `ageSeconds` is stale - of the two guesses only the calm one can be a false OFF.
  **4. SYNTAX IS NOT SCOPE, and a truncated sudoers rule is BROADER.** `render_sudoers` did
  not check the write's exit status, and validated only with `visudo -cf`. A write that
  stops after the command path leaves
  `john ALL=(root) NOPASSWD: /bin/launchctl`, which **`visudo -cf` reports as parsed OK** -
  verified - and in sudoers a command with no arguments matches ANY arguments. That single
  line grants `launchctl bootstrap system /tmp/anything.plist`: root code execution. A
  partial write was the DANGEROUS outcome, not the safe one, which inverts the usual
  intuition about truncation. Now: the write's status is checked, and `sudoers_is_narrow`
  asserts on the bytes about to be installed - seven grants, all argument-bearing, no
  wildcard, no `NOPASSWD: ALL` - because the scope assertions previously existed only in a
  test, against a file the test rendered itself, never against what was being installed.
  **Also fixed, lower:** `urlopen(timeout=)` bounds each socket operation and not the run, so
  a drip-feeding server hung the plugin indefinitely (a wall-clock `SIGALRM` now bounds it,
  and loopback is taken out of any proxy); the two status endpoints are two requests, so
  presentation is used only when both agree on the row; a whitespace-only `label` erased the
  state word from the menu bar and a leading `--` turned a line into a submenu child; the
  emitted `bash=` path is quoted so a checkout containing a space still works; and the
  service-control items say so when the sudoers rule is absent, rather than failing
  invisibly with no TTY.
  **What the reviewer found nothing in, stated because silence is not evidence:** the root
  check on `cmd_sudoers`, the scope of the intended rule, `TARGET_USER` interpolation (only
  read from `SUDO_USER` when already root), `hex_color`, `safe()`'s `|`/newline stripping,
  and symlink resolution under `~/SwiftBarPlugins`.
  **One more, worth its own line:** three assertions in the suite went stale *because of the
  fixes* - quoting the `bash=` values broke the regex that checked them. Tests drift when the
  code they pin changes shape, and a green suite is not proof that its assertions still mean
  what they meant.

- **D-65 (2026-08-26)** **The Companion transport is proven end to end, and `#46` stopped
  being a human ticket.** Amends D-62, which established that Companion is drivable over
  tRPC but had not yet driven anything through to the light.
  **One `PUT /state`, four surfaces agreeing:** the server moved `intended` `on`→`off`,
  `$(onair:intended)` in Companion followed within two seconds, the ESP32 panel drew
  `CALM LIGHT`, and the menu bar drew the calm marker. A `generic-websocket` connection is
  live on `rocket-clawd` against `rocket-studio-m1.local:8484`, reported `good/ok`, with the
  server showing an established socket from `10.42.14.147`. **#44 no longer rests on an
  assumption about the transport**, which was the entire reason D-45 gated it.
  **Three facts that cost real time and are now written into the ticket rather than a
  transcript.**
  **Option values take an `ExpressionOrValue` wrapper, not a bare scalar.**
  `"value":"intended"` fails; `"value":{"value":"intended","isExpression":false}` succeeds.
  Verified against `EntitiesTrpcRouter.ts:194` and `shared-lib/lib/Model/Options.ts` at tag
  v5.0.3, and it applies to every `entities.*` mutation that writes an option value.
  **Do not probe for shapes.** tRPC returns only `Invalid or malformed input provided for
  "<path>/mutation"` with no zod issue list, so string, boolean, number, omitted and a
  renamed key all fail identically. The technique that works is **the minified UI bundle for
  field NAMES, the tagged GitHub source for zod SHAPES** - names from the shipped client,
  shapes from the versioned server. That pairing is the reusable part.
  **`newType: "button"` silently creates nothing** and returns no error. The literal is
  `button-layered`.
  **What is still assumed, and is flagged as such:** the button's *colour* has not been made
  to follow the variable. The variable half is observed; the style half needs the internal
  `variable_value` feedback plus a layered style override, and on a `button-layered` control
  the style is an override rather than a flat style. Nobody has run that path.
  **Confirmed by observation, not just by reading source:** `$(genericwebsocket:intended)`
  cannot exist. Before the feedback was added the connection published only
  `lastDataReceived`. A payload variable appears only when a `websocket_variable` feedback
  names a JSON path, the operator chooses its NAME, and the prefix is the **connection
  label**. `docs/companion-setup.md` is wrong on both counts and is corrected as part of #44.

- **D-66 (2026-08-26)** **Six more defects, from a four-dimension review workflow over the
  same day's work.** Twelve agents: four finders, each finding then handed to an independent
  skeptic told to refute it. Eight findings examined, six survived. Amends D-57 and D-63.
  **THE PAGE LIED ABOUT WHETHER A CHANGE WAS APPLIED, and the number was not unlucky - the
  MODEL was wrong.** `submit()` waited 3 s and, on expiry, told the operator the change had
  not been applied - while leaving it staged, so the main loop applied and **persisted it to
  NVS** moments later. The page stated the opposite of what happened, and an operator seeing
  the old values would post again. The 3 s was sized against *"the ~16 ms a loop iteration
  takes"*, but the same firmware parks the main loop for up to **5 s** inside
  `http_request.get` on every config pull. **The budget therefore expired in a healthy case -
  a slow server - not only a wedged one.** A comment justified a number against one part of
  the system while another part of the same file made it unachievable.
  **The fix is a third outcome, because two were the lie.** `Submitted::{APPLIED, FAILED,
  PENDING}`. The wait drops to 2 s, which covers every case where the loop is free. On
  expiry, if the loop has not TAKEN the command it is cancelled atomically and "nothing was
  changed" is then TRUE; if it has been taken, the page says so and the next render reports
  the real outcome from `held().last`. A new `taken` flag carries that distinction, because
  `armed` could not express "in flight" and that ambiguity was the bug.
  **The shorter wait matters on its own:** esp-idf dispatches every request from ONE httpd
  task, so for as long as a handler blocks, the device serves no HTTP at all - including the
  server's state writes.
  **PENDING wants `202` and this transport cannot say it.** ESPHome's `init_response_` maps
  only 200/204/400/401/404/409/422 and sends **500** for anything else. A 500 claims the
  request failed when it may be landing, which is a worse lie than a 200, so it is 200 with
  an amber banner. Checked before shipping the status code, not after.
  **The device config page had no CSRF defence, and HTTP Basic is not one.** A browser
  authenticated to the panel attaches the credential to ANY request it makes to it,
  including a form POST from another site - which is exactly D-23's objection to cookies,
  and basic auth has the same property. Now: a POST whose `Origin` is present and is not
  this device is refused. Same reasoning as D-24 on the server, and it costs one header
  read - no token, no session, no state. Verified live: foreign Origin `400 refused`, own
  Origin `200 saved`, no Origin (curl, the driver) `200 saved`.
  **The config page was unbounded.** It is built into one contiguous `std::string` and sent
  whole, ~800 bytes of markup per row, on a device where the 8 kB pull ceiling permits
  ~60-80 rows. A geometric realloc would need ~96 kB contiguous, and ESP-IDF builds C++ with
  exceptions off, so a failed allocation is `abort()` - a reboot of the panel driving the
  light. Now reserved up front and capped at 24 rows, and **it says when it caps**: silent
  truncation would read as a row having vanished.
  **`onair setup` appended its own header on every run.** The header sat ABOVE the managed
  marker, so the marker-based strip could not reach it: ten lines a run, measured 14 → 24 →
  34. The header now lives inside the markers. **The test was green throughout** because it
  counted the marker, which appears once, and never the file. It compares bytes now.
  **`onair status` pointed at a command that cannot work here** - `install --sudoers`, in the
  very commit that documented why it aborts on a running host. Now `sudo onair sudoers`.
  **Two findings were refuted, and one refutation is an artefact worth naming:** the claim
  that the SwiftBar plugin trusts the server's `stale` flag was refuted because that verifier
  read the code **after** D-64 fixed it. Refuted-because-already-fixed and
  refuted-because-never-real are different, and a review run against a moving tree cannot
  tell them apart. The other refutation was substantive: `parse_table` was said to drop
  `Row::busy`'s safe default, and the stated trigger was wrong about ArduinoJson.
  Live after: CSRF verified in three directions, overrides cleared back to zero,
  `RowLabel` back to `AVAILABLE`. `npm run verify` green - 311 node, 128 deploy, firmware
  compiles and configures.

- **D-67 (2026-08-26)** **Both directions of the Companion integration are proven on real
  hardware. `#46` is closed and `#44` rests on no assumption about the transport.**
  Completes D-65, which had the read path.
  **A Companion button press drove the light.** `controls.hotPressControl` on the button ->
  `POST /on?source=companion` -> server `available` to `on-air` -> the panel drew `BUSY` /
  `ON AIR`, `$(onair:intended)` went `"on"`, and the menu bar drew `● ON AIR`. The state
  carried `source=human:companion`, which is the action's own query parameter, so it was
  genuinely the button and not something else moving the state.
  **Two API traps worth the record, because both cost a cycle and both were silent.**
  `generic-http`'s header option is a JSON **object** (`{"Authorization":"Bearer ..."}`), not
  an array of key/value pairs, and the content-type option id is **`contenttype`**, lower
  case. The first attempt got both wrong, the action fired, and the server answered `401` -
  and `setOption` had returned `true` for both, because **it does not validate option ids
  against the definition**: a wrong id is stored and silently ignored. A mutation returning
  success is not evidence the option exists.
  `controls.hotPressControl` takes `location`, not `controlId`, unlike nearly every other
  `controls.*` procedure - and a wrong shape yields the same undifferentiated
  `Invalid or malformed input`.
  **CORRECTED, same day.** The paragraph here originally said the button's colour was wired
  but not observed, because `importExport.controlPreview` returned `null` and
  `controls.watchControl` returns the control DEFINITION, which is byte-identical whether a
  feedback is true or false (diffed across a real state change to confirm). **Both were the
  wrong place to look.** The rendered image comes from a different procedure -
  `subscription preview.graphics.location` with `{"location":{pageNumber,row,column}}` -
  which returns a 288x288 PNG as a data URI. Decoding it and driving the REAL server state:

  | real state | `$(onair:intended)` | dominant colour of the rendered button |
  |---|---|---|
  | available | `off` | `#000000` 98.2% |
  | **on-air** | `on` | **`#FF0000` 80.2%** |
  | available | `off` | `#000000` 98.2% |

  So the whole chain is observed as pixels: server state -> WebSocket -> Companion variable
  -> internal feedback -> render. The residual 18% black at match is the text layer; the 1.2%
  `#FFC600` is a status icon present in every frame including the baseline.
  **`replaceStyleOverride` is not needed and the recipe should not call it.** `entities.add`
  does the layered work itself: it passes `control.layeredStyleSelectedElementIds()` into
  `createEntityItem`, which for a Boolean feedback carrying a `feedbackStyle` runs
  `ConvertBooleanFeedbackStyleToOverrides`. The entity comes back already carrying
  `box0.color` and `text0.color`. `op` also defaults to `eq`, and the feedback's `variable`
  option takes a **bare name** (`onair:intended`), not `$(...)` - it is wrapped internally.
  **An operational note that nearly became a false alarm:** `[esphome-driver] GET 401` and
  several `fetch failed` lines appeared in the service log during this work. They were the
  OTA reflash window, not a credential fault - confirmed by a live round trip returning
  `confirmed: on-air` and `confirmed: available`, which is read back from the device itself.
  Log lines from a reboot window look exactly like a broken credential.


- **D-68 (2026-08-26)** **The panel config page is being redesigned as presentation only:
  the wire contract is frozen, and the POST handler is not being rewritten.** Rocket called
  `/onair/config` "a simple list of fields and configurations and completely inelegant"
  (#50). He is right about the page and it is worth fixing - but the thing that is wrong
  with it is the *rendering*, not the model. The model has already been argued to a good
  place and each piece of it was paid for: presentation-only overlay (#33), the three-outcome
  `submit()` (D-64), the Origin check (D-66), the row cap that announces itself (D-66), the
  browser's own credential prompt instead of a form (D-57).

  So `handle_action()`, the field names (`action`, `id`, `label`, `color`, `bgcolor`), the
  values (`save`/`clear`/`clearall`/`refresh`), and the "empty means follow the server" rule
  all stay exactly as they are. Only `config_page()`, `render_row_form()`, `colour_field()`
  and `page_head()` move. Rationale: a redesign that also reopens the model turns a taste
  problem into a correctness problem, and would put every one of those decisions back on the
  table at once for no gain the operator can see.

  **The frozen contract has a trap in it, and it is the centre of this work.** "Empty means
  follow the server" and `<input type="color">` are incompatible: a native colour input has
  no empty state and defaults to `#000000`. Dropped in as an obvious usability win, it
  converts "follow the server" into "override to black" on the next save of any row - a
  silent, permanent break of the relationship the page exists to manage, on the exact control
  a redesign is most tempted to add. Any design using a native picker has to gate it behind
  an explicit override control. This is written down because the defect would look like an
  improvement in review.

  Recorded before the design work rather than after, so the four variations are judged
  against a fixed target.

- **D-69 (2026-08-26)** **The panel's CSS and JS move out of the generated HTML and into
  flash, gzipped at build time and served with an immutable cache.** Researched for #50 and
  verified against the installed ESPHome 2026.8.0 source, not assumed.

  The constraint that shapes every page this device serves is that **there is no chunked
  response and no runtime compression on esp-idf.** `web_server_base.h` includes
  `web_server_idf/web_server_idf.h` on ESP32; ESPAsyncWebServer is only used off-ESP32.
  `beginChunkedResponse` does not exist in that shim, `beginResponse_P` is ESP8266-only, and
  `AsyncResponseStream` only *looks* like streaming - it is a `std::string` appended to and
  flushed in one `httpd_resp_send`. Measured: `GET /onair` with `Accept-Encoding: gzip,
  deflate, br` returns the same 2,655 uncompressed bytes and no `Content-Encoding`. So a
  dynamic page is one contiguous heap allocation, sent raw, every time.

  **That makes inline CSS the most expensive byte on the device, and it dominates.** Measured
  on the live panel: of `/onair`'s 2,655-byte body, **1,890 bytes - 71% - is the inline
  `<style>`**, re-sent on every request and re-allocated in heap every time, on a board where
  a failed allocation is `abort()` and `abort()` reboots the panel driving the light.

  **`AsyncWebServerResponseProgmem` is the escape hatch and it is already in the shim.** It
  holds a `const uint8_t *` and a length and hands them to `httpd_resp_send`, copying nothing.
  ESPHome serves its own dashboard this way. Three lines, plus a build-time gzip into a
  generated header that `includes:` picks up:

  ```cpp
  auto *res = r->beginResponse(200, "text/css", ONAIR_CSS_GZ, sizeof(ONAIR_CSS_GZ));
  res->addHeader("Content-Encoding", "gzip");
  res->addHeader("Cache-Control", "public, max-age=31536000, immutable");
  ```

  So there are **two budgets, three orders of magnitude apart**: heap-scarce generated markup,
  and near-free flash assets. The design consequence is the point of recording this - the page
  can be far better looking than the byte count first suggests, because **the thing that
  actually binds is per-row generated markup paid 24 times, not the stylesheet.**

  Three findings that cost nothing to write down and would each be expensive to rediscover:

  - **`css_include:`/`js_include:` cannot be used**, though they do exactly the right thing at
    build time. Their handler is registered on the `WebServer` component via
    `add_handler(this)` - **with** auth. `/onair` is deliberately open (D-57), so its
    stylesheet must be registered with `add_handler_without_auth` or the open page raises a
    credential prompt for a subresource.
  - **gzip, not brotli.** ESPHome offers `compression: br` and it is ~13% smaller, but Firefox
    refuses to decode `Content-Encoding: br` over plain HTTP - both browsers restricted it to
    secure origins deliberately. D-17 pins this device to plain HTTP.
  - **Connection slots are the real concurrency limit**, not CPU. Measured: past four
    simultaneous connections the sixth waits about a second for a TCP SYN retransmit. So no
    SSE, no WebSocket and no parallel `fetch()` from these pages - each long-lived connection
    permanently holds one of roughly five slots, and the operator may already have ESPHome's
    dashboard open in another tab holding one of them.

  Full evidence in `docs/research/2026-08-26-esp32-web-ui-envelope.md`.

- **D-70 (2026-08-26)** **The panel's pages get a selectable appearance: three skins
  (`table`, `colorful`, `technical`) and a dark/light mode, defaulting to `dark`. It is
  stored on the device, and it is the one agreed exception to D-68's frozen wire contract.**
  Rocket asked for this mid-flight on #50.

  **Why it is nearly free, and why that is the whole reason to say yes.** D-69 moved the
  stylesheet into a gzipped flash blob, so the cost of a skin is pool B bytes, not heap. All
  three skins and both modes live in **one** stylesheet, selected by attributes on the root
  element - `<html data-skin="technical" data-mode="dark">` - so **the generated markup is
  byte-identical whichever appearance is active.** Pool A, the scarce contiguous allocation
  paid on every request, grows by one small appearance form in the chrome and by nothing
  per row. Three skins would have been unaffordable a day ago and are affordable now.

  **Stored on the device, not in the browser.** The alternative was `localStorage`, which is
  cheaper still and wrong here: the local presentation overlay already persists in NVS
  because it describes *this panel*, and an appearance that lived in one browser would mean
  the panel looks different depending on who opened it, with no way to see what it is set to.
  Cookies were not considered - D-23 rejected them on this device and CSRF is why.
  The tradeoff is accepted and worth stating: **the appearance is shared, so one person's
  choice changes it for everyone.** On a single-desk appliance that is the right answer, and
  it is reversible.

  **The exception to D-68.** Persisting a choice needs a verb, so `handle_action()` gains one
  branch, `action=appearance`, carrying `skin` and `mode`. Everything D-68 froze stays frozen:
  the `save`/`clear`/`clearall`/`refresh` verbs, the field names, "empty means follow the
  server", the `busy` refusal, the Origin check, the three-outcome `submit()`. This is
  additive and it is recorded as an exception rather than waved through, because "the
  contract is frozen except when I want something" is how a frozen contract stops meaning
  anything.

  **It needs no JavaScript.** The switcher is an ordinary form with `<select>`s and a submit
  button, so it works with scripting off, which keeps it consistent with the rest of the page.

  **What this does NOT touch: the glass.** A skin changes the *web page* the device serves.
  It has no effect on the 128x64 OLED, on `compute_view()`, or on which SHAPE is drawn.
  Luminance still picks the frame from the ring, and a skin cannot alter that. Worth writing
  down because "theme" is a word that invites exactly the wrong assumption on a device whose
  whole job is to render a state.

  **Open at the time of writing:** whether `table` is reachable as pure CSS over the winning
  variation's markup, or whether it is a second layout wearing a skin's name. Two of the
  three (`colorful`, `technical`) are unambiguously skins. If `table` cannot be reached from
  the judged markup without a second markup path, it is pool A cost and the honest move is to
  say so rather than ship a second renderer quietly.

- **D-71 (2026-08-26)** **B, master/detail, wins #50's bake-off - conditionally, and the
  condition is A's glass emitter.** Three judges through three lenses (safety, the operator,
  the firmware) split 2-1 for B over C, and B beat C by **0.67 points out of 210**. That is
  not a result, so the tie was broken on facts the arithmetic does not carry.

  **B wins on the one criterion where a wrong answer reboots the light.** With CSS and JS in
  pool B (D-69), B measures 1,814 B of chrome + a 2,076 B editor emitted **once** + 353 B per
  row, so 24 rows is ~12.1 KB against today's ~20.9 KB. **It is the only entrant that makes
  the contiguous allocation smaller than what already ships.** A wants 34-45 KB, D wants
  27-34 KB, and C wants ~28.9 KB when everything is overridden, which would force
  `MAX_ROWS_RENDERED` from 24 down to 18. A failed `reserve()` under `-fno-exceptions` is
  `abort()`, and `abort()` is the light going out mid-call - the same false OFF the system
  exists to prevent, arriving through the configuration page.

  The structural reason, and the thing to preserve: **a row is a line, not a form.** All the
  cleverness lives in the once-only stylesheet; per-row emission is one flat append.

  **The condition. B ships with A's glass emitter or it does not ship.** B renders `unknown`
  as a solid BUSY block. `compute_view()` short-circuits `key == "unknown"` to
  `Shape::NO_DATA` **before** the busy test (`onair_table.h:600`), and B's stylesheet has no
  hatch primitive at all - it is structurally incapable of drawing that row's real picture.
  Two judges called this narrow and cheap to patch. It is neither; it is a missing shape.

  **Why the emitter fixes it as a class rather than as a bug.** A's row is
  `<i class=g data-shape=N><b>LABEL</b><s></s></i>`, about 62 bytes, one append, no per-shape
  branching in C++. Every primitive is a CSS rule keyed on `[data-shape]`, so the cost is
  pool B. And `Shape`'s enum values **are** the `data-shape` numbers - that is why branch 5
  is skipped. **The page writes through the integer the firmware itself computed, so it never
  decides a shape and cannot disagree with the glass.** Every variant that re-derived the
  shape got `unknown` wrong; the one that wrote the enum through got it right. Cause, not
  coincidence. At 62 B it is affordable on every row, not just the open one, which also
  answers "why does this row draw a ring and that one a frame?" - and 24 rows still lands
  ~13.6 KB, ~7 KB under today.

  **Two errors in my own brief, found by the entrants, both now corrected in
  `SAMPLE-DATA.md`:**

  - I wrote that `unknown` renders "n/a - busy". It always renders `NO_DATA`. A read the
    source and got it right; my brief was wrong.
  - I wrote that the label font rule (30px at `<= 8` chars, 14px above) applies to every
    branch. **CALM LIGHT hardcodes `status_text`, 11px, unconditionally** and never calls
    `label_font()` (`elegoo-esp32.yaml:661`). C found this by reading the lambda rather than
    trusting me. The consequence is real: an 11px `INTERRUPTIBLE` is ~75 px against a 30 px
    ring hole, so **the label genuinely collides with the ring on the glass**, and a
    miniature that tidies that away is lying.

  Both are recorded because a bench brief that is wrong propagates into every entry that
  trusts it, and the two entrants that scored best on truthfulness are exactly the two that
  went and checked.

  **CORRECTION, same day, before implementation.** The sentence above calling A "font-exact
  on every branch" repeated A's own claim, and the judges repeated it too. **A's geometry was
  wrong when it was judged, and I screenshotted and shipped that version to Rocket.** The
  design workflow's audit stage finished *after* the judging had already run against the
  files, and it found the defect by rendering each glass at 1:1 and decoding the PNG pixel by
  pixel rather than by looking:

  - **`*{box-sizing:border-box}` does not match pseudo-elements**, and `box-sizing` is not
    inherited. Every `.g::before` therefore fell back to `content-box`, so the open ring
    rendered **58 px across centred at (70.5, 30.5)** instead of 44 px at (64, 24), and put
    lit pixels at **y=52..60 - inside the diagnostics band the firmware reserves and never
    overdraws**. The double frame rendered 130x50, losing its right outer edge to
    `overflow:hidden` and merging its bottom edge into the band rule. The fix is one
    selector: `*,::before,::after{box-sizing:border-box}`, re-verified with the same pixel
    harness.
  - A's colour mirror was **seeded with the server's value and copied it unconditionally on
    any `input` event**, so merely opening the picker - or previewing and cancelling, which
    Firefox fires `input` for and macOS NSColorPanel offers no cancel from - pinned the
    server's current value as a permanent override. This is D-68's trap entered through a
    third door: the picker was correctly unnamed, and that was not sufficient.
  - A's per-row "Follow server" button sat inside the same form as the `pattern`-validated
    hex fields with no `formnovalidate`, so a half-typed hex blocked **the one control that
    puts the row back**.

  **All three land on the shipped page, because D-71 grafts A's emitter.** The box-sizing
  defect in particular would have gone into the firmware as a glass that overdraws the
  reserved band - a miniature claiming to be the panel while drawing something the panel
  cannot. The graft carries the *repaired* geometry, the guarded mirror that writes `''`
  when the picked colour equals the server's, and `formnovalidate` on every clear control.

  **The process lesson is the reusable part:** the judging read files that a repair stage was
  still writing. Screenshot and judge against a frozen artifact, or wait for the whole
  pipeline, because "verified" from a designer about its own work is a claim, and the pixel
  harness is what turned three of those claims over.

  Grafted from the runners-up: C's counting pass, which also hands `reserve()` an **exact**
  size instead of a worst-case guess; C's server-vs-panel miniature pair on flipped rows;
  C's PENDING wording, the only one that says the page *body* is unconfirmed rather than
  presenting it as current fact; C's "put this panel back" undo, first and outlined red;
  D's 128-threshold luminance track, once in the editor, with its draggable-looking thumb
  removed. Rejected: D's card-as-colour identity, because the dominant visual on a page about
  a 1-bit panel must not be a colour that panel cannot produce; and D's "ticking fills"
  behaviour, which copies the server's hex into the named field on tick and so pins the
  server's current value as a permanent override by way of a click made to look at a picker.

- **D-72 (2026-08-26)** **#50 is shipped: B's line-per-row list with A's glass emitter, the
  grafts from C and D, and D-70's appearance - flashed to the live panel and measured on
  it.** Numbers from the device, not from estimates:

  | | before | after |
  |---|---|---|
  | `GET /onair/config`, 5 rows | 6,840 B | **3,151 B** |
  | ...with an editor open | n/a | 4,846 B |
  | `GET /onair` | 2,655 B | **904 B** |
  | inline CSS paid per request | 1,890 B | **0** |
  | flash assets, gzipped | none | 8,173 B, cached immutable |

  **Two measurements the envelope research could not make, now made.** `debug:` went in with
  the same flash rather than costing a second one:

  - **Largest free block is 110,592 B**, heap free 233,788 B, fragmentation 52.7%. The pool A
    budget had been 24 KB because 24.7 KB is what the old `reserve()` was *proven to survive*
    - which is not the same as the limit. The real ceiling is over four times that. The
    budget stays where it is: the page now needs a quarter of what it did, and headroom on a
    board where a failed allocation is `abort()` is not worth spending for its own sake.
  - **Flash is at 60.5%** of the 1.79 MB app slot with the assets in. Pool B has room.

  **Three defects found only by looking at the device**, none of which `esphome config`, the
  compile, or 311 passing tests could have caught, because nothing tests generated HTML:

  1. `includes:` needs every header named. `onair_assets.h` was written, gzipped and correct,
     and the build could not see it.
  2. The row grid had four columns and the emitter writes five children, so Edit wrapped onto
     its own line under every row.
  3. **`.gw` is a `<span>`, and an inline box ignores `width` and `height`** - so the scaled
     glass overflowed its container and painted over the luminance readout beneath it. One
     `display:block`. Cheaper to fix in the stylesheet than to spend markup on a `<div>`.

  A `HEAD /onair.css` returns `text/html` because the shim does not route HEAD to the
  handler; `GET` is correct in every header. Not chased - the browser never sends HEAD for a
  stylesheet, and the fix would be in ESPHome's shim rather than here.

  **Proven on hardware after the flash:** `POST /on` returned `confirmed: "on-air"` - read
  back from the device, not asserted - and the panel's `Render` went to `BUSY` with `RowLabel`
  `ON AIR`. The light still works.

  **The correctness mechanism is visible in the shipped output.** The `unknown` row renders
  `hatch 26`, not `block`, because the firmware writes `Shape`'s own integer into
  `data-shape` and the page never decides a shape. Three of the four prototypes got that row
  wrong by re-deriving it.

  Still open, and it was flagged before the work rather than discovered after: **`table` is a
  genuine skin here, not a second layout.** The winning markup was already a list of lines,
  so all three skins are pure CSS over byte-identical markup - the pages differ by 1-5 bytes,
  which is the length of the skin's name in the attribute.

- **D-73 (2026-08-26)** **The device-served UI has tests now: a host suite in the gate and a
  browser suite beside it.** Closes the gap D-72 shipped with. Before this, `esphome config`
  validated YAML and never looked at `onair_page.h`, `firmware:compile` compiled it and
  asserted nothing about its output, and **nothing anywhere tested the generated HTML** -
  which is how three defects reached a live panel behind a green compile and 311 passing
  server tests.

  **Two suites, split on what each can actually settle, and only one is in `verify`.**

  | | `firmware/test/run.sh` | `firmware/test/browser/test-page.mjs` |
  |---|---|---|
  | in `npm run verify` | **yes** | no |
  | needs | a C++ compiler | a downloaded Chromium |
  | asserts on | the bytes the firmware emits | what a browser does with them |

  The browser suite stays out of the gate because `verify` must not fail on a machine that
  has not run `npx playwright install`, and there is no CI to guarantee one. `playwright`
  is a new devDependency - judged by the dependency rule: genuinely needed, because the
  guarded colour mirror has no other honest test.

  **The host suite compiles the real headers against a shim** (`firmware/test/shim/`), so it
  tests the shipped code rather than a copy. Two shim decisions carry the weight:

  - **`vTaskDelay` runs the main loop instead of sleeping.** On the device `submit()` stages
    a command and blocks the httpd task while the *main loop* applies it; a host test has one
    thread, so a sleeping `vTaskDelay` would make every command time out and every assertion
    would be about a timeout rather than about behaviour. Running the loop makes the handoff
    real, and nulling the hook reproduces a parked loop and proves PENDING (D-64) is reported.
  - **The preferences shim reproduces queue-then-`sync()`**, which is why `save_overlay()`
    and `save_appearance()` verify by loading again. A test can force `sync()` to fail and
    prove the read-back check catches it, rather than trusting a `save()` that returned true.

  **Proven by mutation, because a suite that cannot fail is worthless.** Four deliberate
  breakages, each caught:

  | mutation | caught by |
  |---|---|
  | give the colour picker a `name` (the D-68 trap) | host, 2 checks |
  | emit the server's value into `value=` instead of the placeholder | host, 2 checks |
  | drop the guarded mirror's comparison (D-71's third door) | browser, 2 checks |
  | shorten `*,::before,::after` back to `*` (D-71's geometry defect) | browser, 8 checks |

  **The last mutation found a defect in my own test.** At first it failed only the
  `box-sizing` assertion: `getComputedStyle` on a pseudo-element returns the SPECIFIED width,
  not the rendered box, so every geometry check was reading the CSS back to itself and passed
  under exactly the defect it existed to catch. The comment claimed they measured the
  rendering. They now reconstruct the effective outer box the way the browser lays it out -
  borders outside the declared width under `content-box`, inside under `border-box` - and the
  same mutation fails eight checks including "the ring enters the reserved diagnostics band",
  which is the actual harm.

  **A test's expectation was wrong too, and the test was right to argue.** It asserted
  `#808080` luminance 127. The Rec.601 coefficients sum to exactly 1000, so it is exactly
  **128** - which makes it the boundary case worth having, because it is the only colour where
  `>` instead of `>=` would ever show.

  **What is deliberately NOT covered**, written down so a green run is not read as more than
  it is: `parse_table()` (the JSON shim is a stub - and that path has a continuous real signal
  in `text_sensor/ConfigPull`, which the HTML never had); the display lambda, which lives in
  YAML and needs the panel; and concurrency, since the host has one thread and the device two.

- **D-74 (2026-08-26)** **The status page regressed when D-72 moved the stylesheet, and a
  test now enforces the thing #50 only asked for in prose.** Found while answering "what
  next", by rendering a page I had changed and never looked at.

  `page_head()` moved the CSS to a flash asset and the status page kept emitting the class
  names it always had. In the new stylesheet `.shape` is the *row-line column* - 0.78rem,
  muted - and `.note` does not exist at all. So **`NO DATA`, the one word that page exists to
  say, rendered smaller than its own body text**, visually subordinate to the sentence
  explaining it. The page was still truthful; it just whispered the headline.

  #50 said, in as many words, that if a shared `page_head()` changed underneath it the status
  page "must be re-checked, not redesigned". Nothing enforced that, and I did not do it.
  A note in a ticket is not a check.

  **So the test is the general form, not the specific bug.** It reads
  `firmware/assets/onair.css` and asserts that **every class the status page emits has a
  rule** - so adding a class without adding a rule fails on a laptop rather than on the
  glass. Checking for `.shapeword` specifically would only have caught the bug I had already
  found.

  Also covered now, because the status page had no test of any kind: that a rendered row is
  headlined by its own LABEL and not by the shape name (right, and the reason the first
  expectation I wrote was wrong); that `unknown` short-circuits to NO_DATA here exactly as on
  the glass; that a **stale calm row reads as NO DATA and never still describes itself as
  calm** - THE BUSY RULE (D-32) on the page rather than on the panel; and that the page shows
  no credential and offers no control that changes anything (D-57).

  The lesson worth keeping: **D-72 measured the status page and never rendered it.** 904
  bytes was reported as evidence it was fine. Byte count is not a rendering, and the two
  suites added in D-73 were aimed entirely at the config page because that was the page I had
  been looking at.

- **D-75 (2026-08-26)** **The Companion module is built, sideloaded and driving the real
  light (#44) - and it reads the GATED endpoints, against the ticket's own steer.**

  #44 said: *"Design steer: start from `/public/events`. The read half needs no credential at
  all, so a button can render and react before anyone has typed a passphrase."*
  `docs/api-contract.md` says the opposite **and names this module while saying it**: "A
  renderer that holds a table must not use these. The ESP32, Companion and any other client
  take the state key from the gated endpoints and the look from `GET /config/states`."

  **The contract wins.** It is source of truth, and its reasoning holds: `/public/*` is a
  *rendering* view for two unauthenticated browser pages, explicitly free to change shape,
  carrying no `confirmed`, no `hold` and no `source`. A module that generates presets from the
  table is a table-holder by definition. The zero-configuration story the steer was buying is
  worth little here anyway - Companion runs on another host, where D-24's loopback waiver does
  not apply and the passphrase was already mandatory. Proven in the shipped module: it
  publishes `confirmed`, `hold` and `source`, none of which `/public/*` carries.

  **Three sideloading facts, each of which cost real time and none of which is in any doc:**

  1. **`apiVersion` is declared, not derived.** `runtime.apiVersion` is the author's claim
     about which host API the module wants; `@companion-module/base` ships no such field.
     Companion 5.0.3 implements `1.14.0`, `2.1.0`, and a `2.1.2` nightly. The manifest
     declares **1.14.0**, proven by loading before anything was built on top of it - the
     skeleton reported its own `"skeleton loaded"` string back through `instances.statuses`.
  2. **macOS `tar` breaks the sideload, and the error blames the wrong thing.** It writes
     AppleDouble `._*` entries, the first being `._.` - a file with ONE path component.
     Companion extracts with `strip: 1` and **no ignore filter**, so that name strips to
     empty and the install dies with `EISDIR` pointing at the module directory.
     `COPYFILE_DISABLE=1` suppresses them.
  3. **The tarball needs directory entries AND a real top-level name.** The manifest finder
     takes the first DIRECTORY entry as the prefix to trim. A tarball of files only never
     matches `companion/manifest.json` and reports "Doesn't look like a valid module" - which
     reads like a manifest problem and is not one. These two requirements pull against each
     other, and the layout that satisfies both was found by replicating Companion's own two
     tar steps locally rather than by guessing.

  Also corrected against the ticket: `controls.entities.setOption` takes **`entityId`**, not
  `id`; and `instances.connections.add` takes `product` as `.optional()`, so passing `null`
  is a malformed input rather than an absent field.

  **Proven end to end on hardware.** A Companion button press drove the real light: the
  server recorded `source: human:companion` and `confirmed: on-air` read back from the
  device; the ESP32 glass went to `BUSY`/`ON AIR`; the module's own stream updated its
  variables; and the SwiftBar menu bar showed `● ON AIR`. Four surfaces, one press.

  **What the live install cannot prove repeatably is now a test.** "Presets regenerate when
  `tableVersion` moves" is otherwise only testable by editing Rocket's live state table for
  the sake of a test, so `companion-module/test/fake-server.mjs` implements just enough of
  the server to bump the version on demand. Eight tests, no Companion needed, in
  `npm run verify`.

- **D-76 (2026-08-27)** **The menu bar carries a drawn ON AIR sign, not words - and UNLIT is
  reserved for "not a state" (#51).**

  The plugin used to write the state into the menu bar as text (`○ AVAILABLE`, `● ON AIR`).
  Width is the scarce resource up there, so it now draws a small ON AIR **sign** instead:
  32x11 points, a 64x22 bitmap whose `pHYs` chunk declares 144 DPI so AppKit reads it as a 2x
  representation at half the point size.

  **The sign is painted in the state row's own `color` on its own `bgcolor`** - both halves of
  the operator's own indicator, the same pair the panel paints on the glass and the admin
  console edits. There is no second palette to drift from the first.

  **THE BUSY RULE (D-32) is expressed as LIT versus UNLIT.** No data and no service draw the
  sign as an outline with nothing behind the letters. That is stronger than the old text
  marker: an unlit sign cannot be read as *any* configured state, whatever colours the
  operator picked for it - not even if they configure a row in the same grey. A row whose
  colours cannot be painted faithfully (missing, malformed, or no matching row at all) lands
  in the same picture, because a sign this renderer cannot paint truthfully is one it will
  not paint.

  **The `unknown` row's own colours are deliberately NOT used.** That row is `#ff00ff` on
  `#1a1a1a`, chosen for the glass, where the background is dark by construction. `#1a1a1a` in
  the menu bar is invisible on a dark menu bar and a black smear on a light one. NO DATA gets
  grey, and "no service" gets the warning amber, both unlit.

  **There is no hover text, and that is a SwiftBar limitation rather than an omission.**
  SwiftBar assigns `tooltip` to `NSMenuItem` - dropdown rows - and never to the status item's
  button; `button?.toolTip` does not appear in `MenuBarItem.swift`. The state in words is
  therefore the first row of the dropdown, one click away.

  **No dependency was added for imaging.** A PNG is a zlib stream in four length-prefixed
  chunks, and the encoder is twenty lines of `struct` and `zlib`. Every feature of the sign is
  an even number of device pixels and every glyph starts on an even column, so the 2x bitmap
  halves onto exact pixel boundaries on a 1x display - which is the case that actually has to
  look right, because all three of Rocket's displays are 1x today.

  **The test suite had to change shape, not just expectations.** `deploy/test-swiftbar.sh`
  now decodes the PNG and asserts on the set of opaque colours in it: one colour means unlit,
  two means lit in the row's own pair. Grepping for a marker character was only ever a proxy
  for "what does the operator see", and the thing the operator sees is now a picture. Proven
  by mutation - a NO DATA branch that draws a lit calm sign fails 9 assertions, trusting the
  `stale` flag instead of deriving it fails 2, and matching the row by position instead of by
  id fails 4.

- **D-77 (2026-08-27)** **The plugin takes the look from `GET /config/states`, not from
  `/public/status` - the same call D-75 made for Companion, for the same reason.**

  The plugin read presentation from `/public/status`. `docs/api-contract.md` is explicit that
  this is a *rendering view* for `/display` and the landing page, "free to change shape to
  suit the two pages", and that "a renderer that holds a table must not use these ... take the
  state key from the gated endpoints and the look from `GET /config/states`."

  It also **removes a race instead of merely detecting one.** Semantics and presentation
  arrived in two responses, and a write landing between them paired one row's `busy` with
  another row's colour. The old code could only notice the mismatch and drop the colour.
  Looking the row up by its **id** makes the mismatch impossible: the two halves are for the
  same row by construction, and reordering the table cannot repaint the sign. The row is
  matched on the **raw** id from `/status`, not the sanitised copy - `safe()` rewrites `|` and
  collapses whitespace, which is right for a menu line and wrong for a lookup key.

  `/public/status` is no longer read by the plugin at all.

- **D-78 (2026-08-27)** **The admin console's `light` block is called "Device connection" on
  screen. The glossary keeps "on-air light" for the thing itself.**

  Rocket, looking at the console: *"there is a section called light. that word doesn't make
  sense in this context."* He is right, and the reason is worth writing down because it is a
  recurring trap in this repo.

  **"On-air light" is the correct glossary word for the object** and is not being retired. But
  the four fields under that heading - `host`, `entity`, `username`, `password` - are not
  about the light. They are about **how the server reaches it**. Naming a section after the
  noun when its contents are about the *link to* the noun is what made the heading read as a
  category error: next to Status, States, Admin and Network, "Light" promises the light's
  settings and delivers a connection string.

  This is a **screen label, not a domain word.** Nothing in the wire contract, the config
  document, the code or the glossary is renamed - the JSON key stays `light`, and
  `docs/agents/domain.md`'s entry stands. The banned-words list is untouched. What changes is
  one `<h2>` and one rail entry.

  Considered and rejected: **"Panel"**, which `deploy/swiftbar/README.md` already uses for the
  ESP32's own pages. It is shorter and it is already in circulation, but adopting it in the
  console would promote a README's convenience word into the operator-facing vocabulary
  alongside "on-air light", giving one object two names in two UIs. One name per thing.

- **D-79 (2026-08-27)** **The environment overlay keeps winning over the config document, and
  the console is made to say so. Truthfulness is bought in the UI, not by moving the
  precedence.**

  Rocket asked whether the ESP32 address in the console is required or informational. It is
  **required and load-bearing**: `server/src/app.ts:373` returns no driver when
  `light.host` is empty, and the service falls back to `NoopDriver`, which logs a line and
  drives nothing.

  It is also, on this host, **not the value in effect**. `server/src/index.ts:42` reads
  `process.env.ONAIR_LIGHT_HOST ?? config.light.host`, and `loadEnvOverlay()` has already
  pulled `~/.onair/config.env` into the environment - where all four device variables are set.
  So all four fields render as editable text boxes that the running service is ignoring. Typing
  a new address, staging it and saving it succeeds, reports success, and changes nothing about
  where state is sent. Both values happen to read `10.42.12.77` today, so this is a trap rather
  than an outage.

  **The precedence is not the bug.** It is D-14's rule, deliberately preserved when D-36
  retired `config.env` as the config *source*, and it is the documented way to point a box at a
  different light over SSH when its own UI cannot be reached. Reversing it to make the console
  authoritative would trade a silent lie for a missing escape hatch.

  So: a gated route reports **which keys the environment is overriding, by name only**, and the
  console renders those fields read-only, naming the variable and the file to edit. **Names,
  never values** - `ONAIR_LIGHT_PASS` is a device credential and D-35's shell is served
  unauthenticated to every caller. Ticket #53.

- **D-80 (2026-08-27)** **The view (simple/advanced) and the theme (light/dark) are
  browser-local and apply instantly. They are deliberately outside the draft model.**

  Rocket asked for a simple/advanced switch and a theme toggle, both as settings he chooses.
  The obvious home is the config document, next to everything else the console edits. That is
  the wrong home.

  D-39 gives this page **three commit levels** - `editing`, `staged`, `saved` - and one Save
  in the header that reaches the server. Putting a view preference in the document means
  switching from simple to advanced marks the configuration dirty, increments the staged
  count, arms the beforeunload guard, and waits for a Save. **Changing what you are looking at
  is not a configuration change**, and making it behave like one teaches the staged count to
  cry wolf.

  The considered alternative - write it straight through to the server, bypassing the draft -
  buys cross-machine persistence at the cost of one config route that does not obey D-39. A
  documented exception to the commit model is a large price for a preference that is genuinely
  per-browser anyway: the theme you want on the laptop is not obviously the theme you want on
  the kiosk.

  `localStorage`, therefore. No Save button, no round trip, no interaction with the draft at
  all. It follows the browser, which is the right scope for both.

- **D-81 (2026-08-27)** **The admin password is masked; the machine passphrase stays in
  plaintext. The asymmetry is the point.**

  Rocket asked for the admin password field to be `type="password"`, and for a note saying so
  when it is still the shipped default. The natural next move is to mask the passphrase
  sitting immediately above it. Deliberately not done.

  The two credentials have opposite jobs. The **admin password** is typed by a human into this
  page and nowhere else; it is never read back, so masking costs nothing. The **passphrase**
  exists to be **read off this page and typed into other things** - the ESP32's ESPHome
  dashboard, the Companion module's config, VCREC. Masking it adds a reveal click to every
  client setup for no gain: the page is already behind admin credentials, so anyone who can
  see the field can already read the config document that holds it.

  The default-value note is **informational, not a nag**. `POST /admin/session` already
  computes `nags.adminPassword` and it is `true` on the live box. The wording says *currently
  set to the default* and stops there. Consistent with the standing position that these
  defaults are documented and fine, like a router's - the note exists so the operator knows
  which state they are in, not to push them out of it.

- **D-82 (2026-08-27)** **The console is a command surface with sections revealed beneath it,
  and the busy rule is drawn ASYMMETRICALLY: a stale calm state loses its colour, a stale busy
  state keeps it.**

  Rocket on the old page: *"it reads like just a list of things you can do. There is no
  organization to speak of and it is way too busy"*, and the five rail links *"don't actually
  scroll to the right thing"*. The second half was literally true - the rail was
  `href="#status"` against sections id'd `sec-status`, so **every link was inert**, had always
  been, and no test noticed because no test drove the page.

  Three variations were prototyped and judged (`docs/design/admin-console-2026-08-27/`). The
  winner is **A, command-first**: the tally and the state chips are the first and biggest thing
  on screen, identical in both views, above every section, so the job the page is opened for
  costs one glance and zero navigation. The rail below **reveals** one section and hides the
  rest; it never scrolls, and it carries per-section signal (staged counts, a stale mark)
  grafted from variant B.

  **The asymmetry in `treatment()` is the most valuable thing the bench produced**, and it came
  from the losing variant C. Two of the three prototypes handled stale evidence by draining the
  row's colour toward the page background - the intuitive move, and wrong in one direction:

  - **calm + stale** -> withhold the colours entirely. Painting a calm room on evidence that
    cannot support it is the failure this product exists to prevent (D-32).
  - **busy + stale** -> keep the row's own colours, under a hatch. **Draining a stale ON AIR
    toward grey weakens a busy signal**, and false OFF is worse than false ON.

  A judge verified the drained treatment reads calm from across the desk in the light theme,
  which is exactly what the rule forbids. Six lines decide it, and both directions are now
  browser tests.

  **Simple view carries States and Admin and nothing else.** Not advanced-with-things-hidden:
  Status, Network and Device connection are absent from the rail, because the command surface
  already carries the one fact that matters and it is on screen in both views. The judges
  scored one variant 9/9/10 on simplicity for a view holding three paragraphs of prose above
  its controls; that was scoring the calm rather than the word count, and no prose shipped.

  **Tested in a browser, and that is new.** `admin-ui/test/browser.mjs` runs inside
  `npm run verify` and asserts what no text assertion can reach: that a node survives a poll,
  that a section is actually revealed, that the palette repaints when the theme flips, and that
  a preference survives a reload. 53 checks. The text suite in `server/test/admin-ui.test.ts`
  survives as the cheap sibling.

- **D-83 (2026-08-27)** **The device-connection precedence now lives in one function, and the
  console links to the panel using it. A field that lies can be re-read; a link that lies gets
  clicked.**

  D-79 decided the environment keeps outranking the config document and the console must say
  so. Implementing it exposed the real defect underneath, which was not the missing notice.

  **The precedence was written out in exactly one place - `makeDriver` in
  `server/src/index.ts` - and that place was not reachable by anything else.** So the admin
  console had no way to know what the driver had resolved, and rendered the document's value as
  though it were in effect. `deploy/onair`'s `cmd_ui` had to reimplement the same rule in bash
  to print a correct URL, and `deploy/test-ui.sh` pins it there with a test named *"the overlay
  wins over the document"*. Three copies of one rule, and the web console held the only copy
  that was wrong.

  `effectiveLight()` in `server/src/config.ts` is now the single expression of it. `makeDriver`
  calls it, and `GET /admin/config` reports its result as `env.lightHost` alongside
  `env.overrides` - **names of the overriding variables, never their values.** An overridden
  field renders read-only and names the variable and the file to edit.

  **Rocket asked for a link to the panel from that section** (#55), which is what made the
  single-source fix urgent rather than tidy. A text field showing a stale address is a thing
  you can re-read and doubt. A link is a thing you click, and it takes you to a box the service
  is not driving while looking exactly like success. The links are built from `env.lightHost`
  for that reason, and a browser test asserts the link follows the override when the two
  disagree.

  Two smaller decisions inside it. The **scheme is ours and only the authority comes from
  config**: the host is validated as host-shaped before it reaches an `href`, and an unset or
  malformed address emits no anchor at all rather than a dead `http:///onair`. And the bundle's
  **"no external resources" test changed shape.** It banned the string `http://` outright,
  which was a proxy for "loads nothing remote" and would have banned this feature rather than
  the hazard. It now asserts the hazard directly - no remote `src`, no `url()`, no `@import`,
  no `fetch` to an absolute URL, no hardcoded absolute anchor - and pins the one surviving
  scheme literal to the runtime-built link. Proven stricter, not looser: three planted hazards
  are each caught.

- **D-84 (2026-08-27)** **The CrowPanel 7.0" joins the Elegoo board as a second renderer and
  becomes the primary glass. Its 4MB flash, not its size, is what constrains the design.**

  The hardware is an Elecrow CrowPanel ESP32-S3 HMI Display Module, **SKU DIS08070H**: 7.0
  inch, 800x480, GT911 capacitive touch, on an **ESP32-S3-WROOM-1 N4R8**. Confirmed on the
  bench rather than taken from the listing - `esptool flash-id` reports revision v0.2,
  embedded 8MB PSRAM, and a GigaDevice `c8 4016`, which is **4MB** of quad-mode flash.
  (Rocket's note said 5 inch; the board's own splash screen says 7.0, and the SKU agrees.)

  **It adds to the OLED panel rather than replacing it**, and is the one to look at. D-63
  already makes renderers dumb and plural, so a second one costs no new state model. What it
  does cost is real and is deferred to stage 3 of #57: `light.host` is a single string
  (`server/src/config.ts`) and `makeDriver` builds exactly one `EsphomeTextDriver`
  (`server/src/index.ts`). **State is pushed to one host; only the table is pulled.** So a
  second panel does not work by being plugged in, and the open question it raises - what
  `confirmed` means when one panel takes a write and the other does not - is a THE BUSY RULE
  (D-32) question, not a plumbing one. The safe answer is not "average".

  **4MB of flash means two OTA slots of 1792KB each**, and that single number decides the
  rendering approach: **no LVGL.** What this panel has to draw is five shapes and some text,
  which is not what a widget toolkit is for, and the toolkit is the one dependency that could
  put the image over the slot. Measured, not estimated: the stage 1 bring-up image is
  **993472 bytes, 55% of a slot**, with `web_server` already in it. Stage 2 adds
  `http_request`, `json` and the three on-air headers to that.

  Two board facts that cost time and are worth never rediscovering. **`flash_size: 4MB` is
  load-bearing** - every CrowPanel example online says 16MB because they are for a different
  board, and 16MB here gives `rst:0x3` in a boot loop with no log output at all, which reads
  like a hardware fault. And **`logger: hardware_uart: UART0` is load-bearing**: ESPHome
  defaults the S3 logger to `USB_SERIAL_JTAG`, the chip's native USB, which this board does
  not expose - its USB is a CH340 wired to UART0. On the default the board runs perfectly and
  says nothing at all on the wire, so the first serial capture looks like a board that died
  after `entry 0x403c891c`. The config gate confirms the reason independently: it warns that
  **GPIO19 and GPIO20 are the USB-Serial-JTAG pins**, and this board wires the GT911's I2C
  bus to them. The native USB port is not merely unexposed here, it is spent.

  **Touch does not work on this unit, and the received wisdom about why is wrong here.** Every
  write-up says the same two things: the GT911's address is latched at power-on so it is
  `0x5D` or `0x14`, and the PCA9557 I/O expander must be left alone because resetting the
  GT911 through it is how people break touch. An I2C scan on this board answers with **exactly
  one device: `0x18`, which is the PCA9557 itself.** The GT911 does not answer at either
  address, so this is not the address lottery - the touch controller is sitting in reset
  behind the expander nobody is supposed to touch. The same expander also drives the
  backlight, so experimenting costs a lit panel.

  **So touch is not declared at all**, which is a decision and not an omission. Declaring it
  makes ESPHome mark the component FAILED at every boot and plants a permanent error in the
  log that is not the error anyone will be looking for. An on-air panel is a **renderer**
  (D-63) and the Elegoo board has no touch whatsoever, so nothing in the product needs it.
  Tracked on #57 rather than half-built.

  **A full repaint of this panel costs ~150ms**, measured - ESPHome warns about it every
  frame at `update_interval: 1s`. The Elegoo board repaints a 128x64 OLED every 500ms and
  nobody notices. 800x480 is 47 times the pixels, so stage 2 must **repaint on state change
  rather than on a timer**, or the panel spends a sixth of its loop pushing an identical
  frame while also serving HTTP.

  One procedural trap, mine rather than the board's: **ESPHome's safe_mode rolls an OTA back
  if the board reboots before the boot is marked good.** Hard-resetting over RTS to read the
  boot log immediately after flashing rolled the device back to the previous app partition,
  and the previous build's errors reappeared - which reads exactly like a fix that did not
  take. Wait out the window, or verify over HTTP instead of resetting.

  Pin map and timings come from `esphome/esphome-devices` PR #1494, which documents this exact
  SKU. **The CrowPanel 5.0" numbers on `devices.esphome.io` are not interchangeable** despite
  being the same resolution: that page assigns the same physical pins to different colour
  channels and swaps `de_pin` with `vsync_pin`.

- **D-85 (2026-08-27)** **The on-air firmware is now a shared package, `onair-core.yaml`, and a
  board file owns nothing but its own hardware. The split is enforced by a rule with teeth:
  if a block names a pin, it is board knowledge.**

  Two boards sharing ~450 lines of state-table machinery by copy-paste would drift, and D-83
  had just finished demonstrating what that costs - a rule written in three places, with the
  copy nobody was looking at being the wrong one. Duplicating it here would have undone
  `compute_view()`'s single-decision guarantee one level up: two panels standing next to each
  other, disagreeing, each correct according to its own copy.

  `configs/onair-core.yaml` holds the state table and its pull, the entities the server
  drives, the scripts, the served pages and the rendering decision. Board files hold
  `substitutions`, `esp32`, `logger`, `i2c`, `font`, `display` **and nothing else**.

  **The refactor is proven, not asserted.** `esphome config` on the Elegoo board is
  **content-identical** before and after - the resolved output differs only in key ORDER, and
  a sorted diff is empty. That is the whole safety argument for touching a working device's
  config: the live panel's build is unchanged, so it does not need reflashing to stay correct.

  The rule found its own first violation immediately. A vestigial "Onboard LED" switch on
  `GPIO2` had been sitting in what became the core - and `GPIO2` is the CrowPanel's
  **backlight**, so the config failed outright rather than subtly. It named a pin, so it moved
  to `elegoo-esp32.yaml`. A style rule that fails a build is worth more than one that reads well.

- **D-86 (2026-08-27)** **The colour glass draws the operator's colours; it does not re-decide
  what they mean. THE BUSY RULE was already asymmetric one layer down, and the second renderer
  is what proved it.**

  Writing the CrowPanel's display lambda, the obvious move was to implement D-82's asymmetric
  treatment on the glass: calm+stale withholds colour, busy+stale keeps it under a hatch.
  **Half of that was already done and the branch could never have run.** `compute_view()` in
  `onair_table.h` turns `stale && !busy` into `NO_DATA` before any renderer sees it, because a
  calm claim is the only one that can be a false OFF. So a colours-withheld case cannot reach
  the row branch, and code written to handle it is dead - along with a comment claiming the
  glass enforces a rule the shared header enforces for every renderer at once.

  Both were removed. What the glass legitimately decides is the **busy** half: a stale busy row
  keeps its own colours and takes a hatch. Verified on hardware rather than argued -
  `on-air` stays `BUSY` after 98 seconds without a write, `available` becomes `NO DATA`.

  > **AMENDED 2026-08-27 by D-91/D-102, and the amendment is on the MEASUREMENT, not the
  > argument.** That hardware run was real and correctly reported, and the second half of it -
  > *`available` becomes `NO DATA` after 98 seconds without a write* - **was the bug**, not the
  > proof. It is what `stale && !busy -> NO_DATA` did, and since the last write is routinely
  > hours old and the server latches state, it fired on a completely healthy system.
  >
  > Re-measured against the latched model in D-105: `available` now stays `AVAILABLE` at 98
  > seconds and beyond. Everything else in this decision stands - the dead branch was still
  > dead, the glass still does not re-decide meaning, and `CALM_HEAVY`/`CALM_LIGHT` still
  > collapse to one picture while `render_branch` reports the chosen shape.

  **`CALM_HEAVY` and `CALM_LIGHT` collapse to one picture on this panel.** That split exists
  only because a 1-bit display has no colour and has to pick a SHAPE by luminance; a colour
  panel just draws the row. But `render_branch` still reports the shape `compute_view` CHOSE,
  not the picture that was painted, so both boards report **the same vocabulary** over HTTP.
  That is not tidiness: comparing what two panels believe is the whole of #57 stage 3, and it
  is impossible if they answer in different words.

- **D-87 (2026-08-27)** **The CrowPanel is the active panel; the Elegoo board is a TEST board
  that is normally absent. An absent panel is a normal condition, not a fault, and stage 3 has
  to be built for that from the start.**

  `ONAIR_LIGHT_HOST` now points at the CrowPanel and the end-to-end path is proven: a write to
  `POST /state/{id}` reaches the glass and comes back as `confirmed`, for `on-air`,
  `interruptible`, `recording` and `available`.

  The repoint exposed that the previous address was already dead - `10.42.12.77` does not
  answer and `elegoo-esp32.local` does not resolve, and the daemon log holds **915 consecutive
  `[esphome-driver] fetch failed` lines** ending exactly at the restart. That was not a
  regression and is not a fault: **Rocket's Elegoo board is a bench board and is normally off.**

  What that settles for #57 stage 3, which was its hardest open question: **`confirmed` cannot
  mean "every panel agreed".** If one renderer is expected to be absent for weeks, an AND over
  all panels would make `confirmed` permanently false and the system would report a fault as
  its resting state. The shape that survives is **one authoritative panel for `confirmed`, all
  others best-effort** - a secondary that does not answer is logged and otherwise ignored. That
  also keeps THE BUSY RULE (D-32) intact: `confirmed` continues to mean a genuine device read
  from the panel that matters, rather than a quorum that can be gamed by adding hardware.

  Corollary, and the thing that made this hard to see: **the driver's failure log is unusable
  for this.** 915 identical lines, no timestamp, no host, no give-up. There is no way to tell
  from it when a panel went away or for how long. Tracked separately.

- **D-88 (2026-08-27)** **The firmware update port stays open, with no password, on purpose and
  for now.** Port 3232 on every renderer accepts an OTA firmware upload from anyone on the LAN.
  The renderer's own web upload endpoint is closed (`web_server: ota: false`), so this is the
  one remaining unauthenticated path.

  Rocket's call, with his reasons recorded because they are what a later reader will need:
  he is new to ESP32 work, the network and the physical location are trusted, and **the cost
  of a forgotten OTA password is losing the ability to reflash a board without a USB cable.**
  While he is still learning the hardware, the risk of locking himself out is larger than the
  risk of someone on his own LAN reflashing a light.

  **The trigger for revisiting is named, not vague:** when a renderer leaves this network, or
  when the system becomes more production-like. Adding `password: !secret web_server_password`
  to `ota:` in `onair-core.yaml` is the whole change, and it is safe in one direction - a
  running board with no password still accepts the upload that adds one.

- **D-89 (2026-08-27)** **The state table is PULLED and the current state is PUSHED, and a
  naive state poll would break THE BUSY RULE rather than merely duplicate work.**

  Recorded because the asymmetry looks arbitrary until you try to remove it. Verified against
  the firmware: the only outbound request it ever makes is `GET /config/states`. It never
  reads `/status`.

  **Why the table is pulled:** it changes monthly, and a renderer that fetches it needs no
  server-side registration to stay current (D-38). Five triggers, one cadence nobody notices.

  **Why the state is pushed:** it changes many times an hour and matters within a second, and
  push is what produces the **confirmed state** - the On-air API writes, then reads back, which
  is genuine device evidence rather than an echo of intent (D-22.3).

  **The trap, and the real reason a state poll is not a free addition.** The device's staleness
  timer measures *how long since someone asserted this state*. A poll asserts nothing new. If a
  polling device stamped `last_write_ms` on receipt, then a server sitting on hour-old data
  would be refreshed into looking current on the glass, and a calm row would keep its colours
  for ever. **That is a false OFF manufactured by the safety net**, which is the one error
  D-32 exists to prevent. A state poll must therefore carry the server's own `updatedAt`
  forward and never stamp its own receipt time.

  So a poll is worth adding as a **backstop, not a transport** - it corrects a renderer that
  missed a push, and it is what makes an extra renderer cost no server configuration (#57
  stage 3). It must not become an option that can turn the push OFF: a light that is slow to
  come ON is the failure this whole system exists to avoid.

- **D-90 (2026-08-27)** **The WRITER is responsible for making a state change stick. The On-air
  API is reactive: it answers writes, answers questions, and accepts configuration. It does not
  chase anybody.**

  Rocket's design for the **Detector** (VCREC): on a transition it writes the new state, then
  **reads it back to validate**, and repeats on a cycle - of the order of five seconds - until
  the state is confirmed or it runs out of retries or time. Delivery is the writer's problem,
  not the reader's.

  This is a bigger statement than it looks, because it removes the main argument for decay.
  **Staleness exists to cover a write that might have been lost.** If the writer retries until
  it has confirmed the change, a lost write is DETECTED BY THE WRITER rather than inferred by
  the server from silence. Silence then means what a state machine says it means: nothing has
  changed.

  It also settles a question the polling discussion kept circling. **The server must not poll
  anything to ask whether it should change state.** Nor should it need to: a renderer already
  pulls the **state table** by itself (D-38), and the writer now guarantees the state. The two
  remaining pull-shaped questions are separable - the **confirmed state** (already a genuine
  device read-back, D-22.3) and whether a renderer needs a slow backstop poll to self-correct
  after a missed push (open, D-89).

  **What this does NOT solve, and must not be assumed to:** a writer that dies entirely writes
  nothing and retries nothing. Retry-until-confirmed makes delivery reliable; it says nothing
  about whether anyone is still watching. That is a **liveness** question about the writer, and
  it is a different question from what the state is. Conflating the two into one 90-second
  timer is the thing now under review.

- **D-91 (2026-08-27)** **The server latches state and never decays it. Every judgement about
  age moves to the client, where it becomes a judgement about the CONNECTION rather than about
  the state.** Rocket's call, and it supersedes the server half of D-32.

  **Server.** While the service runs, the state is the state. `state`, `hold`, `source`,
  `updatedAt` and `message` change only on an explicit write. Nothing expires, nothing decays,
  and the server never asserts anything about time. `STALE_AFTER_S` and `stale()` go, and
  `stale` leaves the wire: it is a **judgement**, and the server no longer makes judgements.
  `ageSeconds` and `updatedAt` stay as **provenance** - facts a client may reason about. This
  completes D-90: the API answers writes, answers questions, accepts configuration.

  **Client.** Every renderer PULLS. Three conditions, not two:

  1. reachable -> draw the current state, plainly.
  2. unreachable, inside the grace window -> **keep drawing the last known state**, with a
     visible "connection lost" mark - a band, a line of text or an icon. The panel says what
     it last knew AND that it is no longer being refreshed. It does not go blank and it does
     not go calm.
  3. unreachable beyond a configured timeout and/or retry count -> **NO DATA**.

  Timeout and retry count are **configuration**, not constants, and either or both may apply.

  **This is not a new pattern, it is the existing one finally applied evenly.** `/display`
  already ships exactly this: a `DISCONNECTED` overlay behind a 45s watchdog
  (`server/src/display.ts:64`, `:68`). SwiftBar already pulls every 5s with a bounded socket
  deadline. The admin console already polls. **The ESP32 was the only renderer being pushed
  to**, and the only one that could not tell "the server says calm" apart from "I cannot hear
  the server".

  **WHAT THIS COVERS AND WHAT IT DOES NOT - stated plainly, because the gap is real.** It
  covers server death, network partition and renderer isolation: all three now produce a
  visible, escalating loss of confidence at the renderer. **It does NOT cover a dead WRITER.**
  If VCREC stops while the state reads `available`, the server is healthy, every client polls
  happily, and every panel paints confident green. If Rocket then joins a call, that is a false
  OFF - the error D-32 exists to prevent, and this design does not prevent it.

  That is accepted deliberately and is **not fixed by adding decay back**. The fix, when it is
  wanted, is additive and needs no restructuring: the server reports one more **fact** - when
  the writer was last seen - and the client decides what to do with it. A fact is not a
  judgement, so it does not violate the rule above. Until then the exposure is named rather
  than hidden.

- **D-92 (2026-08-27)** **Poll cadence and the two escalation thresholds, as configuration with
  Rocket's defaults. Push survives as a best-effort NOTIFICATION; the poll is the source of
  truth.**

  **Push is an optimisation, not a delivery guarantee.** On a state change the server emits to
  every connected client and **does not error if a client misses it**. The contract is
  explicit: a client that misses a push gets the change on its next poll. That makes push
  purely a latency win and removes it from the correctness argument entirely - which is what
  lets the server stop caring whether any particular renderer is listening.

  Two transports, because the hardware forces it and the split is worth writing down:
  - **Browser renderers** already have this. `sse.ts` holds a `clients` Set, broadcasts
    `text/event-stream`, and drops a client on close without erroring. Nothing to build.
  - **The ESP32 cannot subscribe.** ESPHome's `http_request` is request/response on ESP-IDF;
    the only `text/event-stream` in the component is inside the vendored `httplib.h`, which is
    compiled for the `host` platform, not the board. Verified, not assumed. So the panel keeps
    the existing server-initiated HTTP write - now **best effort, logged and never fatal** -
    and its poll is what makes a missed push harmless.

  **The three thresholds. All configurable; these are the defaults.**

  | Setting | Default | Meaning |
  |---|---|---|
  | poll interval | **1000 ms** | how often a renderer asks the server |
  | connection lost after | **1 minute** | mark the display as no longer refreshing; state unchanged |
  | no data after | **30 minutes** | give up on the state entirely -> NO DATA |

  Both thresholds are measured from the **last successful contact with the server**, not
  chained off each other. Two independent numbers, one clock.

  **Milliseconds, as one bounded integer, not a menu of named speeds.** Range 250..60000,
  default 1000. A fixed enum of 1/5/30/60s is always slightly wrong for somebody and needs a
  code change to widen; an integer with a floor does not. It also maps straight onto an ESPHome
  `number:` entity, so it is editable from the panel's own config page and over HTTP, and it
  persists in NVS like every other device setting. **The floor is 250 ms and it is a measured
  number, not a taste:** a full 800x480 repaint costs ~150 ms, so the paint must become
  on-change before a fast poll is safe. The poll itself is cheap - a LAN round trip - so once
  paint is on-change, 250 ms costs a few percent of the loop.

  **The two thresholds are deliberately far apart, and that separation is the whole design.**
  A meeting runs about thirty minutes, so the STATE must survive a server outage for at least
  that long or the panel goes dark mid-call. But the honesty about not being refreshed costs
  nothing and should arrive immediately.

  This resolves an asymmetric-threshold proposal that was raised and **rejected in favour of
  something simpler**. The concern was real: holding ON AIR silently for 30 minutes is a false
  ON, which D-32 calls the safe error, while holding AVAILABLE silently for 30 minutes on a
  dead link is a false OFF, the error that matters. The proposed fix was a shorter
  connection-lost window for calm rows than for busy ones. **Rocket's split is better and
  needs no asymmetry at all:** mark every state as unrefreshed after one minute, and let every
  state persist for thirty. A calm row on a dead link is never drawn as a confident claim,
  because within a minute it is visibly no longer being refreshed - and there is no second
  rule, no per-row branch, and nothing to explain to whoever configures it next.

- **D-93 (2026-08-27)** **Deleting `stale()` also deletes the two places the server CHANGED
  STATE on its own, because both were the same clock read wearing a different hat.** Found
  while implementing D-91 (#60); recorded because "delete a helper" turned out to mean
  "delete a behaviour".

  `stale()` had three server callers, not one. The wire field was the obvious one. The other
  two were the **withheld heartbeat** (`supervise.ts`: refuse to assert a calm state older
  than 90s, so the device's own watchdog trips to NO DATA) and the **boot adoption**
  (`app.ts`: a device reading busy beats a persisted calm state older than 90s). Both are
  gone, along with the supervisor's mid-tick adoption of a device that disagrees.

  The reason is not tidiness. Under D-91 the server latches, so an assertion that is
  withheld on age is the server making a judgement about time, and an adoption is the server
  changing state with nobody having written anything - which D-90 forbids in as many words.
  **The device is a RENDERER, not a source.** Every value it holds arrived from an earlier
  assertion by this server or from a hand-poked entity; it is never newer than the state,
  so there was never anything there to adopt. The supervisor now asserts `state` whenever
  the heartbeat is due, at any age, and re-asserts over a device that disagrees.

  **What is NOT deleted:** `decayMs` decaying `confirmed` to `unknown` after a run of failed
  reads. `confirmed` describes the DEVICE, not the state - it is evidence, and an admission
  that the evidence has run out is a fact about the reader, not a judgement about the state.
  D-91's rule is that the server does not decay STATE, and `confirmed` is not state.

  This makes the false-OFF exposure D-91 already named slightly wider and no less accepted:
  the boot adoption was a partial cover for a dead writer (it caught the case where the
  panel still held ON AIR), and it is now gone. The fix remains D-91's - report when the
  writer was last seen, as a fact - not a re-litigation of decay.

- **D-94 (2026-08-27)** **Best-effort push means the tick must always finish, not merely that
  the request may fail.** #61's server half, and the one place it was not already true.

  The HTTP write path already met D-92: `doWrite` catches around `driver.set` and around the
  version nudge, so an unreachable panel surfaces as `confirmed: "unknown"` on a `200`. The
  SSE hub already met it too - `sse.ts` detaches a client whose `write` throws and carries on
  broadcasting, with tests for both the broadcast and the heartbeat path. **Neither needed
  building; both were confirmed against the tests that already cover them.**

  The gap was the **supervisor**. Its driver calls were unguarded, and a throw abandoned the
  tick before the `confirmed` bookkeeping at the bottom. The failure that produces is not a
  crash - `enqueue().catch()` swallows it - it is that `confirmed` FREEZES at its last good
  value: the decay to `unknown` lives in the code the throw jumped over. A panel that fell
  over would therefore keep reporting `confirmed: "on-air"` indefinitely, which is a claim
  about evidence the server no longer has. Every driver call in the tick now goes through a
  `bestEffort` wrapper that logs and returns "no evidence", so the tick always reaches the
  decay.

  **Deliberately NOT changed here, and named because it is a real cost:** a write with the
  panel unplugged takes **13 seconds** to answer (measured, this ticket - `retries` then
  `confirmTries` against a dead host, each on a 2s timeout). The write SUCCEEDS, which is
  what #61 asked for, but the caller waits out a retry ladder belonging to a push that D-92
  says is not a delivery guarantee - and D-90's detector retries every ~5s, so writes overlap
  before the first one has answered. Filed as its own ticket rather than folded in here: it
  is a latency and concurrency question about `confirmed`'s contract, not a non-fatality one.

  `verifyEntity()`'s `DriverConfigError` stays FATAL at boot. A 404 on the entity name or a
  401 is a deploy bug, not a missed push, and it fails identically every time; an unplugged
  panel returns `null` from the same call and boots fine. That distinction predates D-92 and
  survives it.

- **D-95 (2026-08-27)** **The contract states the client rules as CONTRACT, not as advice, and
  the two superseded specs get banners rather than edits.** #62's shape.

  `docs/api-contract.md` §3 now carries THE BUSY RULE reduced to its surviving sentence -
  *absence of information never renders calm* - explicitly relabelled as a rule about
  **renderers**, followed by the server latch and a new **CLIENT CONTRACT** section: the three
  conditions, the three defaults, and the fail-closed requirement. It is written in the
  imperative because a renderer that ignores it draws a confident calm claim on a dead link,
  which is the failure the whole system exists to prevent - that is not a style note.

  **The `~60 s heartbeat` line is deleted, and the deletion is the load-bearing part of this
  ticket.** That sentence is what the decayed design rested on: if writers heartbeat, silence
  is evidence, and a server may reason from it. D-90 replaces the premise - the writer retries
  until CONFIRMED and then stops - so the contract now says so in as many words rather than
  leaving the old convention lying around for the next client to implement.

  **Two specs under `docs/superpowers/specs/` restate the 90 s rule normatively and were NOT
  rewritten.** The 2026-08-23 v2 design gets a superseding blockquote directly under the rule
  it states, plus an amendment note on the D-6 paragraph. The 2026-08-22 ESP32 spec gets a
  banner at the top covering every `90` in it at once - `FRESH_S`, `freshS`, `STALE_MS 90000`
  and the "90 s of false green after reboot" analysis. Editing them line by line would
  falsify the record of what was decided when; a spec is a dated artefact and the banner is
  how this repo already handles it (the D-46 transport banner on the same file is the
  precedent being followed).

  `docs/NEXT.md`'s "the light spends most of its life showing NO DATA, because THE BUSY RULE
  correctly refuses to claim calm on stale evidence" is rewritten rather than banner-ed,
  because it is a status page rather than a dated spec - and because that sentence describes
  the exact symptom D-91 exists to remove.

  `docs/companion-setup.md` still documents a `Stale` feedback and a `stale` variable. Left
  deliberately for **#66**, so the operator-facing doc and the module change land together.

- **D-96 (2026-08-27)** **A memoryless renderer has to write its contact time down, or it
  cannot have a grace window at all.** #63's one genuine design problem, and it is the
  SwiftBar plugin's alone.

  D-91 measures both thresholds from the **last successful contact**. `/display` and the
  admin console are long-lived pages and just keep a variable. **SwiftBar starts a fresh
  process every five seconds and it dies with its answer**, so from inside one run "the
  service has been down for two seconds" and "for two hours" are indistinguishable - and the
  only safe thing a renderer with no memory can do with a failed poll is give up at once,
  which is precisely the over-eager NO DATA this whole change exists to remove.

  So the plugin records `{at, status, table}` to `~/.onair/swiftbar-contact.json` on every
  successful poll, and consults it on a failed one. **Fail-closed is preserved and moved
  somewhere stronger:** an absent, unreadable, malformed or FUTURE-DATED record all mean
  *withhold calm*. D-64.3's incident was trusting a server field; now no server field feeds
  the liveness decision at all, so there is nothing left to be renamed, skewed or absent. A
  read-only home directory costs the grace window and nothing else - it degrades to
  give-up-immediately, which is the safe direction.

  Its test harness now redirects `HOME` into the scratch dir. It did not before, so the suite
  was reading the operator's real `~/.onair` - harmless until this ticket, and a cross-test
  contaminant the moment the plugin started WRITING there.

- **D-97 (2026-08-27)** **D-82's asymmetric TREATMENT survives D-92's rejection of asymmetric
  THRESHOLDS. They are different axes and conflating them would have deleted a judge-verified
  result.**

  D-92 rejects a shorter connection-lost window for calm rows than for busy ones: one minute
  for everything, thirty for everything, no per-row branch. That is about **when** to stop
  trusting a reading.

  D-82 is about **how a reading you have stopped trusting should look**: an unrefreshed CALM
  row loses its colours entirely, an unrefreshed BUSY row keeps its own colours and takes a
  hatch. Two of three design prototypes drained both directions toward grey, and a judge
  verified that draining reads calm from across the desk in the light theme - which is the
  thing the invariant forbids. Both renderers that draw colour (admin console, SwiftBar) keep
  that asymmetry; only its trigger moved, from the server's `stale` flag to the renderer's own
  connection.

- **D-98 (2026-08-27)** **The blanking DISCONNECTED overlay is deleted, and `/display`'s page
  script is now executed by its tests rather than pattern-matched.**

  `/display` covered a lost stream with an 82%-black full-screen overlay. Under condition 2
  that is wrong on its face: the contract says the renderer **keeps drawing the last known
  state** and adds a mark - *it does not go blank*. An overlay over the state word is going
  blank. NO DATA is now drawn as the state itself, using the reserved row, because an overlay
  on top of a held state is two claims at once and the honest one is the reserved row.

  Three smaller corrections found while doing it, each of which was silent:
  - `es.onopen` used to clear the mark. **Opening a socket is not contact** - a stream that
    connects and then says nothing is the exact failure the thresholds exist to catch. Only a
    parseable payload counts.
  - `es.onerror` used to raise the overlay; a draft of this change had it call `connect()`.
    Both are wrong. `onerror` fires immediately when the server is down, so reconnecting from
    inside it is a tight loop against a box that is already struggling. The 10 s watchdog
    retries on a clock; `onerror` is now empty, because a socket error is not a verdict - the
    thresholds are.
  - A query-string override matched a literal `"d"` rather than a digit. The page is a
    TEMPLATE LITERAL, so the escape was eaten on the way out and the feature silently did
    nothing. It uses a character class now, which cannot have that bug. **A regex over the
    page source would never have caught this** - which is why the tests now run the script in
    a stub DOM with a controllable clock and assert the three conditions as behaviour.

- **D-99 (2026-08-27)** **The paint is driven by a core-owned FLAG that each board consumes,
  because the obvious form does not exist in ESPHome.** #64.

  The natural shape is `on_value: component.update: my_display` on `presence_key`. It cannot
  be written: `presence_key` is a **core** entity and `my_display` is **board-local**, and
  D-85's rule is that anything naming board hardware is board knowledge. Extending the core's
  entity from the board file does not work either - **measured, not assumed: ESPHome 2026.8.0
  does not merge package list entries by `id`**, so a board-side `text:` block carrying the
  same id produces a SECOND entity and a validation error rather than an extra trigger.

  So the core says WHAT happened (`repaint_pending`, set on a state change and on a table
  install - not on a 304, since the table did not move) and each board decides what to do
  about it (a 100ms interval that consumes the flag and updates its own display). The display
  id never leaves the board file, and the cost is a bool test per tick instead of a repaint.

  Displays are set to `update_interval: never` and **the safety net is a timed set of the
  flag in the core**, not a slow `update_interval` per board. One currency for every repaint
  means one place to look when asking why the glass redrew, and "something should redraw
  every 30s" is board-independent in a way that "which display" is not.

  **Measured on the live CrowPanel:** 1.0 fps before, **0.033 fps idle after** - one repaint
  per 30s, a 30x cut - and a state change repaints within one 100ms tick (`Render` moved
  `NO DATA -> BUSY -> CALM LIGHT` while `Frames` advanced 3 in the 8s containing the change
  and 0 in the 8s before it). That is what makes #65's 250ms floor safe: a ~150ms blocking
  repaint at 1 Hz was ~15% of the loop, and it is now ~0.5%.

  Only the CrowPanel consumes the flag. The Elegoo's 128x64 repaint is trivial, its display
  has no `id:` today, and it is a bench board that is normally off (D-87) - adding the
  mechanism there would be speculative work with no measurement behind it.

- **D-100 (2026-08-27)** **`esphome upload` does not compile, and a stale build flashes
  silently and successfully.** An operational trap, recorded because it cost real work and
  produced a FALSE MEASUREMENT that was nearly committed as fact.

  `firmware/Makefile` documented OTA flashing as `esphome upload --device <ip> <config>`.
  That command ships whatever binary is already in `configs/.esphome/build/`. With a stale
  build it prints `INFO OTA successful` and `Successfully uploaded program`, the panel
  reboots, answers HTTP, and looks completely healthy - while running the OLD firmware.

  The damage was not the wasted flash. Twice, an idle repaint rate was measured at exactly
  1.0 fps and attributed to the change under test; the conclusion drawn was *"`update_interval`
  does not govern the paint on this platform"*, which is false, and it was written into a YAML
  comment as a measurement before being caught. What caught it was checking
  `build/crowpanel-7/src/main.cpp` for a value that had just been changed:
  `my_display->set_update_interval(1000)` where the config said `never`.

  The Makefile now names both steps in order and says why. **The generated `main.cpp` is the
  cheap way to tell a flash that took from one that did not** - far cheaper than reasoning
  about hardware that is answering every request perfectly while running last week's code.

- **D-101 (2026-08-27)** **The panel polls `GET /status`, not `GET /public/status`, and the
  contract already decided it.** #65's one open question, answered by reading rather than by
  choosing.

  `docs/api-contract.md` §5 says of the public pair: *"A renderer that DOES hold a table must
  not use these; it takes the state key from the gated endpoints and the look from
  `GET /config/states`."* This panel holds a table (D-38/D-54). The public pair is a rendering
  **view** for two browser pages that hold none, it is explicitly free to change shape to suit
  them, and building firmware on it would couple a device that needs a reflash to a payload
  the contract refuses to stabilise. The passphrase is already on the device for the config
  pull, so the gated route costs nothing.

  The poll reads **one field**, `state`. Not `busy` - that would put a second copy of the
  safety flag on the device, able to disagree with the row it already holds. Not `ageSeconds`,
  and that omission is the whole of D-91 in one line: it is provenance about the write, it
  decides nothing, and the panel judges its own connection instead.

- **D-102 (2026-08-27)** **The device half of THE BUSY RULE loses its calm clause, and that
  clause was the single line most responsible for the panel sitting on NO DATA.**

  `compute_view()` read `if (key == "unknown" || (v.stale && !v.eff.row.busy))` -> NO_DATA. A
  calm row whose WRITE was more than 90 seconds old was refused outright. Since the last write
  is routinely hours old and the server latches it, that condition was true nearly always: the
  panel drew NO DATA on a completely healthy system, which is the symptom this whole line of
  work exists to remove. Observed live at the start of this work - `PresenceKey: available`,
  `Render: NO DATA` - and gone at the end of it.

  It is replaced by `gap > no_data_ms`, measured from the last successful POLL. **The
  protection is not weakened, it is relocated and strengthened.** A calm claim still cannot be
  drawn as a confident one on a dead link: past `lost_ms` the row is visibly marked and says
  in words that it is not a current reading, and past `no_data_ms` it is given up entirely.
  What the panel may no longer do is throw away a state the server is still serving.

  D-92 chose this over the asymmetric alternative - a shorter window for calm rows than busy
  ones - and the reason it works is that the mark arrives at one minute for everything. A
  silent false OFF is the danger; a *marked* one is not silent. D-82's asymmetric TREATMENT is
  untouched (D-97): an unrefreshed row keeps its own colours and takes a hatch.

- **D-103 (2026-08-27)** **The boot fix-up that D-22-era firmware needed is deleted, because
  the new clock cannot have the bug it existed to patch.**

  `on_boot: priority: -100` zeroed `last_write_ms`, and the comment explained why in detail: a
  template text's `setup()` ends in `publish_state()`, which fires `on_value` unconditionally,
  so without the zeroing a reboot left the clock reading a few hundred milliseconds and **a
  restored `available` rendered as calm for 90 seconds with nobody behind it.** The 2026-08-22
  ESP32 spec calls that the boot watchdog that isn't, and rates it CRITICAL.

  `last_contact_ms` needs no such fix-up and cannot acquire that failure: it starts at 0 and is
  written **only by a successful poll**. A restored entity value is not contact, a push
  arriving is not contact, and `on_value` firing during setup is not contact. `0` is treated as
  the largest gap there is rather than as a gap of zero, so a panel that has never heard from
  the server draws NO DATA - by construction, not by a boot hook that has to be remembered.

  This is the second time this design has removed a class of bug rather than a bug (the first
  being D-96's fail-closed contact record). Both come from the same move: judge the thing you
  can observe directly - your own connection - instead of a number somebody else sent you.

- **D-104 (2026-08-27)** **When a renderer gives the state up, it lands on the RESERVED ROW,
  which is busy. Reporting "not busy" would be a false OFF on a physical control.** #66, and
  the one place the Companion module needed a decision rather than a rename.

  `stale` leaving the wire is mechanical. What is not mechanical is what a stream deck should
  do 30 minutes into a server outage. The tempting answer - report the last known values and
  let the operator notice the connection variable - is wrong for a button: buttons are read at
  a glance across a room, and a calm-looking button is a claim.

  So `view()` returns the reserved `unknown` row past `no_data_ms`: `state: 'unknown'`,
  `label: 'NO DATA'`, **`busy: true`** (D-34's rule, that every degenerate path lands on a
  conspicuous state), and the `State is` feedback stops matching the row it can no longer
  confirm. Both feedbacks read through `view()` rather than through `current` - reading
  `current` directly is what would leave a deck lit for the last row it heard about,
  indefinitely.

  **Breaking, deliberately, with no alias.** `$(stale)` and the `Stale` feedback are gone, not
  renamed: a variable that silently resolves to nothing on a stream deck is worse than one that
  is loudly absent, and an alias beside the real thing is the decoy D-83 records.
  `docs/companion-setup.md` carries the migration table and says so at the top.

  `$(age_seconds)` survives and is now labelled *provenance only* in both the module and the
  docs. It is the field an operator would most naturally reach for to answer "can I trust
  this", and it is exactly the wrong one - which is worth saying in the UI rather than only in
  a decision record.

- **D-105 (2026-08-27)** **D-86's hardware run, re-measured against the latched model. The
  panel no longer sits on NO DATA, and the number that used to decide it now visibly decides
  nothing.** #67, the last of the D-90/D-91/D-92 work.

  Live CrowPanel at `10.42.14.239`, shipped defaults (poll 1000 ms, connection-lost 60000 ms,
  no-data 1800000 ms), server running and answering, **nothing writing state for the duration
  of each arm**. `writeAge` is the server's `ageSeconds`; `heard` is the panel's own time since
  the server last answered it.

  | | glass | Render | mark | writeAge | heard |
  |---|---|---|---|---|---|
  | on-air, t+4s | ON AIR | BUSY | no | 4 s | 0 s |
  | on-air, t+50s | ON AIR | BUSY | no | 50 s | 0 s |
  | on-air, t+98s | ON AIR | BUSY | no | 98 s | 0 s |
  | on-air, t+138s | ON AIR | BUSY | no | 138 s | 0 s |
  | available, t+4s | AVAILABLE | CALM LIGHT | no | 4 s | 0 s |
  | available, t+50s | AVAILABLE | CALM LIGHT | no | 50 s | 0 s |
  | **available, t+98s** | **AVAILABLE** | **CALM LIGHT** | no | 98 s | 0 s |
  | available, t+160s | AVAILABLE | CALM LIGHT | no | 160 s | 0 s |

  **The bolded row is the whole ticket.** D-86 measured `available` becoming `NO DATA` at 98
  seconds without a write. Same panel, same elapsed time, same absence of writes: it now draws
  AVAILABLE, because the server is answering and the server latching a state is what makes that
  state true. `writeAge` climbs to 160 s and past it while every other column stays put - the
  number that used to decide the picture is visibly inert.

  The `on-air` arm is unchanged from D-86, and that matters as much: this work did not buy the
  calm case by weakening the busy one.

  **The escalation still happens, and is keyed on the server rather than the clock.** Measured
  separately in #65 with the thresholds set to 5 s / 15 s: held plainly to 4 s, `NOT REFRESHING`
  from 6 s, `NO DATA` from 15 s, and back to `AVAILABLE` within one poll when the server
  returned. Three conditions, one clock, thresholds not chained.

  **The original complaint is closed.** `docs/NEXT.md` said *"the light still spends most of its
  life showing NO DATA, because the last write is routinely hours old and THE BUSY RULE
  correctly refuses to claim calm on stale evidence."* At the start of this session the live
  panel read `PresenceKey: available` / `Render: NO DATA` with a healthy server. It does not any
  more, and the rule that produced it was not correct - it was measuring the wrong thing.

- **D-106 (2026-08-27)** **The freeze detector has to be calibrated against the panel's own
  idle repaint rate, and #64 moved that rate by 30x without moving the detector.** A
  regression this work introduced, caught on the live system rather than by a test.

  `EsphomeTextDriver.repainted()` reports a panel as FROZEN when its `Frames` counter has sat
  still for `frozenAfterMs`, defaulting to 20s. That was calibrated against a panel repainting
  once a second. D-99 made the paint on-change with a 30s safety net, so an idle panel now
  repaints twice a minute - and every healthy idle panel began reporting frozen. The live
  system sat at `confirmed: "unknown"` with the daemon log filling with *"device state agrees
  but the panel is not repainting"*, while the glass was rendering perfectly.

  Sharpest detail: **the driver's own comment already warned about this exact failure** -
  *"reporting that as frozen drops `confirmed` to `unknown` on a perfectly healthy panel. Only
  a counter that has sat still longer than any plausible publish interval is real evidence."*
  The reasoning was right and the constant was stale. "Any plausible publish interval" is not a
  fact about the driver; it is a fact about firmware in another language in another directory,
  and nothing connected the two.

  Default raised to **90s = three safety-net repaints**, and the coupling is now a TEST rather
  than a comment: `driver.test.ts` reads the interval out of `onair-core.yaml` and fails if the
  threshold no longer clears it. A freeze detector calibrated below the panel's own idle rate
  does not detect freezes, it manufactures them.

  **Why no test caught it:** every existing `repainted()` test passes `frozenAfterMs`
  explicitly, so the default was exercised only in production. Verified after the fix on the
  live system: `confirmed: "available"` and **zero** new freeze reports in 150 s against a 90 s
  window.

- **D-107 (2026-08-27)** **`/` on the panel redirects to `/onair`, and it works only because
  it is registered EARLY. The ESPHome dashboard keeps a path at `/?esphome=1`.** Closes #56.

  The complaint was two complaints with one cause: the bare device IP prompted for a password,
  and the page behind it looked "way too simple". Nothing had been deprecated. `/` was
  ESPHome's own dashboard - its default entity table, behind ESPHome's auth - and D-57's page
  was one path over at `/onair`, open, with none of that. **The bare IP is what a human types**,
  and it was the one URL that went somewhere useless.

  **Registration order is the entire mechanism, and it is easy to get silently wrong.**
  `AsyncWebServer::request_handler_()` walks its handlers in registration order and the first
  `canHandle()` that returns true wins. ESPHome's `WebServer::canHandle()` answers true for
  `/` (web_server.cpp:2339, 2026.8.0). `install_pages()` runs at `on_boot` priority -100, which
  is strictly AFTER web_server's setup at `setup_priority::WIFI - 1` (249) - so a root handler
  added there is appended second and never fires. There is no error and no log line; the
  redirect simply does not happen. So the root handler gets **its own `on_boot` at priority
  600**, above 249. Registering that early is safe: `add_handler_without_auth()` appends to
  `WebServerBase::handlers_`, and `init()` copies that vector into the running server in order.
  `global_web_server_base` is assigned in main.cpp's `setup()` before `App.setup()`, so it is
  non-null at every component priority.

  **Registered without auth, deliberately.** A redirect that fires only after a password prompt
  is worse than no redirect, because it teaches that the prompt is expected.

  **The dashboard is not swallowed.** `canHandle()` DECLINES when the request carries
  `esphome=1`, and declining is not a 404 - it falls through to the next handler that claims
  `/`, which is ESPHome's own, still behind ESPHome's auth exactly as before. The OTA and log
  views live there and have no other URL. Both device pages now link to `/?esphome=1`; the
  config page's old `href="/"` would have bounced straight back.

  **The `=1` is measured, not decorative.** This shipped once reading a bare `/?esphome` and
  the live panel redirected anyway. `query_has_key()` calls ESP-IDF's
  `httpd_query_key_value()`, which parses `key=value` pairs and cannot see a valueless key.
  The host-test shim had modelled the bare key as matching, so the test passed and the device
  disagreed - the same class of failure as D-100, a shim or a build that is not the thing it
  stands for. The shim now mirrors the device and a test asserts the measured truth: bare
  `/?esphome` redirects, `/?esphome=1` falls through.

  Verified on the live CrowPanel at `10.42.14.239` after an OTA flash: `GET /` -> `302
  Location: /onair` with no credential; following it -> `200`; `GET /?esphome=1` -> `401`, and
  with the device credential -> `200` and the dashboard's own HTML; `/onair` -> `200`;
  `/onair/config` -> `401`; `/onair.css` -> `200`.

  No doc named the bare device root as the way in - `deploy/swiftbar/README.md` already said
  `http://<light>/onair` - so the doc half of #56 was already satisfied, and the only offender
  was the device's own config page.

- **D-108 (2026-08-27)** **A test helper that proves a port free must probe the SAME scope the
  service binds, and must not draw from the pool the kernel hands out at random.** Closes #58,
  whose own fix direction pointed at the wrong code.

  The flake was `Error: listen EADDRINUSE: address already in use :::54460` during
  *"A REBIND THAT FAILS ROLLS BACK"*. The ticket read that as the test's `blocker` picking an
  unlucky port and told us to make the blocker atomic - **but the blocker already was**: it
  does `listen(0)`, reads the assigned port and keeps the listener, exactly as recommended.
  The race was one helper up, in `freePort()`, and it had two independent defects.

  **Defect one: the wrong scope.** `freePort()` probed `127.0.0.1`. `resolveBind('all')`
  returns `['::']` and `listenAll()` binds that - the dual-stack wildcard. Measured on this
  machine, holder down the side and the attempted bind across:

  | holder | `127.0.0.1` | `::1` | `::` | wildcard |
  |---|---|---|---|---|
  | `127.0.0.1` | EADDRINUSE | OK | OK | OK |
  | `::1` | OK | EADDRINUSE | OK | OK |
  | **`::`** | **OK** | **OK** | **EADDRINUSE** | **EADDRINUSE** |

  Read the last row. **A port held on the wildcard still binds happily on `127.0.0.1`.** So the
  probe asked the one address that always says yes, and the service then failed on an address
  the probe never looked at. `:::54460` is that address. Wildcard holders are everywhere in a
  run: every other test file boots the same app on `::`, and this file's own blocker takes an
  ephemeral wildcard port.

  This was worth measuring rather than reasoning about - the first version of the fix asserted
  that a holder on `::1` would block a wildcard bind, and the matrix says it does not.

  **Defect two: the ephemeral range.** The port came from `listen(0)`, i.e. macOS 49152-65535
  or Linux 32768-60999, and was then released. Anything on the machine - a browser tab, an
  outbound fetch, another test file - can be handed it back in the gap. The ticket saw this
  half and was right about it.

  **The fix.** One shared `test/free-port.ts` (both suites had their own copy of the same two
  bugs), which probes the **wildcard** and draws from **20000-32767**, below both ephemeral
  ranges. Nothing lands there by accident; anything squatting there is a real service and the
  probe skips it. The band is cut into 64 slices and each process takes `pid % 64`, because the
  runner gives every test FILE its own process - two processes that never look at the same port
  cannot race at all, and near-consecutive worker pids land in distinct slices.

  Note the two pools are now disjoint by construction: the blocker still takes an *ephemeral*
  port on purpose, and can no longer collide with a port `freePort()` handed out.

  It is still not atomic and cannot be - the service does its own `listen()`, so proving a port
  free and taking it are always two steps. What is gone is both reasons that gap could lose.

  The proof is a test, not a run count: hold `::`, assert a loopback probe calls the port free,
  assert the wildcard bind fails EADDRINUSE. Eight consecutive full server runs, 337/337.

- **D-109 (2026-08-27)** **The driver logs the EDGES of a host's reachability, not the polls -
  with a timestamp and the host on every line.** Closes #59.

  Census of the live daemon log the day this was written: **1133 `[esphome-driver]` lines,
  1127 of them two repeated strings** - "fetch failed" 910 times and "The operation was
  aborted due to timeout" 217. One event, a panel going away, recorded a thousand times. No
  timestamp on any of them, and no host. Nothing else in the whole log came close: the next
  most frequent line appeared 88 times.

  The three things missing were each enough on their own to leave the question unanswered, and
  the question is *when did this panel go, and which one*. #87 makes "which one" sharper than
  it looks: the Elegoo is a bench board and is **normally** absent, so the log has to tell
  expected silence apart from the panel that matters dying, and it could not.

  **Now:** the driver holds `failingSince` / `failedCalls` and emits one line when a host
  starts failing and one when it comes back.

  ```
  [esphome-driver] 2026-08-27T23:39:41.674Z 127.0.0.1:58351 UNREACHABLE: POST 503
  [esphome-driver] 2026-08-27T23:39:44.617Z 127.0.0.1:58351 BACK after 3s and 45 failed calls
  ```

  Measured: 46 failing calls across a real outage produce those two lines. 20 `set()` calls
  plus a version nudge against a black-hole host produce **one**.

  **Steady-state repeats are dropped, not rate-limited.** The second identical line already
  says nothing the first did not, and the recovery line's count says it better. A host that
  FLAPS still logs per transition, and that is the honest answer - alternating results are a
  different fault from a dead panel and must not read like one. The failure count on the
  recovery line is what tells them apart at a glance.

  Three call sites fold into the one detector rather than keeping their own streams:
  `attempt()`, `setTableVersion()` (whose nudge would otherwise be a second stream of
  identical lines saying what the first already said), and `verifyEntity()` - boot is simply
  the FIRST contact, so a dead host at startup is an edge like any other and loses its bespoke
  un-stamped line. A `DriverConfigError` keeps its own once-only flag: it is deterministic and
  will fail identically forever, so it is said once and then silent until the host answers.

  **The timestamp is on these lines only, and that is a deliberate half-measure.** Nothing in
  this log has ever carried one - not `[onair]`, not `[supervisor]`. Stamping the sink would
  be the better log and it is a different change: it rewrites the output of every component
  and the deploy tests that read it. A stamped edge line also anchors the unstamped lines
  around it, which is most of the value for a fraction of the blast radius. Worth doing
  properly one day; not worth smuggling into this ticket.

  This also unblocks the cheapest fix for #68. Skipping the device when the driver already
  knows the host is failing needs exactly this per-host failure state.

  Verified live: daemon cycled onto the new build, `state=available, confirmed=available`, and
  no `[esphome-driver]` line at all against a healthy panel.

- **D-110 (2026-08-27)** **A panel can show the wall clock, it takes its time from SNTP, and
  it is off by default.** Closes #69.

  **SNTP is the only source this product already has**, and that is a conclusion rather than a
  default. There is no Home Assistant to take time from, neither board carries an RTC, and
  pushing the time from the server would have put a clock in `docs/api-contract.md` and still
  needed local interpolation between polls - real work for a worse answer.

  Which is exactly why the clock is drawn only when it is VALID. The source can simply never
  arrive: a panel on a network with no route to an NTP server is a case that has to render, so
  it renders as `--:--`. An ESP32 with no time set reports 1970, and a panel confidently
  showing 1970 is the same class of lie as one showing a state it cannot vouch for. Blank was
  rejected for the same reason - an empty slot reads as "the clock is off", which is a
  different fact from "the clock is on and does not know the time".

  **WHETHER is the core's, WHERE is the board's** (D-85), and the two boards genuinely answer
  differently. The CrowPanel has 800x480 and drops the clock in the middle of its diagnostics
  band, keeping the IP and the signal. The Elegoo's band is 128px and already spends ~123 of
  them on `IP: 192.168.1.123` plus `-52dBm`, so there is no third slot - there the clock TAKES
  THE IP's slot, because the 48px above the band belongs to the state and is never overdrawn.
  The IP is still on `/onair`, on the ESPHome dashboard and in the router's lease table; the
  clock has nowhere else to be.

  **Off by default.** A panel exists to answer one question from across a room and the time is
  not that question. `RESTORE_DEFAULT_OFF` for `auto_profile`'s reasoning: the stored value
  wins, so the choice survives a reboot - and it survived an OTA reflash, measured.

  **The minute tick is the part that is not obvious.** The CrowPanel paints on
  `repaint_pending` alone (#64) with a 30s safety net, so a clock left to that net would show
  a minute up to 30 seconds late, which is visibly wrong in the one way a clock is not allowed
  to be. `on_time: seconds: 0` asks for the repaint exactly when the digits change. It is
  GATED on the switch, or a panel with the clock off would force a full 800x480 repaint every
  minute forever to redraw a frame nobody asked for - the waste #64 removed.

  Measured on the live CrowPanel over identical 3-minute windows, state static at CALM:
  **12 repaints with the clock on, 9 with it off.** Exactly one extra per minute, only when
  the switch is on.

  **The rendered string is shared, not copied** - `onair::format_clock()` in `onair_table.h`,
  for the same reason `compute_view()` is there. Two renderers drawing a clock from two copies
  of the 12-hour wrap would drift, and it makes the format testable on the host, which a
  display lambda is not. 9 host checks cover both ends of the wrap; midnight-as-0 and
  noon-as-0 are the two ways this arithmetic goes wrong.

  A `Clock` text sensor publishes exactly what the glass draws, or `off`. That is Render and
  RowLabel's job repeated for the same reason - what reached the glass should be readable, not
  asserted - and the argument is stronger here, because **this panel is moving to WiFi-only and
  will have no serial log**, and a clock is the one thing on the glass whose correctness cannot
  be checked by reading state out of the server. It is what proved this feature: panel `5:30
  PM` against the Mac's `5:30 PM`, after 31 seconds of `--:--` while SNTP had not yet answered.

  Not investigated here: the 30s safety net predicts 6 repaints in 180s and the idle panel
  does 9. Pre-existing - with the clock off, nothing added by this ticket sets the flag.

- **D-111 (2026-08-27)** **The clock toggle belongs on `/onair/config`, in a `Glass` bar
  beside the `Pages` one - and it ASKS the switch rather than storing the answer twice.**
  Closes #70. Amends D-110, which put the only control on the ESPHome dashboard.

  D-110 left the toggle where ESPHome puts a switch, which #56 had just moved behind
  `/?esphome=1`. Rocket went to `/onair/config` looking for it. That is the answer: the
  panel's own page is the operator surface, and a setting that changes the glass is not an
  ESPHome implementation detail.

  **Why it was not simply added to `Appearance`.** That struct is documented as *how the
  served pages look, not how the glass looks* - no path to `compute_view()`, no vote in what
  is drawn. One more field would have made the comment defining it false. So the boundary
  held and the clock got its own command kind.

  **Two labelled bars, `Pages` and `Glass`.** Rocket picked this over merging them into one
  settings bar or hiding both behind a disclosure, having flagged the page as already busy.
  The pairing earns the extra bar: it makes D-70's distinction VISIBLE on screen rather than
  a sentence somebody has to read. Merging would have put a glass setting in the row that is
  documented as page-only, which is the same contradiction by another route.

  **`Command::GLASS` only ASKS.** Applied like `REFRESH`, not like `APPEARANCE`: the switch
  it drives is an ESPHome entity no header can name, and that switch's `RESTORE_DEFAULT_OFF`
  is already the persistence. So `held().clock_on` is a MIRROR published by
  `publish_context()` and never a second copy of the setting - there is one source of truth
  for whether the clock is on, and it is the switch.

  `take_clock_request(bool &on)` is tri-state for a reason worth stating: "requested off" and
  "nothing requested" are different, and a bool cannot express both. A one-shot that returned
  `false` for an off request would fight the switch forever.

  **The bar reports three states, not two.** Off; on and showing a time; and *on but this
  panel has never been told the time*. The third is the one worth naming - from across a room
  it is indistinguishable from a clock that is merely wrong, and its cause is the network
  rather than the panel, so the bar says so and points at NTP.

  Verified on the live CrowPanel, page form to glass and back:

  ```
  before:                    switch=ON   glass=5:53 PM
  POST action=glass&clock=off  HTTP 200  switch=OFF  glass=off
  POST action=glass&clock=on   HTTP 200  switch=ON   glass=5:54 PM
  ```

  Refusals measured on the device too: `clock=maybe` -> 400 "the clock must be on or off",
  cross-origin -> 400 "came from another site", switch untouched by both.

  An existing guard caught this change before hardware did: the suite enumerates every
  `action` value the page emits and fails on one the handler does not recognise. It failed on
  `glass` the first time the bar rendered. That test is doing exactly the job it was written
  for. Firmware host checks 156 -> 183.

- **D-112 (2026-08-27)** **The clock is drawn OVER the state, not in the diagnostics band -
  and the state render is MAPPED into what is left rather than shifted.** Closes #71.
  Amends D-110's placement on the CrowPanel; the Elegoo's is unchanged.

  D-110 put the clock in the diagnostics band at 22px, next to the IP and the signal. Rocket's
  verdict was **too small**: legible from a desk, not from across the room, and across the
  room is the distance this panel is read at. The band was the wrong home because the band is
  for things you go and look for; the clock is something you want to catch at a glance, which
  makes it the state's neighbour rather than the diagnostics'.

  **A MAP, NOT A SHIFT, and that is the whole finding.** Shifting every branch down by the
  strip height is the obvious move and it does not work: the row branch's "NOT REFRESHING"
  line already sits at y=360, so shifting it by ~140 would push it into the band at 430. So
  each branch keeps its ORIGINAL 0..430 coordinates and passes every y through one `sy()`
  that maps 0..430 onto `state_top..430`.

  Two things fall out of that, both worth having. With the clock off `state_top` is 0 and
  `sy()` is the IDENTITY - the panel draws exactly what it drew before, byte for byte, so the
  default path is not a new layout at all. And each branch still reads as a layout rather than
  as arithmetic, with one line to look at when asking how the clock moved something.

  Checked before flashing, because a display lambda cannot be host-tested and the glass cannot
  be read over HTTP. With the strip on, every branch's text spans **145..409** inside a
  140..430 area; the clock spans 38..110, a **7.9%** top margin against the 5-10% asked for.
  Nothing crosses the band and nothing crosses the strip.

  **Drawn after the branches, not before**, since every branch opens with `it.fill()` and
  would paint over it. That also lands it on the ROW'S OWN background in `fg`, so it is
  legible on every colour in the table without the board file knowing any of them.

  **The unrefreshed hatch stops at `sy(0)` and never crosses the clock.** The hatch means
  *this state is not being refreshed*, and that claim is about the state. The clock is local
  and keeps ticking whatever the server is doing, so hatching it would be a false statement -
  the same standard D-110 applied when it refused to draw 1970.

  72px against `label_huge`'s 110, deliberately: the state is what this panel exists to say
  and the time must not out-shout it.

  **Not the Elegoo.** Its state area is 48px tall and its status word is already 30px of it.
  There is no room for a large clock above it, so there the clock stays in the band taking the
  IP's slot (D-111). D-85's split again, and the third time these two boards have honestly
  needed different answers to the same switch.

  Verified live after the flash: `--:--` rendered in the new font for the first seconds after
  boot, then `6:17 PM` on the glass and `Showing 6:17 PM` on the config page, against the
  Mac's 6:17 PM. Repaints continuing, heap free 210,668 with a 163,840 largest block.
  **The pixels themselves are unverified by me** - nobody can read this panel over HTTP, which
  is exactly why the `Clock` sensor exists, and it is a position check that sensor cannot make.

- **D-113 (2026-08-27)** **The panel gets a bench: an operator-held override of the glass,
  behind `?bench=1`, that always lets go.** Closes #77's blocking half.

  #77 asked for a power meter and a pair of eyes. The meter could not be found, and the eyes
  are the half that actually decides - whether `ledc_stop(chan, 0)` reads as BLACK on
  DIS08070H is in no source file, and no amount of reading settles it. So the panel grew an
  instrument instead: six buttons that put the glass in a state, so the question can be
  answered by looking.

  Backlight 100 / 25 / 5 / Off, "Black" (an `it.fill` over the FINISHED frame, after the
  diagnostics band, so the whole screen goes dark rather than a rectangle with a strip glowing
  under it), and "Normal".

  **EVERY OVERRIDE LETS GO, two ways, and this is the part that matters.** There is no touch
  on this panel - the GT911 sits in reset behind the PCA9557 - so a bench that could leave the
  glass dark with no way back would be a trap on a board whose only other surface is a web
  page nobody can read in the dark.

  - a two-minute timeout, the trap-door for a closed laptop;
  - **and a busy row takes the glass back immediately.** A test is never worth a missed ON
    AIR. This is D-6 and D-63 applied to our own instrument: if the bench could hold the glass
    dark through an incoming call, it would be the invariant's own failure with the operator's
    fingerprints on it.

  Held-state release uses a signed millis() difference, so an override survives the 49-day
  wrap rather than every override releasing at once.

  **The black is painted, not branched.** Every render branch still runs, so `render_branch`
  and the `Render` sensor keep reporting the state that WOULD be drawn. A bench that made the
  panel lie about its own branch would be a poor instrument for settling whether a dark panel
  lies.

  **Behind `?bench=1`, and that is arithmetic rather than shyness.** The first draft cost
  4228 B on the five-row config page against the 4000 B Pool A ceiling and the budget test
  caught it - and that ceiling is real: a failed `reserve()` under `-fno-exceptions` is
  `abort()`, which reboots the panel driving the light. A beta instrument must not tax every
  page load of the thing it exists to measure. Trimming got it to 4098, still over; gating it
  behind a footer link returned the default page to 3611 B.

  **But an ACTIVE override renders with or without the query param.** A hidden control holding
  the glass dark is the exact trap this feature is built to avoid.

  Verified on the live CrowPanel: 25% -> `brightness 64` and `Bench=backlight25`; Normal ->
  255 and `normal`; an unrecognised option -> 400 with the override untouched; six buttons
  served at `?bench=1` and zero on the default page. 220 host checks, 0 failed.

  **An OTA anomaly is NOT explained and is recorded rather than papered over.** Two uploads
  reported "OTA successful", the device rebooted each time (`Frames` reset to 3), and it came
  back running the PREVIOUS firmware - confirmed by the absence of the `Bench` text_sensor
  that the built `main.cpp` demonstrably registers at line 1767. It later came up on the new
  build with **no source change of any kind**. Cause unknown. `esphome upload` reporting
  success while the old firmware keeps running is the D-100 failure wearing a new mask, and
  the lesson stands: after a flash, wait for a MARKER THAT ONLY THE NEW BUILD HAS. Waiting for
  `/onair` to answer proves nothing - the panel serves HTTP throughout the OTA write.

- **D-114 (2026-08-27)** **The panel goes dark 23:00-07:00, and the schedule refuses far more
  often than it agrees.** Closes #78. Answers #77 by observation instead of instrumentation.

  **The mechanism was settled by Rocket looking at the panel**, which is what #77 existed for
  and what the missing power meter could not have told him: "when I click off, the whole
  screen turns off. It's great." `light.turn_off` -> `ledc_stop(chan, 0)` parks GPIO2 LOW and
  the CrowPanel goes genuinely dark, not grey. The PCA9557 comment in `crowpanel-7.yaml:60`
  raised a real doubt about that and it is now closed. No power number was ever taken, and
  none is needed: the ask was always "blank the screen at night", not "save power".

  **`night_should_darken()` is mostly refusals, and that is the design.** A panel that is
  black when it should say ON AIR is the worst outcome this system has, so every clause is a
  way of NOT going dark:

  - not while `busy` - never mid-call, at any hour (D-6, D-63, D-92);
  - not without a valid clock - there is no RTC, so if SNTP never answers the panel stays lit
    forever rather than blank forever. D-110 drew `--:--` rather than 1970 for this reason;
  - not unless `compute_view()` resolved a real ROW - dark plus NO DATA is indistinguishable
    from unplugged, and one of those is a fault worth noticing;
  - not before the server has been heard from once;
  - not if a state change already woke it during this window.

  **The window wraps midnight and equal endpoints are never dark.** `now >= 23:00 || now <
  07:00` reads as every minute of the day when the two are equal, so that is guarded in the
  predicate rather than in the entity - no pair of numbers typed into the page can produce a
  permanently dark panel. 30 host checks cover the wrap, both boundaries, the non-wrapping
  case and every refusal.

  **Wake-on-change is derived from a captured key, NOT from `presence_key`'s `on_value`.** The
  research judges caught that trap: `on_value` fires on every server re-assert rather than on
  change, because the supervisor re-asserts on a timer, so a panel armed that way would wake
  every minute all night. Instead the key is captured on ENTERING the window and compared each
  tick; a difference latches `night_woken` until the window ends.

  **One backlight answer, not two.** `effective_backlight()` folds the Beta override and the
  schedule into a single number so no board file has to know the precedence. A person standing
  at the page beats the clock: the Beta control is someone deliberately looking at the panel,
  the schedule is a guess about whether anyone is.

  Measured on the live CrowPanel, by moving the sleep time to one minute out and back:

  ```
  9:52PM  Night='lit (daytime)'  screen=ON
  9:53PM  Night='dark'           screen=OFF      <- went dark on schedule
  restore 23:00 -> Night='lit (daytime)'  screen=ON, within 8s
  ```

  A `Night` text_sensor says which of the refusals is in force - `lit (no time yet)`,
  `lit (holding off - busy or no data)`, `lit (woken by a state change)`. A panel dark on
  purpose and a panel dark by accident look identical from the doorway, and this board has no
  serial console to ask.

  **This is interim and deliberately incomplete.** There is no UI for it on `/onair/config`
  yet (#81), the server still reports `confirmed` while the glass is dark (#82, and that is a
  lie the contract has not yet been taught to tell correctly), and the times are editable only
  as minutes-since-midnight on the ESPHome dashboard. Shipped now because Rocket asked for the
  schedule to be in force tonight, not because the track is finished.

- **D-115 (2026-08-28)** **The config page is reordered, the luminance column is deleted, and
  the byte fence now measures the pages the device can actually serve.** Rocket: the Elegoo is
  out of service.

  **The fence was not guarding what its comment claimed, and that is the important half.**
  `test_byte_budget` measured `seed_table()` alone - and `seed_table()` CLEARS THE OVERLAY, so
  the single page it checked was the cheapest one that exists. Measured the moment it was made
  to look at the others: every row changed here plus the screen held was **4246 B** and with a
  banner **4289 B**, both over the 4000 B fence, with a green suite. A budget test that cannot
  see the expensive case reports a safety it has never measured, and this one had been doing
  that since #50. It now loops over seven states: default, one override, all five, screen held,
  banner, dormant override, editor open.

  **The luminance column is gone because the board it described is.** It printed `ring 73` and
  `block 71` - the shape a 1-BIT panel would pick and the luminance it picked by. That choice
  only ever existed because the 128x64 board has no colour and must tell two calm rows apart
  by lit pixels; the colour panel collapses both to one picture (`crowpanel-7.yaml:312`). With
  the Elegoo out of service it described a screen nobody looks at, in vocabulary nobody outside
  this repo shares. Rocket could not tell what it meant, which is the whole test.

  It paid for the plainer English: **47 B a row, 235 B at five rows**, and it is what brought
  the worst case back under the fence. The RULE it encoded is not gone - `luminance()` and
  `compute_view()` still decide what the glass draws, and those tests were rewritten to assert
  the fact directly rather than to grep for it in HTML. A test coupled to a column dies with
  the column; a test coupled to the rule does not.

  **The table now comes first and the settings sit under one `Panel settings` heading.** The
  order was the real defect under the layout complaint: the page was opened to change a state
  and made you scroll past a skin picker set once, months ago. Within the settings the panel's
  own setting comes before the one that only changes the website.

  **The no-table page stopped short-circuiting its own settings away.** It used to `return`
  after the NO CONFIG banner, which took the settings block with it - so the one situation
  where you most want to check the panel's settings was the one where the page refused to show
  them. Asserted now.

  Copy: `NO CONFIG - no profile has ever arrived` became `This panel has not received the list
  of states from the server`; `local override` became `changed here`; `Panel draws / Id / Busy
  / Glass` became `Shows on the panel / State id / Means a call is live`; the `(D-55)`
  self-reference and the paragraph around it are gone.

  Live: config page **3282 B**, worst measured state 3994 B, 262 host checks, zero occurrences
  of the luminance column.

  **The layout selector is NOT built.** Three layouts were designed and judged (Fold 22, Rail
  21, Two doors 21) and all three had fatal flaws found - an unscoped CSS rule that would put a
  phantom nav on `/onair`, two miscounts of the table's grid children, and a proposal to delete
  CSS the Elegoo shares. Rocket answered "arrange the form logically" rather than picking a
  layout, so the ordering fix shipped and the navigation did not.

- **D-116 (2026-08-28)** **The client guide is one markdown file, and `/docs` is generated
  from it rather than written beside it.**

  Rocket asked for instructions clients can follow when constructing API calls, as a markdown
  file **and** as a page on the server. Two copies of the same document is the whole risk in
  that request: the moment they can be edited independently they disagree, and a client guide
  that disagrees with itself is worse than none - a reader has no way to tell which half is
  stale.

  So `docs/client-api-guide.md` is the single source, and `server/tools/gen-docs.mjs` renders
  it into `server/src/docs-page.ts`, which `GET /docs` serves. `npm run docs:page:check` is in
  `npm run verify`, exactly as `gen-assets --check` is - the build fails when the checked-in
  page no longer matches the markdown. The generator implements only the markdown the guide
  actually uses and is not a general implementation.

  **The guide is not the contract.** `docs/api-contract.md` stays normative and the guide says
  so on its first screen: where they disagree, the contract wins and the guide is the bug. The
  guide is task-shaped - work out what kind of client you are, then send the right call - and
  it repeats the contract's rules rather than restating them differently.

  **`/docs` is unauthenticated**, alongside `/public/*`, `/display` and the admin shell. It
  carries no credential, no configuration and no state; it is the repo's own markdown, and a
  `401` on the page that explains how to authenticate is a door locked with the key inside.

  **The test that earns its place** is not that the page contains particular sentences - that
  is the copy-coupling that died with the luminance column in D-115. It is that **every
  endpoint the guide names still exists**: the markdown is scanned for `` `GET /x` `` route
  mentions and each is requested against a booted server, where a `404` fails and a `405`
  passes, because a `405` proves the path is real. That catches the drift a generated page
  cannot catch on its own - the guide describing a route that has been removed.

  Two generator bugs were found by looking at the output rather than at the tests. Splitting a
  line on backticks to protect code spans put the opening and closing `**` of a bold span that
  *wrapped* a code span into different pieces, and fourteen of them reached the page as literal
  asterisks; and `h2 { border-top }` drew a second rule under the `---` the markdown already
  emits. Both are now regression-covered by the no-markdown-left assertion and by having
  looked at the rendered page in a browser.

  **Nothing links to `/docs` yet.** The admin console has no reference to it, so it is
  reachable only by typing the path. Left that way deliberately: the console's navigation is
  the thing Rocket is mid-way through redesigning (D-115), and adding a link to it is his call,
  not a side effect of writing documentation.

- **D-117 (2026-08-28)** **The console gets a help icon, and it is an anchor.**

  `/docs` shipped in D-116 reachable only by typing the path. The console header now carries
  a `?` beside the theme toggle, pointing at it, opening in a new tab so reading the guide
  never costs an unsaved edit in the console.

  **An `<a href>`, not a `<button>` that navigates.** Middle-click, cmd-click and "copy link
  address" are the three things a reader of documentation actually does with a help control,
  and a button loses all three with no visible symptom. The `.iconbtn` class now neutralises
  link decoration as well as button chrome, so one class dresses both controls.

  **The test follows the href rather than a path retyped in the test.** Asserting
  `href === '/docs'` and then fetching `'/docs'` would let a renamed link keep passing against
  a URL nothing in the console points at. It fetches what the anchor actually holds, and
  checks the response is HTML with a heading in it - a help link that 404s looks perfectly
  normal in the header, because nothing about the header changes when its target is gone.

  Both mutations were run: renaming the target and demoting the anchor to a button each fail
  four checks.

  **Not added to the logged-out landing page.** That page is deliberately not a dashboard
  (D-39), and the audience for a client guide is someone who has already logged in or who is
  reading `curl` output, not someone looking at the tally.

- **D-118 (2026-08-28)** **The client guide was reviewed adversarially, and the review found
  the page was wrong about the server in three places.**

  Rocket asked for an adversarial review of `/docs` for LLM-isms, self-references and unclear
  language. The subagent returned 17 defects and 12 preferences, and **found no LLM-isms worth
  reporting** - the prose survived. What it found instead was worse: the error table and both
  worked examples were factually wrong.

  **Every factual claim in the review was re-verified against the server before acting, and one
  was rejected.** The reviewer's replacement for the `?hold=` copy asserted that `true` and
  `false` are ignored. `holdFromQuery` (`server.ts:374`) accepts `1|true` and `0|false`. Taking
  the finding on trust would have replaced vague-but-correct text with confident-but-false
  text. The concern behind it was real and the rewrite kept it; the proposed words did not
  survive contact with the code.

  What was really wrong:

  - **A body over 16 KB is a `400`, not the `500` the page claimed.** `readBody()` throws
    inside the same `try` as `JSON.parse` on `/state` and `/message`, so it arrives as
    `malformed JSON body: request body too large`. Measured with a 20 KB body against the live
    service. The page had been telling clients to retry with backoff on a request that can
    never succeed, watching for a code they never get.
  - **`409` is three different things and only one carries a status body.** The pin refusal
    merges the state in; an unset `/on`/`/off` shortcut and a stale config `version` send
    `{"error":...}` alone. "Read the status body attached to it" was false for two of the
    three, and "do not retry" was wrong for the stale version, which is exactly
    refetch-and-retry. Now three rows.
  - **The `403` row blamed the client for a server misconfiguration** - `/admin/restart` with
    no token sends the reader hunting a `source` field on a route that has none.
  - **Both worked examples failed the rules stated directly above them.** The writer never
    confirmed, contradicting section 4.5 and the checklist, and `write on-air || true`
    discarded every exit code it had just computed. The renderer used constants eleven lines
    after "make all three configuration", and its `await refreshTable()` at the top level meant
    **a server already down at boot threw at import: no interval, no first paint, a display
    that stays blank in exactly the condition it exists to report.** Proven by running the old
    boot sequence against a dead port: it painted nothing at all.

  **The examples are now run, not read.** `server/test/docs.test.ts` extracts the renderer from
  the markdown, drives it by hand against a booted server and a dead port, and asserts it
  paints NO DATA at boot, the right row when healthy, and never hands an undefined row to the
  renderer. Reverting either fix fails it - the empty-table revert hands over `UNDEFINED-ROW`
  exactly as predicted. The bash example was exercised against the live service on all four
  branches (`400` exit 2 in 0 s, pin `409` exit 0 in 0 s, transient 3 attempts over 12 s,
  happy path confirmed), targeting the state the light was already in so the wall never changed.

  The self-references are gone (`#82`, `D-` ids, "the ESP32 polls this", "there used to be a
  `stale` field", "this file is the bug"). The 27-hour menu-bar incident stays: a concrete
  failure earns trust, and it was rewritten so it no longer depends on a removed field the
  reader never saw. Emphasis went from one bold span every 43 words to one every 48, with the
  connective `**and**`s cut.

  **The typecheck caught what the test run did not.** The new test passed under `tsx`, which
  strips types, and `tsc --noEmit` rejected the `setInterval` stub cast. Running a test is not
  the same as running the gate.

- **D-119 (2026-08-29)** **The Companion module polls, and the poll is the correctness path
  while the stream is only the speed path.**

  The module had no `GET /status` call anywhere in it. Its whole knowledge of the world came
  from the SSE stream, which the contract is explicit is "an optimisation, never a delivery
  guarantee" - so the one renderer in this system that was not implementing section 3's client
  contract was the one on the physical control surface.

  Three faults, all measured in the source before any change:

  - **A half-open stream was never detected.** The `/events` fetch carried only an abort
    signal and `reader.read()` had no watchdog, so a network partition left the module
    escalating its display correctly and then **never reconnecting** - the OS socket timeout
    was the only thing that would ever end it. The 15 s keep-alive the server sends precisely
    "so a client can detect a dead stream" was consumed as a timestamp and nothing else.
  - **No cold read.** The module had no state at all until the server's next state change. On
    a quiet afternoon a Stream Deck came up blank against a perfectly healthy server.
  - **Companion's own connection light lied.** `updateStatus(Ok)` was set when the stream
    connected and never revisited. The light stayed green while the deck showed NO DATA.

  All three now go through one shape: two transports, **one `ingest()`**, which is the only
  writer of `current` and `lastContactAt`. The poll and the stream therefore cannot disagree
  about which is authoritative, and adding the poll could not introduce a class of bug where
  a stale poll overwrites a fresh event.

  The watchdog **aborts and lets the existing retry path run**, rather than reconnecting from
  the stream's error handler. D-98 already paid for that lesson on `/display`: `onerror` fires
  instantly against a downed server, so reconnecting inside it is a tight loop against a box
  that is already struggling. It also keeps its own clock, `lastStreamAt`, separate from
  `lastContactAt` - a healthy poll must not keep a dead stream alive, since noticing the dead
  stream is the entire point.

  Instance status now derives from the same `view()` every button reads: `Ok`, amber at
  `not refreshing`, red at `no data`, with a bad config or a rejected passphrase outranking
  all three because no threshold describes those.

- **D-120 (2026-08-29)** **A Companion press stays `human:`, and the pin it drops is
  announced rather than prevented.**

  `hold` was a read-only variable and nothing else - no action, no feedback, no `?hold=`
  parameter, in a module whose every press is `human:companion`. Under the PIN RULE a human
  write naming a state other than the held one releases the hold, so **an ordinary state
  button silently dropped Rocket's pin**, with `$(hold)` going empty afterwards as the only
  trace.

  **The obvious fix was rejected.** Sending `auto:companion` would make the pin rule stop
  releasing, and it would do it by lying: a thumb on a physical key is a human. `source` is
  wire contract (D-32) precisely because the detector is external and this is the only trace
  it leaves - a module that misreports who wrote, to get a rule to behave differently,
  corrupts the one field the system has no second source for. The rule is right. The silence
  was the defect.

  So: `set_state` gains a `leave` / `pin` / `release` option defaulting to `leave` (today's
  behaviour, so no placed button changes under anyone), plus `pin_current_state`,
  `release_hold`, the `held` and `held_to_this_state` feedbacks, `$(hold_label)`, and PIN /
  UNPIN presets. When a press will drop a pin, the module logs it **by name** first.

  **`release_hold` writes the CURRENT row, and that is load-bearing.** `POST /state/{id}`
  always SETS the row named in the path - there is no clear-the-pin-only route - so the row
  you name is the row the lamp goes to. Naming the HELD row looks like the conservative
  choice and is the dangerous one: in the contract's own worked example the pin is calm
  (`interruptible`) while the live state is busy (`on-air`, escalated under the carve-out),
  so releasing by writing the held row drives the lamp OFF AIR while the camera is live.
  Writing the current row is idempotent - it names the state already showing - so the pin
  goes and nothing else moves. This was caught by the adversarial review (D-125), after the
  first implementation shipped the false OFF and this decision described it as safe.

  **What was deliberately left for Rocket.** #73 says whether a press should also *refuse* or
  *confirm* when it is about to break a pin "is a UI question for Rocket". It was not decided
  here. A Stream Deck press is one event with no room for a dialog, and a refusal would make
  the deck stop doing the obvious thing; the log line and the `held` feedback make it visible,
  which is the part the ticket required. **Open for Rocket.**

- **D-121 (2026-08-29)** **`confirmed` gets two feedbacks, not one, and a write publishes from
  its own response.**

  Section 7 says it plainly - "clients that care check `confirmed`, not the status code" - and
  the module keyed nothing off it. A Stream Deck could show ON AIR in full colour with the
  physical lamp dark.

  **Two feedbacks because they are two faults with two different fixes.** `confirmed:
  "unknown"` is the server admitting it has no evidence: the panel is unreachable or frozen,
  and the fix is at the panel. `confirmed` naming a different row is the device holding
  something nobody asked for, and the fix is finding the second writer. Merging them would put
  a dead panel and a supervisor re-assertion behind one lamp.

  The module now also **publishes from the write's response body** instead of waiting for the
  stream to echo it. The server answers a state write with the full status body *after* the
  write and *after* the light attempt, so `confirmed`, `hold` and `source` are already in
  hand. On a press that fails to reach the lamp this is the difference between the deck showing
  the fault at once and showing it whenever the next event happens to arrive.

  Driving the *state* feedback off `confirmed` was rejected: `state` is what the operator
  asked for and `confirmed` is evidence about the device (D-93). A button that lit only once
  the lamp acknowledged would go dark during every normal re-assertion gap, which reads as a
  failed press.

- **D-122 (2026-08-29)** **The generated presets carry the connection marks, and the reserved
  row's appearance is the owner's.**

  Every generated preset carried exactly one feedback, `state_is`. `connection_lost` and
  `no_data` existed and were attached to nothing an operator drags out of the box - so the
  **default configuration did not meet the client contract the module was rebuilt for.**
  Section 3 condition 2 requires a visible connection-lost mark, and a shipped deck had none
  until somebody hand-wired it.

  Both marks now sit on every state preset, **after** the row's own colours, because later
  feedbacks win: dark-because-dead must never be painted over. The pin badge sits between
  them, so a pinned button still reads as its own state and gains a `PIN` line, but a pin can
  never hide an outage.

  And the reserved row's presentation is now **read from the table** rather than hardcoded. The
  old `view()` returned a literal `'NO DATA'` and the `no_data` feedback defaulted to a magenta
  literal that happened to match the seed `unknown` row rather than being derived from it.
  Section 1 fixes only that the row exists, cannot be deleted, and is `busy: true`; its label
  and colours are freely editable. An owner who relabels `unknown` to SERVER GONE now sees it
  on the Stream Deck like everywhere else.

  One line of v1 residue went with it: `label: row?.label ?? s.label ?? ''`. Presentation left
  the state payload in D-42, so the fallback could never fire while reading as though labels
  still travel with state.

- **D-123 (2026-08-29)** **A write that runs out of time is an unknown outcome, not a failure,
  and the ceiling clears the measured worst case.**

  The write timeout was `AbortSignal.timeout(5000)`. Issue #68 measured, against a panel that
  was powered off, `POST /state/{id}` blocking for **6.4 s** and `PUT /state` for **13.2 s** -
  and **both writes succeeded**. So with the panel unplugged, a press aborted at 5 s, logged
  `set state failed`, and dropped the whole instance to `ConnectionFailure`, while the state it
  had asked for was live on the server and visible in the admin console. The button said the
  write failed and the write did not fail.

  20 s, as configuration. A timeout is now logged as a warning that says the write may have
  landed and the next poll will settle it, and it **does not touch the instance status**.

  **It does not retry.** The write may well have succeeded - both of #68's did - and a retry
  against a server that latches is a second write for no reason.

  Fixing #68 in the server instead was rejected as a dependency: #68 is real and worth doing,
  but any panel on a slow or lossy link reproduces this, and a client whose timeout is shorter
  than the server's own worst case is wrong on its own terms. The 5000 on `GET /config/states`
  was left alone deliberately - it is a plain read of a JSON file and #68's numbers do not
  implicate it.

- **D-124 (2026-08-29)** **Night mode was not built, and that is the decision.**

  #85 (`POST /device/night`) and #86 (the Stream Deck buttons) are the only tickets in the
  Companion track that depend on anything, and #85 says in its own text: *"This is the only
  part of night mode that reaches the wire, and it may not be worth it... Do not build this
  without Rocket saying yes."* It is also blocked by #79, which is unbuilt.

  Building the module half without the server relay would put a button on a Stream Deck that
  drives nothing, and teaching the module the panel's address instead would put a second device
  registry in a system that deliberately has exactly one - and would need the panel's basic-auth
  credential, which D-17 keeps separate from the passphrase and D-79 refuses to disclose.

  So the module ships with no night surface at all, and `docs/companion-setup.md` says so
  rather than leaving its absence to be discovered. **Open for Rocket:** whether the relay is
  worth an endpoint, a driver method, a status field and a module feedback, given that the
  cheaper answer - the panel-local Night bar in #81 - costs none of them. The case for is that
  the CrowPanel has no working touch (the GT911 sits in reset behind the PCA9557), so there is
  no way to darken it from the room it is in.

- **D-125 (2026-08-29)** **The rebuilt Companion module was reviewed adversarially by five
  independent lenses, and the review found a false OFF that the module's own comment and
  D-120 both described as safe.**

  Five review agents (contract compliance, async lifecycle, ticket coverage, test quality,
  Companion 1.14 semantics) raised 31 findings; each went to two skeptics told to refute it
  and to default to refuted when uncertain. Four survived both. **The gate was not treated as
  the verdict** - several refuted findings were fixed anyway, on evidence, and one confirmed
  suggestion was implemented differently from what the reviewer proposed.

  **The critical, and it was reproduced rather than argued.** `release_hold` wrote
  `POST /state/<held>?hold=0`. `POST /state/{id}` always sets the row named in the path, so
  whenever `state !== hold` the press moved the light. That divergence is not an edge: the
  PIN RULE's carve-out creates it deliberately. Pin `interruptible` (busy false), let the
  detector escalate to `on-air` (busy true, pin survives), press UNPIN mid-call - and the lamp
  went to INTERRUPTIBLE while the camera was live. Two lenses found it independently; one
  drove the real `StateStore` and captured `driver.set('interruptible')` as the third call.
  **The fix is to write the current row**, which is idempotent. The regression test was run
  against the old code first and fails on the line `AND THE LIGHT DOES NOT MOVE`.

  **What the skeptics refuted and was fixed anyway**, because a written contract clause or a
  measurement outranks a vote:

  - **A row the module has no entry for rendered as an empty label.** Section 6 is explicit:
    a renderer handed an unknown `id` "must draw the `unknown` appearance... it must never
    silently drop it - a state that degrades to nothing looks exactly like a calm one." An
    empty caption *is* that silent drop.
  - **`state_is` was a visual no-op.** The generated preset's base style and its `state_is`
    style were the same two colours, so a deck of five buttons looked identical whichever row
    was current - while the comment claimed the row was "dimmed when it is not the current
    state". The base is dimmed now, so the feedback has something to be brighter than.
  - **Overlapping polls could ingest out of order.** The write timeout is several poll
    intervals long, so two polls could be in flight and the second answer first - the first
    then overwriting fresh state with stale state. On a system whose cardinal sin is a false
    OFF, that is not a race worth leaving open.
  - **Literal `\n` in button captions.** `parseEscapeCharacters` in `@companion-module/base`
    is documented as applying to action and feedback *option values*, not to preset button
    text, so `PIN\\nAVAILABLE` would draw the two characters. Real newlines now, including in
    the `REFRESH\\nTABLE` preset that shipped that way in #44.

  **What was measured and NOT fixed.** A reviewer asked whether returning from `fetch()`
  without consuming `res.body` leaks sockets on the 401 and non-ok paths. Measured: 150
  unconsumed 503 responses, peak two sockets, byte-identical to the same run with an explicit
  `body.cancel()`. undici drains them itself. No code was added for a leak that does not
  happen.

  **The review mutated the working tree while it ran.** The agents were given the default tool
  set rather than a read-only one, and the test-quality lens injected 400 ms delays into the
  fixture and wrote seven probe scripts into `companion-module/test/` to run real mutation
  experiments. It cleaned up after itself and the module source was never touched, but that
  was luck rather than design: **a review fleet should be read-only**, and the next one will be.
  Its rigour is not in question - the probes are what reproduced the critical.

  Four of the 67 agents died on an unrelated API error. A dead skeptic returns null and the
  surviving vote decided those findings, which is a second reason the gate was not taken as
  final.

- **D-126 (2026-08-29)** **The hold is retired. Every write with a valid body is applied, and
  the last one wins.**

  **Supersedes D-19, D-21.2 and D-32's PIN RULE; retires D-49 and D-120.** `judgeWrite()`, the
  `hold` field, the `?hold=` parameters, the `human:hold` source value and every `403` and
  `409` a state-write route could produce all go. D-32's BUSY RULE is untouched - it never
  depended on the pin, and it is still the thing that keeps a stale calm state off the glass.

  **The workflow the pin was built for is not Rocket's.** His is: the detector drives the
  light; he overrides by hand mid-meeting when he wants something else on the glass; when the
  meeting ends the detector's `available` lands and puts him back. A pin does the exact
  opposite - it exists so the detector's end-of-call write loses. He has never wanted one, and
  `~/.onair/state.json` on the live host reads `"hold": null`. An unused feature that silently
  changes what a write means is a liability, not an option: the next person to trip it will be
  debugging a light that will not move, in a system whose entire job is moving the light.

  So section 3 of the contract gains a positive rule rather than a hole. **LAST WRITE WINS:
  every write with a valid body is applied, no `source` outranks another, no earlier write can
  block a later one, and the server keeps no memory of who wrote last beyond the `source`
  string itself.** Stated positively on purpose. An absence is not a contract, and the next
  reader of D-19 or D-32 would fill it back in with precedence.

  **What is genuinely lost, named rather than buried.** Pinned at a `busy: true` row, an
  `auto:` write to a calm row was refused and the light stayed ON. That was real false-OFF
  protection and it is being removed deliberately. Its scope was always narrow - it needed a
  human to have explicitly pinned at a busy row, it protected only against a detector that was
  already wrong, and after this the detector is the sole authority by design - but it existed.
  This is not a purely subtractive change and the record should not pretend otherwise.

  **Against that, three false-OFF paths go, and the adversarial review reproduced each against
  the real `StateStore` rather than arguing it.**

  - **The pin turned a contract-mandated retry into a false OFF, mid-call.** The client guide
    tells every automated writer to re-send until `confirmed` matches. Pin at `available`, the
    meeting starts, the detector writes `on-air` - allowed by the carve-out. The light is
    unreachable for a beat, `confirmed` never matches, so the writer re-sends the byte-identical
    body. Now `movingToBusy` is false, because the current state is *already* busy. Measured:
    `409`, and the settle-back drove the light back to the held row - `driver.calls
    ['available','on-air','available']`, `intended: off`, camera live. Worse, the guide's own
    published writer read that `409` as success and stopped retrying. The carve-out protected
    the first escalation and then punished its retry.
  - **The `403` fired before anything read `current.hold`**, so it was live on this host with
    no pin set anywhere. Measured against the running daemon: `PUT /state
    {"state":"on-air","source":"auto:vcrec","hold":false}` -> `403`, and the state change
    discarded. An escalation thrown away because of a field name.
  - **D-125's reproduced false OFF was still reachable**: pin `interruptible`, let the detector
    escalate, press UNPIN mid-call, and the lamp went calm with the camera live. The Companion
    module carries a hand-written guard and a regression test that exist only to apologise for
    it.

  **The carve-out was a mitigation OF the pin, not a protection the pin provided.** Contract
  section 3 says the escalation carve-out exists so a pin cannot force calm against a live
  camera, and D-49's settle-back exists so a refusal does not leave a false ON standing. Both
  are repairs to damage the refusal path does. Delete the refusal and the hazard and its two
  repairs leave together. D-49's closing line - *"the pin is what the system falls back TO, not
  merely a veto"* - describes that repair, and on a careless read makes this change look like
  removing a false-ON guard. It is not: it removes what the guard was guarding against.

  **A stray `hold` is IGNORED, never rejected, and this deliberately overrides the repo's usual
  dislike of a silent degradation.** A `400` would discard the state write, which is the exact
  failure this system exists to prevent, arriving through a field name - and the guide
  published `POST /off?hold=1` as a copyable example, so refusing it would leave the light
  asserting ON AIR after the meeting ended. Three senders are known: the admin console (ships
  with the server), the installed Companion 0.2.0 (a separate artifact on another host that
  this commit does not update), and whatever a human wired from that guide line. VCREC is
  external (D-30) and cannot be edited in lockstep. The rule, stated once: **a retired rider
  must never veto a state assertion.** The usual "a typo must not be silent" instinct does not
  reach this case - it is scoped to the *state value*, where accepting an unknown id could
  render calm, and a stray `hold` carries no state semantics at all. What loudness there is goes
  somewhere it cannot cost an escalation: an explicit accepted-and-ignored sentence in both
  documents rather than a quiet omission, and the read-back the contract already mandates,
  where a client that pins and reads its own `200` back sees no `hold` in it. The server itself
  says nothing - `hold` simply joins every other unknown body key, so no branch anywhere in
  `server/src` names it. **Open:** the safety review wanted one dated `log()` line naming the
  field on any write that still carries it, on the grounds that VCREC is a black box and phone
  Shortcuts are invisible, so a sender we cannot enumerate is otherwise undiscoverable. It was
  not built. The counter-argument is the decoy principle applied to source instead of to the
  wire: a branch that names `hold` keeps it alive in the server for ever. Revisit if a stray
  sender is ever actually suspected.

  **`hold` is deleted from the wire, not nulled.** No tombstone in `GET /status`, the state
  object, the SSE frames or the persisted file. The contract already makes this argument
  against itself, about the retired `stale` field: *"a field still called `stale` beside the
  real thing is a decoy the next renderer keys on."* A permanent `hold: null` is that decoy,
  and admin-ui's four null comparisons on `liveStatus.hold` are the proof it is not
  theoretical - drop the field and every one of them flips, so the console would render
  "Release pin" and "pinned" for ever, asserting a regime that cannot exist. A `hold` key in an
  existing `~/.onair/state.json` is dropped at the load boundary and never re-written:
  `loadState` builds a fresh object literal and validates only
  `updatedAt` and a resolvable state, so an unknown key cannot quarantine the file or take the
  supervised daemon down on restart. That is the one thing standing between this change and
  the light on the wall, so it has its own test.

  **`auto:` and `human:` survive as PROVENANCE, with no authority difference.** `judgeWrite`
  was the only place in the entire server where `source.kind` changed behaviour, so with it
  gone the prefix decides nothing. Kept anyway, unchanged: required and prefixed on
  `PUT /state` with its `400`, optional on the convenience routes. `source` is the only trace
  the external detector leaves (D-30), four renderers display it, and changing the shape of a
  required field is a breaking wire change to a client this repo cannot edit, for no gain. But
  the rule's written justification - *"an automated writer that forgot the prefix would
  silently get human authority and break the owner's holds"* - dies with the thing it named,
  and a rule whose only stated reason has gone is a rule the next reviewer correctly deletes.
  So the documents now say it outright: **nothing a `human:` source may do is denied to an
  `auto:` source. The prefix is provenance.**

  **The `409` semantics invert, and there is no deprecation mechanism to stage it behind.**
  There is no URL versioning, and the contract is written to be implemented against by someone
  who is not reading our source, so the only honest mitigation is a dated removal note in both
  documents. Until today a `409` could mean *"the pin decided; read the merged status body and
  carry on"*. The pin's two refusals, the `409` and the `403`, both went through `refuseWrite`,
  which was the only place in the entire server that merged a status body into an error - so
  after this, **no 4xx carries a status object at all**, and the guide's advice to branch on
  the shape of a `409` describes a distinction that no longer exists. Now every `409` is
  `{"error":...}` and every one means a person has to change something: an
  unset `/on`/`/off` shortcut row, a stale config `version`, a save that failed for a reason
  other than disk-full, or a rebind that rolled back. **`403` becomes admin-only** -
  `POST /admin/restart` with no passphrase configured, `POST /admin/factory-reset` without the
  admin password. D-118 rewrote these same error rows yesterday because they were wrong; both
  replacement cells were re-derived from the source rather than from memory, for the same
  reason.

  **The one place `403` must NOT be tidied away** is the client guide's `400|401|403)` case
  arm. `403` is still real on the admin surface, and dropping it there sends it to the `*)`
  lane, which the example treats as transient and retries - turning a documentation edit into a
  retry loop against a never-retryable code. The arm is unchanged. `409` gained an arm of its
  own into the same never-retry lane, because the published example reported a `409` as
  **success**: after this change the only `409` a write route can produce is an unset shortcut,
  which means the light did not move, and swallowing that would be a fresh false OFF inherited
  from the old text rather than fixed by the change that exposed it.

  **The Companion module goes 0.2.0 -> 0.3.0, and that one is a breaking change with manual
  work attached.** The `pin_current_state` and `release_hold` actions, `set_state`'s Hold
  option, the `held` and `held_to_this_state` feedbacks, the `$(hold)` / `$(hold_label)`
  variables and the PIN/UNPIN presets are all gone - the whole surface D-120 added. Regenerating
  presets does not touch buttons a human has already placed, so any placed button bound to one
  of those is orphaned and has to be re-bound by hand. `npm run package -w companion-module` is
  not part of `verify`, so the tarball was built explicitly; until Rocket sideloads it, the
  Companion host keeps running 0.2.0 and keeps sending `?hold=1|0` from its PIN/UNPIN buttons.
  That surviving external sender is exactly why the server ignores a stray `hold` instead of
  rejecting it.

- **D-127 (2026-08-30)** **The gate's flakes are fixed by waiting for the property, not by
  widening the window.** Two server tests asserted "the timer keeps firing" as a fixed
  `sleep` followed by a count - `sleep(70)` then `>= 3` on a 20ms hub, and `sleep(200)` then
  `>= 3` on a 25ms re-assert. Both encode a property as a race against the scheduler, and the
  scheduler wins often enough to matter: measured on rocket-studio-m1 at **load average 164**,
  from OBS, OBSBOT Center, Dante Virtual Soundcard and X32-Edit - Rocket's ordinary studio
  setup, not an agent workload - `sse.test.ts` failed one run in five, and two consecutive
  `npm run verify` runs failed on a different one of the two tests each time.

  That is worse than an annoyance because this project has **no CI by design**, so `verify` is
  the whole discipline. A gate that goes red for reasons unrelated to the change trains you to
  re-run instead of read, and the run where it bit was the one verifying a system-wide contract
  change - exactly when a spurious red is most expensive, and when "unrelated flake" and "I
  just broke the suite" look identical at a glance.

  `server/test/wait-for.ts` polls to a generous deadline. **The deadline is not a timing
  assertion**; it is the point at which "not yet" becomes "never", and tightening it to
  something that looks like the expected duration puts the margin straight back. Both
  alternatives were rejected on the ticket and stay rejected: raising the sleep trades
  flakiness for a slower suite and only moves a threshold that is still fixed against a load
  that is still unbounded, and lowering the assertion to `>= 2` weakens the test to fit the
  flake when two events do not demonstrate "keeps firing".

  **Proven by mutation rather than by assertion**, which is the part worth keeping: a heartbeat
  stubbed to deliver one beat and stop still fails (`got 2`), and a supervisor that refreshes
  `lastAssertAt` on `read()` too - the exact regression that test's own comment warns about -
  still fails (`got 0`). Then 20 consecutive runs of the 326-test server suite, all green,
  while load climbed 150 to 217.

  **One sleep stays, on purpose.** `sse.test.ts` asserts that nothing further is written after
  `closeAll`. That is an ABSENCE, and an absence cannot be polled for; a slow machine only
  makes it pass more easily, which is the safe direction. The rule this establishes is
  narrower than "no sleeps in tests": **do not sleep and then assert that something HAS
  happened.** Sleeping and asserting that something has NOT happened is sound.

  **The population is bigger than the two.** A sweep of `server/test/` found roughly ten more
  sites with the same shape - `sleep(40)` then `assert(sets.includes(...))` and similar,
  mostly in `supervise.test.ts`. None fired in 20 runs at load 217, and none is in #89's
  scope, so they are filed rather than swept up here. Widening a fix past its ticket is how a
  test suite gets rewritten by accident.

- **D-128 (2026-08-30)** **One SSE hub serves two audiences, so `broadcast` carries no payload
  at all.** `SseHub` fed both the gated `/events` and the unauthenticated `/public/events`.
  `attach` took a per-connection snapshot function and was always right; `broadcast` took one
  body and wrote it to everyone, and the body it was given was the gated one. Verified on the
  live daemon before the fix, on an unauthenticated stream from the LAN:

  ```
  connect: {"state":"available","label":"AVAILABLE","color":...,"bgcolor":...,"busy":false,...}
  change : {"state":"available","confirmed":"available","source":"human:anonymous",
            "updatedAt":"2026-08-30T22:48:20.602Z","message":null,"busy":false,
            "intended":"off","ageSeconds":0,"tableVersion":11}
  ```

  Two faults, and the second is the one that mattered to a person. **Disclosure:** `source`,
  `confirmed`, `updatedAt` and `intended` reached any LAN client, which is the opposite of what
  `docs/api-contract.md` section 8 says in as many words. D-27 and D-35 accepted disclosing
  *presence*; they did not accept disclosing who wrote it and when. **Presentation:** the change
  event has no `label`, `color` or `bgcolor`, so `/display` fell back to the raw state id in
  the reserved row's colours and showed **"ON-AIR" in magenta on near-black for up to 15
  seconds after every state change**, until the heartbeat repainted from `snapshot()`. On the
  renderer whose entire job is to be trustworthy at a glance.

  The fix is not "pass the right body". `broadcast()` now takes **nothing** and renders each
  client from the snapshot closure it attached with, which is the mechanism the heartbeat has
  always used. There is no longer a body for a caller to get wrong, so the two audiences cannot
  drift apart again - and there were three call sites passing two different shapes
  (`statusBody(deps)` in `server.ts`, `store.status()` in `app.ts`), which is how one of them
  was wrong without anyone noticing.

  **Why no test caught it:** the existing coverage read only the FIRST event on the stream,
  which is the per-connection snapshot and was correct. The new test asserts the exact key set
  of a CHANGE event rather than a forbidden list, because a forbidden list only catches the
  leaks somebody thought of and this was four nobody had. It is red against the pre-fix source.

  This was **pre-existing**, found while verifying the contract against the code during D-126.
  The pin work only deleted a redundant `hub.broadcast` standing next to it.

- **D-129 (2026-08-30)** **The supervisor logs edges, because the driver already does.**
  `[supervisor] device state agrees but the panel is not repainting` fired unconditionally
  inside a tick scheduled at `pollMs`, 5000 by default - so a frozen panel wrote the same
  unstamped, unattributed string 720 times an hour. That is the census D-109 took of the driver
  (1133 lines, 1127 of them two repeated strings) reappearing in a second component; D-109
  fixed the driver and left this line alone.

  One stamped line naming the host on the way in, one on the way out carrying how long the
  glass was still and how many ticks reported it, in `esphome-driver.ts`'s `BACK after 3s and
  45 failed calls` shape. Steady-state repeats are **dropped, not rate-limited** - D-109's
  argument is unchanged: the second identical line says nothing the first did not, and the
  recovery line's count says it better. A flapping panel still logs per transition, because
  alternating results are a different fault from a dead one and must not read like one.

  **A `null` reading is not recovery.** `repainted()` returns `true`, `false` or `null`, and
  `null` is "cannot tell yet". Only `true` clears the edge. Treating no evidence as recovery
  would log a panel back to a health it never reached, which is a lie in the one place a person
  goes to find out what happened. There is a test for it.

  `stamp()` and `humanMs()` move to `server/src/log-format.ts`. Two copies of `humanMs` would
  have drifted, and the comment explaining why only edge lines are stamped - rather than the
  sink, which is the better log and a much larger change - belongs with the functions.

- **D-130 (2026-08-30)** **A write always waits for the light. It just stops waiting on hosts
  already known to be dead - and the version nudge is not the write's business.** Rocket's call
  on #68 was candidates 1 and 2, with candidate 3 (answering before the light is attempted)
  dropped permanently so that the simple story survives.

  **The defect was never the latency on its own.** Every write and every supervisor tick share
  one queue (`app.ts`); against an unplugged panel a write's own device work measured 6.4s;
  and both the supervisor (5s) and the detector (~5s, D-90) arrive faster than that. Arrivals
  outpaced drains and the queue grew for as long as the panel was away.

  **The nudge comes off the write path.** It was 2 of the 6.4 seconds, for something its own
  docstring calls advisory and that the device re-pulls on its own interval regardless. It
  still reaches the device on the two paths that own it: `applyConfig` nudges the moment the
  table changes, and the supervisor re-nudges on its tick when that one did not land. A table
  edit is delayed by at worst one poll, never lost. The supervisor nudges on **every** tick and
  lets the driver dedupe, and that coupling is load-bearing: `EsphomeTextDriver` returns without
  touching a socket when the version has not moved, and deliberately does **not** cache a
  version it failed to send. A supervisor that deduped on its own side would send a failed
  nudge exactly once and leave the device on an old table with the server believing it had been
  told. It has its own test now, because the next reader will otherwise "optimise" it.

  **A failing host is left alone for 15 seconds.** `DEFAULT_REPROBE_MS = 15_000` is three
  supervisor polls at the 5s default, which is what turns "every tick pays the ladder" into
  "one tick in three does". Measured against a black-hole host (accepts the connection, never
  answers) with the shipped constants:

  ```
  before   set() -> 4411ms, 4404ms, 4410ms, 4403ms, 4406ms
  after    set() -> 4402ms,    0ms,    0ms,    0ms,    0ms
  ```

  **The first call still pays in full, and that is not hidden.** Somebody has to discover the
  host is dead. In service that discovering call is a supervisor tick, not a write, so the
  ticket's "a write returns in under 1s" holds for every write that arrives after the panel has
  already been noticed missing - which is all of them in the case the ticket describes. The
  guard is on the whole `attempt`, not on each retry inside it: `retries` exists to survive one
  dropped request, and a breaker that ate the retry would trade this defect for a worse one, a
  healthy panel written off for a single lost packet.

  **The cost is named rather than buried:** a panel that comes back is not noticed here for up
  to 15s. That is affordable only because the panel does not depend on this path to recover -
  it polls the server for state itself and re-pulls the table on its own interval. The window
  delays the SERVER learning the panel is back; it does not delay the panel.

  **Skips are counted and never logged.** A line per skipped call is D-109's flood wearing the
  opposite label. The count appears once, on the recovery line: `BACK after 1s and 16 failed
  calls (340 skipped while it was down)`.

  **The test asserts queue depth, not wall time**, and `App` grows a `writeQueueDepth()` for it.
  Wall time is the thing a machine at load average 200 ruins, and the queue is the actual
  defect. With the skip window disabled the same test reaches **depth 8**; with it, 2. The
  writes are fired on a timer rather than awaited one at a time, because awaiting each would
  make the queue trivially shallow and the test would pass against the bug.

  **The live log says what this costs in practice, and it is worth Rocket's eye.** The daemon's
  own history on 10.42.14.239 is dominated by short blips - `UNREACHABLE ... BACK after 5s and
  1 failed call`, several times a day, with one 8m 37s outage in the record. A flat 15s window
  turns those 5s blips into roughly 15s before the server notices the panel is back, so
  `confirmed` reads `unknown` for three times as long on the most common failure this device
  actually has. Nothing false is reported and the light itself is unaffected - the panel holds
  its own state and polls the server - but the "not confirmed" mark in the Companion module and
  the admin console will linger longer than it used to. A backoff (probe soon after the first
  failure, back off as the outage persists) would get both, and was NOT built: it is a second
  constant and a second piece of state for a cosmetic gain, and the flat window is the thing
  the ticket asked for. If the lingering `unknown` turns out to annoy, that is the change.

  **Two existing driver tests take `reprobeMs: 0`**, which disables the window. Both walk a host
  down and back on consecutive calls and are about the failure log's edges rather than about
  this; with the window on they would be measuring the breaker instead. The window's own
  recovery behaviour is covered in `server/test/write-latency.test.ts`.

- **D-131 (2026-08-30)** **`confirmed` stops describing pixels nobody can see, and the reason
  goes on the wire.** #82 and #83, landed together with the two surfaces they would otherwise
  have broken.

  **The bug was live, nightly, and had been since D-114.** The panel goes black 23:00-07:00,
  and through all of it the server reported `confirmed: on-air`. Turning the backlight off
  changes nothing the server can see: the display lambda keeps running, `id(frames)++` still
  executes on every path, and `repainted()` reads a healthy advancing counter. So the old
  definition - `unknown` when the light is unreachable **or the panel is not repainting** -
  was insufficient in the most literal way, because **a dark panel is still repainting**.
  `supervise.ts` has carried the line `// confirmed must describe PIXELS, not a variable.`
  through all of it.

  **Not blocked by #79, which is why it could be done today.** #82's dependency was *"the panel
  publishes a `Night` text_sensor (from #79)"*, and #78 already shipped that sensor. It is live
  on the panel now: `GET /text_sensor/Night` answers `lit (daytime)`, and `glassDark()` was run
  against the real device before this landed rather than only against a fixture.

  **The dark test runs FIRST in the tick, and that is not a style preference.** A dark panel
  passes the repainting test, so the branch placed anywhere later is dead code and the server
  goes on claiming a confirmation. Proven by mutation: disabling the branch turns three tests
  red.

  **`confirmedReason` is an optional additive field, not a new `confirmed` value.** Values
  `asleep` | `not-repainting` | `unreachable`, absent when the server cannot name one. The
  precedent is `stateResolvedFrom` in the same object. `confirmed` keeps its type and its
  domain, so every deployed client keeps working unchanged - which is load-bearing rather than
  polite, because Companion buttons are already placed on a physical Stream Deck and D-126 has
  just finished orphaning a set of them.

  **Three, not two.** A surface that cannot tell *dark on purpose* from *broken* alarms every
  night; a surface that cannot tell *gone* from *frozen* is not worth reading. The alternative
  - keep it all server-side and off the wire - fails on the Companion module, which is a
  separate process that only ever sees the wire and is the surface with a physical lamp on it.

  **ALL FOUR SURFACES OR NONE, and this is the part that decided the scope.** Landing the
  server half alone would have appended *"light says unknown"* to the admin console's tally,
  painted its Confirmed row yellow, and lit `light_not_confirming` on the deck from 23:00 to
  07:00 - every night, about a panel that is working perfectly. #82's own text says a feature
  that does that is worse than not having it. So the console, the module (0.3.0 -> 0.4.0, a new
  `panel_asleep` feedback and a `$(confirmed_reason)` variable), the contract and the client
  guide all moved in the same commit.

  **ABSENCE IS NOT REASSURANCE**, written into the contract and tested in all three consumers.
  The field is omitted whenever the server cannot name a reason - including in the gap between
  a write and the supervisor's next tick - and reading that as "fine" would be a **false OK**,
  which fails the same way a false OFF does. Each consumer has a test that an unexplained
  `unknown` still alarms.

  **The setting is device-local; the consequence is contract.** The schedule itself - times,
  enable, brightness - stays on the panel's own page, following D-111. But `confirmed` is
  already on the wire, so what sleeping DOES to `confirmed` is on the wire too. A client never
  learns when the panel sleeps, only that it currently is. That distinction is #83's answer and
  it is now written down rather than inferable.

  **Two cross-component guards, because this is a server constant matched against a string in a
  YAML lambda.** `NIGHT_DARK` is read out of `onair-core.yaml` by a test and asserted to be
  emittable, and exactly one Night verdict may mean dark. Renaming it in the firmware alone
  would not fail a build - it would silently report every dark panel as lit, restoring this
  bug. Same shape as the freeze-threshold guard, same reason: D-106.

  **The 404 is caught before the retry.** Firmware older than #78 has no `Night` sensor.
  `getJson()` routes any non-`ok` response into `attempt()`, which retries and then calls
  `unreachable()` - so the obvious implementation would have logged a permanent UNREACHABLE
  edge about a perfectly healthy panel, and #68's skip window would then have stopped talking
  to it. It is latched instead, one line and then silence, copying `setTableVersion`'s
  `versionEntityMissing`.

  **`/display` needed nothing**, and that is worth recording rather than re-deriving: it feeds
  off `/public/events`, which carries no `confirmed` at all (D-42). It is structurally immune.

  **The `Frames` coupling is now documented in the contract**, having been load-bearing and
  undocumented outside D-106. The server infers "is the panel repainting" from a counter the
  firmware increments; firmware that stops incrementing it makes every healthy panel read as
  frozen, and firmware that increments it while showing nothing makes a blank panel read as
  confirmed - which is precisely this bug.

- **D-132 (2026-08-30)** **A read may be skipped. A write may never be.** An adversarial review
  of the *deployed* D-130 and D-131 found two confirmed defects, both mine, both shipped. This
  records the fix and the rule that should have been written down first.

  **THE REGRESSION.** D-130's skip window keyed on `failingSince`, which means *"the last call,
  on any entity, failed once"* - it is the LOG's edge flag, and it is armed by the three
  callers that have no retry ladder at all (`setTableVersion`, `glassDark`, `verifyEntity`).
  Using it as a traffic gate meant **one dropped packet silenced the driver for 15 seconds**,
  and `set()` was gated with everything else. Reproduced against a panel that swallowed two
  packets once and was healthy thereafter:

  ```
  2. blip write:   unknown | 4409ms | device holds on-air
  3.0 write:       unknown |    1ms | device holds on-air | requests reaching the device: 0
  3.4 write:       unknown |    0ms | device holds on-air | requests reaching the device: 0
  ```

  Five writes to a live panel, nothing on the wire, the panel still showing the previous row.
  If the swallowed write is the one turning the light ON, **that is a false OFF** - D-6 and
  D-63, the invariant the system exists to protect. It was not an emergency only because the
  firmware polls `GET /status` itself and drives `presence_key` from it, so the glass
  self-corrects in about a second. **That redundancy was load-bearing and nobody had written it
  down**; it is not a licence to drop writes.

  **THE RULE, which is the durable part.** Every other call in the driver is the server
  *learning* something and can wait fifteen seconds. `set()` is the server *changing* something.
  A skipped read costs knowledge that is re-acquired on the next tick; a skipped write costs
  the light. So: `set()` is never gated, and only an **exhausted retry ladder** - `attempt()`
  running out of tries - is evidence a host is dead. `deadSince` is now that evidence and is
  separate from `failingSince`, which goes on logging exactly as D-129 left it.

  **The latency criterion #68 asked for is given up, deliberately.** "A write against a
  black-hole host returns in under 1s" was only ever true because writes were being skipped,
  and a fast write that never reaches the panel is not a fast write. A write pays its full
  4.4s ladder against a dead host again. **The feedback loop #68 was actually about survives
  this**: it was the SUPERVISOR's polling, ticking every 5s against a ladder that outlasted the
  interval, and that is still skipped. With the nudge already off the write path (D-130), a
  4.4s write against 5s arrivals drains rather than grows.

  **THE SECOND DEFECT, in D-131.** `glassDark()` returns `null` when it cannot tell - correctly,
  and its docstring says guessing "lit" is the false confirmation the whole ticket exists to
  stop. The supervisor then guessed lit anyway: `if (dark === true) ... else if (got === settled
  && painting !== false) next = settled`, so a `null` fell straight through into a positive
  confirmation. One dropped packet on the Night sensor published **`confirmed: on-air` about a
  panel that was black** - D-131's lie, restored, by exactly the mechanism D-131 removed. The
  same blip armed the skip window, so the false confirmation was then held for the full 15s
  rather than corrected on the next tick.

  A `null` now HOLDS the last real answer, the same discipline `confirmed` itself already uses
  for a single blip. It starts `null`, so a driver that has never read the entity - old
  firmware, no such sensor - behaves exactly as before. If a reading is ever held forever it is
  held at `unknown`, which is an admission of ignorance rather than a claim.

  **What this says about the process, and it is the reason this decision is written at length.**
  Both defects were in code that had passed `npm run verify`, passed a mutation check on the
  behaviour it was written for, been measured against the real panel, and been deployed. **The
  tests encoded the bug**: `write-latency.test.ts` asserted a sub-second write against a dead
  host, which is the symptom of the defect stated as a requirement. Two existing driver tests
  had to be handed `reprobeMs: 0` to keep passing, and that was the signal - a change that makes
  existing tests need an opt-out has probably changed something nobody asked it to. The review
  that caught it did what the mutation checks could not: it asked what the change did to cases
  the change was not about.

  All three fixes are mutation-proven. Restoring the `failingSince` gate, gating `set()`, or
  removing the glass hold each turns a named test red, and the third one prints the failure in
  the only words that matter: `confirmed went positive at some point: ["unknown","on-air","unknown"]`.

- **D-133 (2026-08-30)** **The night SCHEDULE stays device-local; the manual OVERRIDE goes on
  the wire.** #91, built end to end - firmware, server, contract, module - and flashed to the
  live panel.

  **The ask was "a Companion button to darken the screen and another to wake it", and the
  premise that it was already in the server was wrong.** The server had no night surface at
  all; it only *read* the `Night` sensor to decide `confirmed`. Everything below had to be
  built.

  **What already existed and was not it.** The panel has a bench override that sets the
  backlight to any level including 0 - but it **auto-releases after 120 seconds**, by design,
  as a trap-door for a closed laptop, and it is driven from the panel's own page where the
  server cannot reach it. A sleep is the same idea without the trap-door, plus a path from
  another room.

  **D-111 is narrowed rather than reversed, and the line is where the operator is.** The
  schedule - times, enable, brightness - stays on the panel's own page and appears nowhere in
  the API. The override is on the wire, for one reason: **the thing pressing it is a button in
  another room, and a setting nobody can reach is not a setting.** The contract now says this
  in as many words, next to #83's "the SETTING is not on the wire; the CONSEQUENCE is" - which
  survives unchanged, because `confirmedReason` is still how you learn what happened.

  **THE BUSY REFUSAL APPLIES TO A HUMAN PRESS, and that was not Rocket's call to make.** A dark
  panel during a live call is a false OFF, which is the invariant the whole system exists to
  protect (D-6, D-63). So `night_should_darken()` was restructured to put the two shared
  refusals - busy, and "the panel cannot say what is happening" - **first**, gating the manual
  path and the scheduled one alike. Verified on the real panel: with a sleep armed, a busy row
  arriving lit the glass and the `Night` sensor read
  `lit (sleep pending - busy or no data)`; the row going calm again put it back to `dark`.

  A manual sleep otherwise ignores `woken`. A state change wakes the SCHEDULE - that is what
  the latch is for - but a person who asked for the screen off has not changed their mind
  because the row moved.

  **Three ways it ends, and Rocket picked the middle one deliberately:** an explicit wake, the
  **scheduled wake time**, or a busy row. The scheduled expiry is an EDGE on the minute rather
  than a level test - a level test would re-clear the switch every tick for a whole minute, and
  would also stomp a sleep pressed deliberately at 07:00. It needs a clock, so a panel that has
  never heard SNTP keeps a manual sleep until somebody wakes it; that is the honest failure,
  and the alternative is guessing the time, which D-110 already refused.

  **`RESTORE_DEFAULT_OFF` on the switch is the fourth exit and the only one that survives a
  crash.** The other three all need something to still be running. A reboot is the case where
  nothing is, and a sleep that restored ON would bring a panel back dark with no clock yet and
  nothing due to clear it.

  **`delivered` is not "the glass went dark".** The route answers `200` with `delivered:false`
  when the panel is unreachable rather than a `5xx`, because a `5xx` tells a caller to retry a
  command that may well have landed. What actually happened arrives as `confirmedReason` on the
  next tick - which means the `panel_asleep` feedback built for the schedule in D-131 lights for
  a manual sleep too, with no extra work.

  **Two buttons, not one toggle.** A toggle has to know which way it is pointing and this one
  cannot: "asked to sleep" and "is asleep" come apart exactly when it matters, because the
  panel refuses while busy. The sleep preset wears the `panel_asleep` feedback so it reports
  the panel's answer rather than the press.

  **The supervisor's ASLEEP line lost the words "on schedule".** Since this, the glass can be
  dark for two reasons and the supervisor sees one boolean either way; a line naming the
  schedule would be wrong about half of them.

  **The flash checked the linked binary before shipping it**, which #87 established nobody had
  ever done - `esphome upload` ships `build/firmware.ota.bin` and does not compile, so checking
  codegen proves nothing. `strings` on the actual `.bin` found `PanelSleep` and both new log
  strings. Then the marker: `GET /switch/PanelSleep` was **404 before and 200 after**, `Frames`
  reset to 4, and it was re-checked for 120 seconds to clear #87's 60-second rollback window.

- **D-134 (2026-08-30)** **A sleep/wake toggle that asks the glass rather than remembering.**
  #92. Rocket asked for one button that darkens the panel and lights it again, having read
  D-133 and its "two buttons, not one toggle".

  **D-133's argument was right and does not reach this.** It was about a toggle that tracks its
  own presses, and that toggle really is broken here: the panel refuses a sleep while the row is
  busy, so the first refused press leaves the button believing the panel is asleep, and the next
  press sends WAKE at a panel nobody ever darkened. Nothing ever corrects it.

  **So the toggle keeps no state.** `POST /panel/toggle` calls `glassDark()` and sends the
  opposite. A refused sleep leaves the glass lit, so the next press still means sleep - the
  desynchronisation has nowhere to accumulate.

  **It gets the SCHEDULE right without knowing the schedule exists**, which is the part worth
  keeping. At 23:30 the glass is dark with the manual switch off; the toggle sends wake, which
  is what a human pointing at a dark panel means. A toggle that flipped the manual SWITCH -
  the obvious implementation, and the one that keeps D-111's schedule/override split cleanest -
  would send sleep, and nothing visible would happen.

  **Where it lives is the decision.** This is server-side, not module-side, and deliberately:
  the module has no fresh reading of the glass - only a poll that may be seconds old - and the
  server is one hop from the device. A module-side toggle would be the press-counting one
  wearing a disguise.

  **Unreadable glass is assumed LIT**, after falling back to the last published
  `confirmedReason`. That sends sleep, which is recoverable: the busy rule still lights the
  panel for a call, and one more press wakes it. Assuming dark would send wake at a lit panel,
  which presents as a dead button. Both directions are mutation-proven by named tests.

  `wasDark` is on the response and is `null` for `/panel/sleep` and `/panel/wake` - they never
  ask the glass anything, and reporting `false` there would be a measurement nobody took.

- **D-135 (2026-08-30)** **Wordless button art, and contrast that is measured rather than
  assumed.** #92. Rocket asked for graphics on the deck buttons, chosen by running six
  variations past a judge, and for a full set of word-only buttons beside them.

  **THE INTERRUPT BUTTON WAS UNREADABLE AND HAD BEEN SHIPPING THAT WAY.** Rocket reported it;
  the measurement is **1.23:1**. The row's ink `#1a1a1a` was chosen by the owner for the row's
  own amber `#e8a317`, where it is fine - but the button AT REST dims that background by `>>2`
  to `#3a2805`, a colour nobody ever chose ink for. `readableInk()` now keeps the owner's colour
  whenever it clears AA on the background in question and substitutes white or black when it
  does not, so D-31/D-42's "colours verbatim" survives everywhere it was ever true. A test
  measures **every** generated face - base styles and feedback overrides as composed - and
  fails the build below 4.5:1.

  **The art is generated from code, not pasted in as base64.** `tools/icons/` is a small
  rasteriser and a file of shapes; `npm run icons` writes `src/icons.js`. That is what makes it
  answerable: the ink is chosen by contrast against a background that comes from a table the
  owner can edit from the admin console at any time. Each icon ships twice - white ink and black
  ink - and the module picks at runtime, so one state button gets the right art on all THREE of
  its backgrounds: resting, lit, and the amber a `connection_lost` feedback paints over the top.

  **Six variations, judged blind, and the judging changed the result.** Six design languages
  (signals, broadcast, doors, geometric abstraction, human figures, public signage), each drawn
  and rendered onto the real button colours at true 72-pixel size, then scored by three judges
  with different lenses. Public signage won 7.87 to 5.83, unanimously. More usefully, all three
  independently found the same defect - `recording` was a ring with a dot and `unknown` a broken
  ring, two circular silhouettes adjacent on the deck differing only in detail a 72-pixel glance
  loses. Recording became the solid dot the transport symbol actually is; unknown left the
  circle entirely for a square that never closes.

  **The judges were overruled once, on purpose.** All three said the amber caution triangle for
  INTERRUPTIBLE reads "fault" rather than "you may interrupt". They are right. Four
  alternatives were drawn and looked at on the real amber: a knocking fist (an unreadable blob
  at 72), a half-lit disc (crisp, but ON AIR is a disc, so the confusable pair became the one
  pair that must never be confused), a door standing ajar (crisp, and the best semantic fit)
  and pause bars (says "paused"). **The door lost on which way it fails.** Misread, a door ajar
  says "come in, it is fine"; misread, a triangle says "careful". The cardinal sin here is a
  false OFF (D-6, D-63), so the icon that errs toward caution wins over the better picture.

  **Every row and every panel button generates TWO presets**, graphic and words, in parallel
  categories. Not a fallback - an icon is faster to read once you know it and useless before
  that, and which of those an operator is depends on the operator. A row this module has no
  icon for falls back to its words rather than generating a blank button, because the table is
  the owner's and they can add rows.
