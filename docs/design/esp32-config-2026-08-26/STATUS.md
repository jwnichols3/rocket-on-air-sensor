# Panel config page redesign - running status

**Ticket:** [#50](https://github.com/jwnichols3/rocket-on-air-sensor/issues/50)
**Started:** 2026-08-26
**Target file:** `firmware/configs/onair_page.h` (`config_page()`, `render_row_form()`, `page_head()`)
**Live device:** `10.42.12.77`, page at `http://10.42.12.77/onair/config` (basic auth)

This file exists so a disrupted session can resume without re-deriving anything. Update it
at every step boundary, not at the end.

## Steps

| # | Step | State |
|---|---|---|
| 1 | Ticket #50 opened | done |
| 2 | Capture the "before" page from the live device | done - `shots/before.html` |
| 3 | Research the design envelope (bytes, JS, CSS, gzip, chunking) | done - `docs/research/2026-08-26-esp32-web-ui-envelope.md`, D-69 |
| 4 | Hunt for Rocket's earlier description of what he wanted | done - **it does not exist**. House style taken from the admin console instead |
| 5 | Workflow: 4 variations, prototyped as standalone HTML | done - `variants/`, all four pass the fatal checks |
| 6 | Screen-capture each variation | done - `shots/`, and sent to Rocket on Discord |
| 7 | Judge panel, scored | done - `JUDGING.md`, D-71. B wins by 0.67/210, conditional on A's emitter |
| 8 | Implement the winner in `onair_page.h` | done |
| 8a | **D-70 appearance**: 3 skins + dark/light, one stylesheet, NVS-persisted | done |
| 9 | `npm run verify` green | done - 311/311, twice |
| 10 | `npm run firmware:compile` green | done - flash 60.5% |
| 11 | OTA flash + capture the real page from the device | done - `shots/live-*.png` |
| 12 | Prove the light still works | done - `confirmed:"on-air"`, Render=BUSY |
| 13 | Decisions into `CONTEXT.md` | done - D-68..D-72 |
| 14 | Discord DM readout | kickoff + four variations sent; winner and final readout pending |

## Artifacts

```
docs/design/esp32-config-2026-08-26/
  STATUS.md          <- this file
  shots/before.html  <- the page as it was, pulled from the live device
  shots/*.png        <- variation screen captures
  variants/*.html    <- the four standalone prototypes
  JUDGING.md         <- the scored pick
docs/research/2026-08-26-esp32-web-ui-envelope.md   <- the design envelope
```

## Invariants the redesign must not break

Copied from #50 so this file stands alone:

- Presentation-only overlay: `label`, `color`, `bgcolor`. `busy` and row membership are the
  server's (D-32, THE BUSY RULE).
- Handlers run on the esp-idf httpd task. Read under `held().lock`, stage writes for the
  main loop, never touch an ESPHome component API.
- `submit()` has THREE outcomes: APPLIED / FAILED / PENDING (D-64).
- CSRF Origin check on POST (D-66).
- `MAX_ROWS_RENDERED` cap stays, and keeps announcing itself. Failed alloc is `abort()`.
- Auth stays `add_handler()` + the browser's credential prompt (D-57). No form, no cookie.
- No external assets. Everything inline.
- The 1-bit consequence stays visible: `luminance(bgcolor) >= 128` picks the calm SHAPE.

## Corrections made to this bench

- **2026-08-26.** `SAMPLE-DATA.md` and `BRIEF.md` first stated the firmware's luminance
  formula as `(54*r + 183*g + 19*b) >> 8`. That was invented. The real one is
  `onair_table.h:291`, Rec.601 and truncating: `(299u*r + 587u*g + 114u*b) / 1000u`. Caught
  before the design agents ran. It mattered: every variation is asked to preview which SHAPE
  the 1-bit glass will draw, and a preview computed from the wrong formula is exactly the
  kind of confident lie this page must never tell. The corrected figures also now agree with
  the display lambda's own comment (AVAILABLE 73, INTERRUPTIBLE 167).

## Decisions taken (mirror of the `CONTEXT.md` entries)

_none yet_

## Carry into the implementation step

Two things the envelope research left unmeasured that the reflash can settle for free, and
one that `firmware:compile` settles by itself:

1. **Free heap and largest free block are unknown.** The only hard fact is `>= 24.7 KB
   contiguous`, because the config page's `reserve()` succeeds on hardware today. Add the
   `debug:` component (`free`, `block`, `fragmentation`) in the SAME flash as the redesign
   and read it back over HTTP afterwards. It costs nothing extra once a reflash is happening
   anyway, and it turns the pool A budget from an estimate into a measurement.
2. **Flash headroom for the pool B assets is unknown.** `npm run firmware:compile` prints
   `Flash: [=== ] NN.N% (used X from Y)`. Read it rather than assuming; assets also grow
   every OTA transfer.
3. **`<details name=...>` accordion grouping** was not verified for Baseline status. Plain
   `<details>` is safe. If the winning design leans on the accordion behaviour specifically,
   check it before shipping.

## Resume instructions

Read this file, then `gh issue view 50`, then the envelope doc. The step table says where
to pick up. Never flash without `npm run firmware:compile` passing first, and never
foreground `esphome logs` or `make -C firmware flash`.

## Known gap: the page-generating C++ has no test

Checked on 2026-08-26. `npm run verify` runs `esphome config`, which validates YAML and does
not compile or exercise `onair_page.h` at all. `npm run firmware:compile` compiles it and
asserts nothing about its output. Nothing anywhere tests the generated HTML.

That is tolerable for a page nobody was changing. This redesign rewrites most of the
HTML-generating C++, so it stops being tolerable. The invariants worth an actual assertion:

- no `<form>` on the page carries a field named `busy`
- every form's `action` value is one of `save`/`clear`/`clearall`/`refresh`
- the page never emits an unescaped `<`, `"` or `&` from a row's label or id
- a row with no override emits an EMPTY `value=""` for label/color/bgcolor, not a populated
  one - this is the "follow the server" contract and it is the thing most likely to rot
- the luminance readout on a row equals `(299r + 587g + 114b) / 1000` for that row's bgcolor
- the row cap announces itself rather than truncating silently

`compute_view()`, `luminance()`, `html_escape()` and `parse_hex_color_strict()` are pure and
could be host-compiled and tested directly; the handlers cannot, since they need the ESPHome
request types. Decide the shape of this at implementation time. A device-dependent test must
NOT go into `test:deploy` - that glob runs on every `verify` and the panel is not always
reachable, and this repo does not skip quietly.


## Shipped. Measured on the device, 2026-08-26.

| | before | after |
|---|---|---|
| `GET /onair/config`, 5 rows | 6,840 B | **3,151 B** |
| ...with an editor open | n/a | 4,846 B |
| `GET /onair` | 2,655 B | **904 B** |
| inline CSS paid per request | 1,890 B | **0** |
| flash assets, gzipped | none | 8,173 B, immutable-cached |
| largest free heap block | unknown, floor 24.7 KB | **110,592 B** |
| flash used | - | 60.5% of 1.79 MB |

The two carried-forward measurements are both resolved. `<details name=...>` was never
needed, so its Baseline question is moot.

## What is still worth doing

- **The test gap is still open.** Nothing tests the generated HTML, and this session found
  three defects on the device that the compile and 311 passing tests could not see. The
  invariants are listed above; `luminance()`, `html_escape()` and `parse_hex_color_strict()`
  are pure and host-testable today.
- The JS is not exercised by anything. The guarded colour mirror - the thing standing
  between an operator and a silently pinned override - has no test at all.
