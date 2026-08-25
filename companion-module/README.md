# companion-module

The Bitfocus Companion module: sideloaded, with presets generated from the state table.
Targets `@companion-module/base` ~2.1.3 (D-37).

**Not written yet, and deliberately so** - D-45 gates it on a tested v2 API, so its ticket
carries a blocking edge on #40 and cannot reach the frontier early. Phase 1's
zero-code generic-websocket wiring (`GET /events/ws`, D-11) keeps working in the meantime.

This directory exists so the workspace layout D-37 decided is real today. It carries no
scripts, so `npm run verify` skips it via `--if-present`.

Filled in by [#44](https://github.com/jwnichols3/rocket-on-air-sensor/issues/44).
