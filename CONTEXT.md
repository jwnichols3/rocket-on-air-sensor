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
- Receiver (Raspberry Pi): hosts a REST API that is the system's source of truth.
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
- **Receiver** - the device/computer that receives the state change and drives the light.
  Current plan: a Raspberry Pi running the REST API service.
- **On-air light** - the physical light. Hardware TBD; research ticket open. Wi-Fi or
  Bluetooth, preferably battery operated with status feedback.
- **Call state** - boolean, ON_AIR / OFF_AIR. The single fact the system communicates.
- **On-air API** - the REST service on the receiver: set state, query state. The
  system's source of truth, callable by the detector or any other client.

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
- [ ] REST API shape: endpoints, auth (LAN-only? token?), port, state model.
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
