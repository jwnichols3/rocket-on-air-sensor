# On-Air Light/Display Hardware - Full Option Slate

2026-08-10. Supersedes `2026-08-05-light-hardware.md` (8 candidates, one segment). That
file stands as the record of the first pass; this one is the decision document.

Method: five parallel research agents, one per market segment (consumer smart lighting /
purpose-built busylights / broadcast tally + studio signage / maker ESP32-class /
display-and-screen devices), then a single judge that re-verified every ranking-decisive
claim against the primary source, merged cross-segment duplicates, and scored the field.
Segment reports and the full judge verdict are in this session's scratchpad; everything
that survived is below.

Scope: GitHub issue #1. Relevant decisions: D-5 (`intended` vs `confirmed`), D-9 (the
`/display` browser tally), D-11 (zero production dependencies), D-12 (hardware on hold,
`confirmed` pinned to `"unknown"`).

## Requirements

Restated from `CONTEXT.md` plus two Rocket added on 2026-08-10 (R3, and R4 sharpened
from "reports status" to "can be polled"):

- **R1 (MUST)** Wireless - Wi-Fi or Bluetooth/BLE. No GPIO wiring to the receiver.
- **R2 (strong preference)** Battery operated - no mains cord at the light's location.
- **R3 (bonus)** The product family offers both a wireless and a wired variant, ideally
  behind the same API.
- **R4 (extra credit)** Pollable for genuine status - a read of the device's actual
  on/off state, not an echo of the last write. This is what makes `confirmed` real.
- **R5** Local-network control preferred; cloud-required is a strong negative.
- **R6** Node driver writable on macOS/Linux, ideally with zero new production
  dependencies (D-11).

Ranking modifier, from the repo invariant: **false OFF is worse than false ON**. A light
that dies mid-meeting, or lags a call start by minutes, fails regardless of score.

Scoring (R1 is a gate, not points): R2 battery 0-4, R3 wired sibling 0-1, R4 pollable
0-3, R5 local 0-2, R6 zero-dep driver 0-2. Max 12.

## Ranked slate

