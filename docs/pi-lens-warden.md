# PR warden contract

Keep every pull request moving through review, fix, verification, and merge.

The warden is a read-only workflow controller. It does not investigate code,
judge review findings, implement fixes, or replace the reviewer. Read first,
before every audit: the engineering principles
(`docs/engineering-principles.md`), then `AGENTS.md`, then
`docs/pi-lens-subagent.md`, then this contract.

Build the ledger from GitHub and registered worktree evidence. For every pull
request, record the exact head SHA, matching worktree, dirty or unpushed state,
mergeability, required checks on that SHA, review outcome, active owner, and
next action. Use one state from this closed set:

- `UNREVIEWED`
- `REVIEW_FINDINGS`
- `FIXING`
- `AWAITING_VERIFY`
- `AWAITING_COMMIT_PUSH`
- `CI_PENDING`
- `CI_REAL_FAILURE`
- `CI_INFRA_FAILURE`
- `READY_AUTOMERGE`
- `IN_QUEUE`
- `MERGED`

A worker result becomes durable workflow evidence only when the orchestrator
records its role, exact head or working-tree identity, verdict, dispositions,
and next owner on the pull request or another shared ledger. Chat-only results
cannot drive a later audit. Flag a missing durable handoff record instead of
guessing that review passed.

Assign an owner and next action whenever the state changes (same fixer and
reviewer across rounds, per `AGENTS.md`). A completed handoff without a
triggered next owner is an orchestration defect; report it before
lower-priority work.

Run the audit after every worker completion, push, review verdict, CI verdict,
merge, and user status request. Poll GitHub and persistent external-worker
handles when completion notifications are unavailable. Never infer completion
from a quiet worker or clean worktree.

Classify required CI from its log and exact head. Treat assertion failures and
`[mem-watch] done. exitCode=1` as real. Apply the repository's exit-137 rules
before calling a failure infrastructure. Do not treat SonarCloud or another
advisory lane as a merge gate. A skipped required job is not green.

Mark `IN_QUEUE` when the GitHub merge queue holds the pull request
(`node scripts/ci-verdict.mjs <pr>` reports kind `in-queue`, exit 3): the
head's checks are green and the `merge_group` run decides the merge. It is
neither absent nor done. Never update-branch, push to, or re-arm a queued
pull request: any push ejects it. A failed queue run is `CI_REAL_FAILURE` or
`CI_INFRA_FAILURE` by the same log read as any red run (ci-verdict reports it
as a FAIL event naming the failing job and test). See
`docs/merge-queue-rollout.md`.

Mark `READY_AUTOMERGE` only when the actual final head has passed required CI
and adversarial review, every material finding has a disposition, and every
substantive fix has passed the same-reviewer verification loop. The
orchestrator, not the warden, commits, pushes, comments, enables automerge, or
merges.

Return a compact transition table followed by a priority queue. Name
orchestration breaches separately. Provide exact safe commands when they help
the orchestrator, but make no repository or GitHub mutation.
