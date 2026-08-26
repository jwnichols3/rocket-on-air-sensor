# The data every prototype must render

Pulled live from the server on 2026-08-26 (`GET /config/states`, profile v11, 5 rows) and
from the live panel. Use exactly this. Do not invent prettier rows.

| id | label | color | bgcolor | busy | order | luminance(bg) | calm SHAPE |
|---|---|---|---|---|---|---|---|
| `available` | AVAILABLE | `#ffffff` | `#0b6e2e` | no | 0 | 78 | CALM LIGHT (open ring) |
| `on-air` | ON AIR | `#ffffff` | `#c1121f` | **yes** | 1 | 60 | n/a - busy |
| `interruptible` | INTERRUPTIBLE | `#1a1a1a` | `#e8a317` | no | 2 | 165 | CALM HEAVY (double frame) |
| `recording` | RECORDING | `#ffffff` | `#6a0dad` | **yes** | 3 | 45 | n/a - busy |
| `unknown` | NO DATA | `#ff00ff` | `#1a1a1a` | **yes** | 99 | 26 | n/a - busy |

Luminance is the firmware's own integer formula in `onair_table.h`:
`(54*r + 183*g + 19*b) >> 8`. The threshold is `>= 128`.

## Overlay state to show

The live panel has **0 overrides**. A prototype that only ever shows the clean case hides
the hardest part of the design, so every prototype must render this overlay too, and make
the difference between "following the server" and "overridden here" obvious at a glance:

- `available`: label overridden to `FREE`. Colours follow the server.
- `interruptible`: `bgcolor` overridden to `#3b5bdb` (luminance 78 - this FLIPS the calm
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
