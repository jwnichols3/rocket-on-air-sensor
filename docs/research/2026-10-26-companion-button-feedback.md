# Companion 5.1 button feedback research

Research date: 2026-10-26. Target: Companion 5.1.1 and module API 2.2, with `@companion-module/base` 2.2.1. Findings below distinguish upstream capability from the On Air module's implementation. No live controls or configuration were changed for this research.

## What is available

| Capability | Verified interface | Useful application here |
|---|---|---|
| Layered presets | `type: 'layered'`, ordered `elements`, optional `canvas`, local variables, actions and feedback style overrides | Keep the existing sun/moon while adding an independent pending layer and countdown. [1][2] |
| Native gauges | `type: 'gauge'`, `orientation: 'horizontal' \| 'vertical' \| 'ring'`; value/min/max/origin, reverse, start/end angles, ring width, rounded ends, color stops, track and marker properties | A circular countdown or linear drain requires no generated images or video. [1][3] |
| Other native elements | Group, composite, text, image, box, line and circle; bounds, visibility (`enabled`), opacity and supported rotation | Immediate press frame, short captions, progress bands, and retained current-state icon. [1][3] |
| Dynamic properties | Graphics fields accept literal values or `{isExpression:true,value:...}`; layered feedbacks can override individual element properties; local variables can be driven by value feedbacks | Update progress/text without rebuilding preset definitions every tick. [1][2][4] |
| Press feedback | Canvas border/topbar decoration, pressed state, and internal `buttonPushed` feedback | Immediate physical-press acknowledgement. This naturally ends on release, so it cannot by itself represent the subsequent panel wait. [5][6] |
| Action-running indicator | Native decoration draws a running triangle while `action_running` is true | Useful fallback, but its duration is the action callback's lifecycle, not proof that the glass changed. [5] |
| Action events | Preset steps include `down`, `up`, rotary actions and duration-keyed long-press groups | Send the toggle on down; do not move it to release merely to keep a decoration visible. [7] |
| Linked presets | Reference controls listen for preset updates, reload drawing/entities, preserve explicit template variable overrides, and ignore identical checksums | Update the existing placed toggle in place while preserving the state-cycle ring. Converting a reference to editable layers breaks that link. [8] |

The 5.1.0 release notes specifically introduce or improve linked presets, value-feedback style overrides, gauge fill width/alpha, text styles/autosizing, and the expression oscillator. Companion 5.1.1 fixes pressed-state/reference resolution. These are supported release features, not speculative features from a newer branch. [9]

## Timing and animation choices

- `oscillate(period, waveform?, phase?)` is a native continuously evaluated expression. It supports sine, triangle, sawtooth and square shapes and updates at **10 Hz**. Periods are at least 100 ms. Its cycles are aligned to the Unix epoch, including across buttons. It can drive element properties, feedbacks and variables, but not action options. This makes it a good indeterminate pulse after an estimated wait expires, not an inherently command-relative countdown. [10][11]
- `blink(period, duty?)` gives an alternating 0/1 value with an explicit dependency on the host blinker. It is available, but a slow pulse or steady progress is less distracting than repeated flashing for this workflow. [10][12]
- `unixNow()` returns milliseconds. The inspected expression integration marks `oscillate()` as clock-sensitive; do **not** assume an expression containing only `unixNow()` continuously redraws. A real changing variable or explicit render-clock dependency is needed. [10][12]
- `$(internal:time_unix)` is whole Unix seconds. The internal time provider refreshes on a 500 ms interval to avoid skipping seconds, so a deadline minus `time_unix` supports a native approximately one-second countdown. [13]
- A module-owned monotonic timer with numeric/text value feedbacks is another supported approach. It keeps the lifecycle and confirmation logic beside the real request, permits deterministic testing, and can update a native gauge only while pending. Such a visual timer must not generate additional panel requests or regenerate every preset each tick. This is an implementation recommendation, not an upstream requirement.
- The limited internal preset catalog includes wait, abort, local-variable set, expression check, button-pushed and current-step feedback. It does **not** expose a turnkey “wait for this device to physically confirm” element. That semantic state must come from this module. [6]

## Typography and 72-pixel constraints

Companion's text `fontsize` is **a percentage of the element's inner height**, adjusted by the font's line-box ratio. It is not a pixel size. The renderer subtracts padding, then computes `fontsize * innerHeight / 100 / lineBoxRatio`. `fontsize:100` with `fontsizeAllowShrink:true` is a sound starting point for a deliberately allocated text band. [14]

At 72×72, favor one large state icon or one large numeral, one short action caption, and a clear progress cue. Long instructions belong in notes or variables. Confirm at actual 72px using Companion's renderer or live preview; a large design mockup alone does not establish readability. The existing module already learned this distinction in its 0.8.1 diagnostics correction.

