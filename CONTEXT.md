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
> | **D-19** hold as a floor | **Superseded** by D-32, **shipped** by D-49. Hold is a pin with one escalation carve-out, and a refusal settles back to the held row. |
> | **D-21.1** reconciliation merges only on contradiction | **Intact in spirit**, restated over `busy` rather than rungs. |
> | **D-21.2** a manual write below the floor releases the floor | **Superseded** by D-32, shipped in D-48/D-49: a `human:` write naming a state other than the held one releases the pin. |
> | **D-22** ESP32 integration live and accepted | **Intact.** All three sub-findings survive; D-22.3 (a write is not confirmed by the next read) is re-verified against `text` in D-38. D-22.1's `Render` sensor gains a fifth branch in D-46. |
> | **D-23** `ONAIR_TOKEN` set on this host | **Superseded** by D-35 and D-51. The value now lives in `config.json`'s `auth` block; the env var overrides it. |
> | **D-24** loopback alone does not authenticate; `Origin` does | **Survives, unweakened**, cited verbatim by D-35 and **implemented clause by clause** in D-51. Both measured attacks are regression tests, at the unit level and over HTTP. |
> | **D-25** `/ui` and `/display` unauthenticated | **Amended** by D-35, **executed** by D-52 and **completed** by D-53: `/ui` is a `404`; `/display` and the admin console's shell are unauthenticated and byte-identical for every caller. |
> | **D-26** SwiftBar, not a native app | **Survives**, confirmed. |
> | **D-27** one credential, no read/write split | **Carried forward** onto the passphrase by D-35, shipped in D-51, and sharpened: the split that *does* exist is machine credential vs human admin credential, which is a different axis. |
> | **D-30** the detector is decoupled | **Intact**, and load-bearing: it is why `source` is wire contract in D-32. |
> | **D-32** unprefixed `source` reads as `human:` | **Amended** by D-41: required and prefixed on `PUT /state`, optional on the convenience routes. |
> | **D-38** ESPHome cannot serve a custom device page or persist a table | **Corrected** by D-40. It can, via an external component. D-38's architecture stands; only its feasibility verdict was wrong. Its `select`->`text` half is proven by D-44 and **shipped** by D-46; the `select` no longer exists. Its **config-pull half is shipped by D-54**, which also removes the last hardcoded row list from the firmware. Its claim that `mode: password` keeps a value out of the device's REST API is **factually wrong and corrected by D-55** - a second feasibility-shaped error in the same decision. |
> | **D-40** ESPHome CAN serve a custom page, via an external component | **Narrowed** by D-57. The verdict was right and the mechanism was not: `web_server_base::add_handler()` registers a handler on the server ESPHome already runs, so the page needed two headers and no component. D-40's evidence - the `add_handler` / `canHandle` surface, `captive_portal` using it in-tree - is exactly what made that possible, and its NVS-persistence half is **shipped** by D-57 for the overlay only. |
> | **D-55**'s operational note, *"rotating it in the admin console is cheap ... it is on the review list"* | **Retired** by D-61. The defaults are the product, the way a router's are. The first-run change is the operator's step, not remediation, and it is not an open item to keep raising. |
> | **D-31** "colour is on the wire" | **Narrowed** by D-42: colour is in the profile (`GET /config/states`), never on a state change. Presentation travels with the profile, semantics with the state. |
> | **D-42** presentation travels with the profile; the version nudge | **Shipped** by D-53 (server payload) and D-54 (the nudge, and the device end of the pull). The nudge fires on a state write *and* on a config save. |

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

