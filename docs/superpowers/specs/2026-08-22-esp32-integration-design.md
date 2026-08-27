<!--
Provenance: produced by a 10-agent workflow on 2026-08-22 - five parallel verification
agents (web_server under esp-idf, native API vs HTTP, getting state into the device, the
boolean -> three-state contract impact, hands-on toolchain), one designer, three
adversarial reviewers (technical errors / false-green invariant / regression and scope),
one final author folding the reviews in. The "What the adversarial review changed" section
near the end lists nine reversals, four of them critical.

Repo baseline note: the spec cites `2105e61`. HEAD is now 2105e61; every commit since has
been docs-only, so `git diff 2105e61..HEAD -- src test deploy` is still empty and every
src/test file:line below resolves.
-->

> **Superseded on staleness, 2026-08-27 (D-91/D-92).** Every `90` in this spec - `FRESH_S`,
> `freshS`, the `ageSeconds <= 90` freshness bound, the device's `STALE_MS 90000` and the
> "90 s of false green after reboot" analysis - describes a model that no longer exists. The
> server latches and never decays state; `STALE_AFTER_S`, `stale()` and `stale` are gone from
> the code and the wire; each renderer polls and judges its own connection, marking itself
> unrefreshed after **1 minute** and falling to NO DATA after **30 minutes**. Treat every
> normative `90` below as historical. The false-green invariant it was protecting is intact
> and is now enforced at the renderer. See CONTEXT.md D-90/D-91/D-92 and
> `docs/api-contract.md` §3.

> **Superseded on the transport, 2026-08-24 (D-46).** This spec describes the device's
> state entity as a `select` named `Presence`, driven by `EsphomeSelectDriver`. That is no
> longer true: the entity is a `text` named `PresenceKey`, the driver is `EsphomeTextDriver`,
> and the `select` has been removed from the firmware. Read `docs/api-contract.md` and
> CONTEXT.md D-38/D-44/D-46 for the current transport. Everything else here - the false-green
> invariant, the frame counter, the respond-before-apply gap - still holds.

# ESP32 -> on-air API integration spec (2026-08-22)

**Status:** final. Supersedes the draft of the same date and the three adversarial reviews.
**Repo baseline:** `rocket-on-air-sensor` @ `2105e61` (the draft cited `3763374`; `git diff 3763374..HEAD -- src test deploy` is empty, so every `src/`/`test/` `file:line` below still resolves). `npm test` today: **tests 80 / pass 80 / fail 0**. [FACT]
**Firmware baseline:** ESPHome **2026.8.0** at `/Users/john/code/esp32/.venv/`. All component paths below are relative to `/Users/john/code/esp32/.venv/lib/python3.13/site-packages/esphome/`. [FACT]
**Device:** Elegoo `esp32dev`, `framework: esp-idf`, SH1106 128x64 mono OLED on I2C, live at `10.42.12.77`, port 6053 open, port 80 dead. [FACT, measured by the orchestrator 2026-08-22]

---

## Verdict in five lines

1. **Transport: plain HTTP on port 80** via `web_server:` (`version: 2`, no `local:`), served by ESP-IDF's `esp_http_server`. **No framework switch** — `web_server_base/__init__.py:14-19` branches on `CORE.is_esp32` before it tests `using_arduino`, and the delta compiles clean at 51.2% flash. [FACT]
2. **State model: one stored field `level`** with three rungs `available(0) < interruptible(1) < dnd(2)`; **`intended` becomes a derived, read-only projection** kept on the wire *and on disk* for rollback and Companion compatibility. [JUDGEMENT]
3. **The single rule that governs every code path: the server never lowers `level` or asserts a lower rung to the device without fresh evidence.** Raising or matching is always allowed; lowering requires `ageSeconds <= 90`. [JUDGEMENT]
4. **`confirmed` becomes genuine for the first time in this project** — a real `GET` of the device's `current_option()`, *plus* a frame counter so `confirmed` describes pixels, not a variable.
5. **Three device-side lines carry most of the safety:** `api: reboot_timeout: 0s` (without it the board reboots every 15 min forever), `on_boot: priority: -100` re-zeroing the watchdog global, and `options[0] == "dnd"`.

---

## What already exists, and what it means

| Fact | Where | Consequence for this spec |
|---|---|---|
| Device runs `framework: esp-idf` | `/Users/john/code/esp32/configs/elegoo-esp32.yaml:11-13` [FACT] | The prior plan (`docs/superpowers/plans/2026-08-20-esp32-onair-light.md`) assumed Arduino. Ignore that assumption; everything else in it is informative only. |
| `api:` with encryption, no `web_server:` | same file, `:15-17` [FACT] | 6053 open, 80 dead — matches the orchestrator's `nc`/`curl` measurements. We add 80 and keep 6053 for `make logs`/`make flash` only. |
| `captive_portal:` present | `:32` [FACT] | `captive_portal/__init__.py:28-32` `AUTO_LOAD`s `["web_server_base", "ota.web_server"]`. Inert only because nothing listens on 80. **The moment `web_server:` goes in, an OTA upload endpoint goes live.** Hence `ota: false`. |
| `i2c:` sets no `frequency:` | `:34-37` [FACT] | `i2c/__init__.py` `SplitDefault(CONF_FREQUENCY, esp32="50kHz")` [FACT, read today]. Full-framebuffer SH1106 writes at 50 kHz are ~200-220 ms/frame — already over ESPHome's 50 ms blocking warn threshold. **We must add `frequency: 400kHz`.** |
| Display lambda draws title + IP + dBm | `:60-80` [FACT] | Those three readouts are load-bearing for field debugging; the new lambda preserves all three in a reserved bottom band with **no early `return`**. |
| GPIO2 switch `restore_mode: ALWAYS_OFF` | `:87-91` [FACT] | **Left alone.** Rocket says the hardware is done; flipping a strapping-pin LED is cosmetic churn. |
| `CONTEXT.md:56` defines Call state as boolean | [FACT] | Superseded by this work. |
| D-6 (`CONTEXT.md:125-129`), D-9 (`:138-144`), D-12 (`:157-166`) all encode the boolean/no-driver world | [FACT] | Three decisions get amended, not one. See "Repo delta / docs". |
| D-11 (`CONTEXT.md:151-156`) = hand-roll rather than add a dep, *because the thing is small* | [FACT] | Authorises hand-rolling a server-push WebSocket. It does **not** authorise hand-rolling a Noise handshake. HTTP wins on D-11's own terms. |
| `/Users/john/code/esp32` is not a git repo | [FACT] | Noted as a risk. **Out of scope for this change** — see Open questions. |

**Requirement change in scope:** three states (green/available, yellow/interruptible, red/dnd), rendered by a device that may or may not be the mono OLED. The state model names rungs semantically and knows nothing about colour.

---

## Transport

### Decision

**Plain HTTP on port 80, `web_server` REST, driven by Node's built-in `fetch`.** Native API (6053) stays enabled and unused by the driver. [JUDGEMENT]

Rationale, stated once: the native-API argument's strongest point was "6053 is already open, HTTP costs a reflash." That collapses — **we must reflash anyway** to add the three-state entity and the new renderer. Once reflashing is a given the trade is *+26 KB flash and ~110 lines of Node* against *0 KB and ~600 lines of hand-rolled Noise crypto*. [JUDGEMENT]

### Flash cost [FACT, measured]

`939,623 / 1,835,008 B` = **51.2%** with `web_server: version: 2`, no `local:`; baseline `913,563 B`. Delta **+26,060 B**, RAM +432 B. The +102 KB figure from one earlier measurement came from `local: true`, which compiles the 906 KB `server_index_v3.h` blob.

### Wire contract [FACT, all read in 2026.8.0 source]

Base: `http://10.42.12.77`. **The URL segment is the entity NAME, not a slugified object_id** — `web_server/web_server.cpp:167` matches `this->id == entity->get_name()`, and the compiled codegen emits `App.register_select(presence, "Presence", 978369850, 0);`. The name is `Presence` with no spaces, deliberately, so percent-encoding never enters the driver.

**Write**
```
POST http://10.42.12.77/select/Presence/set?option=dnd     (no body)
-> 200, Content-Length: 0, empty body
```
`option` ∈ `dnd | interruptible | available`. Node's `fetch(url,{method:'POST'})` emits `Content-Length: 0` and no `Content-Type`, which is required: `web_server_idf/web_server_idf.cpp:185-189` returns **411 Length Required** if `Content-Length` is absent. [FACT]

**The 200 means nothing.** `web_server.cpp:1464-1465` is `DEFER_ACTION(call, call.perform()); request->send(200);` — the response is sent *before* the value is applied and regardless of whether it ever will be. An invalid option (`select/select_call.cpp:66-74`) and a missing `option` param are **silently dropped, still 200**. ESPHome's own docs concede this for alarm panels: *"A valid POST request will always return a 200 OK status response. This does not indicate that the alarm was armed."* (https://esphome.io/web-api/alarm-control-panel/ , accessed 2026-08-22). **A read-back is mandatory.** [FACT]

**Read**
```
GET http://10.42.12.77/select/Presence
-> 200 application/json
{"id":"select/Presence","value":"dnd","state":"dnd"}
```
Key order from `set_json_id` -> `set_json_value` (`web_server.cpp:610-614`) -> `set_json_icon_state_value` (`:617-621`). For `select`, `value` and `state` come from the same expression and are always identical. **Read `state`; ignore `value` and `id`; tolerate unknown keys.** [FACT]

`?detail=all` adds `domain`, `name`, `entity_category`, and `option` (array). **Use it exactly once, at driver startup** (see `verifyOptions()` — and unlike the draft, it is now actually wired in).

**Distinguishable failures** [FACT]
- `404` = wrong entity name or wrong action (`web_server.cpp:1468`). Config error, not device outage.
- **No HTTP response at all, socket closed** = the URL matched no handler (`web_server_idf.cpp:242-256` returns `ESP_ERR_NOT_FOUND`; nothing registers `onNotFound`). Surfaces in Node as `ECONNRESET`, and in `curl -w '%{http_code}'` as `000` with exit 52.
- Timeout / `ECONNREFUSED` = device or link down.

### Auth: take it [JUDGEMENT — changed by review]

The draft said "skip auth for v1" on the reasoning that `Access-Control-Allow-Origin: *` (`web_server_base/web_server_base.h:133`) is the exposure. **All three reviewers correctly falsified that reasoning, and they are right.** `POST /select/Presence/set?option=available` has no body, no `Content-Type` and no custom header, so it is a CORS **simple request**: any page in Rocket's browser fires it without preflight, and ACAO only governs whether the *response* is readable. Stripping ACAO closes nothing.

One reviewer offered Private Network Access as the mitigation (`web_server/__init__.py` `enable_private_network_access` defaults `False`, so the device never emits `Access-Control-Allow-Private-Network`). That is real but insufficient: it covers PNA-enforcing browsers only, not other browsers and nothing else on the LAN.

Under "false OFF is worse than false ON", an unauthenticated LAN endpoint that forces `available` is a remote false-green primitive, and §"Making confirmed genuine" would faithfully confirm it. So:

```yaml
web_server:
  auth:
    username: onair
    password: !secret web_server_password
    type: basic        # MUST be explicit
```
`type: basic` must be written out: `web_server/__init__.py:94-101` warns the default flips to **digest in ESPHome 2027.1.0**, which would silently break the driver. Digest would cost 40-60 lines of hand-rolled MD5; basic costs one header. `allowed_origins:` (`web_server/__init__.py:55`, `:402-404`) exists and is worth knowing about, but it is not a substitute for auth. [FACT for the source refs, JUDGEMENT for the call]

