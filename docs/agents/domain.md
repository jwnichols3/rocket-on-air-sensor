# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — problem statement, glossary, invariants, open questions.
- **`CONTEXT.md` → `## Decisions`** — this repo records decisions as D-rows in that section
  instead of a `docs/adr/` tree (same pattern as vcrec's `DECISIONS.md`). When a skill says
  "read the ADRs" or "record an ADR", that section is the ADR record.

If these don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) fills them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md        ← glossary, invariants, open questions, ## Decisions (ADR record)
├── docs/agents/      ← this folder
└── (source TBD — stack not yet chosen)
```

If the decision log outgrows the section, promote it to a root `DECISIONS.md` (vcrec-style) and update this file.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` — Detector, Receiver, On-air light, Call state (ON_AIR / OFF_AIR). Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts a recorded decision, surface it explicitly rather than silently overriding:

> _Contradicts D-3 (MQTT transport) — but worth reopening because…_
