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

Confirm the new version appears in the module's version list.

## 3. MOVE THE CONNECTION ONTO IT

**This is the step that gets skipped, and skipping it is silent.**

After step 2 the version list shows the new version, and the plug icon - "in use by a
connection" - is **still on the old one**. Nothing has changed on the deck.

`Connections` -> click the connection -> **Module Version** -> pencil -> pick the new version
-> **Save**. The connection restarts on the new build.

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
| A new **feedback** | a button's feedback picker | Same, and it is what a deck actually keys on |
| A changed variable **description** | `Variables` | Catches a rename the name alone would miss |

Verify the value is *correct*, not merely present. A new field showing the wrong thing is a
worse outcome than a missing one, because it looks like success.

And check the marker was **absent before**. A marker you only ever observe after the change
proves the page renders, not that anything moved - which is the same vacuous-check failure as
diffing two directories that both failed to extract.

Then read `Log` (sidebar, not `/logs`). Filter mentally: this host runs many connections and
one of them is usually failing about something unrelated. Look only for lines naming your
connection. A `stream: fetch failed` at the moment the on-air server restarted is expected -
that is the watchdog reconnecting - and is not a fault.

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
- **`find` located the hidden file input first time** with the query in step 2. Worth keeping
  verbatim.
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
