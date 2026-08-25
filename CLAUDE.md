# rocket-on-air-sensor

Detect Zoom/Google Meet call state on the Mac and drive a remote on-air light.

Read `CONTEXT.md` first, starting at the **Supersession index** at the top of its
`## Decisions` section - several older decisions are written in a vocabulary the system
no longer uses. The v2 architecture is settled in
`docs/superpowers/specs/2026-08-23-onair-v2-design.md` and `docs/api-contract.md`; do not
assume a transport or hardware choice that isn't recorded in those three.

## Layout and the verify gate

Four flat directories (D-37). `server/`, `admin-ui/` and `companion-module/` are npm
workspaces; `firmware/` is ESPHome under uv, driven from root scripts.

```
server/  admin-ui/  firmware/  companion-module/   docs/  deploy/
```

**`npm run verify` at the root is the gate** - every typecheck, every test, the
deploy-path tests, and `esphome config` on the firmware YAML. Run it before any commit
that touches source. There is no CI, deliberately.

The firmware half needs `npm run firmware:setup` and a `firmware/configs/secrets.yaml`
(gitignored) once per machine. Without them `verify` fails and says which is missing; it
does not skip quietly.

**There is a live device.** A real ESP32 drives a real light, supervised by a
LaunchDaemon on 8484. `onair restart` needs sudo with a TTY, so an agent cycles the
daemon by killing the process listening on 8484 and letting `KeepAlive` respawn it
against a rebuilt `server/dist/`. Never foreground `esphome logs` or `make -C firmware
flash` - they tail with no timeout and hang the turn.

## Agent skills

### Issue tracker

GitHub Issues (`jwnichols3/rocket-on-air-sensor`) via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

Canonical five roles (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at root; decisions recorded in its `## Decisions` section
(the ADR record). See `docs/agents/domain.md`.

## Dependencies

**Minimal, necessary, trusted - not zero.** A dependency earns its place by being
genuinely needed and coming from a source worth trusting; it is not rejected merely for
existing. Judge each one on need, trustworthiness, and maintenance burden.

Historical note: earlier docs in this repo assert a "zero production npm dependencies"
hard rule and attribute it to D-11. **That rule was never decided.** It entered as a
`Tech Stack:` line in the first plan (`docs/superpowers/plans/2026-08-05-onair-api-service.md`),
was copied forward into every later plan and spec, and D-11 then cited it as pre-existing
("preserves the zero-production-dependency rule") rather than establishing it. Rocket
retired it explicitly on 2026-08-23. Treat "zero production dependencies" in any older
plan, spec, or research doc as superseded by this section.
