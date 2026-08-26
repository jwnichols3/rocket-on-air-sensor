# Next steps

Updated 2026-08-26, after #44 and #18 closed.

## The board is nearly empty

| # | State |
|---|---|
| ~~44~~ | Closed. Companion module built, sideloaded, driving the real light (D-75) |
| ~~18~~ | Closed. SwiftBar running and configured from the CLI |
| 49 | `needs-info`. Intermittent `403` vs `401` in the server test suite. Has not recurred |

**#49 is the only open ticket and it should stay open, not be worked.** Chasing an
intermittent without a deterministic repro is the worst-value thing available. If it
reappears, capture the failing run first.

## One thing for Rocket, thirty seconds

**SwiftBar will not survive a reboot.** It is running and configured, but not registered to
start at login - no LaunchAgent, no login item, and the only `launchctl` entry is the running
GUI app's own non-persistent registration.

**SwiftBar menu -> Preferences -> General -> tick "Launch at Login".** SwiftBar ships its own
`LaunchAtLoginHelper.app`, so its own toggle is the right mechanism.

Registering it from the CLI was attempted and correctly blocked: adding a login item is a
persistent system-level change and belongs to the machine's owner. Not worked around.

## The gap that is not a ticket, and now is the moment for it

**Nothing writes state automatically.** Every surface is now built and proven:

```
server  ->  ESP32 panel  ->  menu bar  ->  Companion / Stream Deck
```

All four agreed on one button press during #44. And the light still spends most of its life
showing `NO DATA`, because the last write is routinely hours old and THE BUSY RULE correctly
refuses to claim calm on stale evidence.

D-30 put the detector out of this repo deliberately, and that is not being reopened here.
But **where it lives is currently deferred by silence rather than decided**, and this is the
first moment where it is the only thing left between "the parts work" and "the thing works".

Worth a decision, not more infrastructure.

## Smaller things, if the mood is for tidying

- **Extend the class-coverage check to the config page.** D-74 added it for the status page
  after that page regressed. The same failure mode can arrive from the other direction.
- **`docs/research/2026-08-23-companion-v5-module.md`** predates the module. It is research,
  so it is allowed to be historical, but a pointer at the top to
  `docs/companion-setup.md` and `companion-module/README.md` would save someone a wrong turn.
- **The Companion reference build on `rocket-clawd`** now has two connections that were
  scaffolding: `onair` (generic-websocket) and `onairhttp` (generic-http), plus test buttons
  on page 1. The real module (`onairmod`) makes them redundant. Left in place deliberately -
  they are the worked example behind the fallback section of `docs/companion-setup.md`, and
  removing them would make that section unverifiable. Remove them when the fallback goes.
