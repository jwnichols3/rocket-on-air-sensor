# Prior art for a user-definable presence state model - Research

2026-08-23. Wayfinder research ticket #23, under map #19, blocking #32.

**The ask, in Rocket's words:** *"I also want to abstract the states. There's probably
systems out there that do what I'm about to describe. I would launch a research agent to go
see if there's just a library or a pattern where it's like, yeah, you can just use this and
we can accelerate."*

**The thing being designed** (from `docs/2026-08-23-onair-v2-wayfinder-brief.md` §1): an
arbitrary, user-editable table of presence states, each row carrying an **ID**, a **phrase
sent on the wire**, a **background colour**, a **font colour**, and a **description**.
Today's `available < interruptible < dnd` ladder (D-18) becomes the default seed of that
table, and the ID stops being a rank and becomes an unordered key.

Labels used below: **[FACT]** = read from the primary source named. **[SEARCH-LEVEL]** = the
primary source could not be pulled (PDF/binary or paywalled nav); the claim rests on search
snippets and should be re-verified before anything depends on it. **[JUDGEMENT]** = a call.
**[UNRESOLVED]** = not settled.

---

## Verdict

**No. There is nothing to adopt.** No standard, no platform, no product and no library
implements a user-definable presence state table with colours. Every near-miss fails for the
same structural reason, and it is worth stating once because it recurs in all five categories:

> Presence systems are built for **federation** - a stranger's client must render your
> presence without prior agreement. That constraint forces a small closed machine-readable
> enum plus an open human-readable escape hatch, and it forces the escape hatch to be
> *presentational only*, because nothing downstream can branch on a value it has never seen.
> Rocket has no federation. One owner, one server, N renderers he also owns. **The constraint
> that produced every fixed enum in the industry does not apply here** - which is why nothing
> exists to copy, and also why inventing it is safe rather than reckless.

The honest negative is the answer. What follows is the evidence, plus the three things that
*are* worth stealing.

### Worth stealing

| # | Steal | From | Cost |
|---|---|---|---|
| 1 | **The name "Type Object"** for the whole design, and its distinction that the current state is *a reference to a row*, not a row. | Johnson & Woolf, PLoP '96 | Zero. A word. |
| 2 | **The field names `text`, `color`, `bgcolor`** for the row's phrase/font/background. | Bitfocus Companion | Zero, and it makes the D-11 Companion module a field copy instead of a translation layer. |
| 3 | **The `{value, label}` self-describing option list on the wire** - renderers ask the server what states exist and get machine key + human label back. | openHAB `StateDescription` options | Zero. It is a response shape. |

### Do not adopt

| Candidate | Why not |
|---|---|
| XMPP / PIDF / RPID extensibility | Extends by adding *new namespaces*, not new enum members; unknown extensions MUST be ignored, so a custom state degrades to nothing rather than to a fallback. |
| Slack / Teams / Discord | All three are "fixed enum + free text". None exposes a definable state *set*. None has colour anywhere. |
| Home Assistant `input_select`, ESPHome `select`, MQTT discovery `select` | Options are **bare strings** - no id/label split, no colour, no description. The display string *is* the key. |
| openHAB | Right shape (`value`/`label`), but colour lives in the sitemap not the option, and it is EPL-2.0 Java welded to the Thing/Channel/Item model. Nothing importable. |
| Kuando BusyLight / Elgato / LaMetric | Colour and display primitives. No state model at all. |
| `custom:button-card` (MIT) | Closest *artifact* found anywhere - an ordered, coloured, user-edited state table. But it is Lovelace YAML inside one HACS frontend card. Per-card, no server, not importable. Useful as proof-of-shape only. |
| xstate / javascript-state-machine / state-machine-cat | Model **transitions between compile-time states**. This problem has no transition graph (the brief already ruled the ID unordered) and the states are runtime data. All cost, no fit. |

---

## 1. Presence standards: closed enum, open note, ignore-what-you-don't-know

### XMPP - RFC 6121 [FACT]

`<show/>` is a closed set: *"The defined values are 'away', 'chat', 'dnd', and 'xa'."* Absence
of `<show/>` means available. `<status/>` is free human-readable text ("In a meeting").
Extension is by namespace only: *"Extended content can be included by means of extensions
qualified by other XML namespaces."*

