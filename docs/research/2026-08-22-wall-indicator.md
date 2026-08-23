# Wall-Mounted Status Indicator - Research

2026-08-22. Path B of two parallel efforts. Path A (connecting the ESP32 to the on-air API)
is tracked separately.

**The ask, in Rocket's words:** mount an indicator on a wall so people coming up the stairs
can see it "from twenty feet away". He asked specifically about **OLED displays**, because
he already has an SH1106 128x64 monochrome OLED wired to his ESP32 and working. Colour
scheme: **green = available** (or blank/off to save power), **yellow = interruptible**,
**red = do not interrupt unless urgent**. He hoped to power it from the kit's **9 V
battery**, with the power source swappable. He owns Elegoo 3D printers.

Method: four parallel research agents - display physics and 20 ft legibility, ESPHome
component support under the esp-idf framework, the power budget, and the human/physical
design. Labels: **[FACT]** = verified against a primary source. **[COMPUTED]** = arithmetic
from a [FACT], shown. **[JUDGEMENT]** = a call. **[UNRESOLVED]** = not settled.

> **Note on status:** the reconciliation judge for this research was interrupted before it
> ran. Three genuine disagreements between the reports are therefore still open, and are
> listed under "Unresolved" rather than being silently decided here.

---

## Verdict summary

