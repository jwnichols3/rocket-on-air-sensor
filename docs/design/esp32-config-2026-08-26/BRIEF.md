# Design brief: the panel configuration page

Ticket [#50](https://github.com/jwnichols3/rocket-on-air-sensor/issues/50). Read
`SAMPLE-DATA.md` for the exact rows to render, and
`docs/research/2026-08-26-esp32-web-ui-envelope.md` for the byte and technique budget.

## What the page is for

One person, occasionally, at their desk, changing how THIS panel draws a state that the
server already defines. Not an admin console. Not a dashboard. The whole job is:

1. See what the panel will draw for each state, without going and looking at the panel.
2. Change the look of one state on this panel only.
3. Understand that the change is local, and that the server still owns the rest.
4. Put it back.

## What is wrong with it today

See `shots/00-before.png`. Concretely, and these are the things a variation is judged on:

1. **Five identical stacked forms, ~2100 px tall.** Nothing distinguishes one row from the
   next except the text inside it. There is no overview.
2. **The same 2-line note is repeated five times** ("Blank follows the server...").
3. **Colour is shown as a hex string in a text box.** No swatch, no picker, no preview.
   The one thing the page exists to edit is the one thing it does not show.
4. **The 1-bit consequence is buried in prose at the top.** Whether a calm row draws the
   heavy double frame or the open ring is the most surprising thing this page controls,
   and it is a sentence the reader has already scrolled past by the time they edit a
   colour.
5. **No preview of the actual glass.** The panel is a 128x64 1-bit OLED. The page never
   shows what that looks like.
6. **Override vs server-default is a 10px badge.** The most important state in the whole
   page is nearly invisible.
7. **Prose-heavy header** before anything actionable.
8. **Save is per row, with no indication of whether anything is unsaved.**

## The wire contract - DO NOT CHANGE IT

The POST handler is not being rewritten. Any prototype must submit exactly this:

| field | values |
|---|---|
| `action` | `save` \| `clear` \| `clearall` \| `refresh` |
| `id` | the row id, required for `save` and `clear` |
| `label` | 1-64 chars, or **absent/empty to follow the server** |
| `color` | `#rrggbb` strictly, or **absent/empty to follow the server** |
| `bgcolor` | `#rrggbb` strictly, or **absent/empty to follow the server** |
| `busy` | **must never be sent.** The handler REFUSES any POST carrying it. |

Method is `POST` to `/onair/config`, `application/x-www-form-urlencoded`. Response is a
full HTML page: `400` on failure, `200` otherwise.

### The trap in this contract

**"Empty means follow the server" and `<input type="color">` are incompatible.** A native
colour input always has a value; it has no empty state and defaults to `#000000`. Dropping
one in naively turns "follow the server" into "override to black" the moment anyone saves a
row. Any variation that uses a native colour picker MUST solve this explicitly - an
override toggle that gates the field, a paired reset control, a hidden text input that the
picker writes into and that a Clear control blanks - and must SAY how in its notes.

## Hard invariants

- Presentation only: `label`, `color`, `bgcolor`. `busy` and row membership are the
  server's (D-32, THE BUSY RULE). No control may imply otherwise.
- The three banner outcomes stay: APPLIED, FAILED, **PENDING**. PENDING is amber and says
  the change may still be landing. Never collapse it into success or failure.
- `MAX_ROWS_RENDERED` (24) stays, and keeps announcing itself when it bounds.
- Dormant overrides - an override whose row the server has since removed - stay visible.
- Auth stays the browser's own credential prompt. No login form, no cookie, no session.
- No external assets: no CDN, no web font, no remote image. Everything inline.
- The page is built into one contiguous `std::string` in C++ and sent whole. Every byte is
  a byte of ESP32 heap.

## What "user-friendly" means here, in order of weight

1. **Truthful.** A page that looks calm about something the panel is not is worse than the
   ugly page. This beats every other consideration.
2. **Shows the consequence before the click**, not after: the colour, the contrast, the
   SHAPE the 1-bit glass will draw, and whether the row is following the server.
3. **Scannable.** The answer to "what is overridden on this panel?" should take one look.
4. **Small.** Bytes are heap, and heap exhaustion reboots the light.
5. **Handsome.** Last, but it is on the list - Rocket called the current page inelegant and
   that is a real defect in a page a person is meant to use.

## Deliverable per variation

A single standalone `.html` file, no external requests, that:

- renders the exact rows in `SAMPLE-DATA.md`, including the two overrides,
- shows the PENDING banner,
- is honest about what is server-owned,
- works with JavaScript disabled **or** states plainly in its notes what degrades and why
  that is acceptable,
- ends with a `<!-- NOTES ... -->` comment block covering: the concept in two sentences,
  the byte cost (HTML + CSS + JS, measured), how it solves the colour-input trap, what it
  gives up, and how hard it is to generate from C++ string concatenation.

## The earlier description: it does not exist

Rocket said he thought he had described what he wanted this page to look like. Fourteen of
his messages across every past session in this repo mention the config page; none of them
describes its appearance. A search for aesthetic language ("look like", "elegant", "mock up",
"wireframe", "user-friendly") across the same transcripts returns nothing about this page
either.

So there is no brief to recover, and none is invented here. What follows is the nearest real
evidence: the house style already shipped on the sibling surface.

## House style, from the admin console

`shots/01-admin-states-for-reference.png` is the state list from the admin console at
`http://localhost:8484/`. It is the same five rows, edited by the same person, one surface
away. Its choices are the closest thing to a stated preference that exists:

- **The row's own colours are the identifier.** A chip drawn in `color` on `bgcolor`, with
  the label in it. Not a swatch beside a name - the name IS the swatch. Reading it takes no
  legend.
- **The id sits next to it in monospace, muted.** Machine identity and human identity are
  both present and are visibly different kinds of thing.
- **A measured contrast ratio is shown per row** (`6.39:1 AA`), in green when it passes. The
  console does not leave the operator to guess whether a colour pair is legible.
- **Badges carry state**, not prose: `LIVE`, `BUSY`, a lock for a protected row.
- **Actions are per row and on the right**, small, with the destructive one outlined in red.
- Light background, generous whitespace, one accent colour.

The panel page is not the admin console and should not clone it - it is a different job on a
different device, and it is dark today for a reason worth keeping. But a design that ignores
all of this is choosing to, and should say why in its notes. The contrast readout in
particular is a solved problem here that the panel page currently does not solve at all.

**Note the panel page has a harder version of the same problem.** The admin console shows
contrast because the state renders on a colour screen. The panel is 1-bit, so contrast is not
the question - luminance against the 128 threshold is, because that is what picks the SHAPE.
The panel page's equivalent of the `6.39:1 AA` readout is a luminance readout.
