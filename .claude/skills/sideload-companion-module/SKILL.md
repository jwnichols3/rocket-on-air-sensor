---
name: sideload-companion-module
description: Ship companion-module/ to a running Bitfocus Companion host and prove the new build is the one actually executing. Use when the module version has changed and a Companion instance needs updating, or when a Stream Deck is behaving like an older build. Covers the install-is-not-running trap and the marker rule.
---

# Sideload the Companion module

Take `companion-module/` from this repo to a running Companion host, and **prove the new
build is the one executing.** Installing it is the easy half and not the half that goes
wrong.

## The rule this skill exists for

> **A sideload is not done when the import says it is.**

Companion happily holds several versions of a module side by side and goes on running the
old one. Importing the package adds a version; it does **not** move the connection onto it.
The version label on the connection is then what Companion *believes*; a new variable or
feedback appearing is what it *does*. Trust the second.

This is the same shape as the firmware rule in `CLAUDE.md` - *a flash is not done when the
upload says it is* - and it has the same cost when ignored: you measure the wrong build and
conclude the code is broken.

## Before you start

Know the answers, or find them:

- **Which host.** Companion's admin is on port `8000`. `rocket-util1` is the usual target and
  answers on `10.42.13.92` and `10.42.14.75` - **the same multi-homed machine**, not two.
- **Which connection.** There may be several using this module. The one that matters is the
  one that is `Enabled` and green. **`Connections` has no search box** and the list runs to
  dozens; the on-air one is labelled `On_Air`, sits in *Ungrouped Connections*, and took two
  full scrolls to reach. Once you have opened it, its URL is
  `/connections/<id>` - keep that id, it is the fastest way back.
- **What is on it now.** Record the version before you change anything. You need a before to
  have an after.

## 1. Build the package

```sh
npm run package --workspace companion-module
```

Writes `companion-module/pkg/rocket-onair-<version>.tgz`.

**Build it even if a tarball with the right version already exists.** `pkg/` is not cleaned
and nothing ties a `.tgz` to the source that produced it, so an existing file may predate an
edit. Sideloading a stale package is D-100's failure - shipping a build that is not the build
you think you are testing - relocated from the firmware to the module, and it survives every
check in step 4 because the marker only proves *which version*, never *which build of it*.

**Never hand-roll the tar.** `package.mjs` sets `COPYFILE_DISABLE=1` and forces a real
top-level directory, then re-reads the tarball to prove both. Both failures are invisible and
neither error message points at the real cause - one dies with `EISDIR` on the module
directory, the other says "Doesn't look like a valid module", which reads like a manifest
fault and is not one.

If the module version has not been bumped, stop and bump it. Companion keys installed
versions by version string; re-importing the same one gives you no way to tell the two apart,
which destroys the marker check in step 4.

## 2. Import it

Open `http://<host>:8000/modules`. **Import module package** must be enabled - if it is
greyed out, remote import is off and you need `enable_restricted_modules` in Settings, or an
SSH tunnel:

```sh
ssh -f -N -L 18000:127.0.0.1:8000 john@<host>   # then use http://127.0.0.1:18000
```

Do not assume the tunnel is available: `ssh` to `rocket-util1` offers publickey/password only
and there is no agent key, so a non-interactive `ssh` fails outright. The browser path is the
primary route; the tunnel is the fallback that needs a human at a prompt.

**Do not click the Import button.** It opens a native file picker the agent cannot see or
dismiss. Find the hidden `<input type=file>` behind it and upload directly:

- `find` -> *"hidden file input for Import module package"*
- `file_upload` with that ref and the absolute `.tgz` path

**Confirm the new version appears in the module's version list before going on**, at
`/modules/connection/rocket-onair`. Do not skip this because step 3 is about to show you a
version list anyway - **the connection dialog's version dropdown can be stale.** Measured: an
import that had worked perfectly showed only the OLD versions in that dropdown, which reads
exactly like a failed import. The modules page is the source of truth; a reload of the
connection page then fixes the dropdown.

## 3. MOVE THE CONNECTION ONTO IT

**This is the step that gets skipped, and skipping it is silent.**

After step 2 the version list shows the new version, and the plug icon - "in use by a
connection" - is **still on the old one**. Nothing has changed on the deck.

Companion says so itself, in the log, and it is worth knowing the phrasing: an import logs
`Installed connection module rocket-onair v0.6.0` and then
**`Controller: Reloading 0 instances`**. Zero. The module is on disk and nothing is running it.

`Connections` -> click the connection -> **Module Version** -> pencil -> pick the new version
-> **Save**. The connection restarts on the new build.

