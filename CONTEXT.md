# Context

## Problem

Rocket wants a physical on-air light that turns on automatically when he is in a Zoom or
Google Meet call, and off when the call ends. The light lives on/near another computer or
device elsewhere in the house, so the sensing machine must send a message across the
network.

## Domain glossary

- **Detector** - the process on the Mac that decides "call in progress: yes/no".
- **Receiver** - the device/computer that receives the state change and drives the light.
- **On-air light** - the physical light. Hardware TBD.
- **Call state** - boolean, ON_AIR / OFF_AIR. The single fact the system communicates.

## Invariants (draft)

- False OFF is worse than false ON: the light saying "not in a call" while Rocket is on
  camera is the failure mode to avoid.
- The system must recover state after either end restarts (no stuck-on light).
- Local network only is acceptable for v1; no cloud dependency required.

## Open questions

- [ ] Sensing mechanism: mic/camera-in-use (macOS APIs / log stream), process + window
      detection, CGDisplayStream, or Zoom/Meet-specific signals? (vcrec repo has prior
      art on macOS meeting detection - check its detection registry.)
- [ ] Transport: MQTT broker, plain HTTP webhook, Home Assistant, SSH, other?
- [ ] Receiver hardware: Raspberry Pi, ESP32, smart plug (Kasa/Hue), USB busylight?
- [ ] What is the receiving computer? Does one already exist in the right spot?
- [ ] Light behavior: binary on/off only, or colors/states (in call vs camera on)?

## Decisions

_(none yet - record as D-rows here as they land)_
