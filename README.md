# rocket-on-air-sensor

Sense when a Zoom or Google Meet call is in progress on Rocket's Mac and signal another
machine to turn an on-air light on or off.

## Status

Greenfield. Architecture is open. See `CONTEXT.md` for the problem statement and the
open questions we need to resolve before building.

## The idea

```
[Mac in a call?] --sense--> [detector] --message--> [receiver device] --> [on-air light]
```

Three unknowns, all to be determined:

1. **Sensing** - how to reliably detect a Zoom/Meet call in progress (mic/camera in use,
   process detection, calendar, something else).
2. **Transport** - how the detector tells the receiver (MQTT, HTTP, Home Assistant,
   direct GPIO over network, etc.).
3. **Receiver + light hardware** - what device drives the light (Raspberry Pi, ESP32,
   smart plug, busylight-style USB device, etc.).

## Running the API

```sh
npm install && npm run build && npm start   # or: npm run dev
```

One-command run (e.g. on a Pi), no clone needed: `npx --yes github:jwnichols3/rocket-on-air-sensor`.
See `docs/pi-setup.md` for Pi service + kiosk display setup.

Config via env: `ONAIR_PORT` (default 8484), `ONAIR_STATE_FILE` (default `~/.onair/state.json`), `ONAIR_TOKEN` (optional bearer auth). Contract: `docs/api-contract.md`.

Interim tally display: open `http://<host>:8484/display` fullscreen (kiosk). Set a
custom message with `curl -X PUT :8484/message -d '{"text": "BE QUIET"}'`, clear with
`DELETE /message`.

Dark control panel + API console: open `http://<host>:8484/ui`.

Bitfocus Companion integration (button + status feedback): `docs/companion-setup.md`.