Two timing details, both cost a retry:
- **Load the connection page fresh after an import.** A page open from before the import
  offers a stale version list (see step 2).
- **The dialog animates.** Clicking the version dropdown immediately after the pencil catches
  it mid-transition and the click misses. Wait a beat, screenshot, then click.

> **THE FIRST CLICK AFTER A NAVIGATE IS UNRELIABLE, ANYWHERE IN THIS ADMIN UI.** It has now
> eaten a click on the version pencil and on the `Presets` tab, for the same reason both
> times: React had not finished painting and the handler was not attached yet. **Screenshot
> after every navigation and confirm the page has actually rendered before clicking.** The
> failure is silent - the click reports success and nothing happens - so it reads as a broken
> control rather than as a race, and the natural response (click again, harder) is what breaks
> a toggle.

Check the connection is green afterwards. A module that fails to initialise goes red or
warning here and nowhere else.

**`Update Policy` on that panel is not your problem.** It governs updates from the module
store; a sideloaded module is not in the store, so `Stable` will not quietly move the
connection off the version you just selected.

## 4. Prove it with a marker, not a label

**Name something the new build has that the old one cannot fake**, then go and see it. A
version number in the UI is not that thing.

Good markers, cheapest first:

| Marker | Where | Why it works |
|---|---|---|
| A new **variable** | `Variables` -> the connection | Registered by the running instance at init. Check the description text too, not just the name |
| A new **preset**, and the **count** | `Buttons` -> `Presets` tab -> the connection | The count is on the connection's row before you even open it, which makes absent-before / present-after a single number. Best marker when a version adds actions rather than variables |
| A new **feedback** | a button's feedback picker | What a deck actually keys on |
| A changed variable **description** | `Variables` | Catches a rename the name alone would miss |

**Pick the marker from what the version actually changed.** A release that adds only actions
registers no new variable, and looking for one would say "no change" about a perfectly good
install. Actions surface as presets, so the preset count is the marker for those.

The `Presets` tab is at the top right of `Buttons`, beside `Pages` and `Recorder`. **It is a
toggle, so do not click it twice on principle** - a blind double click lands on Presets and
then goes straight back to Pages, which reads as the tab being broken. Click once, screenshot,
and click again only if the panel did not switch. (A click DOES get eaten if the page is still
painting the button grid, which is where "it needs two clicks" came from.) `find` returns a ref
for the tab that does not activate; click the coordinates instead.

Verify the value is *correct*, not merely present. A new field showing the wrong thing is a
worse outcome than a missing one, because it looks like success.

**A preset whose face is data-driven will not look like its own art, and that is not a
fault.** Companion renders each preset thumbnail with its feedbacks applied against live
values, so a preset that wears the current state shows the *state's* face, not the base style
you wrote. 0.7.0's cycle button rendered as a green tick because the row was AVAILABLE.
Identify presets like that by NAME, not by picture: `find` -> *"preset button titled X"*
returns it from the accessibility tree even when the image shows something else entirely.

And check the marker was **absent before**. A marker you only ever observe after the change
proves the page renders, not that anything moved - which is the same vacuous-check failure as
diffing two directories that both failed to extract.

Then read `Log` (sidebar, not `/logs`). **Turn `Info` on** - the toggles are top left and the
page opens with `Warning` only. This matters: the module's own startup line is Info-level, and
at the default filter you cannot see the new process start at all. What you want is the
sequence, which is the cheapest end-to-end confirmation there is:

```
20:33:15 Instance/UserModulesManager: Installed connection module rocket-onair v0.6.0
20:33:56 Instance/ProcessManager: Starting instance: On_Air
20:33:56 Instance/Child/On_Air: Process started process 67198
20:33:56 Instance/Connection/On_Air: state table v11, 5 rows      <- the MODULE talking
```

That last line is the module itself, on the new build, having reached the server.

Filter mentally: this host runs many connections and one of them is usually failing about
something unrelated. Look only for lines naming your connection. A `stream: fetch failed` at
the moment the on-air server restarted is expected - that is the watchdog reconnecting - and is
not a fault.

**Check the tail is current before reading anything into a quiet log**: compare the last
line's timestamp to the clock. `ptz-a` fails every ~77 s and is a usable heartbeat - if its
last line is more than that old, the view has stopped updating and you are reading history.

### The one thing this procedure cannot prove

**A sideload can prove the action EXISTS. It cannot prove pressing it works, because there is
nowhere safe to press it.** Companion has no scratch surface - `Interactive Buttons` in the
sidebar is not a testable sandbox and `/interactive-buttons` is not even a URL, it redirects
to `/connections`. The only way to press a new action is to place it on a real button on a
real page, which means editing the deck somebody is using.