## What the countdown may honestly mean

Project source has a **5-second Night sensor publication interval** and a Receiver supervisor that waits **5 seconds after its previous queued tick finishes**. The module's default polling interval is **1 second**, while its event stream can deliver observations sooner. These independently phased intervals explain several seconds between accepting a command and learning the result; network and queue time can extend the wait. [15]

Therefore an approximately ten-second countdown can represent the **usual confirmation window**, not a guaranteed physical completion time. The design should:

1. Acknowledge the press immediately, before waiting for HTTP.
2. Retain the last confirmed sun/moon while showing the pending request separately.
3. Derive the requested direction from the Receiver's actual toggle response, not from a local press counter.
4. Finish early only on appropriate fresh confirmation of that request's target, with the existing Receiver-instance/ordering protections.
5. Replace an expired estimate with `CHECKING` or another honest waiting state, never a fabricated success or endless reset to ten seconds.
6. Distinguish request errors/unknown outcomes from intentional sleep suppression. A busy row can suppress sleep, and clearing manual sleep can still leave the panel dark under its night schedule. [16]
7. Handle rapid repeated presses explicitly so old replies/timers cannot erase newer feedback; do not silently turn a press counter into the source of truth.

No firmware update is required to add this feedback. Any separate attempt to shorten the underlying confirmation latency should be measured and reviewed as its own change.

## Primary sources

1. [Module base 2.2.1 graphics API, immutable package git revision](https://github.com/bitfocus/companion-module-base/blob/72207feb81dd971af52088ac35ebab5af753a998/packages/base/src/module-api/graphics.ts). Package version and git revision checked against the npm registry.
2. [Layered preset definition API](https://github.com/bitfocus/companion-module-base/blob/72207feb81dd971af52088ac35ebab5af753a998/packages/base/src/module-api/preset/definition-graphics.ts).
3. [Companion 5.1.1 native element schemas](https://github.com/bitfocus/companion/blob/v5.1.1/shared-lib/lib/Graphics/ElementPropertiesSchemas.ts).
4. [Host conversion of layered preset feedbacks](https://github.com/bitfocus/companion/blob/v5.1.1/companion/lib/Instance/Connection/Thread/PresetsLayered.ts).
5. [Native button decoration, pressed frame and action-running icon](https://github.com/bitfocus/companion/blob/v5.1.1/shared-lib/lib/Graphics/ButtonDecorationRenderer.ts).
6. [Module internal preset catalog](https://github.com/bitfocus/companion-module-base/blob/72207feb81dd971af52088ac35ebab5af753a998/packages/base/src/module-api/preset/internal-catalog.ts), and [host conversion](https://github.com/bitfocus/companion/blob/v5.1.1/companion/lib/Instance/Connection/Thread/PresetInternalEntities.ts). These internal IDs require API 2.1 or later, within this project's API 2.2 target.
7. [Preset action and local-variable API](https://github.com/bitfocus/companion-module-base/blob/72207feb81dd971af52088ac35ebab5af753a998/packages/base/src/module-api/preset/definition.ts).
8. [Linked preset reference lifecycle](https://github.com/bitfocus/companion/blob/v5.1.1/companion/lib/Controls/ControlTypes/Button/PresetReference.ts).
9. [Companion 5.1.1 and 5.1.0 release notes](https://github.com/bitfocus/companion/blob/v5.1.1/CHANGELOG.md).
10. [Official expression function documentation](https://github.com/bitfocus/companion/blob/v5.1.1/docs/user-guide/4_expressions/functions.md).
11. [10 Hz render clock](https://github.com/bitfocus/companion/blob/v5.1.1/companion/lib/Controls/RenderClock.ts).
12. [Expression dependency/oscillator implementation](https://github.com/bitfocus/companion/blob/v5.1.1/companion/lib/Variables/Util.ts).
13. [Internal time variables](https://github.com/bitfocus/companion/blob/v5.1.1/companion/lib/Internal/Time.ts).
14. [Native layered text sizing implementation](https://github.com/bitfocus/companion/blob/v5.1.1/shared-lib/lib/Graphics/LayeredRenderer.ts).
15. Project sources: [Night publication](../../firmware/configs/onair-core.yaml), [Receiver supervisor](../../server/src/supervise.ts), and [module polling](../../companion-module/src/index.js).
16. Project contract: [panel sleep/wake/toggle](../api-contract.md#5b-darkening-the-panel---post-panelsleep-post-panelwake-post-paneltoggle), and [D-134 / current supersession guidance](../../GLOSSARY.md).
