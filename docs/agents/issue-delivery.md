# Issue delivery in Codex

Run one coordinator chat in the Codex app. It delegates work to subagents and uses the `gh` CLI for `rtfa1/shymask`, as configured in [issue tracker](issue-tracker.md). No external orchestrator or recurring service is required. Discover the actual build and check commands from the repository as implementation evolves.

## Start and resume

Open this repository root as the Codex project and use a prompt from [delivery prompts](prompts/issue-delivery.md). If skill discovery has not refreshed, explicitly ask Codex to read `.agents/skills/issue-delivery/SKILL.md`. Resolve role definitions as described below; their presence under documentation does not register custom agents automatically.

The normal run delivers one issue, then stops. A queue run needs an explicit issue-count limit. A setup request installs the workflow without picking up work, publishing comments, opening PRs, or merging. Invoking delivery authorizes the issue claim, branch push, PR creation, review comments, and merge within that issue's scope unless the invocation narrows it (for example, stop before merge). Tool permissions and GitHub rules still apply.

This is an agent-driven procedure, not an always-running service. Keep the app and machine available during local execution. No recurring automation is installed. Follow an active run in its coordinator chat; after interruption, use the resume prompt.

## Roles and execution

| Role | Work | Output |
| --- | --- | --- |
| Coordinator (primary chat) | Select, claim, isolate, delegate, publish, verify merge gates | Run checkpoint and final outcome |
| `delivery_implementer` | Implement the issue and collect acceptance evidence | Commit, requirement mapping, checks and gaps |
| `delivery_reviewer` | Independent review using the existing code-review skill | Standards and Spec reports, head SHA, verdict |
| `delivery_fixer` | Resolve review findings and verify affected behavior | New commit, finding resolutions, checks and gaps |

The authoritative role definitions live in `docs/agents/config/`: `delivery_implementer.toml`, `delivery_reviewer.toml`, and `delivery_fixer.toml`. Preserve the parent session's model, reasoning effort, permissions, and tool access. The primary chat owns all GitHub writes and merges. Workers modify only the assigned worktree. The reviewer keeps the tree unchanged and delegates the two review axes with fresh contexts as required by `.agents/skills/code-review/SKILL.md`.

Allow one writer at a time. Finish implementation before review; finish review before fixes. Review needs one reviewer and two read-only axis agents concurrently, in addition to the primary chat. Check the available capacity rather than assuming a configured limit. Retire completed workers using client lifecycle controls when available; reuse the same fixer on follow-up fix rounds rather than creating redundant workers. If retained threads exhaust capacity, checkpoint and stop for a fresh coordinator chat rather than substituting self-review.

If the client cannot select a named custom agent, parse the corresponding TOML and supply its `developer_instructions` verbatim to a general subagent, along with the task's evidence. Use fresh review contexts (`fork_turns: "none"` where supported), supplying the required artifacts explicitly. If independent delegation is unavailable, report the blocker rather than self-approving.

Only the primary chat enters coordinator steps. Delegated agents perform their assigned role and return evidence. Review-axis prompts must explicitly require read-only inspection, no GitHub mutations, and no further delegation; they do not enter the delivery workflow themselves.

## Selection and claiming

1. Read current GitHub issue bodies, labels, comments, native blocking relationships, and linked PRs. Paginate searches until complete. Search snapshots with missing state or labels require a full issue fetch. Local ticket copies aid navigation; GitHub is authoritative.
2. Eligible issues are open, labelled `ready-for-agent`, sufficiently specified, and have every blocker closed. Fetch native blocking edges using the tracker API (`gh api`) and also honor explicit textual blockers. A `ready-for-agent` label alone does not mean unblocked. Exclude parent specifications with child delivery issues, including prototype issue #1, from selection. An explicit issue number still needs the same readiness checks.
3. Exclude issues already being handled by another active coordinator or PR. Resume the same run when its identity is known. Choose the oldest eligible issue, breaking ties by issue number. This ordering governs delivery runs; the tracker's map-order rule governs wayfinding sessions. If the invocation explicitly requests map order, apply it among eligible children. If none qualify, report blockers and stop.
4. Create a local exclusive run lock using an atomic create operation under the Git common directory, `issue-delivery/issue-<number>.lock`. Record the run ID, coordinator identity, absolute checkpoint path, and UTC timestamp. Worktrees of this repository share that lock. A lock remains across interruption and while a blocked run retains ownership; inspect the owner/chat and request a takeover decision when ownership cannot be established. Release it on `merged`, an explicit `stopped` run, or an explicit handoff. A resumed stopped run must reacquire the lock and recheck competing claims.
5. Assign the issue to the connected account and publish a claim comment containing the run identity, coordinator chat identifier when available, branch, and intended scope; read both back and recheck for competing claims before writing code. GitHub comments and assignees are advisory, not a distributed atomic lock: use one coordinator across machines. Use the [five triage labels](triage-labels.md); record delivery progress in comments/PRs rather than inventing status labels.

## Workspace and checkpoints