| # | Device | Tier | Battery (life) | Wired variant | Pollable status (exact call) | Local | Driver | Price | Availability | Score |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **BUSY Bar** (Flipper Devices) | prosumer | **Y** - 18650 3250 mAh, "8 hours of active status" | **Y, same SKU** - USB-C presents a virtual LAN serving the identical API | **Y** `GET /busybar/smart_home/switch` -> `{"state":bool}`; plus `GET /busybar/screen` (actual frame) and `/busybar/status/power` (battery %) | Y | zero-dep `fetch` vs published OpenAPI 3.1 | **$199** | In stock, 14-21 business days | **11** |
| 2 | **Ulanzi TC001 + AWTRIX 3** | consumer hw / prosumer fw | Y - 4400 mAh, ~5 h; vendor expects it plugged in | Y, same device (USB-C) | **Y** `GET /api/stats` -> `matrix` bool + `bat` %; `GET /api/screen` = pixel dump | Y | zero-dep `fetch`, after flashing AWTRIX 3 | **$45.99** | In stock | **10** |
| 3 | **Shelly 1 Gen4 + studio ON AIR sign** | production | **N** - mains | Y - Shelly Pro DIN/Ethernet, same RPC | **Y, strongest** `GET /rpc/Switch.GetStatus?id=0` -> `output`, plus `source` and `apower` (measured Watts) | Y | two `fetch` calls, zero deps | **$27.99** + **$149.95** sign | In stock | **8** |
| 4 | **Athom WLED Slim + WS2812B strip + USB power bank** | prosumer | power bank only (USB-C 5 V) | **Y, extensive** - whole Athom WLED line shares `/json/state` | **Y** `GET /json/state` -> `"on"` | Y | zero-dep `fetch`; use no library | **$11.85** + ~$15 | Listed | **8** |
| 5 | **Philips Hue Go portable + Bridge** | consumer/prosumer | Y - integrated battery, **runtime unpublished** | **Y, best in slate** - every Hue product rides the same Bridge API | **Y** `getLightState(id)` -> `{"on":bool,"reachable":bool}`; `reachable` maps exactly onto `confirmed: unknown` | Y | `node-hue-api` - one production dep | **$98.99** + **$69.99** Bridge | "Only a few left" | **9** |
| 6 | **My Bike's Got LED (LiPo) + WLED** (MCQN) | maker/prosumer | **Y, best real battery** - 8800 mAh pack in the kit | Y - mains sibling board, plus all of WLED | **Y** same `GET /json/state` | Y | zero-dep `fetch` | **$50.00** | Thin - 4 boards / 8 kits in stock | **10** |
| 7 | **LaMetric TIME** | production | **N** - 5 V DC 2 A external adapter | N | **Y, vendor-documented** `GET /api/v2/device/notifications` returns the queue | Y for control | zero-dep `fetch` + Basic auth | **$199** | In stock | **7** |
| 8 | **WiZ Mobile Portable Light** | consumer | Y - rechargeable, **runtime not stated** | Y - whole WiZ range, same UDP | **Y but unofficial** - `getPilot` over UDP:38899; WiZ's official docs are cloud GraphQL only | local UDP, reverse-engineered | hand-rolled `node:dgram` (zero deps) or `wikari` | **$98.99** | "Low stock" | **8** |
| 9 | **Luxafor Bluetooth Pro** | prosumer | **Y, best runtime by far** - 2600 mAh, "80h - 12 months" | Y - Flag / Orb are USB | **N - write-only, confirmed** from Luxafor's own API docs | Y (USB HID path) | `node-hid` + hand-written byte protocol | **$125.73** | In stock | **8** |
| 10 | **TRMNL OG (self-hosted BYOS)** | prosumer | **Y, best on paper** - ~3 months per charge at vendor default refresh | Y in spirit - BYOD spec | **Y, proof-of-delivery** - device polls us carrying `Battery-Voltage`/`RSSI` headers | Y - explicit self-host design | **zero driver** - add ~3 routes to the existing service | **$139** | In stock | 10, demoted on latency |
| 11 | **Umbra x Nanoleaf Cono (+ Cup)** | consumer | Y - 5 h | **Y, explicitly** - Umbra Cup is the mains sibling | Y in principle - Matter OnOff attribute (not verified against this SKU's cert record) | Y - Matter/Thread | `matter.js` **and a Thread border router in the house** | **$95.00** | In stock | 8 |
| 12 | **M5StickS3 + Smart-Tally route** | maker | Y but token - 250 mAh ~2.6 h at Wi-Fi RX | Y - AtomS3 Lite $7.50 is the USB sibling | presence / proof-of-delivery - light polls `GET /tally/N/status`, we answer `onair`/`unselected` | Y | **zero deps, zero driver** - one route | **$21.50** | In stock (StickC PLUS2 is EOL) | 7 |
| 13 | **Shelly Plus RGBW PM + strip** | prosumer | **N** - 12/24 VDC | Y - Shelly Gen2 line, identical RPC | **Y, best fidelity anywhere** `GET /rpc/Light.GetStatus?id=<id>`; the PM meters current, so `confirmed: on` means power is physically flowing | Y | two `fetch` calls, zero deps | **$39.99** | In stock | 8 |
| 14 | **Athom WLED / Tasmota 12 W color bulb** | consumer | **N** - E27 mains | it *is* the wired variant of #4's family | **Y** WLED `/json/state`, or Tasmota `GET /cm?cmnd=Power` -> `{"POWER":"OFF"}` | Y | zero-dep `fetch` | **$14.63** | Listed | 7 |
| 15 | **Athom Tasmota ESP32-C3 US Plug V3 + dumb lamp** | consumer | **N** - mains plug | N/A - it is the wired variant | **Y** `GET /cm?cmnd=Power` with no payload returns relay state | Y - "pre flashed", total local control | zero-dep `fetch` | **$14.35** | In stock | 6 |
| 16 | **ControlByWeb WebRelay X-WR-441-E + sign** | production | **N** | **Y, cleanly** - Ethernet / PoE / Wi-Fi / cellular SKUs in one family | **Y** `GET /state.json` -> `relay1` 0/1 | Y (cloud optional) | `fetch` + `JSON.parse`, zero deps | **$199.99** | In production | 7 |
| 17 | **Cuebi Light (set of 2)** | production | Y - 5 V micro-USB 0.4 W, 4-6 h on the bundled 2xAA pack, or any power bank | Y, same unit | **N** - no status, heartbeat or query documented anywhere | Y, LAN | ~40 lines of `node:dgram` TSL UMD - **but the listen port is undocumented** | **EUR 349** / 2 | In stock | 6 |
| - | **Baseline: `/display` kiosk on a Pi or spare tablet (D-9)** | free | N (tablet: hours) | it is the wired variant | **partial** - the count of open SSE subscribers on `GET /events` is a genuine "a display is connected and receiving" read | Y | **already shipped**, sub-second via SSE | **$0** (screen $40-80) | n/a | ~7 |

Tier spread: **consumer** #2, #5, #8, #11, #14, #15 - **prosumer** #1, #4, #6, #9, #10,
#12, #13 - **production** #3, #7, #16, #17.

## Top six, in detail

### 1. BUSY Bar - $199 - the pick

A battery-powered LED-matrix status device from Flipper Devices, purpose-built for this
job (it ships an "Auto ON CALL status" feature), GPLv2 firmware, and a published
versioned OpenAPI 3.1 spec. It is the only candidate that satisfies all six requirements
at once, and each one was verified from a primary source in one sitting.

- Claim: $199 (from $249), "Li-ion 18650 battery 3250 mAh", "8 hours of active status",
  "Delivery time: ~14-21 business days from Los Angeles", in stock.
  Source: https://busy.app/products/busy-bar - Accessed 2026-08-10
- Claim: `/busybar/smart_home/switch` has **both** `get` ("Get state of emulated smart
  home switch") and `post`; schema `SmartHomeSwitchState` is `state: {type: boolean}`.
  `/busybar/status/power` and `/busybar/screen` also present. Spec is `openapi: 3.1.0`,
  `version: 25.0.0`, 84 KB, 62 endpoints.
  Source: https://api.busy.app/busybar/openapi.yaml - Accessed 2026-08-10
- Claim: "Wi-Fi (LAN) connections to BUSY Bar are disabled by default for security
  reasons... connect your BUSY Bar to a computer via USB... turn on the HTTP API access
  toggle, click Set password and enable... you'll also need to include this password in
  all HTTP requests." Wi-Fi is 2.4 GHz only.
  Source: https://docs.busy.app/bar/dev/http-api and https://docs.busy.app/bar/tech-specs
  (fetched via curl; WebFetch returns 403) - Accessed 2026-08-10
- Claim: official `@busy-app/busy-lib` v0.18.0, MIT, `engines.node >= 18`; repo pushed
  2026-08-07. (Not needed - the zero-dep `fetch` path is preferred under D-11.)
  Source: https://registry.npmjs.org/@busy-app/busy-lib and
  https://github.com/busy-app/busylib-ts - Accessed 2026-08-10

Driver shape: `PUT /state` -> `POST /busybar/smart_home/switch {"state":true}` plus
`POST /busybar/display/draw` for the ON AIR frame; `confirmed` <- `GET` on the same
switch path. Two or three `fetch` calls, no npm package, no protocol to reverse-engineer.
`GET /busybar/status/power` lets the API warn about a dying battery *before* it produces
the false OFF the invariant forbids - no other battery candidate offers that.

Reject it if: the 8 h figure collapses under our duty cycle (a dim, mostly-static ON AIR
frame - nobody has characterised it), or if the `POST /display/draw` 409 priority model
turns out to be unclaimable, meaning an on-device app can silently pre-empt the ON AIR
frame. The spec documents 409 as "Requested priority level is below that of currently
active app" but does not say how to claim a higher level. **The driver must treat 409 as
a real failure and report `confirmed: unknown` - never swallow it.**

### 2. Ulanzi TC001 + AWTRIX 3 - $45.99 - the runner-up

A 32x8 RGB matrix clock that, flashed with the community AWTRIX 3 firmware, becomes ~77%
of BUSY Bar for 23% of the price. The read-back was verified against the firmware source,
not the docs.

- Claim: `DisplayManager_::getStats()` emits `doc[F("matrix")] = !MATRIX_OFF;` alongside
  battery percent, RSSI and current app - i.e. `matrix` is derived from firmware state,
  not an echo of the last command. `GET /api/screen` returns the whole matrix as 24-bit
  colors. `POST /api/power` writes.
  Source: https://github.com/Blueforcer/awtrix3 - `src/DisplayManager.cpp` and
  `docs/api.md`; repo pushed 2026-08-07 - Accessed 2026-08-10
- Claim: 4400 mAh, ~5 h portable, $45.99, in stock; Ulanzi positions the device as living
  plugged in via USB-C.
  Source: https://www.ulanzi.com/products/ulanzi-pixel-smart-clock-2882 - Accessed 2026-08-10

Costs: a one-time ESP32 flash that takes the device off vendor support, and a battery
that is a backup rather than a workday. Five hours of runtime is precisely the false-OFF
risk the invariant names.

### 3. Shelly 1 Gen4 + a mains ON AIR sign - $27.99 + $149.95 - the honest-`confirmed` benchmark

Fails R2 outright and still ranks third, because it is the only build where `confirmed`
stops being a polite fiction.

- Claim: `Switch.GetStatus` returns `output` - "true if the output channel is currently
  on, false otherwise" - plus `source` (enum includes `init`, `WS_in`, `http`) and
  `apower`, "Last measured instantaneous active power (in Watts)... (shown if
  applicable)". Local RPC over plain HTTP GET, no cloud.
  Source: https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/ and
  .../General/RPCChannels/ - Accessed 2026-08-10
- Claim: Shelly 1 Gen4 UL-Certified is $27.99, `available: true`.
  Source: https://us.shelly.com/products/shelly-1-gen4-ul-certified.js - Accessed 2026-08-10
- Claim: American Recorder ON AIR sign $149.95. (Segment-agent sourced, not independently
  re-fetched by the judge.) - Accessed 2026-08-10

Polling `output` **and** `apower` detects a burnt-out sign or an unplugged wall-wart - a
silent-false-OFF failure mode no other candidate can see at all. `source` additionally
lets the API tell its own writes apart from someone hitting the physical button. Two
`fetch` calls, no library (`node-shellies` last pushed 2023-01-24; not needed), nothing to
flash. Smallest, most durable driver in the study.

Safety note: switching mains behind a wall plate is real electrical work. The better
build puts the Gen4's dry contacts in the sign's 12 V DC line. **Verify before relying on
`apower`** - it is documented "shown if applicable"; the plain 1 Gen4 may be
dry-contact-only where the 1PM meters.

### 4. Athom WLED Slim controller + strip + power bank - ~$27-30 all-in - cheapest viable

- Claim: $11.85 (list $15.00), "Native WLED firmware", 5 V USB-C.
  Source: https://www.athom.tech/blank-1/wled-slim-led-strip-controller - Accessed 2026-08-10
- Claim: `GET /json/state` returns `on`, "On/Off state of the light"; POST to the same
  path writes. WLED repo pushed 2026-08-10, 18,531 stars, EUPL-1.2.
  Source: https://kno.wled.ge/interfaces/json-api/ - Accessed 2026-08-10

Ranks this high despite having no battery because the *whole Athom WLED family* speaks
the identical API - this 5 V USB-C controller, the 5-24 V DC controllers, and the
E27/BR30/GU10 mains bulbs. Prototype on the $11.85 controller, swap to a $14.63 bulb with
zero code change. Form factor becomes a late, cheap, reversible decision - worth real
money on a project whose hardware question has already been reopened once (D-12).
"Battery" here is a USB power bank, which is honest rather than elegant: no mains cord at
the light's location, which is what R2 was actually asking for.

Reject it if you want a finished object. This is a controller, not a light.

### 5. Philips Hue Go portable + Bridge - ~$169 - best read-back semantics, one unanswered question

- Claim: `getLightState(id)` returns both `"on"` and `"reachable"`. `node-hue-api` is
  Apache-2.0, 1195 stars, pushed 2026-07-12.
  Source: https://raw.githubusercontent.com/peter-murray/node-hue-api/master/docs/lights.md
  and https://api.github.com/repos/peter-murray/node-hue-api - Accessed 2026-08-10
- Claim: Hue Go portable accent light $98.99, "Integrated LED and battery",
  "Communication protocol Bluetooth, Zigbee", "Only a few left".
  Source: https://www.philips-hue.com/en-us/p/hue-white-and-color-ambiance-go-portable-accent-light/7602031U7 - Accessed 2026-08-10

`reachable` is the cleanest mapping onto this project's state model anywhere in the
study: `on`/`off` -> `confirmed`, `reachable: false` -> `confirmed: unknown`, exactly as
the glossary demands ("never guessed"). Zigbee mesh makes house-scale range a non-issue,
unlike BLE. Wired-variant bonus is maximal - every Hue product rides the same Bridge API.

It ranks fifth on one unresolved fact, and it is the fact that decides whether the
product works at all: **does the Hue Go keep its Zigbee radio alive on battery, off the
charger?** Philips's own support page renders the FAQ questions but not the answers, and
one of those unread questions is "What is the difference between standby and sleep mode?"
- the shape of the exact failure that disqualifies Govee (see Eliminated). Battery
runtime is likewise unpublished.

### 6. My Bike's Got LED (LiPo) + WLED - $50 - the only genuine battery answer

- Claim: $50.00 complete kit, "Board only [4 in stock]", "Complete kit [8 in stock]",
  page warns "Only 3 left in stock"; kit includes an 8800 mAh Li-ion pack; described as a
  "portable LED driver board for WLED projects".
  Source: https://www.tindie.com/products/mcqn_ltd/my-bikes-got-led/ and
  https://mcqn.com/ibal234/ - Accessed 2026-08-10

On raw requirement satisfaction this scores 10 and beats everything except BUSY Bar: the
only assembled, purchasable, battery-native WLED product found across all five segments,
and the only candidate where "battery operated" survives contact with the Espressif
datasheet. Driver identical to #4.

It ranks sixth on buyability, not capability: one small maker, single-digit stock, no
second source, and it is a *bike light kit* - 1.65 m of strip, velcro ties, a saddle bag
- most of which you pay for and discard. Whether it ships pre-flashed with WLED is not
stated outright. Mitigation: because it runs WLED, if the maker vanishes you are
re-sourcing hardware, not rewriting the driver.

## Structural tensions

Forced choices, not hedges.

### Tension 1: battery XOR genuine `confirmed`

This held independently across all five segments, which is why it looks structural rather
than a gap in the search.

- Every device with a documented, vendor-supported on/off read-back is **mains**: Shelly
  (`output` + `apower`), LaMetric, ControlByWeb (`relay1`), Vestaboard, Athom bulbs,
  Tasmota plugs.
- Every purpose-built **battery** busylight is **write-only by design**. Settled from
  Luxafor's own documentation rather than inferred: their webhook API exposes exactly
  `solid_color`, `blink`, `pattern` - no read endpoint of any kind
  (https://luxafor.helpscoutdocs.com/article/25-webhook-api-basics-and-guidelines,
  accessed 2026-08-10). Broadcast tally is the same story for an architectural reason:
  TSL UMD, Art-Net and sACN are all unidirectional. Cuebi, Hollyland, Astera - none of
  them answer "are you actually on?"
- The battery candidates that *do* claim a read (Hue Go, WiZ Mobile) have an unverified
  radio-on-battery story - see Tension 3.

**Exactly two products break the XOR**, and each charges for it: BUSY Bar ($199, 8 h,
finished product) and My Bike's Got LED ($50, multi-day, one maker with single-digit
stock and a saddle bag you don't want).

### Tension 2: battery XOR latency (push vs pull)

Long ESP32-class battery life requires deep sleep at ~10 uA. **A sleeping device cannot be
pushed to.** It must poll, and state-change latency then equals the poll interval. This is
physics, not a product gap, and it collides head-on with D-5/D-6's push-on-change model.

The arithmetic is unforgiving: TRMNL's headline "three months per charge" is quoted at
the vendor's default refresh (the docs' example is 1800 s). Drive it at 30 s to make it
real-time and the battery claim collapses to a number the vendor does not publish. Same
logic kills the Adafruit MagTag despite it having the most battery-sane silicon in the
study.

