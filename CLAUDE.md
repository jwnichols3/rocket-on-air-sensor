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

**There are live devices.** Real ESP32s drive a real light, supervised by a
LaunchDaemon on 8484. Since D-147 the server drives a LIST (`config.devices`): the CrowPanel
at `10.42.14.239` is the **primary**, and `confirmed` describes it and nothing else; the
Elegoo at `10.42.12.77` is a best-effort secondary and is normally off (D-87). An absent
secondary is a normal condition, never a fault - check `GET /admin/health`'s `devices` array
before concluding a panel is broken. `onair restart` needs sudo with a TTY, so an agent cycles the
daemon by killing the process **listening** on 8484 and letting `KeepAlive` respawn it
against a rebuilt `server/dist/`. Use `lsof -ti :8484 -sTCP:LISTEN` and nothing else:
a bare `lsof -ti :8484` also lists every CLIENT with a socket open to it, so
`lsof -ti :8484 | head -1` can return a browser and kill that instead, leaving the
daemon running the old build while the restart appears to have worked. Never foreground `esphome logs` or `make -C firmware
flash` - they tail with no timeout and hang the turn.

**A flash is not done when the upload says it is.** `esphome upload` has reported success,
the device has rebooted, and it has come back on the OLD firmware (#87). **A mechanism that
does exactly this is present and armed, by design**: `enable_ota_rollback` defaults on, so a
fresh image boots `PENDING_VERIFY` and is confirmed only after safe_mode's 60s
`boot_is_good_after` (`main.cpp`: `should_enter_safe_mode(10, 300000, 60000, true)`). Any reset
inside that window makes the bootloader revert to the other slot, and the panel comes back
WORKING on the old firmware with no error anywhere. There is no factory partition, so keep
rollback on - it is the only soft-brick protection on a board with no serial. Whether that
mechanism is what bit in #87 is still open; a stale binary (D-100 again) is not eliminated,
because `esphome upload` ships `build/firmware.ota.bin` and does not compile, and nothing has
ever checked THAT file. So: **after flashing, wait for a marker that only the new build can
produce.** `/onair` answering proves nothing: the panel serves HTTP throughout the OTA write,
so the page you are talking to may be the build you were trying to replace. This has cost a
measurement twice (D-100, then #87); both times the flash looked fine and the thing measured
was the old firmware.

**There is now a standing marker, so stop inventing one per flash (D-145).**

```
curl -s -u rocket:ESP32 http://<device>/text_sensor/Build
# 2026.8.0 (config hash 0x...., built 2026-08-31 13:47:22)
```

The config hash moves when the YAML changes, and this identifies the RUNNING image - which is
exactly what a successful-looking upload can leave stale. Record it BEFORE the flash and compare
after: a marker you only ever observe afterwards proves the page renders, not that anything
moved. And look again past the 60s window, because an image inside it is `PENDING_VERIFY` and
any reset silently reverts it.

**The timestamp does NOT move on its own for a header-only change (#96).** ESPHome regenerates
it only when the config hash or the ESPHome version changes; a change to `onair_page.h` or
`onair_table.h` moves neither, and the recompiled image carries the OLD timestamp. Compile with
`make -C firmware compile CONFIG=configs/<board>.yaml`, which removes the cached
`build_info.json` first so the timestamp is fresh - or remove it yourself before a bare
`esphome compile`. A compile whose `INFO Build Info:` line matches the panel's current `Build`
has produced an image the marker cannot distinguish from the running one; do not flash it.

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

### Sideloading the Companion module

`.claude/skills/sideload-companion-module/`. **Importing the package does not move the
connection onto it** - Companion holds several versions and goes on running the old one, with
nothing on screen saying so. Same shape as the flash rule above, same fix: verify with a
marker the new build produces, not with the version label. The skill carries a
self-refinement loop; run it.

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
