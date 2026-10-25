# Companion module deployment helper

`npm run module:deploy -- ...` operates on one explicitly named `rocket-onair` connection.
It uses the same admin WebSocket RPC as Companion's web UI, supports Companion 5.1.x, and
respects the host's existing custom-module import permission. It does not create an API key,
spoof a local client, change permissions, edit connection settings, press buttons, or replace
placed controls. A different Companion minor version requires reviewing its RPC contract.

## Inspect and capture selected controls

```sh
npm run module:deploy -- inspect \
  --target http://companion-host:8000 --connection CONNECTION_ID \
  --control 1/2/1 --control 1/2/2
```

Inspect performs no remote mutations. It reports the selected module, safe runtime identity,
and connection status. Each `--control` selects a page/row/column (page starts at 1).
The helper resolves the stable page/control IDs through `pages.watch`, then captures each
control through `controls.watchControl`. It never requests a full connection configuration
or its credentials.

Every command creates a private job directory under `~/.onair/companion-deployments/`, or
under `--backup-dir DIR`. Directories are mode 0700 and JSON files are 0600. `before.json`
contains only the selected connection's metadata, safe runtime fields, and explicitly
requested control snapshots. Controls can themselves contain sensitive labels or action
values: keep these backups local. `receipt.json` omits control payloads and arbitrary module
variables, and CLI output does not include credentials or remote error-message bodies.

## Deploy a new version

From a clean committed checkout, build the package using the repository's module packaging
command, then pass that package explicitly:

```sh
npm run package --workspace companion-module
npm run module:deploy -- deploy \
  --target http://companion-host:8000 --connection CONNECTION_ID \
  --package companion-module/pkg/rocket-onair-VERSION.tgz \
  --control 1/2/1 --control 1/2/2
```

The helper validates the compressed archive without extracting files or executing its code.
It checks module ID, matching versions, clean source commit identity, archive structure,
entry types, and the main bundle's recorded SHA-256. It then saves the private snapshot,
imports a new version, explicitly changes only the target connection's module version,
and waits for matching `module_version` / `module_commit` variables and a healthy connection.
The prior installed module version is retained.

If the requested version is already active with the correct running identity, the command
returns `already-active` without mutation. An installed but inactive/unverified copy of the
same version is refused: publish a new version instead of making two builds indistinguishable.
If activation fails, the helper attempts to restore and verify the previously selected
version. It does not overwrite a different module/version selected by a concurrent operator.
Read the failure receipt before retrying. Each RPC call and activation wait has a timeout;
`--timeout-ms` controls the activation/rollback window (default 60000, range 1000..300000).

The service connection being healthy proves communication with the Receiver. It does not
prove the physical panel is lit. Inspect the Receiver's primary readiness and, when authorized,
exercise the existing controls with a recorded starting state and restoration plan.

## Roll back

```sh
npm run module:deploy -- rollback \
  --target http://companion-host:8000 --connection CONNECTION_ID \
  --backup /absolute/path/to/job/before.json
```

The backup must match the target origin and connection ID, and the previous version must
still be installed. Rollback selects and verifies that version; it does not uninstall the
new package or rewrite the saved connection options or controls.

## Control migration and restoration are separate

The helper captures controls but does not silently restore their JSON during a module
rollback. Companion 5.1's `importExport.importSinglePage` resets the entire page before
importing; a sparse page import is not a safe way to restore two controls.

For an explicitly authorized linked-preset migration, preserve the original controls on a
separate backup page using Companion's native grid transfer operations before replacing them.
A **move** preserves control IDs; a copy creates new IDs. Moving originals back can restore
just the affected locations without overwriting the rest of MAIN. Keep the local snapshots
as independent evidence, verify action options and appearance, and remove temporary backup
pages only after acceptance. Linked-preset placement itself is not part of this deployment
command.
