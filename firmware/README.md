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
not recognise. The recognised triple is still hardcoded until
[#43](https://github.com/jwnichols3/rocket-on-air-sensor/issues/43) swaps in the pulled table.
