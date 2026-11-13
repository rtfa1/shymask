---
name: issue-delivery
description: Deliver a GitHub issue through delegated implementation, independent review, fixes, and merge; resume a delivery run or process a bounded issue queue. Setup requests only configure the workflow.
---

# Issue delivery

Act as coordinator in the primary session. Read the authoritative procedure at
`docs/agents/issue-delivery.md` before selecting work or performing delivery mutations.
Read `docs/agents/issue-tracker.md` for the configured repository and GitHub CLI operations.
For setup-only requests, install or update the workflow and stop before claiming an issue.

## Execute

1. Establish invocation scope: one issue by default, an explicit maximum for a queue,
   and any stop-before-merge instruction. Reconcile an existing checkpoint on resume.
2. Fetch live issue readiness, dependencies, comments, and linked PRs. Select an eligible
   child issue, acquire the shared local lock, and publish/read back the claim.
3. Create or verify the isolated worktree, issue branch, base SHA, and checkpoint.
   Required uncommitted setup files are a prerequisite to resolve before dispatch.
4. Spawn a separate `delivery_implementer` agent with the absolute worktree path,
   live issue and parent spec, pinned base SHA, applicable standards, acceptance criteria,
   and the procedure's Shymask validation requirements.
   Wait for its commit and evidence; inspect both before publishing the PR.
5. Push the branch and create/update the PR using the existing `pr` skill for its body.
   Pin the PR base/head and spawn an independent `delivery_reviewer`. It invokes the
   existing `code-review` skill with the base as the explicit fixed point, delegating
   Standards and Spec to fresh parallel subagents. Wait for all review results.
6. Publish the review report. For actionable findings, spawn a distinct `delivery_fixer`,
   wait for its evidence and commit, push, and return to review of the full current diff.
   Keep one writer active. Stop after three fix rounds without PASS or a concrete blocker.
7. Independently verify every merge gate in the procedure. Merge only with current
   authorization, the reviewed head SHA, current base validation, and satisfied checks,
   approvals, and acceptance criteria. Verify the merge and issue resolution by read-back.
8. Save the checkpoint, release the lock on completion, and report issue/PR links,
   merge SHA or blocker, checks, and remaining limitations. Continue only within the
   explicit queue limit.

Use custom agents from `./docs/agents/config`; if role selection is unavailable, provide the
corresponding TOML instructions to general subagents. These files are role definitions,
not an automatically registered Codex agent directory. Supply fresh review contexts
and enough evidence to reproduce findings. Independent delegation is required for PASS.
Keep remote writes and merge decisions in the coordinator. Tool approvals and repository
protections remain in force; workflow instructions do not bypass either.

Example user prompts are in `docs/agents/prompts/issue-delivery.md`.
