# Design brief: the admin console

Ticket [#52](https://github.com/jwnichols3/rocket-on-air-sensor/issues/52). The page is
`http://127.0.0.1:8484/`, built from `admin-ui/src/{index.html,app.css,app.js}` and inlined
into one file by `admin-ui/build.mjs`.

Read `states.json` for the exact rows to render. They are the live table, version 11.

## What the page is for

One person, at their desk, doing one of two quite different jobs:

1. **The frequent job.** Set the state. Pin it, or release the pin. That is it. It happens
   several times a day and should cost one glance and one click.
2. **The rare job.** Change what the states *are* - labels, colours, which are busy - and the
   service's own settings. That happens when something is being set up or has gone wrong.

Today the page makes no distinction: both jobs are on one 2000px scroll with a dead
navigation rail.

## What is wrong with it today

Rocket, 2026-08-27:

> Currently it reads like just a list of things you can do. There is no organization to speak
> of and it is way too busy.
>
> There are five different sections on the left that link to things that don't actually work.
> They don't actually scroll to the right thing.

Concretely, and these are what a variation is judged on:

1. **The rail is inert.** `index.html` gives it `href="#status"`, `#states`, `#admin`,
   `#network`, `#light`; the sections are `id="sec-status"` .. `id="sec-light"`. No anchor
   matches any id. Clicking sets a highlight and scrolls nowhere.
2. **Everything is on one scroll.** Five sections, always all present, whatever you came for.
3. **The frequent job is buried.** The state buttons are inside `#status-controls`, below a
   seven-row definition list of diagnostics.
4. **Diagnostics dominate.** Table version, source, confirmed state, age in seconds, fell-back-
   from - all permanently on screen, all irrelevant to setting a state.
5. **The commit bar is always armed.** Discard all / Save configuration sit in the header
   whether or not the section you are looking at can stage anything.
6. **Nothing tells you where you are** beyond a faint highlight on a link that does nothing.

## What to build

### Two views, and the operator picks

| view | shows |
|---|---|
| **Simple** | only what you set and change. The state buttons, the pin, the state table. No diagnostics, no explanatory text. |
| **Advanced** | all of it - every status fact, contrast ratios, table version, source, confirmed state, network and device connection. |

Rocket: *"The simplified version I'd like to be just the things I can set and change very
simply. No extra text around it, like all of the statuses and things like that."*

### Five sections, revealed not scrolled

`Status` `States` `Admin` `Network` `Device connection`

Clicking a rail entry **shows that section and hides the others.** In simple view, some of
these sections are empty of anything worth showing - a variation must say what it does about
that. Hiding them is a legitimate answer; so is showing them with less in them.

### An Admin section holding exactly three things

The view setting (simple/advanced), change-admin-password, and factory reset.

### A theme toggle, near the top, as an icon

Light and dark, overriding `prefers-color-scheme` in both directions. Rocket asked for an
icon, not a labelled control, and not in a menu.

## Hard invariants

- **D-35.** The shell is served unauthenticated and byte-identical to every caller. No
  interpolation, no secret in the HTML. Every value arrives at runtime from a gated route.
- **D-39, three commit levels.** `editing` -> `staged` -> `saved`. Cancel returns a row to its
  last staged value; Revert drops it to live; one Save reaches the server. Do not collapse
  Cancel and Revert into one control.
- **D-32, THE BUSY RULE.** `busy` and row membership are the server's. **Stale evidence must
  never render as calm.** A page that looks confident about something it cannot support is
  worse than an ugly page.
- **D-31/D-34.** A row `id` is immutable and **visibly locked**. Making that visible is what
  stops someone expecting a rename to rebind their Companion buttons. `order` is presentation
  only.
- **D-80.** View and theme are `localStorage`, applied instantly. They must NOT touch the
  draft, the staged count, or the Save button.
- **D-81.** The admin password is `type="password"`. The machine passphrase stays readable -
  it is read off this page and typed into the ESP32 and Companion.
- The 5-second status poll **must not rebuild the state rows.** See the comment in
  `refreshStatus()`: it swapped the DOM out from under the user, typing went into detached
  inputs, and clicks landed on buttons that no longer existed. Both symptoms were silent.
- No framework, no imports, no external assets. No CDN, no web font, no remote image.
- The contrast checker stays. Legibility across a room is a real constraint and it is the most
  valuable thing on the page.

## The visual language is already decided - lift it

Do **not** invent a palette. The panel's own pages shipped a three-skin appearance system in
D-70/D-72 and the two web UIs should look like one product. Source:
`docs/design/esp32-config-2026-08-26/live/onair.css` and the captures in `shots/`.

What transfers directly, and should:

- **Swatch-first rows.** The row's own `color` on its own `bgcolor`, rendered as the label
  chip, is the fastest possible scan. See `shots/live-technical-dark.png`.
- **Monospace for machine values** - ids, hex, versions - and system-ui for prose.
- **Small-caps grey column headings** over a bordered list.
- **Master/detail**: the row list stays visible, the editor opens inline beneath the row being
  edited rather than replacing the page.

What is genuinely new, and what these variations are actually for: **the organisation.** How
five sections, two views, a commit bar and a theme toggle arrange themselves.

## What "good" means here, in order of weight

1. **Truthful** (x5). Never calm about something unsupported. Never a control that looks
   authoritative and is not.
2. **The frequent job is one glance and one click** (x5). Setting the state is the thing this
   page is opened for.
3. **Simple view is genuinely simple** (x4). Not advanced-with-things-greyed-out.
4. **Scannable** (x4). Where am I, what is staged, what is live.
5. **Buildable** (x3) in vanilla JS on top of the existing `app.js`, without a rewrite.
6. **Handsome** (x2), and consistent with the panel pages.
