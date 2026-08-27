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

**CORRECTED 2026-08-26.** An earlier version of this file said that "where it lives is
deferred by silence rather than decided". That was wrong, and it was wrong in a way that
would have sent someone off to make a decision that already exists.

**D-30 decides it.** Zoom/Meet sensing is done by a separate existing project, **VCREC**,
"which will be evolved to push events to this server". This repo never imports it, never
names it in code, and never depends on its shape. `docs/api-contract.md` is the only
coupling, which is exactly why the contract had to be legible enough to be written against
by a client whose source nobody here reads.

So the decision exists and the WORK does not. Those are different things.

### What is actually open

Not where the Detector lives. When, or whether, VCREC gets the work:

1. **Do it.** VCREC writes to `POST /state/{id}` with `source=auto:vcrec`. Nothing in this
   repo changes.
2. **Do not do it, and drive the light by hand.** The menu bar and the Stream Deck are
   enough. The light becomes a manual sign rather than a sensor.
3. **Defer it, and record that as a decision.** The current condition then becomes
   deliberate instead of accidental.

**Recommend 1.** This repo is complete for its purpose, the contract is now proved by four
independent clients, and VCREC is the only remaining client that takes the person out of the
loop.

**If 3, write it down.** The current condition is invisible: everything reports success,
every test passes, and the light says `NO DATA`. That reads like a fault. It is not a fault.
It is an absent client.

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
