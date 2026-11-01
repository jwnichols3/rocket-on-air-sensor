# Several Macs reporting calls, one light

Design, 2026-11-01. Status: **accepted (D-152), built.**

## Problem

Rocket wants a small menu-bar sensor on any of his Macs that reports when he is in a Zoom
call. The sensor is a separate project and a client of this API (D-30). It will run on
several Macs at once.

The Receiver cannot support that today. Every valid write is applied and no `source` outranks
another (§3 LAST WRITE WINS, D-126). The Receiver keeps no memory of who is in a call. So:

1. Mac A joins Zoom and writes `on-air`.
2. Mac B joins the same call and writes `on-air`. That is idempotent and fine.
3. Mac B leaves and writes `available`. **The light goes calm while Mac A is still in the
   call.** That is a false OFF, the failure §3 says is worst.

Rocket's rule, 2026-11-01: *"the state should remain on-air until all computers exit zoom."*

A second requirement from the same conversation: Rocket sometimes changes the light by hand
during a call, to `interruptible` or `recording`. The end of the call must not overwrite that.

The sensor cannot implement either rule alone. Mac B does not know that Mac A is in a call,
and no Mac knows whether a person changed the light. Only the Receiver sees every writer, so
the rule has to live here.

## What is not reopened

- **D-30.** The sensor stays outside this repo. This design adds wire surface that any
  detector can use. Nothing in this repo names the sensor.
- **D-126.** `PUT /state` stays last-write-wins. Claims are a separate resource. They do not
  add precedence to state writes and do not refuse any write.
- **D-90.** The writer makes its write stick. A sensor reports, reads back, and retries
  until confirmed.
- **D-91.** The Receiver does not decide anything from a clock. See "Stale claims".
- **THE BUSY RULE** (D-32). Unchanged.

## Design

### 1. The call claim

A **call claim** says that one sensor currently sees Rocket in a call. The Receiver holds a set
of claims, keyed by a sensor id.

```
PUT /calls/{sensorId}
{ "inCall": true, "source": "auto:zoom-studio" }
```

- `sensorId` uses the same grammar as a row id: `^[a-z0-9][a-z0-9-]{0,31}$`. The sensor
  generates it once at install and keeps it. It must be stable across relaunch and reboot,
  and unique per Mac.
- `inCall` is a boolean and is required. It states the sensor's whole truth, not a delta. A
  repeat is idempotent.
- `source` follows §4 and is required and prefixed, as on `PUT /state`.
- The route is passphrase-gated, like every other write.
- `inCall: false` for a sensor with no claim is a no-op and returns `200`. A sensor can
  therefore report "not in a call" at launch without effect on anything.

The response is the `GET /status` body plus a `calls` array (section 4), so the sensor can
confirm its own claim from the same answer.

### 2. What a claim change does to the state

The Receiver computes this inside `writeChain`, the queue every write already goes through.
Two reports that arrive together are therefore applied in order. This is the same reason
`POST /cycle` computes its successor on the server.

| Claim set before | Report | Claim set after | State write |
|---|---|---|---|
| empty | `inCall: true` | 1 claim | Write the **call row** (default `on-air`), **unless the current state is already `busy`**. |
| 1 or more | `inCall: true` | same or 1 more | None. |
| 2 or more | `inCall: false` | 1 or more | None. **This is the multi-Mac rule.** |
| 1 | `inCall: false` | empty | Write the **calm row** (default `available`), **only if the call mechanism wrote the current state** (below). |
| any | `inCall: false`, no claim held | unchanged | None. |

**"The call mechanism wrote the current state".** The Receiver keeps one boolean beside the
state, `stateFromCalls`. It is set when the first claim writes the call row. Any other state
write clears it, through any route and from any source. At the last claim's end:

- `stateFromCalls` is true: nobody touched the light during the call, so it goes to the calm
  row.
- `stateFromCalls` is false: a person or another writer changed the light during the call.
  Their choice stands and the end of the call writes nothing.

This gives Rocket's rule: set `interruptible` or `recording` during a call and it stays after
the call. It also covers a call that starts while the state is already `busy`, such as
`recording` set by hand before joining. The first claim does not write, so the flag stays
false, and the end of the call does not overwrite `recording` either.

