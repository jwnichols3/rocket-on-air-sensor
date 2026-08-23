# ESP32 Integration - Handoff Brief

2026-08-23. Written to hand this work to a fresh context window. Read this first, then the
spec.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> to execute this task-by-task.

## What you are building

The on-air API drives a DIY ESP32 over HTTP, showing three availability states, with a
`confirmed` that is a genuine device read for the first time in this project.

**The authoritative design is `docs/superpowers/specs/2026-08-22-esp32-integration-design.md`**
- 1,223 lines, produced by a ten-agent workflow with an adversarial review pass. Every claim
carries an ESPHome 2026.8.0 source path or a repo `file:line`. It contains the exact YAML,
the exact TypeScript, and a ten-step build sequence with acceptance criteria. **Do not
re-derive any of it. Do not "improve" it without evidence** - four of its details were
adversarially recovered from defects that would otherwise have shipped a false green.

This brief records only what changed *after* that spec was written.

## Ground truth

| Thing | Where |
|---|---|
| On-air API | `/Users/john/code/rocket-on-air-sensor` (this repo). Zero production npm deps - D-11. |
| Firmware | `/Users/john/code/esp32` -> **`jwnichols3/rocket-esp32`, private** (created 2026-08-23) |
| Device | Elegoo `esp32dev`, `framework: esp-idf`, SH1106 128x64 mono OLED, live at **10.42.12.77** |
| ESPHome | **2026.8.0** in `/Users/john/code/esp32/.venv`, driven by that repo's `Makefile` |
| Ports today | 6053 open (native API), **80 dead** (no `web_server:` yet) |
| Decisions | `CONTEXT.md` **D-16 .. D-20**, recorded 2026-08-23 |

## The five open questions, answered

Rocket answered these on 2026-08-23. Four are now decisions; one changes the spec.

1. **Middle rung owner -> BUILD THE MANUAL HOLD NOW.** This *overrides* the spec's v1
   ("detector writes `dnd`/`available` only, `interruptible` is manual-only") and the
   recommendation to defer. **The spec does not contain this design. It is specified in full
   below - implement from this document.** Recorded as D-19.
2. **Device auth -> TAKE IT.** Exactly as the spec's Transport section says:
   `auth: {username: onair, password: !secret web_server_password, type: basic}`.
   `type: basic` must be written out explicitly. Add `web_server_password` to both
   `configs/secrets.yaml` (gitignored) and `configs/secrets.yaml.example` (placeholder only).
   The Node side sends the header pre-emptively on every request. Recorded as D-17.
3. **Version control for `~/code/esp32` -> DONE.** Private repo `jwnichols3/rocket-esp32`,
   9 files, `configs/secrets.yaml` correctly excluded. Nothing to do.
4. **Pin ESPHome -> YES.** Add an explicit `esphome==2026.8.0` to
   `/Users/john/code/esp32/pyproject.toml` alongside the existing
   `esphome-device-builder[esphome]==1.12.4`. `uv.lock` already pins it, but it arrives
   transitively, so `uv lock --upgrade` could drift it silently - and the REST URL scheme
   changed *in 2026.8.0*, so drift breaks every driver URL. Commit the pin in the firmware
   repo. Recorded in D-16.
5. **Colour lamp -> SAME BOARD, second renderer.** Not in scope now; deferred until this
   integration works end to end. Recorded as D-20. It will be firmware-only: the state model
   is renderer-agnostic by construction, so it needs **zero new TypeScript**.

---

## The manual hold - full design (new; not in the spec)

**Mental model: the hold is a floor on `level`.** It composes with the spec's ladder
(`available(0) < interruptible(1) < dnd(2)`) and with its ladder rule, rather than competing
with them.

### Rules

1. **`hold` is a persisted field: `'interruptible' | 'dnd' | null`.**
2. **A write with `source: "detector"` is clamped up to the floor**:
   `effective = max(level, hold ?? 'available')`. Detector writes **never** modify the floor.
3. **Any other source** (manual, `/ui`, a direct API call, or an absent `source`) applies its
   `level` as given, and may set or clear the floor.
4. **The floor never blocks escalation.** A detector writing `dnd` against a floor of
   `interruptible` results in `dnd`. Blocking that would leave the light saying "come in"
   while Rocket is on camera - the invariant violation in a new costume.
5. **The floor persists through an escalation.** When the call ends and the detector writes
   `available`, rule 2 clamps it back to `interruptible`. "I am interruptible today" survives
   a meeting. This is the whole point of the feature.
6. **`hold` may never be set to `available`.** A floor at the bottom rung is either a no-op
   or, read the other way, a lever that forces green against the detector. Reject with `400`.
7. **Release is explicit only. Never a TTL, never a decay.** The hold is *intent*, like
   `intended` - not *evidence*, like `confirmed`. Consistent with D-6.
8. **The hold must be visible** in `GET /status`, on `/ui`, and on the device, so an
   unexplained yellow is explainable at a glance. On the mono OLED a small `HELD` marker in
   the diagnostics band is enough - do not spend pixels the spec's renderer already
   allocated.

### Wire shape

```jsonc
// set level and pin the floor there
PUT /state  {"level": "interruptible", "hold": true, "source": "manual"}

// clear the floor and drop to available
PUT /state  {"level": "available", "hold": false, "source": "manual"}

// omitting `hold` leaves the floor untouched
PUT /state  {"level": "dnd", "source": "detector"}

// rejected: 400, a floor at the bottom rung is not a thing
PUT /state  {"level": "available", "hold": true}

GET /status -> { ..., "level": "interruptible", "hold": "interruptible", ... }
```

