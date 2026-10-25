# Current architecture and operations

This guide summarizes the current implementation. The [API contract](api-contract.md)
is the authority for client behaviour; [GLOSSARY.md](../GLOSSARY.md) records the domain
and decisions, including superseded designs.

## Data flow

```text
VCREC Detector ----+
Admin console -----+--> Receiver: On-air API --> primary ESPHome panel
Companion ---------+                |          --> best-effort secondary panels
SwiftBar ----------+                +----------> browser display and status clients
```

VCREC decides whether a call is in progress and writes a row ID with source provenance.
Manual clients write through the same API. The last valid write wins regardless of source.
The Receiver persists the state and reasserts it after restart; it does not change state
because a write became old. Renderers poll and judge their own connection to the Receiver.

The state table defines each row's stable `id`, editable label, colours, `busy`, description,
and display order. The operational state references an ID. Presentation travels in the
versioned table; state messages carry semantics and confirmation. Unknown IDs are refused
on state writes; a reference to a deleted row resolves to the reserved, busy `unknown` row.

## Devices and confirmation

There is one enabled primary whenever devices are configured. `confirmed` and
`confirmedReason` describe that primary; a missing secondary never changes their meaning.
An intentionally disconnected test panel can remain a secondary without affecting
the primary's readiness.

The Receiver reads the device's state, frame progress, and darkness evidence. Interpret
`confirmed: unknown` with its reason:

| Reason | Meaning |
|---|---|
| `asleep` | The panel is deliberately dark; this alone is not a fault |
| `not-repainting` | Device state agrees but expected frame progress is absent |
| `unreachable` | The Receiver cannot obtain fresh confirmation |
| absent | Confirmation is unavailable without a known reason |

`GET /admin/health` describes the service and individual devices. A responding HTTP server
is not proof of a working physical light. Its build and primary-readiness fields help
separate the running software from the primary's current confirmation. Read the current
response and contract rather than assuming a checked-out commit is the deployed build.
`primary.ready` includes intentional sleep: it describes a healthy primary, not a
promise that the glass is currently lit. Use `confirmed` and `confirmedReason` for
the display evidence.

Night schedules and local presentation overrides live on each panel. The console links to
those settings. Server `/panel/sleep`, `/panel/wake`, and `/panel/toggle` request manual
sleep/wake changes; the response's `delivered` field is not proof the glass went dark.

## Configuration and credentials

`~/.onair/config.json` is the administrator-owned config document. State writes live in
`~/.onair/state.json`. Keeping them separate prevents a frequent state write from replacing
an administrator's settings. The console submits the complete config with its base version.
A stale base is refused rather than silently replacing someone else's save.

`~/.onair/config.env` is an overlay, not the main document. Process environment variables
win over the same names loaded from that file. `ONAIR_PASSPHRASE` overrides the machine
passphrase; legacy `ONAIR_TOKEN` is used only when the newer variable is unset. Primary
connection overrides are `ONAIR_LIGHT_HOST`, `ONAIR_LIGHT_ENTITY`, `ONAIR_LIGHT_USER`, and
`ONAIR_LIGHT_PASS`. Document edits do not remove environment overrides.

Three credentials have distinct jobs:

| Credential | Used by |
|---|---|
| On-air passphrase | Detector, Companion, and other state clients |
| Admin session | Human administration of the Receiver |
| Device HTTP basic auth | Receiver access to each ESPHome panel |

Same-origin local access has a narrow waiver. Factory reset still requires the admin
password. See the contract for the exact checks, rotation behaviour, and public routes.

## Verification and deployment

Run `npm run verify` before source commits. The project deliberately uses a local gate
rather than CI (D-37). [README.md](../README.md) and the [firmware guide](../firmware/README.md)
list prerequisites. Run local tests in an isolated checkout if the working tree also serves
the installed Receiver: building `server/public/admin` updates what its browser users see.

On macOS, `deploy/onair` manages the supervised service. `onair restart` restarts it;
`onair reload` reloads its launchd configuration. The application retains
`POST /admin/restart` but currently refuses it with 403. Raspberry Pi installation uses
`deploy/bootstrap` and systemd; consult [Pi setup](pi-setup.md) for host-specific steps.

A release is verified at the running boundary:

1. Confirm which server build is running and that config/state storage is usable.
2. Confirm primary-device evidence; record an intentionally absent secondary separately.
3. For firmware, compare the Build marker before and after upload, including after the
   rollback window. Upload success alone is insufficient.
4. Check call start and call end through the external Detector and the primary light.

Historical research, prototypes, and plans remain under `docs/research`, `docs/design`,
and `docs/superpowers`. They explain earlier work; they do not establish current runtime
state. [NEXT.md](NEXT.md) lists the current follow-up work.