There is a real upside to the pull direction worth naming: **client-pull is the only way
found to get an honest signal out of a write-only device class, and it costs less code
than any driver.** If the light polls `GET /tally/N/status` (the Roland Smart Tally shape
that STAC and Tally Arbiter both speak), our service - already an HTTP server - gains one
nine-character route and is done. We then observe exactly when each light last fetched and
what string it got: proof-of-delivery, degrading to `unknown` on its own, the same
watchdog pattern `/display` already implements (D-9). It never proves the LED lit.

So: **awake device + sub-second latency + a driver**, or **sleeping device + minutes of
lag + no driver**. Minutes of lag violates the invariant.

### Tension 3: battery-save modes silently break automation, and no vendor puts it in the spec sheet

The sharpest finding of the bakeoff, and it generalises.

- Claim: "When the adapter is unplugged, Battery save mode turns on automatically -
  disabling Alexa, Google Assistant, Matter and Wi-Fi. To re-enable them, manually turn
  off Battery save mode in the app." The same page adds "Standby mode consumes power to
  support remote control" - i.e. the vendor knows keeping the radio alive costs battery,
  and their default is to sacrifice the radio.
  Source: https://us.govee.com/products/black-cordless-led-table-lamp - Accessed 2026-08-10

A light you have to wake by hand cannot be driven by an automated on-air signal. That is
exactly the failure the repo invariant names. And **no other vendor answers this question
at all** - not Philips (Go FAQ answers don't render), not WiZ (local-communication help
page 403s), not Nanoleaf.

