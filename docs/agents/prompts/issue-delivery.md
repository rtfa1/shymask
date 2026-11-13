# Delivery prompts

Paste one prompt into a harness chat opened at the repository root. The skill routes to the authoritative procedure; these prompts define the run's scope. Development uses recorded-video input according to that procedure. A queue limit is a maximum, not permission to skip blocked issues or final live acceptance.

## Setup only

```text
Use $issue-delivery to review or update the delivery workflow for rtfa1/shymask. Adapt the procedure, prompts, and role definitions to the current spec and decisions. This is setup only: do not claim issues, push branches, publish PRs, or merge anything.
```

## Next eligible issue

```text
Use $issue-delivery to deliver one eligible GitHub issue in rtfa1/shymask. Use an isolated worktree and separate implementation, review, and fixing agents. Publish the claim and PR, repeat review/fixes within the workflow limit, and merge after every gate passes. Stop after that issue or report a concrete blocker.
```

## Specific issue

```text
Use $issue-delivery for rtfa1/shymask issue #2, the recorded-video preview slice. Verify its current scope, readiness, and dependencies. Implement in an isolated worktree, open the PR, use independent review and a separate fixer when needed, and merge when all gates pass. Keep unavailable acceptance criteria explicit and stop if they block completion.
```

Replace `#2` and its description with the requested child issue. The parent spec #1 is not a delivery ticket.

## Review before a human merge decision

```text
Use $issue-delivery for the next eligible issue in rtfa1/shymask. Implement, open a PR, and run the independent review/fix loop. Stop before merging and report the PR, reviewed head SHA, evidence, and remaining merge gates.
```

## Resume

```text
Resume the existing $issue-delivery run for rtfa1/shymask issue #2. Read its checkpoint, verify lock ownership, reconcile live issue/PR and worktree state, and continue from the first unmet gate. Preserve the original run scope and merge authorization. Re-review any changed code or base.
```

## Bounded queue

```text
Use $issue-delivery for at most three eligible issues in rtfa1/shymask, sequentially. Use a separate worktree and PR per issue. Delegate implementation, independent review, and fixes. Merge each only after its gates pass; then re-evaluate live dependencies. Stop when three are merged, no eligible issues remain, or a run requires my input.
```

## Final live acceptance

```text
Use $issue-delivery for the final physical-webcam and human-acceptance child issue in rtfa1/shymask. Verify all its current blockers are closed and replay-based development checks are ready before requesting my webcam or live participation. Keep unperformed live checks incomplete and distinguish laptop results from desktop results. Stop without merging if required acceptance is unavailable.
```
