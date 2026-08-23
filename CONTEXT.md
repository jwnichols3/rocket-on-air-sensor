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

- **Detector** - the process on the Mac that decides "call in progress: yes/no".
- **Receiver** - the role of the device/computer that receives the state change and
  drives the light. Mac Mini first (development), Raspberry Pi as the long-term host
  (D-4). Never the work Mac.
- **On-air light** - the physical light or display. Since D-16: a DIY ESP32 running
  ESPHome, driving an SH1106 OLED today and a colour lamp later (D-20). Firmware:
  `jwnichols3/rocket-esp32`.
- **Call state** - since D-18, one of three rungs on a ladder:
  `available < interruptible < dnd`. Stored as `level`. The old boolean survives as
  `intended`, a derived read-only projection (`available` -> `off`, anything else -> `on`).
- **Hold** - a persisted **floor** on `level`, set by a manual write (D-19). The detector
  may raise above it but never lower below it. Released explicitly, never on a timer.
- **On-air API** - the REST service on the receiver: set state, query state. The
  system's source of truth, callable by the detector or any other client. Contract:
  `docs/api-contract.md`.
- **Intended state** - what the API was last told (`on`/`off`). Persisted; survives
  restarts.
- **Confirmed state** - what the light acknowledged (`on`/`off`/`unknown`). Never
  guessed; `unknown` when the light can't report or can't be reached.

## Invariants (draft)

- False OFF is worse than false ON: the light saying "not in a call" while Rocket is on
  camera is the failure mode to avoid.
- The system must recover state after either end restarts (no stuck-on light).
- Local network only is acceptable for v1; no cloud dependency required.

## Open questions

- [ ] Sensing mechanism: mic/camera-in-use (macOS APIs / log stream), process + window
      detection, CGDisplayStream, or Zoom/Meet-specific signals? (vcrec repo has prior
      art on macOS meeting detection - check its detection registry.)
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
- [x] Light behavior: **resolved 2026-08-23, see D-18.** Three rungs -
      `available < interruptible < dnd` - named semantically, not by colour, so the mono
      OLED and a future colour lamp are two renderers of one state. Colour mapping and the
      accessibility problem with red/green are in `docs/research/2026-08-22-wall-indicator.md`.
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
