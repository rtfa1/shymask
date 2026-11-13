# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `rtfa1/shymask`.
Use the `gh` CLI from this repository.

## Operations

- Verify the target: `gh repo view --json nameWithOwner`.
- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,labels`.
- Comment: `gh issue comment <number> --body-file <path>`.
- Apply labels: `gh issue edit <number> --add-label "<label>"`.
- Remove labels: `gh issue edit <number> --remove-label "<label>"`.
- Close: post an explanation, then `gh issue close <number>`.

Use UTF-8 files for multiline bodies and comments.

File issues in `rtfa1/shymask`. Verify the target before the
first issue creation of a session.

Use native GitHub sub-issues and issue dependencies when available.
Otherwise, link children with `Part of #<parent>` and record blockers
with `Blocked by: #<number>`. Work is unblocked when all blockers close.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill instructions

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read its GitHub issue.

## Wayfinding

A map is an issue labelled `wayfinder:map`. Link child tickets
as sub-issues, or use a task list with parent references.

Label children `wayfinder:<type>`, where type is research,
prototype, grilling, or task. Select the first open, unassigned
child in map order whose blockers are closed.

Claim a ticket by assigning yourself. On resolution, comment
with the result, close the ticket, and append a result summary
and link to the map’s Decisions-so-far.
