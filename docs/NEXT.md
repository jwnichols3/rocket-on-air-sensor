# Next steps

Written 2026-08-26 as a cold-start handoff. Two items. Everything else on the board is
cheaper to defer.

---

## 1. #44 - Companion module  (agent work, biggest remaining piece)

**Start here.** `gh issue view 44` is written to be executed from a cold start and carries
every measured fact - environment, procedure names, the tRPC call script. Do not rediscover
any of it. This file only says what the ticket cannot: why now, and what is perishable.

### Why now rather than later

The working reference on `rocket-clawd` is a **live Companion install**, not a recorded
artifact. The recipe in the ticket was verified against it, including the full chain observed
as rendered pixels (D-67). Every day it sits, it drifts - someone restarts Companion, a
module updates, a connection is edited.

### Verify the reference is still intact BEFORE trusting the ticket

```sh
ssh -f -N -L 18000:127.0.0.1:8000 john@rocket-clawd     # admin UI is loopback-only
# then, with the call.mjs from the ticket:
node call.mjs query appInfo.version
node call.mjs query instances.connections            # expect `onair` and `onairhttp`
```

Expected, as left on 2026-08-25:

| | |
|---|---|
| modules | `generic-websocket` 2.3.1, `generic-http` 2.5.0 |
| connections | `onair` (`gdRgmqj7yyLg-bXZPMS7T`), `onairhttp` (`yN8PtDPkCyoi5vKNbq5GA`) |
| control | `bank:Dzr7LBc59fWW2RmO0ayEP`, page 1 / row 0 / col 0 |
| that control carries | `websocket_variable` feedback, `internal:variable_value` colour feedback, a `post` action on the `down` set |

If any of that is gone, rebuild it from the ticket before writing module code - it is the
only proof the transport works end to end.

### The four facts that cost the most to learn

1. **The REST API is a decoy.** `/api/connections` answers; almost nothing else does. The
   control plane is **tRPC over a WebSocket at `/trpc`**.
2. **tRPC inputs are RAW, not superjson-wrapped.** A `{"json": ...}` wrapper is *accepted* by
   procedures that ignore their input and *rejected* by every typed one - so the first wrong
   guess looks like it worked. This is the hour-eater.
3. **Option values take an ExpressionOrValue wrapper:** `{"value": X, "isExpression": false}`.
   `setOption` does **not** validate option ids, so a wrong id returns `true` and does
   nothing.
4. **`replaceStyleOverride` is NOT needed.** `entities.add` runs
   `ConvertBooleanFeedbackStyleToOverrides` itself and returns the entity already carrying
   `box0.color`/`text0.color`. The feedback's `variable` option takes a **bare** name
   (`onair:intended`), not `$(...)`.

Two more, smaller: `hotPressControl` takes `location`, not `controlId`; and
`newType: "button"` silently creates nothing - the literal is `button-layered`.

### Cross-host is the stricter case, and it is the real one

The D-24 loopback waiver does **not** apply from `rocket-clawd`, so the passphrase is
mandatory rather than incidental. Verified: `/status` → 401, `/public/status` → 200,
`/events/ws` without a passphrase → 401.

### Scope reminder

Rocket's own framing: *"mostly so we get an idea of how companion modules work."* It is a
learning exercise as much as a feature. Presets regenerating from the server's state table is
the point; a polished module is not.

### Housekeeping

`companion-module/` is already an npm workspace (D-28/D-37), so `npm run verify` will pick it
up. Close the SSH tunnel when done.

---

## 2. #18 - SwiftBar  (Rocket only, ~30 seconds)

**The only thing on the board blocked on a human, and a shipped feature is doing nothing
until it happens.**

State as of 2026-08-26: SwiftBar is **not running** and has **no plugin folder set**
(`defaults read com.ameba.SwiftBar PluginDirectory` → does not exist). The plugin itself is
in place:

```
~/SwiftBarPlugins/onair.5s.sh -> <repo>/deploy/swiftbar/onair.5s.sh
```

**What Rocket does:** launch SwiftBar, and when it asks where to load plugins from, choose
`~/SwiftBarPlugins` - *not* `~/Documents`, which is what triggered the earlier permission
prompt.

The sudoers rule it depends on is already installed (`/etc/sudoers.d/onair`, D-63), so
`onair restart` works from the menu bar without a TTY.

Once it is running, verify the menu bar shows the current state and that a click writes one.
Then close #18.

---

## Deliberately not next

- **#49** - intermittent `403` vs `401` in the server test suite, `needs-info`. Has not
  recurred. Chasing an intermittent without a deterministic repro is the worst-value item on
  the board.
- **More test hardening.** The class-coverage check added in D-74 could be extended to the
  config page. Worth doing, not worth doing first.

## The gap that is not a ticket

**Nothing writes state automatically.** The last write is routinely hours old, so the panel
correctly shows `NO DATA` most of the time - THE BUSY RULE refusing to claim calm on stale
evidence. All the infrastructure exists: server, panel, menu bar, and soon Companion. None of
it decides *when* to be on air.

D-30 put the detector out of this repo deliberately and that is not being reopened here. The
open question is **where it lives**, and right now that is implicitly deferred rather than
decided. It is the gap between "the parts work" and "the thing works", and it deserves a
decision rather than continued silence.
