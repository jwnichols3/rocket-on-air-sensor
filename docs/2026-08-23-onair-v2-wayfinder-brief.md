# Wayfinder brief: On-Air v2 (configurable states, macOS admin, Companion module)

**Source:** walking voice memo, 2026-08-23, 13 min.
Transcript: `~/code/rocket-walk-talk/transcripts/2026-08-23-rocket-on-air-wayfinder/raw.txt`
Ambiguities resolved with Rocket in session, 2026-08-23. Every quote below is verbatim
from that transcript.

---

## The loose idea

Rocket On Air grows from a fixed three-rung on-air light into a **configurable
presence system with a macOS-native control surface and a Bitfocus Companion
integration**. Three moves, in his words:

1. **The states stop being hard-coded.** A user-editable table of states, each with an
   ID, a phrase sent on the wire, a background colour, a font colour, and a description.
   "0 would be available, 1 would be on-air, 2 would be interruptible, 3 would be
   recording" is now just the *default seed*, extensible to "0, 1, 2, 3, 4, blah, blah,
   blah all the way up to whatever."
2. **The server becomes a macOS-centric product**, not a bare daemon: background
   service + menu bar + a config web UI reachable locally without a login and remotely
   with one.
3. **The ESP32 gets its own config page**, with a choice between taking config from the
   server (centralised) and overriding it locally (custom).
4. **Companion gets a real module**, sideloaded, with presets that regenerate from the
   server's state table.

He is explicit that this memo is a partial reconstruction: *"I just walked for over an
hour and did two amazing walk-in' talks"* (Whisper for "walk and talks") *"...I will just
tell you now that I'm not going to be as thorough as I was."* And at the end: *"there's way more than this than that."*
**Treat gaps as fog, not as scope boundaries.**

---

## Standing ruling: this memo supersedes

Rocket's instruction, confirmed in session:

> "we've built a bunch of this already and I've just asked a bunch of questions about
> passwords and user IDs and stuff like that so I don't want to acknowledge that but I
> want to take this input as the new direction."

**Reading (confirmed): do not re-litigate.** Where this memo conflicts with a recorded
decision in `CONTEXT.md`, the memo wins and the old decision gets superseded or amended
in the `## Decisions` section. Do not re-open settled questions to ask him again.

Two exceptions he chose deliberately in session, listed under "Decisions that survive".

---

## What changes, by component

### 1. State model: from ladder to table

**This is the largest change and it breaks two existing decisions.**

Today (D-18): three rungs on a **ladder**, `available < interruptible < dnd`, where the
ordering is load-bearing. **Hold** (D-19) is a persisted *floor* on `level`: the detector
may raise above it, never lower below it. `intended` (on/off) is a projection of position
on that ladder.

The memo asks for an arbitrary, user-extensible set of states. Rocket's own list puts
`interruptible` (2) *above* `on-air` (1), which is backwards for a ladder.

**Resolved in session: the state ID is an unordered enum, not a ladder rung.** It is a
key, not a rank.

Direct consequences that need designing, not just extending:

- **D-19's hold-as-floor loses its meaning.** Rocket's steer: it probably becomes
  **hold-as-pin** - the held state is exact, and the detector cannot change it at all
  until released. Needs a decision ticket.
- **D-18's `intended` projection** (`available` -> `off`, anything else -> `on`) has no
  automatic definition over arbitrary states. Either every state row carries an explicit
  on/off flag, or the projection goes away. Needs a decision ticket.
- **Renumbering and deletion.** What happens to a device pinned to state 3 when state 3
  is deleted or renumbered? Needs a decision ticket.

State row schema as described:

| Field | Rocket's words |
|---|---|
| State ID | "0, 1, 2, 3, 4... all the way up to whatever" |
| Phrase | "the word or phrase that would be sent with the state, we will understand what that means" |
| Background colour | "a set of options for background color" |
| Font colour | "and font color" |
| Description | "and then a description" |

Editing model: per-row **save or cancel**, then a **master save** that applies. Confirmed
in session as a **staged-edit model** - row edits build a draft, nothing reaches the live
service until the overall save. Needs a dirty indicator.

Defaults: "take the defaults I just listed and make those the defaults for the whole
thing" - seed the table with available / on-air / interruptible / recording.

### 2. Server-side: three components

Confirmed in session as **background service + menu bar + config web UI**.

> "I want to make this a macOS centric solution, so we have a service running in the
> background, we have a tool bar thing that we can click on and open up the standard kind
> of toolbar-based things like about, configuration, exit, reload, relaunch"

