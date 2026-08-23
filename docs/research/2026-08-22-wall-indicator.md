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
| Is a bigger OLED the fix? | **No.** The market ceiling is a 5.5" 256x64 at $69.98, and it reaches ~11.9 ft for a glance. See §9 - this row's first pass said 3.12"/11.8 ft and was 2x too low. |
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
| 3.12" OLED 256x64 | $38.17-$42.60 | 43 x 11 arcmin | **NO**, and dim (60-80 cd/m²) |
| **5.5" OLED 256x64** (the true market ceiling - see §9) | $69.98 | 76 x 19 arcmin | **NO** for a glance (11.9 ft), marginal at threshold (23.9 ft) |
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

---

## 9. OLED purchase options (added 2026-08-22, second pass)

Rocket read the verdict above and asked anyway: *"I would like to purchase a new OLED - one
that is wide and mountable. I can find a way to power it with USB-C."* Fair - so this section
answers that question directly. Two researchers: the market, and driver support against his
actual config.

### A correction to §1 and §2 above

**The OLED ceiling recorded above was too low by 2x.** The first pass capped the field at
3.12" / ~11.8 ft because it did not find the 5.5" part. It exists:

**[FACT] Newhaven NHD-5.5-25664UCG3** - 5.5", 256x64, SSD1322 controller, **$69.98**, low
stock at Newhaven. Active area **135.65 x 33.89 mm**. Outer PCB 147 x 64 mm, **four M3 corner
holes and a metal bezel**. Five Newhaven mechanical drawings were read directly (the PDF pages
were rendered, because the dimensions are vector annotations that `pdftotext` cannot reach).

**The "largest is dimmest" claim in §2 applies only to the 3.12".** The 5.5" runs
**100/150 cd/m² at 10,000:1** - as bright as the SH1106 Rocket already owns.

**[COMPUTED]** 5.5" viewing distance: **11.9 ft** for a comfortable glance at a short word,
**23.9 ft** at MIL-STD threshold ("resolvable if you stop and look at it").

### The market ceiling, established three ways

**[FACT] The 5.5" 256x64 SSD1322 is the biggest OLED a hobbyist can buy**, corroborated
independently: Winstar's range tops out at 5.5" (`WEX025664D` / `WEN025664D`), Newhaven's
tops out there too, and Crystalfontz's entire 256x64 line stops at 3.12". PMOLED physics caps
it - anything larger is AMOLED with a MIPI-DSI interface, which is not an ESP32 part.

**So no OLED reaches 20 ft on the glance criterion. The whole market tops out around 12 ft.**

### Buy table

| Module | Size | Active area | Controller | ESPHome | Price (qty 1) | Stock | Glance / threshold | Mountable |
|---|---|---|---|---|---|---|---|---|
| **Newhaven NHD-5.5-25664UCG3** | 5.5" 256x64 | 135.65 x 33.89 mm | SSD1322 | **supported** | **$69.98** | low | **11.9 / 23.9 ft** | **4x M3 + metal bezel** |
| Newhaven NHD-3.12-25664UCY2 | 3.12" 256x64 | 76.78 x 19.18 mm | SSD1322 | **supported** | $38.17 | yes | 6.8 / 13.5 ft | yes (module) |
| Crystalfontz CFAL25664B-Y-B1 | 3.12" 256x64 | 76.78 x 19.18 mm | SSD1322 | **supported** | **$42.60** | yes | 6.8 / 13.5 ft | **NO - bare glass** |
| **Waveshare 2.42"** | 2.42" 128x64 | 55.01 x 27.49 mm | SSD1309 | **no model** | **$12.99** | unconfirmed | 5.2 / 10.3 ft | yes, 4 corner holes |
| Adafruit 2719 | 2.42" 128x64 | 55.01 x 27.49 mm | SSD1309 | **no model** | $39.95 | in stock | 5.2 / 10.3 ft | yes, 4 |
| DFRobot FIT0328 | 2.7" 128x64 | unconfirmed | unconfirmed | unknown | $42.00 | only 3 left | - | not stated |

**[FACT] Two traps verified against ESPHome source at tag 2026.8.0:** there is **no
`ssd1309`, `ssd1325`, `ssd1362` or `ssd1363` component**. That kills the tempting
**Crystalfontz $16 256x64** (it is SSD1362, and also wants a 0.3 mm ZIF flex and a 12 V rail),
and it puts a real risk flag on the Adafruit 2.42", which **moved to SSD1309 in 2023**.
Do not buy the 2.42" without confirming its current controller.

**[FACT] Character OLEDs are disqualified outright.** Newhaven's 20x4 has **4.75 mm** glyphs
fixed in silicon - **3.6 ft**, worse than what is already on the bench, despite the module
being 98 mm wide.

### It works on his exact setup - verified by compiling, not by inference