So do not go looking for a sandbox; there isn't one. Either place a button deliberately, with
the owner's say-so, or **state the gap in the report**: the module-to-server hop for the new
action is covered by module tests against a fake server and by the live server route under
curl, and by nothing that presses the two together. Say which, rather than letting a green
connection imply more than it proves.

## 5. Say what the humans have to do by hand

Report these every time, because none of them happen automatically:

- **Placed buttons keep their bindings.** Preset ids key on the immutable row `id`, so nothing
  is re-bound and existing buttons keep working. Their *behaviour* follows the new build.
- **Placed buttons do not gain new feedbacks.** A placed button is a one-time copy of a
  preset. A feedback added in this version has to be added by hand, or the preset re-dragged.
- **A feedback whose meaning changed needs no action** - the placed button calls into the new
  code. Say so explicitly, because the opposite is the natural assumption.

---

# The self-refinement loop

**Run this at the end of every invocation. It is part of the skill, not an optional extra.**

The loop must terminate in one of two ways, and "I read it and it seemed fine" is neither:

- **an edit to this file**, or
- **an explicit statement of what was checked and what confirmed no change was needed.**

## The loop

1. **Diff intent against reality.** Walk the steps above against what you actually did. For
   each: did it work first time? Did you need a step that is not written here? Did you skip
   one safely - and if so, is it wrong or merely conditional?

2. **Every retry is a defect in this file.** If you clicked the wrong thing, guessed a
   selector, hunted for a page, or had to scroll to find something - that is a missing
   sentence. Add it with the concrete detail: the URL, the label text, the sidebar position.

3. **Ask what would have gone wrong silently.** The most valuable additions are the checks
   nobody would have thought to make. Step 3 exists only because a run once ended with the
   connection still on the old version and everything looking correct.

4. **Re-check the marker table.** Add this version's marker to Field notes with what it
   should read when healthy. The next run needs a marker for *its* version and the pattern to
   pick one.

5. **Prune.** A skill that only grows stops being read. Delete anything now false, and
   anything that turned out never to matter. Removing a paragraph is a valid outcome.

6. **Record it.** Append to Field notes below: the date, the version, and one line per thing
   learned. If nothing was learned, write that, with what confirmed it.

## What not to do in the loop

- Do not add speculation. Only what happened, or what a real failure would have caught.
- Do not rewrite prose for style. Edit for a reader who is about to break something.
- Do not let it become a changelog of the module. This file is about the *procedure*.

---

# Field notes

## 2026-08-30 - 0.3.0 -> 0.4.0

- **Confirmed the install-is-not-running trap on a real run.** After the import the version
  list showed `0.4.0`, `0.3.0`, `0.2.0` with the plug icon still on `0.3.0`. Had the run
  stopped there, the deck would have gone on running 0.3.0 and lit its "not confirming"
  button all night, which is the exact thing the upgrade was for. Step 3 is written from this.
- **Remote import was already permitted** on `rocket-util1` - the button was enabled and no
  tunnel was needed. The tunnel instructions stay because that is a per-host setting.
- **Marker used:** `$(On_Air:confirmed_reason)`, described *"Why confirmed is unknown (asleep /
  not-repainting / unreachable)"*. Healthy reading is **empty** while the panel is lit - the
  server omits the field unless it can name a reason. Variable count went 9 -> 10.
- **The log needed filtering.** `ptz-a` was failing every ~77s about an unrelated host and
  filled the page. The only On_Air line was a `stream: fetch failed` at the exact second the
  on-air daemon was restarted - expected. Step 4's filtering advice is from this.
- **`/logs` redirects to `/connections`.** The sidebar `Log` link goes to `/log`, singular.
  Cost one wasted navigation.
- **`ssh` to the host failed** - publickey/password only, no agent key - so the tunnel
  fallback was not actually available. The browser path carried the whole run.
- **The package was NOT rebuilt on this run**; an existing `0.4.0` tarball was verified by
  listing it instead. That was luck rather than judgement: nothing ties a `.tgz` to the source
  that made it. Step 1 now says to rebuild regardless, and says why. Checked afterwards -
  rebuilt and compared - and it happened to be current: `main.js` sha256 identical.
- **The check that proved it was nearly vacuous, which is its own lesson.** The first attempt
  extracted into two directories, `diff -r`'d them, and printed IDENTICAL - but the extraction
  step could have silently failed and two empty directories also diff clean. Redone with a
  file count and a **negative control**: plant a change, confirm `diff` reports it, remove it,
  then compare for real. Any check that would pass on nothing is not a check. This applies to
  step 4's marker just as much: confirm the marker is *absent before* and *present after*,
  or you have proven only that a page renders.
