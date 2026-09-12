---
name: merge-train
description: Run the pi-lens review → verify → merge policy over one or more open PRs. Use when asked to land a PR, babysit the merge queue, or process review backlogs. Encodes the standing quality gates so any session applies the same discipline.
---

# Merge train

> Source of truth for every rule below is `AGENTS.md` ("Role contracts for
> delegated work" → "Orchestrator rules", plus the defect catalog). This file
> is the procedure and the record; on any conflict AGENTS.md wins.

The policy that landed the 2026-08-17 arc (11 PRs, every one adversarially
reviewed, zero unreviewed merges). Apply it to each PR in the queue.

## The loop, per PR

1. **Review.** Spawn `pi-lens-reviewer` (worktree isolation) with the PR
   number, a one-paragraph summary of the claim, and any PR-specific attack
   angles. Self-authored and small PRs get reviewed too — the depth follows
   the review tier below, never the priority label.
2. **Fix rounds.** Send findings back to the PR's original author agent when
   its worktree survives (SendMessage — cheapest context); otherwise spawn
   `pi-lens-fixer` on the branch with the findings inlined.
   **Since #2486, `SubagentStop` REAPS the stopped agent's own worktree**
   (maintainer decision, 2026-09-02, reversing the earlier "never removes
   here" rule, which left ten stale trees in one afternoon). So by default an
   agent's tree is gone the moment it finishes, and SendMessage to it lands on
   a branch with no checkout. Its branch survives — a tree is never removed
   unless its HEAD is already in an `origin/*` ref — so nothing committed is
   lost and a fresh `pi-lens-fixer` on the branch always works. If this
   session intends to resume fixers by SendMessage, export
   `PILENS_HYGIENE_KEEP_AGENT_TREES=1` for the session (or add
   `--keep-agent-tree` to the registered hook) and the reap is off.
   Kept trees are then reaped by the `SessionStart` sweep —
   which runs on `startup` and `resume` only, not on `/clear`, compaction or a
   fork — once they have been idle ≥30m and are clean and pushed. Idle is
   measured from the checkout directory and the worktree's HEAD (and its
   reflog), never from the git index, so the sweep's own dirty check cannot
   make a finished tree look busy.
   A tree with uncommitted work, or with work not yet on an `origin/*` ref, is
   never removed at any age, by any sweep — so a fix round in flight is safe by
   its own state, not by the clock.
3. **Verify.** The SAME reviewer verifies each fix round with its own probes.
   Do not take the fixer's word; do not swap reviewers mid-PR. A reviewer's
   worktree is an `agent-*` tree too, so once its report lands the tree is
   clean+pushed and `SubagentStop` reaps it exactly like a fixer's — a
   SendMessage resume finds no checkout, same as above. Recreate it: the
   merge-train practice is a FRESH reviewer worktree per VERIFY round, not a
   kept one. Continuity is the reviewer AGENT (SendMessage still reaches the
   same identity, so the same judgment and probes carry over); the checkout
   under it is expected to be rebuilt each round, not preserved. Do not set
   `--keep-agent-tree` / `PILENS_HYGIENE_KEEP_AGENT_TREES=1` merely to dodge
   this — that decision stays off by default (see step 2).
4. **Merge gate.** Merge only when: verdict is merge-ready; every gating check
   genuinely EXECUTED and passed on the exact head SHA
   (`node scripts/ci-verdict.mjs <pr-number|sha>` — a DIRTY PR silently skips
   them, absent is not green); every failing check
   was read and judged (infra failures — codeload 429/503, SARIF-upload
   errors, Initialize-CodeQL outages — may be waved through only with the
   log read and the judgment recorded).
5. **Merge.** `gh pr merge <N> --merge` (merge commit, repo convention).
   If "not up to date", `gh api -X PUT .../pulls/<N>/update-branch`, wait for
   CI, re-gate, merge. On GitHub 503s: retry with backoff, never switch to
   raw-API merge endpoints.
   Alternative, once the verdict is in: apply the `train:approved` label (add
   `train:squash` for a squash merge) and let the merge-train lane workflow
   land it (#2185). The lane merges only when both required checks have
   CONCLUDED success on the exact current head, so a fix round pushed after
   labeling re-gates itself. Removing the label aborts. Steps 1 through 4 are
   unchanged: only the maintainer applies the label, and only after the
   review verdict.
6. **After each merge.** Master moved: check other open PRs for BEHIND/DIRTY,
   check in-flight agents for file overlap with the merged diff and nudge
   affected ones to merge origin/master before their next push.
   Then prune the lane — and ONLY the lane: the merged-ness test is "this
   tree's branch is the head of the PR just merged" (`gh pr view <n> --json
   headRefName`), never `merge-base --is-ancestor`: a live fixer's branch
   with no commits yet passes the ancestor test, and on 2026-09-06 that
   removed #2358's tree with its uncommitted work. `git worktree remove` every tree on the merged
   branch (fixer AND reviewer trees, wherever they were created) and delete
   the merged local branch. A lane's tree lives until its PR merges, not
   after — the orchestrator owns this step; the reaper only sees
   `.claude/worktrees/agent-*`, and on 2026-09-06 twenty-one merged trees
   were still standing at the regroup.

## Queue ordering

Order by dependency, not age: a PR whose schema/API another PR must consume
merges first (the consumer then rebases and wires the new surface). Two PRs
editing the same file get an explicit order decided up front. Log-schema
changes must extend exact-key pins (`BASELINE_KEYS`-style), never loosen them.

## Quota gate (orchestrator)

Before ANY new dispatch (not a fix round on an open PR): know the account's
5h and weekly usage. Above 75% of the 5h window or 85% of the weekly window,
no new work — finish in-flight lanes and merge on green. The numbers are
readable live: `GET https://api.anthropic.com/api/oauth/usage` with the OAuth
token from `~/.claude/.credentials.json` (`anthropic-beta: oauth-2025-04-20`)
returns `five_hour.utilization` / `seven_day.utilization` and reset times; the
`~/.claude/hooks/quota-gate.mjs` PreToolUse hook on `Agent` reads them and
blocks dispatch above the thresholds (no hand-written fallback;
`QUOTA_GATE_OVERRIDE=1` lifts it when the maintainer says so). Read the meters at session start and before
every refill; state them in the lane ledger. Standing rule from
2026-09-03, lifted only when the maintainer says so.

## Brief contract (orchestrator)

Before dispatching any issue that adds a shared helper or seam: grep for
same-shape siblings yourself and write the fold into the SAME slice, or write
the sibling list, the reason folding is unsafe in one PR, and the follow-up
issue into the brief. AGENTS.md's net-count rule binds the brief author; the
fixer and reviewer only enforce what the brief scoped. #2530 shipped a fifth
bound helper because the brief deferred the fold without a reason.

## Filing issues (orchestrator)

Every `gh issue create` carries one TYPE label, at least one `area:*`, and
exactly one `priority:p1|p2|p3` (AGENTS.md #1676 rubric). The priority labels
were found deleted from the repo on 2026-09-03 and recreated (#2553); an
issue filed without one is a triage defect, not a shortcut.

## Round-count rail (orchestrator)

When a verify round reports that a fix round introduced a NEW defect on the
same record or seam (not merely left one), the next fix brief opens with
AGENTS.md's state-space step — invariants, writers × axes, the cell list —
written into the PR body BEFORE any edit, and the fixer is Opus. Never send a
third patch-only round: #2528 went r2 → r3 → r4 on one cache record, each
round fixing three findings and adding two, until the model was demanded.

## Orchestrator invariants (any orchestrator, not only Claude)

These are the habits the train depends on. They live here, not in any one
operator's private notes, so a different orchestrator can run the same train.

- **Contracts move in the same session.** When a review or a dogfood finding
  reveals a defect CLASS (not an instance), add a numbered shape to AGENTS.md's
  catalog with the issue ref and a one-line screen, extend the fixer's screen
  list, and cite the number in the next brief — before the next dispatch. "To
  err twice is not the mark of a wise man." (2026-09-03: shapes 28–36 came out
  of one day's reviews this way.)
- **Second instance of a catalogued shape opens the consolidation lane, not a
  third instance fix (2026-09-09).** The trigger is the shape recurring at all,
  not only twice in one session: when a review, an issue or a dogfood finding
  is the second member of a shape already in AGENTS.md's catalog, the
  orchestrator files the consolidation lane BEFORE the second instance merges,
  with three fixed deliverables: one seam every consumer calls, one log line
  per resolution (which value was chosen and why, throttled once per key per
  session), and one bounded degradation record for the fallback path. The
  record: #2691 (yamllint cwd) and #2756 (Prettier ignore cwd) were shape 40
  twice in one week; each was fixed at its own seam with no log line, and the
  maintainer had to ask for the seam (#2777). "Contracts move in the same
  session" covers the catalog row; this rule covers the code.
- **An external bug's first round is the probe, not the fix (2026-09-09).**
  For any bug reported from outside (or any bug whose symptom is a tool
  verdict), the first delegation is an investigator or a fixer whose FIRST
  deliverable is the reporter's symptom reproduced through the production
  entry point (the tool handler / MCP tool, not a seam beneath it), red on
  master, before any state-space table or edit. A fix brief that names a
  suspected seam is a hypothesis and says so. The record: #2776 spent seven
  fixer rounds on `clients/lsp/client.ts` (pull-vs-push classification) —
  each internally consistent, each verified — before a premise probe through
  `LSPService.touchFile` showed master already returned the pushed
  diagnostic; one investigator round through `createLspDiagnosticsTool`
  then found the real cause in `tools/lsp-diagnostics.ts` (primary/auxiliary
  partition by `diagnostic.source`). AGENTS.md "premise first" already said
  this; the train had been dispatching fixers on the orchestrator's guess.
- **Every "should have been caught by" names a nightly or smoke row, and
  the row is filed the same day.** A detection retrospective that ends in
  prose is not a retrospective. #2776 (emmylua_ls declares pull diagnostics
  but only pushes → false "confirmed clean") was reachable by a
  declared-vs-observed channel probe the capability matrix never ran, and by
  the custom-`lsp.servers` population the matrix never covers.
- **Brief pre-flight by touched surface (2026-09-09).** Before dispatching a
  fixer, read what the fix WILL touch and put the matching dependents into the
  brief's required test set. Every row below cost at least one extra round
  today because the fixer ran only "targeted files":

  | Fix touches | Brief must name |
  |---|---|
  | a new export on a module that has `vi.mock` doubles | every test file that mocks that module (`grep -rl 'vi.mock(".*<module>' tests`), run them all — #2782 r1: 30 reds in 6 files |
  | a field on a durable or shared record (cache entry, diagnostic, ledger row) | old-record parse proof, cache schema version, and every test that deep-equals or snapshots the record — #2783 r1/r3 |
  | a test that spawns a real child (LSP fake server, tool smoke, installer) | the lane admission (header + `vitest.config.ts` project + coverage baseline) and `tests/config/` — #2783 r5 |
  | a new fixture under `tests/fixtures/` | the fixture-contract sweeps for that directory (style-preserving, population guards) — #2782 r2 |
  | a changelog fragment | exactly one top-level entry, never `CHANGELOG.md` — #2775 r4, two hand-edits today |
  | a raw poll in a test | the flake-shape ratchet; the fix is the governed wait, never a header admission — #2781 r1 |

- **Sandbox by test shape (2026-09-09).** A lane whose tests spawn children
  (LSP fake server, tool smoke, installer, formatter wire) is dispatched with
  the runner's full-access mode from round 1. #2781 spent four rounds with a
  fixer that could not run its own wire tests and reasoned about ordering
  instead of observing it; the first full-access round found the cause in
  one pass.
- **A CI-only red is reproduced in the job's shape before any fix.** Replicate
  the job env (the `npm test` PATH prefix with `node_modules/.bin`, a pinned
  `HOME`, no `PI_LENS_HOME`) and trace the leg that differs; a fix that only
  passes under `node_modules/.bin/vitest run` is a guess. #2775 carried one
  CI-only red through three rounds until round 5 traced it to the npm PATH
  prefix resolving the dev-dependency `oxfmt` past the mocked `which`.
- **Follow-up rounds go to the same worker by send, not a fresh delegation,**
  while its handle is alive: it keeps the diff and the reasoning, and the
  brief shrinks to the findings. Release only when the lane moves to review.
  A fresh worker on a resume loses uncommitted work.
- **Fleet inventory at every settlement.** A one-shot watch misses anything
  that settles while it is disarmed: after each settlement,
  list live workers and read every `done` handle not yet consumed. Two lanes
  sat finished for 90 minutes today.
- **Keep a lane ledger.** One file, one row per lane: issue/PR, worker id,
  round, state, head SHA, merge-order note, and for bug lanes
  `caught by / should have been caught by`; a header line with the quota
  reading and the merged list. Update it on every dispatch, report and merge.
  It is what survives a context reset. `state` is one of exactly:
  `not started`, `fixing rN`, `waiting on CI`, `waiting on review`,
  `waiting on verify`, `blocked`, `ready to merge`, `merged`,
  `needs user decision`, `held` — a fixed vocabulary so a resumed session
  (or a different orchestrator) can build the status table without reading
  the transcripts, and so "needs user decision" and "held" are visible as
  rows rather than buried in prose. (Borrowed 2026-09-07 from the heartbeat
  classification in aromanarguello/roman-skills `orchestrate-lane`.)
- **A lane's worktree lives until its PR merges.** Pruning it after a report
  makes the owning worker un-resumable, so every fix round then costs a fresh
  worker. Prune on merge, or when the lane is abandoned.
- **Scope changes are mirrored on the issue before they are sent.** A fixer
  cannot verify a mid-task `SendMessage`; it CAN verify an issue comment.
  Post the comment first, then send the message pointing at it (the fixer
  playbook says to check). Unmirrored additions are declined by design.
- **Dependabot PRs merge on real checks, no issue needed (maintainer,
  2026-09-07).** The PR-title issue-ref gate is a policy check this train
  applies to human PRs; a bump title can never carry a ref. Merge order: one
  at a time (each merge dirties the rest; dependabot rebases them itself);
  gate on Lint, Unit tests and every non-advisory check on the exact head;
  lint.yml and close-keywords.yml themselves skip "PR title", "PR body
  (advisory)" and "Close-keyword syntax" for dependabot (2026-09-09, refs
  #2714), so nothing needs hand-ignoring; hold anything red on a real check
  with a comment naming the check (2026-09-07: tsls 6 needs a Node-floor bump, biome
  fails the install test, vitest 5 fails four gates; a bump whose install
  script is pinned by `allowScripts` needs the pin moved in a maintainer
  commit on the bump branch). A major bump with peers (vitest + coverage-v8)
  lands together or not at all.
- **Detector, ratchet and governance-sweep authoring goes to Opus from
  round 1.** Their correctness lives in parsing edge cases, exactly where the
  smaller model loses: #2693 took two Sonnet rounds (~720k tokens) on a text
  scanner before the rail sent round 3 to Opus, which rewrote it on the AST
  and closed in two rounds.
- **Brief shape for a fixer.** Issue/PR number and head; the checked-out
  branch; the exact findings with file:line, the reviewer's probe to reproduce
  FIRST, and the remedy shape the maintainer chose; what to fold (net-count)
  and what stays out; the suites to run (named files + the mechanical
  governance selector + every tests/config file); the observability record to
  name; "no agents, foreground runs, one CI read, no monitors". Brief a
  reviewer with the PR number, the claims as the fixer stated them, and the
  attack angles that matter for THIS diff; ask for a verdict first.
- **Round routing.** Fix rounds that only apply a reviewer-prescribed remedy
  with quoted reds merge on green (CI read on the exact head, both required
  checks, mergeable state). Rounds that add mechanism, touch session or
  lifecycle semantics, or rewrite a guard get a fresh verify. Classify the
  round by its worst finding, not its count: a round whose findings are all
  contract (body text, docstrings, a record added WITH its test, a test
  added for an existing behaviour) merges on green — #2647 r2 is that shape;
  a round with one behaviour finding (a verdict, a guard direction, a
  lifecycle hook, a failsafe) gets the same-reviewer verify — #2649 r2 and
  #2654 r2. Say which in the fixer brief so the reviewer is not re-armed by
  reflex. A verify that
  reports a NEW defect triggers the round-count rail above.
- **Retargeting a PR's base does not re-arm CI.** `ci.yml` fires on
  `opened`/`synchronize`/`reopened`; `gh pr edit --base` is an `edited`
  event, so the required checks stay ABSENT and `ci-verdict` reports "absent,
  treating as pending" — exit 3, not 0; the "exit 0" first recorded on #2664
  was `$?` read after a `| tail`. After a retarget, push a commit or
  close/reopen. Read exit codes without a pipe. The merge loop is
  `node scripts/ci-verdict.mjs <pr> --wait <seconds>; echo $?` — 0 merge, 3
  still pending (re-arm the wait), anything else read the table. Never
  text-match the table for `failure`: advisory rows (PR body, Vale)
  print `failure` while the verdict is green, and on 2026-09-07 that stopped
  the #2692 loop on a green PR.
- **Maintainer trailing commits** are for intent-free deltas only (a literal
  NUL byte, a false comment, a missing PR-body heading); anything that changes
  what code MEANS goes through a fix round.
- **Mechanical-only verdict (2026-09-07).** When EVERY finding in a review or
  verify is intent-free — a PR-body census the reviewer corrected, an inverted
  body sentence, a heading, a literal, a comment — the orchestrator applies
  them as trailing commits and merges on green: no fixer resume, no re-verify.
  That is one resume saved per such PR. One finding that changes what code
  means, however small, makes it a fix round; a fix round that exists anyway
  carries the mechanical findings with it (#2693 r2 carried F3–F5). Borrowed
  from the auto-fix-mechanical rule in aromanarguello/roman-skills
  `final-review`; NOT borrowed from it: auto-fixing null checks, error
  handling or cleanup hooks, which change meaning.
- **Reserve the catalog number at DISPATCH, not at write time (2026-09-12).**
  AGENTS.md's defect-shape catalog is a contended global counter: every brief
  says "append at the tail with the next free number", so two concurrent lanes
  both read the same tail and both claim it. #2946 and #2953 collided on 49;
  #2987 and #2988 are both still sitting on 49 with 50 and 51 already taken;
  and the same mid-list edits produced markdownlint MD029 three times in one
  day. The counter is the orchestrator's to allocate, not the fixer's to
  discover. When a brief authorises a catalog entry, name the exact number in
  the brief and record the reservation in the ledger beside the lane; when a
  lane is dropped, release the number there too. A lane must never pick its
  own. The same rule blocks the orchestrator: a docs change cannot claim N+1
  while an open PR holds N, because the gap reds MD029 on its own branch
  before the holder merges — stack it on that branch or hold it until the
  holder lands.
- **On a CROSS-REPOSITORY PR, `action_required` is not `absent` (2026-09-12).**
  A fork PR's workflow runs sit unstarted until a maintainer approves them, and
  `ci-verdict` correctly reports the required checks as absent and therefore
  pending. Absent because CI has not registered yet and absent because nobody
  approved the run look identical in the verdict table and are hours apart in
  remedy. Before treating a fork PR as "CI still coming", read the runs
  directly:
  `gh api "repos/<owner>/<repo>/actions/runs?head_sha=<sha>" --jq '.workflow_runs[] | "\(.id)\t\(.name)\t\(.status)\t\(.conclusion)"'`
  and approve each `action_required` run with
  `gh api -X POST repos/<owner>/<repo>/actions/runs/<id>/approve`. #2983 sat
  unapproved while the lane read it as a slow queue.
- **Read the advisory rows before merging, even though they never gate
  (2026-09-12).** The exit-code rule above is right and stays: never text-match
  the verdict table for `failure`, because advisory rows print `failure` on a
  green PR. But "does not gate" is not "carries no information", and filtering
  advisory rows out of your attention is a different mistake from filtering
  them out of the gate. `typos (advisory)` found a real defect in #2955's
  round-12 diff — a comment reading "without reding the file" — which the
  gating checks had no opinion about and which would otherwise have reached
  master. Gate on the exit code; read the advisory failures on the exact head
  before the merge and dispose of each one (fix as a trailing commit, or say
  why it is noise).
- **Detection retrospective on every merged bug fix (2026-09-06).** The
  catalog records the CODE lesson of a bug (a shape, a screen, a guard). Before
  a bug-labelled lane's ledger row closes, the orchestrator also records the
  DETECTION lesson in one line: which verification layer caught it (external
  user, reviewer probe, CI job, governance sweep, install/compat/tool smoke,
  dogfood, release gate) and which layer SHOULD have caught it earlier and at
  what cost. If that layer does not exist, file it as an issue with the bug as
  its named recurrence — the same standard shapes are held to. The ledger
  carries a `caught by / should have been caught by` column. Record: #2587's
  manifest entry escaped the package for four releases; a second registration
  path masked it, so the shipped defect was foreign-tree adoption, not absence
  — and no check ever asked a real pi which SOURCE a skill came from. The
  shape lesson went into AGENTS.md the same day; the layer lesson (a witnessed
  real-pi pass asserting source and path, #2606) surfaced only because the
  maintainer brought an outside skill in, and the first runner's count-only
  row would have passed the broken release.
- **Harvest every reviewer's "Could not verify" and "Named output".** Those
  sections hold the structural insights the probes could not close (a
  runIf-conditional guard, a smoke section that never ran on a real runner, a
  detector's boundary map). Each entry becomes, before merge, one of: an
  issue, a ledger note with a reason, or a line in the PR body. Silence is not
  a disposition.
  When a Named output becomes an issue the orchestrator declines or defers,
  the ledger note names a DURABLE reason (a measured cost, a dependency, a
  design decision with its date), never "not now"; otherwise the same
  candidate is re-harvested at the next regroup rather than silently dropped.
- **Debt pass at the regroup (2026-09-07).** Before prioritising the next
  cycle, run the repo's own dead-code and duplication tools over the files
  changed since the last release tag (`git diff --name-only v<last>..origin/master`;
  `npx knip` uses the config in package.json, Sonar's duplication gate is the
  CI form): every reviewer's "Named output" that named a re-derived seam
  (#2694: the call-site scan hand-rolled in three sweeps) is what this pass
  finds across lanes that no single review can see. Findings become issues
  with the file list, never release blockers, and test-seam duplication is
  IN scope — "Test infrastructure — reuse before you write" in AGENTS.md is
  the standing rule, so the borrowed skill's "test duplication is often
  intentional" exclusion is not borrowed. (Shape from aromanarguello/roman-skills
  `techdebt`.)
  Within that changed-file list, weight candidates by commit frequency since
  the last tag (`git log --since=<last-tag-date> --name-only --pretty=format: |
  sort | uniq -c | sort -rn`) so the pass follows the real hot spots rather
  than every touched file equally. A FULL-repo debt pass (not the diff-scoped
  one) carries a coverage contract: one ledger row per subsystem (id, files,
  status) and the pass is not closed until every row is filled or skipped with
  a reason. A debt-pass subsystem worker reports at most TWO materially useful
  simplifications, each with the deletion test answered, drawn from six
  candidate shapes: scattered booleans or nullable fields that permit invalid
  combinations (a state machine or discriminated union); repeated assumptions
  about an object shape (one typed model); duplicated branching a small map,
  registry or reducer would remove; unclear state or behaviour ownership (a
  module boundary); repeated scans or lookups a better collection or index
  would remove; lifecycle, concurrency or async state whose representation
  permits stale or contradictory state. Never force an abstraction; boring
  local code that is already clear stays. This cap is for
  debt-pass dispatch only and never applies to PR review, where every finding
  from CRITICAL to NITPICK is reported.
- **Session retrospective before the regroup.** One ledger block: what the
  maintainer had to bring in from outside, why the process did not surface it,
  and where the lesson was routed (contract, playbook, skill, issue). The
  2026-09-06 entry: the autoqa witness/reachability rules and the release-QA
  layer came from a maintainer link, not from the train's own retrospective
  on #2587.
- **Review tier follows what the diff touches, never the priority label
  (2026-09-06).** The record: the two most dangerous regressions of that day
  came from p3 follow-ups — #2595 (a 125 s stall on an awaited path, a latent
  crash) and #2604 (broke offline installs in r2, broke `npm install` on
  Windows in r3) — and both were caught only by full review; the p3s where
  review found nothing were the ones touching no production code.
  - **Tier A — full adversarial review, any priority:** anything under
    `clients/`, `tools/`, `mcp/`, `scripts/`, `.github/`, or a package
    manifest / lockfile.
  - **Tier B — one scoped review pass, scope stated in the brief:** tests-only
    diffs that are not governance sweeps or ratchets (those are Tier A: a
    guard is production for the train).
  - **Tier C — no reviewer agent:** docs, comments, rename-only, data files.
    Orchestrator read plus CI on the exact head.
  A prescribed-remedy fix round stays "merge on green" in every tier.
- **Same-seam siblings batch into the open PR (2026-09-06).** When a review
  finds a sibling of the same shape on the same seam, it goes into the current
  PR as another round — reusing the fixer's context and the reviewer's probes
  — when all three hold: same dependent sweep, remedy prescribed rather than
  designed, and the PR is not on the critical path of an external or p1 fix.
  Otherwise file it with the sibling list and the reason. The record: #2598
  out of #2599 and #2593 out of #2594 each cost a fresh fixer spin-up plus a
  fresh review (and #2604 then needed three rounds under a review that was
  already armed on that file); #2603 out of #2595 and #2592 out of #2585 were
  rightly separate (a new matcher; seventeen per-seam reads). #2596 was filed
  as a follow-up and closed as a duplicate — pure waste.
- **Refill order** when the quota gate is open: p1 first, then the queued
  follow-ups in ledger order, then the program work (#2421 → #2416 → #2383/#195).

## Disposition tables

Verify reports and fixer handoffs end with a per-finding disposition table
(defined in AGENTS.md "Orchestrator rules" and `docs/pi-lens-reviewer.md`);
read the worst cell to route the round.

## Honesty rules

- A finding is real when a probe proves it; a fix is real when the same probe
  passes and the regression test was red first.
- `closes` vs `refs` follows delivery, not optimism; leftovers get an issue
  comment before anything closes.
- After merging a `refs #N` PR, VERIFY the issue: read `gh issue view N
  --comments` and confirm a comment names the remainder. If the PR in fact
  satisfied every acceptance criterion, close N crediting the PR; if a
  remainder exists but is unnamed, post it. A `refs` PR with no remainder
  comment is how #1968 and #2355 sat open for weeks after their fixes
  landed (found 2026-09-02).
- Report what ran, what was skipped, and what CI must still confirm.

## Common mistakes (scan at task start)

Each row cost a lane at least once; the prose above carries the record.

| Mistake | Fix |
|---------|-----|
| Reading a CI verdict without checking the SHA it judged | `ci-verdict --wait` returned exit 0 for the PREVIOUS head seconds after a push (#2878 trailing, 2026-09-10); compare the verdict's SHA with `gh pr view --json headRefOid` before merging |
| Reporting "pushed" before `git log -1` shows the commit | Two trailing commits failed the pre-commit hook (changelog one-entry rule, unused vars) and the ledger/body already said pushed; verify the head, then write the row |
| Folding a worker's extra changelog fragment into an existing one | One fragment = one top-level entry (`rollup-changelog --check`); keep a second fragment separate or drop it |
| Accepting a worker's "pre-existing red on master" | Run the file on origin/master in YOUR environment before believing it; four workers reported env-specific reds as master reds (2026-09-10) |
| Letting a fix round enumerate cases instead of deriving the rule | #2877 took 7 rounds; the brief for a rule fix demands derivation from the source of truth (grammar table, measured host sequence) |
| Accepting a state-space table on its claims | Grep every test id in the table before accepting the round; #2877 r3 and #2868 r3 (2026-09-10) shipped 48–72-cell tables with zero real ids |
| Arming `plegma watch --next` after the lane already settled | The watch only sees settlements newer than itself; check `plegma_status` by handle first and process a done lane directly (three lanes sat settled for hours, 2026-09-10) |
| Pruning trees with `merge-base --is-ancestor` | Prune only trees whose branch is the head of the PR just merged (#2358's tree, 2026-09-06) |
| Retargeting a PR base and waiting for CI | `edited` does not fire ci.yml; push a commit or close/reopen |
| Reading `$?` after a pipe | `node scripts/ci-verdict.mjs <pr> --wait N; echo $?` on its own line |
| Text-matching the verdict table for `failure` | Key on the exit code; advisory rows print `failure` on green PRs (#2692) |
| Committing a worker tree with `git add -A` and a pathspec exclude | Check `git ls-files` for handoff files and scratch dirs before the commit; fold a second fragment (#2807, #2808, 2026-09-09) |
| Merging two green PRs that edit the same baseline or admission map in parallel | Serialise them and re-run that file's test on master between (#2816) |
| Reviewing a branch head that no longer carries master | Reviewer merges origin/master into the scratch checkout first; CONFLICTING is not reviewable (#2808 vs #2795) |
| Pushing docs, config or data straight to master without preflight | `npm run preflight` on the exact tree first; three master reds on 2026-09-09 |
| Nudging a capped small-model lane more than once | One continuation, then reassign to the strongest model (GLM lanes, 2026-09-09) |
| Waiting on CI for a bot-authored PR (github-actions nightly refresh) | A GITHUB_TOKEN push fires no `pull_request` run: required checks stay ABSENT forever; close/reopen the PR to fire them (#2801, 2026-09-09) |
| Leaving a design question to the fixer (where evidence comes from, which identity rule) | Decide it in the brief; #2900 oscillated three rounds (walker → findings → walker again) until round 4's brief fixed the evidence source (2026-09-10) |
| Guessing a lane's branch name when writing a brief | Read `gh pr view N --json headRefName` in the same command that builds the brief; plegma refused two dispatches on invented refs (#2908, #2898; 2026-09-10) |
| `git add -A -- . ':!<ignored file>'` in a chained command | The exclude pathspec on an IGNORED path makes `git add` exit 1 and the chain stops before the commit; use plain `git add -A` (ignored files never stage) and verify the index afterwards (2026-09-10, twice) |
| Treating a `ci-verdict --wait` exit as a CI verdict without reading it | Exit 70 = GitHub API unreachable; every armed wait died at once during two outages on 2026-09-10 — poll `https://api.github.com/` until 200, then re-arm one wait per PR |
| Merging a PR that arms a registry-membership guard without telling the other lanes | After #2924, every open PR that adds a formatter, LSP server or MCP tool needs a docs line in the same change; note it in the ledger and the next briefs (2026-09-10) |
| Judging master from the local checkout | `git fetch origin` and read `origin/master`; #2693 r1 reported a catalog row missing that had merged an hour earlier, and the orchestrator's own branch that morning was cut from a master six commits behind |
| Swapping reviewers between rounds | Same reviewer verifies; the probes and the mutation set are the continuity |
| Trusting the fixer's "CI green" | Read ci-verdict on the exact head SHA yourself; absent required checks are not green |
| A third patch-only round on one seam | Round-count rail: state-space table in the body first, Opus fixer |
| Merging a `refs` PR with no remainder comment | Post the remainder or close the issue crediting the PR |
| Dispatching independent agents one message at a time | All independent Agent calls in one message; the quota gate is read once before the batch |
| Resuming a fixer whose tree was reaped | Spawn a fresh fixer on the branch, or export `PILENS_HYGIENE_KEEP_AGENT_TREES=1` for the session up front |
| Sweeping a shape by grep-counting tokens | A ratchet reads the exact literal it governs (#2693: four sites counted, six real) |
| `npx <tool>@latest` inside the repo to measure something | It rewrote package-lock.json (108 deletions) on 2026-09-07; run one-off tools from a scratch prefix, and `git diff --stat` before every commit |
| `git add -A` in a worktree that links `node_modules` | The ignore rule `node_modules/` does not match a SYMLINK; #2703 committed one and broke the clean-clone install and the tracked-shadow test. `git add <paths>`, and `.gitignore` now says `node_modules` without the slash |
| Checking a branch out in the shared main tree for your own fix | Reviewers saw the checkout switch under them three times on 2026-09-07; use a throwaway `git worktree add` under the scratchpad, remove it after the push |
| `gh run rerun --failed` while the run is still in progress | GitHub refuses it; wait for the run to complete (poll `gh run view --json status`), then rerun, then re-read the verdict |
| Reading a failed job's log before its run completes | Empty output; the log is withheld until the whole run finishes |
| Treating a reviewer's prescription as the fix | It is a hypothesis: #2693 r2's blanked-slice remedy stayed green on `env: { PWD: cwd }`; the fixer's AST rule replaced it and the reviewer withdrew the prescription |
| `git add -A` from a worktree without the probe-home exclude | 978 `.probe-home/npm-cache` blobs reached master in a direct push (2026-09-09, #2843); the user-level `commit-index-check` hook now denies it — keep the exclude anyway |
| Ignoring a red advisory row on a PR that changes what the lane runs | #2833 merged with `Unit tests Windows (advisory)` red on its own head; master carried the red until #2842. Read that row like a gate when the diff touches the lane's script, step or executed files |
| Restarting the plegma daemon under systemd with the default PATH | Backend detection is a PATH walk in the daemon process; 5 of 10 backends vanished and every Luna/GLM brief was rejected `Unknown model` (plegma#375). Set `Environment=PATH=…npm-global/bin…` in a drop-in and read `daemon.out`'s `backends:` line after ANY restart |
| Polling `plegma_list` every turn | 68 calls, 194 KB of context in one session for no decision. Arm one background `plegma wait <handle>` per lane in the dispatch turn; `plegma_list` only at reconnect and to consume `done` handles |
| Running `node ../../scripts/<x>` from a worktree | The path resolves against the worktree's parent, not the repo; two CI waits exited at once with the wrapper's exit 0 (2026-09-10). Inside a worktree the scripts are at `scripts/`; read the wait's output file before trusting an exit code |
| Appending a worker's body section keyed on an exact heading level | The worker wrote `# Round 7`, the append keyed on `## Round 7`, and the PR body shipped without the round (#2846 v7). `grep` the published body for the section before reporting it landed |
| Pushing an orchestrator round without `npm run fmt:check` on the whole tree | #2853's merge round redded oxfmt on two trimmed lists (2026-09-10). fmt:check is the last command before any push, orchestrator rounds included |
| Running a governance suite in the main checkout after merges without rebuilding | Vitest loads compiled `.js`; a stale build makes the run fail closed (or worse, test old code). `npm run build` before any test run in a checkout that has moved |
| Accepting a lifecycle round on `-t`-only mutation reds | #2853 r6/r7 quoted reds that only reproduced under `-t`; nine awaits never returned whole-file (#2859). Whole-file mutation runs are the acceptance shape (AGENTS.md round-routing) |
| Sending a scope `note` to a worker about to finish | The #2854 r2 worker settled before the note was read; the round shipped without H2/M1. Check `plegma_status` first; a worker with no turns left gets a new round, not a note |