**Rule to adopt: ask this of every battery smart lamp before buying.** "Does it answer the
network while running on battery, off the charger, with no app open?" Not answerable from
any spec sheet, and decisive.

### Tension 4 (secondary): the zero-dependency rule is a real discriminator here

Almost every top candidate's driver is `fetch` or `node:dgram` with zero npm production
deps - BUSY Bar, Ulanzi, Shelly, WLED, Tasmota, LaMetric, ControlByWeb, Cuebi, and the
Smart-Tally inversion. The exceptions each cost something concrete: Hue needs
`node-hue-api`; Matter/Thread needs `matter.js` **and** a Thread border router in the
house; any BLE-direct path needs `@abandonware/noble` (a keep-alive fork of an abandoned
package, last pushed 2025-02-09); Tally Arbiter needs a second Node process kept alive on
the receiver, which is real weight against D-13/D-14's single-service install story. D-11
is not a nicety in this decision - it eliminates or demotes four otherwise reasonable
options.

## Eliminated

| Device | Segment | Reason cut |
|---|---|---|
| Govee Cordless Table Lamp H1741 | consumer | Confirmed from Govee's own page: unplugging auto-enables Battery Save Mode, disabling Wi-Fi and Matter until manually re-enabled in the app. Unautomatable by construction. |
| Elgato Key Light Mini | busylight | Confirmed discontinued on Elgato's own page. Would have ranked ~3rd (4000 mAh, 4 h, $59.99, undocumented :9123 API). |
| Kuando Busylight UC Omega / UC Alpha | busylight | USB-tethered - the light must sit next to the receiver. Fails R1. |
| Kuando Busylight IoT Omega (LoRaWAN) | busylight | Needs a LoRaWAN gateway + network server; no direct Node-to-device path. |
| MuteMe / MuteMe Mini | busylight | USB HID only, no BT variant. Its 4-byte return is *touch* state, not light state - wrong direction. |
| Luxafor Busy Tag | busylight | Has genuine read-back (`AT+SC?`) but over USB serial, and "requires an external power source at all times". Its Wi-Fi HTTP server does file ops only. Fails R1 and R2. |
| Luxafor Signal | busylight | Wi-Fi native but mains, cloud-controlled, no read endpoint. Fails R2, R4, R5. |
| Luxafor Switch Pro 2 | busylight | Marketed "app-free" - you twist a physical cube. No documented local protocol. Fails R6. |
| Embrava Blynclight Wireless | busylight | embrava.com and store.embrava.com return 403 / Cloudflare to every method tried, including `/products.json`. Zero primary-sourced facts. Unrankable without a human with a browser. |
| Hollyland Wireless Tally | broadcast | Hollyland publishes **no third-party protocol at all**; every documented integration is a proprietary switcher handshake or a physical GPI voltage input. The oft-repeated "VideoHub API on TCP 9990" traces to a GitHub discussion, not the manufacturer. Prior pass's dismissal upheld, for a stronger reason. |
| Astera Titan/Helios + Art-Net/sACN | broadcast | The open protocol never reaches the battery: the AsteraBox WiFi datasheet lists UHF/CRMX/Bluetooth/WiFi and no Art-Net; Art-Net enters via a mains-powered DataLink that must sit next to the lights. Four figures, price unpublished. |
| Sonifex SignalLED LD-40 | broadcast | GPI-only, no network protocol - needs a Shelly in front of it anyway. Both Sonifex domains failed (404 / expired TLS cert). |
| Blackmagic ATEM / Datavideo / Neewer / Desview tally | broadcast | All switcher-side distribution: each assumes a video switcher is the source of truth, so driving one means emulating a switcher. Our source of truth is an HTTP service. |
| Vestaboard / Vestaboard Note | display | Textbook local API (`GET` with `X-Vestaboard-Local-Api-Key`, returns the actual displayed characters) at $999-$3,499 for a boolean. Two orders of magnitude off. |
| Tidbyt Gen 2 | display | Not manufactured ("taking a break from manufacturing"), cloud-gated push, `pixlet` last touched 2024-09-30. |
| Divoom Pixoo-64 | display | Divoom's own app guide disclaims the local HTTP API as "community reverse-engineered, not officially documented or supported" and warns firmware updates can block it. No read-back. $159.99, mains. |
| Inkplate 6 | display | Out of stock ~6 weeks, converts a Node/TS project into a firmware project, and still carries the e-ink latency tax. |
| M5PaperS3 | display | Store listing prefixed `[EOL]`; price unverified. |
| Adafruit MagTag | maker | Inverts the push model (Tension 2), three SKUs (~$55.85 all-in), firmware you write. Best battery silicon, worst latency fit. |
| Pimoroni Badger 2040 W | display | "We no longer stock this product." |
| Pixelblaze V3 | maker | Sold out, requires soldering, undocumented WebSocket protocol, no status read. |
| LIFX color bulb | consumer | Real documented LAN/UDP `getPower` reads, but mains-only and strictly dominated by the Athom WLED/Tasmota bulb at ~1/4 the price with the same local-read story. Demoted from the prior pass's runner-up. |
| TP-Link Kasa / Tapo | consumer | `tplink-smarthome-api` last pushed 2023-11-15; no battery product; strictly worse than Shelly or Tasmota for the identical mains-plug job. |
| Generic BLE LED controllers (ELK-BLEDOM / MELK / LEDBLE) | prior pass | No read characteristic, no canonical manufacturer, unmaintained Python hobby repos, Node path depends on `@abandonware/noble` (pushed 2025-02-09). |
| IKEA VAPPEBY | consumer | A rechargeable Bluetooth *speaker* lamp, not a smart light. No control protocol. |
| Hue Go over Bluetooth without a Bridge | consumer | Technically possible but puts the driver on `@abandonware/noble`. The Bridge path dominates. |
| Visionect | display | Enterprise signage licensing, no public pricing. Wrong tier. |

