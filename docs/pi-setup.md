# Pi setup

Two independent uses for a Raspberry Pi here: running the API itself, or just
displaying it (kiosk). You can do either or both.

## 1. Run the API on a Pi

Needs Node 22+.

```sh
node --version   # if < 22:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

One-liner install:

```sh
curl -fsSL https://raw.githubusercontent.com/jwnichols3/rocket-on-air-sensor/main/deploy/get-onair | bash
```

It checks for git and Node.js 22+, clones (or reuses) a checkout at
`~/code/rocket-on-air-sensor` (override with `ONAIR_DIR`), and hands off to
`deploy/bootstrap`.

Already have a checkout, or want to read `deploy/bootstrap` before running it?
Clone and bootstrap it directly instead - both do the same thing:

```sh
git clone https://github.com/jwnichols3/rocket-on-air-sensor.git
cd rocket-on-air-sensor
deploy/bootstrap
```

Run `deploy/bootstrap` plain, without a `sudo` prefix - it asks for your
password itself when it needs to install the service.

`deploy/bootstrap`:

- checks that git and Node 22+ are present
- runs `npm ci` and `npm run build` as the invoking (non-root) user, even
  under `sudo`
- renders `deploy/onair.service.template` into `/etc/systemd/system/onair.service`
  (fills in the node path, this checkout's directory, and your Pi user and
  home)
- runs `systemd-analyze verify` on the rendered unit when available
- installs the unit, runs `daemon-reload`, then `enable --now`
- polls `/admin/health` for up to 5s and prints `health: PASS`/`FAIL`

The rendered unit runs `node dist/index.js` from this checkout. It does not
run `npx github:...` at boot: fetching and building at every start needs
network access before the service is up, and a Pi that boots before the
network is ready would fail silently.

### Configuration

The service reads `~/.onair/config.env` at startup (`EnvironmentFile=-` in
the unit; the leading `-` means a missing file is not an error - the service
starts with defaults). There is no setup wizard on the Pi - `onair setup`
needs `launchctl`, which is Mac only. Create or edit the file directly, then
restart:

```sh
mkdir -p ~/.onair
nano ~/.onair/config.env
```

```sh
ONAIR_PORT="8484"
ONAIR_TOKEN="some-secret-value"
ONAIR_STATE_FILE="/home/pi/.onair/state.json"
```

```sh
sudo systemctl restart onair
```

A real environment variable set on the service always wins over the file
(`src/config.ts`).

### Updating

```sh
git pull && deploy/bootstrap
```

`deploy/bootstrap` rebuilds the checkout and, if the service is already
active, restarts it to pick up the new build. Re-running it is always safe.

## 2. Kiosk display Pi (interim tally, issue #8)

A second, simpler option: don't run the API on the Pi at all, just point a
browser at another machine's `/display` endpoint (e.g. the Mac Mini running the
API today; could be the Pi itself later once it's running the service).

On Raspberry Pi OS (default desktop is labwc or wayfire depending on release),
add an autostart entry:

```sh
mkdir -p ~/.config/labwc   # or ~/.config/wayfire.ini's directory, per your OS version
```

`~/.config/labwc/autostart` (or the equivalent wayfire autostart file):

```sh
chromium-browser --kiosk --noerrdialogs --disable-restore-session-state http://<api-host>:8484/display &
```

Replace `<api-host>` with the Mac Mini's hostname/IP (or `localhost` if the API
ends up running on the Pi itself).

Turn off screen blanking so the kiosk display doesn't sleep:

```sh
sudo raspi-config
# -> Display Options -> Screen Blanking -> Disable
```

## 3. Caveats

- `deploy/bootstrap` needs git and network access to clone and to `npm ci` -
  but only when you install or update, not at every service start.
- The service checkout is a plain git clone, not a supply-chain-hardened
  installer. If provenance matters, check out a tag or commit instead of
  tracking the default branch before running `deploy/bootstrap`.
- **Kiosk binary name**: current Raspberry Pi OS ships `chromium`; older images
  use `chromium-browser`. Check which exists with `which chromium chromium-browser`
  and update the autostart command accordingly.
- **Screen blanking on Wayland**: raspi-config's Screen Blanking option
  historically targets X11. Under Wayland (labwc/wayfire), behavior varies by
  release - verify the blanking state on your device after enabling/disabling.