"Tool bar thing" is the macOS **menu bar**. **D-26 stands** (confirmed in session): it
remains a **SwiftBar plugin**, not a native app. About / configuration / exit / reload /
relaunch render as menu lines that shell out. No Swift build, sign, or notarize pipeline.

### 3. Config surface

Server-level settings, in his order:

- **Network interface** - "I want to pick the network interface this is listening to or
  sending and receiving on... whatever network interfaces are available that would accept
  IP traffic. I'm sure there is a process in which you can filter out any of the noise
  from the network interfaces." (Filtering heuristic is undecided: loopback? link-local?
  down interfaces? VPN tunnels?)
- **Port number**
- **Passphrase** - see auth below

### 4. Auth model

Three credentials appear in the memo. Resolved in session:

- **The passphrase replaces `ONAIR_TOKEN`.** Same role - the machine-to-machine
  credential that ESP32, Companion, and the detector present - but renamed and made
  **UI-configurable** instead of env-var-only. **Supersedes D-7 and D-23.**
- **A separate admin user and password** gates the human-facing admin UI.
  Default user `rocket`, default password `ESP32`, **literally as spoken** (his call,
  made with the exposure explained). Ship a change-me nag on first login; do not force it.
- **Reset** returns both to those defaults. Available **both** as a factory-reset button
  in the admin UI *and* as the natural result of a clean install.

**D-24 survives, by Rocket's explicit choice.** He asked for "if I'm doing it locally, I
don't want to have to do the user ID password", and pre-authorised the fallback: *"If you
find yourself twisted up about this and it's just really hard, fine, I'll enter the
password and user ID, okay? That's fine."* In session he chose neither extreme: **keep
D-24's Origin check**. Loopback plus a valid `Origin` gets into admin with no prompt;
anything else demands the login. He types no password at home, and a hostile local page
still cannot get in.

Admin page contents, as described: **state configuration**, plus **admin settings** =
user ID and password ("I'd like to be able to change that or add a new one" - note the
plural, multi-user is possible fog), network interface, and port.

Unauthenticated landing page: *"if I go to my IP address, colon, port... it's going to
give me a status. Is it active? What's it currently sending out? And then it's going to
give me an option to log in."*

### 5. ESP32 config page

A web UI served **by the ESP32 itself**, at the device's own IP. Shape mirrors the server:
title, current state if connected, admin login button.

Behind the login: **which server, which port, which passphrase**, then a two-way choice:

- **Auto** - "you're going to take whatever's been defined on the server and that's what
  you're going to implement, and if the server changes you change - that way it's
  centralised configuration."
- **Custom** - the same state table, locally overridable, with a **refresh** button that
  pulls the server's table down as a starting point: "you can say refresh, and it will
  refresh from server, and it'll just download the server, and then you can override and
  you can save it out."

**Resolved in session: propagation is PULL, not push.** The ESP32 polls the server for
config on an interval and on boot. The server stays stateless about devices - no
registry, no reachability requirement, no retry logic. Matches how the device already
polls `GET /status` (D-17). "If the server changes you change" happens within one poll
interval.

Open: the poll interval, and whether config polling shares a request with state polling.

### 6. Bitfocus Companion, two phases

**Phase 1 - generic connection.** *"if we have a REST API, we use the REST transport, if
we have an HTTP API, we use the HTTP transport... we put in all the different things so
that we can set the state, and then we can get feedback so that the button color and any
of the feedback on the button can change."*

Note: **D-11 already built `GET /events/ws`** specifically for Companion's
generic-websocket module, and `docs/companion-setup.md` documents the wiring.
**Resolved in session: verify what actually still works before building anything.** The
move from a fixed three-rung ladder to an arbitrary state table very likely breaks the
existing feedback configuration. This is a verification ticket, not a build ticket.

**Phase 2 - a real module.** Rocket's framing, expanded in session:

> "the companion module will be a side card to start with, so I don't want to have to
> submit this upstream or whatever, but I want to go through the whole process of the
> companion development cycle"

"Side card" is **sidecar / sideloaded**. His clarification, verbatim from the session:

> "Sidecar (sideloaded?) if that is an option - Mostly so we get an idea of how companion
> modules work. And I'm making a big assumption that we can do a side-loaded or sidecar
> module where we don't have to commit it somewhere. We can add it to a running companion
> instance as a new module. I think this was a feature that was added as part of companion
> four. And it should be researched. Each module can have a set of presets. I would like
> for the presets that get defined in the system to be dynamically regenerated. And maybe
> that's variables we can use, uh, feedback, things like that. So that's a bit of a
> research to see how the pre-defined buttons and predefined variables are set inside of
> a companion module."

