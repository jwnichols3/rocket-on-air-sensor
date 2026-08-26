# The data every prototype must render

Pulled live from the server on 2026-08-26 (`GET /config/states`, profile v11, 5 rows) and
from the live panel. Use exactly this. Do not invent prettier rows.

| id | label | color | bgcolor | busy | order | luminance(bg) | calm SHAPE |
|---|---|---|---|---|---|---|---|
| `available` | AVAILABLE | `#ffffff` | `#0b6e2e` | no | 0 | 73 | CALM LIGHT (open ring) |
| `on-air` | ON AIR | `#ffffff` | `#c1121f` | **yes** | 1 | 71 | n/a - busy |
| `interruptible` | INTERRUPTIBLE | `#1a1a1a` | `#e8a317` | no | 2 | 167 | CALM HEAVY (double frame) |
| `recording` | RECORDING | `#ffffff` | `#6a0dad` | **yes** | 3 | 59 | n/a - busy |
| `unknown` | NO DATA | `#ff00ff` | `#1a1a1a` | **yes** | 99 | 26 | **n/a - always draws NO DATA, see below** |

Luminance is the firmware's own integer formula in `onair_table.h:291`. It is Rec.601,
integral, and truncating:

```c
(uint8_t) ((299u * r + 587u * g + 114u * b) / 1000u)
```

The threshold is `>= 128`. Reproduce it EXACTLY. A preview that rounds differently from the
firmware is a preview that can disagree with the glass, which is the one thing this page must
never do.

## Overlay state to show

The live panel has **0 overrides**. A prototype that only ever shows the clean case hides
the hardest part of the design, so every prototype must render this overlay too, and make
the difference between "following the server" and "overridden here" obvious at a glance:

- `available`: label overridden to `FREE`. Colours follow the server.
- `interruptible`: `bgcolor` overridden to `#3b5bdb` (luminance 96, down from 167 - this FLIPS the calm
  SHAPE from heavy to light, and the page must say so).
- everything else: no override.

## Page chrome the prototype must include

- The profile line: `Profile v11, 5 rows.`
- A "Refresh profile from server" control.
- A footer explaining the passphrase is not settable here (D-55), linking to
  `/onair` ("Back to status") and `/` ("ESPHome dashboard").
- The three banner states: APPLIED (green), FAILED (red), **PENDING** (amber, with a
  Reload link). Show the PENDING one in the prototype - it is the one that gets forgotten.
- The `NO CONFIG` empty state, as a second screen or a toggle, is a bonus not a
  requirement.

## The five SHAPES, exactly as the glass draws them

From the display lambda in `firmware/configs/elegoo-esp32.yaml`. The panel is a **128x64
1-bit SH1106**. `y >= 49` is a reserved diagnostics band, never overdrawn: a horizontal rule
at `y=49`, then `IP: <addr>` bottom-left and `<n>dBm` bottom-right. Any miniature that claims
to be the glass must include that band, because the real panel always does.

| branch | SHAPE | drawn as |
|---|---|---|
| 0 | `BUSY` | `filled_rectangle(0,0,128,48)` - solid block, label **knocked out** (unlit) and centred at y=24. If stale, the word `STALE` also knocked out at y=44. |
| 1 | `CALM HEAVY` | `rectangle(0,0,128,48)` and `rectangle(2,2,124,44)` - a **double frame**, inset. Label lit, centred at y=24. |
| 2 | `CALM LIGHT` | `filled_circle(64,24,22)` then `filled_circle(64,24,15)` unlit - an **open ring** 44px across with a 30px hole. Label lit, centred inside it. |
| 3 | `NO DATA` | vertical hatch, `x` every 4px from y=0 to y=14, then `NO DATA` centred at y=26. |
| 4 | `UNKNOWN KEY` | `filled_rectangle(0,0,128,16)` with `UNKNOWN KEY` knocked out, the offending key **left-aligned** at (2,20), then a hatch band y=40..47. |
| 6 | `NO CONFIG` | hatch band y=0..14, `NO CONFIG` at y=26, then the server host (or `no server set`) at y=42. |

Branch 5 is skipped deliberately - the `Shape` enum values ARE these branch numbers.

### `unknown` never draws as BUSY. CORRECTED 2026-08-26.

This table first said `unknown` was "n/a - busy". That was wrong, and it was wrong in a way
that matters: `compute_view()` at `onair_table.h:600` short-circuits on the KEY, **before**
the busy test.

```cpp
if (key == "unknown" || (v.stale && !v.eff.row.busy)) { v.shape = Shape::NO_DATA; return v; }
if (v.eff.row.busy)                                   { v.shape = Shape::BUSY;    return v; }
```

The row carries `busy: true` as a row property and that is real - it is what stops a stale
`unknown` being a false OFF - but the SHAPE drawn is always `NO_DATA`, the hatch band. A
preview that draws `unknown` as a solid BUSY block is showing a picture the glass will never
produce.

### Font sizes. CORRECTED 2026-08-26.

Three fonts, `elegoo-esp32.yaml:477-486`: `status_title` 14px, `status_text` 11px,
`status_huge` 30px bold.

`label_font()` picks 30px at `strlen(label) <= 8` and 14px above - but it is applied on the
**BUSY** and **CALM HEAVY** branches only. The **CALM LIGHT** branch hardcodes
`id(status_text)`, 11px, unconditionally (`elegoo-esp32.yaml:661`) and never calls
`label_font()` at all.

This table previously stated the rule as applying to every branch. It does not.

**The consequence is not cosmetic.** An 11px `INTERRUPTIBLE` is about 75px wide against a
ring whose hole is 30px across, so on the real glass **the label genuinely collides with the
ring**. A miniature that renders CALM LIGHT at a large size, or that tidily fits the label
inside the hole, is hiding a collision the operator will see on the panel.

**Colour never reaches a busy branch.** Shape there is keyed on `busy` alone, because a dark
red and a dark green have near-identical luminance and a false OFF is the one error that
matters. Only the two CALM branches consult luminance.
