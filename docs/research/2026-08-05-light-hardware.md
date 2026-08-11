# On-Air Light Hardware Options
2026-08-05

> **Superseded by `2026-08-10-onair-light-hardware-slate.md`** (17 ranked options across
> consumer/prosumer/production tiers, five parallel segment researchers + a verifying
> judge). Kept as the record of the first pass. Two of its conclusions were overturned
> there: battery-powered smart lamps with local control do exist, and the top pick here
> (Luxafor Bluetooth Pro) is confirmed write-only from Luxafor's own API docs.

This is the first file in `docs/research/` - there is no established research-notes
convention in this repo yet. This file establishes one for this task; adjust the
pattern later if it doesn't fit.

Scope: hardware for the "on-air light" open question in `CONTEXT.md` (research ticket,
GitHub issue #1). Requirements pulled from `CONTEXT.md`: no GPIO wiring (Wi-Fi or
Bluetooth/BLE only), battery preferred, status feedback preferred (so the API's
`confirmed` field per D-8 can reflect reality), binary on/off is the floor, RGB is a
nice-to-have, driver is Node.js (D-8) behind a pluggable `LightDriver` interface, and
Wi-Fi is scored above BLE because Node's BLE ecosystem (noble/bleno) is thinner than
its Wi-Fi/HTTP ecosystem. The invariants section of `CONTEXT.md` also states: "Local
network only is acceptable for v1; no cloud dependency required" - so cloud-required
control paths are a discriminator, not an automatic disqualifier, but score worse.

## Comparison table

