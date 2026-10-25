# Admin console

The working browser console for the On-air API. It is served at `/` and `/admin`.
The state controls stay visible above the settings sections; the simple and advanced
views change which settings are shown.

The console provides:

- State buttons and live primary-panel confirmation, including a distinct asleep state.
- A state-table editor with stable row IDs, editable presentation and meaning, and a
  live contrast check.
- A device list with one primary, optional secondary panels, per-device reachability,
  and links to each panel's settings and night schedule.
- Machine passphrase, admin credentials, port, binding, shortcuts, and factory reset.
- Draft staging: **Save row** stages an edit; **Save all** sends the complete document
  with its version. **Discard all** returns to the last loaded document.

The passphrase is readable for client setup; admin and device passwords are masked.
An environment-overridden credential is read-only, names the winning variable,
and does not display the inactive document value. Overrides stay in effect after
saving or resetting the document.

The shell is public, but its administrative data requires an admin session. Local
same-origin access uses the server's loopback waiver. Drafts live in sessionStorage;
admin session tokens remain in memory. The API is also available to other clients,
so the console's save is subject to the same validation and version checks.

## Build and test

```sh
npm run build -w server
npm run build -w admin-ui
npm test -w admin-ui
```

Run these from the repository root. `build.mjs` inlines `src/index.html`, `app.css`,
and `app.js` into `server/public/admin/index.html`; there is no frontend framework
or runtime bundler. That path is served by an installed Receiver, so build in an
isolated checkout when testing without updating the live console.

`test/browser.mjs` drives the real server and console in Chromium with temporary
config/state files, an ephemeral loopback port, and an inert device driver. Fixture
device addresses cannot cause requests to real panels. The tests cover DOM stability
across polling, settings visibility, connection-loss rendering, device edits, and
state-ID collision rejection. Install Chromium with `npx playwright install chromium`
if it is not present.

The full project gate is `npm run verify`. See [the architecture guide](../docs/architecture.md)
and [API contract](../docs/api-contract.md) for server and device behaviour.
