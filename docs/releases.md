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


## Companion module releases

Companion is versioned separately from the On Air product. Use:

```sh
npm run version:set --workspace companion-module -- patch
npm run version:check
npm run verify
npm run package --workspace companion-module
```

The module command synchronizes its package manifest, Companion manifest, and lockfile
record without changing Receiver, console, or SwiftBar versions. Commit the tested changes
and publish a module tag such as `companion-v0.7.3`. Build the final tarball from that clean
commit, then attach `companion-module/pkg/rocket-onair-0.7.3.tgz` to its GitHub release.
The tarball carries `build-info.json`, including source identity and the bundle SHA-256.

Import the package in Companion, then explicitly select the imported version on the target
connection. Check the running `module_version` and `module_commit` variables against the
release, not just the installed-version list. Verify the existing action bindings, state
feedback, and connection health before declaring deployment complete. Re-create copied
presets only where the new release changes their feedback/style definitions; do not overwrite
customized deck controls indiscriminately. Keep the previous module installed for rollback.

A module release does not imply a Receiver deployment, a firmware flash, or an API 2 migration.

## Signed Mac runtime and API 2 deployments

The Mac runtime has its own controlled installation lifecycle. Build and verify the signed
app, test normal Local Network consent in a supervised probe, then change the service
launcher with an administrator-authorized rollback plan. See [Mac runtime setup](mac-setup.md#stable-signed-mac-runtime).
Ordinary Receiver JavaScript releases reuse that runtime and do not re-sign Node.

For module releases, [the deployment helper](companion-deployment.md) verifies the installed
version/commit and retains a previous-version rollback path. API 2 linked-control migration
is deliberate and separate: preserve existing controls on a backup page, test the linked
candidates, and use native grid transfers to replace only the intended locations. Keep
custom cycle selections and verify appearance and actions before removing backups.
