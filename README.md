# rocket-on-air-sensor

A Receiver service and physical on-air displays for call state from an external
Detector, with manual control from a browser, menu bar, and Stream Deck.

Install the host with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/jwnichols3/rocket-on-air-sensor/main/deploy/get-onair | bash
```

[INSTALL.md](INSTALL.md) covers each layer. [Current architecture and operations](docs/architecture.md)
is the short guide to how the parts fit together.

For long-running Mac Receivers, see the [signed runtime setup](docs/mac-setup.md#stable-signed-mac-runtime).
For repeatable Companion installs and rollback, see [Companion deployment](docs/companion-deployment.md).

## Architecture

```text
[work Mac: VCREC Detector] --> [On-air API on the Receiver] --> [primary on-air panel]
                                         |                  [optional secondary panels]
                                         ^
                             admin UI, SwiftBar, Companion
```

- The **Detector** is the separate VCREC project. It writes state through the API;
  this repository does not implement call sensing. Detector writes identify their
  source as `auto:vcrec`. Verify the complete chain with a real call when installing it.
- The **Receiver** hosts the **On-air API**, the source of truth. It runs on macOS
  or a Raspberry Pi with systemd (D-4).
- The **on-air panels** run ESPHome. One enabled panel is primary, and `confirmed`
  describes that panel only. Secondary panels are best effort (D-147). Firmware
  configurations support CrowPanel and Elegoo ESP32 boards.
- The **state table** defines stable row IDs, labels, colours, and the `busy` meaning.
  The last valid write wins. A manual write lasts until the next writer changes it.
  The Receiver latches state; each renderer judges its own connection health.

[GLOSSARY.md](GLOSSARY.md) holds the vocabulary, invariants, and decision record.
Read its **Supersession index** before relying on older decisions or design documents.

## Repository layout

Three npm workspaces and one firmware toolchain (D-37):

```text
server/            Node On-air API and browser display
admin-ui/          admin console: state table, device list, settings
companion-module/  Bitfocus Companion module and Stream Deck presets
firmware/          ESPHome firmware, device pages, and host tests
```

`docs/` and `deploy/` are shared across the project.

## Interfaces

| Interface | Purpose |
|---|---|
| `GET /status`, `PUT /state`, `POST /state/{id}` | Read or write a state-table row; automated writes identify their source |
| `POST /on`, `POST /off` | Write the configured shortcut rows |
| `POST /cycle` | Advance through a caller-selected ring of rows |
| `POST /panel/sleep`, `/panel/wake`, `/panel/toggle` | Request a manual panel sleep/wake change |
| `PUT /message`, `DELETE /message` | Set or clear the display message |
| `GET /events` (SSE), `GET /events/ws` (WebSocket) | Push status to machine clients |
| `GET /config/states` | Read the versioned state table |
| `GET /`, `GET /admin` | Open the admin console |
| `GET /admin/config`, `PUT /admin/config` | Read or save configuration with a version check |
| `GET /display`, `GET /public/status`, `GET /public/events` | Public browser display and its rendering data |
| `GET /admin/health` | Inspect service and per-device health |
| `GET /docs` | Read the client API guide in the browser |

The [API contract](docs/api-contract.md) specifies authentication, request bodies,
response fields, and error handling. Restart the installed Mac service with
`onair restart`; `POST /admin/restart` is retained but returns 403 in the shipped
application.

## Local development

```sh
npm install
npm run build
npm start -w server          # or: npm run dev -w server
```

Open `http://localhost:8484/` for the console or `/display` for the tally.
To develop alongside a running Receiver, use a different port and temporary
`ONAIR_CONFIG_FILE` and `ONAIR_STATE_FILE` paths rather than the deployed files.

Configuration lives in `~/.onair/config.json`. The console edits that document;
`~/.onair/state.json` stores the last state write separately. `~/.onair/config.env`
is an environment overlay for installation and recovery, and an already-set
process variable wins over the same variable in the file.

Common overrides:

| Variable | Purpose |
|---|---|
| `ONAIR_PORT` | Override the configured port (default 8484) |
| `ONAIR_CONFIG_FILE` | Choose the config document path |
| `ONAIR_STATE_FILE` | Choose the state file path |
| `ONAIR_CONFIG` | Choose the environment-overlay file path |
| `ONAIR_PASSPHRASE` | Override the machine-client passphrase |
| `ONAIR_TOKEN` | Legacy passphrase override, used when `ONAIR_PASSPHRASE` is unset |
| `ONAIR_LIGHT_HOST`, `ONAIR_LIGHT_ENTITY`, `ONAIR_LIGHT_USER`, `ONAIR_LIGHT_PASS` | Override the primary panel connection |

Machine clients use the passphrase. Human administration uses a separate session
credential. Same-origin local access has the documented loopback waiver; LAN
clients still authenticate. See the contract for the exact conditions.

## Verification

```sh
npm run verify              # builds, typechecks, tests, generated-file and firmware checks
npm test -w server          # server typechecks and tests
npm test -w admin-ui        # real-browser console checks, after building
```

`npm run verify` is the local gate before source commits. There is no CI,
deliberately (D-37). Browser tests require Playwright's Chromium installation;
run `npx playwright install chromium` once if it is missing.

Firmware validation needs its pinned toolchain and a local secrets file:

```sh
npm run firmware:setup
cp firmware/configs/secrets.yaml.example firmware/configs/secrets.yaml
# Fill in the file, including a valid base64 API encryption key.
```

Missing prerequisites fail the gate explicitly. [firmware/README.md](firmware/README.md)
explains board compilation, browser tests, and post-flash verification. A passing
host test or YAML check does not establish which firmware is running on a device.

Dependencies are **minimal, necessary, and trusted** (D-29). Node.js 22 or later
is required. Older documents' zero-production-dependency restriction is superseded.
The former `npx github:jwnichols3/rocket-on-air-sensor` install path is retired;
use `deploy/get-onair`.

## Documents

| Document | Content |
|---|---|
| [Current architecture](docs/architecture.md) | Present model, configuration, health, and operating boundaries |
| [GLOSSARY.md](GLOSSARY.md) | Vocabulary, invariants, and decisions |
| [INSTALL.md](INSTALL.md) | Install instructions by layer |
| [API contract](docs/api-contract.md) | The On-air API contract |
| [Mac setup](docs/mac-setup.md) | Mac service setup and the `onair` CLI |
| [Pi setup](docs/pi-setup.md) | Raspberry Pi service and kiosk setup |
| [Companion setup](docs/companion-setup.md) | Bitfocus Companion configuration |
| [Admin console](admin-ui/README.md) | Console behaviour and development |
| [Next steps](docs/NEXT.md) | Current follow-up work and verification boundaries |

Files under `docs/research/`, `docs/superpowers/`, and `docs/design/` capture their
original research or implementation stage. Use the current contract and source to
resolve differences.
