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

Then run it directly:

```sh
npx --yes github:jwnichols3/rocket-on-air-sensor
```

First run is slow (git clone + `npm install` + `npm run build` via the `prepare`
script). Needs git and network access at start.

### As a systemd service

```sh
sudo cp deploy/onair.service /etc/systemd/system/onair.service
sudo nano /etc/systemd/system/onair.service   # set User=, uncomment ONAIR_TOKEN if wanted
sudo systemctl daemon-reload
sudo systemctl enable --now onair
```

**Updating**: `npx github:...` re-resolves the default branch on every run, so a
restart picks up the latest code:

```sh
sudo systemctl restart onair
```

For reproducibility (pin instead of always tracking `main`), reference a tag or
commit in both the manual command and `ExecStart`:

```
github:jwnichols3/rocket-on-air-sensor#v0.1.0
```

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

- `npx github:...` needs git and network access at the time it runs - it's not a
  pre-built artifact.
- First boot/first run is slow: it's cloning and building from source.
- This is a cold-machine convenience for a home project, not a
  supply-chain-hardened installer. If provenance matters, pin a commit or tag
  (`#v0.1.0` or `#<sha>`) rather than tracking the default branch.
- npm configs with `ignore-scripts` (or strict allow-scripts policies) silently
  skip the `prepare` build on git installs. If you see "Cannot find module
  .../dist/index.js" (not an install-time error), check `npm config get
  ignore-scripts` and ensure it's false.
- **Kiosk binary name**: current Raspberry Pi OS ships `chromium`; older images
  use `chromium-browser`. Check which exists with `which chromium chromium-browser`
  and update the autostart command accordingly.
- **Screen blanking on Wayland**: raspi-config's Screen Blanking option
  historically targets X11. Under Wayland (labwc/wayfire), behavior varies by
  release—verify the blanking state on your device after enabling/disabling.