- Loop outcome: **file created from this run, then amended by its own loop.** Five additions:
  the missing search box on `Connections`, rebuild-always, `ssh` not being available, the
  `Update Policy` red herring, and `/log` vs `/logs`. Steps 3 and 4 are the two that would
  have been guessed wrong without this file existing at all.

## 2026-08-30 - 0.4.0 -> 0.5.0 (#91, the panel sleep/wake buttons)

- **THE CONNECTION DIALOG'S VERSION DROPDOWN WAS STALE, and it looked exactly like a failed
  import.** After uploading 0.5.0 I went straight to step 3, opened the version picker, and
  saw only `v0.4.0 / v0.3.0 / v0.2.0`. `/modules/connection/rocket-onair` showed `0.5.0`
  installed all along. A reload of the connection page fixed the dropdown. **I had skipped
  step 2's confirmation**, which is the check that would have told the two apart instantly -
  so step 2 now says why it matters rather than just saying to do it.
- **The connection id shortcut from the last run paid off**:
  `/connections/LtdseHJSGXPUank5m0uDc` opens the On_Air editor directly, no scrolling past
  thirty connections. Keep that id.
- **Marker used: the PRESET COUNT, 7 -> 9**, plus `PANEL SLEEP` and `PANEL WAKE` appearing by
  name under `Buttons` -> `Presets` -> `On_Air` -> `Utility`. 0.5.0 adds no new variable at
  all, so the previous run's marker type would have reported no change on a perfectly good
  install. That is why the marker table now says to pick the marker from what the version
  changed.
- **The `Presets` tab needed two clicks both times** - the first lands before the panel
  renders - and the `find` ref for it does not activate. Coordinates work.
- **The dialog animation ate one click.** Pencil, then immediately clicking the dropdown,
  caught it mid-transition.
- **Nothing in the log.** Only `ptz-a`, still failing every ~77s about an unrelated host, as
  it was on the previous run. Confirmed the tail was current by comparing the last line's
  timestamp to the clock rather than assuming the view was live - worth doing, because a log
  that has silently stopped updating looks identical to a quiet one.
- Loop outcome: **five edits.** Step 2 now explains itself, step 3 gained the two timing
  traps, and the marker table gained presets plus the rule that the marker must match what
  the version changed.

## 2026-08-30 - 0.5.0 -> 0.6.0 (#92, button art and the sleep/wake toggle)

- **Step 2's confirmation did its job, first time it was actually followed.** Checked
  `/modules/connection/rocket-onair` after the upload, saw `0.6.0` at the top of the list with
  **the plug icon still on `0.5.0`**, then loaded the connection page fresh - and the version
  dropdown offered `v0.6.0` correctly. Last run's stale dropdown did not recur. One check, one
  page load, and the ambiguity that cost a retry last time never appeared.
- **Companion states the install-is-not-running trap in its own log**, which is new and useful:
  `Installed connection module rocket-onair v0.6.0` is immediately followed by
  `Controller: Reloading 0 instances`. Step 3 quotes it now.
- **Marker used: the PRESET COUNT, 9 -> 18**, read off the `On_Air` row in `Buttons` ->
  `Presets` before and after, plus four category headings that cannot exist in 0.5.0 -
  `Panel`, `Panel (words)`, `States`, `States (words)`. 18 was PREDICTED before looking
  (5 table rows x 2, plus 8 utility), which is worth doing: a count you compute first is a
  test, and a count you read first is a description.
- **`png64` takes RAW base64 with no `data:image/png;base64,` prefix**, and Companion renders
  it in the preset previews in the web UI. Confirmed by eye at 72 px. Recorded because the next
  version that touches art should not have to rediscover it.
- **The `Presets` tab is a toggle.** Clicking it twice - which this file told me to do - opened
  Presets and then closed it again, which looks exactly like a tab that does not work. Step 4
  is corrected. The underlying truth is narrower: a click is eaten while the button grid is
  still painting.
- **The log's default filter hides the thing you most want.** `Warning` only is the default,
  and `Instance/Connection/On_Air: state table v11, 5 rows` - the module's own first words on
  the new build - is Info. Step 4 now says to turn Info on and quotes the four-line sequence.
- **The staleness check nearly produced a false alarm, and was still worth running.** The tail
  read 20:34:27 against a 20:35:35 clock, which looked stale until I noticed `ptz-a`'s 77 s
  period made the next line due at 20:35:44. The check is now written with that heartbeat in
  it, so the next run gets a threshold instead of a feeling.