## Recommendation

**Top pick: BUSY Bar, $199.** The only device that satisfies wireless, battery, a wired
variant of the same SKU, genuine documented status read-back, local-only control, and a
zero-dependency Node driver *all at once* - each verified from the vendor's own OpenAPI
spec and product page. It turns D-12's "`confirmed` stays `unknown`" from a permanent
condition into a real boolean, and it is also a display device, so it subsumes `/display`
(D-9) rather than sitting beside it. Order early: 14-21 business days.

**Runner-up: Ulanzi TC001 + AWTRIX 3, $45.99.** 77% of the read-back for 23% of the
price. You pay in a one-time ESP32 flash and a ~5 h battery that is really a backup.

**Cheapest viable: Athom WLED Slim $11.85 + a short WS2812B strip + a USB power bank**
(~$27-30 all-in). Or, for the dumbest possible contract, the **Athom Tasmota plug at
$14.35** driving any lamp.

**Spend more, get more (production): Shelly 1 Gen4 $27.99 switching an American Recorder
ON AIR sign $149.95.** The only build where `confirmed` is a physical measurement rather
than a firmware flag. Catches a burnt-out sign or an unplugged wall-wart, which nothing
else on the slate can see. Fails battery completely. If PoE at the sign location is the
deciding constraint, **ControlByWeb X-WR-441-E at $199.99** is the same capability in
industrial packaging at seven times the price.

