# Local admin, the menu bar, and where the token really belongs

2026-08-23. Written after the ESP32 integration went live (D-22), when the owner's first
real use of the system produced this:

```
open "http://10.42.14.189:8484/ui?token=$(grep '^ONAIR_TOKEN=' ~/.onair/config.env | cut -d= -f2-)"
```

His words: *"That is a crazy amount of code just to open a web page on this computer."*
He is right, and the fix is not to paper over it with an alias.

## Status of the research

Four research agents were dispatched (localhost trust, menu bar options, token model,
ergonomics). **All four went idle without returning reports**, and two did not respond to
a direct request for their findings. The delivery mechanism failed, not the questions.

Everything below is therefore **first-hand**: measured on this machine, or read at
`file:line`. That is a better basis than agent prose would have been, and the security
section in particular is experimental rather than argued. Where something is unverified it
says so.

---

## 1. The security question, settled by experiment

The owner's premise: *"if I'm loading a web page on the machine as localhost, that is a
local admin function... simply because it's localhost I think that is not a security
hole."*

**The premise is false as stated.** A loopback source address does not identify the caller.

### The experiment

A stand-in for the real write route was run on a loopback port. A web page served from a
*different* address then attacked it, using exactly the shape of the real button: `POST`,
no body, no `Content-Type` - a CORS **simple request**, so no preflight.

The attack **succeeded**. What the server received: [FACT, measured 2026-08-23]

```
method: POST      url: /available
remote: 127.0.0.1                     <- a loopback check PASSES this
origin: http://10.42.14.189:9099      <- the page was not ours
site:   cross-site
```

Run again from a different **port on the same host**, the classification changes: [FACT]

```
origin: http://127.0.0.1:9099
site:   same-site                     <- NOT cross-site. A port is not part of a "site".
```

### What follows

- A check on `req.socket.remoteAddress` alone protects **nothing**. Proven twice.
- A check that merely rejects `Sec-Fetch-Site: cross-site` is **also insufficient**,
  because another loopback port reports `same-site`.
- `Origin` was **present and wrong in both attacks**. It is the header that works.

Loopback address forms seen by Node on this machine, which the implementation must all
handle: [FACT, measured]

| Client used | `req.socket.remoteAddress` |
|---|---|
| `http://127.0.0.1` | `::ffff:127.0.0.1` |
| `http://localhost` | `::1` |
| `http://[::1]` | `::1` |
| LAN IP | `::ffff:10.42.14.189` |

`Host` is freely forgeable by a non-browser client (`curl -H "Host: evil.example"`
succeeded) [FACT], but a browser sets `Host` from the URL and page script cannot override
it, which is what makes a `Host` allowlist worth having against DNS rebinding.

### One inconclusive test, stated honestly

A cross-site **HTML form** POST was also attempted. The browser navigated to the target
URL but no request reached the server, and **the cause was not determined**. It does not
change any conclusion here - the `fetch` variant already proved the vector is open, and
the recommended rule blocks both.

### The rule

Waive the token **only** when all three hold:

1. the connection is from loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`); **and**
2. the `Host` header names a loopback name on our own port; **and**
3. `Origin` is **either absent, or exactly one of ours**
   (`http://localhost:PORT`, `http://127.0.0.1:PORT`, `http://[::1]:PORT`).

Reject if `Sec-Fetch-Site` is present and is not `same-origin` or `none`. Never accept
`same-site` - the experiment above is exactly why.

This admits our own page (sends our `Origin`) and `curl`/Shortcuts (send none). It refuses
every page on the internet.

### What this deliberately does not protect against, and why that is acceptable

**Malicious software already running as this user.** It can read
`~/.onair/config.env` and take the token. A token therefore buys **nothing** against that
adversary, so requiring one from local non-browser callers is security theatre. The
adversary a local waiver must actually stop is *a web page in the owner's browser*, and
that adversary always sends `Origin`. [JUDGEMENT]

**Another human user account on this Mac.** A process running as a different local user
can open a loopback socket and send no `Origin`. Accepted because this is a single-user
machine. **If that ever changes, this waiver must be revisited.** [JUDGEMENT]

---

## 2. `/ui` and `/display` should not be gated at all

Both are single exported template strings containing **zero `${}` interpolations**
[FACT, `src/ui.ts`, `src/display.ts`]. They are byte-identical for every caller and carry
no state. Gating them buys no confidentiality whatsoever.

What gating them *costs* is concrete:

- the token is forced into the address bar and browser history;
- a bare reload returns `401`, because a top-level navigation cannot send an
  `Authorization` header [FACT, measured];
- an unauthenticated visitor sees `{"error":"missing or invalid bearer token"}` - raw
  JSON, which is a dead end for a human [FACT].

**Serve both unauthenticated. Keep every data route gated.** The pages then load bare,
and take their credential from the local waiver or from `localStorage`.

---

## 3. The token model

