# companion-module

The Bitfocus Companion module for the on-air light. Sideloaded, with presets generated from
the server's state table. Built by [#44](https://github.com/jwnichols3/rocket-on-air-sensor/issues/44),
rebuilt against the v2 client contract by
[#72](https://github.com/jwnichols3/rocket-on-air-sensor/issues/72),
[#73](https://github.com/jwnichols3/rocket-on-air-sensor/issues/73),
[#74](https://github.com/jwnichols3/rocket-on-air-sensor/issues/74),
[#75](https://github.com/jwnichols3/rocket-on-air-sensor/issues/75) and
[#76](https://github.com/jwnichols3/rocket-on-air-sensor/issues/76).

Setup and packaging: `docs/companion-setup.md`. This file is the developer view.

```sh
npm run build   --workspace companion-module   # bundle to dist/
npm run package --workspace companion-module   # build, then pkg/rocket-onair-<v>.tgz
npm run test    --workspace companion-module   # 38 tests, no Companion needed
```

## Layout

```
src/index.js            the module
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

`ingest()` is the only writer of `current` and `lastContactAt`, so the two transports cannot
disagree about which of them is authoritative.

## Three things that cost real time to find

**`apiVersion` is declared, not derived.** `runtime.apiVersion` in the manifest is the
module author's claim about which host API it wants. It has nothing to do with the version of
`@companion-module/base` you depend on - that package ships no such field. Companion 5.0.3
implements `1.14.0`, `2.1.0` and a `2.1.2` nightly; the manifest declares **1.14.0**. A
manifest declaring `2.1.3` asks for an API newer than the host has and will not load.

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

`test/module.test.mjs` loads `src/index.js` with its `runEntrypoint` line swapped for an
export, so the tests exercise the shipped source rather than a copy. Instances are built with
`Object.create(OnAirInstance.prototype)`: `InstanceBase`'s constructor refuses manual
construction and then builds an IpcWrapper that wants a live Companion.

The timing-sensitive tests set the thresholds they depend on rather than waiting out the
defaults - every threshold in this module is configuration, which is what makes that honest
rather than a dodge.