**[FACT] `display: platform: ssd1322_spi`, model `"SSD1322 256x64"`** - that is the only model
string the platform accepts. SPI only; there is no `ssd1322_i2c` or parallel platform, so
avoid parallel-only modules. 256x64 is also **the largest and widest OLED in all of ESPHome
2026.8.0**; the runners-up are 128x128.

**[FACT] Every OLED component works under esp-idf.** All 14 ssd13xx source files were grepped
for `only_with_framework` / `only_on` / `USE_ESP_IDF` / `USE_ARDUINO`: **zero framework guards
exist.** SPI maps `spi_esp_idf.cpp` onto `ESP32_IDF`, with the source comment "ESP32 uses
ESP-IDF SPI driver for both Arduino and IDF frameworks."

**[FACT] Two displays coexist** - the researcher installed ESPHome 2026.8.0 locally and
compiled Rocket's real config plus the delta: `INFO Successfully compiled program.`, exit 0.
RAM 25.3% -> 26.0% (**+1,140 B static**; the 8 KB greyscale buffer is runtime heap, not
static), flash +44.6 KB (mostly the size-44 font), 133,820 B static DRAM free. **RAM is not a
constraint.**

### Three things that will bite

1. **[FACT] Power is the real cost, not GPIO or RAM.** The SSD1322 has **no VCC charge pump**,
   unlike the SH1106 - a full-text search of the datasheet finds no "charge pump" / "boost" /
   "DC-DC". Newhaven's 3.12" module draws **310 mA typ / 340 mA max** at 3.3 V, roughly **7x
   the SH1106**. That plus a transmitting ESP32 is 580 mA through the DevKit's AMS1117 =
   0.99 W, junction ~114 C, out of spec above ~36 C ambient.
   **Fix: set the module's jumper Option #1 and feed its boost input from the 5V pin, not
   3V3.** The 3V3 load then drops to 200 uA and the total is ~410 mA, inside USB's guaranteed
   500 mA. Without USB-PD negotiation, 500 mA is the only number you are guaranteed.
2. **[FACT] A silent rendering footgun.** `color_to_grayscale4` reads `color.white`, and the
   three-argument `Color(r,g,b)` constructor sets `w = 0`. So `Color(255,255,255)` - **and the
   CVD-safe green `Color(0,255,120)` recommended in §4 above** - render **BLACK** on
   SSD1322/25/27, while working fine on the SH1106. Use `COLOR_ON`, or `Color(0,0,0,N)` to
   dim.
3. **[FACT] A YAML trap.** Appending a second `display:` or `font:` block fails with
   `Duplicate key`. They must be merged as list items under the existing key, and the SH1106
   needs an `id:` added ("Required if there are multiple displays").

**Pin map** (avoids GPIO5 - which is both the default VSPI CS **and** a strapping pin, per
ESPHome's own `_ESP32_STRAPPING_PINS = {0, 2, 5, 12, 15}`, independently confirming the
correction in §3): **CLK 18, MOSI 23, CS 14, DC 27, RESET 26.** This deliberately spends ADC2
pins, which are useless while Wi-Fi is up, and preserves GPIO32/33 on ADC1 for a future light
sensor plus GPIO4 for the LED strip. The only strapping warning in the build is his
pre-existing GPIO2 LED.

### The honest comparison

**[FACT] Adafruit 2278, HUB75 P4 matrix** - **$39.95, in stock**, 255 x 127 mm, M3-mountable,
full colour. **[COMPUTED] 24.0 ft** for a four-letter word at a comfortable glance. That is
**$30 cheaper than the 5.5" OLED and double the range**, and it satisfies "wide and
mountable" too. It costs 13-14 GPIOs and its own power supply (see §3).

**Supported is not the same as readable.** The 5.5" OLED is a genuine upgrade, a properly
mountable object, and the right part if the goal is a rich text readout at conversational
distance. It is still not the 20 ft stairs answer.

### Sourcing caveats

Waveshare, Winstar and BuyDisplay all return **HTTP 403** to automated fetch - everything from
those vendors is flagged UNCONFIRMED in the source file rather than reconstructed from search
snippets. The full reports carry 11 UNCONFIRMED flags between them.

### Corrections from a second sourcing pass (same day)

Parallel researchers covering the US maker vendors and Waveshare/AliExpress returned
corrections to the buy table above. All accessed 2026-08-22.

1. **[FACT] A price error, corrected.** Crystalfontz CFAL25664B-Y-B1 at **"$30.60" is the
   1000-unit price**. Single unit is **$42.60**. The ladder is 1/$42.60, 10/$39.19,
   20/$38.04, 50/$36.66, 100/$34.67, 1000/$30.60. It is therefore *more* expensive than the
   Newhaven 3.12", not cheaper.
2. **[FACT] That Crystalfontz part is not mountable.** It is **bare glass with no carrier
   PCB and no mounting holes** - the earlier "check drawing" should read **NO**. Its
   controller is confirmed as Solomon Systech SSD1322 outright (not "or compatible"), active
   area 76.78 x 19.18 mm, logic 3.0 V typ, **panel rail 14.5 V**, 23-32 mA.