- https://datatracker.ietf.org/doc/html/rfc6121

**Why it does not fit:** the extensibility model adds *new structure*, not new members of the
existing enum. A recipient that does not understand your namespace ignores it and sees only
available/unavailable. That is the correct behaviour for federation and the wrong behaviour
for us - if the ESP32 or Companion does not know state `4: recording`, we want it to render a
defined fallback, not silently fall back to a boolean.

**Vocabulary worth noting:** the `show`/`status` split - **one machine token, one human
string** - is the whole naming model, and it is two fields, not three. Rocket's row has three
name-ish fields: ID, phrase, description. `show`/`status` says the machine key and the human
text are enough, and the description is documentation for the *editor*, not for the wire.
**Flag for #32:** carrying both a numeric ID *and* a wire phrase means two identities for one
state. Every standard surveyed here carries exactly one machine key. Two is a rename/renumber
hazard - it is the mechanism by which "what happens when state 3 is renamed" becomes a bug.

### XMPP XEP-0108 User Activity [FACT]

Fixed taxonomy, plus an `<other/>` element and a free-text `<text/>`. Business rule: *"The
receiving application MUST ignore a specific activity element or detailed activity element if
it does not understand the namespace that qualifies the element."* And on `<other/>`: *"In the
absence of a `<text/>` element, the recipient is free to draw whatever conclusions he or she
may like regarding the nature of the 'other' activity."*

- https://xmpp.org/extensions/xep-0108.html

That last sentence is the escape hatch admitting it carries no machine meaning. Exactly the
shape to avoid.

### SIP/SIMPLE - RFC 3863 PIDF [FACT]

`<basic>` is a **boolean**: *"The `<basic>` element contains one of the following strings:
'open' or 'closed'."* Everything richer is an extension namespace, and processors *"MUST
ignore any XML element with an unrecognized name"*.

- https://datatracker.ietf.org/doc/html/rfc3863

### SIP/SIMPLE - RFC 4480 RPID [FACT]

Adds a 26-value fixed `<activities>` vocabulary (appointment, away, breakfast, busy, dinner,
holiday, in-transit, looking-for-work, lunch, meal, meeting, on-the-phone, performance,
permanent-absence, playing, presentation, shopping, sleeping, spectator, steering, travel, tv,
unknown, vacation, working, worship), and: *"The `<activities>`, `<mood>`, and `<place-type>`
elements can also take `<other>` elements containing text, for custom free-text values
specific to an application."* New standardised values require an IANA-registered namespace.

- https://datatracker.ietf.org/doc/html/rfc4480

**Same shape, third time.** RPID is the most elaborate presence vocabulary in the IETF corpus
and its answer to "I have a state you didn't think of" is still a free-text blob nobody can
act on. If a 26-value committee vocabulary needs an escape hatch, a 4-row user table is not an
unreasonable thing to want.

---

## 2. Chat and collaboration: 0 of 3 expose a definable state set

### Slack [FACT]

Custom status is three profile fields: `status_text` - *"The displayed text of up to 100
characters"*; `status_emoji` - *"The displayed emoji that is enabled for the Slack team"*; and
`status_expiration`. Presence itself is auto/away. There is no user- or admin-definable named
status set, and no colour anywhere in the model.

- https://docs.slack.dev/reference/methods/users.profile.set

### Microsoft Teams (Graph presence resource) [FACT]

Two closed enums plus a message:

- `availability`: `available`, `away`, `beRightBack`, `busy`, `doNotDisturb`, `focusing`,
  `inACall`, `inAMeeting`, `offline`, `presenting`, `presenceUnknown`
- `activity`: `available`, `away`, `beRightBack`, `busy`, `doNotDisturb`, `offline`,
  `outOfOffice`, `presenceUnknown`
- `statusMessage`: free text

Not extensible by a tenant admin. Microsoft's own answer to "richer presence" was to *add more
enum members in a service update* - `focusing`, `inACall`, `inAMeeting`, `presenting` are
Microsoft's states, not the customer's.

- https://learn.microsoft.com/en-us/graph/api/resources/presence

### Discord [FACT]

`status` is `online`, `dnd`, `idle`, `invisible`, `offline`. A custom status is activity type
4 carrying a free-text `state` field plus an optional emoji. Closed enum, free text.

