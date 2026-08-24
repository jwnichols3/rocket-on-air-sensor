# rocket-on-air-sensor

Detect Zoom/Google Meet call state on the Mac and drive a remote on-air light. Read
`CONTEXT.md` for the problem statement, glossary, invariants, and open questions -
architecture is still undecided; do not assume a transport or hardware choice that
isn't recorded there.

## Agent skills

### Issue tracker

GitHub Issues (`jwnichols3/rocket-on-air-sensor`) via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

Canonical five roles (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at root; decisions recorded in its `## Decisions` section
(the ADR record). See `docs/agents/domain.md`.

## Dependencies

**Minimal, necessary, trusted - not zero.** A dependency earns its place by being
genuinely needed and coming from a source worth trusting; it is not rejected merely for
existing. Judge each one on need, trustworthiness, and maintenance burden.

Historical note: earlier docs in this repo assert a "zero production npm dependencies"
hard rule and attribute it to D-11. **That rule was never decided.** It entered as a
`Tech Stack:` line in the first plan (`docs/superpowers/plans/2026-08-05-onair-api-service.md`),
was copied forward into every later plan and spec, and D-11 then cited it as pre-existing
("preserves the zero-production-dependency rule") rather than establishing it. Rocket
retired it explicitly on 2026-08-23. Treat "zero production dependencies" in any older
plan, spec, or research doc as superseded by this section.
