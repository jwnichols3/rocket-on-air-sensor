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