**The call row and calm row are the `/on` and `/off` shortcuts.** `shortcuts.on` (seeded
`on-air`) and `shortcuts.off` (seeded `available`) already mean "the row for on" and "the row for
off", so claims resolve through them rather than through two new keys (changed at build time,
2026-11-01: one setting, not two). If either is unset or names a row that no longer exists, the
claim is still recorded and the state write is skipped. That is the same fail-closed rule as
§5's unknown id: a typo never renders calm. The log says why.

**State writes made by claims** carry the reporting sensor's `source`, so `/status` still says
who put the light where it is.

### 3. Persistence

The claim set persists with the state file and is restored on restart. If it did not persist,
a Receiver restart during Mac A's call would forget A's claim. Mac B's next end would then
find an empty set and turn the light calm with A still in the call.

`stateFromCalls` persists for the same reason.

### 4. Visibility

- `GET /status` gains `calls`: an array of `{ sensorId, source, since, lastReportAt }`.
  Additive. Older clients ignore it. `lastReportAt` is a fact, in D-91's sense: the server
  reports it and never branches on it.
- `GET /admin/health` lists the claims. A **Clear** button in the admin console is a follow-up;
  until then `DELETE /calls/{sensorId}` does it.
- `DELETE /calls/{sensorId}` clears one claim. It is passphrase-gated. Clearing the last claim
  follows the same table as `inCall: false`.

### 5. Stale claims - decided: option A (D-152)

A Mac can disappear mid-call: it sleeps with the lid closed, leaves the LAN, crashes, or is
switched off. Its claim stays, and the light stays ON.

**Option A, chosen: the sensor clears its own claim.** The Receiver has no timer. The
sensor reports its full truth at launch, at full wake (D-055's gate), when the network comes
back, and on every transition. A sleeping laptop clears its claim when it next wakes on the
LAN. A Mac that never returns leaves the light ON until Rocket clears the claim in the admin
console or the light is set by hand. That is a false ON, the lesser failure (§3), and the
console shows its cause.

**Option B, rejected: claims expire.** The sensor renews every 60 s during a call, and the Receiver drops
a claim not renewed for about 5 minutes. This heals itself, but it puts a clock back on the
Receiver, which D-91 removed on purpose. A network drop longer than the expiry would also turn
the light calm during a live call: a false OFF.

Rocket chose A on 2026-11-01 (D-152).

### 6. What a sensor must do

This goes in `docs/api-contract.md` and `docs/client-api-guide.md` when built.

- Write calls through `PUT /calls/{sensorId}`, never through `PUT /state`. A sensor that writes
  `available` through `PUT /state` at the end of its call bypasses the claim set and brings the
  false OFF back.
- Report `inCall: false` at launch and at full wake if not in a call. Report `inCall: true`
  again at launch if a call is already confirmed.
- Retry until the response's `calls` array confirms the claim (D-90). When off the LAN, drop
  the report. Do not queue it. The next transition or network return re-reports the truth.
- Any wait before ON, such as the 60 s dwell that absorbs Zoom reminder chimes, is the
  sensor's job. The Receiver applies a claim as soon as it arrives.

## Conflict with vcrec

vcrec drives the light through `PUT /state` today. Until vcrec moves to `PUT /calls`, its end
of call writes `available` directly and overrides an open claim. The rule in section 6 applies
to vcrec too. The options are to migrate vcrec to the claim route, or to switch off vcrec's
on-air output on any Mac that runs the new sensor. That is Rocket's call, and it is vcrec's
change, not this repo's. If needed, a hand-off prompt in the style of
`docs/vcrec-retire-the-pin-prompt.md` can follow.

## Tests to write first

- Two sensors in a call. One leaves: the state stays `on-air`. The other leaves: the state
  goes `available`.
- A human writes `interruptible` during a call. The last claim ends: the state stays
  `interruptible`.
- A human writes `recording` before any claim. A claim starts and ends: the state stays
  `recording`.
- A Receiver restart with one claim open, then a second sensor starts and ends: the state stays
  `on-air`.
- Concurrent `inCall: false` from the last two sensors, which `writeChain` serializes: exactly
  one calm write.
- `inCall: false` from an unknown sensor: no state write.
- `shortcuts.off` names a deleted row: the claim clears and the state does not go calm.
- `PUT /state` is unchanged. Every existing test passes unedited.
