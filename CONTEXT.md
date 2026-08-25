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
  entire safety axis - it defines `intended`, it is what the staleness rule is written over,
  and it is the one thing that can break a pin (D-31/D-32/D-33).
- **`order`** - a row's display sort hint. Presentation only. **Never on the wire, never an
  address** (D-31/D-34).
- **Profile refresh** - Rocket's phrase for the config pull: a renderer fetching the state
  table from `GET /config/states` on its own slow schedule (D-38). *"Profile" is a button
  label, not a domain word* - the thing itself is the **state table**. The rule it enforces
  (D-42): **presentation travels with the profile, semantics travel with the state.** `label`,
  `color` and `bgcolor` never ride on a state change; `busy`, `intended` and `confirmed` do.
- **Current state** - the operational level: a **reference to a row**, not a copy of one
  (Type Object). Stored as an `id`.
- **Hold** - a persisted **pin** on the current state, set by a `human:` source (D-32,
  replacing D-19's floor). While pinned, an automated writer may only escalate from a
  `busy: false` state to a `busy: true` one; nothing else moves it. Released explicitly by a
  human, never on a timer. The released regime is called **auto**.
- **`source`** - `kind:label`, where `kind` is `auto` or `human`. Wire contract, because
  under D-30 it is the only trace the detector leaves here. An absent or unprefixed `source`
  reads as `human:`.
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
  Neither does `dnd` as a shipped state. Banned in code and docs: `state machine`,
  `statechart`, `transition`, `guard`, `event`, `taxonomy`, `traits`; `select` and `option`
  are ESPHome transport words only.

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

> **Supersession index (2026-08-23).** On-Air v2 rewrote the state model. Read this before
> reading any decision below it - several are still written in a vocabulary the system no
> longer uses.
>
> | Decision | Fate |
> |---|---|
> | **D-5** contract v1 state model | **Amended** by D-31/D-32/D-33 and rewritten in `docs/api-contract.md` v2. `level`, `onAir`, `/on`, `/off` and the five hardcoded rung routes are gone. |
> | **D-6** no TTL / staleness visible, never acted on | **Intact in principle; its rule is restated** by D-32's BUSY RULE. No TTL, no decay, no auto-raise - all confirmed. |
> | **D-7** optional `ONAIR_TOKEN` | **Superseded** by D-35. Becomes the UI-configurable passphrase. |
> | **D-9** `/display` browser tally | **Intact**, but its appearances are now table-driven rather than four hardcoded ones. |
> | **D-10** `npx github:` distribution | **Amended** by D-15 then D-37. The `npx github:` path is formally retired; `deploy/get-onair` is the install path. |
> | **D-11** hand-rolled WebSocket | **Intact and deployed.** The zero-dependency rule that justified it was never a rule (D-29); the code is not revisited. Its feedback wiring survives v2 because of D-33. |
> | **D-12** light hardware on hold | Already superseded by D-16/D-18/D-21. |
> | **D-13** LaunchDaemon supervision | **Intact**, but the plist's `ProgramArguments` path changes once with D-37's layout, carried by `onair update`. |
> | **D-14** config-file-first install | **Amended** by D-36. `config.env` retires as the config source and survives as an env overlay; the plist still carries no `ONAIR_*`. |
> | **D-16** firmware in a separate repo | **Reversed** by D-28, implemented by D-37. Firmware moves to `firmware/`. The ESPHome `2026.8.0` pin and its warning survive. |
> | **D-17** device transport over plain HTTP | **Intact**, **amended** by D-38: the device entity moves from `select` to `text`. Basic auth stays mandatory and stays separate from the passphrase. |
> | **D-18** three-rung ladder | **Superseded** by D-31 (table), D-32 (busy rule), D-33 (`intended`). |
> | **D-19** hold as a floor | **Superseded** by D-32. Hold is a pin with one escalation carve-out. |
> | **D-21.1** reconciliation merges only on contradiction | **Intact in spirit**, restated over `busy` rather than rungs. |
> | **D-21.2** a manual write below the floor releases the floor | **Superseded** by D-32: a manual write naming a state other than the held one releases the pin. |
> | **D-22** ESP32 integration live and accepted | **Intact.** All three sub-findings survive; D-22.3 (a write is not confirmed by the next read) is re-verified against `text` in D-38. D-22.1's `Render` sensor gains a fifth branch in D-46. |
> | **D-23** `ONAIR_TOKEN` set on this host | **Superseded** by D-35. |
> | **D-24** loopback alone does not authenticate; `Origin` does | **Survives, unweakened**, and is cited verbatim by D-35. The two measured attacks stay as regression tests. |
> | **D-25** `/ui` and `/display` unauthenticated | **Amended** by D-35. `/ui` retires into the admin UI; the reasoning is restated as unauthenticated shell plus gated data. |
> | **D-26** SwiftBar, not a native app | **Survives**, confirmed. |
> | **D-27** one credential, no read/write split | **Carried forward** onto the passphrase by D-35, and sharpened: the split that *does* exist is machine credential vs human admin credential, which is a different axis. |
> | **D-30** the detector is decoupled | **Intact**, and load-bearing: it is why `source` is wire contract in D-32. |
> | **D-32** unprefixed `source` reads as `human:` | **Amended** by D-41: required and prefixed on `PUT /state`, optional on the convenience routes. |
> | **D-38** ESPHome cannot serve a custom device page or persist a table | **Corrected** by D-40. It can, via an external component. D-38's architecture stands; only its feasibility verdict was wrong. Its `select`->`text` half is proven by D-44 and **shipped** by D-46; the `select` no longer exists. |
> | **D-31** "colour is on the wire" | **Narrowed** by D-42: colour is in the profile (`GET /config/states`), never on a state change. Presentation travels with the profile, semantics with the state. |

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
