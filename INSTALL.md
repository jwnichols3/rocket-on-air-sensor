# Install

Install the system in three layers, in this order:

1. **Host** - the Receiver that runs the On-air API.
2. **Client** - the on-air light, the control panel, and manual control.
3. **Companion** - Stream Deck control through Bitfocus Companion.

Each layer builds on the one before it. Install the host first.

## Before you start

- The host needs Node.js 22 or later. Check with `node --version`.
- The host needs Git.
- All devices must be on the same LAN.
- Auth is optional. When you set `ONAIR_TOKEN` on the host, the On-air API requires
  a bearer token on every request. Without a token, the On-air API is open to the
  LAN. The "Configure the host" section shows how to set the token.

## Layer 1: Host (the Receiver)

Pick one host. The host runs the On-air API. The On-air API is the source of truth
for the call state.

### Option A: Mac (launchd service)

Use this option for the Mac Mini. The service starts at boot, needs no GUI login,
and restarts after a crash.

```sh
git clone https://github.com/jwnichols3/rocket-on-air-sensor.git
cd rocket-on-air-sensor
npm install && npm run build
sudo deploy/onair install
```

The installer renders the launchd plist, installs it, starts the service, and runs
a health check. It prints PASS when the service responds. It also links itself to
`/usr/local/bin/onair`, so the `onair` command works from any directory afterward.

Control the service with the `onair` CLI:

```sh
onair status      # supervised? responding?
onair restart     # kill and respawn the process
onair logs -f     # follow the log
onair reset-state # force the call state to off and clear the message
```

`docs/mac-setup.md` has the full verb table, the `--sudoers` option, and the
caveats (node path, how to reload the plist, log rotation).

### Option B: Raspberry Pi (systemd service)

```sh
git clone https://github.com/jwnichols3/rocket-on-air-sensor.git
cd rocket-on-air-sensor
sudo cp deploy/onair.service /etc/systemd/system/
sudo nano /etc/systemd/system/onair.service   # set User= to your Pi user
sudo systemctl daemon-reload
sudo systemctl enable --now onair
```

The unit runs `npx --yes github:jwnichols3/rocket-on-air-sensor`. It needs network
access at start. `docs/pi-setup.md` has the full setup.

### Verify the host

```sh
curl http://localhost:8484/status
curl http://localhost:8484/admin/health
```

Both commands must return JSON. `stateFileWritable` must be `true`.

### Configure the host

Set environment variables in the service definition:

| Variable | Default | Purpose |
|---|---|---|
| `ONAIR_PORT` | `8484` | HTTP port |
| `ONAIR_STATE_FILE` | `~/.onair/state.json` | Where the call state persists |
| `ONAIR_TOKEN` | unset | Bearer token; also enables `POST /admin/restart` |

On the Mac, put the variables in `~/.onair/cli.env` (or export them in your shell).
Then run `sudo deploy/onair install` again to render a new plist. Then run
`onair reload`. A plain `onair restart` does not read plist changes.

On the Pi, edit the unit file. Then run `sudo systemctl daemon-reload`. Then run
`sudo systemctl restart onair`.

## Layer 2: Client

Clients talk to the On-air API over HTTP. In the URLs below, replace `<host>` with
the Receiver's hostname or IP address. Replace `<token>` with the `ONAIR_TOKEN`
value you set on the host.

### The on-air light (display page)

Open `http://<host>:8484/display` fullscreen on any screen. The page shows ON AIR
on red when the call state is on. It shows OFF AIR on dark when the call state is
off.

For a dedicated screen, point a Raspberry Pi in kiosk mode at that URL. This kiosk
device can be the Receiver Pi or a different Pi - the kiosk only needs a browser,
not the On-air API. `docs/pi-setup.md` has the kiosk configuration.

If `ONAIR_TOKEN` is set, add the token to the URL:
`http://<host>:8484/display?token=<token>`.

### The control panel

Open `http://<host>:8484/ui`. The page has ON and OFF buttons, message controls, a
live event log, an API console, and an Admin card with a Restart button. If
`ONAIR_TOKEN` is set, enter the token in the header field.

### Manual control (curl)

```sh
curl -X POST http://<host>:8484/on
curl -X POST http://<host>:8484/off
curl -X PUT http://<host>:8484/message \
  -H "Content-Type: application/json" -d '{"text": "BE QUIET"}'
curl -X DELETE http://<host>:8484/message
```

Each command returns the full status JSON, with the new call state and message.
`docs/api-contract.md` has the exact response shapes. If `ONAIR_TOKEN` is set, add
`-H "Authorization: Bearer <token>"` to each command.

### The Detector

The Detector is not built yet. Until it exists, set the call state manually with
the control panel, curl, or Companion. GitHub issue #5 in this repo tracks the
Detector work.

## Layer 3: Companion (Stream Deck)

Bitfocus Companion gives you a physical ON/OFF button with live status feedback.
Follow `docs/companion-setup.md` for the exact settings. The outline:

1. Install Bitfocus Companion from https://bitfocus.io/companion (version 5.x).
2. Add a **Generic HTTP** connection for the buttons. Point it at
   `http://<host>:8484`.
3. Add a **Generic Websocket** connection for status feedback. Point it at
   `ws://<host>:8484/events/ws`.
4. Build the ON and OFF buttons. Add the feedback rules.

## Checklist

- [ ] Host: `curl http://<host>:8484/status` returns JSON from another machine.
- [ ] On-air light: `/display` turns red on `POST /on` and dark on `POST /off`.
- [ ] Control panel: `/ui` buttons change the call state.
- [ ] Companion: the Stream Deck button changes the call state, and the button
      color follows it.
