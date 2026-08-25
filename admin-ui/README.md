# admin-ui

The admin SPA: the state table editor and the settings console. Builds to
`server/public/admin/` (D-37); the shape it is being built to is D-39.

**Not written yet.** This directory exists so the workspace layout D-37 decided is real
today rather than asserted - the root `package.json` names three workspaces and all three
resolve. It carries no scripts, so `npm run verify` skips it via `--if-present` and does
not pretend to have checked anything here.

Filled in by [#42](https://github.com/jwnichols3/rocket-on-air-sensor/issues/42).