- https://docs.discord.com/developers/events/gateway-events

**The pattern across all three:** the free-text field is *always* presentational. Nothing
downstream branches on it - no bot logic, no light, no automation. Rocket needs the exact
opposite: the user-defined value must **drive a renderer**. No chat platform has ever needed
that, so none of them built it.

---

## 3. Home automation: the closest analogue, and it also does not fit

### Home Assistant `input_select` [FACT]

The configuration variables are `name`, `options`, `initial`, `icon`. `options` is *"List of
options to choose from"* - a list of **bare strings**. No per-option metadata: no separate ID,
no colour, no description. `input_select.set_options` replaces the whole list at runtime;
there is no add/remove-single-option service.

- https://www.home-assistant.io/integrations/input_select/

**The consequence matters to us.** Because the display string *is* the key, renaming an option
silently breaks every automation, script and dashboard that referenced the old string. That is
precisely open question 3 in the brief - *"what happens to a device pinned to state 3 when
state 3 is deleted or renumbered?"* - and Home Assistant's answer is "it breaks, and that is
your problem." **Do not copy this.** It is the single strongest argument for an immutable
numeric/opaque ID that the phrase, colours and description all hang off, which is what Rocket
already sketched.

**Colour:** Home Assistant attaches colour in the **frontend, per card**, never to the option.
The state machine carries no colour at all.

### ESPHome `select` [FACT] - the sharpest practical finding

Options are **compile-time YAML**. Template select: *"options (Required, list): The list of
options this Select has."* There is no runtime API to change the option list. And on invalid
values: *"When a non-existing option value is used, a warning is logged and the state of the
select is left as-is."*

- https://esphome.io/components/select/index.html
- https://esphome.io/components/select/template.html

Two things follow.

1. This is the **primary-source confirmation of D-17's** hard-won empirical finding that the
   device *"silently drops invalid options"*, and therefore that read-back is mandatory. It is
   documented behaviour, not a firmware bug. Good - D-17's driver design is safe.
2. **The moment the state table becomes user-editable, the ESP32's `select` entity stops being
   the right device interface.** A `select` is a compile-time enum. Either every table edit
   implies a reflash of `jwnichols3/rocket-esp32`, or the device stops advertising an enum -
   e.g. it takes an opaque state key plus the colours it should render, which is the direction
   D-20's renderer split already points. **[JUDGEMENT]** This belongs in #32 as a named
   consequence, not discovered during implementation.

### MQTT discovery `select` [FACT]

`options`: *"List of options that can be selected. An empty list or a list with a single item
is allowed."* Plain strings. No colour, no description, no id/label split.

- https://www.home-assistant.io/integrations/select.mqtt/

So the limitation is not a quirk of one helper - it is the whole Home Assistant ecosystem's
model of "a user-defined option list".

### openHAB - the one genuine near-miss [FACT for the REST shape, SEARCH-LEVEL for the file syntax]

openHAB items carry `StateDescription` / `CommandDescription` metadata whose `options` are
**value/label pairs**. Over the REST API each option is `{"value": "PowerOff", "label":
"PowerOff"}`; in an items file the documented syntax is
`stateDescription="" [ pattern="%d%%", options="1=Red, 2=Green, 3=Blue" ]`. **[SEARCH-LEVEL]**
on the exact items-file string - the openHAB docs pages I could fetch
(`docs/concepts/items.html`, `docs/configuration/items.html`) did not render that section, and
the syntax above comes from the openHAB community threads and issue
`openhab/openhab-core#1185`. The `{value, label}` REST shape is well attested.

- https://www.openhab.org/docs/configuration/items.html
- https://community.openhab.org/t/item-metadata-state-description-options/169933
- https://github.com/openhab/openhab-core/issues/1185

**What openHAB gets right that Home Assistant does not:** the machine value is separate from
the human label, and the option list **travels over the API with the item**. A UI does not need
out-of-band knowledge of the legal states; it asks and is told.

**Steal this shape.** The brief needs exactly this in two places - the ESP32's config page
("take config from the server" vs "override locally") and the Companion module ("presets that
regenerate from the server's state table"). Both are "renderer asks the server what states
exist". Do not invent a bespoke discovery response; `{value, label}` (extended with `color`,
`bgcolor`, `description`) is proven and instantly legible.

