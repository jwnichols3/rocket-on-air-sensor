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
| 5 | Workflow: 4 variations, prototyped as standalone HTML | running - `wf_801f41ae-771` |
| 6 | Screen-capture each variation | not started |
| 7 | Judge panel, scored | not started |
| 8 | Implement the winner in `onair_page.h` | not started |
| 9 | `npm run verify` green | not started |
| 10 | `npm run firmware:compile` green | not started |
| 11 | OTA flash + capture the real page from the device | not started |
| 12 | Prove the light still works | not started |
| 13 | Decisions into `CONTEXT.md` | not started |
| 14 | Discord DM readout | channel proven, kickoff sent |

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
