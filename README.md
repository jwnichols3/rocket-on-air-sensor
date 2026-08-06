# rocket-on-air-sensor

This system turns an on-air light on when Rocket is in a Zoom or Google Meet call.
It turns the on-air light off when the call ends.

## Architecture

```
[work Mac] --detector--> [On-air API on the Receiver] --> [on-air light]
                              ^
                              | manual control: /ui, curl, Stream Deck (Companion)
```

- The **Detector** runs on the work Mac. It senses the call state. It is not built
  yet. GitHub issue #5 in this repo has the research.
- The **Receiver** runs the **On-air API**. The On-air API is the source of truth for
  the call state. The Receiver is a Mac Mini now. A Raspberry Pi can be the Receiver
  later (D-4).
- The **on-air light** is the `/display` browser page (D-12). Light hardware is on
  hold.

`CONTEXT.md` holds the glossary, the invariants, and all decisions (D-1..D-14).

## Parts

| Part | What it does |
|---|---|
| `GET /status`, `PUT /state`, `POST /on`, `POST /off` | Read and write the call state |
| `PUT /message`, `DELETE /message` | Set or clear the display message |
| `GET /events` (SSE), `GET /events/ws` (WebSocket) | Push status to clients |
| `GET /display` | The on-air light: a fullscreen tally page |
| `GET /ui` | Control panel and API console |
| `GET /admin/health`, `POST /admin/restart` | Service health and remote restart |
| `deploy/onair` | CLI that installs, configures (`setup`), updates, and controls the Mac service |
| `deploy/bootstrap` | Builds and installs the host on either machine: `deploy/onair install` on the Mac, a rendered systemd unit on the Pi |
| `deploy/onair.service.template` | systemd unit template for the Raspberry Pi, rendered by `deploy/bootstrap` |

The full On-air API contract is in `docs/api-contract.md`.

## Quick start

Quick start runs the On-air API locally, for development or a first look. For a
deployed Receiver, see `INSTALL.md`.

```sh
npm install && npm run build && npm start   # or: npm run dev
```

Then open `http://localhost:8484/ui`.

Configuration comes from environment variables: `ONAIR_PORT` (default 8484),
`ONAIR_STATE_FILE` (default `~/.onair/state.json`), and `ONAIR_TOKEN` (optional
bearer auth). It also reads `~/.onair/config.env` if present; a real environment
variable always wins over the file (`src/config.ts`).

## Install

`INSTALL.md` has the instructions for each layer:

1. **Host** - run the On-air API as a supervised service (Mac launchd or Pi systemd).
2. **Client** - connect the on-air light, the control panel, and manual control.
3. **Companion** - control the call state from a Stream Deck.

## Development

```sh
npm test          # type-check + unit tests
npm run dev       # run from source with tsx
```

The service has zero production npm dependencies. The system requires Node.js 22
or later.

## Documents

| Document | Content |
|---|---|
| `CONTEXT.md` | Problem, glossary, invariants, decisions |
| `INSTALL.md` | Install instructions by layer |
| `docs/api-contract.md` | The On-air API contract |
| `docs/mac-setup.md` | Mac service setup and the `onair` CLI |
| `docs/pi-setup.md` | Raspberry Pi service and kiosk setup |
| `docs/companion-setup.md` | Bitfocus Companion configuration |
| `docs/research/` | Research notes: light hardware, call detection, Companion |