**What openHAB still does not give us:** colour. openHAB puts colour in the **sitemap**, as
conditional presentation rules - `labelcolor` / `valuecolor` / `iconcolor` - alongside
`mappings=[0="DasErste", 1="BBC One", 2="Cartoon Network"]`, which is another value=label list
in the presentation layer.

- https://www.openhab.org/docs/ui/sitemaps.html

So even the best-shaped system in this category **splits the model**: option list on the item,
colour in the presentation layer. **[JUDGEMENT]** Rocket's design deliberately merges them -
one row owns both the wire phrase and the colours. That is a real divergence from all prior
art and it should be a conscious decision in #32, not an accident. The argument for merging is
strong here: unlike openHAB we have multiple dumb renderers (OLED, future lamp, Companion
button, web UI) that cannot each carry their own sitemap, so the colours must ride with the
state. The argument against is that it welds presentation into the wire protocol forever.

### And it is not importable

openHAB is Java under EPL-2.0, and `StateDescription` is entangled with the Thing/Channel/Item
model. There is no npm package, no schema, nothing to depend on. What crosses over is the
**idea and the two field names**, which cost nothing.

---

## 4. On-air / tally products: none ships a configurable state table

### Bitfocus Companion - best field-level match, and we already integrate with it (D-11) [FACT]

A boolean feedback definition carries a `defaultStyle`:

```js
{
  type: 'boolean',
  name: 'My first feedback',
  defaultStyle: { bgcolor: 0xff0000, color: 0x000000 },
  options: [...],
  callback: (feedback) => { ... },
}
```

The full set of style properties a feedback may set: `text`, `size`, `color`, `bgcolor`,
`alignment`, `pngalignment`, `png64`, `imageBuffer`. Presets carry a `style` of `text`, `size`,
`color`, `bgcolor` plus `steps` and `feedbacks`, and are *"ready-made buttons that will be
presented to the user in the Presets tab"*. The docs note *"The user will be able to customise
these values as well as the fields that will be changed."*

- https://companion.free/for-developers/module-development/connection-basics/feedbacks/
- https://companion.free/for-developers/module-development/connection-basics/presets/

**Steal the field names verbatim.** `text` for the phrase, `color` for the font colour,
`bgcolor` for the background. Not `fontColour`/`backgroundColour`/`displayText`. Rationale:
the brief already commits to a Companion module whose presets regenerate from the server's
state table; if the state row's field names are Companion's field names, the preset generator
is a field copy rather than a translation layer, and Rocket reads one vocabulary in the admin
UI and in Companion. This is the cheapest win in this document.

**What Companion is not:** there is no shared state-table object. `defaultStyle` lives in
module code; the user's overrides live in Companion's own database, authored in Companion's
GUI. There is nothing to export, import, or depend on. **Vocabulary yes, mechanism no.**

**[UNRESOLVED]** The brief wants presets to *regenerate* when the state table changes.
`setPresetDefinitions()` is an instance method on `InstanceBase`, but the published docs
describe it only as *"Set the preset definitions for this instance"* and say nothing about
whether it may be called repeatedly at runtime to replace definitions. Verify against a real
module's source before designing the regeneration flow on it.

- https://bitfocus.github.io/companion-module-base/classes/InstanceBase.html

### Kuando BusyLight [SEARCH-LEVEL]

The SDK is a **colour primitive** API: RGB values, brightness, blink/pulse duty cycle, built-in
sounds; .NET SDK plus a WebHID/JavaScript SDK for Chromium. The state→colour mapping lives
inside Plenom's per-integration connector software (Teams, Skype, etc.), not in any portable or
user-authored table. The Plenom configuration PDF would not extract. Nothing to adopt.

- https://www.plenom.com/support/development/

### Elgato [SEARCH-LEVEL]

Key Light / Key Light Air / Light Strip via Control Center and Stream Deck expose On/Off, Set
Brightness, Adjust Brightness, Set Temperature, Adjust Temperature. **No state model at all** -
these are lamp primitives. Stream Deck buttons are per-button configuration, same class of
thing as Companion.

- https://marketplace.elgato.com/learn/how-to/control-lighting-stream-deck

### LaMetric [SEARCH-LEVEL]

