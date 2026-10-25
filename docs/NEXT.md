# Next steps

Release changes belong in [CHANGELOG.md](../CHANGELOG.md), and the version/tag process
is in [Releases](releases.md). Deployment observations and acceptance results should be
recorded locally for the installation being tested.

## Acceptance checks

After installing an update, verify the version in SwiftBar's About panel and the running
Receiver's `/admin/health` response. Then run a real call through the external Detector,
Receiver, primary panel, and Companion, checking both call start and call end.

An intentionally disconnected secondary panel is not part of the primary's success
condition. Treat HTTP service availability and primary readiness separately. See
[Mac troubleshooting](mac-setup.md#a-powered-panel-is-reported-unreachable) when a powered
panel is reported unreachable.

## Firmware follow-up

[Issue 87](https://github.com/jwnichols3/rocket-on-air-sensor/issues/87) concerns OTA
reporting success while the device later runs its old firmware. The root cause is
unresolved. Keep rollback protection enabled, compile through the Makefile, record the
running Build marker before an upload, and verify the new marker after the rollback
window. Follow [the firmware guide](../firmware/README.md) and `CLAUDE.md` before a flash.

Check the issue board and installed runtime when needed instead of treating historical
setup notes as current deployment status.
