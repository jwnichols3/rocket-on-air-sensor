# firmware/test

Tests for the HTML the panel generates, and for the behaviour of the page once a browser has
it. Added after #50, because nothing tested either.

## Why this exists

`npm run verify` runs `esphome config`, which validates YAML and never looks at
`onair_page.h`. `npm run firmware:compile` compiles that header and asserts nothing about its
output. So before these, **the entire device-served UI had no test at all** - and shipping
#50 put three defects on a live panel that a green compile and 311 passing server tests could
not see.

Two of those three were cosmetic. The class that is not cosmetic is a page that quietly stops
honouring **"empty means follow the server"**: it looks perfect in a screenshot, and the next
save silently pins the server's current colours as permanent local overrides. That is the
defect these tests exist for.

## The two suites, and why they are separate

| | `run.sh` | `browser/test-page.mjs` |
|---|---|---|
| runs | `npm run test:firmware` | `npm run test:browser` |
| in `npm run verify` | **yes** | no |
| needs | a C++ compiler | a downloaded Chromium |
| asserts on | the bytes the firmware emits | what a browser does with them |

**The host suite is in the gate; the browser suite is not.** `verify` must not fail on a
machine that has not run `npx playwright install`, and this repo has no CI to guarantee one.
Run the browser suite before shipping a change to `firmware/assets/`.

### `run.sh` - the emitted HTML and the POST contract

Compiles `onair_table.h` and `onair_page.h` on the host against `shim/`, then asserts on the
strings they produce and drives real POSTs through `Page::handleRequest`.

Built with `-fno-exceptions` deliberately, matching ESP-IDF. That is *why* a failed
allocation on the device is `abort()` rather than a throw, and it is what the byte-budget
assertions are protecting against.

Covers: the follow-the-server contract; the shape the glass will draw (including that
`unknown` is always `NO_DATA`, which three of #50's four prototypes got wrong); escaping of
server-supplied labels; the `busy` refusal; the Origin/CSRF check; NVS round-trips including
a sync that fails; the appearance verbs and their refusals; the row cap; dormant overrides;
the three banner outcomes; the pool A byte budget; and which handlers are registered with
auth and which without.

### `browser/test-page.mjs` - what only a browser can settle

Two things the host suite cannot reach:

1. **What a form actually serialises.** "The picker carries no `name`" is a string assertion;
   "the picker cannot post" is a claim about `FormData`. The gap between those is where
   D-71's third defect hid.
2. **The guarded mirror.** The picker is *seeded* with the server's value, so an unguarded
   mirror writes it into the posting field on any `input` event - Firefox fires `input` while
   its colour dialog previews and the operator may cancel; macOS NSColorPanel has no cancel
   at all. Merely *looking* at the picker would pin the server's current value as a permanent
   override. Untestable without events.

It also measures the glass geometry from the rendered box rather than from the CSS text,
which is the check that would have caught `*` not matching pseudo-elements - the defect that
inflated the ring to 58px and put lit pixels inside the reserved `y >= 49` band.

It prefers the **live device** and falls back to the committed capture, and always prints
which it used. It never silently skips.

```sh
npm run test:browser                      # live device if reachable
ONAIR_DEVICE=10.42.12.77 npm run test:browser
```

## `shim/`

The smallest set of ESPHome symbols that lets the two headers compile and run on a laptop.
Not a reimplementation. Two parts are worth knowing about:

- **`freertos/task.h`.** On the device, `submit()` stages a command and blocks the httpd task
  while the *main loop* applies it - two tasks, and the whole three-outcome model (D-64)
  exists because that handoff can miss its window. A host test has one thread, so
  `vTaskDelay` **runs the main loop** instead of sleeping. That makes the staging path real.
  A test can null the hook to reproduce a parked loop and prove PENDING is reported.
- **`esphome/core/preferences.h`.** Reproduces the two-step that matters: `save()` only
  *queues*, and the blob is written in `sync()`. That is why `save_overlay()` and
  `save_appearance()` verify by loading again, and a test can force `sync()` to fail and
  prove the verify catches it.

## What is NOT covered

Stated plainly so a green run is not read as more than it is:

- **`parse_table()`.** The JSON shim is a stub that always returns false - reproducing
  ArduinoJson would mean testing the shim rather than the device. JSON parsing is also the
  one thing here with a continuous real-world signal: `text_sensor/ConfigPull` reports
  `version:rows:ok:failed:overrides` on every pull, so a parser regression is visible within
  seconds of a flash. The HTML had no such signal, which is why the tests aim there.
- **The display lambda.** It lives in YAML and needs the panel. The tests assert that the
  page writes the `Shape` enum's integer through; whether the panel then draws it correctly
  is what `text_sensor/Render` reports from the device.
- **Concurrency.** One thread here, two on the device.
- **The pull, OTA, and anything else needing hardware.**