3. **[FACT] The bare-glass power trap, which applies to the whole 256x64 class.** Every
   bare-glass 256x64 panel needs a **12-14.5 V panel rail**. Cheap modules hide this behind
   an onboard boost converter; raw panels do not. That is real BOM and board cost on any
   bare-glass path. Newhaven's *modules* carry the boost (hence the jumper Option #1 noted
   above) - **[UNRESOLVED]** confirm the 5.5" part's own arrangement from its datasheet
   before ordering, since the 310 mA figure quoted above was measured on the 3.12".
4. **[FACT] A much cheaper 2.42" exists.** **Waveshare 2.42", $12.99** - active
   55.01 x 27.49 mm, SSD1309, 4-wire SPI default with I2C via solder jumpers, 3.3 V/5 V with
   an onboard level translator, carrier PCB with **4 corner mounting holes**. That is the
   **identical glass** as the Adafruit 2719 at $39.95. **[UNRESOLVED]** stock: the page has
   an Add-to-Cart button and no out-of-stock banner, but it is the only Waveshare OLED page
   lacking a schema.org offer block, and it is absent from their own OLED category listing
   (28 items, no 2.42") - findable only by site search. Treat as a supply risk.
5. **[FACT] But both 2.42" options carry a driver risk, now verified.** ESPHome's `ssd1306`
   platform `MODELS` enum at tag 2026.8.0 contains exactly: SSD1306 (128x32, 128x64, 96x16,
   64x48, 64x32, 72x40), SH1106 (128x32, 128x64, 96x16, 64x48), SH1107 (128x64, 128x128),
   SSD1305 (128x32, 128x64). **There is no SSD1309 entry.** Adafruit's 2719 moved to SSD1309
   on 2023-09-14 and Waveshare's is SSD1309 too. The community workaround is to declare an
   SSD1306 or SSD1305 model and rely on command compatibility - **[UNRESOLVED] and untested
   on this hardware.** The SSD1322 parts have an explicit model string and do not carry this
   risk.
6. **[FACT] A buying trap worth more than any single price.** **Diagonal labels on 256x64
   panels are unreliable** - the identical panel ships as "2.7in", "2.8in", "3.12in",
   "3.2in" and "3.55in" across listings. **Anchor on active area in mm, never on the
   diagonal.**
7. **[FACT] The 5.5" ceiling is now confirmed from the cheap end too.** AliExpress carries 10
   distinct SSD1322 5.5" listings from $43.38 to $145.34, and a search for "4 inch OLED
   display module" returns **zero** OLEDs above 1" - the top hits are iPad glass and a 4.0"
   ILI9488 TFT **LCD**. Newhaven's 135.65 x 33.89 mm also matches the active area derived
   geometrically for 256x64 at 5.5", so two independent methods agree.
8. **[FACT] Vendor ceilings.** Adafruit's largest OLED is the 2.42" - no SSD1322, SSD1362 or
   256x64 part anywhere in their catalogue. SparkFun's largest currently sold is 1.3";
   everything bigger (1.5" Zio, 1.51" transparent, HUD) is **retired or discontinued**.
   Pololu's only OLED is a 1.3" and it is **on backorder**. Seeed tops out at 1.12",
   Pimoroni at 1.3" own-brand.
9. **[FACT] Transparent OLEDs.** SparkFun's two transparent parts are both **retired**.
   Waveshare's 1.51" transparent is $19.99 and in stock, but it is bare glass on a ~40 mm
   flex to a **physically separate driver board**, has **no mounting holes**, and its
   transparency percentage is **not published by the vendor** - do not quote a figure.
10. **[FACT] Amazon yielded nothing.** Both `curl` with full browser headers and WebFetch
    return HTTP 503 with an explicit anti-automation notice. No ASINs, prices or stock from
    that channel; nothing was reconstructed from search snippets. buydisplay.com (Cloudflare
    403) and winstar.com.tw (403) are likewise unreadable by automation.
11. **[FACT] Identifying a genuine OLED from a listing:** the controller is the tell.
    SSD13xx / SH110x / SSD1322 / SSD1362 = OLED. ILI9xxx / ST77xx / GC9A01 = LCD. Titles
    reading "OLED LCD Display" on SSD1322 parts are sloppy copy, not mislabels - SSD1322 is
    OLED-only silicon. And the 4.2" 400x300 part is confirmed **e-paper** (84.8 x 63.6 mm
    display, 5 s full refresh, sub-uA standby), which is reflective and unlit and therefore
    useless here regardless.

**Net effect on the recommendation: unchanged, and slightly strengthened.** The Newhaven 5.5"
is a *module* rather than bare glass, it is genuinely mountable, and its SSD1322 has an
explicit ESPHome model string. The two cheaper 2.42" options are attractive on price - the
Waveshare especially at $12.99 - but both carry an unverified driver question that the
SSD1322 parts do not.
