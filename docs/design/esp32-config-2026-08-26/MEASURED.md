# Objective measurements of the four variants

Measured by the main session on 2026-08-26, not self-reported. `A` and `B` shipped a NOTES
block with their own accounting; **`C` and `D` did not ship one at all**, which the design
brief required. So all four are measured here the same way instead, and the judges' "small"
and "buildable" scores should rest on this table rather than on claims.

Method: strip the NOTES comment, then split the file into `<style>` inner text, `<script>`
inner text, and everything else.

| variant | markup (pool A) | css (pool B) | js (pool B) |
|---|---|---|---|
| A glass board | **10,743** | 8,557 | 1,877 |
| B master-detail | **6,087** | 7,178 | 2,911 |
| C overrides-first | **5,539** | 3,199 | 0 |
| D live card | **8,960** | 6,004 | 1,795 |
| *today's page* | *6,840* | *(inline, counted in the 6,840)* | *0* |

**Only pool A is scarce.** It is a contiguous heap allocation on every request, on a board
where a failed allocation is `abort()`. Pool B is a gzipped flash blob served by
`AsyncWebServerResponseProgmem`, cached immutable, costing no heap (D-69). A variant with a
large stylesheet and small markup is the CHEAPER one, which is the opposite of the intuition
the raw file sizes give.

The five-row figure is not the number that matters either. `MAX_ROWS_RENDERED` is 24, and
`config_page()` reserves `3000 + 24 * 900` up front - one contiguous ~24.7 KB allocation.
What decides the ceiling is **fixed chrome plus per-row cost times 24**.

## The three fatal properties, checked on every file

All four pass. Verified by pattern, not by reading the notes:

| check | why it is fatal | A | B | C | D |
|---|---|---|---|---|---|
| any `<input type=color>` carrying a `name` | it would post `#000000` as an override when the operator meant "follow the server", silently breaking the relationship the page exists to manage (D-68) | none | none | none | none |
| any field named `busy` | `handle_action()` REFUSES the whole POST, so the save would fail and the operator would not know why | none | none | none | none |
| `action` values outside `save`/`clear`/`clearall`/`refresh` | an unrecognised action silently does nothing | exact | exact | exact | exact |

A and D both use native colour pickers - 10 each - and both give them **no `name` attribute**,
so the picker is structurally incapable of being serialised and only ever writes into the
adjacent named text input. B and C avoid `<input type=color>` in the served markup entirely.
Three different answers to the same trap, all sound.
