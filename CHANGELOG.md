# Changelog

## Companion module 0.7.3

### Fixed

- Late responses from old connections and superseded HTTP requests no longer overwrite
  newer state observations; table refreshes are coordinated.
- The Light health preset presents connection loss, no data, and intentional sleep explicitly.
  Existing copied health buttons also stop showing green during lost contact/no data through
  the broadened `light_not_confirming` feedback, with its existing ID preserved.
- The contact-age variable updates between connection-condition changes.
- State and sleep labels distinguish Receiver intent, physical confirmation, and manual sleep.

### Added

- Running module version and commit variables, backed by embedded build identity.
- Sideload package version/hash validation and synchronized module manifest/lock versions.
- Current upgrade guidance, including explicit version activation and copied-preset migration.

The module remains on API 1.14. Product version 0.2.0 and firmware are unchanged.

## 0.2.0

This is the first tagged On Air product release. The Receiver, admin console, and SwiftBar
share a product version; Companion and ESPHome retain their independent version schemes.

### Added

- A visible version in SwiftBar's On Air About panel.
- One version command for package manifests, lockfile records, and SwiftBar metadata,
  with a consistency check in the local verification gate.
- GitHub tag/release guidance and running-build identity in the Receiver health response.
- Primary-panel readiness reporting, independent of service availability and secondary panels.
- Offline browser verification against HTML generated from current firmware source,
  explicit live-device checks, and a command to compile both firmware boards.

### Fixed

- Concurrent configuration saves can no longer leave memory and disk with different settings.
- Failed listener rebinding preserves the previous device targets, state table, and sessions.
- Environment passphrases remain authoritative through saves, reset, and restart.
- Replacing the primary panel clears old confirmation and supervisor evidence.
- Duplicate state IDs are rejected inside the row editor, including staged-row collisions.
- Failed updates restore the matching server and admin console, including interrupted
  replacement and rollback of older installations without a console bundle.
- Device connection errors retain safe network cause codes for diagnosis.

### Documentation and checks

- Updated current architecture, installation, authentication, recovery, and release guidance.
- Added regression coverage for configuration concurrency, primary evidence, credentials,
  version drift, release rollback, and redacted firmware diagnostics.
- Preserved the local verification gate and existing firmware rollback protection.