Verify the repository remote and discover its default branch rather than assuming `main`. Fetch the current base. Create an isolated worktree under `.worktrees/issue-<number>-<run-id>` on a unique `codex/issue-<number>-<slug>` branch (add a suffix on collision). Record absolute worktree path, base branch, and base SHA before dispatch. Create worktrees through Git inside the current chat; a user-owned sidebar chat is unnecessary.

Keep the original checkout's uncommitted files intact. A fresh worktree contains committed files only: if required workflow, skills, glossary, or decision records are still uncommitted, resolve that prerequisite before dispatch. Commit only already-authorized setup changes when authorized to do so; otherwise report the missing prerequisite. Do not silently copy uncommitted source or claim the isolated worktree contains it. Stage only changes belonging to the selected issue in the delivery worktree. Reuse a recorded worktree on resume after verifying its branch, status, and remote head. Obtain the video fixture through its documented acquisition/setup process; do not commit local recordings or large media merely to make another worktree run.

Store a local checkpoint at `.issue-delivery/issue-<number>.json` in the coordinator checkout. Locate it through the shared lock's absolute checkpoint path when resuming from another worktree. Update after each transition and before ending a turn. Include:

- Repository, issue URL, run ID, coordinator identity, lock path, UTC update time.
- Worktree path, branch, base branch/SHA, current head, PR URL/number.
- Phase: `claimed`, `implementing`, `reviewing`, `fixing`, `ready-to-merge`, `merged`, `blocked`, or `stopped`.
- Invocation scope and merge authorization, fix-round count (maximum three).
- Acceptance evidence per criterion; checks with command, exit status, head SHA, and log location.
- Review reports with base/head SHA, verdict, findings and resolutions; unresolved blockers and next action.

Checkpoints are ignored by Git. Keep durable summaries in the authorized issue/PR comments; avoid credentials and unnecessary logs. After interruption, reconcile the checkpoint against live GitHub and Git state before proceeding. A checkpoint never proves that a merge or check succeeded. If the PR is already merged, verify that result and finish instead of creating another PR.

## Implementation and PR

Give the implementer the live issue and parent spec, applicable decisions, absolute worktree path, base SHA, relevant standards, and the Shymask validation requirements below. Require every acceptance criterion of the selected child issue to be classified as satisfied with evidence, incomplete, or blocked. A successful tool connection or build alone does not demonstrate processed preview, virtual webcam compatibility, or visual quality.

Once the worker returns, inspect its diff, commits, and evidence. Use `.agents/skills/pr/SKILL.md` when preparing the PR body. Link `Closes #<number>` only when the complete child issue can be resolved; partial or blocked work uses `Refs #<number>` and a draft PR. Record incomplete criteria explicitly. Push the issue branch and create or update the matching PR through `gh`, using a UTF-8 body file for multiline text. Read back its repository, base, head, and URL. Delivery of a child issue does not authorize closing its parent spec.

## Review and fixes

Pin the fetched PR base SHA and head SHA. Supply the reviewer with the absolute worktree path, full diff/commit range, live issue and parent specification, acceptance evidence, and known checks. Pass the base SHA as the explicit fixed point required by the code-review skill. Review the full PR diff after each fix, including correctness, regressions, and meaningful test coverage. Resolve truncated patches by fetching the remaining files.

The reviewer reports Standards and Spec separately, preserving that skill's reports and summary. Append a delivery verdict: `PASS`, `CHANGES_REQUESTED`, or `BLOCKED`, the reviewed base/head SHAs, actionable findings with file/line and evidence, and acceptance gaps. Evaluate completion against the selected child's slice and the parent constraints applicable to that slice; later child features and final live checks do not block an earlier slice unless its own criteria require them. A missing specification or required unrun validation is `BLOCKED`. Style heuristics are advisory unless supported by a concrete consequence or a documented requirement. Every actionable finding needs a fix or an evidence-backed disposition accepted by the reviewer.

Publish the reports as PR conversation comments identifying the reviewed SHAs. Agent roles share the connected GitHub account; a clean agent review is recorded evidence and cannot satisfy a required approval from another account. Keep required GitHub approvals as a separate merge gate.

For `CHANGES_REQUESTED`, dispatch a separate fixer with the issue, findings, worktree, and expected head. The fixer changes only the issue branch, checks affected behavior, and maps each finding to a commit or reasoned dispute. Push the new commits, invalidate the old PASS, and return to independent review. The reviewer adjudicates disputes; the coordinator cannot silently discard findings. After three fix rounds without PASS, stop with the remaining findings. Authentication failures, unavailable required builds, human checks, and unresolved design decisions produce a blocker rather than a retry loop.

## Merge gates

Before merging, the coordinator independently verifies all of these against current state:

- Complete acceptance evidence and a PASS review for the exact current PR head and current target-branch base. If the target branch changed since review, integrate the current base, rerun affected validation, and review again.
- All required repository checks pass for that head and required GitHub approvals are present. Inspect check results and branch rules through `gh`, using its API access when necessary. Unknown requirements or results block merging. If no CI is configured, explicitly record that fact and require relevant local validation; never call absent checks passed.
- No unresolved actionable review threads, draft state, merge conflict, changed issue scope, or human acceptance gap. Read fresh PR comments as well as the agent report.
- The run's merge authorization remains valid. Respect an instruction to stop before merge. Use the repository's permitted merge method, preferring squash when allowed. Never use an admin bypass or change protections to get a merge through.

