# Prompt for the VCREC project: the on-air API has retired the pin

Paste everything below the line into the VCREC repo's agent. It is written to stand alone -
it assumes the reader has never seen the on-air repo and cannot read its source.

---

The on-air API you write to has **retired the pin / hold concept entirely**, as of
2026-08-29. Please remove VCREC's side of it.

## What changed on the server

1. **The `hold` field is gone from the state object.** `GET /status` no longer returns it.
   It was deleted outright rather than left as a permanent `null`, because a retired field
   sitting beside the real ones is a decoy the next reader keys on.

2. **The `hold` body field and the `?hold=1` / `?hold=0` query parameters are gone.**

3. **No write is refused any more.** The rule that replaced the pin is:

   > Every write with a valid body is applied. No `source` outranks another, and no earlier
   > write can block a later one. There is no pin, no hold, no precedence, and no
   > server-side memory of who wrote last beyond the `source` string itself.

4. **`auto:` and `human:` no longer differ in authority.** The prefix survives, is still
   required on `PUT /state`, and is still a `400` if missing or unprefixed - but it is now
   **provenance only**. Nothing a `human:` source may do is denied to an `auto:` source.

5. **Two status codes no longer occur on the write routes:**
   - `403` was only ever "an `auto:` source tried to set or clear a hold". No state-write
     route can return `403` now. (`403` still exists on the server's `/admin/*` surface,
     which VCREC does not touch.)
   - `409` was only ever "this automated write was refused by the pin, here is the status
     that stands". **No state-write route returns `409` now**, and no error response carries
     a status object any more. If you had a branch that read the merged status body out of a
     `409`, it is dead code.

## What VCREC should change

**Not urgent, and nothing is broken today.** A body that still carries `hold`, or a URL that
still carries `?hold=`, is **accepted and silently ignored** - deliberately. The server will
not reject your write because it mentions a retired field, because a rejected write is a
write that never happened, and a state that never got set is a light that stays wrong. That
is the failure the whole system exists to prevent, so the retired field is ignored rather
than policed.

So take these in your own time:

1. **Stop sending `hold`** in `PUT /state` bodies and `?hold=` in query strings. Harmless,
   but it is now noise that implies a feature that does not exist.

2. **Delete any pin-related logic, UI or state.** If VCREC tracks whether a hold is set,
   reads `hold` from `GET /status`, or decides anything from it, remove it. `hold` will be
   `undefined` from now on - check for any `=== null` comparison against it, which silently
   becomes `false` when the field is absent rather than missing loudly.

3. **Delete the `403` and `409` handling on state writes**, and any retry or back-off policy
   keyed to them. This is the change most worth making, because those branches are now
   unreachable and a future reader will believe they mean something. Treat what used to be
   the `409` arm as: it cannot happen.

4. **Keep sending `source` as `auto:<name>`.** Still required, still a `400` if absent or
   unprefixed. Its meaning is narrower now - it is a label for humans reading logs, not a
   claim of authority - but the wire requirement is unchanged.

5. **Keep the write-then-read-back-and-retry loop.** That is unaffected and still required:
   the server latches state and does not decay it, and the writer is still responsible for
   making a write stick. Re-send until the write is confirmed, then stop. There is still no
   heartbeat convention - do not re-send on a timer.

## What did NOT change

- `PUT /state` with `{"state": "...", "source": "auto:..."}` - identical.
- Authentication: the passphrase, `Authorization: Bearer`.
- `400` on an unknown state id, still with the `validStates` list. A typo is still loud and
  is still never accepted-and-fallen-back.
- `confirmed`, and the rule that a write succeeds even when the light is unreachable. Clients
  that care about the lamp still check `confirmed`, not the status code.
- Everything about the three-condition client contract for renderers.

## One consequence worth knowing

With the pin gone, **the detector is the sole authority over the light.** A human's manual
override now lasts only until VCREC's next write. That is intended - the owner's pattern is
"override mid-meeting, and let the meeting ending put it back" - but it does mean a wrong
detector is no longer correctable by a human except transiently. If VCREC ever writes a calm
state while a call is genuinely live, nothing on the server will stop it now.