| Product | Protocol | Battery (Y/N + life) | Status feedback (Y/N + how) | Local control path from Node on Pi/Mac (library, repo, maintenance state) | Cloud required? | Price | Availability |
|---|---|---|---|---|---|---|---|
| Luxafor Bluetooth Pro | BLE between light unit and a bundled USB dongle; dongle-to-host is USB HID (not BLE from Node's perspective) | Y - built-in 2600 mAh, 80h-12mo depending on mode | Undocumented at the protocol level - no read/query command found in the public HID byte-protocol docs (write-only) | USB HID via `node-hid` (github.com/node-hid/node-hid, active, last commit 2026-07-18) against Luxafor's published byte-level HID command spec (mirrored at pyluxa4 docs); official `loklaan/luxafor` JS wrapper exists but is stale (last commit 2016-05-02) | No - dongle talks directly to host over USB | ~EUR 109 | Currently sold, luxafor.com |
| Kuando Busylight UC Omega (standard) | USB only | N - "Powered via the USB data cable... No need for external power supply" | N documented in product docs | N/A - USB HID device, but disqualified on battery/wireless | No | $54.95 | Currently sold, shop.busylight.com |
| Kuando Busylight IoT Omega (LoRaWAN) | LoRaWAN (Class C, US902-928) | Uncertain - not stated on product page | Uncertain - not documented on product page | Uncertain - no local API found; LoRaWAN implies a gateway + network server, not a direct Node-to-device path | Effectively yes (needs a LoRaWAN network/gateway infra) | $84.95 | Currently sold, shop.busylight.com |
| Embrava Blynclight (Standard/Plus) | USB only (no Bluetooth model found) | N | N | N/A - disqualified, no wireless option | No | Uncertain (manufacturer page blocked WebFetch with HTTP 403) | Currently sold |
| Hollyland Wireless Tally System | Proprietary TCP/IP link between transmitter and tally receivers; transmitter side speaks broadcast protocols (e.g. emulates Blackmagic VideoHub API on TCP port 9990) to integrate with switchers, not a documented generic REST/on-off API | Y - battery packs in the tally receivers (life not found in a fetched primary spec) | Y in the broadcast sense (link status), but not a documented "confirmed on/off" status API for third-party control software | Uncertain/high effort - would mean emulating a VideoHub-style TCP server from Node just to toggle one light; no simple REST or BLE binding found | No (LAN) | Uncertain | Currently sold |
| Philips Hue (bulb + Bridge) | Bulb: Zigbee to Bridge. Bridge: Wi-Fi/Ethernet LAN, local REST API | N - mains-powered bulb (screw-in) | Y - Bridge API reports `reachable`/`on` state per light, polled from the mesh | `node-hue-api` (github.com/peter-murray/node-hue-api), active - last commit 2026-07-12, "fully supports local network... access to the Hue Bridge API" | No for local control; Bridge also offers an optional remote/cloud API this project doesn't need | Bridge $69.99 (philips-hue.com); bulb price not fetched from a primary source | Currently sold |
| LIFX color bulb (e.g. Mini Color / Color) | Wi-Fi direct, no hub - official LAN protocol (UDP, port 56700) | N - mains-powered bulb (screw-in) | Y - `getState`/`getPower` in the LAN protocol, genuine device readback | `lifx-lan-client` (github.com/node-lifx/lifx-lan-client), active - last commit 2025-05-24, "Node LTS and current versions are tested and supported on Mac, Linux and Windows" | No - LAN protocol docs are explicit that this path needs no cloud | Uncertain (lifx.com blocked WebFetch with HTTP 403; not confirmed from a primary source) | Currently sold |
| Govee smart devices (LAN API models) | Wi-Fi, local UDP LAN API on capable devices | Uncertain generally, but per govee2mqtt's own docs: "If the device has no WiFi, then Govee2MQTT is not able to control it... there is no BLE support" - i.e. no device is documented as both battery-only and LAN-API-capable | Limited - LAN API is control-only for basic properties (powerSwitch, brightness, colorRgb, colorTemperatureK); readback support not confirmed from a primary source | `govee-lan-hass` (github.com/wez/govee-lan-hass) - last commit 2024-01-21, author has since "shifted development focus" to `govee2mqtt`; LAN API must be manually enabled per device in the Govee app first | No for day-to-day LAN control, but initial per-device LAN-mode enablement happens through the cloud app | Uncertain | Currently sold |
| Generic BLE LED controller (ELK-BLEDOM / MELK / "LEDBLE" family) | BLE, writes hex commands to a vendor characteristic (`0000fff0-...`) | Uncertain - no single manufacturer or spec page; these are unbranded modules typically sold as 5V/12V strip controllers (external power), not as self-contained battery pucks | N - no read-status characteristic documented in the projects reviewed | `@abandonware/noble` (github.com/abandonware/noble) - maintained fork of the deprecated original `noble`, last commit 2025-02-09; example controller repo `TheSylex/ELK-BLEDOM-bluetooth-led-strip-controller` is stale (last commit 2020-11-07) | No | Uncertain - no canonical manufacturer, prices vary by reseller | Widely available under many rebrands |

## Per-candidate notes

### Luxafor Bluetooth Pro
- Claim: Built-in 2600 mAh battery, working time 80h-12 months depending on brightness/mode, charges via Micro USB-C.
  Source: https://luxafor.com/product/bluetooth-pro/
  Accessed: 2026-08-05
- Claim: Uses Bluetooth 5.2 with LE coded PHY; the included USB dongle gives up to 80m range in long-range mode.
  Source: https://luxafor.com/product/bluetooth-pro/
  Accessed: 2026-08-05
- Claim: The sibling "Bluetooth" (non-Pro) model specs a 2600 mAh battery too but rates it at 53h-6 months, 25m range without obstacles, and notes concrete/metal can block the signal; the dongle itself is USB-powered from the host.
  Source: https://luxafor.helpscoutdocs.com/article/10-luxafor-bluetooth-technical-specifications-and-requirements
  Accessed: 2026-08-05
- Claim: The dongle connects to the host over USB (not as a BLE peripheral the host must scan for) - "connect the Luxafor Bluetooth PRO to your PC or Mac by plugging the Dongle into the USB port." This means the Node driver only needs USB HID, not a BLE central stack.
  Source: https://luxafor.com/product/bluetooth-pro/ ; corroborated by community USB HID drivers (see below)
  Accessed: 2026-08-05
- Claim: The published USB HID byte protocol only documents write commands (`basic_color`, `color`, `fade`, `strobe`, `wave`, `pattern`) - no read/query-status command is documented.
  Source: https://facelessuser.github.io/pyluxa4/usb/
  Accessed: 2026-08-05
- Claim: `node-hid`, a plausible Node library for talking to the dongle over USB HID, is actively maintained (commit dated 2026-07-18).
  Source: https://api.github.com/repos/node-hid/node-hid/commits?per_page=1
  Accessed: 2026-08-05
- Claim: The official JS wrapper library for Luxafor devices is stale - last commit 2016-05-02.
  Source: https://api.github.com/repos/loklaan/luxafor/commits?per_page=1 (and https://github.com/loklaan/luxafor)
  Accessed: 2026-08-05
- Claim: Price is EUR 109.00.
  Source: https://luxafor.com/product/bluetooth-pro/
  Accessed: 2026-08-05

### Kuando Busylight (UC Omega / UC Alpha / IoT Omega)
- Claim: The standard UC Omega is "Powered via the USB data cable (9 feet long). No need for external power supply" - i.e. wired USB, not battery or wireless-to-host.
  Source: https://shop.busylight.com/kuando-busylight-uc-omega/
  Accessed: 2026-08-05
  Price cited on the same page: $54.95.
- Claim: No wireless/battery variant of the standard Alpha model was found in manufacturer search results; all consumer listings describe a USB-tethered device.
  Source: https://shop.busylight.com/kuando-busylight-uc-alpha/ (title/summary only, product is USB per the family pattern above)
  Accessed: 2026-08-05
- Claim: A separate "Busylight IoT Omega - LoRaWAN" SKU exists at $84.95 and operates via LoRaWAN downlink packages (Class C, US902-928 band), which implies a LoRaWAN gateway/network server is required - it is not a direct Wi-Fi or simple BLE device, and no local (non-network-operator) control API was found on the product page.
  Source: https://shop.busylight.com/kuando-busylight-iot-omega-lorawan-us/
  Accessed: 2026-08-05

### Embrava Blynclight
- Claim: No wireless/Bluetooth Blynclight model is confirmed from a primary source - the manufacturer's own product pages (`embrava.com/blynclight`, `store.embrava.com/products/blynclight-standard`) returned HTTP 403 to automated fetch, so this could not be verified directly against Embrava's own site. Search-result snippets (secondary, not independently verified here) describe Blynclight as USB-only. Treat "no Bluetooth model" as plausible but unconfirmed by a primary source I actually fetched.
  Source: attempted https://embrava.com/blynclight and https://store.embrava.com/products/blynclight-standard (both 403)
  Accessed: 2026-08-05

### Hollyland Wireless Tally System
- Claim: The system communicates over TCP/IP and, for switcher integration, emulates the Blackmagic ATEM VideoHub API on TCP port 9990; it supports multiple physical switcher-side ports (DB25, RJ45, USB-C) and a "sequence learning" mode for generic tally-voltage inputs.
  Source: search summary of https://www.hollyland.com/support/faq/wireless-tally-system/control and related Hollyland pages (not independently re-fetched as raw page content; treat protocol details as approximate pending direct doc read)
  Accessed: 2026-08-05
- Assessment: this class of device is designed to receive tally state from a broadcast switcher via a broadcast-oriented protocol, not to expose a simple "set on/off" REST or BLE endpoint for a home project. Repurposing it would mean building a minimal VideoHub-protocol server in Node just to flip one tally light - disproportionate complexity versus the busylight/smart-bulb options. Not recommended without a much deeper protocol read.

### Philips Hue (Bridge + bulb)
- Claim: The Hue Bridge exposes a local REST API on the LAN; `node-hue-api` states "The library fully supports `local network` and `remote internet` access to the Hue Bridge API and has 100% coverage of the documented Hue API," with connections over TLS to a bridge-issued certificate.
  Source: https://raw.githubusercontent.com/peter-murray/node-hue-api/master/README.md
  Accessed: 2026-08-05
- Claim: `node-hue-api` is actively maintained - most recent commit 2026-07-12, repository not archived.
  Source: https://api.github.com/repos/peter-murray/node-hue-api (fields `archived: false`, `pushed_at: 2026-07-12T16:10:54Z`)
  Accessed: 2026-08-05
- Claim: Hue Bridge price is $69.99; the product page states the Bridge "works without Wi-Fi" for local operation, though the Hue app promotes cloud-based remote access as an additional feature.
  Source: https://www.philips-hue.com/en-us/p/hue-bridge/046677458478
  Accessed: 2026-08-05
- Claim: Hue bulbs are mains-powered (standard screw-in form factor); no battery Hue bulb exists in the current lineup (general product knowledge, not separately re-verified against a bulb-specific primary spec page in this pass).
  Source: https://www.philips-hue.com/en-us/p/hue-bridge/046677458478 (bridge page context) - bulb-specific pricing/power page not independently fetched
  Accessed: 2026-08-05

### LIFX color bulb
- Claim: LIFX bulbs use an official LAN protocol - UDP packets to port 56700, binary encoding, documented for third-party client development; discovery via UDP broadcast `GetService`/`StateService`. This is explicitly separate from the LIFX cloud/HTTP API used for internet control.
  Source: https://lan.developer.lifx.com/docs/introduction and https://lan.developer.lifx.com/docs/communicating-with-device
  Accessed: 2026-08-05
- Claim: The `lifx-lan-client` Node library supports `getState`/`getPower`/`getLabel` reads (genuine status feedback, not just intent), and states "Node LTS and current versions are tested and supported on Mac, Linux and Windows."
  Source: https://github.com/node-lifx/lifx-lan-client
  Accessed: 2026-08-05
- Claim: `lifx-lan-client` is actively maintained - most recent commit 2025-05-24 (version 2.1.2).
  Source: https://api.github.com/repos/node-lifx/lifx-lan-client/commits?per_page=1
  Accessed: 2026-08-05
- Claim: LIFX bulbs are mains-powered, screw into a standard fixture, and market themselves as needing no hub ("No Hub. Wi-Fi Direct.").
  Source: page title of https://www.lifx.com/collections/lightbulbs, seen in search results; the page itself returned HTTP 403 to direct WebFetch so pricing was not independently confirmed.
  Accessed: 2026-08-05

### Govee (LAN API-capable devices)
- Claim: Govee has a LAN API that is UDP-based (not MQTT/cloud), limited to `powerSwitch`, `brightness`, `colorRgb`, `colorTemperatureK`; it must be manually enabled per device in the Govee app before local control works, and not all devices/SKUs support it.
  Source: search summary of https://community.govee.com/posts/mastering-the-lan-api-series-lan-api-101/136755 (page itself did not return body text to direct fetch, so this is the search engine's cached synopsis, not a re-verified raw fetch)
  Accessed: 2026-08-05
- Claim: Per the `govee2mqtt` project's own SKU/compatibility notes: "The more modern/powerful WiFi controller chips can have LAN API enabled... All known LAN API compatible devices are lights; there are no known appliance devices that support fully local control," and "If the device has no WiFi, then Govee2MQTT is not able to control it at this time, as there is no BLE support in Govee2MQTT at this time." No SKU is documented as both battery-only and LAN-API-capable.
  Source: https://github.com/wez/govee2mqtt/blob/main/docs/SKUS.md
  Accessed: 2026-08-05
- Claim: `govee-lan-hass` (a reference LAN API client) last commit 2024-01-21; its author has since redirected effort to `govee2mqtt`.
  Source: https://api.github.com/repos/wez/govee-lan-hass/commits?per_page=1 and https://github.com/wez/govee-lan-hass
  Accessed: 2026-08-05

### Generic BLE LED strip controllers (ELK-BLEDOM / MELK / LEDBLE family)
- Claim: These are unbranded BLE LED controllers (sold under many names) that accept hex commands written to a vendor GATT characteristic (`0000fff0-0000-1000-8000-00805f9b34fb` family); community projects targeting them are typically Python/Home Assistant integrations rather than maintained Node packages.
  Source: search summary of https://github.com/TheSylex/ELK-BLEDOM-bluetooth-led-strip-controller and related repos (`dave-code-ruiz/elkbledom`, `8none1/elk-bledob`)
  Accessed: 2026-08-05
- Claim: `TheSylex/ELK-BLEDOM-bluetooth-led-strip-controller` is stale - last commit 2020-11-07.
  Source: https://api.github.com/repos/TheSylex/ELK-BLEDOM-bluetooth-led-strip-controller/commits?per_page=1
  Accessed: 2026-08-05
- Claim: `@abandonware/noble` - the maintained fork of Node's original (now-deprecated) `noble` BLE-central library, which any Node BLE-central driver for these devices would depend on - last commit 2025-02-09, i.e. roughly 18 months stale as of this research date, and it is explicitly a community continuation of an abandoned original package.
  Source: https://api.github.com/repos/abandonware/noble/commits?per_page=1
  Accessed: 2026-08-05
- Assessment: this directly illustrates the brief's concern about the Node BLE ecosystem - the best available BLE-central library is a "keep-alive" fork of an abandoned package, and the device-specific control code is unmaintained hobby repos, mostly for Python/Home Assistant, not Node. No canonical manufacturer or spec sheet exists, so battery-vs-DC-power and price could not be pinned to a primary source.

## Recommendation

Top pick: **Luxafor Bluetooth Pro** - it is the only candidate that is genuinely battery
operated and purpose-built as a presence/status indicator (matches the "tally / busylight
(battery)" box in the architecture sketch almost exactly), and its wireless hop (BLE,
light-to-dongle) is invisible to the Node driver - the driver only needs USB HID (via the
actively-maintained `node-hid`) to talk to the dongle plugged into the receiver, so it
does not actually touch the thin Node BLE ecosystem the brief is worried about. The real
gap is status feedback: no read-back command is documented, so the `LightDriver`
implementation would treat a successful HID write as `confirmed: on/off` optimistically
and fall back to `confirmed: unknown` only on a write/communication failure (consistent
with D-5's "writes succeed even when the light is unreachable" behavior) - it would not
be a true acknowledgment from the light itself. It also needs a small custom Node HID
driver written against Luxafor's published byte protocol, since the official JS wrapper
is abandoned.

Runner-up: **LIFX color bulb** (e.g. Mini Color) - it best satisfies the Wi-Fi-over-BLE
preference (native Wi-Fi, no hub, official documented LAN/UDP protocol) and the status-
feedback preference (`getState`/`getPower` are genuine reads from the bulb, not assumed
state), backed by an actively-maintained Node library (`lifx-lan-client`) with explicit
Linux support. The tradeoff is it's mains-powered - the "light" becomes a screw-in bulb
that needs a lamp/fixture at the remote location, not a self-contained battery puck - so
it drops the battery preference entirely. Its `LightDriver` would be a thin wrapper
around `lifx-lan-client`'s `setPower`/`getPower`, polling or subscribing for confirmed
state after each write.

Philips Hue (Bridge + bulb) is a close third: equally strong local API and status
feedback, actively maintained Node library, but requires buying a $69.99 Bridge in
addition to a bulb, and is also mains-powered.

## Uncertain

- Luxafor Bluetooth Pro / Bluetooth: whether the dongle-to-light link can report
  confirmed on/off state back to the host - no read/query command is documented in the
  public HID protocol reference used here.
- Embrava Blynclight: whether any wireless/Bluetooth model exists at all - the
  manufacturer's own pages returned HTTP 403 to automated fetch and could not be
  directly verified; only secondary search-result summaries were available.
- Kuando Busylight IoT Omega (LoRaWAN): battery presence/life, and whether any local
  (non-network-operator) control API exists - not documented on the fetched product
  page.
- Hollyland Wireless Tally System: exact control protocol details (this was drawn from
  a search-engine synopsis of Hollyland's control/FAQ page, not a raw fetch of that
  page's full content) and tally-receiver battery life.
- LIFX bulb price and the "no hub / Wi-Fi direct" marketing claim's exact wording:
  lifx.com blocked automated fetch (HTTP 403); price and claim were only seen via
  search-result snippets, not independently confirmed from the raw page.
- Hue bulb-specific price and power spec: only the Bridge page was fetched directly;
  bulb pricing/power was not independently re-verified against a bulb-specific page.
- Govee: exact list of LAN-API-capable SKUs and their power source - the community
  LAN-API-101 post did not return readable body content to WebFetch; only the search
  engine's synopsis was available, and no SKU list was directly confirmed as
  battery-powered plus LAN-capable.
- Generic BLE LED strip controllers (ELK-BLEDOM/MELK/LEDBLE): whether any variant is
  genuinely battery-powered (as opposed to needing 5V/12V DC) - no canonical
  manufacturer/spec page exists for this rebranded module family, so this is not
  confirmable from a primary source. Price/availability likewise not pinned to a
  primary source.

## Sources

- https://luxafor.com/product/bluetooth-pro/
- https://luxafor.helpscoutdocs.com/article/10-luxafor-bluetooth-technical-specifications-and-requirements
- https://facelessuser.github.io/pyluxa4/usb/
- https://github.com/loklaan/luxafor
- https://api.github.com/repos/loklaan/luxafor/commits?per_page=1
- https://github.com/node-hid/node-hid
- https://api.github.com/repos/node-hid/node-hid/commits?per_page=1
- https://shop.busylight.com/kuando-busylight-uc-omega/
- https://shop.busylight.com/kuando-busylight-uc-alpha/
- https://shop.busylight.com/kuando-busylight-iot-omega-lorawan-us/
- https://embrava.com/blynclight (fetch blocked, HTTP 403)
- https://store.embrava.com/products/blynclight-standard (fetch blocked, HTTP 403)
- https://www.hollyland.com/support/faq/wireless-tally-system/control
- https://raw.githubusercontent.com/peter-murray/node-hue-api/master/README.md
- https://github.com/peter-murray/node-hue-api
- https://api.github.com/repos/peter-murray/node-hue-api
- https://www.philips-hue.com/en-us/p/hue-bridge/046677458478
- https://lan.developer.lifx.com/docs/introduction
- https://lan.developer.lifx.com/docs/communicating-with-device
- https://github.com/node-lifx/lifx-lan-client
- https://api.github.com/repos/node-lifx/lifx-lan-client/commits?per_page=1
- https://www.lifx.com/collections/lightbulbs (fetch blocked, HTTP 403)
- https://www.lifx.com/products/lifx-mini-color (fetch blocked, HTTP 403)
- https://community.govee.com/posts/mastering-the-lan-api-series-lan-api-101/136755
- https://github.com/wez/govee2mqtt/blob/main/docs/SKUS.md
- https://github.com/wez/govee-lan-hass
- https://api.github.com/repos/wez/govee-lan-hass/commits?per_page=1
- https://github.com/TheSylex/ELK-BLEDOM-bluetooth-led-strip-controller
- https://api.github.com/repos/TheSylex/ELK-BLEDOM-bluetooth-led-strip-controller/commits?per_page=1
- https://github.com/abandonware/noble
- https://api.github.com/repos/abandonware/noble/commits?per_page=1
- CONTEXT.md (this repo) - problem statement, architecture sketch, glossary, D-8, and
  invariant "Local network only is acceptable for v1; no cloud dependency required"