**This is a research ticket before it is a build ticket.** Two questions, both explicitly
flagged by him as assumptions:

1. Can Companion 4 sideload a module into a running instance without upstream submission?
2. How are presets, variables, and feedbacks declared inside a module - and can presets
   be **dynamically regenerated** from a live server-side state table, rather than
   declared statically at module load?

The motive matters for scoping, and it is from his session clarification above, not the
memo: *"mostly so we get an idea of how companion modules work."* This is a learning
exercise as much as a feature.

End goal: *"pre-configured buttons which I can drag on there, which automatically refresh
based on the server's configuration, and then I can drag onto my Stream Deck."*

---

## Resolved, no ticket needed

**The REST question is answered.** Rocket asked, and flagged it as garbled himself:

> "Are we doing REST currently? Are we doing straight HTTP puts and gets? Which one's
> better? Can we do both?... A lot of twists and turns there on those phrases, so take a
> moment and decipher that as you put the action item together."

Deciphered: **the fork is not a fork.** REST *is* HTTP verbs on resources. And both
shapes already exist in `docs/api-contract.md`:

| Shape | Exists today |
|---|---|
| REST / JSON | `PUT /state` - canonical, idempotent |
| Bare verbs, no body | `POST /on`, `/off`, `/available`, `/interruptible`, `/dnd` |
| Read | `GET /status` |
| Push | `GET /events` (SSE), `GET /events/ws` (WebSocket, D-11) |

The two real questions hiding inside it - which shape device clients use as primary, and
poll vs push for the ESP32 - were both raised and **Rocket chose to record the answer
rather than spawn research**. Poll stays (see ESP32 section). No research ticket.

---

## Decisions that survive this memo

Explicitly confirmed in session, despite the standing ruling above:

- **D-24** - Origin-checked local admin, no loopback-only bypass.
- **D-26** - menu bar is a SwiftBar plugin, not a native app.
- **D-17** - device polls over plain HTTP.

## Decisions this memo supersedes or amends

| Decision | Fate |
|---|---|
| **D-7** optional shared bearer token via `ONAIR_TOKEN` env var | Superseded - becomes the UI-configurable **passphrase** |
| **D-23** `ONAIR_TOKEN` set on this host | Superseded - same |
| **D-18** three-rung ladder `available < interruptible < dnd` | Superseded - arbitrary unordered state table |
| **D-19** hold as a **floor** on `level` | Broken by the above - needs redesign, likely hold-as-**pin** |
| **D-5** API contract v1 state model | Amended - `level`/`intended` semantics change with the state table |
| **D-27** one token, not a read/write split | Carried forward onto the passphrase, unchanged in spirit |
| **D-11** WebSocket for Companion | Intact, but its **feedback wiring** needs re-verification |

---

## Not yet specified (fog)

- **Hold semantics over an unordered state table.** Floor is meaningless; pin is the
  likely answer but undecided, and interacts with detector behaviour.
- **`intended` on/off projection** over arbitrary states. Per-row flag, or delete the
  concept.
- **State lifecycle**: renumbering, deletion, and what a device pinned to a deleted state
  does.
- **Network interface filtering heuristic** - which interfaces are "noise".
- **Multi-user admin.** "I'd like to be able to change that or add a new one" implies more
  than one credential. Unclear whether he wants real multi-user or just editability.
- **Colour representation.** Hex? Named palette? The mono SH1106 OLED cannot render
  colour at all (D-20 defers the colour lamp), so what a colour field *means* on today's
  hardware is undecided.
- **Config poll interval** on the ESP32, and whether it shares a request with state polls.
- **Detector integration.** The memo never mentions it. The detector still has to map
  Zoom/Meet call state onto a now-arbitrary state table, and the sensing mechanism is
  still an open question in `CONTEXT.md`.
- **Migration.** There is a live, accepted, running system (D-22). Nothing in the memo
  says what happens to it during this change.
- **Everything from the two lost walks.** "There's way more than this than that."

## Out of scope

- **Upstream submission of the Companion module to Bitfocus.** Explicitly ruled out for
  now: "I don't want to have to submit this upstream or whatever."
- **Native macOS menu bar app.** D-26 confirmed to stand.
- **Recovering the 53-minute recording** at
  `~/code/rocket-walk-talk/audio/2026-08-23-rocket-on-air-pt1.m4a`. Rocket declined
  transcription in session. Noted here because it is almost certainly one of the two
  lost walks and remains recoverable if he changes his mind.
