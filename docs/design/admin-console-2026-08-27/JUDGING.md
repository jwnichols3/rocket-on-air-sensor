# Judging: the admin console

Ticket [#52](https://github.com/jwnichols3/rocket-on-air-sensor/issues/52). Three prototypes
(`variants/*.html`), three judges on three lenses (a truthfulness skeptic, the daily user, the
engineer who has to ship it). Weights from `BRIEF.md`: truthful 5, frequent job 5, simple-is-
simple 4, scannable 4, buildable 3, handsome 2. Maximum possible is 230.

Every load-bearing claim below was re-checked against the source, not taken from a judge.
Where a judge was wrong, it is said so.

## 1. The weighted table

Mean of three judges, rounded.

| variant | truthful x5 | frequent x5 | simple x4 | scannable x4 | buildable x3 | handsome x2 | **total** |
|---|---|---|---|---|---|---|---|
| **A** command-first | 7.00 | 9.67 | 8.67 | 5.67 | 8.00 | 7.67 | **180.00** |
| **C** one-surface | 7.33 | 8.00 | 9.00 | 7.33 | 4.67 | 8.67 | **173.33** |
| **B** workbench | 6.00 | 6.00 | 4.00 | 9.00 | 7.00 | 7.33 | **147.67** |

**The judges were unanimous in prescription even where they split on rank.** All three
independently wrote some version of *ship A's shell, graft C's treatment and B's rail signal*.
That agreement, arrived at from three different lenses, is worth more than the 6.67-point gap
between A and C.

## 2. The winner: **A, command-first**, with two grafts

A wins the thing the brief weights highest twice over: **the frequent job costs one glance and
zero navigation.** The tally and the five chips are the first and biggest thing on screen, they
are byte-identical in both views, and they sit above every section - so setting a state never
involves travelling anywhere. It is the only variant where that is true.

### Graft 1: C's `treatment()` - the asymmetric busy rule

This is the single best idea produced by the bench and it is six lines.

A and B both handle stale evidence by **draining the row's colour toward the page background**.
C reasons about **which way the error is allowed to point**, and treats the two directions
differently:

- **calm + stale** -> withhold the colours entirely. Never paint a calm room on evidence that
  cannot support it.
- **busy + stale** -> keep the row's own colours, under a hatch. Draining a stale ON AIR
  toward grey **weakens a busy signal**, which is the one direction D-32 forbids.

A's drain is a real defect, not a preference. Judge 2 verified it in the light theme
(`shots/A-command-first__simple__light.png`): the withheld tally renders as a pale mint card
with AVAILABLE in large black type, and it reads calm from across the desk. That is exactly
what THE BUSY RULE exists to prevent.

### Graft 2: B's rail signal

B's navigation is the best of the three and answers complaints 1 and 6 outright: group headings
(Operate / Configure), `aria-current`, a per-section staged count, a `WITHHELD` dot on Status,
an `ENV` badge on Device connection, and a commit bar that breaks the total down by section
with a control that jumps to the first dirty one.

A's section strip carries no per-section signal, so its commit bar can say "1 change staged"
with nothing on screen saying where. Take B's signal column; A's strip is the right container
for it.

## 3. What each variant got wrong

Verified, not quoted.

**A** - four enabled, authoritative-looking fields (`#admin-pw`, `#net-port`, `#net-bind`,
`#net-pass`) have no listeners and no draft binding; typing in them and pressing Save discards
the input silently. The States section is under-built: no Add, no Delete, no Undo, no
consequence modal, no `order` or `description` field. Its facts list says `Stale threshold
300s`; `server/src/state.ts:61` says `STALE_AFTER_S = 90`. All are prototype incompleteness
rather than design error, but they are what has to be re-imported from today's `app.js`.

**B** - two truthfulness breaks, both verified live. `setState()` assigns
`STATUS.confirmed = id` in the same tick as the write, so the page claims the light confirmed a
state the instant you click - the evidence-vs-intent conflation D-32 exists to prevent. And its
chips are built from `draft.states`, so an unsaved staged rename is painted onto the buttons
that command the server. Its simple view is also advanced-minus-two-rail-items, which its own
notes concede.

**C** - two DOM trees, rendered in parallel by `fillList()`, so an open editor is instantiated
twice and emits duplicate element ids; the advanced tree's `<label for>` resolves to the hidden
simple tree's input. That is a permanent structural tax on every future control. Its shell also
carries `value="10.42.12.77"` as literal markup, which D-35 forbids.

## 4. Where I disagree with the judges

**C's simple view scored 9, 9 and 10 on "simple is simple". That is too generous.** It is
visually calm, but it is textually heavy: `shots/C-one-surface__simple__dark.png` shows three
paragraphs of prose above the controls, including a rendered citation of D-32 and its
threshold. Rocket's words were *"No extra text around it"*. C is the handsomest artifact here
and the most explanatory, and the second of those is not a virtue in simple view. The judges
scored the calm, not the word count.

**A also ships prose in simple view** - a line explaining which sections are hidden and why.
Same fault, smaller. Neither survives into the build.

## 5. One thing the bench found in shipped code

Not about any prototype. A's author separated build-once from mark-on-poll for its chips
specifically to avoid the DOM-swap bug, and a judge reading it against `admin-ui/src/app.js`
noticed **the shipped console still has that bug on its state buttons.** `refreshStatus()`
calls `renderStatus()` every five seconds; `renderStatus()` clears `#status-controls` and
rebuilds every state button. The comment two lines above it describes this exact defect and
guards only `renderRows()`.

Verified in the source, filed as [#54](https://github.com/jwnichols3/rocket-on-air-sensor/issues/54).
The fix landed on the rare job and left the frequent one exposed.
