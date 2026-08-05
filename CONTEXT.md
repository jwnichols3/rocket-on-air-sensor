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
- Light: connects to the Pi over Wi-Fi or Bluetooth. Preferred: battery operated and
  reports its status back to the Pi (so status queries reflect reality, not intent).
- Distribution to the Pi should be dead simple - `npx <pkg>` or similar one-command
  install/run. Publishing to Rocket's GitHub (jwnichols3) is available if needed.
- Rocket has Raspberry Pis on hand and can give SSH access to one for development.

## Domain glossary

- **Detector** - the process on the Mac that decides "call in progress: yes/no".
- **Receiver** - the role of the device/computer that receives the state change and
  drives the light. Mac Mini first (development), Raspberry Pi as the long-term host
  (D-4). Never the work Mac.
- **On-air light** - the physical light. Hardware TBD; research ticket open. Wi-Fi or
  Bluetooth, preferably battery operated with status feedback.
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
- [ ] Light hardware: which Wi-Fi/BT tally or busylight? Battery operated preferred,
      status feedback preferred. (Research ticket open.)
- [x] REST API shape: endpoints, auth, port, state model - resolved, see
      `docs/api-contract.md` and D-5..D-7.
- [ ] Light behavior: binary on/off only, or colors/states (in call vs camera on)?
- [ ] Pi packaging: npx-style one-command install - Node on Pi, or alternative
      (pipx, docker, systemd unit) if npx is a poor fit?
- [ ] How does the API confirm the light actually changed (ack/status from the light)
      vs just recording intent?

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