- **What a sideload does NOT verify, and this run did not:** the new ACTION was never pressed.
  Pressing it needs a button placed on the deck, and the deck is Rocket's production surface -
  not something to add to unasked. The action is covered by tests against a fake server and the
  server route was exercised live by curl; the module-to-server hop for `panel_toggle`
  specifically is verified by neither. Say so rather than implying the sideload proved it.
- Loop outcome: **four edits.** One correction (the Presets tab is a toggle, and this file had
  it wrong), two additions (the log filter and the `Reloading 0 instances` line), one prune
  (the `find`-worked note, now redundant with step 2 carrying the query verbatim).

## 2026-08-30 - 0.6.0 -> 0.7.0 (#93, the state-cycle key)

- **Marker used: the PRESET COUNT, 18 -> 20**, plus a preset named `Next state (cycle)` in
  `States` and in `States (words)`. Recorded 18 before the import, predicted 20 out loud, and
  read 20 after. The prediction is worth making explicitly: it is what turns "a number changed"
  into a test.
- **THE MARKER LOOKED WRONG AND WAS RIGHT.** The cycle preset rendered as a green tick, because
  Companion draws preset thumbnails with feedbacks applied and the row was AVAILABLE - which is
  exactly what that button is designed to do. Confirmed by name with `find` rather than by
  picture. Step 4 now carries this; it would otherwise read as a build that shipped the wrong
  art.
- **Confirmed last run's Presets-tab correction, and generalised it.** The click was eaten once
  again - but only on the visit where the page had just been navigated and the button grid was
  still blank. On the visit where the page was already painted, one click worked. So the toggle
  wording is right and the cause is render timing, which also explains the version pencil eating
  a click on this same run. Promoted to a general rule at step 3 rather than left as two
  unrelated quirks.
- **Went looking for a scratch surface to press the new action on. There is none.**
  `/interactive-buttons` is not a route - it redirects to `/connections` and opens the Add New
  Connection panel, which is startling and harmless. Cost one navigation. Written up as its own
  short section, because the next run will have the same instinct and deserves to be told no
  before it spends the navigation.
- **The install-is-not-running trap fired again, exactly as documented**: after the import,
  `/modules/connection/rocket-onair` listed 0.7.0 with the plug still on 0.6.0. Step 3 remains
  the step that carries this file.
- **Version dropdown was NOT stale this time.** Step 2's confirmation was done first, as the
  file now says to; the connection page was then loaded fresh and offered v0.7.0 immediately.
  The 0.5.0 run's failure does not reproduce when the order is followed, which is evidence the
  fix was the right one.
- **Log was clean and current.** `Installed connection module rocket-onair v0.7.0` ->
  `Reloading 0 instances` -> `Starting instance: On_Air` -> `state table v11, 5 rows`, no
  On_Air errors. `ptz-a` still failing every ~77s about an unrelated host, third run running.
- Loop outcome: **three edits, no prune.** One generalisation (first-click-after-navigate),
  one addition (data-driven preset faces), one new section (there is no sandbox). Nothing in
  the file turned out to be false this run - the two corrections made last run both held.

## 2026-08-31 - 0.7.0 -> 0.7.1 (a feedback that was never re-evaluated)

- **Marker used: THE BUTTON ITSELF, on the grid at `/buttons`.** 0.7.1 fixes a feedback that
  never fired, and the panel happened to be dark throughout - so key 2/2 went from a white moon
  on dark to a black sun on light grey across the version change, with nothing else touched.
  When a release fixes something VISUAL, the placed button is the best marker there is: it is
  the actual user-visible behaviour rather than a proxy for it, and absent-before /
  present-after is one screenshot each.
- **The button editor is a diagnostic tool and this file never said so.** `Buttons` -> click the
  key -> `Feedbacks` shows each feedback, whether it is enabled, and its full override list
  (Companion 5.x calls these "Layered Styles Overrides" - Text/Color/Image/Background as
  separate rows). That view is what proved the preset was correct and the FEEDBACK EVALUATION
  was not, which is a distinction no amount of reading module source would have settled
  quickly. Check it before suspecting the preset.
- **A correct-looking button that never changes means the feedback is not being re-checked.**
  Companion only re-evaluates a feedback when the module asks. The overrides can be perfect and
  the id can be missing from the module's `checkFeedbacks(...)` call, and nothing anywhere
  reports a fault. Symptom to remember: action works, hardware responds, button face frozen.
- Version dropdown was current with no reload needed; the two-click dance on the pencil was the
  first-click-after-navigate race again, already documented at step 3.
- Loop outcome: **two additions**, both about using the button editor as a diagnostic. Nothing
  in the file turned out to be false.
