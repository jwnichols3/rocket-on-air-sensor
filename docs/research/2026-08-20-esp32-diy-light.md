# DIY ESP32 On-Air Light - Research and Verdict

2026-08-20. Triggered by a new fact: Rocket bought an **ELEGOO ESP-32 Super Starter Kit**
and wants agentic coding (Claude Code) to build and deploy the firmware. That reopens the
hardware question the 2026-08-10 slate closed (`docs/research/2026-08-10-onair-light-hardware-slate.md`,
issue #1) with an option that slate treated only as a category: build it.

Method: four parallel segment researchers - the kit and its hardware reality, a firmware
stack bakeoff, the agentic development loop, and protocol design plus prior art - then a
judge that re-verified every ranking-decisive claim against primary sources (including
ESPHome's own C++ source on `dev`), adjudicated a head-on conflict between two of the
reports, and produced the plan.

Labels used below: **[FACT]** = verified from a primary source or this repo's code on
2026-08-20. **[JUDGEMENT]** = a call, not a fact. **[UNRESOLVED]** = could not be settled.

Plan: `docs/superpowers/plans/2026-08-20-esp32-onair-light.md`.

---

## Verdict summary

| Question | Verdict |
|---|---|
| Build or buy? | **BUILD.** ESPHome on the DevKit V1 already in the box + **$13.40** of light. |
| Firmware stack | **ESPHome**, not hand-written C++. PlatformIO + Arduino is the named escape hatch. |
| Protocol | Node pushes `POST /light/onair/turn_on\|turn_off`, reads back `GET /light/onair`, polls every 10 s and re-asserts on mismatch. Device posts `{"id":"..."}` to `POST /register` on `wifi.on_connect` + every 30 s; **Node takes the device IP from `req.socket.remoteAddress`**. |
| Flash WLED on the DevKit instead? | **Rejected.** Dominated in both directions - see below. |
| Best agent loop | **Neither simulator.** Real board, flashed once over serial, thereafter OTA, verified by `curl`. |
| Biggest correction | The kit contains **no on-air light**. A 5 mm LED is a smoke test, not a light. |

### The DIY case in one line

The 2026-08-10 slate proved two tensions were structural across 17 products: **battery XOR
genuine `confirmed`**, and **battery XOR latency**. A USB-powered board whose firmware we
write is always-awake, sub-second, and honestly readable - it dissolves both at once, and
retires D-12's "`confirmed` stays `unknown`" consequence. **[JUDGEMENT]** That, plus the
fact that agent-built firmware is Rocket's stated goal rather than a tiebreaker, is why
build wins over the $11.85 Athom.

---

## 1. The kit: what is actually in the box

**[FACT] There is exactly one ESP32 starter kit in Elegoo's US catalogue** - the whole
store was enumerated via `/products.json` (6 pages x 250) and filtered on "ESP": one hit.
So there is no naming ambiguity to flag.

| Field | Value |
|---|---|
| Title | ELEGOO ESP-32 Super Starter Kit |
| SKU | **EL-KIT-032** |
| Price | **$35.99** |
| Availability at Elegoo direct | `"available": false` on 2026-08-20 (Rocket already owns one) |

Source: `https://us.elegoo.com/products/elegoo-esp-32-super-starter-kit.js` (Shopify JSON
via curl; the HTML page returns navigation chrome only) - accessed 2026-08-20.

### The board

**[FACT]** DOIT **ESP32 DevKit V1, 30-pin**, USB-C, **CP2102**, ESP32-WROOM-32 class,
4 MB flash, no PSRAM.

- PlatformIO: `board = esp32doit-devkit-v1`
- arduino-cli FQBN: `esp32:esp32:esp32doit-devkit-v1`
- **[FACT] macOS driver: none needed, and do not install one.** Checked on Rocket's own
  machine, not taken from a vendor claim: macOS 26.6.1/arm64 ships
  `com.apple.DriverKit-AppleUSBSLCOM.dext` with a personality literally named
  `DriverKit-AppleUSBSLCOM-CP2102` (VID 0x10C4 / PID 0xEA60). macOS also ships
  `AppleUSBCHCOM` for CH340 clones, so either chip enumerates driver-free.
  **Installing the Silicon Labs VCP driver on Apple Silicon is a known way to break this.**

### Parts relevant to us

| Part | Qty | Relevance |
|---|---|---|
| ESP-32 board (DevKit V1, USB-C, CP2102) | 1 | the whole point |
| 5 V relay module (`SRD-05VDC-SL-C`, 10 A 250 VAC) | 1 | **the only in-box path to room-visible light** |
| RGB LED, **common cathode** | 2 | Phase 0 smoke test |
| Plain 5 mm LEDs | 25 | Phase 0 smoke test |
| 0.96" OLED 128x64 I2C (SSD1306) | 1 | status/debug readout, not a light |
| Photoresistor (photocell) | 2 | **tier-3 `confirmed`**: aim one at the LED and read photons |
| Resistors (assorted, incl. 220 Ω / 1k / 10k) | 120 | current limiting |
| Breadboards 400-point | 2 | |
| Jumper wires M-M / F-M | 65 / 10 | |
| Power supply module (MB102-style) + 9 V battery | 1 + 1 | 6.5-9 V in, 5 V/3.3 V rails |

Plus the usual starter-kit cast that is irrelevant here: MPU-6500 IMU, HC-SR04, stepper +
ULN2003, SG90 servo, DC motor, IR RX/TX + remote, DHT11, PIR, RC522 RFID, keypad,
joystick, buzzers, 74HC595, L293D, 7-segment, tilt switch, potentiometer, thermistor.

**No WS2812/NeoPixel. No LED matrix. No LCD1602.**

### The brightness problem, quantified

**[FACT]** A 5 mm red diffused LED is ~**50 mcd** typical (Kingbright WP7113ID). One
WS2812B is **390-420 mcd**, and you would use 8 to 60 of them. That is one to two orders of
magnitude. **A 5 mm LED is a smoke test, not an on-air light** - say so plainly rather than
shipping a dim disappointment.

The relay is the only in-box path to a room-visible light, with three cautions:
1. **[UNRESOLVED]** driving a 5 V-coil module from a 3.3 V GPIO is undocumented behaviour.
2. **A crashed ESP32 de-energises the relay - which is a false OFF**, precisely the
   invariant this project exists to protect (`CONTEXT.md`).
3. Do not switch mains on a breadboard.

### Shopping list to make it real - $13.40

| Part | Price | Why |
|---|---|---|
| NeoPixel Stick 8 (Adafruit 1426) | $5.95 | the actual light |
| 74AHCT125 level shifter (Adafruit 1787) | $1.50 | **not optional** |
| Black LED diffusion acrylic (Adafruit 4749) | $5.95 | turns 8 dots into a glow |
| *(optional)* 5 V 2 A supply | $7.95 | only if you scale past a stick |

**[FACT] The level shifter is not optional:** WS2812B `VIH = 0.7 x VDD` = 3.5 V at a 5 V
supply, above anything the ESP32's 3.3 V output can produce. "It works on my bench" is the
failure that returns in six months when the cable or the temperature changes.

### GPIO gotchas on this board

**[FACT]** GPIO0 and GPIO6-11 are not broken out on the 30-pin board - two traps closed for
free. **GPIO12/MTDI is the board-bricking one** (pulled high at boot switches VDD_SDIO to
1.8 V). GPIO34-39 are input-only. **ADC2 pins (0/2/4/12-15/25-27) are dead for analog while
Wi-Fi is up** - and our device is Wi-Fi-up permanently, so any photocell read must be on
ADC1.

**Worth knowing:** Elegoo's own RGB tutorial puts LEDs on GPIO2 and GPIO5, **both strapping
pins**. Use 25/26/27 for the smoke test and GPIO18 for the NeoPixel data line.

### Power and battery

**[FACT]** Espressif ESP32 datasheet v5.3: RX **95-100 mA**, TX 180-240 mA (Table 5-4);
modem-sleep 30-68 mA, deep-sleep 10 µA (Table 4-2).

**Deep sleep is closed to us** - a sleeping device cannot be pushed to (the slate's
Tension 2) - so we pay 30-80 mA permanently. A 2500 mAh LiPo is a **~10 hour device**: a
workday, not set-and-forget. **A 10,000 mAh USB power bank is the honest answer** to "no
mains cord at the light's location". **[UNRESOLVED]** many power banks auto-shut-off below
~50-100 mA; that is a silent false-OFF generator and must be bench-tested on the specific
bank.

---

## 2. Firmware stack bakeoff

Candidates scored on agent-friendliness, status read-back, OTA, macOS CLI, Wi-Fi
resilience, off-device testability, and Node-driver cost.

**Ranking: 1. ESPHome. 2. Tasmota. 3. PlatformIO + Arduino. 4. WLED. 5. arduino-cli.
6. MicroPython. 7. ESP-IDF. 8. Rust (esp-rs). 9. Zephyr.**

### Status read-back - the decisive column

**[FACT]**, verbatim from primary sources:

| Stack | Read endpoint | What the value is |
|---|---|---|
| ESPHome | `GET /light/onair` -> `{"state":"ON"\|"OFF",...}` | the light component's own state object (`web_server.cpp:1017`, `obj->remote_values.is_on()`) |
| WLED | `GET /json/state` -> `on` | firmware output state |
| Tasmota | `GET /cm?cmnd=Power` -> `{"POWER":"OFF"}` | "Every command used without a parameter returns the current setting" |

All three are genuine reads of **firmware output state**, not echoes of the last write -
they reflect button, preset and boot-restore changes too. **None of them measure photons.**

Their real value against the invariant: after a device reboot the light comes up OFF, a
poll sees `confirmed: off` while `intended: on`, and the API re-asserts. **An echo can
never see that divergence.** Do not describe any of them to anyone as proof the LED is lit.

### Two false-OFF landmines in the defaults

**[FACT]** Both are one-line fixes and neither is the default:

- `light:` `restore_mode` defaults to **`ALWAYS_OFF`**, and `wifi:` `reboot_timeout`
  defaults to **`15min`**. Composed: the router reboots, 15 minutes later the ESP reboots,
  and the light comes up dark mid-call. Set **`restore_mode: RESTORE_DEFAULT_OFF`**.
- `power_save_mode` on ESP32 defaults to **`LIGHT`**. A power-saving station buffers
  inbound traffic to DTIM intervals - the "light reacted three seconds late" failure. Set
  **`power_save_mode: NONE`**. This board is USB-powered; there is nothing to save.

Tasmota's equivalent defaults are the opposite and are safe: `PowerOnState 3 = last saved
state` and `WifiConfig 4 = retry other AP without rebooting`.

### Why the others lost

- **ESP-IDF is disqualified on OTA** [FACT]: there is no `idf.py` verb that pushes firmware
  over Wi-Fi. You compile `esp_https_ota()` into the app and host the binary yourself.
- **Rust (esp-rs)** needs a forked rustc via `espup` (ESP32 is Xtensa), and Espressif's own
  book says `esp-hal` "may break your project with a simple `cargo update`".
- **MicroPython** removes the compiler - the exact feedback channel D-8 chose Node+TS *for*.
- **Tasmota** bends a relay abstraction over an LED and its Rules DSL is worse to author
  and impossible to test - but it is the honest "working tonight, zero firmware" answer.
- **WLED** is right only if the light is *only* an addressable strip, and **[FACT]** its OTA
  is a browser file-upload behind an "OTA locked" checkbox - the least scriptable in the
  field. The web installer also "cannot be used" from Safari.

### Node driver cost

~20 lines and zero dependencies for every stack, so this column did not discriminate.
Custom firmware wins on *shape*, not size: you could make `POST /state` return the
post-write read and get `confirmed` in one round trip. ESPHome cannot (see below).

---

## 3. The conflict, adjudicated

The firmware bakeoff ranked **ESPHome #1 precisely because it needs no C++**. The
integration research designed a protocol - `POST /state` with a JSON body, response
carrying the read-back - that **ESPHome does not literally speak**. The judge checked all
four sub-questions against esphome.io and ESPHome's source on `dev`.

**[FACT] The conflict is real but shallow - a vocabulary mismatch, not a capability gap.**

| Sub-question | Answer |
|---|---|
| Can `web_server` serve the read? | **Yes.** `GET /light/onair` -> `{"state":"ON"}`. And the REST layer is **not** gated on `web_server:`'s `version:` flag - `canHandle()` dispatches on domain + method only (`web_server.cpp:2329-2470`). That was the specific risk worth checking; it is clean. |
| Outbound POST on boot? | **Yes, no lambda.** `http_request.post` with a static `json:` body. And use `wifi: on_connect:` rather than `on_boot` - it fires when the link is genuinely up and **re-fires on every reconnect**, which is exactly when the IP may have changed. |
| Inbound write over plain HTTP? | **Yes, but not the specced shape.** `POST /light/onair/turn_on\|turn_off`, **query params only, no body**, and the response is `request->send(200)` - empty. **Two round trips per write.** |
| Does it force Home Assistant? | **No.** `api:` is optional, and `esphome logs` falls back to the `web_server` `/events` stream. Install is `pip install esphome`. |

**Adjudication:** every *function* the protocol needs is present; only the *ergonomics* are
lost. The cost is one extra ~5 ms LAN GET per write on a device that changes state a few
times an hour. **[JUDGEMENT] It is not worth writing and owning C++ firmware to save one
LAN round trip.**

### The honest ceiling of "ESPHome needs no C++"

**[FACT]** `web_server` exposes **no trigger for "an HTTP request arrived"** - `light:` has
`on_turn_on`/`on_state`, but those fire only on *change*, and a repeated identical push is
not a change. So the device cannot measure "time since last inbound push" in YAML.

**[JUDGEMENT] The fix inverts the evidence source:** measure staleness from the device's own
outbound heartbeat, which *does* have hooks (`on_response` / `on_error`). That costs **two
one-line lambdas** - a counter increment and a comparison - and nothing else.

So: "~20 lines of YAML, no C++" is true for the light, and off by two lambdas once the
false-OFF invariant is honoured. Stated rather than smoothed over.

### The tiebreakers that actually decided it

1. **[FACT]** It serves the protocol - all four sub-questions yes.
2. **[FACT]** The validation loop is ~1 s (`esphome config`) with YAML line numbers, versus
   a multi-minute C++ build whose failure mode is a boot loop and a backtrace.
3. **[FACT] The verification surface is HTTP, not serial.** An agent proves state changed
   with `curl -m 2 http://<ip>/light/onair`. **Every serial monitor in the field has no
   timeout flag** - verified across `pio device monitor`, `idf.py monitor`,
   `arduino-cli monitor` and `esphome logs` - and `timeout`/`gtimeout` are not installed on
   this Mac. Removing serial from the inner loop removes the single most common way an
   agent hangs a turn.
4. **[JUDGEMENT]** Wi-Fi reconnect, watchdog, brownout, safe-mode and OTA rollback are
   exactly where you manufacture a false OFF, and ESPHome's are shared across a large fleet.

**Escape hatch, to be recorded as a decision if taken:** switch to PlatformIO + Arduino if
you want one-round-trip writes, an inbound-request watchdog, or behaviour ESPHome's `light`
effects cannot express. Note tier-3 `confirmed` (photocell) is *not* a trigger - ESPHome
exposes it as `GET /sensor/onair_lux`.

---

## 4. The agentic development loop

### Wokwi - confirmed, and narrower than it looks

- **[FACT] `wokwi-cli mcp` is real and first-party**: MIT, "experimental", 11 tools
  including **`wokwi_read_pin`** (returns level *and* voltage, e.g. `Pin D2 on esp: 1
  (3.3V)`), `wokwi_read_serial`, `wokwi_take_screenshot`. Combined with `expect-pin` in
  scenario YAML this is a literal answer to "an agent can't see an LED light up".
  `WOKWI_CLI_TOKEN` is mandatory.
- **[FACT] Reaching a localhost API from the sim needs the paid Private Gateway** (Hobby
  €5.6/mo+): the public gateway is outbound-only, and `host.wokwi.internal` is Private-only.
- **[FACT] And `wokwi-cli` cannot express it anyway** - `WokwiConfig.ts` has no `net` key
  and `simulate.ts` has no gateway handling. `[[net.forward]]` is a **VS Code-only** feature.
- **[UNRESOLVED]** whether interactive MCP use burns CI minutes; Wokwi's docs and pricing
  page disagree on minute allocations. Do not budget on either number.

### ESPHome `host` platform - half confirmed, half refuted

The agentic-loop research called this "the sleeper answer to the localhost question". The
judge checked it component by component:

| Sub-claim | Verdict |
|---|---|
| Compiles and runs natively on macOS | **CONFIRMED** - "known to work on MacOS and Linux". No Linux needed. |
| No `wifi:` needed, uses the host's network | **CONFIRMED** |
| `http_request` available on host | **CONFIRMED** (source: `PLATFORM_HOST`, `http_request_host.cpp`) |
| **`web_server` available on host** | **REFUTED** - `cv.only_on([ESP32, ESP8266, BK72XX, LN882X, RP2, RTL87XX])`, **no `PLATFORM_HOST`** |
| GPIO/light on host | **compiles, means nothing** - `digital_write` only calls `ESP_LOGD`; `digital_read` returns `inverted_`, never what was written |

**So `host` proves the outbound half only** - registration and heartbeat against the real
`:8484`. Label `firmware/host-test.yaml` as exactly that. It is not "the firmware, tested".

### The conclusion neither report reached

**[JUDGEMENT] Neither simulator gives an end-to-end loop, and on the ESPHome path you do
not need one.** Wokwi proves the pin but cannot reach the API; `host` reaches the API but
has neither the pin nor the web server. The real board is *better* than either for agent
work:

```
edit YAML -> esphome config (~1 s) -> esphome compile ->
esphome run --device 192.168.x.y   # OTA: no USB, no human
curl -m 2 -X POST http://192.168.x.y/light/onair/turn_on
curl -m 2 http://192.168.x.y/light/onair      # -> {"state":"ON",...}
```

Unattended, free, no token, a natural timeout on every command, and it never touches a
serial port. **Wokwi and `host` are optional extras, not the plan.** This inverts the
agentic-loop research's phase ordering, which put simulation first because it assumed a C++
workflow whose verification surface is serial.

### Other findings worth keeping

- **[FACT] `esptool` was renamed** - it is `esptool` with hyphenated subcommands
  (`write-flash`, `flash-id`), not `esptool.py write_flash`. Old snippets are stale.
- **[FACT] Machine state checked 2026-08-20:** arm64 macOS 26.6.1; none of pio, arduino-cli,
  esptool, esphome, idf.py or wokwi-cli installed; no board plugged in.
- **CI**: PlatformIO publishes no official action (pip + cache is the documented path);
  `arduino/compile-sketches` is actively maintained; `espressif/esp-idf-ci-action` and
  `arduino/setup-arduino-cli` are dormant. `esphome/build-action` compiles YAML on push.
- **Serial-port MCP servers: none credible.** The candidates found have 1-2 stars, or are a
  dormant PoC (`horw/esp-mcp`, 155 stars). Reported honestly rather than laundered.
- **QEMU is out** - no Wi-Fi, no GPIO matrix, and "Espressif does not provide support for
  QEMU". **Renode is out** - ESP32 is a community contribution, no Wi-Fi.
- **~70-75% of the interesting logic is off-target testable** (an estimate, flagged as such)
  via `pio test -e native` + Unity - but only on the PlatformIO path, and only if the logic
  never includes `Arduino.h`.

---

## 5. Protocol design and prior art

### Options evaluated

| Option | Verdict |
|---|---|
| **(a+) Server pushes; device serves a read; device registers on boot** | **RECOMMENDED** |
| (c+) Device holds our existing `GET /events` SSE stream, reports via `POST /confirm` | **Second choice** |
| (b) Device polls us (STAC / Roland Smart Tally shape) | sacrifices the independent read for a battery capability a USB-powered board does not need |
| (d) WebSocket | (c) with a harder client, and `/events/ws` discards inbound data by D-11's design |
| (e) MQTT + broker | a production dependency and a second source of truth - against D-11 |

**The integration researcher's recommendation flipped mid-research, and the reason is
recorded:** (c+) was ahead because the push half already exists and is tested (`src/sse.ts`),
reboot recovery is already correct (`src/sse.ts:32` snapshots on connect), and the
addressing problem evaporates. Two facts outweighed that:

1. **[FACT] Nobody does SSE on an ESP32 client.** Scans of the Arduino Library index
   (53,263 libraries) and the PlatformIO registry each found exactly one SSE *client*
   library - 0 stars, four months old, ESP8266-only. Every other hit is an SSE *server*.
2. **[FACT] "Device runs an HTTP server with a readable `GET /state`" is the trodden path** -
   four independent projects, one (`HipsterBrown/on-air-light`, MIT) with the identical
   offline-first, no-cloud premise.

**The judge's one change to the design: drop `ip` from the registration body.** Node already
has the address from `req.socket.remoteAddress`. That removes the last lambda from the
firmware *and* all discovery from the critical path.

### Addressing

**[FACT] mDNS works from Node, but only through the right resolver** - measured on this Mac:
`dns.lookup()` (getaddrinfo -> mDNSResponder) resolves `.local`; `dns.resolve4()` (c-ares)
returns ENOTFOUND and never will. Global `fetch` uses `dns.lookup`, so
`fetch('http://onair-light.local/state')` works - but any code that hand-rolls `dns.resolve4`
first would silently break.

**[JUDGEMENT] Ranked least- to most-fragile:** device-initiated registration (no discovery
protocol at all) > static DHCP reservation for the *receiver* as a floor > mDNS as a
fallback resolution path only. If mDNS is used at all, use it in the direction where the
**mature** implementation is the responder - device querying Avahi/mDNSResponder, not the
reverse. The ESP32's responder is the weakest in the system, and Wi-Fi power save drops
multicast frames.

### Prior art worth stealing from

| Project | License | What to take |
|---|---|---|
| `HipsterBrown/on-air-light` | MIT | closest premise - offline-first, no cloud, device HTTP server |
| `josephdadams/TallyArbiter` | MIT (monorepo) | listener registration + liveness map; **hold-last-state on disconnect** |
| `wifi-tally/wifi-tally` | MIT | `lastTallyReport: Map<string, Date>`, "emits signals when tallies connect, go missing or disconnect" |
| `Xylopyrographer/STAC` | **CC BY-NC-SA 4.0 - not a software license** | **read, do not copy.** Best protocol reference in the field |
| WLED `/json/state`, AWTRIX `/api/stats` | - | contract shapes to imitate |

**[FACT] Two license hazards:** STAC is CC BY-NC-SA (read-only for us), and both archived
`TallyArbiter-M5*Listener` repos have **no license at all** - use the MIT monorepo.

**[FACT] Fail-safe direction is a real fork, and two mature projects chose opposite
defaults without reasoning about it.** STAC deliberately fails to green / "not on air" -
exactly backwards for `CONTEXT.md:67`. **Copy Tally Arbiter's hold-last-state instead, plus
a visible degradation blip.**

---

## 6. What changes in this repo

### `src/driver.ts` - the interface

Today (`src/driver.ts:3-5`) is write-only with no read:

```ts
export interface LightDriver {
  set(onAir: boolean): Promise<Confirmed>;
}
```

Add an **optional** `read?()`, which keeps `NoopDriver` (`src/driver.ts:7-14`) and its test
valid with zero edits, and add an `EsphomeLightDriver` (~20 lines, zero dependencies,
`fetch` + `AbortSignal.timeout`).

**The rule that must have its own test:** a timeout, a non-2xx, or a malformed body maps to
`'unknown'` and **never** to `'off'`. `src/server.ts:164-167` already gets this right for
`set()`.

### Who polls

**A background `setInterval` in `createApp`, 10 s, `.unref()`ed** - matching `src/sse.ts:41`.
It reads, writes through `store.setConfirmed()`, broadcasts only on change, and **re-asserts
`driver.set(intended)` when the read disagrees with `intended`**.

**[FACT] Not from `GET /status`.** `statusBody` (`src/server.ts:126-128`) is used in three
places - the `/status` handler (`:240`), the SSE snapshot closure (`:275`) and the WebSocket
upgrade snapshot (`:102`). Making it await a device round trip would fire one device request
per connected SSE client per 15 s heartbeat, plus one per WS client, plus one per `/status`
call - each with a 2 s timeout when the device is off.

### `confirmed` decay, and why it does not violate D-6

`StateStore` gains a **memory-only** `confirmedAt` (not part of `OnAirState`, so
`isOnAirState` and every state file already on disk stay valid). `statusBody` computes decay
lazily: older than 30 s -> report `unknown`.

The argument was checked independently against the contract and the code, and it holds:

1. **[FACT]** D-6's no-TTL is scoped to on-air state. `docs/api-contract.md:20-22`: "only an
   explicit write turns the light off." The object that turns the light off is `intended`,
   which decay never touches.
2. Decay produces `unknown`, never `off` - an admission of ignorance, not a claim of darkness.
3. **[FACT]** Decay cannot darken the light: `src/display.ts:80` is
   `var on = s.intended === 'on';`. The display never reads `confirmed`.
4. **[FACT]** `setConfirmed` (`src/state.ts:51-54`) deliberately does not touch `updatedAt`,
   so confirm traffic can never reset `ageSeconds` or clear the stale badge.
5. **[FACT] The contract already demands it, and today no code can deliver it.**
   `docs/api-contract.md:14` defines `confirmed` as `unknown` when the light is unreachable
   - "never guessed" - yet `setConfirmed` is called only from `src/app.ts:31,34` and
   `src/server.ts:168`, so **once `set()` returns `'on'` the field is frozen until the next
   write.** That is a live gap against the written contract, not a new risk.
6. **[FACT]** `persistCurrent` (`src/server.ts:130-133`) already pins the *persisted*
   `confirmed` to `unknown` - the field is already modelled as ephemeral evidence.

**[JUDGEMENT] Amend D-6 in writing anyway**, or this gets re-litigated in three months.

### `POST /register` - three edits that must move in lockstep

1. `ROUTES` (`src/server.ts:27-38`) gains `'/register': ['POST']`, or the exact-match 404
   branch (`:222-226`) rejects it.
2. **`willReadBody` (`src/server.ts:236`) must be extended.** The code's own comment at
   `:233-235` warns that adding a body-reading route without updating it makes
   `req.resume()` eat the body - a silent empty-body failure.
3. **Keep it off `enqueueWrite`** (`:53-57`) so a 30 s device heartbeat never queues behind
   a slow disk write.

### Secrets, and the public-repo hazard

**[FACT] The repo is PUBLIC** (`gh repo view` -> `"visibility":"PUBLIC"`) and this repo's
acceptance ritual **posts real transcripts to GitHub issues**. So:

- `firmware/secrets.yaml` holds `wifi_ssid`, `wifi_password`, `ota_password`. **Gitignored
  from commit one.** Add `firmware/secrets.yaml`, `firmware/.esphome/`, `firmware/*.bin` to
  `.gitignore` - the current file covers `.env`, `tmp/`, `*.log`, none of these.
- Capture acceptance transcripts with `logger: level: WARN`, and make "grep the transcript
  for the SSID and OTA password before `gh issue comment`" an explicit checklist step.
- **[FACT] The ESPHome path is materially safer than PlatformIO here:** PlatformIO's
  documented secrets mechanism is `-D` build flags, which are **compiled into the binary in
  plaintext** (`strings firmware.bin | grep -i ssid`).
- If Rocket enables D-7 auth, the device carries `ONAIR_TOKEN` in plaintext flash. That is
  consistent with D-7's LAN-only threat model, but write it down.

### Repo layout, and a painless split later

```
firmware/
  onair-light.yaml        # the device firmware
  host-test.yaml          # ESPHome host platform: outbound half only (no web_server)
  secrets.yaml            # GITIGNORED
  secrets.yaml.example    # committed, placeholders
  README.md               # install, first flash, OTA, pin map
docs/firmware-setup.md    # the runbook (mirrors docs/pi-setup.md's role)
```

Rules that cost nothing now and make the split free later: `firmware/` is a **leaf**
(nothing in `src/` reads it, nothing in it reads `src/`); the **wire contract lives in
`docs/api-contract.md`** because it survives the split in both directions; **no shared
build** - ESPHome runs from its own venv and `package.json` never learns about it. When it
moves: `git subtree split -P firmware -b esp32-firmware`, push as the root of the new repo,
leave a pointer. **[JUDGEMENT] Not a submodule** - that would put a second checkout in the
path of D-15's one-line installer for no benefit.

---

## 7. Decisions to record (proposed, pending Rocket)

- **D-16 Light hardware: DIY ESP32** (ELEGOO EL-KIT-032 DevKit V1) + WS2812B NeoPixel stick
  behind a diffuser. Amends D-12 - the hold is lifted; #1 and #6 unpark. Chosen over the
  slate's Athom WLED Slim ($11.85) because it is the only option that gets always-awake +
  sub-second push + a firmware-level `confirmed` read simultaneously, dissolving the slate's
  Tensions 1 and 2. **Explicitly rejected: flashing WLED onto the DevKit V1.** Revisit if
  the build stalls past Phase 2 - then buy the Athom.
- **D-17 Firmware stack: ESPHome**, not hand-written C++. Escape hatch: PlatformIO + Arduino
  with `pio test -e native`. Two mandatory non-default YAML lines:
  `restore_mode: RESTORE_DEFAULT_OFF` and `power_save_mode: NONE`.
- **D-18 Device protocol:** server-push + device-read + device-initiated registration, in
  ESPHome's dialect; server takes the device address from `req.socket.remoteAddress`. Two
  round trips per write is an accepted cost.
- **D-19 Firmware lives in `firmware/` in this repo** until a second ESP32 project starts or
  it exceeds ~10 files; then `git subtree split`.
- **Amend D-6:** no-TTL applies to `intended`; `confirmed` decays to `unknown` - and only
  ever to `unknown` - after 30 s without device evidence.
- **Amend D-12:** its "`confirmed` stays `unknown` (no-op driver)" clause is retired.

---

## 8. Open questions

**Before building** (all closed by Phase 0's ten-second bench checks):

1. **Board identity** - `esptool flash-id` / `chip-id`: module revision (-32 / -32D / -32E)
   and flash size. Decides whether the default partition table leaves room for OTA.
2. **CP2102 vs CH340, and does a port enumerate at all** - `ls /dev/cu.*`. macOS ships
   Apple-signed dexts for both, so the answer should be "no driver either way".
3. **Is there an onboard LED on GPIO2 on this clone?** Decides whether Phase 0 needs wiring.
4. **Does Rocket want `ONAIR_TOKEN` auth on?** If yes the device carries it in plaintext
   flash and it must be in `secrets.yaml` from the first commit, not retrofitted.

**While building:**

5. **`wifi.reboot_timeout`: keep 15 min or set `0s`?** Genuine tradeoff - default lets a
   wedged Wi-Fi stack self-heal at the cost of a brief reboot-induced dark window;
   `0s` never reboots but a wedged stack stays wedged. **[JUDGEMENT] keep the default**,
   since the 10 s re-assert makes the window small - but test it and record the answer.
6. **`web_server` heap cost on an ESP32-WROOM-32.** Docs warn it "will take up *a lot* of
   memory"; no ESP32 figure is published. Log free heap after Phase 2. **[UNRESOLVED]**
7. **Light behaviour: binary, or colours/states?** Still open at `CONTEXT.md:86`, and now
   nearly free - a NeoPixel stick gives colour for the same $5.95. Decide before Phase 2 so
   the entity shape does not churn. If colour becomes the signal, **re-check that the
   attribute encoding ON AIR is the one `GET` returns** (AWTRIX's write-only
   `POST /api/moodlight` is the cautionary tale).
8. **Does `esphome logs` print the SSID at INFO?** Check once, before any transcript is
   posted to a public issue.
9. **Power-bank auto-shutoff below ~50-100 mA.** Test the specific bank for a full workday.
   **[UNRESOLVED, not primary-sourced by anyone.]**

Two off-segment findings worth keeping, both relevant to the still-open detector question
(`CONTEXT.md:70`): the Home Assistant Companion App for macOS exposes
`binary_sensor.<mac>_camera_in_use` (a working zero-cloud detector not on the shortlist),
and one prior-art project tapes a photocell over the webcam LED for spoof-proof detection.

---

## Sources

All accessed **2026-08-20**.

**ESPHome (docs)** - https://esphome.io/web-api/ (REST schema, query-params-only POST,
`/events`) - /components/web_server/ (`version` 1/2/3, `auth`, memory warning) -
/components/http_request/ (`post`, `json:`, `on_response`, `on_error`) - /components/wifi/
(`on_connect`, `reboot_timeout` 15min, `power_save_mode` ESP32 default `LIGHT`) -
/components/light/ (`restore_mode` `ALWAYS_OFF (Default)`) - /components/esphome/ (`on_boot`
priorities) - /components/api/ (optional) - /components/host.html - /guides/cli/ (`run`,
`--device` = OTA, log fallback order) - /guides/installing_esphome/ (pip, Python >= 3.12) -
/guides/faq/ (`!secret`)

**ESPHome (source, `dev` via raw.githubusercontent.com)** -
`components/web_server/__init__.py` (`cv.only_on([...])`, no HOST) -
`components/web_server/web_server.cpp` (`canHandle`, `light_json_`, `request->send(200)`) -
`components/http_request/__init__.py` (`PLATFORM_HOST`) - `components/host/gpio.{py,cpp}`
(stub `digital_write`/`digital_read`)

**Kit / hardware** - https://us.elegoo.com/products/elegoo-esp-32-super-starter-kit.js and
`/products.json` - Elegoo tutorial ZIP packing list - Espressif ESP32 datasheet v5.3
(Tables 4-2, 5-4) - WS2812B datasheet (`VIH = 0.7 x VDD`) - Kingbright WP7113ID -
adafruit.com products 1426 / 1787 / 4749 - macOS `com.apple.DriverKit-AppleUSBSLCOM.dext`
(observed locally) - *blocked:* elegoo.com global (403), Amazon ASIN B0FR4RGDYN (bot shell)

**Other firmware** - kno.wled.ge (JSON API, OTA lock, Safari note) - tasmota.github.io/docs
(`cmnd=Power`, `PowerOnState`, `WifiConfig`) - docs.espressif.com (OTA, QEMU support
statement) - micropython.org - esp-rs book

**Toolchain / CI** - docs.platformio.org - arduino.github.io/arduino-cli -
https://docs.wokwi.com/guides/esp32-wifi (gateway table, `host.wokwi.internal`, "only
available for paying users") - https://wokwi.com/pricing - github.com/wokwi/wokwi-cli
(`packages/cli/src/mcp/WokwiMCPTools.ts`, `WokwiConfig.ts`, `commands/simulate.ts`) -
https://docs.wokwi.com/vscode/project-config (`[[net.forward]]` is VS Code only) -
github.com/marketplace/actions/... (`esphome/build-action`, `arduino/compile-sketches`)

**Prior art** - github.com/HipsterBrown/on-air-light - github.com/josephdadams/TallyArbiter -
github.com/wifi-tally/wifi-tally - github.com/Xylopyrographer/STAC (CC BY-NC-SA) -
github.com/deckerego/tally_circuitpy - github.com/AronHetLam/ATEM_tally_light_with_ESP8266 -
github.com/Den-Sec/busylight - github.com/brianmwhite/on-air-alert -
github.com/theiltho/ms-teams-statuslight (no license; technique only)

**This repo (read 2026-08-20)** - `CONTEXT.md` (D-1..D-15, invariants, open questions) -
`docs/api-contract.md` - `docs/agents/issue-tracker.md` -
`docs/research/2026-08-10-onair-light-hardware-slate.md` (Tensions 1-3; Athom rows) -
`src/driver.ts`, `src/state.ts`, `src/server.ts`, `src/sse.ts`, `src/display.ts`,
`src/app.ts`, `package.json`, `.gitignore` - `gh repo view` -> PUBLIC
