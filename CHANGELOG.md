# Changelog

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