Indicator apps push or poll **frames** - icon, text, goal, chart - to stay resident on the
device. It is a display delivery protocol, not a state model; there is no notion of a named
state, let alone a table of them.

- https://lametric-documentation.readthedocs.io/en/latest/reference-docs/device-apps.html

**Category verdict:** zero of four products ship a portable configurable state table. The ones
with colour have no states; the one with state-driven styling (Companion) keeps it inside its
own application.

---

## 5. Generic patterns: yes, and it has a name

### Type Object (Ralph Johnson & Bobby Woolf, PLoP '96) [FACT]

Intent: **decouple instances from their classes so that those classes can be implemented as
instances of a class**, allowing new "types" to be created dynamically at runtime. Two
participants:

- the **TypeObject** - holds the data shared by everything of that type, and represents a
  logical type. *Here: the row. Phrase, background colour, font colour, description.*
- the **TypedObject** - holds instance-specific data and **a reference to its type object**.
  *Here: the live presence. Current state = a reference to a row, plus timestamp, source, hold.*

Use it *"when you don't know what types you will need up front, or when you want to be able to
modify or add new types without having to recompile or change code."* That is a verbatim
description of the ticket.

- http://www.cs.ox.ac.uk/jeremy.gibbons/dpa/typeobject.pdf (Johnson & Woolf, original paper -
  binary PDF, could not be text-extracted; vocabulary below is from the secondary sources)
- https://gameprogrammingpatterns.com/type-object.html
- https://java-design-patterns.com/patterns/type-object/

**Why this word earns its place.** It draws the line the brief keeps stumbling over:

> **The current state is not a row. It is a reference to a row.**

Hold that distinction and the three "needs a decision ticket" items in the brief get an answer
*shape* for free:

