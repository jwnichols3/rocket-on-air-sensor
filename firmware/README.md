# firmware

The ESPHome configuration for the on-air panel - an Elegoo ESP32 devkit driving an
SH1106 128x64 OLED.

Imported here by **D-37** from [`jwnichols3/rocket-esp32`](https://github.com/jwnichols3/rocket-esp32)
as **files, not history**: that repo was set up as a lab and stays one, unarchived. Its log
is a toolchain log, not this project's provenance.

## Setup

```sh
make -C firmware setup                     # uv sync - creates .venv with esphome 2026.8.0
cp firmware/configs/secrets.yaml.example firmware/configs/secrets.yaml
$EDITOR firmware/configs/secrets.yaml      # gitignored; holds the D-17 device credentials
```

## Use

```sh
npm run firmware:config                    # validate - no hardware, no flash. Part of `npm run verify`.
npm run firmware:compile                   # full build
.venv/bin/esphome upload --device <ip> configs/elegoo-esp32.yaml   # OTA flash
```

**Do not run `make -C firmware flash` or `logs` from an agent turn** - `esphome run` and
`esphome logs` tail the device with no timeout and will hang. OTA upload is the flash path.

## The ESPHome pin

`pyproject.toml` pins `esphome==2026.8.0` deliberately. The `web_server` REST URL scheme
changed in that release, and every URL in the server's driver
(`server/src/esphome-driver.ts`) is written against it. Read D-16 before moving the pin.

## The state entity

The panel's state entity is a **`text`** named `PresenceKey`, not a `select` (D-38, proven
on hardware in D-44, shipped in D-46). The device declares no set of valid states: it
renders the key it is handed and draws a conspicuous `UNKNOWN KEY` branch for one it does
not recognise.

**The panel now holds no vocabulary at all** (D-54). It pulls `GET /config/states` into RAM
and renders whatever rows that returns - there is no hardcoded row list and no `dnd` alias
left. The table is not persisted, so a fresh boot shows `NO CONFIG` until the first pull
succeeds, which is correct: a table the device cannot vouch for is exactly what that branch
is for.

## The device's own entities

All of these are at the device's IP on port 80, behind the `web_server` basic auth (D-17).

| Entity | What it is |
|---|---|
| `text/PresenceKey` | the state key, written by the server |
| `text/TableVersion` | the version nudge, written by the server (D-42) |
| `text/ServerHost`, `number/ServerPort` | where to pull the table from |
| `text/ServerPassphrase` | **write-only.** Reads back `********` - see below |
| `switch/AutoProfile` | on = follow the server, off = freeze the table last pulled |
| `button/RefreshProfile` | "Refresh profile from server". Pulls even when frozen |
| `text_sensor/ConfigPull` | `version:rows:ok:failed`, for checking the pull from a shell |
| `text_sensor/RowLabel`, `text_sensor/RowColor` | the current row as pulled |
| `text_sensor/Render` | which SHAPE the display lambda drew |

`ServerHost`, `ServerPort` and the passphrase persist across reboots and across a reflash;
the `!secret` values in `secrets.yaml` are first-boot defaults only.

### The passphrase is write-only, and that is not caution

`mode: password` masks only the `state` field in ESPHome's JSON - `value` carries the raw
string on every read. D-38 claimed otherwise; D-55 corrects it. So the passphrase is not
held in an entity at all: it lives in a preference blob (`onair_table.h`) and the entity
exists only to set it.

Change it with:

```sh
curl -u onair:<web_server_password> -d '' \
  "http://<device>/text/ServerPassphrase/set?value=<new passphrase>"
```

A change takes effect at once and triggers a pull, so `text_sensor/ConfigPull` tells you
within a few seconds whether the new value works.