### Suggested buy-and-test sequence

1. **Now, $0.** Keep `/display` running (D-9/D-12). Already built, sub-second via SSE, and
   its SSE-subscriber count is a real liveness read. It stays the fallback; winning
   devices should supplement it, not replace it.
2. **Now, $14.35-$27.99.** Buy one Athom Tasmota plug (or a Shelly 1 Gen4) and a dumb
   lamp. Build the real `LightDriver` against it. This retires D-12's "`confirmed` stays
   unknown" consequence for fifteen dollars, on a device that will never go EOL, before
   spending real money. **Success criterion: `GET /status` returns `confirmed: "on"`
   sourced from a device read, and returns `"unknown"` within one poll interval when the
   lamp is unplugged.**
3. **Week 1, $45.99.** Buy the Ulanzi TC001, flash AWTRIX 3, point the driver at it.
   Proves the whole battery + wireless + display + pollable shape at a quarter of BUSY
   Bar's price. **Measure the two things nobody publishes:** (a) does it answer HTTP while
   on battery with no cord, and (b) real runtime at low brightness on a static ON AIR
   frame. If (a) fails, you learn the Tension-3 lesson for $46 instead of $199.
4. **Week 2-4, $199 - only if step 3's form factor is right.** Order the BUSY Bar. Enable
   the Wi-Fi HTTP API over USB first; design the 409 handling in from day one.
5. **Finish, $149.95 - optional.** Put the ON AIR sign on the Shelly from step 2 as the
   permanent household-visible fixture, with the battery device as the portable desk
   indicator. Two lights, one driver interface, one `intended` state.

### Ask before buying

- **Any battery smart lamp (Hue Go, WiZ Mobile, Cono):** "Does it answer the network on
  battery, off the charger, with no app open?" No vendor publishes this. Govee documents
  the *wrong* answer. Ask support in writing, or buy where returns are easy.
- **Philips specifically:** what do "standby" and "sleep mode" do to the Zigbee radio, and
  what is the Go's actual runtime?
- **Cuebi:** what UDP port and address/index does the light listen on in TSL mode, and can
  Roland Smart Tally mode be pointed at an arbitrary IP? A yes to the second makes Cuebi a
  top-5 candidate with zero driver code; a no to both makes it unbuyable.
- **BUSY Bar:** how do I claim a display priority high enough that `POST /display/draw`
  never 409s, and what is runtime on a static dim frame?
