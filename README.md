# rocket-on-air-sensor

This system turns an on-air light on when Rocket is in a Zoom or Google Meet call.
It turns the on-air light off when the call ends.

Install the host with one command (it asks three setup questions, then starts the
service):

```sh
curl -fsSL https://raw.githubusercontent.com/jwnichols3/rocket-on-air-sensor/main/deploy/get-onair | bash
```

`INSTALL.md` has the full instructions for every layer.

## Architecture

```
[work Mac] --detector--> [On-air API on the Receiver] --> [on-air light]
                              ^
                              | manual control: admin UI, curl, Stream Deck (Companion)
```

- The **Detector** runs on the work Mac. It senses the call state. It is not built
  yet. GitHub issue #5 in this repo has the research.
- The **Receiver** runs the **On-air API**. The On-air API is the source of truth for
  the call state. The Receiver is a Mac Mini now. A Raspberry Pi can be the Receiver
  later (D-4).
- The **on-air light** is a DIY ESP32 driving an OLED panel (D-16, live since
  2026-08-23). The `/display` browser page is a second renderer of the same state, not
  the light itself.

`CONTEXT.md` holds the glossary, the invariants, and all decisions. Start at the
**Supersession index** at the top of its `## Decisions` section - several older
decisions are written in a vocabulary the system no longer uses.

## Repo layout

Four flat directories (D-37). Two are npm workspaces plus one placeholder; `firmware/`
has its own toolchain and is driven from root scripts.

```
server/            the Node service - package "onair-api", the thing the daemon runs
admin-ui/          the admin SPA (state table editor, settings) - built by #42
firmware/          the ESPHome lab for the ESP32 panel - uv/esphome, not npm
companion-module/  the Bitfocus Companion module - built by #44
docs/  deploy/     repo-wide by nature, and stay at the root
```

## Parts

| Part | What it does |
|---|---|
| `GET /status`, `PUT /state`, `POST /available`, `POST /interruptible`, `POST /dnd` | Read and write the call state (three rungs; `POST /on` and `/off` still work and map to `dnd`/`available`) |
| `PUT /message`, `DELETE /message` | Set or clear the display message |
| `GET /events` (SSE), `GET /events/ws` (WebSocket) | Push status to clients |
| `GET /display` | The on-air light: a fullscreen tally page, rendered from the state table |
| `GET /public/status`, `GET /public/events` | Unauthenticated, deliberately thin - the current row resolved for rendering |
| `GET /admin/health`, `POST /admin/restart` | Service health and remote restart |
| `deploy/onair` | CLI that installs, configures (`setup`), updates, and controls the Mac service |
| `deploy/bootstrap` | Builds and installs the host on either machine: `deploy/onair install` on the Mac, a rendered systemd unit on the Pi |
| `deploy/get-onair` | Self-contained one-line install shim: clones (or reuses) the repo, then hands off to `deploy/bootstrap` |
| `deploy/onair.service.template` | systemd unit template for the Raspberry Pi, rendered by `deploy/bootstrap` |

The full On-air API contract is in `docs/api-contract.md`.

## Quick start

Quick start runs the On-air API locally, for development or a first look. For a
deployed Receiver, see `INSTALL.md`.

```sh
npm install                 # installs all workspaces from the root
npm run build               # builds server/ into server/dist/
npm start -w server         # or: npm run dev -w server
```

Then open `http://localhost:8484/display`.

Configuration comes from environment variables: `ONAIR_PORT` (default 8484),
`ONAIR_STATE_FILE` (default `~/.onair/state.json`), and `ONAIR_TOKEN` (optional
bearer auth). It also reads `~/.onair/config.env` if present; a real environment
variable always wins over the file (`server/src/config.ts`).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jwnichols3/rocket-on-air-sensor/main/deploy/get-onair | bash
```

`INSTALL.md` has the instructions for each layer:

1. **Host** - run the On-air API as a supervised service (Mac launchd or Pi systemd).
2. **Client** - connect the on-air light, the control panel, and manual control.
3. **Companion** - control the call state from a Stream Deck.

## Development

```sh
npm run verify         # THE gate: every typecheck, every test, the deploy-path
                       # tests, and `esphome config` on the firmware YAML
npm test -w server     # just the server's typecheck + unit tests
npm run dev -w server  # run from source with tsx
```

`npm run verify` is what runs before any commit that touches source. There is no CI,
deliberately (D-37) - this command is the gate, run by a human or an agent.

The firmware half of `verify` needs a one-time setup, since it shells out to a real
`esphome`:

```sh
npm run firmware:setup                                          # uv sync
cp firmware/configs/secrets.yaml.example firmware/configs/secrets.yaml && $EDITOR $_
```

Without them `verify` **fails** with a message saying which one is missing - it does
not skip quietly.

Dependencies are **minimal, necessary and trusted - not zero** (D-29). Earlier docs in
this repo assert a zero-production-dependency rule; it was never actually decided and
was retired on 2026-08-23. The system requires Node.js 22 or later.

**`npx github:jwnichols3/rocket-on-air-sensor` is retired.** The root package is
`private` and has no `bin`, so that path no longer resolves an executable. D-15 had
already demoted it to a throwaway demo; D-37 finished the job. `deploy/get-onair` is
the install path.

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
| `firmware/README.md` | The ESPHome lab: setup, the version pin, the state entity |