| Question | Answer |
|---|---|
| Can the OLED he owns do this job? | **No, and not close.** ~5.7 ft for a readable word; ~10.4 ft absolute ceiling with one giant glyph. Short by 3.6x to 6.6x. |
| Is a bigger OLED the fix? | **No.** The largest genuine mono OLED found (3.12", $38.17) reaches ~11.8 ft, and is the dimmest of the field. |
| What actually works? | **Colour, not text.** A WS2812B stick behind a diffuser, **$11.90**. |
| Why? | The spec is three colours, not a message. A colour patch needs ~53-80 mm of apparent size at 20 ft; a *character* needs 53-67 mm **each**. ~20x less area for the same job. |
| Does it work under `framework: esp-idf`? | **Yes** - `esp32_rmt_led_strip`. `neopixelbus` and `fastled_clockless` are Arduino-only and are the only two casualties. |
| Can the 9 V battery run it? | **No. About two hours.** |
| Is red/yellow/green a good scheme? | **Not as the only channel.** ~16% chance of affecting a household of 4; ~36% for 10 guests. |
| Is "blank = available" acceptable? | **No.** It is a false OFF by construction. |

**The OLED is not wasted.** Keep it exactly where it is as the bench/debug readout - IP
address, Wi-Fi dBm, current state, last-contact time. That is what
`docs/research/2026-08-20-esp32-diy-light.md` already called it ("status/debug readout, not
a light"). This research is the number behind that judgement.

---

## 1. The question he asked: how far can the OLED be read?

Legibility is an **angular** problem. A character of height `h` at distance `d` subtends
`θ = h/d` radians, so `d = h/θ`. Everything below is that one equation.

| Display | On screen | Threshold legibility | Comfortable glance |
|---|---|---|---|
| 0.96" 128x64 | default 6x8 font | **0.8 ft** (ten inches) | 0.5 ft |
| 0.96" 128x64 | 4-letter word, as large as it fits | **4.2 ft** | 2.2 ft |
| 0.96" 128x64 | ONE character filling the panel | **7.7 ft** | 4.1 ft |
| 1.3" SH1106 128x64 | 4-letter word, as large as it fits | **5.7 ft** | 3.0 ft |
| 1.3" SH1106 128x64 | ONE character filling the panel | **10.4 ft** | 5.5 ft |

**[FACT]** The 1.3" SH1106 active area is **29.42 x 14.7 mm**, 0.23 mm pixel pitch
(Waveshare SH1106 datasheet §1.2, corroborated by Adafruit #938 and Pololu #3761).
The 0.96" figure (21.81 x 10.90 mm) is **[COMPUTED]** geometrically because both
manufacturer datasheets blocked automated fetch; the same method reproduces the 1.3"
datasheet to within 0.4%.

**[FACT]** 20 ft demands a **28 mm** character at MIL-STD-1472F's absolute threshold
(§5.2.1.6.4.1) and **53-76 mm** for a reliable glance-read. ADA Table 703.5.5 gives 67 mm at
20 ft. The trade rule of thumb ("one inch of letter height per ten feet") gives 51 mm.

**The entire active area of the 1.3" panel is 14.7 mm tall.**

**Brightness was never the problem.** **[FACT]** The OLED runs 100-150 cd/m², roughly 4-6x
the luminance of a stairwell wall (~25 cd/m² at 100 lux ambient). Its viewing angle is the
best of every technology surveyed - the SH1106 datasheet specifies it as "Free". It fails
purely on **angular size**, and no firmware trick closes a 3.6x gap.

**Method cross-check:** applied to SparkFun's 6.5" seven-segment display, this formula
returns 108 ft against SparkFun's own "seen from a hundred feet away" claim.

---

## 2. The reframe: colour needs 20x less area than text

**[FACT]** MIL-STD-1472F §5.2.1.5.6.6 requires an isolated **colour** symbol to subtend
30 arcmin minimum, 45 preferred. **[COMPUTED]** at 20 ft (6096 mm), 1 arcmin = 2.909e-4 rad:

- 30 arcmin -> 6096 x 30 x 2.909e-4 = **53 mm**
- 45 arcmin -> 6096 x 45 x 2.909e-4 = **80 mm**

That is the size of the **whole glowing object**. For text, 53-67 mm is the height of **one
character** - so a four-letter word needs a panel roughly 230 mm wide. Rocket's own spec is
three colours, not a message, so the colour path is the right one and it is an order of
magnitude cheaper.

| Technology | Cost | Apparent size @ 20 ft | 20-ft verdict |
|---|---|---|---|
| 0.96" OLED (owned) | $0 | 12 x 6 arcmin | **NO** - ~5x too small |
| 1.3" SH1106 (owned) | $0 | 17 x 8 arcmin | **NO** - 3.6x too small |
| 2.42" OLED 128x64 | $39.95 | ~30 x 15 arcmin | **NO** |
| 3.12" OLED 256x64 (largest found) | $38.17 | 43 x 11 arcmin | **NO**, and dimmest of the field (60-80 cd/m²) |
| **NeoPixel Stick 8 + diffuser** | **$11.90** | up to **147 x 74 arcmin** (diffuser-sized) | **YES - recommended** |
| NeoPixel Ring 24 (bare, 65.5 mm) | $16.95 | 37 arcmin | YES, just over the 30 arcmin minimum |
| HUB75 P3 64x32 (191x96 mm) | $44.95 | 108 x 54 arcmin | colour YES, text marginal (27 arcmin/char) |
| HUB75 P5 64x32 (318x158 mm) | $49.95 | 179 x 89 arcmin | **YES for both** - the only sub-$100 route to 20-ft *text* |
| Colour smart bulb in a fixture | $14.63+ | 34 arcmin bare, 85-113 in a shade | **YES** - the zero-fabrication answer |
| Edge-lit acrylic sign | ~$20 DIY | sign-sized | marginal - washes out at 100 lux |

**[FACT]** WS2812B per-LED output is R 390-420 / G 660-720 / B 180-200 mcd. Eight of them
behind a 100 x 50 mm diffuser gives roughly 200-880 cd/m² - 8 to 35x the stairwell wall.

**[JUDGEMENT] The diffuser is the highest-leverage $5.95 in the build.** It does three jobs
at once: it creates the apparent size that satisfies the 30-arcmin rule, it makes the
emission Lambertian so the colour holds off-axis, and it mixes eight point sources into one
readable patch.

**A caution flagged for later:** "4.2 inch OLED" listings are suspect - 4.2"/400x300 is the
standard **e-paper** size, and e-paper emits no light at all.

---

## 3. ESPHome support, given `framework: esp-idf`

This is the constraint that decides what is buildable without a rewrite. The existing config
at `/Users/john/code/esp32/configs/elegoo-esp32.yaml` uses `framework: type: esp-idf`.

Checked at git tag **2026.8.0**, not `dev`:

| Technology | Component | esp-idf? | GPIO cost |
|---|---|---|---|
| WS2812B / SK6812 | `light: esp32_rmt_led_strip` | **YES, native** | 1 |
| WS2812B via NeoPixelBus | `light: neopixelbus` | **NO** - Arduino only | - |
| WS2812B via FastLED | `light: fastled_clockless` | **NO** - Arduino only | - |
| APA102 / DotStar | `light: spi_led_strip` | YES | 2 + shared SPI |
| HUB75 matrix | `display: hub75` - **now in core** | YES | 13-14 |
| MAX7219 7-seg / 8x8 | `display: max7219` / `max7219digit` | YES | 3 |
| Colour TFT (ILI9341/ST7789) | `ili9xxx` / `st7789v` / `mipi_spi` | YES | 4-6 |
| PWM RGB LED | `output: ledc` + `light: rgb` | **YES, native** | 3 |
| Relay | `switch: gpio` | YES | 1 |

**[FACT]** Both rejected components carry the same guard, quoted verbatim from
`neopixelbus/light.py` and `fastled_clockless/light.py`:

```python
cv.only_with_framework(
    frameworks=Framework.ARDUINO,
    suggestions={Framework.ESP_IDF: ("esp32_rmt_led_strip", ...)},
)
```

ESPHome itself names the replacement in its own error message. The docs agree: "FastLED does
not work with ESP-IDF"; "NeoPixelBus does not work with ESP-IDF". NeoPixelBus ESP32 support
is additionally **deprecated as of 2026.6, removal by 2027.1**.

**[FACT]** `esp32_rmt_led_strip` has no framework guard at all - only a chip-variant check -
includes `<driver/rmt_tx.h>` under `#ifdef USE_ESP32`, and calls
`include_builtin_idf_component("esp_driver_rmt")`. It is ESP-IDF-native.

**The esp-idf constraint kills exactly two components, and both have a first-class
replacement. Nothing on the shortlist requires a framework rewrite.**

### The YAML shape

```yaml
light:
  - platform: esp32_rmt_led_strip
    id: onair
    name: "On Air"
    pin: GPIO18
    num_leds: 8
    chipset: WS2812
    # 2026.8.0 accepts channel_colors; rgb_order still parses but is
    # deprecated with removal slated for 2027.3.0
```

**[FACT] The OLED and the LED strip do not conflict.** I2C and RMT are separate peripherals,
and ESPHome ships `i2c_bus_esp_idf.cpp`. Free, safe output pins after GPIO21/22 (I2C) and
GPIO2: **4, 13, 14, 18, 19, 23, 25, 26, 27, 32, 33**.

**Correction to the prior research doc:** **GPIO5 is also a strapping pin** per the ESP32
datasheet Table 3-1, which lists GPIO0, 2, 5, 12 and 15. `docs/research/2026-08-20-esp32-diy-light.md`
omitted GPIO5 from that list.

### Power draw of the LEDs

**[FACT] The widely-cited "60 mA per LED" figure is NOT in the WS2812B datasheet** - all six
pages were read and there is no IDD row. It is an Adafruit rule of thumb, and Adafruit
themselves discount it to 20 mA/pixel in practice. Planning figures for 8 LEDs:

- ~480 mA at full white (the 60 mA/LED worst case)
- ~160 mA at solid red, 100% brightness
- **~38 mA at 60% brightness** - ESPHome's default gamma of 2.8 makes dimmed draw much
  lower than people expect

A separate 5 V supply becomes necessary past roughly 12-15 LEDs.

---

## 4. The colour scheme

### Red/green is the wrong axis, and yellow makes it worse

**[FACT]** 8% of men and 0.5% of women have colour-vision deficiency (Colour Blind
Awareness / NEI). The peer-reviewed US figure is 5.6% of Caucasian boys (MEPEDS,
*Ophthalmology* 2014). **[COMPUTED]** binomially: ~**16%** chance of affecting a household
of four; ~**36%** for ten guests. **[FACT]** 40% of affected people do not know they are
affected - so nobody will report the problem.

**The yellow reasoning inverts.** **[FACT]** Deuteranopes confuse "bright greens with
yellows" *and* "mid-reds with mid-greens" - yellow sits between the two colours they already
cannot separate. Worse, protanopes confuse "black with many shades of red", so the
do-not-interrupt state becomes the *dimmest* one for them. Yellow is more distinct **for
Rocket**; it is specifically wrong for the 8%.

### The fix traffic signals already use

**[FACT]** Dialight's ITE-compliant traffic module datasheet gives **625 nm red / 590 nm
amber / 500 nm green**. That green is a **blue-green**, not a spectral green - which puts it
on the **blue-yellow opponent axis**, the axis that stays intact in red-green CVD.

**Concrete change, and the single highest-leverage one in this research:** drive "available"
as roughly **`(0, 255, 120)`** rather than `(0, 255, 0)`. It costs nothing.

**[JUDGEMENT]** The question "is yellow more distinct than amber?" is the wrong question -
they are 5-15 nm apart and it barely matters. **The load-bearing choice is the green.**

### Never colour alone

**[FACT]** WCAG 2.2 SC 1.4.1: "Color is not used as the only visual means of conveying
information." The physical-signage equivalent is the MUTCD traffic-signal stack, where the
**lit position** carries the meaning independently of hue.

Redundant cues, ranked by value at 20 ft:

1. **Position** - a vertical stack with one window lit. Works at any distance, for anyone.
2. **Lit area / brightness** - a bigger or brighter patch for the busy state.
3. **Slow motion** on the busy state only - motion wins peripheral attention.
4. **A backlit word** - needs >= 2.6 in characters at 20 ft (ADA Table 703.5.5).
5. **Colour** - last, not first.

**[FACT]** A PLOS One study confirms stair climbers navigate on **peripheral** vision while
foveating the treads, and a *Journal of Vision* paper adds that red-green discrimination
declines fastest in the periphery, while **stimulus size** preserves it. **Area beats
lumens** for this application.

### "Blank = available": reject it

Eight states render identically under that scheme - dead board, crashed firmware, unplugged
USB, tripped breaker, Wi-Fi down, receiver down, detector stopped, and actually-free. Seven
of the eight are wrong in the direction `CONTEXT.md:67` explicitly forbids.

It also strands the API's `unknown` state: the one thing the architecture went to trouble to
model would have no visual expression.

**[COMPUTED]** The energy saved is **$0.26/year** (EIA 18.44 c/kWh, May 2026), on a board
that already costs $0.65/yr to stay online. There is no tradeoff to weigh.

**Use a dim green instead, and reserve dark to mean "this system is dead, go knock."**

---

## 5. Power: the 9 V battery is a two-hour device

**[COMPUTED] ~1.7 to 2.7 hours.** Not a workday.

The arithmetic: **~140 mA** drawn from the cell (ESP32 in RX 100 mA + OLED 25 mA + two
AMS1117 quiescent currents + LED) against a battery that **[FACT]** Energizer only
characterises **up to 50 mA** - where it already delivers 445 mAh, down 26% from its 600 mAh
at 10 mA. The nearest measured data at 100 mA is 310-450 mAh (PowerStream, third-party).
Take 75-85% off for the ~6 V regulator dropout floor, divide by 140 mA.

**[FACT] The regulator penalty is real but is not the cause.** 9 V -> 5 V through the MB102's
AMS1117-5.0 is 55.6% efficient (0.52 W as heat); 5 V -> 3.3 V on the DevKit is 66%. End to
end **33%** - two thirds of the battery becomes heat before reaching the ESP32. But the
counterfactual settles it: **a 90% buck converter only buys ~3-3.5 hours.** The chemistry
kills it, not the regulator. Do not let "get a buck converter" be the takeaway.

**A correction to the prior research:** `docs/research/2026-08-20-esp32-diy-light.md` says
"we pay 30-80 mA permanently". That is optimistic by about half. `power_save_mode: NONE` -
which that same document mandates - puts the radio in **continuous RX**, which is datasheet
Table 5-4's **95-100 mA**, not Table 4-2's modem-sleep figure.

**The invariant angle, which is worse than simply going flat:** a dying 9 V is a **false-OFF
generator before it is a dead battery**. As it approaches dropout the ESP32 brownout-resets,
and `restore_mode: RESTORE_DEFAULT_OFF` brings the light up dark until the re-assert poll.
Repeatedly. Blinking looks like working.

### Ranked alternatives

| # | Option | Cost | Notes |
|---|---|---|---|
| 1 | **USB-C wall adapter + 10 ft cable** | **$18.54** | Adafruit 5802 $5.95 + Monoprice 38918 $12.59. 12x headroom, 77 mV cable drop. |
| 2 | PoE splitter -> USB-C | $14.99 | UCTRONICS, 802.3af, isolated. Better than #1 if Ethernet reaches the wall. |
| 3 | PowerBoost 1000C + 2500 mAh LiPo | $34.90 | ~13 h ride-through, true load-sharing. The real "survives a power cut" answer. |
| 4 | Voltaic V50 "Always On" bank | $74 | ~65 h. **[FACT]** Voltaic market these explicitly against low-current auto-shutoff. |
| 5 | Olimex ESP32-POE | EUR 17.95 | Different board. |
| 6 | Mains PSU inside the enclosure | - | No. |
| 7 | The 9 V battery | - | No. |

**[FACT] TP4056 + 18650 is a non-option** for always-on use: it has no power-path
management, and its C/10 charge termination is never reached while a load is attached.

**[FACT] The power-bank auto-shutoff question from the prior research is now closed** in
the sense that Voltaic markets "Always On" packs specifically to solve it. The exact mA
threshold remains unpublished by any vendor - which is itself the argument for buying a bank
marketed as Always-On rather than bench-testing an arbitrary one.

### The "swappable" requirement, answered

**Add no connector at all.** Cut a slot in the enclosure for the DevKit's own **USB-C port**.
Every option above terminates in a USB plug, so swapping the power source is unplugging a
cable. It doubles as the flash port. And it makes dual-supply back-feed **structurally
impossible** rather than a matter of discipline.

**Never** put 9 V on VIN-to-3V3 (3.6 V absolute max), and never connect two supplies without
OR-ing or load-sharing.

### Brownout

**[FACT]** The ESP32 brownout detector is `default y` at level 2.43 V ±0.05 (verified in
ESP-IDF's `Kconfig.power`). The trigger is the 100 -> 240 mA step when the radio transmits.
Espressif require a **>= 500 mA** supply and **>= 10 uF** at the power entrance against
"power rail collapse". **[COMPUTED]** practical fix: 220-470 uF on the 5 V rail - a 240 mA
/ 2 ms burst drops 470 uF by 1.0 V but drops 47 uF by 10 V.

---

## 6. Mounting and sightlines

**[COMPUTED] Stair geometry is counterintuitive.** Worked from IRC stair limits and FAA
eye-height anthropometrics: the sight angle from the bottom of a flight is approximately the
**pitch of the staircase itself, 30-38 degrees**, regardless of how high you mount the sign.

1. **Mount LOW at the top of the flight** - 40-48 in above the upper floor, not 60-72 in.
   This contradicts the reflex to put signage above a door. Every inch higher costs gaze
   angle. **[FACT]** It also lands at the bottom of the range ADA signage practice considers
   correct for standing viewers, so the two constraints agree.
2. **Tilt the face down 20-30 degrees.** A flat-to-wall face at 34 degrees off-axis loses
   ~17% of its on-axis output and, more importantly, presents a **foreshortened lit area** -
   and area is what preserves peripheral colour discrimination.
3. **Build the tilt into a separate wedge-shaped wall plate**, not into the enclosure. It is
   a 30-minute print and a $0.30 reprint if the angle is wrong.

**Diffusion.** **[FACT]** ACRYLITE publish real transmission figures: clear 92%, WT031 white
54% at 3 mm falling to 35% at 6 mm; near-opaque white reflects 91%, which settles the
interior-colour question (white inside is the industry baseline). **[UNRESOLVED]** the
LED-to-diffuser gap has no verifiable published rule - hot spots are a geometry problem and
this one must be prototyped.

**[FACT]** 14 3D-printable models were verified with licences. The two best "on air" signs
are plain CC-BY, so the NC-licensed ones can be avoided entirely.

### Prior art worth heeding

- ThoughtAsylum runs their build at **40% brightness** with a startup self-test sweep.
- Brian Lough's wife required a **call-me-back button** before the thing was socially
  acceptable in the house.
- Salzman's light backfired socially because **"Do Not Disturb" reads as a rule** where
  **"Busy" reads as information**. Worth remembering when labelling the red state.

---

## 7. Unresolved - three genuine conflicts between the reports

The reconciliation judge did not run. These need a call before building:

1. **Level shifter, or run the LEDs at 4.5 V?** One report says a 74AHCT125 ($1.50) is
   mandatory: **[FACT]** WS2812B `V_IH = 0.7 x VDD` = 3.5 V at a 5 V supply, and the ESP32
   outputs 3.3 V - 200 mV short. The other notes the datasheet's own absolute VDD range is
   **3.5-5.3 V**, so dropping the LED supply to ~4.5 V is a datasheet-legal way to lower
   `V_IH` instead. **[FACT] SK6812 is not a fix** - `V_IH` 3.4 V typ at 5 V - despite
   Adafruit reporting it works in practice. **[UNRESOLVED]** WS2812B-ECO: no primary
   datasheet found; do not assume it matches.
2. **Ambient light sensing.** The kit contains two photoresistors, usable on ADC1
   (GPIO32-39; **[FACT]** ADC2 returns `ESP_ERR_TIMEOUT` while Wi-Fi is active, and ESPHome
   does **not** warn you about this). But **[FACT]** ESPHome has no LDR-to-lux path - the
   `resistance` platform stops at ohms. The alternative is a **BH1750 at $4.50**, a natively
   supported ESPHome lux component that rides the I2C bus the OLED already uses.
3. **Auto-dim range.** **[FACT]** MIL-STD-1472F §5.2.1.5.6.3 caps colour-coded luminance at
   **10 cd/m²** for dark adaptation, while daytime wants 130-380. That is a 13-38x range,
   roughly 2-100% duty - and **at the night end, WS2812B's 8-bit PWM will visibly shift the
   yellow**. Whether that matters, or forces a different LED, is unsettled.

**Also unresolved:** the widely-repeated "busylights are too bright at night" claim could not
be verified from any primary source; ThoughtAsylum's 40% is the only hard operating point
found anywhere.

---

## 8. Indicative parts list

Not a decision - the three conflicts above touch it. Roughly $32-37 for a complete build.

| Part | Price | Status |
|---|---|---|
| NeoPixel Stick 8 (Adafruit 1426) | $5.95 | core |
| Black LED diffusion acrylic (Adafruit 4749) | $5.95 | core |
| USB-C wall adapter (Adafruit 5802) | $5.95 | core |
| 10 ft USB-C cable (Monoprice 38918) | $12.59 | core |
| 74AHCT125 level shifter (Adafruit 1787) | $1.50 | see conflict 1 |
| BH1750 lux sensor | $4.50 | see conflict 2 |
| 220-470 uF capacitor, 5 V rail | ~$1 | recommended (brownout) |
| Enclosure + wedge plate | ~$1 filament | self-printed |

**Cheapest experiment that de-risks everything, using only parts already owned:** wire one
of the kit's plain LEDs or the RGB LED, put it behind a sheet of paper as a stand-in
diffuser, and look at it from the bottom of the stairs at night and at noon. That tests
apparent size, the sight angle and the ambient-light range before any money is spent.

---

## Sources

**Displays and legibility** - Waveshare SH1106 datasheet §1.2 - Adafruit #938, Pololu #3761 -
MIL-STD-1472F §5.2.1.5.6.3, §5.2.1.5.6.6, §5.2.1.6.4.1 - ADA Standards Table 703.5.5 -
Newhaven 3.12" 256x64 OLED - SparkFun 6.5" seven-segment - Adafruit 1426 / 4749 / 1787.
*Blocked:* both 0.96" OLED manufacturer datasheets (active area computed instead); ISO
9241-303's character-height clause is not in the free preview; EN 12464-1 stairwell lux is
paywalled.

**ESPHome** (docs + source at tag 2026.8.0) - esphome.io/components/light/esp32_rmt_led_strip/
- `esphome/components/{neopixelbus,fastled_clockless}/light.py` (the `cv.only_with_framework`
guards) - `esp32_rmt_led_strip/{light.py,led_strip.h}` - `esphome/components/hub75/` -
`ledc_output.cpp` - `adc_sensor_esp32.cpp` - `i2c_bus_esp_idf.cpp` - ESP32 datasheet Table 3-1
(strapping pins) - ESP-IDF ADC2/Wi-Fi restriction.

**Power** - Energizer 522 9 V datasheet - PowerStream 9 V discharge data (third party) -
Espressif ESP32 datasheet Tables 4-2 and 5-4 - AMS1117 datasheet - ESP-IDF `Kconfig.power`
(brownout) - Adafruit 5802, PowerBoost 1000C - Monoprice 38918 - UCTRONICS PoE splitter -
Voltaic Systems "Always On" - Olimex ESP32-POE - EIA electricity price, May 2026.
*Unverified:* the MB102 module has no manufacturer datasheet at all; no vendor publishes 9 V
capacity above 50 mA.

**Human factors** - Colour Blind Awareness - NIH/NEI - MEPEDS, *Ophthalmology* 2014 -
WCAG 2.2 SC 1.4.1 - Dialight 432-series ITE traffic module datasheet - City of Toronto LED
module material spec - MUTCD - PLOS One (stair climbing and peripheral vision) - *Journal of
Vision* (peripheral colour discrimination) - ACRYLITE transmission data - ADA signage
mounting heights - IRC stair limits. *Blocked:* ITE chromaticity standard (paywalled);
Printables/MakerWorld HTML (used their APIs instead); Reddit unfetchable, so no Reddit
content appears anywhere in this research.

**This repo** - `CONTEXT.md` (glossary, invariants, `:67`) -
`docs/research/2026-08-20-esp32-diy-light.md` - `/Users/john/code/esp32/configs/elegoo-esp32.yaml`