- **Shelly:** does the plain 1 Gen4 report `apower`, or is a 1PM needed?
- **MCQN (My Bike's Got LED):** does the board ship pre-flashed with WLED, and what is the
  board-only price?

## Verification log

Re-verified by the judge against the primary source on 2026-08-10: the BUSY Bar OpenAPI
spec (the decisive R4 claim for the top pick), its price/battery/stock and the
Wi-Fi-disabled-by-default gotcha; AWTRIX's `matrix` boolean read out of the firmware
source; Shelly's `output`/`source`/`apower` semantics; WLED's `on`; Athom prices; Luxafor
write-only (every webhook endpoint extracted - no GET anywhere); Elgato discontinued;
Govee's disqualifying FAQ; LaMetric mains-only; Hue Go / WiZ / Cono / M5Stack / TRMNL /
Tindie stock and pricing; and 15 repository `pushed_at` dates.

Changed by verification:

1. **Shelly SKU corrected.** The consumer segment ranked "Shelly Plug S Gen3" with an
   unconfirmed price; four US plug SKU JSON endpoints all returned 404. The slate uses the
   verified, priced, in-stock Shelly 1 Gen4 ($27.99) and Plus RGBW PM ($39.99) instead.
2. **TRMNL X availability relaxed** - reported as backorder by the segment, but the store
   JSON reports `available: true` at $229.00 today (OG $139.00). Caveat: a Shopify
   `available: true` can still be a sell-through-backorder setting.
3. **Cuebi's gate confirmed and sharpened.** The manual PDF's full text (163 lines)
   contains zero occurrences of "TSL", "UMD", "Smart Tally", "Roland", or any port number
   - only ATEM IP configuration. But cuebi.com's own compatibility list *does* include
   Roland Smart Tally. If that mode can be pointed at an arbitrary IP, Cuebi would poll
   our service directly (the STAC inversion) and become a production battery tally with
   zero driver code. Cheapest question in the whole study to ask.
4. **BUSY Bar's `X-Api-Token` header name downgraded to unverified.** A password is
   confirmed required; the header name does not appear in the docs page fetched. Immaterial
   to ranking; do not code against it blind.
5. Minor date drift, no ranking impact: `lifx-lan-client` pushed 2026-04-02 (prior pass
   said 2025-05-24); `node-hid` pushed 2026-07-20 (2026-07-18).

Accepted on the segment agents' evidence, not independently re-checked: Tasmota
`cmnd=Power` read semantics; ESPHome `web_server` REST; the Espressif ESP32
current-consumption table (95-100 mA Wi-Fi RX, 30-68 mA modem-sleep, 10 uA deep sleep) and
all runtime arithmetic derived from it; Tally Arbiter internals; STAC's `/tally/N/status`
contract; ControlByWeb `/state.json` semantics and $199.99; American Recorder sign
$149.95; Hue Bridge $69.99 and the `getLightState` response shape; matter.js controller
claims; TRMNL BYOS device headers and battery figures; Divoom's written API disclaimer;
Tidbyt's manufacturing wind-down; Kuando and MuteMe USB-only status.

## Uncertain

- **Hue Go: battery runtime, and whether the Zigbee radio stays alive on battery.** The
  Philips support page renders FAQ questions but not answers; one unread question is
  "What is the difference between standby and sleep mode?" **Gates purchase of #5.**
- **WiZ Mobile: radio-on-battery behaviour, and WiZ's own statement on local
  communication** (help-centre page 403s). The UDP:38899 protocol has no official spec -
  WiZ's official developer docs are cloud GraphQL only. **Gates purchase of #8.**
- **Cuebi: the TSL listen port / address-index scheme, and whether Smart Tally mode
  accepts an arbitrary IP.** Undocumented everywhere reachable. **Gates purchase of #17.**
- **BUSY Bar: runtime at our duty cycle** (dim, mostly-static ON AIR frame), and the
  `POST /display/draw` **409 priority model** - how to claim a sufficient priority is not
  described in the spec.
- **Embrava: everything.** 403 to WebFetch, to curl with a browser UA, and to the Shopify
  `/products.json` endpoint. Needs a human with a browser.
- **Athom stock levels** - the Wix storefront exposes no machine-readable stock field.
  Prices are sale prices against higher list prices and may not hold.
- **My Bike's Got LED:** pre-flashed with WLED? and the board-only price.
- **Umbra Cono:** certified Matter cluster list for this SKU (OnOff attribute
  read/subscribe is required by the device type, so very likely - but it is an inference);
  whether an already-commissioned Cono can join a matter.js fabric via multi-admin without
  a factory reset; and **whether a Thread border router exists in Rocket's house at all**
  (matter.js is a controller, not a border router).
- **Shelly 1 Gen4 `apower`** - documented "if applicable"; the plain Gen4 may be
  dry-contact-only. Verify before relying on power draw as a second confirmation signal.
- **Ulanzi:** whether flashing AWTRIX voids warranty, and real runtime at low brightness.
- **Astera and Hollyland pricing** - not published by either manufacturer.
- **Raspberry Pi Touch Display 2 is DSI and Raspberry Pi explicitly excludes the Zero
  line** - so "Pi Zero 2 W + Touch Display 2" is not a buildable baseline config; a Zero
  build needs mini-HDMI.

## Sources

BUSY Bar / Ulanzi / busylights:
- https://busy.app/ , https://busy.app/products/busy-bar
- https://api.busy.app/busybar/openapi.yaml
- https://docs.busy.app/bar/dev/http-api , https://docs.busy.app/bar/tech-specs (WebFetch 403; fetched via curl)
- https://github.com/busy-app/busylib-ts , https://registry.npmjs.org/@busy-app/busy-lib
- https://www.ulanzi.com/products/ulanzi-pixel-smart-clock-2882
- https://github.com/Blueforcer/awtrix3 (`docs/api.md`, `src/DisplayManager.cpp`)
- https://luxafor.com/products/ , https://luxafor.com/product/bluetooth-pro/ , .../switch-pro-2/ , .../signal/ , .../busy-tag/
- https://luxafor.helpscoutdocs.com/article/25-webhook-api-basics-and-guidelines (primary evidence of write-only)
- https://luxafor.helpscoutdocs.com/article/47-busy-tag-usb-cdc-command-reference-guide , .../48-busy-tag-local-server-api
- https://github.com/JnyJny/busylight , https://github.com/node-hid/node-hid
- https://www.elgato.com/us/en/p/key-light-mini , .../key-light-air
- https://shop.busylight.com/kuando-busylight-uc-alpha/ , .../kuando-busylight-uc-omega/ , .../kuando-busylight-iot-omega-lorawan-us/
- https://muteme.com/pages/software-technical-specifications
- https://embrava.com/pages/blynclight , https://store.embrava.com/products.json (both HTTP 403 / Cloudflare)

Consumer smart lighting:
- https://www.philips-hue.com/en-us/p/hue-white-and-color-ambiance-go-portable-accent-light/7602031U7
- https://www.philips-hue.com/en-us/support/product/go-portable-and-table/100036 (FAQ answers do not render)
- https://raw.githubusercontent.com/peter-murray/node-hue-api/master/docs/lights.md , https://api.github.com/repos/peter-murray/node-hue-api
- https://developers.meethue.com/develop/hue-api-v2/api-reference/ (login-gated)
- https://www.wizconnected.com/en-us/p/table-lamps-mobile-portable-light/046677604356
- https://docs.pro.wizconnected.com/ (cloud GraphQL only) , https://faq.wizconnected.com/hc/en/7-wiz-v2/faq/548-disabling-local-network-communication/ (403)
- https://github.com/uditkarode/wikari
- https://nanoleaf.me/en-US/products/smarter-partners/umbra-lamps/cono-sierra/ , https://us-shop.nanoleaf.me/products/umbra-cono-portable-smart-lamp-sierra , https://www.umbra.com/pages/smart-lamps
- https://github.com/matter-js/matter.js
- https://us.govee.com/products/black-cordless-led-table-lamp
- https://raw.githubusercontent.com/wez/govee2mqtt/main/docs/SKUS.md
- https://api.github.com/repos/plasticrake/tplink-smarthome-api , https://api.github.com/repos/node-lifx/lifx-lan-client

Maker / WLED / Shelly / Tasmota:
- https://kno.wled.ge/interfaces/json-api/ , https://kno.wled.ge/basics/compatible-controllers/
- https://www.athom.tech/wled , .../blank-1/wled-slim-led-strip-controller , .../blank-1/wled-12w-color-bulb , .../blank-1/tasmota-esp32-c3-us-plug-v3
- https://www.tindie.com/products/mcqn_ltd/my-bikes-got-led/ , https://mcqn.com/ibal234/ , https://github.com/mcqn/my-bikes-got-led
- https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/ , .../Light , .../General/RPCChannels/ , .../Devices/Gen4/Shelly1G4/
- https://us.shelly.com/products/shelly-1-gen4-ul-certified.js , https://us.shelly.com/products/shelly-plus-rgbw-pm.js
- https://tasmota.github.io/docs/Commands/ , https://esphome.io/web-api/ , https://esphome.io/components/web_server.html
- https://shop.m5stack.com/products/m5sticks3-esp32s3-mini-iot-dev-kit(.js) , .../m5stickc-plus2-...(.js, EOL) , .../atoms3-lite-...(.js) , .../atom-tailbat.js (unavailable)
- https://www.adafruit.com/product/4800 , https://quinled.info/quinled-dig2go/ , https://shop.electromage.com/products/pixelblaze-v3-standard-wifi-led-controller
- https://documentation.espressif.com/esp32_datasheet_en.pdf (Table 5-4 RF current consumption)
- https://api.github.com/repos/wled/WLED , .../esphome/esphome , .../arendst/Tasmota , .../SteffenKn/wled-js , .../ShiftLimits/wled-client , .../alexryd/node-shellies-ng

Broadcast / production:
- https://github.com/josephdadams/TallyArbiter (docs: sources, listener-clients, rest-api; `src/sources/TSL.ts`, `IncomingWebhook.ts`)
- https://github.com/Xylopyrographer/STAC (`STAC Communications.md` - `GET /tally/[number]/status`)
- https://shop.ccisolutions.com/StoreFront/jsp/pdf/RND-V-60HD_usingSmartTally.pdf (Roland's own Smart Tally doc)
- https://www.cuebi.com/ , https://www.cuebi.com/files/CuebiLightManual.v1.0.pdf , https://shop.cuebi.com/products/cuebi-lights
- https://help.rossvideo.com/acuity-device/Topics/Devices/UMD/TSL.html ; https://support.rossvideo.com/hc/en-us/articles/29695573086875-... (403)
- https://controlbyweb.com/webrelay/ , https://controlbyweb.com/support/cbw-integration-manual/
- https://astera-led.com/wp-content/uploads/ART7-WiFi_AsteraBox-WiFi_Datasheet_V3-1.pdf , https://astera-led.com/products/datalink/ , .../titan/
- https://www.hollyland.com/product/wireless-tally-system , https://www.hollyland.com/support/faq/wireless-tally-system/control
- https://api.github.com/repos/margau/dmxnet , .../node-dmx/dmx , .../k-yle/sacn , .../hobbyquaker/artnet (stale, 2019)

Displays:
- https://lametric.com/en-US/time , .../time/tech-specs , .../sky
- https://github.com/lametric/Documentation (`reference-docs/device-notifications.rst`, `device-state.rst`, `device-display.rst`)
- https://trmnl.com/ , https://shop.trmnl.com/ , https://docs.trmnl.com/go/diy/byos , https://docs.trmnl.com/go/private-api/screens.md , https://github.com/usetrmnl/trmnl-firmware
- https://tidbyt.com/blogs/tidbyt/tidbyt-is-joining-modal , https://github.com/tidbyt/pixlet
- https://docs.vestaboard.com/docs/local-api/endpoints/ , https://www.vestaboard.com/products/vestaboard-white
- https://divoom.com/blogs/app-guide/pixoo-64-api-beginner-guide , https://divoom.com/products/pixoo-64 , http://doc.divoom-gz.com/... (ECONNREFUSED)
- https://soldered.com/products/inkplate-6-6-e-paper-board , https://shop.pimoroni.com/products/badger-2040-w , https://www.visionect.com/software/
- https://www.raspberrypi.com/products/touch-display-2/ , .../raspberry-pi-zero-2-w/ , https://www.pishop.us/product/raspberry-pi-zero-2-w/

Repo:
- `CONTEXT.md` (D-5, D-6, D-9, D-11, D-12, D-13, D-14; invariants), `docs/api-contract.md`,
  `docs/research/2026-08-05-light-hardware.md`, `docs/research/2026-08-05-companion-integration.md`
