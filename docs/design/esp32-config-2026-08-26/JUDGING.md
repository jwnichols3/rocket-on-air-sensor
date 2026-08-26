# Judging: the panel configuration page

Ticket [#50](https://github.com/jwnichols3/rocket-on-air-sensor/issues/50). Four prototypes
(`variants/*.html`), three judges, one synthesis. Weights from `BRIEF.md` §"What
user-friendly means here": truthful 5, consequence 4, scannable 4, small 3, buildable 3,
handsome 2. Maximum possible score is 210.

Every load-bearing claim below was checked against the firmware or the variant HTML, not
taken from a judge. Where a judge was wrong, it is said so and the source is cited.

---

## 1. The weighted table

Mean of the three judges' scores, rounded to two places.

| variant | truthful ×5 | consequence ×4 | scannable ×4 | small ×3 | buildable ×3 | handsome ×2 | **weighted total** |
|---|---|---|---|---|---|---|---|
| **B** master/detail | 6.33 | 7.33 | 8.67 | 9.33 | 8.00 | 8.00 | **163.67** |
| **C** overrides-first | 8.00 | 6.00 | 9.33 | 8.33 | 8.00 | 6.33 | **163.00** |
| **A** glass board | 9.00 | 9.67 | 6.00 | 2.67 | 5.00 | 8.33 | **147.33** |
| **D** live card | 4.33 | 5.67 | 5.00 | 3.33 | 5.00 | 8.00 | **105.33** |

Weighted contributions, for audit:

| variant | truthful | consequence | scannable | small | buildable | handsome | total |
|---|---|---|---|---|---|---|---|
| B | 31.67 | 29.33 | 34.67 | 28.00 | 24.00 | 16.00 | 163.67 |
| C | 40.00 | 24.00 | 37.33 | 25.00 | 24.00 | 12.67 | 163.00 |
| A | 45.00 | 38.67 | 24.00 | 8.00 | 15.00 | 16.67 | 147.33 |
| D | 21.67 | 22.67 | 20.00 | 10.00 | 15.00 | 16.00 | 105.33 |

**The judges split 2-1: B, B, C.** The arithmetic separates B from C by 0.67 points out of
210 - one judge moving one criterion by two points reverses it. Treat B and C as tied on
the numbers and decided on facts the numbers do not carry.

---

## 2. The winner: **B, master/detail** - conditional on the graft in §3

B wins the arithmetic by noise, and wins on a fact none of the three judges weighted
correctly: **it is the only entrant that makes the contiguous heap allocation smaller than
what already ships.** Measured, with CSS and JS moved to pool B where they cost no heap
(D-69): 1,814 B chrome + a 2,076 B editor emitted *once* + 353 B per row, so 24 rows is
~12.1 KB against today's ~20.9 KB. A wants 34-45 KB, D wants 27-34 KB, and C wants ~28.9 KB
in the all-overridden case and therefore forces `MAX_ROWS_RENDERED` from 24 down to 18 -
which `BRIEF.md` lists as an invariant that stays. On this device a failed `reserve()` under
`-fno-exceptions` is `abort()`, and `abort()` is the light going out mid-call. That is not a
style preference being traded against handsomeness; it is the same false-OFF failure the
whole system exists to prevent, arriving through the configuration page. B is the only
design that retires that risk instead of taking it on.

The structural reason B is cheap is worth stating because it is the thing to preserve in
implementation: **a row is a line, not a form.** All the cleverness - glass geometry, shape
glyphs, the `:has(input:placeholder-shown)` rule that flips each field's pill between
"follows server" and "overridden here" - lives in the once-only stylesheet, and the per-row
emission is one flat append with substitutions `config_page()` already holds. Nothing needs
a second request, nothing needs state the httpd task cannot legally reach, and `?edit=<id>`
needs no new plumbing because `getParam()` already falls through to `find_query_value_` for
query strings. It is also the best answer in the bench to "what is overridden on this
panel?" and the only variant that reflowed its primary surface on purpose for a phone
(`@media(max-width:44rem)`).

**But B is picked with a condition, not a compliment.** Its truthful mean of 6.33 is the
second-lowest in the bench on the criterion the brief puts above every other, and my own
checks make B's truthfulness *worse* than any judge scored it:

- **B gets `unknown` wrong at the data layer, not just in prose.** Its row carries
  `data-v="unknown|1|NO DATA|..."` - the `1` is busy - so opening that row renders a
  full-size solid block. `onair_table.h:600` short-circuits `key == "unknown"` to
  `Shape::NO_DATA` **before** the busy test. Worse: B's stylesheet has `.s0` (block), `.s1`
  (double frame) and `.s2` (ring) and **no hatch primitive at all**. B is structurally
  incapable of drawing the picture that row actually gets. Judge 3 called this "two narrow
  bugs, both cheap to fix"; it is not - it is a missing shape.
- **B's font model is wrong on every branch, not only the ring.** `.lb{font-size:20px}` and
  `.lg .lb{font-size:32px}` on a 2× glass are 10px and 16px effective, against the
  firmware's 11 / 14 / 30 (`elegoo-esp32.yaml:479-486`). Judge 3 caught only the ring and
  scored truthful 7; judge 1 caught the whole thing and scored 5. Judge 1 was right.
- **B's `data-v` pipe packing is corruptible.** Labels are 1-64 free-form characters from
  the server. A `|` in one splits the editor's values across fields and shows another row's
  data. Replace with separate `data-*` attributes; ~25 B/row.

C is the honourable runner-up and the source of most of the grafts. Its structural argument
is real - zero JS means no client recomputation can ever drift from what the server
rendered - and it was the only variant that read the display lambda instead of the brief.
It loses because its consequence score (6.00) is the criterion inverted: you type a hex and
see nothing until after you have saved it, and the SHAPE FLIP warning always describes the
already-saved state. And because on the live panel's actual state - **zero overrides** - C's
first render is "0 of 5 rows are overridden" with the entire editing surface folded behind
one `<details>` triangle, reachable via a radio button and a hex box placeholdered "follow".
That is progressive disclosure hiding the thing the operator came for.

A is the best preview in the bench and it is not close - the only variant that draws
`unknown` correctly, the only one font-exact on every branch, the only one that shows
UNKNOWN KEY, NO CONFIG and BUSY+STALE. It ranks third only because its bytes *are* its
design and cannot be cut without deleting it. D is last on merit: it spends its entire
visual budget rendering saturated colours a 1-bit glass can never draw, never draws the
glass at all, and its checkbox gate is a JS-only truth (see §5).

### Arithmetic vs judgement

**I am following the arithmetic, and the tie-break is mine.** B and C are 0.67 points
apart, which is not a result. I break the tie for B on the heap - the only criterion where a
wrong answer reboots the light - and because B's defects are fixable inside its own 353 B/row
line while C's central weakness (no consequence before the click) *is* its architecture.

Where I do override the panel is on how conditional that pick is. Two judges called B's
`unknown` error "narrow" and "not structural". It is structural: B has no hatch shape.
**B ships with A's glass emitter or it does not ship**, because the emitter is what makes
the error impossible rather than patched. See §3, graft 1.

---

## 3. What to graft from the runners-up

Byte figures are pool A (contiguous heap, per request) unless marked pool B (flash,
gzipped, immutable-cached, ~0 heap - D-69). Grafts 1-3 are ship conditions; the rest are
ranked improvements.

### Graft 1 (mandatory) - A's glass emitter, on every row

`<i class=g data-shape=N><b>LABEL</b><s></s></i>` - **≈62 B**, one `std::string` append,
zero per-shape branching in C++. Every primitive is a CSS `::before` keyed on
`[data-shape]`: the double frame is one 1px border plus a two-layer inset `box-shadow`
landing lit pixels at x=2..3/125..126 and y=2..3/45..46 (exactly `rectangle(2,2,124,44)`);
the open ring is a 7px border on a 44px circle at (42,2) (`filled_circle(64,24,22)` minus
`filled_circle(64,24,15)`); the hatch is a `repeating-linear-gradient` at the same 4px
pitch. **Pool B cost only.**

This is not a size trick, it is the correctness mechanism. `compute_view()` already returns
the `Shape` enum and **those enum values ARE the `data-shape` numbers** (branch 5 is skipped
deliberately for exactly this reason). The emitter writes the integer the firmware itself
computed, so the page never *decides* a shape and therefore cannot disagree with the glass.
Every variant that re-derived the shape got `unknown` wrong; the one that wrote the enum
through got it right. That is cause, not coincidence.

At 62 B a glass, B can afford one on **every** row instead of only the open one, which is
B's other real weakness and the whole of what it loses on "why does this row draw a ring and
that one a frame?". Cost to B: 353 → ~415 B/row, so 24 rows goes from ~12.1 KB to ~13.6 KB -
still ~7 KB *under* today's ~20.9 KB.

### Graft 2 (mandatory) - A's font map, verbatim

`.g b.lg{font:700 30px/1 …}` on shapes 0 and 1 when `strlen(label) <= 8`, 14px above, and
`.g[data-shape="2"] b{font:400 11px/1 …}` **unconditionally**, winning on source order.
**≈120 B pool B, ≈3 B pool A** (the `.lg` class token). Replaces B's 20/32px model, which is
wrong on every branch.

The 11px is not a style choice. `elegoo-esp32.yaml:660-663` hardcodes `id(status_text)` on
the CALM LIGHT branch and never calls `label_font()`. C found this by reading the lambda;
A implements it; `SAMPLE-DATA.md` states the rule as applying to every branch and is wrong.
It produces a real finding no prose could: an 11px `INTERRUPTIBLE` is ~75px wide against a
30px ring hole, so **the label really does collide with the ring on the glass**, and a
miniature that hides that collision is lying.

### Graft 3 (mandatory) - A's `--ip` / `--db` custom properties on `<body>`

The diagnostics band (`y=49` rule, `IP:` bottom-left, `<n>dBm` bottom-right) fed from two
custom properties set once per page instead of repeated inside every glass. **≈45 B once,
saves ≈30 B per glass** - at 24 glasses that is ~700 B recovered, which more than pays for
graft 1. C hardcodes `IP: 10.42.12.77` into each miniature and would pay it per row.

### Graft 4 - C's counting pass, in B's header line

"2 of 5 rows are overridden on this panel." **≈40 B.** All three judges named it the most
scannable sentence in the bench. The same single pass over the overlay - under the lock
`config_page()` already holds - hands `reserve()` an **exact** size instead of a worst-case
guess, which is the largest single heap win available on this page and costs one loop over
≤24 entries.

### Graft 5 - C's server-vs-panel miniature pair, on flipped rows only

A second `<i class=g>` beside the first, captioned `SERVER · lum 167` / `THIS PANEL · lum 96`.
**≈62 B + ≈90 B caption = ≈150 B**, emitted only on rows whose shape actually flipped (0 or
1 rows in practice, never more than the override count). Two judges independently called
this the clearest single artifact in the bench. It replaces B's flip *sentence* with a flip
*picture*, and B already renders the first of the two glasses.

### Graft 6 - C's PENDING wording

"PENDING - the panel is busy applying this and it may still be landing. **Nothing below is
confirmed until you Reload.**" **≈45 B**, replacing B's "reload in a moment to see the
result". C is the only variant whose banner says the page *body* is unconfirmed; A, B and D
all present the body as current fact while telling you to reload. Free truth.

### Graft 7 - C's undo label and placement

"Clear all overrides - put this panel back", as the first control, destructive-outlined in
red per the admin-console house style. **≈20 B** (label change; B already has the control in
its toolbar). This is the one task C answers in three seconds and every other variant
answers in twenty or more.

### Graft 8 - D's 128-threshold luminance track

The 0-255 rail with the 128 tick ruled across it and a marker at `left:NN.N%` computed from
the firmware's own integer. **≈75 B**, in the single editor block, **not per row**. Two
judges called it the best-drawn control and the best mechanism explanation in the bench - it
is the page's answer to the admin console's `6.39:1 AA` readout, which `BRIEF.md` explicitly
asks for. Render it inert-looking: **drop D's draggable-looking thumb**, which invites a drag
that does nothing.

### Graft 9 - A's three off-nominal pictures, behind a `<details>`

UNKNOWN KEY, NO CONFIG, and BUSY+STALE, drawn with the same emitter. **≈400 B, emitted once**
(three glasses plus captions), collapsed by default. These are the three pictures an
operator will one day be staring at with no idea what they mean, and A is the only variant
that shows them. With graft 1 in place they cost three integers.

### Keep from B, do not lose in the merge

- The struck-through luminance on rows where it is not consulted - `block <s>71</s>`. All
  three judges named it independently as the most elegant detail in the bench. ~9 B/row.
- The `:has(input:placeholder-shown)` per-field pill that flips between FOLLOWS SERVER and
  OVERRIDDEN HERE with **no JS**. Pool B.
- The `@media(max-width:44rem)` reflow. Pool B, and the only deliberate phone answer in the
  bench.
- The LOCAL rail down exactly the overridden rows.

### Do not graft

- **D's card-as-colour identity.** The dominant visual on a page about a 1-bit panel must
  not be a colour the panel cannot produce. A and C caption their chips "which this 1-bit
  glass cannot show"; D's cards carry no such caveat.
- **D's "ticking fills" behaviour** (`D-live-card.html:187`): ticking a field's checkbox
  copies the server's hex out of the placeholder into the named input, so the next Save pins
  what is presently the server's value as a permanent local override - the follow-the-server
  relationship destroyed by a click made in order to look at the picker. D's notes defend it
  ("without this the OVERRIDDEN badge would be a lie for one keystroke"); the cure is worse.
- **B's `data-v` pipe packing.** Separate `data-*` attributes, ~25 B/row.

---

## 4. What all four got wrong, and one nobody explored

### 4.1 The `unknown` row - and the bench data is the cause

`onair_table.h:598-601`:

```cpp
// THE BUSY RULE (D-32). ... `unknown` is the reserved landing row and never renders as anything.
if (key == "unknown" || (v.stale && !v.eff.row.busy)) { v.shape = Shape::NO_DATA; return v; }
if (v.eff.row.busy) { v.shape = Shape::BUSY; return v; }
```

The short-circuit is **before** the busy test. B, C and D all describe or draw that row as
the busy solid block. Only A draws the hatch.

**The root cause is `SAMPLE-DATA.md`, which is wrong.** Its table lists `unknown` as
`busy: yes` / `calm SHAPE: n/a - busy`, and its shape table gives no hint that the key is
special. Three of four prototypes inherited the brief's error - the same class of bench bug
as the luminance formula already corrected in `STATUS.md`, and it must be corrected the same
way, before implementation.

### 4.2 Nobody noticed the NO_DATA branch ignores the label entirely

`elegoo-esp32.yaml:627-629`:

```cpp
for (int x = 0; x < 128; x += 4) it.line(x, 0, x, 14, COLOR_ON);
it.printf(64, 26, id(status_title), COLOR_ON, TextAlign::CENTER, "NO DATA");
```

The glass prints the **literal string** `NO DATA`, not the row's label. So a label override
on the `unknown` row can never change anything the panel draws, in any circumstance. A came
closest ("Label and colour are stored and still travel with the row, but they never reach
this glass") but did not say the string is hardcoded, and A still renders that row's label
into the miniature - where it only happens to read correctly because the sample label *is*
`NO DATA`. Change the label to `FOO` in A and the miniature lies. The shipped page should
render the literal on that branch and mark the label field inert.

### 4.3 All four preview a *prediction*; the panel already records the *fact*

`id(render_branch)` (`elegoo-esp32.yaml:148`) is set as the last act of every branch of the
display lambda, and is already surfaced as a text sensor at line 516 via `shape_name()`. It
is what the panel **actually drew last frame**. Every variant instead re-derives the shape in
CSS or JS and calls the result a preview.

A page that prints `render_branch` is showing an observation, not a model, and it costs
**~30 bytes**. It cannot drift, because it is not a second copy of anything. It should sit
beside the current-state row: *"the panel is drawing the open ring right now"*. This is the
single cheapest truthfulness win available and nobody proposed it.

### 4.4 Nobody rendered the row cap announcing itself

`BRIEF.md` lists "`MAX_ROWS_RENDERED` (24) stays, **and keeps announcing itself when it
bounds**" as a hard invariant. All four state the cap in a footer sentence; none renders the
*bounded* state, the way all four were asked to render PENDING rather than describe it. It
is the same kind of forgotten branch and deserves the same treatment.

### 4.5 The possibility none of them explored: preview on the actual glass

The device owns a 128×64 display. A **"hold to preview on the panel"** control - one button,
~60 B of pool A, a staged write the main loop applies and reverts - is the only preview that
is *structurally incapable* of disagreeing with the firmware, because it **is** the firmware.
It makes every miniature in this bench a convenience rather than a claim, and it answers
brief defect #5 ("no preview of the actual glass") literally rather than by simulation.

It must be gated hard: never while the row is busy, time-boxed with an automatic revert, and
never while the current state is `on-air`. Blanking the panel mid-call is precisely the false
OFF the system exists to prevent - which is very likely why nobody proposed it. But no
variant *considered and rejected* it either, and the rejection is the interesting part.

---

## 5. Dissent worth recording

### 5.1 Judge 1 (SAFETY AND TRUTH), whose pick lost by 0.67 points - honour it

Judge 1 ranked C first and scored B truthful **5**, the lowest truthful score any judge gave
any variant except D. Its objection stands and my own verification strengthened it: every one
of B's safeguards is correct *today* and is a thing that must **stay** correct across every
future edit to two files that have already drifted twice - the luminance formula (corrected
in `STATUS.md`) and the CALM LIGHT font rule (still wrong in `SAMPLE-DATA.md`). C has no
script to keep correct, no picker to leave unnamed, no live preview to drift.

**Honoured by making graft 1 a ship condition rather than an improvement.** The emitter is
the answer to judge 1's objection in its own terms: it makes B's shape unable to drift
because B never decides it. Alongside it, the test C's own notes ask for -
*assert `compute_view()` and the page emit the same `Shape` for the same row* - becomes a
ship condition too, filling part of the "the page-generating C++ has no test" gap `STATUS.md`
already documents.

### 5.2 Judge 3 (THE FIRMWARE): the byte question is a safety question, not a size one

Judge 3's framing should survive into implementation even though it picked the winner:
`reserve()` failing under `-fno-exceptions` is `abort()`, and `abort()` is the light going
out mid-call. **Honoured** by making graft 4's exact counting pass mandatory - `reserve()`
gets a computed size, not a worst-case guess - and by carrying `STATUS.md`'s "Carry into the
implementation step" item 1: add the `debug:` component (`free`, `block`, `fragmentation`) in
the **same flash** as this redesign, so the 24.7 KB contiguous floor stops being the only
hard fact and becomes a measurement.

### 5.3 Judge 2 (THE PERSON AT THE DESK): C's undo, and the phone

Judge 2's task-timing found the one thing C does better than anything else in the bench: "I
changed something months ago, put it all back" is answered in three seconds because the `h1`
*is* the answer and the undo is the first control. **Honoured by grafts 4 and 7.** Its phone
verdict is also the only one grounded in a media query rather than in the page happening to
be narrow, and B won it on merit - keep the reflow.

### 5.4 A minority objection I am recording *against* the panel

Two judges made D's missing `<!-- NOTES -->` block its fatal flaw. That was true of the
judged artifact and is no longer true of the file: see §6. D still loses, and loses on
substance - colour-only identity, no glass anywhere, a JS-only checkbox gate, and the
ticking-fills pin. But "it shipped without notes" should not be the sentence that carries
the verdict, because it is now false, and a reader coming back to this file would find the
reasoning did not survive its own evidence.

---

## 6. Audit note: the judged artifact is not the current file

The four variants were **edited after the bench was measured and screenshotted**. The
judges, the screenshots in `shots/`, and `MEASURED.md` all describe commit `a130bb2`; the
working tree differs.

| | at judging (`a130bb2`) | now (working tree) |
|---|---|---|
| A | NOTES block present | present, reworked (+95/-74 lines) |
| B | NOTES block present | present, reworked (+87/-66) |
| C | **no NOTES block** | NOTES block added (+120 lines) |
| D | **no NOTES block** | NOTES block added, markup changed (+166/-37) |

Three consequences:

1. **`MEASURED.md` is now wrong** where it says "`C` and `D` did not ship one at all". It was
   right when written. It should be dated to `a130bb2` rather than corrected, so the bench
   stays auditable.
2. **C now renders a dormant override** (`presenting`, line 106; the `h1` reads "2 of 5 rows
   overridden on this panel, plus 1 dormant"). Judge 2's and judge 3's fatal flaws for C -
   both "no dormant override, a hard invariant" - were true of the judged file and are now
   stale. **C's own NOTES still say "Dormant overrides are not in this render"**, contradicting
   its own markup. If C's markup is mined for grafts, do not trust its notes.
3. **D's added NOTES overstate its no-JS safety.** They claim "Unticked sets `disabled` on
   both the text field and the picker". In the served markup the `<input type=color>` carries
   `disabled` but the named text input does **not** - `w.disabled=!k.checked` at line 163 is
   JavaScript-only. With JS off, typing into an unticked field still posts an override, and
   D's NO-JS section does not list this among what is lost. Judge 2 caught it; the new notes
   do not.

Everything in §§1-5 is judged against the artifact the panel actually saw. Nothing above
changes as a result of the later edits, because none of the later edits touched a defect the
verdict rests on.

---

## Appendix A: full scorecards, verbatim

Preserved so the reasoning is auditable later. Judge claims that verification contradicted
are marked in §2 and §4; the text below is unedited.

### Judge 1

**Lens.** SAFETY AND TRUTH - rank on the risk of a lie reaching the operator. A prettier page
that can lie loses to a plainer page that cannot.

**Ranking:** C > A > B > D  
**Pick:** C

| variant | truthful | consequence | scannable | small | handsome | buildable |
|---|---|---|---|---|---|---|
| A | 9 | 10 | 6 | 3 | 9 | 6 |
| B | 5 | 6 | 9 | 9 | 8 | 7 |
| C | 8 | 7 | 9 | 9 | 7 | 9 |
| D | 3 | 5 | 6 | 4 | 9 | 6 |

#### A - judge 1

The only variant that draws `unknown` as the NO DATA hatch (matching the `key == "unknown"`
short-circuit at onair_table.h:598) and the only one font-exact on every branch - its
`.g[data-shape="2"] b{font:...11px}` at line 59 beats `.g b.lg` on source order, which is
precisely what the CALM LIGHT branch does at elegoo-esp32.yaml:661; the picker carries no
`name` attribute so it is structurally incapable of posting, JS-on or JS-off; live redraw
uses `(299*r+587*g+114*b)/1000|0`, byte-identical to the firmware. Consequence is unmatched:
five 128x64 miniatures at the lambda's own coordinates with the y=49 diagnostics band, a
ghost of the server's own picture beside each override, and the three off-nominal pictures
(UNKNOWN KEY, NO CONFIG, BUSY+STALE) no other variant shows. Scannability is only fair - a
2-of-5 summary line and a blue rail, but five 300px tiles to sweep. It is by a distance the
largest page and it says so.

*Fatal flaw:* At MAX_ROWS_RENDERED=24 it projects ~31.7 KB of contiguous heap against a floor
proven only to ~24.7 KB, and a failed reserve() under -fno-exceptions is abort(). The config
page becoming the cause of the light going out mid-call is exactly the false OFF the whole
system exists to prevent. A declares this in its notes and names two ways down, but ships
neither.

#### B - judge 1

The colour trap is solved cleanly - `data-v="unknown|1|NO DATA|..."` feeds a text-only input
and the picker is created in JS with no name - but the same data-v is a hand-rolled pipe
packing that a `|` in a label corrupts, which B names as the one new failure mode it
introduces. Its `draw()` at line 197-201 rewrites the master row's colour chip to the value
you are typing while leaving that row's `ring 96` luminance column at the saved value, so a
list line can show saved and unsaved state mixed on one row. Font model is wrong twice over:
`.lb` 20px / `.lg` 32px at 2x scale is 10px/16px against the firmware's 11/14/30, applied on
every branch instead of only BUSY and CALM HEAVY. The list itself is the best answer to "what
is overridden here" on any of the four - chip in its own colours, LOCAL rail, busy column,
shape glyph and luminance with a strikethrough when not consulted - and at 353 B/row it is
the only variant comfortably inside the envelope (~12.1 KB at 24 rows, half of today's).

*Fatal flaw:* Opening the `unknown` row renders a full-size miniature of a solid block with
NO DATA knocked out of it. compute_view returns Shape::NO_DATA for that key unconditionally,
before the busy test, so the largest picture on the page is a picture the glass will never
draw - the exact 'preview that disagrees with the firmware' failure, and worse than showing
no preview.

#### C - judge 1

It eliminates categories of lie rather than executing them carefully: no `<script>` tag at all
so nothing can look functional and be inert; no `<input type=color>` anywhere so the trap is
never entered; swatches reflect the SAVED value only and the notes say so out loud. Its
PENDING banner is the only one that says the page body is unconfirmed - 'Nothing below is
confirmed until you Reload' - where A, B and D all say 'reload to see the result' while
presenting the body as current fact. It is the only variant that went and read the display
lambda and caught a real error in SAMPLE-DATA.md: label_font() is not applied on the CALM
LIGHT branch, which elegoo-esp32.yaml:661 confirms. The side-by-side SERVER lum 167 / THIS
PANEL lum 96 pair is the clearest single statement of the shape flip on any of the four.
Smallest markup at 5,574 B, 1,289 B of chrome against today's 3,148, 238 B per untouched row,
and the easiest C++ - one counting pass, two passes over the table, colour_field() survives
nearly as-is.

*Fatal flaw:* It tells the operator 'All three are busy... Busy draws the solid block with the
label knocked out', which is false for `unknown` - and because it deliberately gives busy rows
no miniature, 3 of 5 rows are described only in prose the page never draws. The operative
conclusion (a colour override changes nothing there) survives, so it is a wrong sentence
rather than a wrong picture, but it is the same error B and D make.

#### D - judge 1

The picker is correctly unnamed and `disabled`, and the checkbox is unnamed too, so nothing
can post #000000 - but line 184 undoes the good work by copying the server's hex out of the
placeholder into the named field the instant you tick the box. Every card is a saturated
colour block on a page about a 1-bit panel, and unlike A and C - which caption their colour
chips 'which this 1-bit glass cannot show' - the cards themselves carry no such caveat; the
page's dominant visual language is the one thing the glass cannot do. There is no 128x64
miniature anywhere, so brief defect #5 is untouched; the shape arrives as a 1.7rem glyph and
a sentence. The `unknown` card reads 'BUSY, solid block'. The read-only luminance meter is
drawn with a thumb that invites a drag that does nothing. Cards measure ~1,050 B against a
900 B budget, ~28.6 KB projected at 24 rows.

*Fatal flaw:* Ticking a field's checkbox writes the server's current hex into the named input,
so the next Save pins that value as a permanent local override of what is presently the
server's value - the follow-the-server relationship destroyed by a click made in order to look
at the picker. It is the colour trap entered through a different door, and D is the only
variant with no `<!-- NOTES -->` block, so it never states its colour-trap solution, never
measures its bytes, and never admits the 24-row overrun.

#### Judge 1 reasoning

Weighted arithmetic (truthful x5, consequence x4, scannable x4, small x3, handsome x2,
buildable x3): C 172, A 154, B 149, D 107. My lens does NOT override the arithmetic here - it
confirms it, and I want to say why rather than let the agreement look like a coincidence.

A is the better preview and it is not close. It is the only variant that gets `unknown`
right, the only one font-exact on all six branches, and the only one that shows UNKNOWN KEY,
NO CONFIG and BUSY+STALE - the three pictures an operator will one day be staring at with no
idea what they mean. If the criterion were 'shows the consequence', A wins outright with a 10.

But the lens asks which page is likeliest to put a lie in front of the operator, and A carries
risk C has designed out entirely. A has ~2 KB of JavaScript that re-derives every verdict on
the page; when it runs it is exact, and when it fails the page falls back to server-rendered
truth - A's no-JS story is genuinely clean. C has no such story to get right, because it has
no script. A has a colour picker that cannot post; C has no colour picker. A has a live
preview that could drift from the firmware on a future edit to either copy; C's swatches show
only what is saved and say so. Every one of A's safeguards is correct today and is a thing
that must stay correct across every future change to two files that have already drifted once
- SAMPLE-DATA.md's font rule is wrong about the ring branch, and C is the only variant that
noticed by reading elegoo-esp32.yaml:601-661 rather than trusting the brief.

Then the byte argument, which under this lens is a safety argument and not a size one. A
projects ~31.7 KB contiguous at 24 rows against a floor proven only to ~24.7 KB. reserve()
failing under -fno-exceptions is abort(), which is the panel rebooting and the light going out
mid-call. That is a false OFF caused by the configuration page. A declares it honestly and
names two mitigations, which is exactly the right behaviour, but a design that needs a heap
measurement before it can ship is a design I cannot rank first on safety. C's markup is 5,574
B, its chrome is 1,289 B against today's 3,148, and its one overrun case (24 rows all
overridden, ~28.9 KB) comes with a number already worked out: MAX_ROWS_RENDERED drops to 18.

C's real cost is honest and I am accepting it with eyes open: it shows consequence AFTER the
click, not before, on the brief's second-heaviest criterion. You can save a shape flip and
only be warned on the page you land on. Under this lens that trades correctly - a preview that
shows nothing is never a preview that lies, and C's saved-state miniatures are exact where
they exist.

B and D both lose on the same fact. B draws `unknown` as a full-size solid block with NO DATA
knocked out; D labels it 'BUSY, solid block'. B is the best table on the page and the only
variant comfortably inside the envelope, and its list line - chip, LOCAL rail, shape glyph,
luminance struck through when not consulted - is the thing I would steal if the pick were
about scanning. D is the handsomest and the least truthful: it paints a 1-bit device in
saturated colour without caveat, ships no miniature at all, converts follow-the-server into a
pinned override on a checkbox tick, and has no notes block in which to admit any of it.

#### Judge 1 best idea to graft

A's glass emitter, moved into C's zero-JS overrides-first frame - and extended to the rows C
currently leaves as prose.

A reduced the whole 1-bit panel to `<i class=g data-shape=N><b>LABEL</b><s></s></i>`, about 62
bytes and one std::string append, with every primitive living in pool-B CSS keyed off
`[data-shape]`: the double frame is one border plus a two-layer inset box-shadow, the open
ring is a 7px border on a 44px circle, the hatch is a repeating-linear-gradient, and the y=49
diagnostics band is an empty `<s>` fed by `--ip`/`--db` custom properties set once on `<body>`
instead of repeated per row. compute_view() already returns the Shape enum and those enum
values ARE the data-shape numbers, so the emitter writes the int straight in - there is no
per-shape branching in C++ at all. That is the cheapest possible way to buy the thing C is
weakest at, and it costs C nothing in JavaScript because the markup is static once rendered.

Graft it specifically onto the two places C is currently wrong or silent:

1. The `unknown` row. C's sentence 'Busy draws the solid block with the label knocked out' is
false there. A `data-shape=3` miniature on that pick-line replaces the sentence with the hatch
band the glass actually draws, and the error becomes structurally impossible - the shape comes
from the same enum the lambda switches on, so the two cannot disagree without the test C's own
notes ask for (assert both pick the same Shape for the same row) going red.

2. The busy rows generally. C omits their miniature on the reasoning that a picture would imply
colour is consulted. A answers that better: draw the block, knock the label out of it, and let
the CSS-content note say colour gets no vote here. The picture that shows the label knocked out
of solid ink is a stronger statement that colour is irrelevant than the absence of a picture is.

Two smaller pieces worth taking in the same move. A's `--ip`/`--db` trick, because C hardcodes
'IP: 10.42.12.77' into every miniature and would pay it per row. And A's font mapping verbatim
- 30px bold at strlen<=8 on the BUSY and CALM HEAVY branches only, 14px above, 11px
unconditionally on CALM LIGHT - because C's stylesheet has only two sizes and has no way to
draw a short label on the heavy frame, which the firmware renders at 30px.

One thing from B is worth a line too: the struck-through luminance number (`block <s>71</s>`)
on rows where luminance is not consulted. It shows the value and cancels it in the same glyph,
which is a more honest readout than either printing it plainly or hiding it.

---

### Judge 2

**Lens.** THE PERSON AT THE DESK - one person, occasionally, who has forgotten everything
since last time, standing at the panel with a phone. Judged on three timed tasks (recolour one
state; find and undo what I changed months ago; understand why one state draws a ring and
another a frame) answered without reading prose, plus explicit phone verdict. Hard on
scroll-to-build-a-mental-model, hard on paragraphs where a picture belongs, hard on disclosure
that hides the thing the operator came for.

**Ranking:** B > C > A > D  
**Pick:** B

| variant | truthful | consequence | scannable | small | handsome | buildable |
|---|---|---|---|---|---|---|
| A | 9 | 9 | 6 | 3 | 7 | 5 |
| B | 7 | 8 | 8 | 9 | 8 | 8 |
| C | 7 | 7 | 9 | 8 | 6 | 7 |
| D | 4 | 6 | 4 | 3 | 8 | 4 |

#### A - judge 2

TRUTHFUL 9: the only variant that renders `unknown` correctly - onair_table.h:600 makes
`key == "unknown"` fall to Shape::NO_DATA (hatch band), not the busy solid block, and A alone
emits data-shape=3 and says outright that label and colour never reach that glass; it is also
the only one besides C to get the CALM LIGHT font right (11px, because elegoo-esp32.yaml:660
hardcodes id(status_text) and skips label_font()), it carries the diagnostics band, all three
banner classes, an explicit dormant slot even when empty, and no colour picker anywhere carries
a name attribute. CONSEQUENCE 9: five real 128x64 glasses, a luminance bar with the 128 line
under each, a ghost of the server's own picture beside the changed row, and a live amber 'this
override crosses the 128 line' warning - nothing else in the set shows the before-picture and
the after-picture of the same row. SCANNABLE 6: the summary sentence names exactly which rows
and which fields ('available (label), interruptible (background)'), but the board itself is
~3,300px of 660px cards and OVERRIDDEN HERE is a small pill on each. SMALL 3: 10,743 B of
pool-A markup measured here, ~1,150 B/row, projecting to ~31.7 KB at 24 rows against a 24 KB
ceiling - the heaviest in the set, though it names the overage, two ways down, and the heap
measurement it needs. HANDSOME 7: the board of real glasses is the strongest single idea in the
bakeoff, but five dense cards plus a 3-up/2-up grid with a hole in it is busy. BUILDABLE 5: the
glass is a 62-byte append and the Shape enum values ARE the data-shape numbers, which is
genuinely elegant, but every server value gets written twice (attribute mirror plus
placeholder), the ghost glass is a second emit, and it cannot ship until someone measures
heap_caps_get_largest_free_block(). PHONE: works - auto-fill collapses to one column and the
260px glass fits 390px - but the person standing at the panel scrolls ~3,300px, and 'Clear all
overrides' is at the very bottom of it.

*Fatal flaw:* Byte cost. ~31.7 KB projected at MAX_ROWS_RENDERED=24 needs a reserve() near 34
KB contiguous against a floor only proven to 24.7 KB, on a device where a failed malloc calls
abort() and the light goes out mid-call. A design that must be measured before it can ship is
not the one to ship.

#### B - judge 2

TRUTHFUL 7: strong almost everywhere - LOCAL rails, per-field FOLLOWS SERVER / OVERRIDDEN HERE
pills driven by :has(input:placeholder-shown) so they stay correct with JS off, busy rendered
read-only, a real dormant row (DEEP WORK) with Clear and no editor, all three banner classes,
no `<input type=color>` in the served HTML at all, and it deliberately keeps the label crossing
the open ring because the glass really does that. Docked for one row: line 153 claims `unknown`
draws 'block 26', but the firmware sends that key to the NO_DATA hatch, so the page shows a
picture the panel will not draw and implies that row's colour is consulted when it never is.
CONSEQUENCE 8: the open row gets a live 128x64 glass, a luminance readout, and the flip
sentence naming #e8a317/167 vs #3b5bdb/96; the closed rows get 'ring 96 was heavy' with the old
luminance struck through, which is a lot of consequence for 353 bytes - but only one row is ever
a picture. SCANNABLE 8: five lines, one screen, no scroll; chip-as-identity from the admin
console, LOCAL rail down the left of exactly the two overridden rows, and shape+luminance in
their own column. SMALL 9: 6,087 B markup measured, 353 B/row against today's 738, editor
emitted once - 24 rows projects to ~12.1 KB against today's ~20.9 KB. It is the only variant
that makes the heap situation strictly better in every case with no invariant traded away.
HANDSOME 8: crisp and dense, and the struck-through stale luminance is the most elegant single
detail in the bakeoff. BUILDABLE 8: a row is one flat append with six substitutions
config_page() already holds, and ?edit= needs no new plumbing because getParam() already falls
through to find_query_value_ for query strings; three hard parts named honestly, with the
pipe-packed data-v attribute the one genuinely new failure mode, and it only affects the JS
path. PHONE: best in the set and the only one with a real reflow of its primary surface -
@media(max-width:44rem) drops the table header, regrids to four columns, stacks the editor and
caps the preview at 256px.

*Fatal flaw:* It gets the `unknown` row's shape wrong (block, not the NO_DATA hatch), and there
is no per-row picture - 'show me all five glasses' is answered by a glyph and a number. Both are
fixable inside the existing 353 B/row line; neither is structural.

#### C - judge 2

TRUTHFUL 7: zero JS means the page can never render a preview that disagrees with what is
actually saved, which is a real structural advantage, and C did the best homework in the set -
it caught that SAMPLE-DATA.md's font rule is wrong for the ring (label_font() is applied on the
BUSY and CALM_HEAVY branches only; CALM_LIGHT hardcodes 11px at elegoo-esp32.yaml:660) and
followed the lambda instead of the brief. Against that: it repeats the `unknown` error ('all
three are busy... busy draws the solid block'), it renders no dormant override at all despite
that being a hard invariant (its notes admit this and say a reviewer should ask), it defines
only one banner style so APPLIED and FAILED are undemonstrated, and it requires
MAX_ROWS_RENDERED to drop 24→18, which the brief lists as an invariant that stays. CONSEQUENCE
7: the SERVER lum 167 / THIS PANEL lum 96 miniature pair under the flipped row is the single
clearest artifact in the whole bakeoff - but every consequence here is post-hoc. You type a hex
and see nothing until you have already saved it, which is precisely the criterion inverted, and
its own notes call this the biggest sacrifice. SCANNABLE 9: 'CLEAR ALL OVERRIDES - PUT THIS
PANEL BACK' is the first control on the page and the h1 is the answer to the question. Nothing
beats it. SMALL 8: 5,540 B markup, the lightest, and cost scales with overrides not rows -
~3.2 KB on the live panel's actual 0-override state against today's 6.8 KB - but 24
all-overridden projects to ~28.9 KB, over the ceiling, which is what forces the row-cap
regression. HANDSOME 6: calm and honest, but the .f3 field row is cramped and the collapsed
section reads as an unfinished page. BUILDABLE 7: drops the inline `<style>`, one counting pass,
two passes over the same table; five hard parts named, of which the real one is that the
miniature is a second copy of the display lambda that can silently drift. PHONE: works by
accident of narrowness rather than design - no media query at all, and at 390px the .f3 grid
(1fr 7.5rem 7.5rem) leaves about 100px for the label input.

*Fatal flaw:* The live panel has zero overrides today, so C's real first render is 'ZERO of 5
rows are overridden' with the page's entire editing surface folded behind one `<details>`
triangle, reachable only via a radio button, a shared hex box placeholdered 'follow', and no
preview. That is the disclosure hiding exactly the thing the operator came for, on the device's
actual current state.

#### D - judge 2

TRUTHFUL 4: the dominant visual on the page - a full-bleed red ON AIR card, a purple RECORDING
card - is a colour this 1-bit glass can never produce, presented at card scale as the row's
identity, and there is no 128x64 miniature anywhere to correct it. It repeats the
`unknown`-is-a-solid-block error. It defines only .pn (amber PENDING); there is no
failed/applied class and, critically, no `<!-- NOTES -->` block at all, so the brief's required
statements of byte cost, colour-trap solution, no-JS degradation and C++ cost were never
written. And the checkbox gate is a JS-only truth: the served markup leaves every text input
enabled and the checkboxes unnamed, so with JS off 'tick a field to override it' is false - an
unticked field that gets typed into still posts an override. CONSEQUENCE 6: the 128-threshold
luminance slider is the best-drawn control in the bakeoff and the best mechanism explanation of
why luminance picks the shape, and the flip note names both hex values and both luminances -
but the SHAPE itself is only ever asserted in words plus a 12px glyph, never drawn. SCANNABLE
4: '2 of 5 rows are overridden' is stated, then you scroll ~1,700px through five tall cards to
learn which, reading a low-contrast OVERRIDDEN pill against a saturated card. SMALL 3: 8,960 B
markup measured, 1,045-1,292 B per form, projecting to roughly 29 KB at 24 rows - over the
ceiling, and with no notes, unacknowledged. HANDSOME 8: much the most striking page here; the
colour is what makes it beautiful and is the same thing that makes it untruthful. BUILDABLE 4:
second-heaviest per row, every card carries an inline style="--c:...;--b:...", seventeen colour
inputs, and the checkbox gate has no server-side representation at all - plus nobody has thought
through the C++ cost, because the notes block that would have forced that does not exist. PHONE:
works (@media(max-width:38rem) stacks the colour pair, minmax(0,1fr) prevents overflow), but it
is a long scroll on a phone and 'Clear all overrides' sits at the very bottom, below the dormant
section.

*Fatal flaw:* It paints the page in colours the panel cannot show while never once drawing the
panel, and it shipped without the NOTES block the brief requires - so the colour-trap solution,
the byte cost and the JS-off behaviour are all undeclared, and the JS-off behaviour is in fact
wrong.

#### Judge 2 reasoning

Weighted arithmetic (truthful 5, consequence 4, scannable 4, small 3, handsome 2, buildable 3):
B 166, C 156, A 143, D 97. My lens sharpens that result rather than overriding it - I am NOT
overriding the arithmetic.

Walking the three tasks:

1. "INTERRUPTIBLE is orange, I want it blue here." B ~15s: the whole panel is one screen, click
the row, it expands in place, pick blue in the swatch, the glass and the flip sentence update,
Save. A ~20s (find the card among five 660px cards, then the best feedback in the set). D ~20s
(scroll, tick BACKGROUND first - an extra concept - then pick). C ~60s and this is the one that
breaks it: on the live panel's actual state (zero overrides) every editable row is behind a
`<details>` triangle, and reaching one costs a disclosure, a radio button, a hand-typed hex into
a box placeholdered "follow", and no preview or flip warning until after the POST. That is the
disclosure hiding the thing the operator came for.

2. "I changed something months ago. Put it all back." C 3s and unbeatable - the h1 IS the answer
and "Clear all overrides - put this panel back" is the first control. B ~5s and nearly as good:
LOCAL rails down exactly the two changed rows, and Clear all overrides in the top toolbar. A
names them in a sentence but buries the undo 3,300px down. D states the count and then makes you
scroll to learn which, with the undo at the very bottom.

3. "Why does available draw a thin ring but interruptible a thick frame?" A wins outright - two
real glasses side by side plus a luminance bar with the 128 line. C's SERVER/THIS PANEL
miniature pair is the clearest single artifact anywhere in the bakeoff, but only exists on
flipped rows. D's threshold slider is the best mechanism but never draws the glass. B answers
with a glyph, a number, and a struck-through old value - weaker, and the one place B genuinely
loses.

Phone: B is the only variant that reflowed its primary surface on purpose
(@media(max-width:44rem) drops the table header, regrids to four columns, stacks the editor,
caps the preview at 256px). A and D both work but demand 1,700-3,300px of scrolling with the
undo at the bottom - bad for someone standing at the panel. C works only by being narrow
already; it has no media query and its three-field row leaves ~100px for the label input at
390px.

The deciding facts beyond the tasks: B is the only design that improves the heap situation in
every case without trading an invariant (353 B/row vs today's 738; ~12.1 KB at 24 rows vs
today's ~20.9 KB). A and D both blow the 24 KB ceiling. C only fits by dropping
MAX_ROWS_RENDERED from 24 to 18, which the brief lists as an invariant that stays, and C also
renders no dormant override at all - another hard invariant.

B's two real defects are both local, not structural: it claims `unknown` draws the busy solid
block when onair_table.h:600 sends that key to the NO_DATA hatch, and only the open row gets a
picture. Both fit inside the existing 353 B/row line. Every other candidate's worst problem is
architectural.

D I would not ship. It is the handsomest page here and the least truthful one: it paints five
cards in colours the 1-bit glass can never draw, never draws the glass, and shipped with no
NOTES block - so its byte cost, colour-trap solution and JS-off behaviour are undeclared, and
the JS-off behaviour is in fact wrong (the checkbox gate exists only in JS, so an unticked field
that gets typed into still posts an override).

#### Judge 2 best idea to graft

A's glass emitter: `<i class=g data-shape=N><b>LABEL</b><s></s></i>` - ~62 bytes, one append,
with every shape primitive living as a ::before on [data-shape] in the pool-B stylesheet, and
the IP/dBm strings injected once per page as --ip/--db custom properties on `<body>` instead of
once per glass.

Graft it into B for three reasons, in order:

1. It is a correctness mechanism, not just a size trick. compute_view() already returns the
Shape enum and those enum values ARE the branch numbers, so the emitter writes the int the
firmware itself computed. B's miniature currently re-derives the shape and gets `unknown` wrong;
A's cannot, because it never decides. That closes B's only truthfulness hole structurally rather
than by patching one row.

2. At 62 bytes a glass, B can afford a miniature on EVERY row instead of only the open one,
which is B's other real weakness and the whole of what it loses on task 3 ("why a ring here and
a frame there?"). All five pictures, side by side, at roughly 300 bytes total of pool A.

3. Take A's CSS with it, including `.g[data-shape="2"] b{font:400 11px/1 ...}`. That 11px is not
a style choice - elegoo-esp32.yaml:660 hardcodes id(status_text) on the CALM_LIGHT branch and
skips label_font() entirely, which is why INTERRUPTIBLE really does collide with the ring on the
real glass. SAMPLE-DATA.md's font rule is wrong about this; C found it, A implements it, and
whoever builds this must read the lambda, not the brief.

Second, cheaper graft: C's server-vs-panel miniature PAIR under a row whose shape flipped. B
already renders one glass plus a flip sentence; adding the server's own picture beside it
replaces the sentence with a picture for ~200 extra bytes, and only on rows that actually
flipped.

---

### Judge 3

**Lens.** THE FIRMWARE - I have to emit this from C++ into one contiguous std::string, where a
failed reserve() is abort() and abort() drops the light mid-call. I judged per-row emitted bytes
at MAX_ROWS_RENDERED=24 (not the 5-row prototype), how much cleverness sits in once-only pool-B
chrome versus per-row pool-A markup, and whether any of it needs state the httpd task cannot
legally reach.

**Ranking:** B > C > A > D  
**Pick:** B

| variant | truthful | consequence | scannable | small | handsome | buildable |
|---|---|---|---|---|---|---|
| A | 9 | 10 | 6 | 2 | 9 | 4 |
| B | 7 | 8 | 9 | 10 | 8 | 9 |
| C | 9 | 4 | 10 | 8 | 6 | 8 |
| D | 6 | 6 | 5 | 3 | 7 | 5 |

#### A - judge 3

Truthful 9: the colour picker carries NO name attribute, so it is structurally incapable of
posting #000000 with JS on or off, and an invalid hex dims the glass and says 'nothing will be
saved' rather than previewing a lie; it also gets the CALM LIGHT 11px rule right by CSS
specificity (.g[data-shape="2"] b at line 59 beats .g b.lg at line 46). Consequence 10: the
128x64 glass is drawn full size at the firmware's own pixel coordinates, redraws as you type,
and puts a ghost of the server's own picture beside it - nothing else in the bench is close.
Scannable 6: a summary sentence names the two overrides but each card is ~600px tall, so five
rows is already a two-screen board. Small 2: measured 3,046 B chrome + 1,291-1,755 B per row,
projecting to 34-45 KB at 24 rows against a heap floor only proven to 24.7 KB. Handsome 9: the
board of glass panes is the most memorable thing here and reads instantly as a device. Buildable
4: the glass emitter itself is genuinely cheap (~62 B, one append, zero per-shape branching, the
Shape enum value written straight in as data-shape), but every server value is emitted twice as
a data-* mirror plus a placeholder, the ghost is a second emitter call, and the byte problem
forces a cap change.

*Fatal flaw:* The bytes are the design, so they cannot be cut without deleting the idea. At 24
rows this needs a reserve() of 34-45 KB - 40-90% over the ceiling the device is proven to
survive. Its own notes propose either cutting MAX_ROWS_RENDERED (which the brief lists as an
invariant) or emitting the editor for only the first N rows, which makes rows 14-24 uneditable
and breaks the page's second stated job.

#### B - judge 3

Truthful 7: the colour trap is solved twice over - no `<input type=color>` exists in the served
HTML at all, and the JS-created one is deliberately unnamed - and the struck-through luminance on
busy rows (`<s>71</s>`) is the most elegant 'this number exists but is not consulted' in the
bench; docked for two real defects below. Consequence 8: live glass, live luminance, live flip
sentence, and the collapsed row's chip updates as you type, but only for the one open row.
Scannable 9: one line per row with a LOCAL badge and an accent rail, plus a dedicated GLASS SHAPE
column carrying 'ring 96 was heavy' - one look answers the question and it still holds at 24 rows.
Small 10: measured 1,784 B chrome + 2,076 B editor emitted ONCE + 353 B avg per row = ~12.3 KB at
24 rows, against today's ~20.9 KB; it is the only entrant that makes the contiguous allocation
smaller than what already ships. Handsome 8: restrained and dense, closest to the admin-console
house style the brief cites as the only real evidence of preference. Buildable 9: a row is one
flat append with six substitutions the emitter already holds, all glass geometry lives in pool-B
CSS so C++ picks one of three class names, and I verified getParam() falls through to
find_query_value_ for URL query strings, so ?edit= needs no new plumbing.

*Fatal flaw:* Two narrow bugs, both cheap to fix and neither structural. (1) The ring font rule is
wrong: .lg sets 32px with no shape-2 override, so opening `available` draws FREE at 16px effective
inside a ring where the panel draws it at 11px - a preview disagreeing with the glass, which is
the one sin the brief names. Two lines of pool-B CSS. (2) data-v packs eight fields
pipe-delimited, so a server label containing '|' corrupts the split and the editor shows another
row's values; labels are 1-64 free-form chars from the server, so this is reachable. Use a
delimiter that cannot appear, or separate data attributes.

#### C - judge 3

Truthful 9: zero JS means there is no client-side recomputation that can ever drift from what the
server rendered, and it is the only entrant that read the display lambda instead of the brief -
correctly finding that CALM LIGHT hardcodes id(status_text) at 11px and never calls label_font(),
which I verified at elegoo-esp32.yaml and in the font block (huge 30 / title 14 / text 11). It
also refuses to draw a miniature for busy rows because colour is not consulted there, and a
picture would imply it is. Consequence 4: this is the criterion inverted - type a hex and nothing
happens; the SHAPE FLIP warning always describes the already-saved state, so you can save a flip
and only be warned on the page you land on. Scannable 10: the answer is the h1, literally - '2 of
5 rows are overridden on this panel' - then only those two, in full. Small 8: 1,303 B chrome and
238 B per untouched row gives ~7.8 KB at 24 rows with no overrides, but ~32.5 KB if all 24 are
overridden. Handsome 6: plain and text-heavy, though the side-by-side SERVER vs THIS PANEL
miniature pair is the single best explanation of the flip anywhere in the bench. Buildable 8:
cheapest per-row emission of the four, colour_field() survives nearly as-is, and the counting pass
it already needs for the h1 hands you an exact reserve() instead of a worst-case guess.

*Fatal flaw:* Dormant overrides are simply not rendered - a hard invariant, and the one case the
design most needed to prove, since its entire organising principle is 'group by override state'.
It says where they would go and asks a reviewer to demand it, which is honest but is not the
deliverable. Compounding it, cost scales with overrides rather than rows, and a single contiguous
reserve() cannot be sized on the optimistic case, so the pathological 24-overridden page still
forces MAX_ROWS_RENDERED down to 18.

#### D - judge 3

Truthful 6: the colour trap is well solved with two independent guards (the type=color input is
both `disabled` in the served HTML and unnamed, so the named text field is the only thing that can
post), the dormant STANDBY row carries the best explanation in the bench, and busy rows read 'not
consulted'; but the dominant visual on every card is a saturated colour the 1-bit glass can never
draw, and the page has no glass miniature at all. Consequence 6: colour and luminance are live and
genuinely excellent, but SHAPE - the most surprising thing this page controls - is a 27x16px glyph
and a sentence. Scannable 5: colour is spent on row identity, so it cannot also mark override;
five equally loud cards compete and the OVERRIDDEN badge has to fight them. Small 3: measured
2,994 B chrome + ~1,100 B per row = ~29 KB at 24 rows, worst case 34 KB, over the ceiling without
a picture of the glass to show for it. Handsome 7: bold and confident, but the shipped render has
'BACKGROUND' colliding with its swatch on every card and grey hex placeholders that are unreadable
on the red and purple cards. Buildable 5: 1,100 B/row of nested grid divs with color-mix()
throughout, three near-identical .f blocks per row each needing checked-state derived from
has_label/has_color/has_bgcolor.

*Fatal flaw:* No `<!-- NOTES -->` block at all - the one per-variation deliverable the brief spells
out, including the requirement that any design touching a native colour picker must SAY how it
solves the trap. It does solve it, but never states it, so there is no measured byte cost, no C++
estimate and no declared trade-off to check. Separately, the luminance meter renders as a slider
with a draggable-looking knob and is inert, and `style=margin:1.3rem_0_.55rem` uses underscores for
spaces so the declaration silently does nothing.

#### Judge 3 reasoning

Weighted arithmetic: B 176, C 161, A 145, D 112. My lens confirms it rather than overriding it, so
I am not invoking the override clause.

The deciding fact is that B is the only entrant that makes the contiguous allocation SMALLER than
what already ships. Measured on the prototypes with CSS/JS moved to pool B: B is 1,784 B chrome + a
2,076 B editor emitted ONCE + 353 B per row, so 24 rows is ~12.3 KB against today's ~20.9 KB, and
reserve() can drop from 3000+24*900 to roughly 4500+24*400. A wants 34-45 KB, D wants 29-34 KB, and
C wants 32.5 KB in the all-overridden case. Every one of those asks me to raise a single contiguous
malloc against a heap floor that is only proven to 24.7 KB, on a device whose failure mode is the
light going out in the middle of a call. That is not a style preference I can trade away against
handsomeness.

B also passes the structural test the lens actually cares about: a row is a LINE, not a form. All
the cleverness - the glass geometry, the shape glyphs, the :has(input:placeholder-shown) rule that
flips each field's pill between 'follows server' and 'overridden here' - lives in the once-only
stylesheet, and the per-row emission is one flat append with six substitutions config_page()
already holds. Nothing needs a second request, nothing needs state the httpd task lacks, and no
handler has to touch an ESPHome component API. I verified the one claim its no-JS path depends on:
getParam() falls through to find_query_value_ for URL query strings, so ?edit=<id> needs no new
plumbing.

What B loses on is truthfulness (weight 5), and I want to be explicit that I did not let the byte
win paper over it. Its ring font is wrong and its data-v packing can be corrupted by a '|' in a
server label. Both are real. Both are also two-line fixes that cost zero pool-A bytes. Contrast
that with A, whose problem is not a bug at all - 1,300-1,750 B/row is what the design IS, and you
cannot shrink it without deleting the picture that makes it worth having. C's omission is likewise
not a bug: dormant overrides are the case its own organising principle most needed to prove, and it
did not.

A is the one I most regret ranking third. It scores a 10 on consequence and it is the handsomest
thing here by a distance. If the heap floor were ever measured well above 24.7 KB it would deserve
another look - and STATUS.md already carries adding the debug: component on the same flash as this
work, so that number is cheap to get.

D is last on merit, not on style. It is missing the mandated notes block, so there is no declared
byte cost or C++ estimate to check, and it is the only design whose central metaphor works against
the page's first job: it spends its whole visual budget rendering colours the 1-bit panel will
never show, and has no glass miniature anywhere.

#### Judge 3 best idea to graft

C's discovery that the CALM LIGHT branch hardcodes id(status_text) (11px) for every label and never
calls label_font(). I verified it: elegoo-esp32.yaml's ring branch is `it.printf(64, 24,
id(status_text), ...)` with no size decision, while the BUSY and CALM HEAVY branches both go
through label_font() (status_huge 30 at strlen<=8, status_title 14 above). SAMPLE-DATA.md states
the rule as applying to every branch, which is wrong, and three of the four prototypes inherited
the error - including B, the winner. This is not a design idea, it is a correctness fact that must
be carried into the implementation, asserted in a test, and corrected in SAMPLE-DATA.md the same
way the luminance formula already was. It also produces a genuine finding neither prose nor the
brief could: an 11px INTERRUPTIBLE is ~75px wide against a 30px ring hole, so the label really does
collide with the ring on the glass, and a miniature that hides that collision is lying.

Two smaller grafts worth naming, both free:
1. A's glass encoding - `<i class=g data-shape=N><b>LABEL</b><s></s></i>`, ~62 bytes, with every
shape primitive as a CSS ::before on [data-shape] and the IP/dBm strings injected once per page as
--ip/--db custom properties on `<body>` rather than repeated per row. B's miniature is currently six
fixed divs; A's is one element plus one integer, and that integer is already the Shape enum value
compute_view() returns. Strictly better and it shrinks B's editor block.
2. C's counting pass in B's header line. '2 of 5 rows are overridden on this panel' is the most
scannable sentence in the bench, costs ~40 bytes, and the same pass gives you an exact reserve()
instead of a worst-case guess.

---

## Appendix B: facts verified for this synthesis

| claim | verdict | source |
|---|---|---|
| `unknown` short-circuits to `Shape::NO_DATA` before the busy test | **true** | `firmware/configs/onair_table.h:598-601` |
| `SAMPLE-DATA.md` lists `unknown` as busy / "n/a - busy" | **true - the brief is wrong** | `SAMPLE-DATA.md` row table |
| CALM LIGHT hardcodes `id(status_text)` and never calls `label_font()` | **true** | `elegoo-esp32.yaml:660-663` |
| fonts are huge 30 / title 14 / text 11 | **true** | `elegoo-esp32.yaml:479-486` |
| NO_DATA prints the literal `"NO DATA"`, never the row's label | **true - nobody noticed** | `elegoo-esp32.yaml:627-629` |
| A is font-exact: `.g[data-shape="2"] b` forces 11px, shape-2 rows carry no `.lg` | **true** | `A-glass-board.html:46,59,131,167` |
| B carries `data-v="unknown\|1\|NO DATA\|…"` - busy=1 | **true** | `B-master-detail.html:152` |
| B has no hatch primitive - only `.s0`, `.s1`, `.s2` exist | **true - worse than judged** | `B-master-detail.html:73-79` |
| B's fonts are 20px/32px on a 2× glass = 10/16 effective | **true - wrong on every branch** | `B-master-detail.html:77-78` |
| C still says "All three are busy… Busy draws the solid block" | **true, in the current file** | `C-overrides-first.html`, `<details>` block |
| D line 187 copies the placeholder into the named field on tick | **true** | `D-live-card.html:187` |
| D's named text inputs are NOT `disabled` in served markup | **true - JS-only gate** | `D-live-card.html:94-96` vs `:163` |
| `id(render_branch)` records the branch actually drawn | **true, already a text sensor** | `elegoo-esp32.yaml:148, 516, 612-662` |
| C and D shipped no NOTES block | **true at `a130bb2`, false now** | `git show a130bb2:…` vs working tree |
