# Product versions and releases

The root `package.json` version is the On Air product version. The Receiver and admin
console package versions match it, and SwiftBar's static `<xbar.version>` metadata uses
`v` followed by that version. GitHub release tags use the same form, for example `v0.2.0`.

SwiftBar reads its About metadata from the installed script. That version identifies the
plugin code, even when the Receiver is unavailable. The Receiver reports its own running
`build.version`, `build.commit`, `build.dirty`, and `build.builtAt` through `/admin/health`.
Compare both after deployment; a checkout or GitHub tag does not prove a process restarted.

Companion remains independently versioned in its package manifest. The ESPHome version
and device Build marker are separate from product release numbers. A product release does
not imply a Companion package was sideloaded or firmware was flashed.

## Prepare a version

Use a patch increment for compatible fixes and a minor increment for features or pre-1.0
contract changes. Choose a major increment deliberately. This workflow accepts stable
`MAJOR.MINOR.PATCH` versions; prereleases are not currently part of it.

```sh
npm run version:set -- patch       # or minor, major, or an explicit version such as 0.3.0
npm run version:check
npm run verify
```

`version:set` updates the root, Receiver and console manifests, their lockfile records,
and SwiftBar's About version together. It preserves the independently versioned Companion
manifest and synchronizes that manifest's lockfile record. It preserves the plugin's
executable mode and refuses malformed or backwards versions. It makes local source edits
only: it does not build, commit, tag, push, create a release, or deploy.

`version:check` fails on a missing or duplicate About field or version drift. The full
local gate runs this check and the version-tool tests before building. The project's
explicit local-gate policy remains in place; no CI service is required by this workflow.

Verify on Node 22 as well as the Receiver's runtime when those differ. Companion's
upstream base package declares Node 22 support. Its test-file timeout is 60 seconds
because Node 22 applies that limit to the whole file, including the timed reconnect
and outage checks, rather than only to individual tests.

Update [CHANGELOG.md](../CHANGELOG.md), commit the tested changes on a branch, and open a
pull request against `main`. Review the change and verification evidence before merging.
Do not publish credentials, local configuration, or machine-specific verification receipts.

## Publish the merged release

Run from a clean checkout of the merged `main` revision. Confirm that all source changes
being released passed the full gate and that the changelog describes this version.

```sh
git switch main
git pull --ff-only
npm run version:check
release_version="$(node -p 'require("./package.json").version')"
release_tag="v$release_version"
git tag -a "$release_tag" -m "On Air $release_tag"
git push origin "$release_tag"
gh release create "$release_tag" --verify-tag --title "On Air $release_tag" --generate-notes
```

Use the current changelog entry to refine the generated release notes. Confirm the GitHub
release references the expected tag and that the tag resolves to the merged commit. Never
move an already published version tag to different code; publish a new patch release.

## Deploy and verify

On the Receiver's clean `main` checkout, run `onair update`. It builds and stamps a matching
server/console pair, restarts the service, and restores the previous pair if its service
health check fails. Primary-panel readiness is checked separately from service availability.

Refresh SwiftBar's plugins, then close and reopen the On Air About panel. If SwiftBar has
cached old metadata, quit and reopen SwiftBar before checking again.

A release is deployed only after all of these are observed:

- The About panel displays the expected product version.
- `/admin/health` reports the expected `build.version` and tagged `build.commit`, with
  `build.dirty: false`.
- `primary.ready` is true, including intentional sleep, or a genuine device issue is
  reported explicitly. An intentionally disconnected secondary is not a release failure.
- The served console matches the built console, and existing state remains intact.

Keep rollback artifacts until verification completes. Firmware changes additionally require
[the firmware release checks](../firmware/README.md), including real device Build-marker
verification after the OTA rollback window. Compilation alone is not a firmware deployment.