`hold: true` means "pin the floor at the `level` in this same request". That keeps the common
case one request and avoids a second endpoint.

### Which writes count as "detector"?

The literal string `source: "detector"`. Everything else - including a missing `source` - is
treated as manual. A client that forgets to set `source` therefore gets manual privileges,
which is the *safe* direction: manual writes are deliberate human acts, and the failure mode
is "the hold released when I did not expect it", not "the light lied about my availability".
Document this in the contract rather than being clever about it.

### Contract change this forces

`docs/api-contract.md` currently says of `source`: *"Free-form; no precedence semantics in v1
(last write wins)."* **That line is now false** and must be rewritten - `source` carries real
precedence for the first time.

### Tests that must exist

1. detector `available` + floor `interruptible` -> stays `interruptible`
2. detector `dnd` + floor `interruptible` -> becomes `dnd` (escalation allowed)
3. detector `available` after that escalation -> back to `interruptible`, **not** `available`
4. manual `available` + `hold:false` -> `available`, floor cleared
5. floor survives a restart (persist round-trip)
6. `{"level":"available","hold":true}` -> `400`
7. floor does **not** decay: advance the clock past `FRESH_S` and assert the floor is intact
8. a write with no `source` can clear the floor

---

## Order of work

The spec's ten steps stand. Fold the hold in as follows, and **do not reorder** - each step's
acceptance gates the next.

| Step | Spec step | Change from the spec |
|---|---|---|
| 1 | Repo change, red then green | **Add the hold** to `state.ts`, `persist.ts`, `server.ts`, and the 8 tests above. Everything else per spec. |
| 2 | Device config, validate | **Add `web_server_password`** to `secrets.yaml` and `secrets.yaml.example`. Auth block is in the spec. |
| 3 | Compile before flashing | unchanged |
| 4 | Flash over the air | unchanged |
| 5 | Prove the latency hypothesis | unchanged |
| 6 | The wire transcript | **Add:** an unauthenticated POST must return `401`. |
| 7 | Physical proof | **Add:** the `HELD` marker renders. |
| 8 | End to end through the API | **Add:** the hold scenario - manual `interruptible` + hold, then a simulated detector `available`, then `dnd`, then `available` again. |
| 9 | Rollback safety | unchanged. Note `hold` is a new field older binaries ignore. |
| 10 | Soak, and the Plan B decision | unchanged |

Also, in the **firmware repo**: add the `esphome==2026.8.0` pin (Q4) and commit it there.

## Verification bar

This repo's standing bar, non-negotiable:

- `npm test` **and** `npx tsc --noEmit` both pass before every commit. `tsx` strips types, so
  tests alone never prove compilation. Baseline today: **80 tests, 80 pass, 0 fail.**
- Acceptance is a **real transcript** posted to the GitHub issue - not a description of one.
- Plus, for anything with a physical effect: **proof the panel actually changed** (photo or
  video). `confirmed` says a variable changed; it does not say pixels moved. The spec's frame
  counter exists for exactly this reason.

## Things that will bite

Ranked, from the spec's risk register. The first three each ship a false green.

1. **`api: reboot_timeout: 0s` is mandatory.** The default is 15 minutes and it fires when no
   *native API* client connects. An HTTP-only driver never satisfies it, so the board reboots
   every 15 minutes forever. Measured at 15 min 12 s. This is the single most likely way to
   ship something that looks perfect for fourteen minutes.
2. **`on_boot: priority: -100` is mandatory.** Without it, `on_value` fires during the NVS
   restore, the boot watchdog never arms, and every reboot has a 90-second window showing a
   restored `available` with nothing behind it.
3. **The supervisor's `lastAssertAt` advances only on a successful `set()`**, never on
   `read()`. Advancing it on reads makes the heartbeat fire exactly once, ever - permanent
   STALE in the healthy case, invisible until the soak.
4. **The write's `200` means nothing.** It is sent before the value is applied, and invalid
   options are silently dropped. Read-back is mandatory; derive option strings from the
   `LEVELS` constant, never from a literal.
5. **The URL segment is the entity *name*.** Renaming `name: "Presence"` breaks every driver
   URL, and an unmatched URL closes the socket with no HTTP response - so it surfaces as
   `ECONNRESET` and looks exactly like a dead device.
6. **`i2c: frequency: 400kHz`.** The esp32 default is 50 kHz, which makes a full SH1106
   repaint ~220 ms of blocking on the device that now also serves HTTP.
7. **Never foreground a serial monitor.** `esphome logs` has no timeout flag and will hang the
   turn. Everything in the loop is `curl` against port 80; the board never needs a cable again
   after the first flash.
8. **Never commit `configs/secrets.yaml`.** The firmware repo is private, but the `.gitignore`
   is what actually protects it. And this repo is **public** with transcript-to-issue
   acceptance - grep every transcript for the SSID and both passwords before posting.

## Open, deliberately

- **The detector does not exist** (issue #5, still a research question). The hold is built
  ahead of it; when the detector lands, verify the hold against a real heartbeat.
- **The colour lamp** (D-20) is deferred. The parts research and the accessibility findings -
  including that red/green is the wrong axis and that no OLED at any price reaches 20 ft - are
  in `docs/research/2026-08-22-wall-indicator.md`.
- **Three conflicts in the wall-indicator research** are unresolved and flagged in that doc's
  §7: level shifter vs a 4.5 V supply, the kit's photoresistor vs a BH1750, and the auto-dim
  range against 8-bit PWM colour shift. None block this work.
