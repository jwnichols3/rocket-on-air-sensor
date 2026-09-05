# The night schedule can be edited but cannot be found (#95)

Tracking doc for #95. Resume from the checklist at the bottom if the session is disrupted.

## Problem

Rocket, 2026-09-04: *"there is a setting somewhere that says to turn the screen dark at a time
and turn it back on at another time (11p / 7a i think is the default). I don't see where to make
the changes to the start/stop time in either the on-air admin panel or the esp32 interface."*

## What exists

Verified against the live CrowPanel (`10.42.14.239`, build `2026-08-31 13:49:54 -0700`):

- `NightMode ON`, `NightSleepMin 1380` (23:00), `NightWakeMin 420` (07:00). Defaults, in force.
- The editor is the Night bar (#81, D-138) at `/onair/config?night=1` on the panel itself:
  On/Off radios, two `<input type=time>` fields, Apply. Validates HH:MM, refuses equal times,
  persists via `make_call()` (proven across a reboot in #81).
- The schedule is deliberately device-local and not on the server API (D-111, D-133,
  `docs/api-contract.md` "The SETTING is not on the wire; the CONSEQUENCE is"). The admin
  console therefore has nothing of the schedule to show.

## Why it could not be found

1. Panel page default view: `Screen: on. Darkens at 23:00.` - the sentence naming the schedule -
   has no affordance. The only path to the controls is the muted footer
   `Status · Night · Beta · ESPHome dashboard, ...`. "Night" beside "Beta" does not read as
   "edit the schedule".
2. Admin console device card: links `Open the panel` and `Panel settings` only.

## Approaches considered

| | Approach | Cost | Verdict |
|---|---|---|---|
| A | Link to the existing bar from the verdict line and from the console card; rename the footer link and bar heading to `Night schedule` | ~60 B on the default page, 0 on the dark page (bar already rendered); one console link | **Chosen** |
| B | Render the bar on every page | +545 B fixed; fence and reserve must move again | Rejected - D-138 declined this for the same reason |
| C | Put the schedule on the wire, edit it in the console | New endpoint, driver methods, contract text, per-device form under D-147 | Rejected - reverses D-133 for a set-once setting |

## Design (A)

**Firmware, `firmware/configs/onair_page.h`**
- `render_night_line()` takes `bool link_to_bar`. When true it appends
  ` <a href="/onair/config?night=1">Change the schedule</a>` inside the verdict `<p>`.
- `render_settings()` computes `bar = show_night || held().night_dark` once, passes `!bar` to
  the line and renders the bar when `bar`. The link is never shown beside the bar.
- Bar heading `<strong>Night</strong>` -> `<strong>Night schedule</strong>`.
- Footer link text `Night` -> `Night schedule`.
- Byte budget: worst page (dark, every row overridden) was 4325 of the 4400 fence and grows
  by 9 B (heading). Default page grows by ~70 B. Nothing crosses the fence; fence and reserve
  stay at 4400 / 3000.

**Tests, `firmware/test/test_page.cpp`** (in `test_night_bar`)
- Default page has `Change the schedule` and the `?night=1` href.
- `?night=1` page and the dark page do NOT have `Change the schedule` (the bar is right there).
- Existing `<strong>Night</strong>` assertions become `<strong>Night schedule</strong>`.

**Console, `admin-ui/src/app.js`**
- Third `panelLink`: `Night schedule` -> `/onair/config?night=1`, same host resolution as the
  other two (primary follows the overlay).

**Tests, `admin-ui/test/browser.mjs`**
- A device card carries a `Night schedule` link whose href is `http://<host>/onair/config?night=1`.

**Decision**: D-149 in `CONTEXT.md`.

## Verification plan

1. `bash firmware/test/run.sh` - budget line and 0 failed.
2. `npm run verify` at root.
3. Server: `npm run build && deploy/onair restart` -> `health: PASS`; `curl -u rocket:<pass> localhost:8484/admin/` contains `Night schedule`.
4. Firmware: record `text_sensor/Build`; `firmware/.venv/bin/esphome compile configs/crowpanel-7.yaml`;
   `strings` the OTA image for `Change the schedule`; `esphome upload --device 10.42.14.239`;
   wait > 60 s; `Build` moved and `/onair/config` carries the link; re-check after 2+ min.
5. Post transcripts to #95, close it.

## Found on the way: the Build marker is frozen for header-only changes (#96)

The first `esphome compile` of this change reported
`Build Info: config_hash=0x765af209 build_time_str=2026-08-31 13:49:54 -0700` - identical to
the running panel - while the OTA image did contain `Change the schedule`. ESPHome 2026.8.0
regenerates the timestamp only when the config hash or its own version changes; our
`includes:` headers are outside the tree it tracks. Fix: remove
`configs/.esphome/build/<name>/build_info.json` before compiling (the Makefile `compile` target
now does). CLAUDE.md corrected; D-150 records it.

## Checklist

- [x] Research; ticket #95 opened
- [x] Firmware page + tests
- [x] Console link + test
- [x] D-149 recorded
- [x] #96 opened; Makefile, CLAUDE.md, D-150
- [ ] `npm run verify` green
- [ ] Commit + push
- [ ] Server rebuilt and restarted, `/admin/` verified
- [ ] CrowPanel compiled, image checked, flashed, verified past 60 s
- [ ] #95 closed with transcripts; this checklist finished