Node side, sent pre-emptively on every request:
```ts
headers: { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }
```

### Not used: SSE

`GET /events` works on ESP-IDF (`web_server_idf.cpp:694-935`) and would give sub-second push. **Deferred, not rejected.** It holds one of the device's 7 sockets permanently, and `config.lru_purge_enable = true` (`web_server_idf.cpp:150-152`) plus an LRU counter that only advances on *receive* makes an idle SSE stream the first casualty of socket pressure. A 5 s poll is 10x faster than this signal needs. Add it later as a latency optimisation. [FACT + JUDGEMENT]

### Timeouts, from measurement

`ping -c 20` today: **min 3.104 / avg 64.583 / max 124.361 ms, 0% loss**. TCP connect to 6053, 8 samples: `120.2, 9.6, 83.6, 14.9, 11.7, 9.9, 37.6, 11.0` ms. An earlier 3-packet ping showed 33% loss in a 133-172 ms band. [FACT]

A 3 ms floor **rules out a slow mesh backhaul**; the bimodality is DTIM buffering under `power_save_mode: LIGHT` (ESPHome's ESP32 default). `power_save_mode: NONE` is the fix. [JUDGEMENT, tested in Step 5]

- **Per-request timeout 2000 ms.** Do not go below 1000 ms — a 500 ms budget flaps `confirmed` on ordinary jitter.
- **Retries: 1, with a 400 ms gap.** The draft retried with zero backoff; against the *correlated* burst loss actually measured, an immediate retry lands inside the same burst and buys nothing that TCP retransmission inside the 2 s budget did not already buy. [JUDGEMENT — changed by review]
- **Poll 5000 ms**, scheduled *after* completion (`setTimeout`, never `setInterval`), so requests cannot overlap.
- **Corrected arithmetic** (the draft's was wrong and someone will tune against it): a fully failing heartbeat tick costs 2 attempts x 2000 ms + 400 ms gap ≈ 4.4 s, plus the 5 s poll gap ≈ **9.4 s per failing cycle**. The device's `STALE_MS = 90000` therefore needs **~10 consecutive failing cycles**, not six. No flapping on a lost packet. [FACT, arithmetic]

---

## State model: boolean -> three states

### The ladder

```
available (0)  <  interruptible (1)  <  dnd (2)
RANK = { available: 0, interruptible: 1, dnd: 2 }
intended = (level === 'available') ? 'off' : 'on'     // derived, never stored in memory
```

Semantic names, not colour names: the OLED is monochrome and a colour lamp is a *second renderer*. The state model does not know what draws it. [JUDGEMENT]

The ordering is load-bearing, not cosmetic. It reduces the safety rule to one sentence:

> **THE LADDER RULE — the server never lowers `level`, and never asserts a lower rung to the device, without fresh evidence. Raising or matching is always allowed. Absence of information never renders below `dnd`.**

`FRESH_S = 90` seconds, matching the device's `STALE_MS`. "Fresh evidence" means `store.ageSeconds() <= FRESH_S`.

This is the generalisation of D-6, and the generalisation is **not** "no auto-GREEN" — that phrasing leaves a gap. D-6 as written forbids only downgrades that end at the bottom; on a three-rung ladder `dnd -> interruptible` on a timer is a brand-new failure its words do not cover but its rationale plainly forbids. Write the amendment on the ladder once and the gap never gets found by a future implementer looking for a clever compromise. [JUDGEMENT]

Do **not** auto-*raise* either. "Detector went stale, escalate to `dnd`" is safe-directional but (i) manufactures a state nobody asserted and makes `source` lie, (ii) is sticky, so one flaky night leaves Rocket permanently red, and (iii) staleness already has a home in this system, and that home is **presentation** (`docs/api-contract.md:19-21`; the STALE badge at `src/display.ts:44,74-77`), not state.

### `GET /status`

```json
{
  "level": "dnd",
  "intended": "on",
  "confirmed": "dnd",
  "source": "detector",
  "updatedAt": "2026-08-22T21:04:00.000Z",
  "message": null,
  "ageSeconds": 12
}
```
`intended` is computed at serialisation, so it cannot drift. Companion's shipped config (`docs/companion-setup.md:41`, `$(genericwebsocket:intended) == "on"`) keeps working untouched; yellow and red both read `"on"` -> red button, the cheap direction of error. `confirmed` widens to `Level | "unknown"` — leaving it `on|off|unknown` produces a model that cannot express "the light says yellow", which becomes a real bug the moment the real driver lands.

### `PUT /state`

Preferred `{"level":"interruptible","source":"webui"}`. Legacy `{"onAir":true,"source":"detector"}` still accepted, mapping `true -> dnd`, `false -> available`. `true -> dnd` rather than `interruptible` because a client that can only say yes/no is telling you it does not know how bad it is; the ladder says round up.

Both present and contradictory -> `400 {"error":"level and onAir disagree"}`. Neither -> `400 {"error":"body must contain level or onAir"}`.

New no-body conveniences, matching the `/on` `/off` idiom (all accept `?source=`):
```
POST /available     POST /interruptible     POST /dnd
POST /on -> dnd     POST /off -> available        (unchanged, kept)
```

### Defaults: the device and the server must agree, and they agree on `dnd`

The draft argued at length that `options[0]` must be `dnd` because *"a device that boots into AVAILABLE mid-call is the failure this project exists to prevent"* — and then set `defaultState()` to `available`, with the boot re-apply pushing that down onto the device within seconds of first boot. Both reviewers caught it; it is a real self-contradiction. [FACT — the draft says both things]

**Ruling: `defaultState()` -> `level: 'dnd', source: 'boot'`.** Match the device. `loadState` returns `null` on ENOENT (`src/persist.ts:10`), and ENOENT is not only "fresh install" — it is also a changed `$HOME` under launchd, a wiped `~/.onair`, a failed `rename()` in `saveState` leaving only `state.json.tmp`, and a D-14 reinstall. Every one of those must not assert green. The stated cost ("annoying on a fresh install") is exactly the cost we already accept on the device side and call correct. [JUDGEMENT — changed by review]

### On the device

One `select:` entity, `Presence`, options `["dnd","interruptible","available"]`. **Index 0 is `dnd`, deliberately.** `restore_value`'s out-of-range fallback (`template/select/template_select.cpp:27-36`, which validates the restored index against the current option list), `initial_option`'s default, and the display lambda's `has_value()` fail-safe all converge on `options[0]`. Every degenerate path — first boot, corrupt NVS, an options-list change, a lambda running before any state exists — lands on "do not interrupt". [FACT for the mechanism]

**Why `select` and not `switch`:** `select/select.cpp:22-34` `publish_state(size_t)` calls `state_callback_.call(index)` **unconditionally** — no dedup — and `select/select_call.cpp:100-121` `perform()` has no same-value short-circuit. So re-POSTing the *same* option refires `on_value`, which is what makes the heartbeat work. `switch` dedups via `publish_dedup_` and would break it. Flash wear is a non-issue: `esp32/preferences.cpp:273-291` `is_changed_()` memcmps against stored NVS before writing. [FACT, all verified independently by two reviewers]

### The detector tension — decide it now, before the detector exists

`docs/api-contract.md:15` fixes last-write-wins with no source precedence. With a boolean, D-6's 60 s heartbeat is harmless. With three states, a detector that can only distinguish call/no-call will re-write `dnd` every 60 s and **silently destroy any manual `interruptible` within a minute**. The middle rung is the one Rocket sets by hand; the heartbeat is the thing that erases it.

**Call for v1** [JUDGEMENT]: the detector does not exist yet (`CONTEXT.md:74`, D-2), so shape it rather than patch around it — **the detector writes `level` explicitly and only ever `dnd` or `available`; it never writes `interruptible`.** Accept the clobbering, document it at `docs/api-contract.md:15`, file a follow-up for a manual-hold flag. Do not build source precedence in v1: a forgotten hold is a stuck light, which D-6's "no stuck-on light" clause cares about.

---

## Device config delta (exact YAML)

Applied to `/Users/john/code/esp32/configs/elegoo-esp32.yaml`. The draft's version of this delta **compiled clean** (`Successfully compiled program`, EXIT=0, RAM 25.6%, Flash 51.2%); the changes below (on_boot, i2c frequency, auth, wifi timeout, display restructure, frame counter) are **not yet compiled** — Step 2/3 is where that is proven. 🔒 marks lines that guard the false-OFF invariant.

### a. `esphome:` — ADD `on_boot` 🔒 [CRITICAL, added by review]

```yaml
esphome:
  name: ${device_name}
  friendly_name: ${friendly_name}
  on_boot:
    priority: -100            # 🔒 setup_priority::LATE, runs after every component setup()
    then:
      - lambda: 'id(last_write_ms) = 0;'
```

**Why this exists.** The draft asserted `last_write_ms == 0` after boot means "no controller has spoken since boot", and built the whole reboot-safety argument on it. **It is false without this block**, and both reviewers proved it independently:

- `template/select/template_select.h:32-41` — `setup()` calls `setup_with_restore(...)`
- `template/select/template_select.cpp:27-35` — `setup_with_restore` ends in `sel_comp->publish_state(index)` [FACT, read today]
- `select/select.cpp:22-34` — `publish_state(size_t)` calls `state_callback_.call(index)` **unconditionally** [FACT] (the same no-dedup property we rely on elsewhere; it cuts both ways)
- `select/automation.h:9-14` — `SelectStateTrigger`'s **constructor** registers the callback, so the trigger is live before `App.setup()` runs (the draft's own generated `main.cpp:406` vs `:1029` proves the ordering) [FACT]
- `globals/globals_component.h:20` — `GlobalsComponent::setup()` is `{}`, so nothing clears it afterwards [FACT]

Without the `on_boot` block, after every reboot `last_write_ms ≈ a few hundred ms`, `stale == false` for 90 s, and **a board that restored `available` with the Mac unreachable shows a calm dot and the word `free` for a minute and a half.** That is the exact failure this project exists to prevent.

The fix is mechanically sound: `core/config.py:309-313` registers `StartupTrigger` with the given priority; `core/base_automation.h:134-141` shows `StartupTrigger::get_setup_priority()` returns it and `setup()` fires the trigger; `core/component.h:59` `LATE = -100.0f` vs `HARDWARE = 800.0f` for the select. Components set up in descending priority, so `-100` runs strictly last. [FACT, all four read today]

### b. `api:` — ADD `reboot_timeout` 🔒 [HIGHEST-VALUE SINGLE LINE]

```yaml
api:
  encryption:
    key: !secret api_encryption_key
  reboot_timeout: 0s          # 🔒 ADDED
```
`api/__init__.py:292-294` defaults `reboot_timeout` to `15min`; `api/api_server.cpp:143-158` reboots when `api_connection_count_ == 0` and `now - last_connected_ > reboot_timeout_`, with `last_connected_` seeded at setup. **Our driver speaks HTTP, so it never satisfies that timer.** Measured live: device UP 22:32:36, **DOWN 22:51:57** — 15 min 12 s after the last API disconnect, against a control run of 22 minutes of zero reboots while one API connection was held. Without this line the board reboots every 15 minutes forever. `0s` disables it (https://esphome.io/components/api/ , accessed 2026-08-22). [FACT]

### c. `wifi:` — power save off, reboot timeout lengthened (not zeroed)

```yaml
wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
  power_save_mode: NONE       # ADDED - fixes the 3ms-to-124ms spread; costs battery, irrelevant on USB
  reboot_timeout: 10min       # CHANGED from the default 15min, NOT to 0s

  ap:
    ssid: "${friendly_name} Setup"
    password: !secret fallback_ap_password
```
`wifi/__init__.py:486-497` defaults `reboot_timeout` `15min` and `power_save_mode` `light` on esp32. [FACT]

**The draft set `wifi: reboot_timeout: 0s` and called it "strictly safer than rebooting". It is not, and both reviewers were right to reject it.** `restore_value: true` already means a reboot *preserves* the level (`template_select.cpp:29-30`) and the panel is correct within one frame — and with the `on_boot` fix in (a), a reboot now correctly re-enters STALE/NO DATA until Node reconnects, which makes rebooting *safer* than the draft assumed. Meanwhile `0s` removes the only self-heal for a wedged WiFi stack, trading a ~10 s blackout for an indefinite one requiring a human to walk to the board. `10min` is far longer than any mid-call blip and short enough to recover unattended. [JUDGEMENT — changed by review]

`api: reboot_timeout: 0s` in (b) stays at zero: that timer fires in the *healthy* case, which is categorically different.

### d. `i2c:` — ADD `frequency` [added by review]

```yaml
i2c:
  sda: GPIO21
  scl: GPIO22
  scan: true
  frequency: 400kHz           # ADDED
```
`i2c/__init__.py` defaults esp32 to `50kHz` [FACT, read today]. `ssd1306_i2c/ssd1306_i2c.cpp:41-61` rewrites the entire 1024-byte framebuffer every update with no dirty check: 8 pages x (3 command transactions + 8 x `write_bytes(0x40, data, 16)`), ≈1224 payload bytes plus ~88 START/address/STOP overheads. At 50 kHz and 9 clocks/byte that is **~200-220 ms of blocking I2C per frame** — already over ESPHome's 50 ms warn threshold (`core/component.h:100`) at the *current* 1 s interval, and ~45% duty cycle at the 500 ms interval this spec wants, on the device that now also has to serve HTTP. 400 kHz (fast mode, supported by SH1106) drops it to ~28 ms. **If 400 kHz proves unstable on breadboard wiring, revert `update_interval` to `1s` rather than dropping back to 50 kHz at 500 ms.** [FACT for the mechanism, JUDGEMENT for the value]

### e. ADD after `captive_portal:`

```yaml
web_server:
  port: 80
  version: 2
  ota: false                  # 🔒 ADDED
  log: false
  auth:                       # 🔒 ADDED - see Transport/Auth
    username: onair
    password: !secret web_server_password
    type: basic               # MUST be explicit; default flips to digest in 2027.1.0
```
`version: 2` not `3`, and **no `local:`** — v3's `local: true` compiles a 906 KB JS blob. The REST layer is version-independent (`canHandle` dispatches on domain and method only, `web_server.cpp:2429-2470`); `version` affects only the browser UI nobody needs. [FACT]

🔒 `ota: false` closes the unauthenticated firmware-upload endpoint `captive_portal` auto-loads. The key **only accepts `false`** (`web_server/__init__.py:112-122`). **State its scope honestly:** `web_server/__init__.py:104-122` and `web_server/ota/ota_web_server.cpp:45-49` both say it disables OTA *for `web_server` only* — the **captive portal can still perform an unauthenticated `/update` whenever the AP fallback is running**. That is acceptable here because the fallback AP is password-protected (`!secret fallback_ap_password`), and it is exactly the recovery case you want it for. [FACT — the draft implied a stronger closure than this]

`log: false` keeps log streaming off `/events`; `api:` already covers logs.

Add `web_server_password` to `configs/secrets.yaml` and `secrets.yaml.example`.

### f. ADD after the `i2c:` block

```yaml
globals:
  - id: last_write_ms
    type: uint32_t
    restore_value: false
    initial_value: '0'        # 🔒 re-zeroed by on_boot priority -100 (see 3a)
  - id: frames
    type: uint32_t
    restore_value: false
    initial_value: '0'        # proves the panel actually repaints

select:
  - platform: template
    name: "Presence"          # -> URL /select/Presence   (no spaces, deliberately)
    id: presence
    optimistic: true          # required: template/select/__init__.py:63-68
    restore_value: true       # 🔒 survives a reboot with the last written value
    options:
      - "dnd"                 # 🔒 index 0 == the safe state
      - "interruptible"
      - "available"
    initial_option: "dnd"     # 🔒 fallback when NVS is empty or invalid
    on_value:
      then:
        - lambda: |-
            uint32_t t = millis();
            id(last_write_ms) = (t == 0) ? 1 : t;

sensor:
  - platform: template
    name: "Frames"
    id: frames_sensor
    update_interval: 5s
    accuracy_decimals: 0
    lambda: 'return (float) id(frames);'
```
🔒 `restore_value` and `initial_option` cover different failures: `restore_value` covers "the board rebooted while Rocket stayed on the call"; `initial_option` covers "the stored index was unusable". `(t == 0) ? 1 : t` guards the one-in-49-days case where `millis()` is genuinely 0.

The `Frames` sensor is the answer to "200 OK, state updated, panel never repainted" — see "Making confirmed genuine".

### g. `font:` — ADD one

```yaml
  - file: "gfonts://Roboto@700"
    id: status_huge
    size: 30
```
[UNRESOLVED] `ON AIR` at size 30 is ~110-120 px wide on a 128 px panel, centred at x=64. ESPHome clips at the buffer edge **silently**, so compiling proves nothing. **Measure it on the first flash** (Step 7). If it clips, drop to size 26 or use `ONAIR`.

### h. REPLACE the `display:` lambda

The draft's version early-`return`ed in the `dnd` branch, which **deleted the WiFi dBm readout in the default/restored/failure state** and dropped the existing title — while its own prose claimed both diagnostics were "preserved verbatim". Its `interruptible` branch also drew a full-screen border straight through the band it claimed to preserve, and `free` at y=44 overlapped the y=49 divider. All corrected below: the band is drawn **first**, `y >= 49` is reserved, there is **no early `return`**, and the frame counter is bumped unconditionally. [FACT — the draft's prose and code disagreed]

```yaml
display:
  - platform: ssd1306_i2c
    model: "SH1106 128x64"
    address: 0x3C
    update_interval: 500ms    # was 1s; safe only with i2c frequency: 400kHz (3d)
    lambda: |-
      // ---- diagnostics band FIRST, y>=49 is reserved and never overdrawn ----
      it.line(0, 49, 127, 49);
      if (id(ip_address).has_state()) {
        it.printf(0, 52, id(status_text), "IP: %s", id(ip_address).state.c_str());
      } else {
        it.print(0, 52, id(status_text), "IP: connecting...");
      }
      if (id(wifi_signal_db).has_state()) {
        it.printf(127, 52, id(status_text), TextAlign::TOP_RIGHT, "%.0fdBm", id(wifi_signal_db).state);
      }

      // ---- state, with a fail-safe: no state yet => index 0 == "dnd" ----
      auto idx = id(presence).active_index();
      size_t i = idx.has_value() ? idx.value() : 0;

      // ---- staleness: 0 means "nothing written since boot" (see on_boot, 3a) ----
      const uint32_t STALE_MS = 90000;
      uint32_t lw = id(last_write_ms);
      bool stale = (lw == 0) || (millis() - lw > STALE_MS);

      // "available" is the only claim that can be a false OFF. Stale => refuse to render it calm.
      bool render_unknown = stale && (i == 2);

      if (i == 0) {
        // DND - maximum ink. Words knocked out of a solid block, band left alone.
        it.filled_rectangle(0, 0, 128, 48, COLOR_ON);
        it.printf(64, 24, id(status_huge), COLOR_OFF, TextAlign::CENTER, "ON AIR");
        if (stale) it.print(64, 44, id(status_text), COLOR_OFF, TextAlign::BASELINE_CENTER, "STALE");
      } else if (render_unknown) {
        // UNKNOWN - hatched band. Never blank, never calm.
        for (int x = 0; x < 128; x += 4) it.line(x, 0, x, 14, COLOR_ON);
        it.printf(64, 26, id(status_title), COLOR_ON, TextAlign::CENTER, "NO DATA");
      } else if (i == 1) {
        // INTERRUPTIBLE - double frame INSET above the band, mid ink.
        it.rectangle(0, 0, 128, 48, COLOR_ON);
        it.rectangle(2, 2, 124, 44, COLOR_ON);
        it.printf(64, 24, id(status_huge), COLOR_ON, TextAlign::CENTER, "BUSY");
      } else {
        // AVAILABLE - a big open ring plus a word. Comparable ink, unmistakable shape.
        it.filled_circle(64, 24, 22, COLOR_ON);
        it.filled_circle(64, 24, 15, COLOR_OFF);
        it.printf(64, 24, id(status_text), COLOR_ON, TextAlign::CENTER, "FREE");
      }

      id(frames)++;   // last statement, every path: proves the panel repainted
```

Design notes, each load-bearing:

- 🔒 **Ink coverage is monotonic with urgency** — solid block > double frame > thick ring > hatch. Distinguishable in peripheral vision before any word is legible. Never encode state as blink rate; an ambiguous signal a reader must *decode* is how a false OFF gets read.
- 🔒 **`available` is never blank, and is no longer a speck.** The draft used `filled_circle(64,26,7)` — 14 px across, ~3.2 mm on a 1.3" SH1106, subtending ~3.7 arcmin at 3 m — against a `fill(COLOR_ON)` DND branch of 8192 lit pixels, a 585:1 ink ratio. **From the stairs, "unplugged" and "available" were the same dark panel**, which is the exact conflation the draft's own §0 ruling called an invariant violation. A 22 px open ring fixes it. [JUDGEMENT — changed by review]
- 🔒 **A stale `available` is not rendered as `available`** — it becomes the hatched NO DATA panel. `dnd` and `interruptible` when stale keep their appearance (already-safe claims); `dnd` additionally prints `STALE`.
- 🔒 `active_index()` returns `optional<size_t>`; `.has_value() ? … : 0` means **any** un-set condition renders DND. Comparing an *index* rather than a string makes "safe state is index 0" structural, not a convention someone breaks by reordering `options:`.
- **`select` has no `.state` member in 2026.8.0.** `id(presence).state` does not compile — `select/select.h:28-70` exposes `current_option()` / `active_index()` / `has_state()` / `option_at()` only. (`text_sensor` *does* still have `.state`, hence `id(ip_address).state.c_str()` in the same lambda. The inconsistency is live and select-specific.) [FACT]
- **Do not add `offset_x: 2`.** `ssd1306_i2c.cpp:41-56` already adds `0x02` on top of `offset_x_` for SH1106 models; adding it yourself shifts the image and clips the right edge. And `platform: ssd1306_i2c` + `model: "SH1106 128x64"` is correct and current — there is no `sh1106_i2c` platform in 2026.8.0. **The existing config is right; do not "fix" it.** [FACT]
- `auto_clear_enabled` defaults true when a lambda is present.
- Verified API surface: `display/display.h:320 fill`, `:369 line`, `:386 rectangle`, `:395 filled_circle`, `:513 printf(int,int,BaseFont*,Color,TextAlign,const char*,...)`. `filled_rectangle` is in the same header. [FACT]

### i. NOT changed

The GPIO2 `switch:` block stays exactly as it is (`restore_mode: ALWAYS_OFF`). The draft proposed flipping it to `RESTORE_DEFAULT_ON` and called the change cosmetic itself; the hardware is done, the OLED is the indicator, and it is a strapping pin. **Dropped.** [JUDGEMENT — changed by review]

---

## Repo delta (exact TypeScript, with file:line)

Zero new production dependencies. `fetch` and `AbortSignal.timeout` are Node ≥22 builtins and `package.json:12-14` already pins `>=22`. D-11 is not touched. [FACT]

### a. `src/state.ts` — replace `:1-2`, `:4-10`, `:12-14`, `:16-27`, `:40-49`

```ts
export type Level = 'available' | 'interruptible' | 'dnd';
export type OnOff = 'on' | 'off';
export type Confirmed = Level | 'unknown';

export const LEVELS = ['dnd', 'interruptible', 'available'] as const;
export const RANK: Record<Level, number> = { available: 0, interruptible: 1, dnd: 2 };

export function isLevel(v: unknown): v is Level {
  return v === 'available' || v === 'interruptible' || v === 'dnd';
}

/** Derived, never stored in memory. The wire/disk `intended` field is always this. */
export function levelToOnOff(level: Level): OnOff {
  return level === 'available' ? 'off' : 'on';
}

/** Legacy boolean -> ladder. `true` rounds UP to dnd: a client that can only say
 *  yes/no is telling you it does not know how bad it is. */
export function onAirToLevel(onAir: boolean): Level {
  return onAir ? 'dnd' : 'available';
}

/** The higher rung wins. Used wherever two sources of level information disagree. */
export function higher(a: Level, b: Level): Level {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface OnAirState {
  level: Level;
  confirmed: Confirmed;
  source: string;
  updatedAt: string;
  message: string | null;
}

/** What actually lands on disk. `intended` is rollback insurance, typed so it cannot
 *  be deleted by a refactor without a compile error. */
export type PersistedState = OnAirState & { intended: OnOff };
```

- `defaultState()` (`:12-14`) -> `{ level: 'dnd', confirmed: 'unknown', source: 'boot', … }`. 🔒 See "Defaults" above. This is the one place the draft contradicted itself.
- `isOnAirState` (`:16-27`) accepts **either** a legacy file (`intended` is `'on'|'off'`, no `level`) **or** a new one (`level` is a Level). `confirmed` widens to the three Levels plus `'unknown'`. Extra keys stay permitted (`src/state.ts:19-26` already permits them, which is what makes rollback work).
- `write(onAir: boolean, …)` (`:40-49`) -> `write(level: Level, source: string, now?: Date)`.
- `ageSeconds()` (`:66`) unchanged.

### b. `src/persist.ts` — the migration must **reconcile**, not prefer 🔒 [CRITICAL, changed by review]

The draft resolved `level: isLevel(p.level) ? p.level : (p.intended === 'on' ? 'dnd' : 'available')` — `level` wins unconditionally. **That is a false-OFF generator in exactly the rollback path `intended` was kept for**, and it was measured against the shipped `dist/`:

`dist/state.js` `write()` is `{ ...this.state, intended: onAir ? 'on' : 'off', … }` [FACT, read today]. The old binary spreads an unknown `level` through untouched while updating `intended`. So after a D-14 rollback the file holds a **stale `level` and a fresh `intended`**, and the draft's roll-forward believes the stale one:

```
disk after the OLD binary is told ON AIR:
{ "level": "available", "intended": "on", "confirmed": "unknown", "source": "detector", ... }
draft resolves level => available    while intended on disk = on
```
Green while Rocket is on camera. The draft's headline evidence only measured that the old binary *starts*; it never measured what the old binary *writes back*.

```ts
import { higher, isLevel, isOnAirState, type OnAirState, type PersistedState } from './state.js';

export async function loadState(file: string): Promise<OnAirState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;   // genuine first boot
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return quarantine(file, raw, 'unparseable JSON');
  }
  if (!isOnAirState(parsed)) return quarantine(file, raw, 'invalid shape');

  const p = parsed as { level?: unknown; intended?: unknown; message?: string | null };
  // 🔒 Reconcile on the ladder, never by precedence. A rolled-back binary writes a fresh
  //    `intended` beside a stale `level`; taking the higher rung is the only safe merge.
  const fromLevel = isLevel(p.level) ? p.level : 'available';
  const fromLegacy = p.intended === 'on' ? 'dnd' : 'available';
  return {
    ...(parsed as OnAirState),
    level: higher(fromLevel, fromLegacy),
    confirmed: 'unknown',
    message: p.message ?? null,
  };
}
```

🔒 **`quarantine()` replaces the old `throw`** [JUDGEMENT — changed by review]. The draft was right that falling back to `defaultState()` silently would be a false-OFF generator — but with `defaultState()` now `dnd`, that objection evaporates, and "throw" was never actually *loud*: `src/index.ts:26` has no try/catch, launchd `KeepAlive` restarts forever, and during the loop `/status`, `/events`, `/display` and `/ui` are **all down**, so nobody can be told anything. Meanwhile the device holds its last value and Node can never correct it.

```ts
async function quarantine(file: string, raw: string, why: string): Promise<OnAirState> {
  const dest = `${file}.corrupt-${Date.now()}`;
  await writeFile(dest, raw, 'utf8').catch(() => {});
  const s = defaultState();                       // level: 'dnd'
  s.source = 'recovered';
  s.message = `state file was ${why}; quarantined to ${dest}`;
  return s;
}
```
Louder than a crash loop (the message renders on `/display` and `/ui`), and it lands on the **safe** rung.

🔒 **The backfill is still what stops the first start after upgrade from bricking the service** — every existing `~/.onair/state.json` lacks `level`.

`saveState` (`:18-22`) needs no change beyond retyping to `PersistedState`.

### c. `src/driver.ts` — replace `:1-14` entirely

```ts
import { type Confirmed, type Level } from './state.js';

export interface LightDriver {
  /** Command the device, then read back. Returns what the device confirmed. Never throws. */
  set(level: Level): Promise<Confirmed>;
  /** Read the device's own current level. 'unknown' if unreachable/unparseable. Never throws. */
  read(): Promise<Confirmed>;
  /** Has the panel repainted since the last call? `null` = the driver cannot tell. */
  repainted?(): Promise<boolean | null>;
}

export class NoopDriver implements LightDriver {
  constructor(private readonly log: (line: string) => void = console.log) {}
  async set(level: Level): Promise<Confirmed> {
    this.log(`[noop-driver] light -> ${level.toUpperCase()}`);
    return 'unknown';
  }
  async read(): Promise<Confirmed> { return 'unknown'; }
}
```

**`close()` is dropped.** [JUDGEMENT — changed by review] Both implementations would have been `async close() {}`, `fetch` owns no socket the driver holds, and its only caller was `supervisor.stop()`. Speculative interface growth against this repo's "minimum code that solves the problem" standard.

🔒 **Every `implements LightDriver` in `test/` must gain `read()` in the same commit**, or `npm run check` (`package.json:19` `pretest`) hard-fails before a single test runs. The draft's test list named only the `set` signature lines and would have failed Step 1:
- `test/app.test.ts:10-16` `StubDriver`
- `test/app.test.ts:41-45` `FailingDriver`
- `test/server.test.ts:13-28` `StubDriver` (with `gate`/`fail`/`throwValue`)

### d. NEW `src/esphome-driver.ts` (~120 lines)

```ts
import { isLevel, type Confirmed, type Level } from './state.js';
import type { LightDriver } from './driver.js';

export interface EsphomeDriverOptions {
  host: string;                 // "10.42.12.77" or "elegoo-esp32.local", no scheme
  entity?: string;              // ESPHome select NAME (not object_id). Must match the YAML `name:`.
  username?: string;
  password?: string;
  timeoutMs?: number;           // 2000
  retries?: number;             // 1
  retryGapMs?: number;          // 400 - correlated burst loss makes a zero-gap retry worthless
  log?: (line: string) => void;
}

export class DriverConfigError extends Error {}   // 404: wrong name/action. Never retried.

/**
 * Drives an ESPHome `select` over web_server's REST API (ESPHome 2026.8.0, esp-idf).
 *
 *   POST /select/<Name>/set?option=<level>  -> 200, EMPTY body, applied AFTER the response.
 *                                              Invalid option silently dropped, still 200.
 *   GET  /select/<Name>                     -> {"id":"select/<Name>","value":"..","state":".."}
 *   GET  /sensor/Frames                     -> {"id":"sensor/Frames","value":..,"state":".."}
 *
 * NAME COUPLING: the URL segment is the entity `name:` in configs/elegoo-esp32.yaml
 * (web_server.cpp:167). Renaming there breaks every URL here. verifyOptions() catches it.
 */
export class EsphomeSelectDriver implements LightDriver {
  private readonly base: string;
  private readonly entity: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryGapMs: number;
  private readonly log: (line: string) => void;
  private lastFrames: number | null = null;

  constructor(opts: EsphomeDriverOptions) {
    this.base = `http://${opts.host}`;
    this.entity = encodeURIComponent(opts.entity ?? 'Presence');
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 1;
    this.retryGapMs = opts.retryGapMs ?? 400;
    this.log = opts.log ?? console.log;
    this.headers = opts.username
      ? { authorization: `Basic ${Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64')}` }
      : {};
  }

  /**
   * One-shot startup check. Single un-retried fetch so it can DISTINGUISH the two
   * failures that Risk 3 depends on telling apart:
   *   throws DriverConfigError -> the entity name is wrong (404). Loud, actionable.
   *   returns null             -> the device is unreachable. Not an error; do not crash.
   */
  async verifyOptions(): Promise<string[] | null> {
    try {
      const res = await fetch(`${this.base}/select/${this.entity}?detail=all`,
        { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 404) {
        throw new DriverConfigError(`no select entity named "${this.entity}" on ${this.base}`);
      }
      if (res.status === 401) throw new DriverConfigError(`web_server auth rejected by ${this.base}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { option?: unknown };
      return Array.isArray(body.option) ? (body.option as string[]) : null;
    } catch (err) {
      if (err instanceof DriverConfigError) throw err;
      this.log(`[esphome-driver] verifyOptions: device unreachable (${errText(err)})`);
      return null;
    }
  }

  async set(level: Level): Promise<Confirmed> {
    const url = `${this.base}/select/${this.entity}/set?option=${level}`;
    // fetch() with no body sends Content-Length: 0 and no Content-Type, which is what
    // the device requires -- web_server_idf returns 411 if Content-Length is absent.
    const ok = await this.attempt(async () => {
      const res = await fetch(url, { method: 'POST', headers: this.headers,
                                     signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 404) throw new DriverConfigError(`404 ${url}`);
      if (!res.ok) throw new Error(`POST ${res.status}`);
      await res.arrayBuffer();  // drain
      return true;
    });
    if (!ok) return 'unknown';
    return this.read();         // the 200 proves nothing; read back
  }

  async read(): Promise<Confirmed> {
    const body = await this.getJson(`${this.base}/select/${this.entity}`);
    const state = (body as { state?: unknown })?.state;
    return isLevel(state) ? state : 'unknown';
  }

  /** true if the device's frame counter advanced since the previous call. */
  async repainted(): Promise<boolean | null> {
    const body = await this.getJson(`${this.base}/sensor/Frames`);
    const n = Number((body as { value?: unknown })?.value);
    if (!Number.isFinite(n)) return null;
    const prev = this.lastFrames;
    this.lastFrames = n;
    return prev === null ? null : n > prev;
  }

  private async getJson(url: string): Promise<unknown> {
    return this.attempt(async () => {
      const res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`GET ${res.status}`);
      return (await res.json()) as unknown;
    });
  }

  /** Runs fn with `retries` extra attempts, spaced by retryGapMs. Never throws except
   *  DriverConfigError, which is a config bug and is not worth retrying. */
  private async attempt<T>(fn: () => Promise<T>): Promise<T | null> {
    let last: unknown;
    for (let i = 0; i <= this.retries; i++) {
      try { return await fn(); }
      catch (err) {
        if (err instanceof DriverConfigError) { this.log(`[esphome-driver] CONFIG: ${errText(err)}`); return null; }
        last = err;
        if (i < this.retries) await new Promise((r) => setTimeout(r, this.retryGapMs));
      }
    }
    this.log(`[esphome-driver] ${errText(last)}`);
    return null;
  }
}
```

### e. NEW `src/supervise.ts` — poll / re-assert / decay, **inside the write queue**

Three defects the reviewers found in the draft's version are fixed here, and each one mattered:

1. 🔒 **`lastAssertAt` only advances on a successful `set()`.** The draft advanced it on the `read()` path too, so with `pollMs`(5 s) < `reassertMs`(60 s), `now - lastAssertAt` **never reached 60 s while polls succeeded** — `driver.set()` would have run on the first tick and never again, `last_write_ms` would be bumped once at ~5 s and never refreshed, and the panel would go STALE at 90 s **in the fully healthy case, forever**. It looks correct through Steps 6, 7 and 8 and only rots during the soak. [FACT — the draft's own code]
2. 🔒 **It runs inside the shared write queue.** Every other writer goes through `enqueueWrite` (`src/server.ts:53-57`, applied at `:293,:317,:343,:349`), and `test/server.test.ts:233-277` exists specifically to prove writes cannot race through the driver. A supervisor `set('available')` in flight for up to 4.4 s while `POST /dnd` lands would leave the device on **`available` while `/status` says `dnd`** — a false green created by the supervisor itself. [FACT]
3. 🔒 **It obeys the ladder rule.** The draft's reconcile branch (`got !== want -> set(want)`) and its boot re-apply would happily push a 16-day-old `available` onto a device correctly showing `dnd`. The draft itself measured the live service serving `ageSeconds: 1425395` (16.5 days). [FACT]

```ts
import { higher, RANK, type Confirmed, type Level, type OnAirState, type StateStore } from './state.js';
import type { LightDriver } from './driver.js';

export interface SuperviseOptions {
  store: StateStore;
  driver: LightDriver;
  /** Wrap every store/driver mutation, so supervisor writes serialise with HTTP writes. */
  enqueue: (run: () => Promise<void>) => Promise<void>;
  /** Called only when `confirmed` actually changes: one event per transition. */
  onChange: (state: OnAirState) => void;
  pollMs?: number;      // 5000
  reassertMs?: number;  // 60000 - also refreshes the device's STALE watchdog
  decayMs?: number;     // 30000
  freshS?: number;      // 90 - matches the device's STALE_MS
  log?: (line: string) => void;
}

export function startSupervisor(o: SuperviseOptions): { stop: () => void } {
  const pollMs = o.pollMs ?? 5000, reassertMs = o.reassertMs ?? 60000;
  const decayMs = o.decayMs ?? 30000, freshS = o.freshS ?? 90;
  const log = o.log ?? console.log;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastAssertAt = Date.now();   // seeded by the successful boot assert in app.ts
  let lastGoodAt = Date.now();

  /** 🔒 THE LADDER RULE, in code. Raising or matching is always allowed.
   *  Lowering requires fresh evidence. */
  function mayAssert(want: Level, got: Confirmed): boolean {
    const fresh = o.store.ageSeconds() <= freshS;
    if (got === 'unknown') return fresh || want !== 'available';
    return RANK[want] >= RANK[got] || fresh;
  }

  async function tick(): Promise<void> {
    const want = o.store.get().level;
    const due = Date.now() - lastAssertAt >= reassertMs;

    // Heartbeat, but only if we are allowed to assert `want` right now.
    let got: Confirmed;
    if (due && mayAssert(want, 'unknown')) {
      got = await o.driver.set(want);
      if (got === want) lastAssertAt = Date.now();   // ONLY a successful set() refreshes it
    } else {
      got = await o.driver.read();
    }

    if (got !== 'unknown' && got !== want) {
      if (mayAssert(want, got)) {
        log(`[supervisor] device says ${got}, want ${want} - re-asserting`);
        got = await o.driver.set(want);
        if (got === want) lastAssertAt = Date.now();
      } else {
        // 🔒 Our level is stale and lower than the device's. Believe the device.
        log(`[supervisor] device says ${got}, our stale ${want} is lower - deferring to device`);
      }
    }

    // 🔒 confirmed must describe PIXELS, not a variable.
    let painting: boolean | null = null;
    if (got === want && o.driver.repainted) painting = await o.driver.repainted();

    let next: Confirmed;
    if (got === want && painting !== false) {
      lastGoodAt = Date.now();
      next = want;
    } else if (painting === false) {
      log('[supervisor] device state agrees but the panel is not repainting');
      next = 'unknown';
    } else if (Date.now() - lastGoodAt > decayMs) {
      next = 'unknown';                     // 🔒 an admission of ignorance, never a claim
    } else {
      next = o.store.get().confirmed;       // hold briefly through a single blip
    }

    if (next !== o.store.get().confirmed) o.onChange(o.store.setConfirmed(next));
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      o.enqueue(tick).catch((err) => log(`[supervisor] ${String(err)}`)).finally(schedule);
    }, pollMs);
    timer.unref?.();
  }
  schedule();

  // 🔒 stop() is SYNCHRONOUS and does not await an in-flight tick. test/app.test.ts:87-93
  //    and test/ws.test.ts assert close() resolves fast; awaiting a 4.4s driver.set would
  //    break both. The queue's own promise chain is abandoned, which is safe: tick() only
  //    mutates an in-memory store the process is about to drop.
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
```

🔒 **The withheld heartbeat.** `mayAssert(want,'unknown')` returns `false` when `level === 'available'` and the store is stale — so the supervisor **stops asserting** and lets the device's own watchdog trip into NO DATA. This is not a state change (D-6-safe); it is *withdrawal of a liveness assertion*. It closes the case the draft had no answer for: detector dies at 09:00 with `level: available`, Node heartbeats that value faithfully all day, panel shows a permanently non-stale calm dot. [JUDGEMENT — added by review]

### f. `src/server.ts`

- **`:27-38` `ROUTES`** — add `'/available': ['POST'], '/interruptible': ['POST'], '/dnd': ['POST']`.
- **`:236` `willReadBody`** — unchanged, and that is deliberate. The new routes are no-body, which is exactly why this idiom was chosen over path parameters; honour the warning comment at `:232-235`.
- **`:52-57` `enqueueWrite`** — hoist out of `createApiServer` so `app.ts` can hand the *same* queue to both the server and the supervisor. Add it to `ServerDeps` (optional; `createApiServer` creates its own if absent, preserving every existing test).
- **`:126-128` `statusBody`**
  ```ts
  function statusBody(deps: ServerDeps): OnAirState & { intended: OnOff; ageSeconds: number } {
    const s = deps.store.get();
    return { ...s, intended: levelToOnOff(s.level), ageSeconds: deps.store.ageSeconds() };
  }
  ```
- **`:130-133` `persistCurrent`** — typed, **not cast**. The draft wrote `as OnAirState`, which suppresses the very field the rollback insurance depends on; delete the cast in a future cleanup and the insurance vanishes with zero type errors and zero test failures.
  ```ts
  function persistCurrent(deps: ServerDeps): Promise<void> {
    const s = deps.store.get();
    const out: PersistedState = { ...s, intended: levelToOnOff(s.level), confirmed: 'unknown' };
    return deps.persist(out);   // ServerDeps.persist: (s: PersistedState) => Promise<void>
  }
  ```
- **`:153-169` `doWrite`** — signature `doWrite(deps, level: Level, source, log)`; `:159` -> `store.write(level, source)`; `:163` -> `driver.set(level)`.
- **`:325-346` `PUT /state`**
  ```ts
  const { level, onAir, source } = body as { level?: unknown; onAir?: unknown; source?: unknown };
  let target: Level;
  if (level !== undefined) {
    if (!isLevel(level)) return sendJson(res, 400, { error: `level must be one of ${LEVELS.join(', ')}` });
    if (onAir !== undefined) {
      if (typeof onAir !== 'boolean') return sendJson(res, 400, { error: 'onAir must be a boolean' });
      if (levelToOnOff(level) !== (onAir ? 'on' : 'off')) {                      // 🔒
        return sendJson(res, 400, { error: 'level and onAir disagree' });
      }
    }
    target = level;
  } else if (typeof onAir === 'boolean') {
    target = onAirToLevel(onAir);
  } else {
    return sendJson(res, 400, { error: 'body must contain level or onAir' });
  }
  ```
  `{"onAir":true,"level":"available"}` must be a 400, never a silent pick.
- **`:349` `POST /on|/off`** -> a map:
  ```ts
  const PATH_LEVEL: Record<string, Level> = {
    '/on': 'dnd', '/off': 'available',
    '/dnd': 'dnd', '/interruptible': 'interruptible', '/available': 'available',
  };
  await enqueueWrite(() => doWrite(deps, PATH_LEVEL[path]!, url.searchParams.get('source') ?? 'manual', log));
  ```

**`src/sse.ts` and `src/ws.ts` need no change.** Both are pure transports for `statusBody` (`server.ts:240,275,102,136`); `src/ws.ts` contains zero references to `intended`. The new fields appear on all three surfaces at once. [FACT]

### g. `src/app.ts` — `:23-34`, plus wiring

```ts
  const loaded = await loadState(opts.stateFile);
  const store = new StateStore(loaded ?? defaultState());   // defaultState() is now dnd

  // 🔒 Startup config check. Called, not merely defined (the draft defined it and never
  //    called it, while three separate risk mitigations named it).
  if (driver instanceof EsphomeSelectDriver) {
    const opts_ = await driver.verifyOptions();             // throws DriverConfigError on 404/401
    if (opts_ !== null) {
      const want = [...LEVELS].sort().join(',');
      if ([...opts_].sort().join(',') !== want) {
        throw new Error(`device option list ${JSON.stringify(opts_)} != ${JSON.stringify(LEVELS)}`);
      }
    } else {
      log('[onair] light unreachable at boot; continuing with confirmed=unknown');
    }
  }

  // Invariant: recover after restart - re-apply the level to the light on boot,
  // 🔒 subject to the ladder rule. A stale file must not push the device DOWN.
  try {
    const cur = await driver.read();
    const want = store.get().level;
    const fresh = store.ageSeconds() <= 90;
    if (cur !== 'unknown' && RANK[want] < RANK[cur] && !fresh) {
      log(`[onair] boot: device says ${cur}, our stale ${want} is lower - adopting the device`);
      store.setConfirmed(cur);
    } else {
      store.setConfirmed(await driver.set(want));
    }
  } catch (err) {
    log(`[onair] boot driver re-apply failed: ${errorMessage(err)}`);
    store.setConfirmed('unknown');
  }
```
A `DriverConfigError` from `verifyOptions()` **does** propagate and stop the service: a wrong entity name is a deploy bug that must be loud. An *unreachable* device does not, because crash-looping on an unreachable light is the failure mode `persist.ts` was just fixed to avoid.

After `server.listen`, start the supervisor; `close()` becomes `async` and stops it **without awaiting an in-flight tick** (`src/app.ts:58-64` currently returns a `new Promise` with a synchronous executor, which cannot `await` anything):

```ts
  const supervisor = startSupervisor({
    store, driver, enqueue: enqueueWrite, log,
    onChange: (s) => {
      const b = { ...s, intended: levelToOnOff(s.level), ageSeconds: store.ageSeconds() };
      hub.broadcast(b); wsBridge.broadcast(b);
    },
  });

  close: async () => {
    supervisor.stop();                 // synchronous: clearTimeout + stopped flag
    hub.closeAll(); wsBridge.closeAll(); server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
```

### h. `src/index.ts` — driver selection from config

```ts
const lightHost = process.env.ONAIR_LIGHT_HOST;          // e.g. "10.42.12.77"
const driver = lightHost
  ? new EsphomeSelectDriver({
      host: lightHost,
      entity: process.env.ONAIR_LIGHT_ENTITY ?? 'Presence',
      username: process.env.ONAIR_LIGHT_USER,
      password: process.env.ONAIR_LIGHT_PASS,
    })
  : undefined;                                           // -> NoopDriver, unchanged behaviour
const app = await createApp({ port, stateFile, token, driver });
```
Set these in `~/.onair/config.env` (D-14: the service reads it at startup; the plist never changes).

### i. Renderers

`src/display.ts` — 🔒 **four appearances, not three**:
- `:21-24` CSS: add `body.interruptible { background: #b38600; }` and `body.unknown { background: #4a0000; }`. Keep `.on` -> `#b30000` as the `dnd` class.
- 🔒 `:39-40` — **stop asserting a state before any data arrives.** Ship `<body class="unknown">` with `NO DATA`, not `<body class="off">OFF AIR`. Today the page claims "not on air" during exactly the window when the server may be crash-looping. `grep -n "location.reload" src/display.ts src/ui.ts` returns nothing [FACT, run today], so a kiosk tab under D-10 can be running week-old JS — which is precisely why `intended` stays on the wire.
- `:79-87` `render(s)` — switch on `s.level`, with `s.intended` as the fallback for a stale tab.
- 🔒 `:25-31` **keep the DISCONNECTED overlay at `rgba(0,0,0,0.85)`** — it dims the state colour to 15% rather than replacing it. An overlay that blanked the background would turn every blip into a false green.
- 🔒 **D-9's message rule extends to four appearances:** a `message` may never replace or obscure the state word in `dnd` or `interruptible` (`src/display.ts:83` currently lets a message replace the word outright). Render it as a subordinate line.

`src/ui.ts` — three buttons, not two: `:62-63` pill classes, `:130` `.btn-*.active`, `:179-180` `.ev-intended.*`, `:220` initial pill, `:231-232` buttons, `:283` console default body (`{"level":"dnd","source":"webui"}`), `:531-533` `logKey`, `:552-555` log row, `:575-587` `render`, `:589-593` `doAction`. This is the largest single hunk and it is justified in one line: **the detector will never produce `interruptible`, so `/ui` is the only way the middle rung gets used at all in v1.**

### j. Docs, decisions, tests

**Docs:** `docs/api-contract.md:11-17` (field table; mark `intended` **derived, read-only, retained for compatibility**), `:15` (document the heartbeat clobbering the middle rung), `:19-22`, `:28-40`, `:42-56`, `:157`; `CONTEXT.md:56` glossary (Call state is no longer a boolean); `CONTEXT.md:93` open question -> **closed**. `docs/companion-setup.md` needs **no change to keep working**; add the optional `level` feedback as a note.

**Decisions — three are amended, not one** (`CLAUDE.md` and `docs/agents/domain.md` make `CONTEXT.md ## Decisions` the ADR record):
- **D-6** (`CONTEXT.md:125-129`) — restate on the ladder. New text: *"The server never lowers `level`, and never asserts a lower rung to the light, without fresh evidence (`ageSeconds <= 90`). Raising or matching is always allowed. Staleness remains visible and never acted on."*
- **D-9** (`CONTEXT.md:138-144`) — the safety rule gains a fourth appearance (`unknown`) and the message rule extends to it.
- **D-12** (`CONTEXT.md:157-166`) — **superseded.** Light hardware is no longer on hold; `confirmed` is no longer permanently `"unknown"`; status feedback keys off `level`, with `intended` retained for compatibility.
- **New decision** recording: three-state ladder, HTTP/`web_server` transport, `select` entity, basic auth, index-0-is-dnd.

**Tests that break and must move:** `test/state.test.ts:5-14,16-25,49-54`; `test/persist.test.ts:40-45,47-56,58-69`; `test/server.test.ts` (**29** lines matching `onAir|intended` — the draft said 32; verify with `grep -c`); `test/app.test.ts:12-14,26,35` **plus the three stub class bodies** (see 4c); `test/ws.test.ts:13-14,185,194-203,252`; `test/sse.test.ts:39-41,53-56`; `test/driver.test.ts:8-10`.

**Six tests to ADD** (gate Step 1 on these **by name**, not on a suite count — a refactor that consolidates two tests while adding three still lands at 81):
1. `loads a legacy state file (intended, no level) with level derived`
2. 🔒 `reconciles a rolled-back file: {level:"available", intended:"on"} loads as dnd`
3. 🔒 `a state file written by the new code still passes the previous shape's validator` (rollback regression)
4. 🔒 `a corrupt state file is quarantined and loads as dnd with a message`
5. `supervisor: an unknown driver for > decayMs decays confirmed to unknown; a mismatched Level triggers a re-assert`
6. 🔒 `supervisor: a stale, lower-ranked level is NOT asserted down onto a higher-ranked device`
7. 🔒 `a POST /dnd arriving mid-supervisor-tick leaves the device on dnd` (write-queue serialisation)

---

## Making `confirmed` genuine

**What it reads.** The device's own `current_option()` (`select/select.h:43`), fetched with `GET /select/Presence` and parsed from `state`. `web_server.cpp:1483` is `obj->has_state() ? obj->current_option() : StringRef()` — **not an echo of the last write.** [FACT] This is the "extra credit" criterion in `CONTEXT.md:41-42` that every purpose-built battery busylight failed.

**Plus a frame counter, because a variable is not a pixel.** [added by review] `select_json_` reads a member set in the same call chain as the POST; the display is a separate `PollingComponent` writing over I2C. If the bus wedges, the SH1106 NAKs, or the display component faults, `current_option()` still returns `dnd`, the GET still returns `{"state":"dnd"}`, and a naive `confirmed` **vouches with total confidence for a frozen panel**. A frozen panel showing `free` from ten minutes ago is then indistinguishable from a correct `free`. The `frames` global (device delta 3f) bumped as the last statement of every display path, exposed as `sensor: Frames`, and checked by `driver.repainted()` closes this: a stalled counter forces `confirmed: 'unknown'` regardless of what the select says. [JUDGEMENT]

**Why the read-back is mandatory.** See Transport: the 200 is sent before the value is applied and regardless of whether it ever will be. **Mitigate three ways:** derive the option strings from `LEVELS` in `state.ts` (never a literal at the call site), call `verifyOptions()` once at driver startup and fail loudly on a mismatched name or option list, and read back on every write.

**Values.** `confirmed: Level | 'unknown'`. 🔒 **`unknown` is never flattened into a Level.** A renderer that maps `unknown -> available -> blank` has re-created false-OFF inside the renderer.

**Decay.** `confirmed -> 'unknown'` after **30 s** with no successful read. 🔒 **`confirmed` decays; `level` never does.**

**On device reboot — four layers, in order:**
1. `restore_value: true` restores the last written option from NVS. The OLED is correct within one 500 ms frame.
2. 🔒 `on_boot: priority: -100` re-zeroes `last_write_ms`, so the device knows no controller has spoken *since this boot* and renders STALE — and if the restored value is `available`, renders NO DATA instead. **This layer does not exist without device delta 3a.**
3. Node's supervisor detects the mismatch or hits its 60 s heartbeat, re-POSTs (subject to the ladder rule), `on_value` fires, `last_write_ms` refreshes, STALE clears. Worst case ~60 s of an honest STALE band; typical 5 s.
4. `app.ts` re-applies `store.get().level` at startup, so a *service* restart also converges — but never downward on stale evidence.

**Constants:** request `2000 ms`, retries `1` @ `400 ms` gap, poll `5000 ms`, re-assert `60000 ms`, decay `30000 ms`, freshness bound `90 s`, device `STALE_MS 90000`. Do not tighten the poll below ~5 s or the timeout below ~1 s.

---

## If pushes prove unreliable: plan B

[UNRESOLVED — **none of this section has been compiled.** The APIs check out by inspection (`select/select.h:48` `has_option(const std::string&)`, `:70` `option_at(size_t) -> const char*`, `select/select_call.h:25` `set_option(const char*)`, `http_request/__init__.py:343-350` binds both `response` and `body` under `capture_response`, `:144-147` lists `esp_idf=cv.Version(0,0,0)` so there is no framework gate) but treat the YAML as a sketch, not a delta. [FACT for the API refs]]

**Trigger, stated now so it is not a judgement call later.** After the demo, soak one hour with supervisor logging. Switch to Plan B if **any** of: poll success < 95% over the hour (>~36 failed ticks of 720); the STALE/NO-DATA treatment appears more than twice; or **median HTTP set->confirm exceeds 1500 ms** after `power_save_mode: NONE` is deployed. Deploy `NONE` first — do not evaluate against the light-sleep link.

**Why it would help.** Push requires the *initiator* to reach a sleepy peer. Inverting it makes the ESP32 the initiator: it retries on its own schedule, from a stack that knows when its radio is awake, against an always-on listener.

**Shape.** One new Node route, `GET /device/level?have=<level>` -> `200 text/plain`, body = the bare target level plus `\n`. `have` is the device reporting its rendered level; Node records it as `confirmed` and stamps `lastSeenAt`, decaying to `'unknown'` after the same 30 s. Device side: `http_request:` + `interval: 5s` doing a GET, validating the response with `has_option()` before `make_call().set_option(...).perform()`, and bumping `last_write_ms` itself.

🔒 Under pull, `last_write_ms` becomes a **true end-to-end watchdog** — it goes stale if the network is down, if the Mac is down, or if the service crashed, all of which must not render as `available`. Strictly stronger than the push watchdog.

⚠️ **Known cost:** `http_request.get` on esp-idf is a synchronous `esp_http_client_perform` on the main loop. With `timeout: 3s`, an unreachable Mac freezes the loop for 3 s out of every 5 — exactly the scenario Plan B exists to survive, and the OLED visibly stops updating. Set `watchdog_timeout:` (`http_request/__init__.py:120-124`, esp32-only) and shorten the timeout to ~1500 ms if adopted. [FACT]

Node-side cost is ~15 lines plus degrading `EsphomeSelectDriver` to a passive recorder. Keep `LightDriver` as the seam so the swap is one line in `index.ts`. Use the Mac's LAN IP, not `.local` — mDNS resolution from the ESP32 adds a failure mode you cannot debug from the device.

---

## Step-by-step to a working demo (exact commands + acceptance per step)

One acceptance criterion per step. **Stop at the first failure.**

### Step 1 — repo change, red then green
```bash
cd /Users/john/code/rocket-on-air-sensor
git switch -c three-state-esp32
# apply Repo delta a-j
npm test && npx tsc --noEmit && echo "STEP1_OK"
```
**Accept:** both exit 0, **and all seven named tests from Repo delta (j) appear in the output**. Do not gate on a suite count.

### Step 2 — device config, validate
```bash
cd /Users/john/code/esp32
# apply Device config delta a-h to configs/elegoo-esp32.yaml
# add web_server_password to configs/secrets.yaml and secrets.yaml.example
make validate
```
**Accept:** `INFO Configuration is valid!`, exit 0. The only warning is the pre-existing GPIO2 strapping-pin notice.

### Step 3 — compile before flashing
```bash
cd /Users/john/code/esp32 && make compile
```
**Accept:** `Successfully compiled program`, exit 0, `Flash:` under **60%**. Draft reference build (without on_boot/frames/auth): `RAM 25.6% (46208/180736)`, `Flash 51.2% (939623/1835008)`.

### Step 4 — flash over the air, no cable
```bash
cd /Users/john/code/esp32 && make flash
```
`make flash` is `esphome run` -> OTA over port 3232.
**Accept:** the device reboots and `ping -c 3 10.42.12.77` recovers within ~30 s.

### Step 5 — prove the latency hypothesis, **and measure HTTP**
```bash
ping -c 20 -i 0.5 10.42.12.77 | tail -2
for i in $(seq 1 20); do
  curl -s -u onair:PASS -o /dev/null -w '%{time_total}\n' -m 3 http://10.42.12.77/select/Presence
done | sort -n | awk '{a[NR]=$1} END{print "median", a[int(NR/2)], "max", a[NR]}'
```
**Accept:** ping `avg < 15 ms`, `max < 50 ms`; HTTP **median < 300 ms**. Baseline before the change: `min 3.104 / avg 64.583 / max 124.361`.
Note `ping` is answered by LwIP, not the main loop — that is why the HTTP loop is here too; the draft had no HTTP-latency measurement at all and the design depends on that number.
If ping avg is still > 50 ms, `power_save_mode: NONE` did not take: `make validate | grep -A2 power_save` before tuning any timeout. If HTTP is slow while ping is fast, suspect the I2C/display duty cycle — re-check `frequency: 400kHz` landed.

### Step 6 — the wire transcript (this is the deliverable)
```bash
IP=10.42.12.77; A="-u onair:PASS"
echo "--- option list";          curl -s $A -m 3 "http://$IP/select/Presence?detail=all"; echo
echo "--- initial";              curl -s $A -m 3 "http://$IP/select/Presence"; echo
echo "--- POST -> 200 EMPTY";    curl -s $A -m 3 -o /dev/null -w '%{http_code} %{size_download}\n' -X POST "http://$IP/select/Presence/set?option=available"
                                 curl -s $A -m 3 "http://$IP/select/Presence"; echo
echo "--- interruptible";        curl -s $A -m 3 -X POST "http://$IP/select/Presence/set?option=interruptible" -o /dev/null
                                 curl -s $A -m 3 "http://$IP/select/Presence"; echo
echo "--- THE TRAP: bogus";      curl -s $A -m 3 -o /dev/null -w '%{http_code}\n' -X POST "http://$IP/select/Presence/set?option=BOGUS"
                                 curl -s $A -m 3 "http://$IP/select/Presence"; echo
echo "--- unknown entity";       curl -s $A -m 3 -o /dev/null -w '%{http_code}\n' "http://$IP/select/Nonexistent"
echo "--- no auth must fail";    curl -s     -m 3 -o /dev/null -w '%{http_code}\n' -X POST "http://$IP/select/Presence/set?option=available"
echo "--- frames advancing";     curl -s $A -m 3 "http://$IP/sensor/Frames"; sleep 3; curl -s $A -m 3 "http://$IP/sensor/Frames"; echo
echo "--- OTA endpoint closed";  curl -s $A -m 3 -o /dev/null -w '%{http_code}\n' -X POST "http://$IP/update"
```
**Accept, line by line:**
- option list contains `"option":["dnd","interruptible","available"]`
- initial read is `{"id":"select/Presence","value":"dnd","state":"dnd"}` — **`dnd`, not `available`**, because index 0 is the safe state
- POST line prints exactly `200 0` — the empty body, proving the read-back is required
- after `available` -> `"state":"available"`; after `interruptible` -> `"state":"interruptible"`
- BOGUS prints `200` and the state is **still `interruptible`**. Seeing this trap confirmed is worth more than every happy-path line above it.
- `/select/Nonexistent` -> `404`
- the un-authenticated POST -> `401`
- `Frames` value strictly increases across the 3 s gap
- `POST /update` -> **anything other than `200`.** Expect **`000` with curl exit 52** (no handler matches, `web_server_idf.cpp:251-255` returns `ESP_ERR_NOT_FOUND` with no response written and the socket closes); `403`/`404`/`500` also pass. A `200` means `ota: false` did not take.

### Step 7 — physical proof
For each of the three POSTs, photograph the OLED. **Accept, from across the room without reading any word:**
- `dnd` -> a solid white block filling the top 48 px, `ON AIR` knocked out in black, **IP and dBm still legible in the bottom band**
- `interruptible` -> an inset double frame, dark interior, `BUSY`, band intact
- `available` -> a thick lit ring with `FREE` inside, band intact
- **Check `ON AIR` is not clipped at either edge.** If it is, drop `status_huge` to size 26.
- 🔒 **Photograph the powered-off panel and the `available` panel from the same spot under the same light. If you cannot tell them apart, the renderer has failed and this step does not pass.**
- 🔒 **Unplug the Mac from the network for 2 minutes with the device on `available`:** the panel must switch to the hatched `NO DATA` band. If it stays showing `FREE`, the watchdog is not wired and the whole safety argument fails.
- 🔒 **Power-cycle the board while set to `dnd`:** it must come back showing `ON AIR` (restore_value) **with `STALE`** (`on_boot` re-zeroed `last_write_ms`), and `STALE` must clear within 60 s once the service reconnects. **This is the acceptance test the draft would have failed.**

### Step 8 — end to end through the API
```bash
cd /Users/john/code/rocket-on-air-sensor
cat >> ~/.onair/config.env <<'EOF'
ONAIR_LIGHT_HOST=10.42.12.77
ONAIR_LIGHT_USER=onair
ONAIR_LIGHT_PASS=<the web_server_password>
EOF
npm run build && onair restart          # no sudo: INSTALL.md:73,114 / docs/mac-setup.md:113,129,228
sleep 3
curl -s localhost:8484/status; echo
curl -s -X POST 'localhost:8484/dnd?source=manual' >/dev/null; sleep 2
curl -s localhost:8484/status; echo
curl -s -X PUT -H 'content-type: application/json' -d '{"level":"interruptible","source":"webui"}' localhost:8484/state >/dev/null; sleep 2
curl -s localhost:8484/status; echo
echo "--- legacy path must still work"
curl -s -X PUT -H 'content-type: application/json' -d '{"onAir":true,"source":"detector"}' localhost:8484/state; echo
echo "--- contradiction must be rejected"
curl -s -X PUT -H 'content-type: application/json' -d '{"onAir":true,"level":"available"}' localhost:8484/state; echo
cat ~/.onair/state.json
```
**Accept:**
- `/status` shows `"level":"dnd","intended":"on","confirmed":"dnd"` — 🔒 **`confirmed` is a Level, not `"unknown"`. This is the first time in this project's history that has been true.** (The live service today serves `{"intended":"off","confirmed":"unknown","ageSeconds":1425395}` — 16.5 days stale. That is the invariant being violated right now.)
- after the `interruptible` PUT: `"level":"interruptible","intended":"on","confirmed":"interruptible"` — and the OLED shows the inset frame
- `{"onAir":true}` -> `"level":"dnd"`
- `{"onAir":true,"level":"available"}` -> `400 {"error":"level and onAir disagree"}`
- `~/.onair/state.json` contains **both** `"level"` and `"intended"`

### Step 9 — rollback safety, for real
```bash
cd /Users/john/code/rocket-on-air-sensor
git worktree add /tmp/onair-baseline 2105e61      # NOT `git stash`: it leaves untracked
cd /tmp/onair-baseline && npm ci && npm run build  # new files behind, breaking tsc
cp ~/.onair/state.json /tmp/onair-state.json
ONAIR_PORT=8485 ONAIR_STATE_FILE=/tmp/onair-state.json node dist/index.js
```
**Accept:** the *previous* build starts against the new state file without throwing `state file ... has invalid shape` and without `EADDRINUSE`. Then, the other direction:
```bash
# with the OLD binary still holding /tmp/onair-state.json, drive it ON AIR, then:
cd /Users/john/code/rocket-on-air-sensor
node -e 'import("./dist/persist.js").then(async m => console.log(await m.loadState("/tmp/onair-state.json")))'
```
🔒 **Accept:** the new code loads it as `level: "dnd"` — **not `available`.** This is the ladder reconciliation of Repo delta (b), and it is the check the draft would have failed. The draft's Step 9 used `git stash`, which does not stash untracked files, so `tsc` would have compiled the two new `src/` files against the reverted `state.ts` and died before `node dist/index.js` ever ran.

Cleanup: `git worktree remove /tmp/onair-baseline`.

### Step 10 — soak, and the Plan B decision
Leave it running one hour with supervisor logging on.
**Accept:** poll success ≥ 95%; ≤ 2 STALE appearances; median set->confirm < 1500 ms; **zero unexplained reboots** (the `api: reboot_timeout: 0s` proof — an hour is four missed 15-minute windows); **`Frames` monotonically increasing throughout**; and 🔒 **no `[supervisor] device says … deferring to device` line that was not deliberately provoked**. If any fails, build Plan B.

---

## Risks, in priority order

**1. 🔒 The 15-minute API reboot timer, live right now.** `api.reboot_timeout` defaults to `15min` and fires when no *native API* client connects; measured at 15 min 12 s. Our driver speaks HTTP, so it never satisfies it. **Mitigation:** `api: reboot_timeout: 0s`. Verified in Step 10 — one hour of soak with zero unexplained reboots. This is the single most likely way to ship something that looks fine for 14 minutes.

**2. 🔒 The boot watchdog that isn't.** Without `on_boot: priority: -100`, `on_value` fires during the restore and `last_write_ms` is never 0, so **every reboot has a 90 s window in which a restored `available` renders as a calm dot with nothing behind it.** Correlated failures (power blip taking out router and board together) put you squarely in that window. **Mitigation:** Device delta 3a, verified by Step 7's power-cycle test.

**3. 🔒 Node pushing stale information downward.** The service loads a 16-day-old `available`, POSTs it, and overwrites a device that was correctly showing `dnd` — then `confirmed` faithfully reports the false green. **Mitigation:** the ladder rule in `mayAssert()`, the boot-path guard in `app.ts`, `defaultState()` -> `dnd`, and the persist-time ladder reconciliation. Four separate places; test 6 and Step 9 are the gates. This was the most severe defect in the draft and it appeared in four code paths.

**4. 🔒 The rolled-back state file.** The old binary writes a fresh `intended` beside a stale `level`; naive roll-forward believes the stale one. **Mitigation:** `higher(fromLevel, fromLegacy)` in `persist.ts`, plus test 2 and Step 9's second direction.

**5. 🔒 The silent-drop trap turns a typo into a frozen light.** An invalid option, a missing `option` param, and a renamed entity are all indistinguishable from success at the HTTP layer. If the frozen value is `available`, that is a textbook false OFF. **Mitigation, three layers:** derive option strings from `LEVELS`, never a literal; `verifyOptions()` at startup (now actually called, and now able to distinguish `404` from unreachable); read back on every write. Step 6's BOGUS check is the acceptance test.

**6. 🔒 The rename hazard.** The URL segment is the entity **name**. Renaming `name: "Presence"` silently breaks every driver URL, and because an unmatched URL closes the socket with no HTTP response, it surfaces as `ECONNRESET` and looks exactly like a dead device. **Mitigation:** `verifyOptions()` throws `DriverConfigError` on 404 and returns `null` on unreachable; comment the coupling in both the YAML and `esphome-driver.ts`; never hardcode the name twice.

**7. 🔒 Unauthenticated LAN write = remote false-green.** `POST /select/Presence/set?option=available` is a CORS *simple request*: any page Rocket visits fires it, no preflight. ACAO is not the mechanism and removing it closes nothing. **Mitigation:** `auth: {type: basic}` on the device, one header in the driver. Verified by Step 6's un-authenticated POST returning 401.

**8. 🔒 First start after upgrade bricks the service.** Every existing `~/.onair/state.json` lacks `level`. **Mitigation:** the backfill plus quarantine-instead-of-throw. Step 1 catches it; Step 8 confirms it.

**9. Display duty cycle starving the HTTP server.** At the default 50 kHz, a full SH1106 repaint is ~220 ms; at 500 ms that is ~45% of the main loop on the device that now serves HTTP. **Mitigation:** `i2c: frequency: 400kHz`; measured by Step 5's HTTP loop, not by ping.

**10. `confirmed` vouching for a frozen panel.** The select's model and the panel's pixels are different things. **Mitigation:** the `frames` counter and `driver.repainted()`; Step 6 and Step 10 both check it.

**11. Detector heartbeat will erase manual `interruptible`,** within 60 s, silently, once the detector exists. **Mitigation:** decide the detector's contract now (it writes only `dnd`/`available`), document at `docs/api-contract.md:15`, file a follow-up for a manual hold. Do not build source precedence in v1.

**12. Stale kiosk tabs and Companion.** No `location.reload` anywhere, so a D-10 kiosk tab can run week-old JS. Keeping `intended` on the wire makes that old JS render red rather than a dark "OFF AIR" while Rocket is on camera. Companion's `generic-websocket` leaves a variable *untouched* when the subscribed path is absent and zeroes it on reconnect, with the connection indicator still green. **Mitigation:** do not remove `intended` in this change. Remove it only after Companion is migrated and every kiosk tab reloaded, as a separate boring ticket.

**13. Captive-portal OTA remains reachable in AP-fallback mode.** `ota: false` scopes to `web_server` only. Contained by the fallback AP password; stated here so nobody believes it is fully closed.

**14. ESPHome version drift.** The URL scheme *already changed in 2026.8.0* (name replaced `domain-object_id`), so every pre-2026 blog post showing `/select/presence` is now wrong. **Mitigation:** pin ESPHome in `/Users/john/code/esp32/pyproject.toml` and re-run Step 6's transcript after every firmware upgrade. 30 seconds, catches exactly this class of quiet regression. (Pinning is a separate change in a separate tree — see Open questions.)

**15. SSE deferred, so worst-case out-of-band latency is 5 s.** Node's *own* writes are confirmed in one round trip; only a direct curl to the device or a reboot takes up to a poll interval to notice. Acceptable. If it ever matters, `GET /events` exists on ESP-IDF and any client must handle `lru_purge_enable` closing an idle stream.

---

## What the adversarial review changed

Nine substantive reversals. Each one was a defect that would have shipped.

| # | Change | Severity |
|---|---|---|
| 1 | **`on_boot: priority: -100` added.** `on_value` fires during the restore (`template_select.cpp:27-35` -> `select.cpp:22-34` -> `automation.h:9-14`), so the draft's `last_write_ms == 0` boot watchdog **did not exist**. 90 s of false green after every reboot. | CRITICAL |
| 2 | **Supervisor `lastAssertAt` now advances only on a successful `set()`.** The draft advanced it on `read()` too, so with poll 5 s < reassert 60 s the heartbeat **would have fired exactly once, ever** — permanent STALE in the healthy case, invisible until the soak. | CRITICAL |
| 3 | **The ladder rule is now in code** (`mayAssert`, the `app.ts` boot guard). The draft invented the ordering in prose and then never used it, so boot and reconcile would push a 16-day-old `available` onto a correctly-red device. | CRITICAL |
| 4 | **`persist.ts` reconciles on the ladder instead of preferring `level`.** Measured against the shipped `dist/`: the old binary writes a fresh `intended` beside a stale `level`, so the draft's migration resolved to `available` while `intended` said `on`. | CRITICAL |
| 5 | **`defaultState()` -> `dnd`.** The draft argued index-0-must-be-dnd on the device and set the server default to `available` in the next section, with the boot re-apply overwriting the device within seconds. | HIGH |
| 6 | **`verifyOptions()` is now called**, and can distinguish `404` from unreachable. The draft defined it, cited it as the mitigation for three separate risks, and never wired a call site — and its `attempt()` flattened both failures to `null` anyway. | HIGH |
| 7 | **Supervisor runs inside the shared `enqueueWrite` queue**; `close()` no longer awaits an in-flight tick; `LightDriver.close()` dropped; the three `implements LightDriver` test stubs enumerated (without them `pretest` hard-fails before Step 1's first test). | HIGH |
| 8 | **Renderer fixed:** diagnostics band drawn first with no early `return` (the draft deleted the dBm readout in `dnd` while claiming to preserve it, and its `interruptible` border ran through the band); `available` upgraded from a ~3 mm dot to a 22 px ring, because "unplugged" and "available" were the same dark panel from the stairs — the exact conflation the draft called an invariant violation. `frames` counter added so `confirmed` describes pixels. | HIGH |
| 9 | **`i2c: frequency: 400kHz`;** `wifi: reboot_timeout` 10min not 0s; **auth taken, not skipped**; retry gap 400 ms and the STALE arithmetic corrected (~10 failing cycles, not six); corrupt-file quarantine instead of a silent crash loop; `PersistedState` type instead of a cast; Step 9 uses a worktree not `git stash`; `sudo` dropped; Step 1 gates on named tests; `/update` accepts `000`; Plan B demoted and labelled uncompiled; GPIO2 hunk, `git init`, and the `pyproject.toml` edit dropped from scope. | MEDIUM |

**Where a reviewer was wrong, in one line each:**
- Private Network Access as sufficient mitigation for the unauthenticated endpoint: real for PNA-enforcing browsers only, not other browsers and not anything else on the LAN — so the conclusion (take auth) stands regardless.
- "`ota: false` closes the hole": it scopes to `web_server` only, which the reviewer stated correctly and the draft overstated; recorded as Risk 13 rather than treated as closed.
- The draft's own CORS diagnosis was wrong and all three reviewers said so independently; that is a draft error, not a reviewer error.

---

## Open questions for Rocket

1. **The middle rung's owner.** v1 says the detector writes only `dnd`/`available` and `interruptible` is manual-only via `/ui`. Accept, or do you want a manual-hold flag before the detector is written? [UNRESOLVED — affects `docs/api-contract.md:15`]
2. **Basic auth username/password.** This spec assumes `onair` / a new `web_server_password` secret. Confirm, or say "no auth, LAN is enough" and accept Risk 7 explicitly.
3. **`/Users/john/code/esp32` is not under version control** and the parallel colour-light work will touch the same file. Both `.gitignore` files are already correct (a real `git add -A` stages 9 files and excludes `secrets.yaml`), so `git init` there is safe — but it is a different tree and not part of this change. Do you want it done first, as its own step? [UNRESOLVED]
4. **Pinning ESPHome in `pyproject.toml`** (Risk 14) — same question, same tree, same answer needed.
5. **The colour lamp.** This state model is renderer-agnostic by design. When the parallel research lands, the lamp becomes a second `LightDriver` behind the same `Level` union with no changes to `state.ts`, `server.ts`, or the contract.

---

## Sources

**External** (all accessed 2026-08-22):
- ESPHome native API component, `reboot_timeout` semantics — https://esphome.io/components/api/
- ESPHome web server component, `version`/`local`/`ota`/`auth`/`allowed_origins` — https://esphome.io/components/web_server/
- ESPHome web API, "a valid POST request will always return 200 OK ... does not indicate the alarm was armed" — https://esphome.io/web-api/alarm-control-panel/
- ESPHome template select — https://esphome.io/components/select/template/
- ESPHome WiFi component, `power_save_mode` and `reboot_timeout` defaults — https://esphome.io/components/wifi/
- ESPHome I2C bus, `frequency` — https://esphome.io/components/i2c/
- ESPHome HTTP request component (Plan B) — https://esphome.io/components/http_request/

**ESPHome 2026.8.0 source** (under `/Users/john/code/esp32/.venv/lib/python3.13/site-packages/esphome/`, all read 2026-08-22):
`components/web_server_base/__init__.py:14-19`, `components/web_server_base/web_server_base.h:133`; `components/web_server_idf/__init__.py:6-9`, `web_server_idf.cpp:150-152,184-189,242-256,694-935`; `components/web_server/__init__.py:49-55,94-122,259-263,392-424`, `web_server.cpp:167,510,610-621,1462-1468,1483-1496,2429-2470`, `web_server/ota/ota_web_server.cpp:33-56`; `components/captive_portal/__init__.py:28-32`; `components/api/__init__.py:292-294`, `api/api_server.cpp:143-158`; `components/wifi/__init__.py:486-497`; `components/i2c/__init__.py` (`SplitDefault(CONF_FREQUENCY, esp32="50kHz")`); `components/select/select.h:25-70`, `select.cpp:15-40`, `select_call.cpp:66-121`, `select/automation.h:9-14`; `components/template/select/__init__.py:63-68`, `template_select.h:32-59`, `template_select.cpp:22-45`; `components/globals/globals_component.h:20`; `components/esp32/preferences.cpp:271-291`; `components/ssd1306_i2c/ssd1306_i2c.cpp:41-61`; `components/http_request/__init__.py:120-124,144-147,343-350`; `core/config.py:309-313`; `core/base_automation.h:134-141`; `core/component.h:37-59,100,165`; `display/display.h:320,369,386,395,513`.

**Repo** (`/Users/john/code/rocket-on-air-sensor` @ `2105e61`, all read 2026-08-22):
`src/state.ts:1-70`, `src/persist.ts:1-22`, `src/driver.ts:1-14`, `src/app.ts:23-64`, `src/server.ts:27-38,52-57,126-133,153-169,232-236,285-355`, `src/display.ts:21-31,39-44,74-87`, `src/ui.ts:62-63,130,179-180,220,231-232,283,531-593`, `src/sse.ts`, `src/ws.ts`, `dist/state.js` (shipped `write()` spread), `package.json:11-25`, `CONTEXT.md:33,41-42,56,74,93,109-196` (D-1..D-15), `docs/api-contract.md:1-60`, `docs/companion-setup.md:41`, `docs/mac-setup.md:113,129,228`, `INSTALL.md:73,114`, `deploy/onair:728-740`, `test/app.test.ts:10-45,87-93`, `test/server.test.ts:13-28,233-277`, `test/persist.test.ts:40-69`, `docs/research/2026-08-20-esp32-diy-light.md`, `docs/superpowers/plans/2026-08-20-esp32-onair-light.md` (both informative, not binding).

**Device** (`/Users/john/code/esp32`, read 2026-08-22): `configs/elegoo-esp32.yaml:1-91`, `Makefile`, `pyproject.toml`.

**Measurements** (2026-08-22): orchestrator's `ping`/`nc`/`curl`/mDNS on `10.42.12.77`; draft author's `esphome compile` (EXIT=0, Flash 51.2%) and `ping -c 20`; reviewers' independent re-reads of every ESPHome path cited above; this author's re-reads of `i2c/__init__.py`, `select/select.cpp`, `select/automation.h`, `template_select.cpp`, `core/base_automation.h:134`, `core/component.h:37-59`, `core/config.py:309-313`, `dist/state.js`, `src/*.ts`, `CONTEXT.md`, `docs/api-contract.md`.