- **Renumbering.** The reference is by immutable ID. The phrase, both colours and the
  description can all be edited freely without touching anything that points at the state -
  because nothing points at the phrase. (This is the exact failure mode Home Assistant's
  `input_select` has, and the exact thing openHAB's value/label split avoids.)
- **Deletion.** A dangling type reference. Type Object's standard answers are the only two
  available: refuse to delete a type that is currently referenced, or define a fallback type
  every dangling reference resolves to. Pick one deliberately. **[JUDGEMENT]** given the
  project's founding invariant - *false OFF is worse than false ON* - the fallback must not be
  `available`; either refuse the delete, or resolve to the most-restrictive row.
- **`intended` projection.** A TypeObject can carry whatever shared data the renderers need, so
  an explicit `onAir: bool` (or equivalent) **on the row** is the natural home for it - not a
  derived function of an ordering that no longer exists. The brief listed this as an either/or;
  Type Object says the row is where per-type data lives, so it is not much of a contest.

Also: the seed table (available / on-air / interruptible / recording) becomes **four
TypeObjects, not four code paths**. Cost of adopting: zero. It is a name for a shape.

### Related vocabulary worth having

- **Reference data** (Fowler's usage) - a small, slowly-changing, user-maintained lookup keyed
  by a stable ID. Says the right things about migration, seeding and referential integrity.
- **First-match rule list** - the render-side shape, below.

### `custom:button-card` - the closest existing *artifact* found anywhere [FACT]

A HACS Lovelace card (MIT licence) whose `state` configuration is an **ordered array of styled
rows**: fields `operator`, `value`, `name`, `icon`, `color`, `styles`, `label`,
`state_display`, `entity_picture`, `rotate`, `spinner`, `tooltip`. Operators are `<`, `<=`,
`==` (default), `>=`, `>`, `!=`, `regex`, `template`, `default`. Matching: *"The order of your
elements in the `state` object matters. The first one which is `true` will match."*

- https://custom-cards.github.io/button-card/v7.0/config/state/
- https://github.com/custom-cards/button-card (MIT)

This is a real user-edited, ordered, coloured state table that thousands of people actually
maintain. **It is not adoptable** - it is Lovelace YAML inside one frontend card, per-card, no
server, no API, no export, and its match semantics (regex, comparison operators, JS templates)
are far heavier than an unordered keyed enum needs. Its value here is as **proof the shape is
right**, plus a short checklist of fields that real users turned out to need: an explicit
`default` row, and per-row style overrides beyond a single colour.

### Libraries: no [FACT on what they are, JUDGEMENT on fit]

`xstate`, `javascript-state-machine`, `@urbn/state-machine` and the rest model **transitions
between compile-time states**, and typically *"enforce a static and explicit configuration
where all possible states and transitions must be defined upon machine creation."*
`state-machine-cat` has per-state colours but is a **diagram renderer**.

- https://www.npmjs.com/package/xstate
- https://www.npmjs.com/package/state-machine-cat

Neither axis matches. This problem has **no transition graph** - the brief already ruled the
state ID an unordered key, not a rank, so there is nothing to model transitions over - and the
states are **runtime data**, not compile-time configuration. Pulling in a statechart library to
hold four rows of JSON would be all cost and no benefit. **This satisfies D-29 (minimal,
necessary, trusted dependencies) trivially: the recommendation adds zero dependencies.**

### One piece of validation that is genuinely needed [FACT]

Because a row carries **both** background and font colour, a user can author an unreadable
pair. WCAG 2.2 SC 1.4.3 gives the threshold: **4.5:1 for normal text, 3:1 for large text**,
computed from relative luminance. A contrast check in the state-table editor is a few lines and
is the one validation this table actually needs. It also connects to the accessibility finding
already recorded in `docs/research/2026-08-22-wall-indicator.md` about red/green.

- https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum

---

## What this means for #32

**[JUDGEMENT]** Five things this research would put in the design ticket:

1. **Build it. Nothing exists.** The absence of prior art here is explained, not suspicious -
   every presence system in the industry is federation-shaped and this one is not.
2. **Name it Type Object**, and hold the line that the live presence is *a reference to a row*.
   That framing answers renumber/delete/`intended` in one move.
3. **One machine key per state, immutable.** Every surveyed standard carries exactly one. Two
   identities (numeric ID *and* wire phrase) is the mechanism by which renames become bugs -
   decide which one is the key and make the other pure presentation.
4. **Use Companion's field names** - `text`, `color`, `bgcolor`. Free, and it collapses the
   Companion preset generator into a field copy.
5. **The ESP32's `select` entity is now a problem.** ESPHome options are compile-time and
   invalid writes are silently dropped (documented, and it confirms D-17). A user-editable
   table means either a reflash per edit or a different device interface. This is a real
   consequence of the state-table decision, not a firmware detail to discover later.

---

## Sources

Presence standards:
- https://datatracker.ietf.org/doc/html/rfc6121 (XMPP IM & Presence)
- https://datatracker.ietf.org/doc/html/rfc3863 (PIDF)
- https://datatracker.ietf.org/doc/html/rfc4480 (RPID)
- https://xmpp.org/extensions/xep-0108.html (User Activity)

Chat platforms:
- https://docs.slack.dev/reference/methods/users.profile.set
- https://learn.microsoft.com/en-us/graph/api/resources/presence
- https://docs.discord.com/developers/events/gateway-events

Home automation:
- https://www.home-assistant.io/integrations/input_select/
- https://esphome.io/components/select/index.html
- https://esphome.io/components/select/template.html
- https://www.home-assistant.io/integrations/select.mqtt/
- https://www.openhab.org/docs/configuration/items.html
- https://www.openhab.org/docs/ui/sitemaps.html
- https://github.com/openhab/openhab-core/issues/1185
- https://community.openhab.org/t/item-metadata-state-description-options/169933

On-air / tally products:
- https://companion.free/for-developers/module-development/connection-basics/feedbacks/
- https://companion.free/for-developers/module-development/connection-basics/presets/
- https://bitfocus.github.io/companion-module-base/classes/InstanceBase.html
- https://www.plenom.com/support/development/
- https://marketplace.elgato.com/learn/how-to/control-lighting-stream-deck
- https://lametric-documentation.readthedocs.io/en/latest/reference-docs/device-apps.html

Patterns:
- http://www.cs.ox.ac.uk/jeremy.gibbons/dpa/typeobject.pdf
- https://gameprogrammingpatterns.com/type-object.html
- https://java-design-patterns.com/patterns/type-object/
- https://custom-cards.github.io/button-card/v7.0/config/state/
- https://github.com/custom-cards/button-card
- https://www.npmjs.com/package/xstate
- https://www.npmjs.com/package/state-machine-cat
- https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
