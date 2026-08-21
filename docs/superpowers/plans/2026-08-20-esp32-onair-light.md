# ESP32 On-Air Light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** A DIY ESP32 on-air light that the existing on-air API drives over the LAN, with a
**genuine `confirmed`** read from the device - retiring D-12's "`confirmed` stays unknown"
consequence. Firmware is ESPHome YAML, deployed over OTA by an agent.

**Research (authoritative, read it first):** `docs/research/2026-08-20-esp32-diy-light.md`.
Supersedes nothing; it reopens the hardware question that
`docs/research/2026-08-10-onair-light-hardware-slate.md` (issue #1) closed.

**Hardware:** ELEGOO ESP-32 Super Starter Kit (EL-KIT-032), DOIT ESP32 DevKit V1, 30-pin,
USB-C, CP2102. Plus **$13.40**: NeoPixel Stick 8 (Adafruit 1426), 74AHCT125 level shifter
(1787), black LED diffusion acrylic (4749).

**Tech stack:** ESPHome (Python venv, its own toolchain) for firmware; TypeScript
(Node >= 22, ESM, `.js` import extensions) for the driver side.

## Global constraints

- **Zero production npm dependencies.** The driver is `fetch` + `AbortSignal.timeout`. No
  new devDependencies either. ESPHome lives in `~/.esphome-venv`, never in `package.json`.
- Before every commit: `npm test` AND `npx tsc --noEmit` must both pass. tsx strips types,
  so tests alone never prove compilation.
- **A driver failure maps to `'unknown'`, never `'off'`.** Timeout, non-2xx, malformed body
  - all `'unknown'`. This is the false-OFF invariant in code form and it gets its own test.
- **`firmware/secrets.yaml` is gitignored from the first commit.** The repo is PUBLIC and
  acceptance transcripts get posted to issues. Grep every transcript for the SSID and OTA
  password before `gh issue comment`.
- `firmware/` is a **leaf**: nothing in `src/` reads it, nothing in it reads `src/`. The
  wire contract lives in `docs/api-contract.md` so it survives the eventual repo split.
- Two ESPHome YAML lines are mandatory and are **not** defaults:
  `restore_mode: RESTORE_DEFAULT_OFF` and `power_save_mode: NONE`. Both guard false OFF.

## Phase and attendance summary

| Phase | Effort | Needs Rocket's hands? |
|---|---|---|
| 0 - board identity + any LED over HTTP | 60-90 min | **Yes** - plug in the board, maybe hold BOOT |
| 1 - Node driver, poll, decay, `/register` | ~2 h | Only a 30-second unplug/replug |
| 2 - a light the room can see | ~30 min + shipping | **Yes** - wiring |
| 3 - failsafes + provisioning | ~2 h | **No** - fully OTA |
| 4 - soak, docs, decisions | ~1 h + 48 h elapsed | No |
| 5 - optional: enclosure, CI, repo split | open | Enclosure yes |

**After Phase 0 the board never needs to be touched again** - every later firmware change
is OTA.

---

## Phase 0 - Tonight, with what is in the box

**Goal:** close the three biggest unknowns - board identity, CP2102 enumeration, and *any*
LED responding to an HTTP call - and prove OTA works before we depend on it.

**Files:** create `firmware/onair-light.yaml`, `firmware/secrets.yaml` (gitignored),
`firmware/secrets.yaml.example`; modify `.gitignore`.

### Steps

```bash
# 1. Rocket: plug the board in with a DATA USB-C cable.
#    (A charge-only cable is the #1 cause of "no port appeared".)
ls /dev/cu.*
system_profiler SPUSBDataType | grep -i -A6 "CP210\|Silicon Labs\|CH34"

# 2. Toolchain into a venv. Never pip install into system Python.
python3 -m venv ~/.esphome-venv
~/.esphome-venv/bin/pip install --upgrade esphome esptool
~/.esphome-venv/bin/esphome version

# 3. Board identity - the ten-second question every research segment left open.
PORT=$(ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART 2>/dev/null | head -1); echo "$PORT"
~/.esphome-venv/bin/esptool --port "$PORT" flash-id     # note: hyphens, not flash_id
~/.esphome-venv/bin/esptool --port "$PORT" chip-id
~/.esphome-venv/bin/esptool --port "$PORT" read-mac
```

`firmware/onair-light.yaml`:

```yaml
esphome:
  name: onair-light
esp32:
  board: esp32doit-devkit-v1
wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
  power_save_mode: NONE           # ESP32 default is LIGHT - buffers inbound to DTIM
  ap: { ssid: "onair-fallback" }
captive_portal:
logger:
  level: INFO                     # drop to WARN before capturing a public transcript
ota:
  - platform: esphome
    password: !secret ota_password
web_server:
  port: 80
output:
  - platform: gpio
    pin: GPIO2                    # onboard LED; strapping pin, LED-to-GND is the safe direction
    id: led_out
light:
  - platform: binary
    name: "onair"                 # lowercase, no spaces - avoids URL-encoding in the driver
    id: onair
    output: led_out
    restore_mode: RESTORE_DEFAULT_OFF   # default is ALWAYS_OFF
```

```bash
# 4. First flash MUST be over serial.
~/.esphome-venv/bin/esphome run firmware/onair-light.yaml --device "$PORT"
#    Ctrl-C out of the log view once it prints the IP. esphome logs has NO timeout flag -
#    never leave it in an agent's foreground.

# 5. The acceptance transcript.
IP=192.168.x.y
curl -s -m 2 http://$IP/light/onair                 # expect "state":"OFF"
curl -s -m 2 -X POST http://$IP/light/onair/turn_on
curl -s -m 2 http://$IP/light/onair                 # expect "state":"ON"
curl -s -m 2 -X POST http://$IP/light/onair/turn_off
curl -s -m 2 http://$IP/light/onair                 # expect "state":"OFF"

# 6. Prove OTA works before you need it.
~/.esphome-venv/bin/esphome run firmware/onair-light.yaml --device $IP --no-logs
```

### Acceptance

All four: (i) `flash-id`/`chip-id` output pasted, settling the module revision and flash
size; (ii) the five-curl `OFF -> ON -> OFF` transcript; (iii) a photo or 5-second video of
the LED changing; (iv) a successful `--device <IP>` OTA run. Repo code is untouched, so run
`npm test` and `npx tsc --noEmit` and paste them anyway, per the bar.

### What could go wrong

No `/dev/cu.usbserial-*` -> almost always a charge-only cable, then a CH340 instead of a
CP2102 (macOS ships `AppleUSBCHCOM` too, so still no driver install). **Do not install the
Silicon Labs VCP driver on Apple Silicon.** Some DevKit V1 clones need BOOT held during
`esptool` connect. Whether this clone has an onboard LED on GPIO2 is unresolved - fallback
is a 5 mm LED on **GPIO4** through a 220 Ω resistor to GND (~6 mA, well inside spec). Do
not use GPIO12 (bricks boot), GPIO34-39 (input only), or GPIO5 (strapping - Elegoo's own
tutorial uses it anyway).

---

## Phase 1 - The Node side: `read()`, poll, decay, `POST /register`

**Goal:** make `confirmed` real. Fully unattended except a 30-second unplug/replug.

**Files:** modify `src/driver.ts`, `src/state.ts`, `src/server.ts`, `src/app.ts`,
`test/server.test.ts`, `test/state.test.ts`, `docs/api-contract.md`.

### Task 1.1 - `LightDriver.read?()` and `EsphomeLightDriver`

`src/driver.ts:3-5` today is `set()` only. Add an **optional** `read?()` - optional is the
right shape because it keeps `NoopDriver` (`src/driver.ts:7-14`) and its existing test valid
with zero edits.

```ts
export interface LightDriver {
  set(onAir: boolean): Promise<Confirmed>;
  /** Genuine device read. Absent = no feedback available; confirmed stays "unknown". */
  read?(): Promise<Confirmed>;
}

export class EsphomeLightDriver implements LightDriver {
  constructor(private readonly base: string, private readonly timeoutMs = 2000) {}

  async set(onAir: boolean): Promise<Confirmed> {
    try {
      const r = await fetch(`${this.base}/light/onair/${onAir ? 'turn_on' : 'turn_off'}`, {
        method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) return 'unknown';
      return await this.read();      // ESPHome's POST body is empty - second round trip
    } catch { return 'unknown'; }
  }

  async read(): Promise<Confirmed> {
    try {
      const r = await fetch(`${this.base}/light/onair`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) return 'unknown';
      const j = (await r.json()) as { state?: string };
      return j.state === 'ON' ? 'on' : j.state === 'OFF' ? 'off' : 'unknown';
    } catch { return 'unknown'; }
  }
}
```

Config: `ONAIR_LIGHT_URL` selects `EsphomeLightDriver`; absent keeps `NoopDriver`. Follow
the existing `src/config.ts` pattern.

**Tests first:** a timeout maps to `'unknown'`; a 500 maps to `'unknown'`; `{"state":"BOGUS"}`
maps to `'unknown'`; `{"state":"ON"}` maps to `'on'`. **No input ever produces `'off'` except
a literal `"OFF"`.**

### Task 1.2 - `confirmedAt` and lazy decay

`StateStore` gains a **memory-only** `confirmedAt: number | null`, set by `setConfirmed()`
(`src/state.ts:51-54`). **Do not add it to `OnAirState`** - that keeps `isOnAirState`
(`src/state.ts:16-27`) unchanged and every state file already on disk valid.

`statusBody` (`src/server.ts:126-128`) computes decay lazily, mirroring how `ageSeconds` is
already computed on read: if `now - confirmedAt > 30_000`, report `confirmed: 'unknown'`
regardless of the stored value. Tests inject a clock - `StateStore` already takes `now`
parameters (`src/state.ts:40,66`).

It propagates for free: `statusBody` *is* the SSE snapshot closure (`src/server.ts:275`) and
`src/sse.ts:34-40` re-invokes it every 15 s, so an idle `/display` self-corrects within one
heartbeat with no extra code. Same for the WS bridge (`src/server.ts:102`).

Timings reuse ratios the repo already proved: **10 s poll, 30 s decay** (3x), against the
existing 15 s SSE heartbeat and 45 s display watchdog (`src/display.ts:45`).

### Task 1.3 - The poll loop

A background `setInterval(10_000)` in `createApp`, **`.unref()`ed** - matching
`src/sse.ts:41`. It calls `driver.read?.()`, writes through `store.setConfirmed()`,
broadcasts **only on change**, and **re-asserts `driver.set(intended)` when the read
disagrees with `intended`**. That re-assert is what recovers a device reboot within 10 s.

**Not from `GET /status`.** `statusBody` is used in three places - `/status` (`:240`), the
SSE snapshot (`:275`), and the WS upgrade snapshot (`:102`). Awaiting a device round trip
there would fire one device request per SSE client per 15 s heartbeat, plus one per WS
client, plus one per `/status` call - each with a 2 s timeout when the device is off.

### Task 1.4 - `POST /register`

Three edits that **must move in lockstep**:

1. `ROUTES` (`src/server.ts:27-38`) gains `'/register': ['POST']`, or the exact-match 404
   branch (`:222-226`) rejects it.
2. **`willReadBody` (`src/server.ts:236`)** must be extended. The code's own comment at
   `:233-235` warns that a body-reading route missing from this list makes `req.resume()`
   eat the body - a silent empty-body failure.
3. **Keep it off `enqueueWrite`** (`:53-57`): it persists no on-air state, so a 30 s device
   heartbeat must never queue behind a slow disk write.

Body is `{"id":"onair-light-1"}`. **The server takes the address from
`req.socket.remoteAddress`, not from the body** - that is what removes the last lambda from
the firmware and all discovery from the critical path.

### Acceptance

`npm test` + `npx tsc --noEmit`, plus this live transcript with the board up:

```bash
npm start &
curl -s localhost:8484/on     | jq '{intended,confirmed}'   # -> on / on   (a device read)
curl -s localhost:8484/status | jq '{intended,confirmed}'
# Rocket unplugs the ESP32:
sleep 35; curl -s localhost:8484/status | jq '{intended,confirmed}'  # -> on / unknown, never "off"
# Rocket plugs it back in:
sleep 40; curl -s localhost:8484/status | jq '{intended,confirmed}'  # -> on / on  (re-asserted)
```

Plus a regression test that `POST /register` alters neither `intended` nor `updatedAt`.
**The unplug/replug line proves the whole premise** - it is the divergence an echo of the
last write can never see.

### Why this does not violate D-6

D-6's no-TTL is scoped to `intended`; decay produces `unknown` and only `unknown`, never
touches `updatedAt` or the persisted file, and cannot darken the display
(`src/display.ts:80` branches on `intended`). And `docs/api-contract.md:14` already *demands*
`unknown` when the light is unreachable while no current code path can deliver it -
`setConfirmed` is called only from `src/app.ts:31,34` and `src/server.ts:168`. This closes a
live gap. **Amend D-6 in writing anyway** (Phase 4).

---

## Phase 2 - A light the room can see

**Goal:** replace the indicator LED with something readable across a room. **Order the parts
on Phase-0 night so shipping overlaps the software work.**

**Wiring:** ESP32 `GPIO18` -> 74AHCT125 input; shifter output -> stick `DIN`; stick `5V` ->
board `VIN` (the USB 5 V rail); common ground. 8 pixels at half-brightness red is ~72 mA,
inside what USB supplies through `VIN`. **Do not drive the strip from `3V3`.**

**Firmware delta - still no C++:**

```yaml
light:
  - platform: neopixelbus          # or: esp32_rmt_led_strip
    type: GRB
    variant: WS2812
    pin: GPIO18
    num_leds: 8
    name: "onair"
    id: onair
    restore_mode: RESTORE_DEFAULT_OFF
    effects: [ pulse: ]
```

Deploy with `esphome run firmware/onair-light.yaml --device $IP` - **OTA, no USB.**

**Acceptance:** the same five-curl transcript against the new build, plus a photo of the
diffused stick lit red in a normally-lit room **taken from where Rocket's family actually
stands**. "Is it visible from the doorway" is the criterion, not "does `state` say ON". Note
the `GET` response for a colour light also carries `brightness`/`color` - the driver must
keep reading `state` only.

**What could go wrong:** skipping the level shifter (works today, fails when the cable or
temperature changes - WS2812B `VIH` is 3.5 V at 5 V, above the ESP32's 3.3 V); powering the
stick from `3V3`; substituting a strapping or input-only pin for GPIO18.

---

## Phase 3 - Failsafes and provisioning

**Goal:** correct behaviour when the network, the server, or power fails. Fully unattended
over OTA.

Adds the registration heartbeat and the 3-miss failsafe. `web_server` exposes **no "request
arrived" trigger**, so staleness is measured from the device's own outbound heartbeat -
which does have `on_response` / `on_error` hooks. **Two one-line lambdas, the only C++ in the
project:**

```yaml
globals:
  - id: missed
    type: int
    initial_value: '0'

interval:
  - interval: 30s                        # heartbeat + registration, one mechanism
    then:
      - http_request.post:
          url: http://onair.local:8484/register
          request_headers: { Content-Type: application/json }
          json: { id: "onair-light-1" }
          on_response:
            - globals.set: { id: missed, value: '0' }
          on_error:
            - lambda: 'id(missed)++;'
  - interval: 10s
    then:
      - if:
          condition:
            lambda: 'return id(missed) >= 3;'
          then:
            - light.turn_on: { id: onair, effect: "Pulse" }   # hold ON, degrade visibly
```

Also add `wifi: on_connect:` firing the same registration (fires on every reconnect, when
the IP may have changed), `captive_portal:` so credentials change without a reflash, and
`web_server: auth:` with `type: basic` if Rocket wants it - **not digest**, which costs ~40
lines of hand-rolled MD5 in the driver for no gain on a LAN.

**Fail-safe direction:** hold last state and degrade visibly. STAC fails to green / "not on
air", which is exactly backwards for `CONTEXT.md:67`; copy Tally Arbiter's hold-last-state.

### Acceptance - four transcripts, none needing hands at the board

1. Kill `npm start`, wait 100 s -> photo/video of the light **still ON and pulsing**, never
   dark. This is the false-OFF invariant, demonstrated.
2. Restart the API -> the pulse stops within one heartbeat.
3. Power-cycle the board with `intended: on` -> the poll loop's mismatch re-assert turns it
   back on within 10 s; `GET /status` transcript across the gap.
4. `esphome run --device $IP` deploys a change with the board never leaving the shelf.

**What could go wrong:** test 1 covers the API dying, not Wi-Fi dying -
`wifi.reboot_timeout` (default 15 min) still applies. Run a separate test with the AP off
for 20 minutes if Rocket wants that covered, and decide `reboot_timeout` then (open question
5 in the research doc).

---

## Phase 4 - Soak, docs, decisions

48-hour soak with the light on the shelf; a script sampling `GET /status` every 60 s into
`tmp/soak.log`. **Acceptance: zero `confirmed: "off"` while `intended: "on"`**, and the
count of `unknown` intervals reported honestly rather than hidden.

Then:
- `docs/api-contract.md` gains a "Device protocol" section and the `confirmed` decay rule.
- `CONTEXT.md` gains **D-16..D-19** plus the **D-6 and D-12 amendments** (drafted in
  `docs/research/2026-08-20-esp32-diy-light.md` §7).
- `docs/firmware-setup.md` gains the ESPHome install + first-flash + OTA runbook, mirroring
  `docs/pi-setup.md`'s role.
- `CLAUDE.md` gains a firmware section: never foreground a serial monitor, never guess the
  port, never erase flash, always redact transcripts before posting.
- Log free heap after Phase 2 and record it (`web_server`'s ESP32 cost is unpublished).

---

## Phase 5 - Optional, later

- **Enclosure** with "ON AIR" lettering. Rocket owns Elegoo printers, this environment has a
  `cad` skill, and Elegoo publishes a `.step` of this exact board.
- **CI**: `esphome/build-action` compiles the YAML on push - cheap, no token.
- **Repo split**: `git subtree split -P firmware -b esp32-firmware`, push as the root of the
  new ESP32 repo, delete `firmware/` here, leave a pointer in `docs/firmware-setup.md`.
  History preserved, no filter-branch. **Not a submodule** - that would put a second
  checkout in the path of D-15's one-line installer.
- **Buy one Athom Tasmota plug or WLED Slim ($11.85-$14.35) as the *second* light** - it
  validates that `LightDriver` survives two different devices, which is the whole point of
  having an interface. **Not now:** buying it now is how the DIY build quietly never happens.

---

## Rejected, so it does not get re-proposed

- **Flashing WLED onto the DevKit V1.** Gives up the contract while keeping every DIY cost,
  and its OTA is a browser file-upload behind a checkbox - the least scriptable in the field.
  If you want zero firmware, the $11.85 Athom ships assembled and is strictly better.
  Dominated in both directions.
- **Wokwi as the primary loop.** Reaching a localhost API needs the paid Private Gateway and
  is inexpressible in `wokwi-cli` regardless. Keep `wokwi-cli mcp` (`wokwi_read_pin`) in mind
  as an optional extra.
- **ESPHome `host` as "the firmware, tested".** `web_server` does not compile on host and
  host GPIO is a logging stub. It tests the **outbound half only** - label
  `firmware/host-test.yaml` accordingly.
- **MQTT, ESP32-as-SSE-client, WebSocket.** See the research doc §5.
