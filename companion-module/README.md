# companion-module

The Bitfocus Companion module for the on-air light. Sideloaded, with presets generated from
the server's state table. Built by [#44](https://github.com/jwnichols3/rocket-on-air-sensor/issues/44),
rebuilt against the v2 client contract by
[#72](https://github.com/jwnichols3/rocket-on-air-sensor/issues/72),
[#73](https://github.com/jwnichols3/rocket-on-air-sensor/issues/73),
[#74](https://github.com/jwnichols3/rocket-on-air-sensor/issues/74),
[#75](https://github.com/jwnichols3/rocket-on-air-sensor/issues/75) and
[#76](https://github.com/jwnichols3/rocket-on-air-sensor/issues/76). Given wordless button art,
a measured contrast rule and a sleep/wake toggle by
[#92](https://github.com/jwnichols3/rocket-on-air-sensor/issues/92).

Setup and packaging: `docs/companion-setup.md`. This file is the developer view.

```sh
npm run build   --workspace companion-module   # bundle to dist/
npm run package --workspace companion-module   # build, then pkg/rocket-onair-<v>.tgz
npm run test    --workspace companion-module   # source tests, no Companion needed
npm run icons   --workspace companion-module   # redraw src/icons.js from tools/icons/icons.mjs
```

## Layout

```
src/index.js            the module
src/panel-progress.js   bounded command/confirmation lifecycle, with an injected monotonic clock
src/command-presets.js  native layered command feedback, preserving observed-state artwork
src/build-info.js       build-injected module identity; unbuilt source reports no release identity
src/icons.js            GENERATED button art, base64 PNG (npm run icons)
tools/icons/            the art: a rasteriser, the shapes, and the generator
companion/manifest.json what Companion reads to load it
build.mjs               esbuild -> dist/, the shape Companion installs
package.mjs             dist/ -> pkg/*.tgz, the shape Companion IMPORTS
test/                   tests against a fake server
dist/ pkg/              generated
```

## The shape of the module

One class, and every claim it makes to Companion goes through **one method**, `view()`. That is
the load-bearing decision: variables, feedbacks and the instance status all read the same
three-condition verdict, so there is no path by which a button says one thing and the
connection light says another.

Two transports feed **one** ingest path:

- `GET /status` on a timer is the **correctness** path. It is the cold read at startup and the
  backstop afterwards. The contract (section 3) says every renderer polls, and (section 5)
  that "push is an optimisation, never a delivery guarantee".
- `GET /events` (SSE, parsed by hand so the fetch can carry an `Authorization` header, which
  `EventSource` cannot) is the **speed** path.

`ingest()` is the shared publication path. Connection generations fence late responses after
reconfiguration or teardown. HTTP observations are discarded when another accepted status
arrives while their request is in flight. Table refreshes are coordinated so an older pull
cannot replace a newer one. This is conservative client-side ordering; it does not invent a
server-wide revision or treat a write timestamp as the age of every confirmation update.

## The buttons (#92)

Every state row and every panel button generates **two** presets: a graphic one in `States` /
`Panel`, and a words-only one in `States (words)` / `Panel (words)`. They are the same button -
same action, same feedbacks, same colours - so a deck can mix them freely.

**The art is generated, not pasted.** `tools/icons/icons.mjs` holds the shapes as code;
`npm run icons` rasterises them and writes `src/icons.js`. Each icon ships twice, white-ink and
black-ink, and the module picks between them at runtime by measuring contrast against the
button's actual background. That matters because one state button has **three** backgrounds -
resting, lit, and the amber a `connection_lost` feedback paints over the top - and because the
table's colours belong to the owner, who can change them from the admin console at any time.

**Contrast is measured, never assumed.** `readableInk()` keeps the row's own colour whenever it
clears WCAG AA on the background in question, and substitutes white or black when it does not.
It exists because INTERRUPTIBLE's `#1a1a1a` on amber-quartered-to-`#3a2805` measured **1.23:1**
on the resting button and had been shipping that way: the row's ink was chosen by the owner for
the row's own background, and nothing had ever checked it against the dimmed one.

A row this module has **no icon for falls back to its words**, rather than generating a blank
button. The table is the owner's and they can add rows.

## Sleep/wake acknowledgement (0.9.0)

The linked toggle keeps its observed sun/moon and adds a native drain strip while a command
is pending. It shows `SENDING` before HTTP completes, then `SLEEP SENT` or `WAKE SENT` with
`CHECK ~10s`. The estimate starts after delivery. It represents the usual confirmation
window, based on the panel's five-second Night publication and the Receiver's separate
five-second checks; it is not a promise that the panel will change when the number reaches zero.

A fresh physical transition ends the overlay early. At ten seconds the strip changes to
checking with elapsed overtime. At twenty seconds it stops animating, releases the repeat
guard, and shows `NO CONF`. A later eligible confirmation can clear that notice. Busy sleep
suppression, rejected requests, unknown delivery, and lost contact have distinct captions.
Unknown evidence never becomes a sun by default: a known previous moon is marked `LAST SEEN`;
without any physical observation the button shows an unknown face.

Repeated toggle presses during the active wait show `WAIT` without issuing another request.
Explicit sleep/wake actions can override a pending operation. State cycling stays independent,
including rapid presses and the saved cycle ring; its linked preset gets only a matching press
accent. Copied presets do not acquire new layers automatically.

`panel_command_phase`, `panel_command_target`, `panel_command_seconds`, and
`panel_command_result` expose this lifecycle separately from `last_command_status`, which
continues to describe delivery. Only strictly newer accepted physical transitions in the
same Receiver lifetime can confirm progress. The display-only last-seen cache is never
confirmation evidence. No additional panel requests are generated by the animation.

Capability sources and design tradeoffs: [Companion 5.1 research](../docs/research/2026-10-26-companion-button-feedback.md).

## Three things that cost real time to find

**`apiVersion` is declared, not derived.** `runtime.apiVersion` in the manifest is the
module author's claim about which host API it wants. It has nothing to do with the version of
`@companion-module/base` you depend on. The manifest declares **2.2.0**, matching Companion 5.1.1's supported API list, and the
implementation uses SDK 2.2.1. The module exports an ESM constructor and upgrade scripts,
object-map variables, and separate preset sections/definitions. This is an implementation
migration, not just a changed version string.

**macOS `tar` breaks the sideload.** It writes AppleDouble `._*` entries, the first being
`._.` - one path component. Companion extracts with `strip: 1` and no ignore filter, so that
strips to an empty name and the install fails with `EISDIR` on the module directory.
`COPYFILE_DISABLE=1` suppresses them.

**The tarball needs directory entries and a real top-level name.** Companion finds the
manifest by treating the first DIRECTORY entry as the prefix to trim. With no directory
entries it never matches `companion/manifest.json` and reports "Doesn't look like a valid
module" - which reads like a manifest problem and is not one.

`package.mjs` sets both and then **asserts them against the finished tarball**, because the
failure mode of getting them wrong is an error message that points somewhere else.

## Why it reads the gated endpoints

`docs/api-contract.md` names this module while saying so: "A renderer that holds a table must
not use these. The ESP32, Companion and any other client take the state key from the gated
endpoints and the look from `GET /config/states`." `/public/status` and `/public/events` are
a *rendering* view for two unauthenticated browser pages - free to change shape, and carrying
no `confirmed` and no `source`.

#44's own text steered the other way, toward `/public/events`, for the zero-configuration
story. The contract wins: it is source of truth, and a module that generates presets from the
table is a table-holder by definition. The cost is a mandatory passphrase, which on the real
deployment is not a cost at all - Companion runs on another host, where D-24's loopback waiver
does not apply.

## Why a press is simply a write

`?source=companion` is unprefixed, so the server reads it as `human:companion`. That is
**provenance and nothing else** now: D-126 retired the pin, so `auto:` and `human:` differ in
no authority, every write with a valid body is applied, and the last write wins. A press
cannot be refused by an earlier write and cannot stop the detector's next one - which is the
whole workflow: override by hand mid-meeting, and the detector puts the light back when the
meeting ends.

The prefix is still not faked. `auto:companion` would misreport who pressed the key, in the
one place the system has no other way to know (D-30).

D-120 gave this module a Hold option on `Set state`, `Pin the current state` and `Release the
hold` actions, `held` / `held_to_this_state` feedbacks, `hold` / `hold_label` variables, PIN
and UNPIN presets, and a warning that an ordinary press was about to clear somebody else's
pin. All of it went with the rule that produced it, at 0.3.0. **A button already placed on a
deck that used any of them is orphaned and has to be re-bound by hand** - regenerating presets
does not touch placed buttons.

## Tests

`test/fake-server.mjs` implements just enough of the server: `GET /status`,
`GET /config/states`, `GET /events` as SSE, `POST /state/{id}`, and Bearer auth that is
actually enforced.

It exists so that things which are only observable on a broken system can be tested on a
working one. On the real server, proving any of these means editing Rocket's live state table,
unplugging the panel, or killing the daemon mid-meeting:

| Knob | What it makes testable |
|---|---|
| `editTable()` | presets regenerate when `tableVersion` moves |
| `setEventsAvailable(false)` | the poll alone carries the module |
| going silent (the default) | the stream watchdog, without waiting 45 s |
| `setConfirmed()` | a light that disagrees, and a light that will not answer |
| `setWriteDelay()` | #68's slow-but-successful write |

`test/module.test.mjs` imports the exported source class and records its host callbacks.
`test/api2.test.mjs` additionally loads source and the actual ESM bundle through the real
`@companion-module/host` wrapper, validating the API 2 definitions and upgrade script.
`test/ordering.test.mjs` checks Receiver sequence/instance handling and command diagnostics.

The timing-sensitive tests set the thresholds they depend on rather than waiting out the
defaults - every threshold in this module is configuration, which is what makes that honest
rather than a dodge.


## Build identity and module releases

The module has its own version, independent of the Receiver/SwiftBar product version.
Use `npm run version:set --workspace companion-module -- patch` (or an explicit stable
version) to synchronize `package.json`, `companion/manifest.json`, and the workspace lock
entry. The root `npm run version:check` checks all three.

`build.mjs` embeds `MODULE_BUILD_INFO` into the running bundle and writes
`dist/build-info.json` with the same version, commit, dirty flag, build time, and a SHA-256
of `main.js`. `package.mjs` checks version agreement and that hash before archiving.
`module_version` and `module_commit` are live instance variables: a modified checkout is
marked, and unbuilt source/unknown provenance is not presented as a release commit.

After importing a new package, explicitly select that module version on the connection.
Verify the new live identity variables before exercising controls. A copy of a preset already
placed on a page does not acquire new feedbacks merely because a module was updated. In
particular, old **Light health** copies now show their existing navy NO ACK presentation
when Receiver contact is lost or there is no data: the unchanged `light_not_confirming` ID
now includes those conditions. Re-create a copy from the 0.7.3 preset to gain the more precise
NOT REFRESHING, NO DATA, and ASLEEP presentations. Healthy sleep is not a fault. Preserve
customized controls deliberately.
See [module release and deployment instructions](../docs/releases.md#companion-module-releases).


## API 2 presets and diagnostics

Companion 5.1.1 can place these presets as linked references. Existing copied buttons do not
become linked automatically. Preserve their full configuration before replacing them.
The existing preset IDs `state_cycle` and `panel_toggle` remain stable. A linked cycle uses
the local variable `cycle_states`; set that array to the old button's selected ring during
migration so later table additions do not silently change which states it cycles.

The `diagnostics` preset uses layered graphics and local value-feedback variables to display
READY, ASLEEP, RECEIVER OFFLINE, or a primary-panel warning, together with the last command
outcome and module version. It creates no additional polling loop. `last_command` retains
the full result while the preset uses a concise summary. Command acceptance/delivery is kept
separate from physical confirmation.

The module orders snapshots by `(receiverInstanceId, statusSequence)` when present. Equal
sequence heartbeats refresh contact and write age without replacing semantic state.
`receiver_instance_id` and `status_sequence` expose the accepted epoch and highest sequence,
and are empty for legacy Receivers. Old
Receiver identities are retired when a new boot is accepted. Legacy Receivers remain usable;
a rollback from the ordered protocol to a legacy one requires a fresh SSE stream or an
explicit connection reset, so an arbitrary missing field cannot erase ordering protection.