**Established fact, because the owner was unsure:** the ESP32 is **not** a client of this
API. The Node service is an HTTP *client* of the ESP32 [FACT, `src/esphome-driver.ts:74,97`].
Nothing on the network needs a token *in order to talk to the light*. The device has its own
password, which the service sends outbound.

What actually connects inbound: the two web pages, `GET /events` (SSE), the WebSocket,
Companion, and phone Shortcuts.

**Recommendation: keep exactly one token, and add the local waiver.** A read-only /
read-write split is *not* recommended for phase 1: control is the thing the owner does
locally, and the network consumers that would take a read-only credential (Companion,
the kiosk) are the same LAN he already trusts. The split is written up as a deferred
option below rather than built. [JUDGEMENT]

`?token=` in URLs stays available for `EventSource`, the WebSocket, and the remote kiosk,
because neither can send a header. After this change it is **only** needed off-machine.

---

## 4. Ergonomics, measured

| # | Finding | Evidence |
|---|---|---|
| 1 | **`onair setup` silently deletes the light config.** It rewrites `config.env` from scratch with only `ONAIR_PORT`, `ONAIR_TOKEN`, `ONAIR_STATE_FILE`. The four `ONAIR_LIGHT_*` keys vanish, the driver falls back to `NoopDriver`, and the light dies with no error. | `deploy/onair:104-125,455` [FACT] |
| 2 | Nothing prints the URL to open. There is no `onair ui` verb. | `grep` of `deploy/onair` [FACT] |
| 3 | A browser with no token gets raw JSON, not a message. | measured [FACT] |
| 4 | `onair status` reports `supervised: no (state=unknown ...)` for a **healthy** service, because it cannot read `launchctl` without sudo. It should say it cannot tell. | measured [FACT] |
| 5 | `onair update` is sound - staged build, swap, health-poll, rollback. Leave it alone. | `deploy/onair` cmd_update [FACT] |

Only `setup` writes the config file; `install` calls it **only when no config exists**
(`deploy/onair:280`), so `install` is safe today. The hazard is exactly one verb. [FACT]

---

## 5. The menu bar

The privileged half of this is **already built and not installed**. `onair install
--sudoers` writes `/etc/sudoers.d/onair` containing a narrowly scoped rule: seven
`launchctl` subcommands against this one label and plist path, nothing broader, validated
with `visudo -cf` before installation [FACT, `deploy/onair:315-332`]. It is **not present
on this Mac** [FACT], which is why `onair restart` prompts for a password and why
`onair status` cannot see the daemon.

With that rule installed, a menu bar tool needs no privilege machinery of its own - it
just runs `onair`.

**Recommendation: a SwiftBar plugin.** SwiftBar is actively maintained, macOS 26
compatible, MIT-licensed, installs with `brew install --cask swiftbar`, and a plugin is
just a script that prints text.

Rejected alternatives [JUDGEMENT]:

- **Native Swift `MenuBarExtra`** - needs Xcode or a hand-rolled `swiftc` build, an app
  bundle, and a login-item registration, to end up with something that shells out to
  `onair` anyway. Far more code for the same result.
- **Hammerspoon / rumps** - heavier runtime dependency than the job needs.

Cost, stated plainly: it is a third-party app the owner must install once. That is the
honest price of not writing and signing a Swift app.

---

## Plan

Phased so that each phase is independently useful and independently revertible.

### Phase 1 - stop the bleeding (do first, small)

1. **Fix `onair setup` so it preserves keys it does not manage.** This is a live trap.
2. `onair ui` verb: print the URL, and open it with `--open`.
3. `onair status`: say `supervised: unknown (needs sudo)` rather than `no`, and print the
   URLs.
4. Browser-friendly `401`: when `Accept` contains `text/html`, return a small HTML page
   explaining what to do, instead of raw JSON.

### Phase 2 - the local waiver (the real change)

5. Implement the three-part rule in `src/server.ts`, with tests that encode the two
   measured attacks as regression cases.
6. Ungate `GET /ui` and `GET /display`.
7. `http://localhost:8484/ui` then works with nothing appended.

### Phase 3 - the menu bar

8. `onair install --sudoers` (owner runs once, with consent - it edits `/etc/sudoers.d`).
9. SwiftBar plugin: state at a glance, open UI, open display, start/stop/restart, edit
   config, about.

### Deferred, with reasons

- **Read-only token split.** Revisit if the kiosk moves somewhere physically untrusted, or
  if anything is exposed beyond the LAN.
- **Session cookie instead of `?token=`.** Would remove the token from kiosk URLs, but
  reintroduces CSRF on a server whose write routes are deliberately CORS-simple. Not worth
  it while the local waiver solves the common case.
- **Multi-user hardening.** Only if this Mac ever gets a second human account.

## Verification bar

Unchanged, and it applies to every phase: `npm test` **and** `npx tsc --noEmit` before each
commit; a real transcript for acceptance; and a live browser check for anything touching
the inline page scripts. Phase 2 additionally must include the two measured cross-origin
attacks as automated tests - a security rule with no regression test is a rule that will be
refactored away.
