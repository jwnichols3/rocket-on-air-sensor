# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues (`github.com/jwnichols3/rocket-on-air-sensor`). Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## NEVER write "does not close #N" in a commit message

GitHub's closing-keyword parser is a **regex, and it does not understand negation.** Every one
of these closes the ticket on push:

```
This does not close #NNN
Not a fix for #NNN
Does not resolve #NNN - the mechanism is still armed
```

Measured on 2026-08-31: `324c361`'s body contained the sentence "This does not
close" followed by issue 87's number, written to say the ticket must stay open, and the push
closed it. `d2366c3`, the commit adding this very section, then closed it AGAIN by quoting
that sentence. The keywords are `close`,
`closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`, each followed
by `#N`.

This repo's commit messages are long and discursive, which is exactly the style that walks into
it - a message explaining what a change does NOT settle is the most likely place to write the
phrase, and the most damaging place for it to fire.

**Write it without the keyword:**

```
#87 stays open - the rollback mechanism is still armed by design.
This leaves #87 open.
Partial: see #87.
```

**Quoting the phrase fires it too.** The commit that first documented this rule closed #87 a
SECOND time, because the documentation quoted the sentence verbatim. Avoiding the phrase is not
enough - any occurrence of a keyword next to `#N` counts, including inside quotes, code fences
and examples. When writing about an incident like this, break the pair: write the number as
`#&#8203;87`, or as "issue 87", or use a placeholder like `#NNN`.

And after any push that mentions an issue you meant to leave open, check it:
`gh issue view <n> --json state`. Do this even when the message was only ABOUT the hazard.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
