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

## The two pages the device serves

Point a browser at the panel's IP (#33, D-57):

| Path | Auth | What it is |
|---|---|---|
| `/onair` | **none** | what the panel is showing, and why |
| `/onair/config` | device basic auth | the local presentation overrides |
| `/` | device basic auth | ESPHome's stock dashboard, untouched |

`/onair` is deliberately open and deliberately read-only: it shows no credential of any
kind and offers no control that changes anything. It reports the same answer the glass is
showing, because both call the same `compute_view()` in `onair_table.h` - a status page
that could be calm about something the panel was not would be worse than no status page.

"Configure" is a link, and the login is the browser's own credential prompt rather than a
styled form. That is `add_handler()` doing its job: the page inherits `web_server`'s auth
instead of implementing a second one. A real form would mean a session and a cookie, and
D-23's CSRF objection with them, on a device that has no CSRF defences.

### What a local override is, and is not

**Presentation only, and an overlay rather than a copy of the table.** `label`, `color` and
`bgcolor` can be overridden per row; `busy` and row membership cannot, and are not fields
the overlay has. `busy` drives THE BUSY RULE on the glass (D-32) - an override that could
set a busy row calm would draw a false OFF - and the server is what addresses a state, so a
row invented here could never be selected.

The panel keeps pulling while overrides are in place, so a row the server adds next month
arrives with the server's own look and needs nothing done to it. Leave a field blank to
follow the server.

**The overlay persists; the pulled table still does not.** A boot with no successful pull
shows `NO CONFIG` whether or not overrides exist - an overlay is not a vocabulary.

**A colour edit can change the SHAPE a calm row draws.** The panel is 1-bit, so
`luminance(bgcolor) >= 128` is what picks between the heavy double frame and the open ring
(D-54). An edit across that line flips the picture. The page says so where colour is
edited; it is a consequence, not a bug.

## The device's own entities

All of these are at the device's IP on port 80, behind the `web_server` basic auth (D-17).
**The login is `rocket` / `ESP32`** - the same default as the admin console (D-56). It is a
published default, not a secret; change `web_server_password` in `secrets.yaml` for a
per-device one, and set `light.password` in `~/.onair/config.json` to match.

| Entity | What it is |
|---|---|
| `text/PresenceKey` | the state key, written by the server |
| `text/TableVersion` | the version nudge, written by the server (D-42) |
| `text/ServerHost`, `number/ServerPort` | where to pull the table from |
| `text/ServerPassphrase` | **write-only.** Reads back `********` - see below |
| `switch/AutoProfile` | on = follow the server, off = freeze the table last pulled |
| `button/RefreshProfile` | "Refresh profile from server". Pulls even when frozen |
| `text_sensor/ConfigPull` | `version:rows:ok:failed:overrides`, for checking the pull from a shell |
| `text_sensor/RowLabel`, `text_sensor/RowColor` | the current row **as drawn** - local override included |
| `text_sensor/Render` | which SHAPE the display lambda drew |

`ServerHost`, `ServerPort`, the passphrase and the local overrides persist across reboots
and across a reflash; the `!secret` values in `secrets.yaml` are first-boot defaults only.

### The passphrase is write-only, and that is not caution

`mode: password` masks only the `state` field in ESPHome's JSON - `value` carries the raw
string on every read. D-38 claimed otherwise; D-55 corrects it. So the passphrase is not
held in an entity at all: it lives in a preference blob (`onair_table.h`) and the entity
exists only to set it.

Change it with:

```sh
curl -u rocket:ESP32 -d '' \
  "http://<device>/text/ServerPassphrase/set?value=<new passphrase>"
```

A change takes effect at once and triggers a pull, so `text_sensor/ConfigPull` tells you
within a few seconds whether the new value works.

**It is not offered on `/onair/config`.** A field that sets a credential and cannot show it
belongs where the rest of the write-only entity lives, and duplicating it onto a page whose
whole subject is presentation would invite exactly the confusion D-55 came out of.

## The three headers

| File | What is in it |
|---|---|
| `configs/elegoo-esp32.yaml` | the ESPHome configuration, the display lambda, the pull |
| `configs/onair_table.h` | the table, the overlay, `effective()` and `compute_view()` |
| `configs/onair_page.h` | the two web handlers |

Headers rather than an external component. D-40 argued a component was needed for a
device-served page; it was not - `web_server_base::add_handler()` registers a handler on
the server ESPHome already runs (`captive_portal` does the same in-tree).

**One thing to know before editing them.** ESPHome emits `includes:` files *after* the
block that instantiates `GlobalsComponent<T>`, so a `globals:` entry whose C++ type comes
from an include does not compile. Everything the panel holds therefore lives in
`onair::held()`, a function-local static behind an inline accessor.

**And one before adding a handler.** esp-idf runs web handlers on the httpd task, not the
ESPHome main loop. Handlers here read under `held().lock` and *stage* every write for the
main loop to apply. Nothing in `onair_page.h` touches an ESPHome component API directly,
and nothing should.
