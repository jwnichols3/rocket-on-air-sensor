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
- **On-air light** - the physical light (or display). Hardware TBD; research ticket open.
  Wi-Fi or Bluetooth, preferably battery operated and pollable for real status.
- **Call state** - boolean, ON_AIR / OFF_AIR. The single fact the system communicates.
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
- [ ] Light hardware: which Wi-Fi/BT tally, busylight or display? Research is done - 17
      ranked options across consumer/prosumer/production tiers, priced and sourced, in
      `docs/research/2026-08-10-onair-light-hardware-slate.md` (supersedes the 2026-08-05
      pass). The pick is Rocket's call; issue #1 carries the summary. Two structural
      tradeoffs have to be settled by that choice: **battery XOR genuine `confirmed`**
      (only two products on the whole slate give both), and **battery XOR latency** (a
      deep-sleeping device cannot be pushed to, so lag equals its poll interval).
      **Update 2026-08-20:** Rocket bought an ELEGOO ESP-32 Super Starter Kit, which
      reopens the question with a build option. Judged research:
      `docs/research/2026-08-20-esp32-diy-light.md` (verdict: build, ESPHome firmware,
      server-push + device-read protocol); plan:
      `docs/superpowers/plans/2026-08-20-esp32-onair-light.md`. A USB-powered board whose
      firmware we write dissolves both tensions above. Proposed D-16..D-19 and the
      D-6/D-12 amendments are drafted in the research doc, pending Rocket's call.
- [x] REST API shape: endpoints, auth, port, state model - resolved, see
      `docs/api-contract.md` and D-5..D-7.
- [ ] Light behavior: binary on/off only, or colors/states (in call vs camera on)?
- [x] Pi packaging: npx one-command install + systemd unit - resolved, see D-10 and
      `docs/pi-setup.md`.
- [ ] How does the API confirm the light actually changed (ack/status from the light)
      vs just recording intent? Partly answered by the 2026-08-10 research: a real read
      is available on several candidates (Shelly `Switch.GetStatus` -> `output` + measured
      `apower`, WLED `/json/state` -> `on`, BUSY Bar `/busybar/smart_home/switch`, Hue
      `reachable`), but every purpose-built battery busylight is write-only by design.
      Answered in full for the DIY path by the 2026-08-20 research: poll the device's own
      read every 10s, re-assert on mismatch, decay `confirmed` to `unknown` after 30s.
      Note the live gap it closes - `setConfirmed` is called only from `src/app.ts:31,34`
      and `src/server.ts:168`, so today no code path can return `confirmed` to `unknown`
      without another write, which `docs/api-contract.md:14` already requires.

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