Immediately re-read target-branch and PR state, then submit the merge with the expected reviewed head SHA (`gh pr merge --match-head-commit`). A moved head invalidates approval and returns to review. A changed base also requires the base revalidation above; head matching alone does not guard base changes. Use a configured merge queue or server-enforced up-to-date checks when required by the repository. GitHub's direct merge API has no expected-base parameter, so without server enforcement there is a residual race between that final base read and merge. Record this limitation in the run; if the invocation requires atomic base enforcement, stop before merging until repository protections provide it. Do not claim the direct API atomically pins both SHAs.

Read back the merged PR and merge commit. Post the issue resolution evidence before an explicit close; if a closing PR already closed the issue, add the evidence and verify its state. Close only fully satisfied issues. Record `merged`, release the lock, and report issue, PR, merge SHA, checks, and remaining limitations. Preserve worktrees and branches unless cleanup was requested. Start another issue only within an explicit queue limit.

## Shymask validation requirements

The live [prototype spec #1](https://github.com/rtfa1/shymask/issues/1), selected child issue, root glossary, and architectural decision records are authoritative. Read the glossary and relevant decisions through [domain guidance](domain.md). Fetch current child relationships and blocking edges instead of assuming a fixed queue or completion count. The spec covers a Windows 11 virtual webcam first and macOS later; the tracker, renderer, and package format are engineering choices to validate, not a preselected game-engine stack.

### Recorded input during development

Use a prerecorded webcam-style video in a real-time loop as the default development input. The initial video/preview slice establishes acquisition, usage terms, repeatability, motion coverage, and valid processing timestamps. Later slices extend that same processing path through tracking, effects, paused-output policy, preview, and virtual webcam publication. A preview-only slice is complete against its own criteria; it must not claim later virtual webcam or motion capabilities.

Develop and validate without asking the user to connect a physical webcam or act as a live test subject. Missing or invalid fixture input produces an actionable setup error and hidden output; never silently activate a physical webcam. Use controlled recorded scenarios or failure injection for tracking loss, multiple faces, and rendering failures. Document loop seams and any deliberate resets. Preserve the same processing path for the eventual physical-camera adapter.

### Observable output and evidence

Test at the highest public-workflow boundary available in the selected slice: use app controls, import effect packages where supported, and observe preview and virtual webcam output. Prefer complete behavior over internal-call assertions. Verify Zoom, Google Meet, and OBS individually when the slice requires compatibility; a successful generic consumer or screenshot is not evidence that all three work.

Apply the failure policy from the architectural decisions: tracking/effect failures hide the entire image behind the opaque "Tracking paused" output in both output paths. Include readiness, no active effect, switching interruptions, manual pause, multiple-face handling, and automatic recovery as those capabilities land. Partial masks, distortion, and other face-revealing effects are allowed during normal operation; this is a failure fallback policy, not an anonymity guarantee.

For motion work, inspect recorded turns, nods, and leaning for face anchoring, face-based occlusion, and reactive ears or hair. For authoring work, demonstrate the external AI-assisted Blender -> validated declarative effect package -> import -> playback flow. Playback runs independently of Blender and the AI harness. Unreal authoring, Snapchat Lens imports, arbitrary executable effect code, hand-over-mask occlusion, and full strand-level hair simulation are outside the prototype scope.

The performance targets are 720p/30 FPS and no more than 100 ms added processing delay, excluding call-network delay. Measure frame pacing and stalls as well as average FPS, with a target call/stream app running when required. Record hardware, workload, source mode, measured boundaries, commands, and the exact tested head SHA. Label replay-based results clearly; they do not establish physical-camera compatibility or camera-sensor-to-output latency. Desktop success does not establish integrated-graphics laptop suitability.

### Final live acceptance

Request a real webcam and human participation only once the blocking replay-based work is ready and the final live-acceptance slice is being delivered. Verify its current prerequisites and scope in the tracker rather than hard-coding an issue number. Keep required but unavailable real-person checks incomplete and block completion/merge of that slice. Where its criteria allow unavailable laptop hardware to be reported as unverified, record that limitation explicitly rather than claiming a pass. Earlier slices do not inherit the final slice's human-participation gate.

Keep the parent spec open as child issues are delivered. Record missing application access, hardware, measurements, or acceptance evidence honestly; a tool connection, build, or simulated input cannot substitute for evidence it did not produce.

## Configuration references

The role TOMLs use the standalone fields documented in the [official OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents). Codex discovers project custom agents under `.codex/agents/`; this repository keeps its authoritative definitions under `docs/agents/config/` and supports the explicit general-subagent fallback above. Do not claim those documentation files are auto-registered. This setup does not install a project model override, MCP endpoint, permission override, or background service. Use available tools appropriate to the selected slice; Blender is relevant to authoring work, not a prerequisite for every app ticket.
