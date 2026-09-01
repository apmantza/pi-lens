# pi-lens — agent context

## How to read this file

AGENTS.md is the durable engineering contract and judgment record for pi-lens.
It has three reading modes; pick by task, do not read front to back.

1. **Authoring screens - read before you write code or open a PR:** "Issue and
   PR design contract", the discipline paragraphs in "Contributing",
   "Recurring defect shapes - screen against these BEFORE you write code", and
   "Test requirements" (including the test-authoring screens).
2. **Standing invariants - consult the group for every seam you touch:** the
   "Standing invariants" section, grouped by subsystem. Each paragraph is a
   live contract with its evidence issue.
3. **Subsystem references - consult while working in that area:** everything
   from "Key source layout" downward.

Task index (headings are stable anchors - grep by title; `file:line`
references rot and are evidence-only):

- Any code change: Recurring defect shapes; Issue and PR design contract.
- Writing or editing tests: Test requirements and its test-authoring screens;
  defect shapes 7, 14, 16; "Testing extension wiring"; "Testing dispatch
  runners"; "Real-runner rule/dispatch tests".
- LSP work: Standing invariants LSP group; "TypeScript LSP version split";
  "Runner process model"; defect shapes 4, 5, 15.
- Dispatch, runner, formatter, or installer work: Standing invariants dispatch
  group; "Actionable warnings routing"; "Severity policy"; defect shapes 3,
  10, 13, 16, 17, 18.
- Cache, store, or path-key work: Standing invariants caches group; defect
  shapes 1, 2, 6, 9, 12, 17; the OS-agnostic rule in "Contributing".
- Session lifecycle or telemetry: Standing invariants session group; defect
  shapes 17, 21, 22; the bounded-record rule in the PR contract.
- Review graph, snapshots, or word index: Standing invariants
  project-intelligence group; "Project intelligence and snapshots".
- Git-guard work: Standing invariants git-guard group.
- Delegated work: "Role contracts for delegated work" and
  `docs/pi-lens-subagent.md`, plus the selected role contract.
- Multi-PR orchestration: "Role contracts for delegated work" and
  `docs/pi-lens-warden.md`.
- ast-grep or tree-sitter rules: Standing invariants rules group; "ast-grep
  rules"; "Tree-sitter rules".
- Opening a PR: the PR template headings; the prose contract, blast-radius,
  class-sweep, and observability rules in "Issue and PR design contract".

## What it is

A pi coding-agent extension that runs automated checks on every file write/edit. Dispatches async parallel runners (LSP, biome, ruff, ast-grep, tree-sitter, jscpd, knip, Madge, and language-specific linters/build checks) and injects findings as context injections at turn-end and session-start.

Layout: see "Key source layout". Version and release history live in
`CHANGELOG.md`; do not duplicate them here.

## Maintaining this file (do this on every commit)

AGENTS.md is the durable context handed to every agent that works on pi-lens. **Update it as part of the same commit that changes the world it describes** — never as a follow-up:

- **Kill staleness.** If a commit changes behavior, structure, commands, conventions, or invariants documented here, fix the affected lines now. A stale claim is worse than none — agents act on it as fact.
- **Capture decisions & patterns.** When a commit establishes a non-obvious decision, gotcha, convention, or architectural pattern the next agent would otherwise relearn the hard way, add it here with the *why* and *how-to-apply* (recent examples: the dist/packaging + `pi.skills` resolution gotcha, the event-loop/hot-path discipline, the build-vs-lint gate).
- **Keep it high-signal.** Prune what's no longer true; prefer concise, load-bearing notes over exhaustive prose.
- **Shed to HISTORY.md, don't delete.** When a section completes, dissolves, or a rule's supporting narrative stops changing any future decision, move that narrative to `HISTORY.md` and keep the live rule here. HISTORY.md updates ONLY on shedding — it is the destination for what this file removes, not a parallel changelog; a quiet HISTORY.md while this file only gains content is the expected state, not neglect.

Placement rules (the add/add conflict record from 2026-08-25 - three PRs
collided appending to this file's tail in one night):

- A new invariant paragraph goes INSIDE the matching "Standing invariants"
  group. Never prepend at the top of the file; never append at the tail.
- A new defect shape appends as a numbered catalog entry; a refinement to an
  existing shape appends as an indented sub-paragraph under that shape.
- In PR bodies and reports, name the AGENTS.md sections you consulted. This
  citation record drives retention decisions for this file.
- Durable text cites mechanisms by symbol name and section heading, not
  `file:line`; line numbers belong only in point-in-time evidence.

## Issue and PR design contract

Message-end stale attribution anchors the session id when a live ctx is handled, not when the stale event drains: replacement can make the active id point at the wrong session. The anchor resets from `handleSessionStart` and is covered by the session-state registry; stale rows use its last live value or `unknown`. Durable degradation metadata truncates every value and retains only a bounded caller-key prefix, reporting dropped keys while reserved row fields win. (#1956 R2)

- **Design the state space before coding.** For stateful, ordered, resource-mutating, or security-sensitive work, write the invariants, supported transitions, explicit deferrals, and a cross-product test matrix before implementation. Examples are not enough: cover operation order, preview/apply, validation/normalization/execution seams, failure atomicity, observability bounds, and OS/path/encoding axes. If adversarial review finds repeated cross-product defects, stop patching one symptom at a time and return to the model.
- **Concurrency tests wait on the right clock.** Use `tests/clients/interleaving-kit.ts` for suspension and polling: every suspension belongs in `try/finally` with `release()` plus `restore()`, and waits on worker-thread or child-process progress must use the wall-time default. A custom tick yield is only valid for progress guaranteed to occur on the current event loop. Prefer a suspended call's `completed` promise over draining unrelated global work, and reset in-memory mirrors before asserting on durable disk state.
- **Prove filesystem isolation before coding subagents touch Git.** A
  conversational fork does not prove that the worker has a distinct checkout.
  Before dispatch, map each issue to an explicit worktree at the intended base
  and give the worker its absolute path. A worker may commit only after its
  current directory is verified as that distinct registered worktree. When the
  agent runner cannot bind a worker to a directory, the worker runs no Git
  commands; it edits and tests with the absolute worktree as `workdir`, and the
  orchestrator owns rebases, stashes, commits, pushes, and PR operations.
  Verify the parent checkout after dispatch. If isolation is uncertain, stop
  every worker before recovering state. Never use branch switches or stashes
  to coordinate parallel workers inside one checkout.
- **Verify sibling worktrees in situ; never trust coordinator-session
  diagnostics for them.** All build, lint, test, and diagnostic verification
  for a worktree runs from inside that worktree; its own `npm run build` and
  `npm run lint` are authoritative. Diagnostics a coordinator session takes
  on worktree files are advisory only: the parent's LSP/dispatch context
  resolves those files under the wrong root and floods results with false
  `Cannot find name 'process'` / missing-module blockers (one session logged
  49 such false blocking errors that dominated its summary; refs #2050).
  When a scratch or review worktree must run tests, link the parent's
  dependency tree instead of copying it or reinstalling: Windows
  `cmd /c mklink /J <worktree>\node_modules <parent>\node_modules` (a
  junction needs no admin rights), POSIX `ln -s`. Run one `npm run build`
  inside the worktree afterwards so the vitest stale-build guard passes.
  Use a real isolated `npm install` inside the worktree ONLY when the branch
  changes `package.json` or `package-lock.json`: a shared junction routes
  every install mutation into the shared tree, so concurrent installs across
  linked worktrees can corrupt it. Never copy `node_modules` into a worktree;
  copies drift immediately and resurrect stale compiled twins.
- **Real-clock budget assertions run in the wall-clock-budget phase (#1920).** A test that asserts elapsed time around awaited work (a `Date.now()` delta, or a self-reported span whose window contains deschedulable real work) measures scheduler contention under the default project's fork storm, not code speed — startup-overhead measured 659-2321ms against a 500ms budget under load while passing solo every time. Such tests belong in vitest.config.ts's fully-serialized `wallClockBudgetInclude` list (dead-last quiet phase), NOT in the `timing-sensitive` project, whose charter is sampler-only. Before adding a new budget assertion, ask whether it can assert recorded/logical spans instead; if it must measure real time, add the file to the list and note the budget's origin. The existence check in `tests/config/timing-sensitive-coverage.test.ts` keeps renamed members from silently dropping out of every project.
- **Real-LSP-spawn tests run in the lsp-spawn-heavy phase (#2344).** Tests that spawn a real LSP child and wait on its initialize handshake or first diagnostics belong in vitest.config.ts's serialized `lspSpawnHeavyInclude` lane (dead-last phase, `maxWorkers: 1`) — the #1022 ast-grep rule-compile and #2332/#2340 workspace-pull contention class. Membership is enforced, not conventional: `tests/config/lsp-spawn-heavy-coverage.test.ts` derives candidates from the spawn seams (a bare `launchLSP(` call, a `getServerById(` registry spawn, or an import of `tests/fixtures/fake-lsp-server.mjs`) and fails when a candidate is neither in the lane nor a documented exemption, and when a lane member goes stale. Add a new real-spawn test to the lane; a deliberate exception carries a named reason in that file's `SPAWN_EXEMPTIONS`.
- **Fault-injection probes come from the kit, not ad hoc (#1838).** Wedged child pipes (`spawnWedgedChild`), deterministic seam delays (`delayInside`), starved env budgets (`starveBudget`), externally-resolvable gates (`gatedPromise`), and lifecycle hooks fired inside a mocked seam (`fireResetAt`) come from `tests/support/fault-injection.ts`. Indefinite suspension stays on `suspendAt`. When a fix touches a latch, teardown path, in-flight cache, or session-straddling write (catalog shapes 1/3/9/24), the red-first pass should reach for the matching primitive instead of hand-rolling a probe — the bespoke-fixture era produced each probe exactly once and then lost it. Each kit primitive carries its own fidelity test in `fault-injection.test.ts`; extending the kit means adding one, and a primitive whose fidelity test cannot detect its own neutering does not ship.
- **Preserve the model in handoffs.** Every issue or PR should name the defect/capability class, separate in-scope acceptance criteria from explicit non-goals, state invariants and failure semantics, and enumerate relevant test dimensions. A PR must say which existing seams it extends, how it preserves those invariants, and which matrix cells it tests. Keep cross-cutting capabilities in separate PRs unless their composition is explicitly designed and tested.
- **Adversarial-review every PR before merge.** For every non-trivial PR, run a read-only review against the actual final head after rebases/merges and CI. The reviewer must challenge the invariants, cross-product matrix, security boundaries, failure atomicity, observability bounds, and composition with merged changes—not merely repeat the happy-path tests. Request changes for real P1/P2 findings; after repeated cross-product findings, return to the state-space model instead of applying isolated patches. Do not merge on green CI alone. **Beware the skipped-CI-on-conflict trap:** a `DIRTY` (merge-conflicted) PR cannot have its merge-ref built, so `ci.yml`'s `Lint & type-check` and `Unit tests` jobs are **silently skipped, not failed** — the PR shows only the always-runnable checks (CodeQL/Sonar) green, and a naive `gh pr checks | grep -cv pass` reads zero because a skipped required check is absent, not failing. Resolving the conflict and pushing re-triggers `ci.yml`; before merging, verify the `Unit tests` job actually **ran and passed on the current head SHA** (e.g. `gh api repos/.../commits/<sha>/check-runs`), and never `--admin`-merge a formerly-DIRTY PR without that fresh green. **Conversely, SonarCloud is NOT a required check** — only `Lint & type-check` and `Unit tests` gate merge (confirm via `gh api repos/.../branches/master/protection/required_status_checks`); a red SonarCloud gate does NOT block merge and must not trigger correction rounds. Its `new_duplicated_lines_density` CPD over-flags inherently-repetitive code (lookup tables / policy maps — #1169's `FORMATTER_POLICY_BY_EXTENSION`), and its Automatic Analysis re-analyzes async so it **lags the head SHA** (a stale ERROR often clears once it catches up). Treat it as advisory: read the finding, don't contort correct code to satisfy CPD, and don't take a reviewer's assertion that "Sonar is a required gate" at face value — check the protection list (this cost two correction rounds on #1169). A `BLOCKED` merge-state with `Lint`+`Unit` green is usually just a non-required check (Sonar/install-matrix) pending — mergeable. **One review question the gates cannot ask (#1500):** when a call site hands a shared policy an outcome or classification it did not DERIVE from the evidence — `noteUnavailable("missing", "not-found")`, `available = false`, a hard-coded severity or verdict — ask what actually failed, and require either a derivation (`classifyProbeFailure`) or a comment justifying the assertion plus a record carrying the raw facts. Governed storage with a wrong classification looks identical to a correct verdict in the logs.
**One more review question (#2000 routine): do these tests exercise REAL binaries/state, or mocks?** For every touched test, check whether the code under test runs against the real implementation (real `RuntimeCoordinator`, real logger writing bytes a reader can parse) or against a hand-rolled double. Mocks are legitimate ONLY at true process boundaries (external binaries via `safeSpawnAsync` mocks, host SDK seams); when a seam has real in-process state, the test must flow through it and assert against the real store/sink — swapping a fake runtime into an existing test to keep it green is a regression the reviewer must flag, not approve. See also "Real-runner rule/dispatch tests" (#448).

- **Review findings carry a materiality bar.** A finding is rejected — by the reviewer before reporting, and by the orchestrator on receipt — when its only justification is stylistic consistency, hypothetical extensibility, or minor line-count reduction; prefer boring local code when it is already clear. Never report what a REQUIRED CI check already fails on (lint/`tsc`, the governance sweeps inside Unit tests) — a finding the gate would have rejected anyway is noise; advisory and non-required lanes (SonarCloud, oxfmt, the ast-grep self-scan's untagged rules) are NOT covered by this clause, and the reviewer's standing probes still run in full. Report spec-compliance findings (the issue's acceptance criteria) and standards-compliance findings (this file's conventions) under separate headings so neither buries the other. And when a review reveals that a whole seam could be dramatically simpler — a restructuring that preserves behavior while shrinking the implementation — that insight is a NAMED OUTPUT: file it as an evidence-first issue with the simpler shape sketched; it is never applied inside the fix round (blast-radius discipline governs the PR; the consolidation-verdict rule governs the family).
- **Judging a red Unit-tests run under the exit-137 wave (#2042/#2103).** Read the log before any rerun. The infra shape: `Killed node scripts/with-memory-watch.mjs` or a bare 137 with ZERO `FAIL`/`AssertionError` lines, and often no `[mem-watch] done.` verdict line at all (the OOM killer can take the wrapper itself — the record has a structural gap there). The real shape: assertion lines plus `[mem-watch] done. exitCode=1`. Infra → rerun once and record the judgment; the same TEST failing twice across attempts is a signal, not a flake. A flake claim needs the controlled comparison (isolated run on the composed tree, and master under the same load) — a real regression masquerades as a flake (#1407). `scripts/classify-ci-failure.mjs` (#2103) mechanizes this read. `.github/workflows/ci-infra-kill-rerun.yml` invokes it only for a completed first-attempt CI failure, requests the exact failed `Unit tests` job, and reruns failed jobs only for `infra-kill`. The workflow-run attempt gate and sticky per-SHA marker bound the rerun; acquisition or classification errors produce a PR comment when the event identifies a PR.
- **Re-verify after review fixes land — the push is not the proof.** Addressing review findings is complete only when the NEW head has been re-verified: re-run every suite the reviewer ran (plus lint and the ast-grep self-scan lane, which `tsc`/`fmt:check` do not cover), confirm required checks actually ran and passed on the fix SHA (`gh api .../check-runs` — a forced push invalidates prior green), and post a per-finding disposition (fixed-in-<sha> / deferred-to-<issue>) on the PR. Substantive P1/P2 fixes get a scoped follow-up review round on the delta before merge; P3 dispositions may be recorded without a re-review. A fix commit that exists only locally — or whose verification predates it — counts as unverified.
- **Prose contract for every user-facing artifact** (PR bodies, issue bodies, review comments, commit bodies, docs). Frame: lead with the outcome. Strip every word that does no work. Clarity beats brevity. Write like a person. Mechanics, from Google developer-documentation style and Simplified Technical English:
  - Active voice, present tense.
  - One idea per sentence, roughly 20-25 words. Split any sentence over ~30 words.
  - Consistent terminology: never swap synonyms for the same thing.
  - Sentence-case headings. Plain words. No idioms or colloquialisms. No `please`. Oxford comma.
  - No em-dash chains or nested parentheticals.
  - Second person for instructions; imperative for steps ("Run the sweep", not "The sweep should be run").
  - Condition before instruction: "If the check is red, read the log" — the reader learns whether the sentence applies before parsing what it asks.
  - Parallel structure in every list: items share grammatical shape (all imperatives, or all noun phrases), and the list is introduced by a complete sentence.
  - Timeless wording in DURABLE docs (this file, HISTORY.md, README): no "new", "currently", "now", "recently" — they rot silently. Point-in-time records (PRs, issues, comments) instead use ABSOLUTE dates, never relative ones ("on 2026-08-26", not "yesterday").
  - Commits: tpope style on top of the conventional prefix. Imperative subject of 50 characters or fewer, blank line, 72-column body stating what and why.
  - Issue references live in the PR TITLE. Use `closes` only when every acceptance criterion is met. Otherwise use `refs` plus an issue comment naming the remainder.
- **Mutation-proof every new guard, branch, and filter.** A red-first test for the feature is not enough: deleting or neutering the guard itself must turn at least one test red. Vacuous guards were the most repeated review finding of the 2026-08-19 arc. #1682's generation check survived `if (false)`. #1674's latch-clears survived neutering. #1686's membership check survived a cursor swap. #1692's coverage sweep survived gate deletion. When you add a conditional that exists to prevent a bad outcome, run the mutant yourself and cite the red in the PR body.
- **Re-run the governance suites after every master merge, not just your targeted files.** A registered-or-fail sweep merged to master (session-state conformance, delivery-surface registry, changelog guard) fires the first time it meets your branch — that is the merge commit, not your development window. Three branches hit this in one day (#1664, #1633, #1687) because each ran only its own test files after merging master.
- **Prove composition with evidence when your PR overlaps an open PR.** Same field, same store, or same render surface as an in-flight PR means: merge that branch locally and run ITS test files on the merged tree. Never conclude compatibility by reasoning about "different structures". That exact reasoning shipped the #1631/#1641 `stale`-semantics collision: three separate semantic collisions (an add/add conflict, a conformance-sweep failure, and a tally-convention disagreement), each resolved by a maintainer commit pushed to the fork PR #1633. When a change adds a second writer to an existing field, add a reason/kind discriminator with per-writer semantics before either PR merges.
- **Re-home deferred work to an issue, never to another in-flight PR.** A PR is not a tracking surface: its author does not know they are carrying your remainder, and it merges without it. #1664 deferred the inline-blocker gate "to #1633", which shipped without it. Only a bookkeeping audit recovered the loss. The deferral comment names exactly what remains and lands on the issue before you finish.
- **Any mechanism you cite as precedent carries a `file:line`.** A justification that references "the existing pattern in X" without a checkable location invites fabrication. #1701 justified a correct change with an in-repo relationship that did not exist. Only a reviewer tracing the claim caught it. Reviewers: trace every cited precedent.
- **Every new failure path emits a bounded record that preserves the discriminating identity.** Route repeats through `recordDegradationOnce`/`incrementDegradationCount`, never a raw per-occurrence log (#1678's orphan spam), and never let aggregation destroy WHICH file/tool/record is stuck (#1705's review probe). `emitBounded`/`admitBounded` (`clients/bounded-telemetry.ts`) are the sanctioned form: they derive the rising edge from the ledger's own tally, cap per turn, and stamp the identity into the record, and `tests/clients/bounded-telemetry-sweep.test.ts` sweeps failure-path phases registered-or-fail, so a new raw `logLatency` on a failure path needs a stated reason (#1743). State in the PR body which log or ledger record proves the fix works in production — or name the observability gap and file it.
- **Map blast radius for every code PR.** Before and after editing, use `module_report` on each touched production module with `blastRadius: true`; inspect `callbacks[]`, closures, `usedBy`, entry points, and risk flags, then use `read_symbol`/`read_enclosing` for relevant bodies. The PR must state affected dependents, callbacks/entry points, and the verification plan—or explicitly record that the blast radius is empty/unavailable and why. Re-run this map after conflict resolution or architectural changes. If the change touches a hot path (per-spawn, per-file, per-render), MEASURE the cost delta and state the number. Silent per-call taxes ship otherwise: #1673 added 100 ms to every spawn across 118 call sites, #1687 multiplied a per-file budget, and #1701 cost 14x on the background scan. Every one was caught by a reviewer's measurement. None was stated by its author. `module_report` is a navigable structural/dependent view, not a complete function-level call graph; for call-graph work reuse `clients/call-graph.ts` or LSP incoming/outgoing-call navigation instead of inferring completeness from `usedBy` or `blastRadius`.
- **Describe every test in the PR body.** The PR body (or a review-prompt appendix) carries a section naming each NEW test file/case and each EDIT of an existing test, with one line on what it pins and why it exists — a regression proof, a contract seam, an occupancy budget. A reviewer who cannot see what changed about the tests cannot review the change: silently swapping a real coordinator for a fake runtime inside an existing test is exactly the edit this section exists to expose.

**PR body structure is advisory-linted.** Keep `Summary`, `Tests`, `Blast radius`, `Class sweep`, and `Observability` populated — plus `Test assessment` whenever the PR touches `tests/` (see "Test assessment and removal" under Test requirements); `scripts/check-pr-body.mjs` checks structure only, so reviewers still judge the answers.

## Contributing

For human contributors and issue/PR authors, see `CONTRIBUTING.md` at the repo root. It covers the development workflow, how to add runners, LSP servers, formatters, and rules, and the issue/PR templates. This `AGENTS.md` is the durable agent context; `CONTRIBUTING.md` is the public contributor guide.

### Role contracts for delegated work

Every delegated worker receives `docs/pi-lens-subagent.md` and exactly one role
contract before it starts:

- Use `docs/pi-lens-fixer.md` to implement an issue or requested change.
- Use `docs/pi-lens-reviewer.md` to adversarially verify a finished change.
- Use `docs/pi-lens-investigator.md` to root-cause behavior without editing.
- Use `docs/pi-lens-warden.md` to audit PR state and route the next handoff.

This routing applies to native subagents, Plegma workers, and any other agent
runner. Include the contract text or an explicit repository-relative reference
in the task. For Plegma, also pass the matching daemon contract names in this
order: `pi-lens-subagent`, then the selected role. Repository instructions win
if a daemon copy has drifted.

Name the role, absolute worktree, branch, base, acceptance criteria, non-goals,
and Git authority in every delegation. A role never grants Git authority by
itself. Follow "Prove filesystem isolation before coding subagents touch Git":
if the worker cannot verify a distinct registered worktree, it runs no Git
commands, and the orchestrator owns commits, pushes, and PR operations.

Do not mix implementation and review in one delegation. If an investigation
produces a fix, return the diagnosis and start a fixer delegation. If a reviewer
finds a defect, return the finding and start a fixer round. Run the final review
against the actual PR head in a separate reviewer delegation.

For concurrent PR work, run the warden after every worker completion, push,
review verdict, CI verdict, merge, and status request. The warden assigns each
PR one workflow state, one next action, and one next owner from GitHub and
registered-worktree evidence. Trigger that owner in the same orchestration
pass. A completed handoff without a triggered next owner is an orchestration
defect. Reuse the same fixer and reviewer across correction rounds. Enable
automerge only after the final head passes required CI and same-reviewer
verification. The warden remains read-only; Git and GitHub authority stays with
the orchestrator.

Record every worker handoff on the pull request or another shared ledger. Name
the role, exact head or working-tree identity, verdict, finding dispositions,
and next owner. A chat-only result is not durable workflow evidence and cannot
support a later warden audit.

All delegated roles follow `docs/pi-lens-subagent.md`'s "Tautological tests
considered harmful" rule. A red-first test is valid only when it reaches the
real seam, observes an independent result, and turns red when its guard or
filter is removed. Treat setup-echoing assertions, duplicated predicates, and
unnecessary in-process mocks as test defects.

**The minimalism ladder — climb it before writing any code.** Be lazy about the solution, never about reading: understand the problem and trace the real code flow first, then ask, in order: (1) does this need to exist at all — would nothing break without it? (2) does this codebase already do it — reuse the existing seam (single-source-of-truth rule); (3) does the stdlib or platform do it? (4) does an installed dependency do it? (5) is it one line? Only then write the minimum that works. Lazy, not negligent: validation, error handling, security, bounded observability, and the degradation records this repo requires are never skipped for minimalism. The record: #2091 was built and then killed by measurement — step 1 asked before building would have saved the PR; #2106's catch-path outcome split was an unobservable discriminator that step 1 would have stopped ("a discriminator nothing can observe is a vacuous guard"). When a reviewer finds over-built code, the finding names the ladder step that was skipped.

**External-PR handling.** Maintainer agents may commit directly to a contributor's PR branch when "allow edits from maintainers" is enabled. Prefer this over asking the contributor to apply small review asks. Keep the contributor's authorship: commit only the review deltas, write clear commit messages, and reference the review. When you post a review on an external PR, thank the contributor first. Then state plainly that the review is AI-generated and that a maintainer supervises the process.

**Mechanical versus intent: what a maintainer may land without a fix round.** A maintainer trailing commit (to any branch, including post-merge master follow-ups) is allowed only for INTENT-FREE mechanical deltas: formatting, comment accuracy, doc numbers, cross-reference ids, a test pin whose behavior the review already proved. Anything that touches what the code MEANS — a guard, a branch, an outcome value, a threshold — goes through the fix-round + same-reviewer-verify loop no matter how small it looks; the smallest-looking intent changes of the 2026-08-26 arc each cost a full round when probed.

**Pi-lens dogfooding is part of every pi session.** When pi-lens is installed while we work in pi, the agent is also a pi-lens consumer and debugger. If an observed behavior is not as expected (including stale/deleted-file diagnostics, a misfiring command, a stale installed-copy result, a hang, or a misleading clean/unconfirmed state), first distinguish a real defect from an artifact of the installed build, cache, or environment; then open or update a labeled tracking issue with the reproduction, observed-versus-expected behavior, evidence, affected surfaces, acceptance criteria, non-goals, and test matrix, and notify the user with the link. The same obligation applies to enhancement opportunities identified through consumption of the extension (performance, observability, ergonomics, or architectural seams), even when the current task is unrelated. Do not silently dismiss a finding as "just dogfooding" or leave it only in chat. Example: #1259 tracks the latency benchmark needed after #1254's default all-scope LSP collection change.

**Always look at the bigger picture — a fix's PATTERN matters more than its instance.** When a change fixes or improves one thing, ask before implementing: *does the same class apply to its siblings?* Conformity and maintainability are anchor values in this repo — one convention applied everywhere beats four local variations, and a fix that leaves identical latent instances behind is half a fix. Recent examples of the discipline: #519 reported ONE skill-name collision (`ast-grep`) but the fix namespaces ALL four bundled skills (same collision class, uniform `pi-lens-` prefix); #513 was ONE renderer crashing on width, and the fix extracted the shared `tui-fit.ts` helper + audited every other render surface; #210 was one read-guard map with raw keys, and the invariant became "EVERY guard map keys through `normalizeFilePath`". How to apply: name the pattern class in the PR/issue (not just the instance), sweep the codebase for other members of the class, fix the contained ones in the same PR, file an issue for the rest — and when the sweep would expand scope materially, surface the question to the maintainer BEFORE implementing the narrow version.

**A newly FILED issue is a class trigger too, not just a newly root-caused bug.** When you file (or triage) a new issue, before or immediately after filing: (1) name the defect *shape* the finding belongs to; (2) sweep the repo for other members of that shape and record the sweep's coverage in the issue body or a comment; (3) search the existing open issues (`gh issue list --search`) for related or duplicate members and cross-link them (`refs #N`) so class members don't accumulate as disconnected tickets. An issue filed from a single observed instance without a class sweep is a partial report — the canonical case is #1289, filed 2026-08-12 from three known env-less managed-tool spawns before the repo-wide sweep had run.

**A newly root-caused BUG is a class trigger, not just a fix ticket.** The moment a bug's root cause is understood, name the *defect shape* and sweep the whole repo for other members of that shape BEFORE closing it out — a latent sibling left behind is the same bug waiting to be re-filed under a new number. Fix the contained siblings in the same PR (or a fast follow-up); file a tracking issue for the rest; and record the sweep's coverage (what you grepped, what you found OK) so the next agent can audit it. The cautionary case is #1020: `lens_diagnostics mode=all` replayed a stale blocker because `widget-state`'s `files` map keyed on a **raw, non-normalized path** — the SAME class as #210's read-guard raw-key bug, whose fix had already declared "every path-keyed map normalizes at write AND read AND rehydrate." widget-state was simply missed by that earlier sweep, so the class re-surfaced years later as a Windows/resumed-session `\`-vs-`/` duplicate-key replay. Two lessons: (1) a bug is evidence its class was under-swept — re-run the sweep repo-wide, don't trust that a prior fix covered every member; (2) the highest-severity subclass is any keyed cache/guard whose write/read forms can diverge (path case/separator, resolved-vs-raw), because it fails as a stale replay or a silent "never seen" miss — the #533 honesty trap where a resolved state renders as still-broken, or a real signal silently drops. The structural remedy for this class is `clients/path-keyed-map.ts`'s typed **`PathKeyedMap<V>`** (#1025): it folds every key through a caller-supplied normalizer INTERNALLY on get/set/has/delete, so keying a raw path is impossible by construction — reach for it (rather than a bare `Map<string, V>` + hand-normalized call sites) whenever you add or touch a path-keyed in-memory map. Pick the normalizer to match the state's lifetime: `normalizeEphemeralMapKey` (cheap slash-fold + win32-lowercase, NO `realpathSync`) for hot single-process indexes whose keys this process produced (e.g. the word index, via its exported `wordIndexKey`); `normalizeMapKey` (realpath-canonicalizing) for long-lived state shared across call sites (read-guard, `_fileSeq`). It preserves each value's original display path for render surfaces. The #1025 sweep converted the CONFIRMED word-index offender; `RuntimeCoordinator`'s `_pendingInlineBlockers`/`_pendingDeferredFormatFiles`/`_lspReadWarmState` remain unconverted (unproven suspects — a follow-up).

**A bug fix is also a survey of its neighborhood.** While the fix is fresh — the seam read, the invariants understood — thoughtfully check every ADJACENT surface for improvement opportunities before moving on, in this repo's usual directions: duplication that belongs on a shared seam (consolidation over parallel hand-rolled implementations — the #1289→#1290 arc: three clients independently hand-rolled the same availability dance and independently grew the same bug; the fix's real deliverable was the consolidation issue), missing enforcement (a coverage test or ast-grep rule so the fixed pattern can't regrow — #1158's dogfood set, the #883 derive-don't-hand-maintain pattern), maintainability drift the fix exposes (divergent timeouts, hand-copied conventions, a comment admitting "mirrors the pattern in X"), and telemetry the debugging session wished existed. Scope discipline still governs ACTION: apply what is contained in the fix PR, file or comment the rest (deferral hygiene — refs, issue stays open), one seam per PR for the structural work. The failure mode this paragraph exists to prevent is the silent walk-past: fixing the one call site, seeing the four siblings and the missing guard, and leaving no trace that they were seen. Seeing without recording is indistinguishable from not looking. **Every population sweep ends with a consolidation verdict:** a family whose members spell the same defect differently is evidence the logic never had one home, so the sweep's per-member table closes with one line — fold onto one seam (name it, file the issue) or stay distributed (say why). The deciding instrument is the **deletion test**: would removing the proposed shared module CONCENTRATE complexity back into a few callers (fold — the seam is deep), or merely RELOCATE the same lines (stay — the abstraction is shallow and adds indirection without depth)? The record: #1289's three hand-rolled availability dances became #1290's consolidation; #1025's PathKeyedMap came from the raw-path-key sweep; the 2026-08-25 arc found five defective idle-evict replacement sites (#2073) and four dormant truncation guards (#2100) the same way.

**Everything must be OS-agnostic — we develop on Windows but the unit-test CI job runs on Linux.** "Green locally" is not "green on CI," and a fix isn't done until it holds on the CI OS. The axes that differ are exactly the ones pi-lens's path/diagnostic code touches: **case sensitivity** (Linux case-sensitive; Windows/macOS-default case-insensitive), **separators** (`\` vs `/`), **realpath/symlink** resolution, drive letters, line endings, path-length limits. Code or a test that silently assumes one OS's behavior passes locally and then fails — or vacuously passes — on the other. This is a facet of the bug-class discipline above: path-key / path-form bugs are *inherently* OS-sensitive, so their tests must handle case-sensitive vs case-insensitive filesystems too. The cautionary case is #1024's own regression test — it assumed a case-INSENSITIVE FS (mis-cased `SUB/a.ts` aliasing the real `sub/a.ts`) and gated on a `path.relative` string comparison, which differs *textually* on Linux but never *aliases* there, so the test RAN on Linux CI and failed a PR that was green on Windows. How to apply: prefer probing the actual filesystem/behavior at runtime (`fs.existsSync`, a real symlink) over branching on `process.platform` (an FS probe is truer — macOS can be case-sensitive, Linux mounts case-insensitive); when a fix targets a Windows-specific divergence, either write a cross-platform variant (e.g. symlink-based, which exercises realpath on Linux too) or skip *correctly* where it can't apply — but say so, never let it vacuously pass; and reason about the CI OS explicitly, not just the local run. **Tests must never hardcode a drive-letter/UNC literal (`"C:/..."`, `"C:\\..."`, `"\\\\host\\..."`) as a `normalizeMapKey`/`normalizeFilePath`-keyed structure key — derive the expected key by calling `normalizeMapKey`/`normalizeFilePath` on the input path.** `normalizeFilePath` enters its win32 branch by path *shape* on ANY OS (`isWindowsPath`), so a Windows-shaped literal normalizes to a DIFFERENT key on Linux than the byte-identical literal it is on Windows — a hardcoded expectation passes on Windows and silently mis-keys on Linux CI (this is exactly what produced #1139's green-locally/red-on-CI, root-caused in #1150). Feeding a drive-letter literal *into* the normalizer as an INPUT is fine; hardcoding one as the expected *output* key is the trap. (No ast-grep rule ships for this: the good use — literal fed into `normalizeMapKey` — and the bad use — literal used as a raw key — are syntactically identical string literals, distinguishable only semantically, so a shape-matching rule would fire on every legitimate drive-letter input literal, including the normalizer's own tests. It stays a convention, enforced by review + the `normalizeFilePath` regression guard in `tests/clients/path-utils.test.ts`.) **For the separator-fold itself, `toPosix()` / `splitPathSegments()` (`clients/path-utils.ts`, #1193) are now the sanctioned forms** — do NOT hand-roll `.replace(/\\/g, "/")` / an inline `.split(/[\\/]+/)` (that idiom was scattered ~138× across 83 files — the *root cause* of the recurring shape-2 arc #1150→#1152→#1161→#1163→#1194: an un-funnelled transform can't be lint/ast-grep-ruled because the idiom and the bug are byte-identical). `toPosix` is byte-equivalent to the inline idiom (pure fold — no resolve/case/realpath; reach for the normalizers when a canonical *key* is needed). The deeper direction (tracked in #1193, recorded in `docs/fable.md`) is **normalize at the INGEST boundaries** — persisted-key rehydrate (snapshot / word-index / call-graph / review-graph symbol keys written on Windows, read on Linux CI) is the hot one; LSP URIs already funnel through `uriToPath`/`uriToDiskPath` and are notably the *one* axis not generating recurring bugs — so interior code can once again trust host-default `path` fns, rather than bolting a per-site `isWindowsPath ? win32 : posix` conditional onto each new call (which only ever hardens the sites someone already filed a bug for).

**Proactively surface structural improvements.** While doing any task, actively look for and report **consolidation** (duplicated logic/maps/singletons → one shared seam), **dead-code removal** (unreachable branches, orphaned modules, deps used only by dead code), and **architectural improvements** — even when not strictly in scope. Do the safe, contained ones inline (keep the primary PR focused); file a tracking issue for the larger refactors so they aren't lost. Recent examples: the shared-`TreeSitterClient` seam (#416 — four subsystems each constructed their own client + duplicated ext→lang maps), the WASM-heap leak (#417/#418 — `TreeCache` bounded entry count but never called `tree.delete()`, leaking the WASM heap unbounded), and the `typescript`-obsoletion thread (#402, born from a bundle-size observation). The canonical smell: **a resource bounded along one axis but unbounded along another** (entry-count-bounded cache leaking heap). Open architectural threads + the standing assessment live in `docs/fable.md` (status section kept current as items ship). **This is opportunistic, not a standing audit — it only reaches whatever the active task happens to touch.** Whenever a fix involves reusing, creating, or reaching for a shared helper/primitive (not just fixing the one call site), do one broader grep across the repo for the same code *shape* before closing out — not just the obviously-related call sites the bug report names. `#622`→`#625` is the canonical example: fixing one walker's missing `isAtOrAboveHomeDir` guard led to a targeted grep for that helper's usage, which surfaced four more files hand-rolling the same upward-climb loop instead of the shared `walkUpDirs`/`findNearestContaining` primitive that already existed for exactly this. That sweep only happened because this specific bug's fix touched the right helper — an unrelated fix elsewhere wouldn't have surfaced it. Don't wait to be asked to "audit all walkers"; treat discovering a duplicated pattern as the trigger to grep for its siblings before moving on.

**Shape 12 — a durable commit followed by an out-of-guard mirror refresh** (found #1309 review, 2026-08-12; swept same day: dispositions was the sole member, probe-cache is the reference-correct pattern). When a writer atomically replaces shared state and THEN refreshes an in-memory mirror, stat/metadata, or validity cache, the refresh must occur before releasing the lock/guard — or be revalidated against the committed generation/object identity. Otherwise a sibling writer commits between publication and refresh, pairing one writer's mirror metadata with another's durable state. When you touch any lock consumer, atomic-write-plus-mirror seam, or worker promotion: verify the mirror update executes INSIDE the guard (`durable-store.ts`'s `afterWriteLocked` is the sanctioned seam), and classify advisory/rebuildable mirrors separately from behavior-gating state. Detection: grep the release call, then look downward for cache/memo/flag assignments.

**Every bug fix ships a regression test that FAILS on the pre-fix code (red-first), and the fix makes it pass (green).** A fix without a test that reproduces the bug is not done. Prove the red-first: run the new test against the unmodified pre-fix code and confirm it fails for the RIGHT reason (the bug), not a setup error; a test that passes on pre-fix code is vacuous (defect-shape 7) and does not protect against regression. Reviews mutation-verify this: revert the fix, the test must go red. When a bug reveals a class (see the bug-class sweep discipline), the regression test should cover the class shape, not just the single reported input.

**Clean up after merged PRs: the worktree AND the branch (local + remote).** Merged branches and their worktrees accumulate fast (a single burn-down session left 130+ worktrees). Note that `gh pr merge --delete-branch` SILENTLY fails to delete a branch a worktree still holds (`cannot delete branch … used by worktree`), so merging does not auto-clean when a worktree checks the branch out. Periodically and at session end: `git worktree remove` your own temp worktrees when done; `git worktree prune` dead entries; `git push origin --delete <branch>` for merged remote branches (works regardless of local worktrees); `git branch -d <merged-branch>` locally. For plegma `~/.plegma/work/sub-*` worktrees, the daemon auto-cleans unchanged ones — force-remove committed-branch ones only once their PR merged and the agent is no longer live.

### Recurring defect shapes — screen against these BEFORE you write code

The captured-at-subscribe / used-after-replace shape also applies to pi's `events` API: `pi.events.emit` is a session-bound wrapper whose runtime is invalidated on replacement. Long-lived publishers must retain a getter and resolve the emitter at delivery time; deferred callbacks must resolve inside the callback, never before scheduling. The resolved target pairs the emitter with its OWN activation's event ctx — never a process-global "latest ctx", which can belong to an unrelated sibling activation after a replacement and would silently pass the stale-session probe (a live-looking ctx with no relation to the paired emitter, dropping every publish until the new activation's own first handler arrives; #1415). The shared live-emitter seam probes that ctx immediately before delivery and records `skipped_stale_session` instead of invoking a confirmed-stale target. The getter itself is activation-scoped: module-singleton bus/notifier/widget-render plumbing must be re-wired from the current factory on every `session_start`, BEFORE the #473 concurrent-secondary guard can return, because a sibling activation can overwrite the singleton and later go stale. Emit-failure suppression is occurrence-scoped (success re-arms it), and a stale occurrence records one `bus-stale` degradation. (#1128, #1383, #1415)

This is the payoff of the two disciplines above: a bounded checklist of defect *shapes* that each recurred ≥2× across the arc. Read it at task start; when your change matches a shape, treat the screen as an acceptance criterion (and the regression test the shape implies). Each entry is **SHAPE → SCREEN (when you touch X, verify Y) → canonical example → detection**. Where a shape has a fuller treatment above, this cross-references rather than restates it.

1. **Path-keyed map whose write and read forms can diverge** (case / separator / resolved-vs-raw / existence). *Screen:* any in-memory map keyed by a file path uses `PathKeyedMap<V>` with the lifetime-appropriate normalizer, never a bare `Map<string, V>` + hand-normalized call sites — fold every key on BOTH write and read. Key derivation must not change when the file appears or disappears; otherwise capture the key before the state change. Tests exercise the real guard with real mixed-case files on disk. See the `PathKeyedMap` paragraph above (#210→#1020→#1025→#1086). *Detect:* grep `new Map<string,` near path/file keys; review question "is every key normalized on write AND read AND rehydrate, independent of existence?". Not cleanly ast-grep-able (can't tell a string key is a path) — #1158/#1684. **Multiplier variant:** a realpath normalizer inside a per-element loop over an already-canonical collection multiplies the #2016 tax by O(project-files); delete the second normalization. For raw walker output, use a bounded spelling→canonical memo with an explicit lifetime/freshness story (#2072).

2. **A host-default `path` fn inside a shape-committed branch.** Once a branch has classified a path as win32-shaped (by shape, on ANY OS via `isWindowsPath`), its `dirname`/`basename`/`join`/`relative`/`sep` must be `win32.*` — the bare fns follow the *host* OS, so a Windows-shaped path gets POSIX-split on Linux CI. Classification-by-shape must parse-by-shape. *e.g.* #1150/#1152 (bare `dirname` in `normalizeFilePath`'s win32 branch mis-keyed on Linux). *Detect:* grep `\b(dirname|basename|join|relative|sep)\b` in files that also branch on `isWindowsPath`/drive-letter shape; confirm each is `win32.`/`posix.`-qualified. Partly ast-grep-able but branch-scoping is hard — #1158. **Second axis (an `isWindowsPath`-grep sweep MISSES these):** a hand-rolled path fn that does NOT branch on `isWindowsPath` is invisible to the grep above — #1194 (`project-report.ts:toDisplayPath` re-implemented `path.isAbsolute`/`path.relative` display natively instead of delegating to the shape-aware `toProjectRelativePath`, so the #1163 sweep couldn't see it). So ALSO grep for hand-rolled relativizers / separator-folds that BYPASS the primitives (`toProjectRelativePath`, `toPosix`, `splitPathSegments`), not just the `isWindowsPath`-branching sites. And a class sweep can miss a member **in its own file** (#1171: the mtime-freshness sweep left the nested-config cache un-fixed in the very file it was editing) — so adversarially re-check the sweep's own coverage claim; a sweep that says "complete" is not proof. A pattern sweep is not a population sweep: an enumerable family's siblings can spell the same defect differently. Family membership requires one verdict per member across the whole tree, never only `clients/` or the textual twins a grep found (#1787/#1791).

3. **A wrapper-convention argv transform applied to a non-wrapper config.** `slice(1)`/`shift()` to drop a wrapper binary, run over a real command, turns `cargo test`→`cargo`, `pytest -q`→`pytest`. *Screen:* before mutating an argv array by position, verify the config actually IS the wrapper shape the transform assumes; never conflate a command member with the launcher `binName`. *e.g.* #1098 (test-runner binary resolution stripped real subcommands — pytest/gradle/minitest all corrected). *Detect:* review question only — `.slice(1)` on a command array is right for wrappers, wrong for commands, and syntactically identical; NOT ast-grep-able.

4. **A timer / promise / worker / child that outlives its one-shot settle, or races without ordered cancellation.** The one-shot-retention class: a race-loser's timer left armed, a re-`ref`'d MessagePort with a listener added after `unref`, a non-`unref`'d child/timer/**fs-watcher (inotify)** spawned at session_start — any keeps a print-mode/CLI process alive past its work. *Screen:* every `setTimeout`/`setInterval`/`new Worker`/`spawn`/`fs.watch` — is it `unref()`'d, or cleared on EVERY settle path (including the race-loser), or gated out of print mode? *e.g.* #1097/#1109/#1110 (race-loser wait timers), #1141/#1123 (handle tracer), #1174 (external report — an inotify fs-watcher armed by quick-mode warmup kept a headless `pi -p` alive; fixed by the #1154/#1159 print-mode gating that stops warmup work arming under `--print`). *Detect:* grep `setTimeout|setInterval|new Worker|spawn(|fs.watch`, review per hit. A raw-timer-without-`unref`/`clearTimeout` rule is possible but noisy — viable only scoped to session-start/print-mode modules (#1158).
	A completion signal must also cover loser cleanup: remove an in-flight request only after its owned stage/temp artifacts are synchronously reaped (or track the cleanup promise), so waiters cannot observe "done" while cleanup is still queued (#1318).
	Teardown, breaker, and demotion paths cannot depend on the health of the resource they are tearing down. Bound every await on those paths, especially replies from a pipe already known to be dead, and put cleanup in `finally` (#1620).
	Timer-owning cache entries clear their timer on the way OUT when a replacement is installed; clearing the incoming entry is vacuous and strands the outgoing payload behind its closure. Test replacement with a live-timer count, not elapsed time (#2073).

5. **A side-channel property dropped by spread / map / filter / `JSON`.** A flag or content-binding hung on an object is silently lost when the object is copied or serialized; the consumer reads `undefined` and mis-decides. *Screen:* read the signal off the ORIGINAL producer object, not a derived copy; if it must survive a copy, make it an enumerable field the copy carries. *e.g.* the diagnostics content-binding thread — #1095/#1104 (cascade fallback-display gated on binding read from the source, not the reconciled copy); #1094/#1096. *Detect:* trace whether the property survives every `{...x}`/`.map`/`JSON.parse(JSON.stringify(...))` between producer and consumer. Not ast-grep-able. **The corollary that broke the nightly (#1240):** when a seam's RETURN CONTRACT changes (the #1179 `touchFile` array→`TouchFileResult` wrapper), sweep the **un-type-checked consumers too** — `scripts/*.mjs` are outside the tsc surface, so the smoke script's `Array.isArray(touched)` reads survived the sweep and silently misread every wrapper as "no client ready" (43 skips + 5 aux fails, 7 green nights → red).

6. **A freshness stamp that doesn't cover what the data depends on.** mtime alone misses content changes that preserve mtime (git checkout, formatters, same-millisecond writes); an mtime keyed on file A misses a cross-file dependency on B. *Screen:* cache validity = `size` + `mtimeMs` as the cheap first tier, then a content-hash confirm; explicitly seed a same-mtime collision in tests. A diagnostic depending on B invalidates when B changes, not just A. The review-graph's `size:mtimeMs` + `confirmContentChanged` is the gold standard. *e.g.* #1105 (word-index refresh + `importsChanged` fast path bound to size, not mtime alone), #1088/#1092/#1633/#1664. *Detect:* grep `mtimeMs`/`.mtime` in an equality/cache-key lacking a sibling `.size`/hash; weak signal — #1158. **Second axis — existence, not content:** a stamp can be perfectly valid about content and still describe a file that no longer exists. A TTL-only scanner cache served a gitleaks 🔴 blocker for a directory deleted eleven minutes earlier, and the #1419 provenance guard certified it `current` seven times because it validates the files the agent EDITED, not the paths named INSIDE the findings. *Screen:* when a cached finding names a path, validate at delivery that the path still exists — not only that the cache is young. Drop the finding when the path is gone (there is no remediation for a deleted file); demote only for content drift on a surviving one. Use `dropFindingsForMissingPaths` (`clients/advisory-provenance.ts`): one stat per unique path, fails open on unreadable paths, and logs one bounded `finding_dead_path_drop` record. *Detect:* grep `readCache<` for stores whose findings carry a file path, and check the delivery seam for an existence probe (#1460/#1461).

7. **A vacuous test fixture that never exercises the code under test.** A hardcoded version literal orphaned by a version bump; a mock missing the property the guarded code reads (so both guard branches pass for free); a drive-letter literal fed to a normalizer as an *expected key* on the assumption it's a no-op; or a suite-wide environment default disabling the mechanism whose side effects the test counts. *Screen:* every regression test must FAIL on pre-fix code, and the fixture must actually reach an armed code path. Side-effect-count tests opt back in with save/restore or assert a positive control. *e.g.* #1114 (kill-process-tree mock had no `.once`/`.killed`, so the SIGKILL-escalation guard passed vacuously — the escalation was dead code), #1089/#1106 (fixture version drift), #1139/#1150 (Windows-shaped literal as expected key — see the OS-agnostic paragraph), #1759 (17 tests asserted a suite-disabled no-op path). *Detect:* the "confirm the regression test fails against pre-fix code" step; a mock asserted on a method it never defines; an environment gate is off for the whole suite. Not ast-grep-able (#1759). *Prevention:* this entry is the review-time catch. The authoring-time form is the six **Test-authoring screens** in the "Test requirements" section below (#1829): parallel path, invisible skip, wrong-layer pin, ambient-inspection double, env leakage, and loose bound. Each is answerable while you write the test.
	**Inverse variant — a fixture that pins a producer shape only one platform emits.** The mock is green and the guard runs, but it does not model the production input on every supported OS. A cap kill is `SIGTERM` with a null status on POSIX, but Windows reports status 1 with no signal or failure. `safeSpawnAsync.killedForOutputCap` carries the cross-platform ownership fact. *Screen:* derive fixtures from the producer through platform-specific builders and a live test that asserts only the portable invariants. Never infer our action from an exit code.

8. **A name-heuristic that silently excludes real data.** A walk that skips by filename pattern drops real files that happen to match (`gen.ts` that is hand-written). *Screen:* any name-based skip needs observability (count what it dropped) + a content-probe escape hatch. *e.g.* #1107 (generated-artifact skip dropped real `gen.ts`; fix added a content probe + skip counters surfaced in project scans). *Detect:* grep filename-pattern skips in walkers; review question "what real file could this match, and would anyone notice it was dropped?".

9. **A resource bounded on one axis while it grows on another.** An entry-count-bounded cache leaking WASM/heap bytes; drop-oldest eviction discarding exactly the earliest evidence a leak-hunter needs. *Screen:* bound the axis that actually grows; when evidence-order matters, don't blindly drop-oldest — pin the earliest N. See the structural-improvements paragraph (#417/#418). *e.g.* #1141/#1123 (handle-origin tracker pins the earliest `TRACKER_PROTECTED_COUNT` entries because a leak is usually among the oldest handles). *Detect:* review question on every bounded cache/tracker — "which axis is bounded, which one grows?".

10. **Silencing counted as fixing.** A persistently-suppressed finding counted "resolved" every dispatch; a baseline computed WITHOUT the same filter pipeline the live pass uses; a producer error read as "0 findings = clean." *Screen:* a suppressed/filtered/errored result is not a resolved one — the baseline must pass through the identical filter pipeline as the comparison, and an empty result must distinguish clean from unavailable/errored. *e.g.* #1087 (sg-scan exit-1 matches dropped, making a failing scan read clean; swept as "silencing is not fixing"). *Detect:* review question — does "0" mean clean, or did the producer error / get filtered?

11. **Skipped-CI-on-conflict, counted as green.** A DIRTY (merge-conflicted) PR can't build its merge-ref, so the real gates are *skipped, not failed* — absent, so a naive check reads them as passing. *Screen:* before merge, verify `Unit tests`/`Lint` actually RAN and passed on the current head SHA — an absent required check is not a passing one. Full treatment in the adversarial-review note above (skipped-CI-on-conflict trap).

12. **A durable commit followed by an out-of-guard mirror refresh.** Full treatment in the "Shape 12" paragraph above (#1309); listed here so the catalog's numbering matches it.

13. **A transient failure classified as durable INSIDE an already-governed latch.** Migrating a memo to the shared availability policy makes its *storage* correct and says nothing about its *classification*. `govulncheck-client.ts` wrote `this.available = false` after a failed `go install`, and that setter routes into `availabilityLatch.noteUnavailable("missing", "not-found")` — governed plumbing, wrong classification, and the resulting `availability_decision` row is a well-formed `missing` verdict indistinguishable from a genuine absence. *Screen:* when a call site hands the policy an outcome it did NOT derive from `classifyProbeFailure`, justify it in a comment at the call site AND record what actually failed — `classifiedBy: "caller"` plus `evidence` (`clients/dispatch/runners/utils/availability-policy.ts`), so the row can be audited instead of trusted. An install failure, a stat, or a shim on disk are all legitimate caller assertions; a spawn result is not — derive it. *e.g.* #1500 (the class), #1467/#1476/#1489 (the migrations that made storage correct). *Detect:* **deliberately ungated.** The available shortcut — flag any literal `"missing"`/`"not-found"` passed into a governed latch — fires on every correct post-ENOENT write, and a gate that cries wolf gets baselined rather than fixed. Review-enforced: grep `noteUnavailable(`/`available = false` and ask what spawn result justified each one.

14. **A test that resets a DUPLICATE of the module's state.** Vitest resolves an import specifier literally, and this repo's runtime is the compiled output, so `x.ts` and `x.js` are two module instances: the `.ts` spelling gives the test a private copy of that module's own mutable state (generation counters, latches, memo maps) while everything the module imports stays shared. A `beforeEach` reset called through `.ts` therefore clears the copy, the code under test keeps reading the compiled original, and the assertion passes without ever observing the state it claims to guard — shape 7 with no visible fixture defect to notice. Note the trap in the ordinary case too: a test whose imports are ALL `.ts` is accidentally self-consistent and green, so "it passes" says nothing; one co-imported `.js` module reaching the same file makes it vacuous. *Screen:* tests import the artifact the runtime imports — `.js` — for every module the build compiles, including `vi.mock` and dynamic-`import()` specifiers. *e.g.* #1514 (the near-miss: the fixer's session-re-arm test only bound after switching its imports to `.js`), #1565 (the class; 17 test files were reaching the same module both ways). *Detect:* `tests/config/module-instance-coverage.test.ts` — a static scan (`tests/support/module-instance-scan.ts`) over every specifier in `tests/`, with a reasoned allowlist. Static on purpose: a twin-on-disk check goes silent in an unbuilt tree.

15. **A detached process-lifetime timer firing into an operation that granted itself a longer wall-clock budget than the timer's own delay.** A 240s LSP idle-reset timer (`clients/runtime-turn.ts`) fired straight into an in-flight `lens_diagnostics mode=full` sweep (which grants itself 300s), destroying the very service the sweep was touching and mislabeling ~81 service-destroyed files as budget exhaustion. *Screen:* when a background timer and a long-running operation can both touch the same resource, the operation must HOLD a gate for its whole lifetime (a counter, not a boolean — an overlapping second call or a throw must still release correctly via try/finally), and the timer must check that gate at FIRE time and defer — re-arming a FRESH delay once the gate releases, never resuming a countdown that already elapsed. Derive the timer's delay from the operation's own ceiling plus a safety margin so the two constants can't drift back into the dangerous relationship; extend the derivation to every path that arms the SAME timer (a shortened/degraded-mode delay is not exempt just because it's usually smaller). A destroyed-mid-operation outcome needs its OWN discriminated reason, distinct from a real timeout or a thrown error — collapsing them into one ambiguous flag reproduces shape 10 (silencing/misclassifying counted as fixing) one level up. And the hold itself is state that must re-arm at session_start (clear it unconditionally on a session boundary) and carry a bounded max-age failsafe (force-release past the operation's own ceiling, with a distinct log record) — a leaked hold that never releases is the INVERSE defect, permanently disabling the timer. *e.g.* #1618 (`clients/lsp/workspace-sweep-hold.ts`'s counter-based hold, `LSPWorkspaceDiagnosticResult.unconfirmedReason`). *Detect:* review question — can a background timer and a long operation touch the same resource, and does anything gate the timer on the operation's actual lifetime rather than a guessed delay? Not ast-grep-able (the racing pair is never syntactically adjacent).

16. **An unverified claim about an external tool's behavior.** Exit codes, output streams, output shape, severity vocabulary, and findings conventions are hypotheses until a real run confirms them — a tool's own docs, your memory of them, and this repo's notes all drift. *Screen:* verify any such claim against the real binary before it ships in code, comments, tests, or rule notes. Capture fixtures for tool output from real runs; never hand-write one — a hand-written fixture drifts from the tool and then pins the drift as if it were truth. When the real binary is unavailable, label the claim unverified at the site and gate the test, never fake it. *e.g.* `trivy config --no-progress` printed usage to stdout, and two lanes broke on it — one read the usage text as a clean scan for its whole life, the other failed on every run (#1757/#1781); `vulture` exits 3 on findings, not the assumed 1 (#1765); `rustc`/`clippy` emit six severity levels, and an ICE mapped to `warning` until a live `cargo` run falsified the assumed two-valued scheme (#1802/#1809); `mypy` exit 2 carries real syntax diagnostics an exit-code table nearly discarded (#1822 review); biome's reporter has no `tags` field, so fixability never fired, and it keys findings by `location.path`, not `source` (#1810); pyright positions live under `range.start`, and every real diagnostic read line 0 until probed (#1809); markdownlint-cli2 treats `--version` as a glob, so its managed probe must use the real bounded `--no-globs -` stdin command (#2045). *Detect:* review question — does this claim about a tool's exit code, output shape, or vocabulary cite a real run, or only a doc/memory of one? A hand-written JSON/text fixture for a tool's output is itself the smell.

17. **A process-lifetime latch holding a session-scoped signal.** A module singleton can remember "once" after the session whose fact justified it has ended. *Screen:* every new once-latch answers "what resets it at `session_start`?". Put session dedupe in the degradation ledger, or reset it in the runtime-session reset block; do not hide it in an unregistered singleton (#1525/#1541/#1542).

18. **A cooldown ladder that outruns its caller's cadence.** A long exponential cooldown can block the caller's natural recovery loop; repeated calls inside that cooldown can also launder a cooldown-served value into a permanent cache. *Screen:* name the caller's retry cadence when wiring a latch, then check both directions: the cooldown must neither suppress recovery nor let a caller promote an unprobed value (#1541/#1543).

19. **A later stage re-deriving identity instead of carrying correlation.** Relative paths, worktrees, drive case, and other ambiguous inputs can resolve differently after the first stage. *Screen:* paired stages carry the earlier stage's resolved identity by call ID or resolved path; they never reconstruct it from the later stage's inputs (#1642; fixed by #1648, whose issue thread documents the re-derivation and resolution-basis correction).

20. **A fallback claiming work from staleness alone.** Age can show that work may be abandoned, but it cannot show who owns it. *Screen:* any fallback that claims unclaimed work proves origin provenance, such as cwd and session, in addition to staleness (#1642).

21. **A late loser overwriting a newer result.** First-non-empty and similar races can let an older completion clobber the winner after shared state has advanced. *Screen:* concurrent writes to one key carry a monotonic generation stamp, and a mutation test proves that removing or neutering the generation guard fails (#1682).

22. **An async write straddling a session boundary.** Availability or verdict work that starts before a reset can publish into the fresh session after an `await`. *Screen:* every write after an await in availability or verdict code captures the session generation before the await and re-checks it before publication (#1674).

23. **An ancestor-walk predicate testing the advanced cursor instead of the starting leaf.** The loop variable changes meaning on every step, so it cannot answer a question about the entity that began the walk. *Screen:* predicates about the starting entity receive the starting path, not the cursor; tests include a layout with a gap directory (#1686).

24. **A second writer added to a shared field without a discriminator.** The #1631/#1641 fix PRs' `WidgetDiagnostic.stale` collision combined demote-and-exclude with demote-but-keep-tally semantics; each fix was green alone, but the incompatibility surfaced only when their branches composed (#1633/#1703). *Screen:* when your change adds a second writer to an existing field: name every existing writer (grep the field's assignments); add a reason/kind discriminator with per-writer semantics BEFORE either lands; prove composition by running the other in-flight PR's test files on a locally merged tree — never by reasoning about different structures.
25. **A process-uniqueness assumption held in module scope.** pi evaluates the pi-lens module graph MORE THAN ONCE per process — source and compiled entries load through separate graphs, in-process subagent binds re-enter the extension loader, and dogfood pass 3 measured one pid emitting `host_boot` nine times. Every module-scope `let` therefore exists N times, so any state whose correctness depends on being the process's only copy silently breaks, and a guard built on it becomes unreachable rather than wrong. The #2133 session-start guard was correct and never fired: evaluation 2 read an empty registration, classified a subagent temp root as `primary`, and ran the full battery (three identical word-index rebuilds, 240.8s of CPU for one index). The instance registry's single mutation tail became N tails and tore `instances.json` (#2146). *Screen:* when you add module-scope state, ask whether a SECOND copy of it in the same process would be merely wasteful or actually wrong. Registrations, serialization points, and once-per-process latches are wrong: put them behind `getProcessSingleton` (`clients/process-singletons.ts`) with a family version, and make the test-reset clear the GLOBAL state. Memos that re-derive the same answer from a stable source (an env read, a host probe) stay at module scope. *Detect:* a test that evaluates the module twice (`vi.resetModules()` + dynamic import) and asserts the second instance sees the first's state; `host_boot.metadata.evaluationOrdinal` in `latency.log` proves multi-evaluation in production.
26. **A substitute surface still applying its old role's filter.** A component that stands in for another surface must deliver at the SUBSTITUTED surface's contract, not at the budget its former always-on role justified. `ast-grep-napi` became the ast-grep LSP's fallback in #239 Phase 2, but kept the per-edit `blockingOnly` floor from when it ran on every edit. That floor drops every rule whose declared severity is not `error` — 380 of the 481 bundled rules — while the LSP it replaces publishes all of them at their declared severity (`clients/dispatch/auxiliary-lsp.ts:179-183` states that contract in words). The gap was silent for the whole life of the seam: the runner reported zero diagnostics in all 255 retained dispatch records, so #2329's dedupe path had never once run with a finding in hand and looked correct because nothing could collide (#2336). *Screen:* when you gate a component behind "run only when X is unavailable", state X's output contract and check the component still meets it; a filter justified by the OLD role is a defect in the new one unless you re-argue it. Cost limits are re-argued against the substitute's value, not inherited: outside the substitute role the component is redundant, so its budget was never the binding constraint. *Detect:* for every fallback gate, diff the fallback's emitted set against the primary's on one fixture that violates a NON-blocking rule; a production-shaped test whose fixture only violates error-severity rules cannot see this class.

For process singletons that own live child processes, an incompatible cell must
call the owner's teardown seam before replacement and carry its pending handoff
into the replacement. The LSP service uses this rule in `lsp/index.ts` so a
schema reset cannot orphan a server fleet.

### AI-authorship smells

A separate, narrower family from the shapes above: not a recurring bug, but a recurring *tell* that generated code stopped at "it compiles" instead of "it's correct." Each member fabricates or launders type evidence rather than earning it — the assert-until-it-compiles pattern. Eight members are shipped as ast-grep rules today (`rules/ast-grep-rules/rules/`); each entry below is **SHAPE → SCREEN → detect**.

1. **`as any` type assertion.** Casting straight to `any` discards every property the compiler could still check. *Screen:* narrow to the real type, or route the cast through `unknown` if the compiler genuinely can't verify it. *Detect:* `no-as-any.yml` (`$X as any`).
2. **Explicit `any` type.** An `any`-typed binding, parameter, or return silently opts out of checking everywhere it flows. *Screen:* same as above — a real type, a generic, or `unknown` at the boundary. *Detect:* `no-any-type.yml` (`predefined_type` leaf, regex `^any(\[\])?$`, plus `$X as any`/`$X as any[]`).
3. **`type X = unknown` alias.** An alias that only renames `unknown` carries zero type information — every consumer still narrows from scratch. *Screen:* give the alias real shape, or drop it and let the rare genuine unknown-input site say `unknown` directly. *Detect:* `no-unknown-laundering.yml` (`type $T = unknown`, at `error`). The alias arm was re-scanned at zero and promoted on 2026-08-20 (#1856); `unknown` parameters and dictionary values remain out of scope.
4. **Conditional empty-object spread.** `{...(cond ? {} : {x})}` hides field omission behind a ternary instead of an explicit branch. *Screen:* prefer an explicit `if`/`else` that builds the object directly. *Detect:* `no-conditional-empty-object-spread.yml` / `-js` (spread of a ternary whose consequence or alternative is an empty object literal). Shipped at `hint` severity: an FP-scan found 147 existing pi-lens uses of this exact shape, which is this codebase's established idiom for optional-field construction, not a shape mismatch.
5. **`Reflect.apply`/`Reflect.get` calls.** Reflection where a typed call or property access already works. *Screen:* prefer `fn(...args)`/`fn.apply(...)` and `obj.prop`/`obj[key]`. *Detect:* `no-reflect-apply.yml` / `no-reflect-get.yml` (+ `-js` twins), at `error`. Standard forwarding inside an inline `new Proxy` trap is excluded structurally; a method merely named `get` or `apply` outside a Proxy remains in scope (#1856).
6. **Chained type assertions.** `x as A as B` stacks two unrelated-type assertions with no runtime check between them. *Screen:* narrow with a type guard, or assert once to the type actually needed. *Detect:* two rules that PARTITION the shape (2026-08-20, refs #1727/#1777). `no-chained-type-assertions.yml` owns the concrete chain (`$X as $A as $B`, excluding `as const` and excluding the `unknown` hop, at `error`, no escape valve). `require-safety-comment-for-as-unknown-as.yml` owns `x as unknown as T` at `error`, cleared by a `SAFETY:` comment naming the invariant. Before the split both rules matched the identical site list, so one cast raised two diagnostics. Both are now tagged `metadata.category: pi-lens-self-scan`, so CI holds this tree at zero for both: the 16 `clients/` casts each carry a real `SAFETY:` comment, and the one unjustified cast was replaced (`clients/runtime-context.ts`).
7. **Bare `object` parameter type.** `object` guarantees nothing about shape, not even that a property exists. *Screen:* use `Record<string, unknown>` for an open bag, or a real interface. *Detect:* `no-bare-object-param.yml` (`predefined_type` regex `^object$` in a parameter's `type_annotation`, at `error`). Zero violations on this tree as of #1597/#1599 and again on 2026-08-19.
8. **"Shape" in a symbol name.** A name that only says "this has some shape" (`PackageJsonShape`, `windowsShaped`) is filler a domain term would replace. *Screen:* name the ownership/role, not the structure. *Detect:* `no-shape-in-symbol-names.yml`, at `hint` — considered for the `error` floor on 2026-08-20 and left at `hint`; excluding test paths still leaves all 48 `clients/` hits, which are production identifiers, not a test idiom. **Deliberately NOT self-scanned**: "shape" is load-bearing vocabulary in this very catalog (the numbered defect-shape list above, `ProbeFailureShape`, `windowsShaped`) — 27 distinct identifiers / 291 occurrences as of the 2026-08-19 audit. The rule ships for repositories without that convention; #1718 decides whether/how pi-lens's own tree is scanned against it.

**ast-grep candidates:** shapes 4, 2, 1, and 6 are *syntactically* detectable and could become dogfooded rules (assessed for false-positive load in **#1158**); shapes 3, 5, 7, 8, 10 are semantic — good and bad uses are syntactically identical — and stay review-enforced. Do not author rules here; #1158 tracks the viable set.

**Anti-slop pattern adoption (2026-08-19, refs #1718).** A maintainer-supervised comparison against dmmulroy/anti-slop's 15 Oxlint rules (src/rules/, MIT-licensed; ported patterns credit the origin in each rule file's note) confirmed the six then-shipped rules above were already clean on this tree — `no-chained-type-assertions` 0 non-exempt hits (pre-strictness), `no-unknown-laundering`'s alias arm 0, `no-reflect-apply` 0, `no-reflect-get` 0 outside the documented 3-argument Proxy-trap exemption, `no-object-parameters` 0, and the `Record<string, any>` dictionary-value arm went from 2 confirmed hits (a wider sweep later found 2 more in test fixtures, fixed and exempted — see `no-unsafe-dictionary-any.yml`'s note) down to 0. That audit's follow-up shipped the remaining feasible patterns as new catalog rules: `no-unsafe-dictionary-any`/`no-unsafe-dictionary-unknown` (the `Record<K, V>` value-type arms, `error`/`hint`), `no-unknown-parameters`/`no-unknown-returns` (`hint` — the arms `no-unknown-laundering.yml` deliberately dropped for THIS repo's own FP load, now shipped for repositories without that finding), `no-known-value-widening` (`hint`, narrowed to the one syntactically self-contained sub-case ast-grep can check: an annotated `const x: Record<K, V> = { ... }` — upstream's full data-flow variable-resolution version is out of ast-grep's reach), and `require-safety-comment-for-as-unknown-as` (`hint`, scoped to `as unknown as` chains rather than every non-const assertion, unifying defect shape 13's ad-hoc "justify it in a comment" ask with a checkable rule). `no-runtime-typeof` shipped at `hint` with three structural exemptions (type-predicate-returning functions, functions named `parse`/`decode`/`validate`/`is`/`assert`, `.d.ts` files) after the original audit found the bare rule unworkable against this tree's 404 client-side hits. `no-widen-then-assert` was NOT ported: upstream's implementation resolves `const` variable references transitively across statements, which needs symbol-table data flow ast-grep's structural matcher doesn't have; a narrowed syntactic subset wasn't found. `no-module-mocking` and the Effect-specific rule stay out of scope per the original audit (test-hygiene ratchet design, and no Effect dependency, respectively). Every new/extended rule's per-file self-hit count against `clients/`+`tests/` is recorded in the adopting PR body, not chased to zero — hint-tier rules are shipped for the catalog's users, not as a mandate that pi-lens's own history retroactively conform in the same PR (#1718 owns that decision).

## Standing maintenance routines (invoke on request)

These are named, well-scoped sweeps a maintainer can ask for by name; each is dispatched deliberately (often to a worker), never run autonomously, and the DELETION routines require proof + adversarial verification before anything is removed. Several overlap existing disciplines: bug-class sweeps, single-source-of-truth/consolidation, and red-first regression tests.

- **Crash fuzzer** — find real crashes and hangs, then open root-cause fix issues. **Trigger/scope:** explicit request to exercise a named surface or bounded scenario. **SAFETY RAIL:** reproduce first; distinguish a real defect from a build, cache, or environment artifact per the dogfooding rule.
- **Internal-only shipper** — ship or delete forgotten internal-only features based on ACTUAL usage. **Trigger/scope:** explicit request covering a named internal-only feature or bounded feature set. **SAFETY RAIL:** usage-based deletion needs real usage evidence (telemetry or grep of call sites), never inference; deletion requires sign-off.
- **Logic simplifier** — simplify convoluted logic. **Trigger/scope:** explicit request for named logic or a bounded module. **SAFETY RAIL:** behavior-preserving only; the full test suite must be green; no semantic change.
- **Logic bugfixer** — model tricky logic to find and fix bugs. **Trigger/scope:** explicit request for a named stateful, ordered, or otherwise tricky logic seam. **SAFETY RAIL:** add a red-first regression test for every fix.
- **Dup unifier** — merge duplicated implementations into one (this IS our single-source-of-truth discipline). **Trigger/scope:** explicit request for a named duplicate family or bounded code area. **SAFETY RAIL:** prove the duplicates are semantically identical; a coverage test must bind the merged form.
- **Dead-code removal** — delete provably unreachable code. **Trigger/scope:** explicit request for named code or a bounded reachability sweep. **SAFETY RAIL:** “provably” means traced (with no dynamic, reflective, or config-driven reachability), not guessed; perform adversarial verification before deletion.
- **Useless-test pruner** — delete tests that cannot fail (defect-shape 7 vacuous tests). **Trigger/scope:** explicit request for named tests or a bounded test family. **SAFETY RAIL:** prove vacuity via mutation (the test passes on deliberately broken code) before deleting; unfamiliar ≠ useless.
- **Shipped-feature inliner** — remove flags for fully shipped features. **Trigger/scope:** explicit request for a named shipped feature and its flag. **SAFETY RAIL:** confirm the flag is default-on everywhere and no consumer sets it off; remove both branches cleanly.
- **Flaky-test fixer** — root-cause flaky CI tests (never mute). **Trigger/scope:** explicit request for named flaky tests or a bounded CI failure pattern. **SAFETY RAIL:** identify the actual nondeterminism (timing, order, or environment); fix the cause; the fix must be deterministic.
- **Abstraction improver** — flatten over-engineered abstractions. **Trigger/scope:** explicit request for a named abstraction or bounded call chain. **SAFETY RAIL:** behavior-preserving; keep one caller-visible surface unchanged.
- **Abstraction police** — fix layering violations. **Trigger/scope:** explicit request for a named boundary or bounded dependency direction. **SAFETY RAIL:** define the intended layering; restore it without breaking the public contract.

Each routine's output is a PR (or a tracked issue for discovery routines), reviewed under the same two-tier adversarial-review + red-first discipline as any change. Deletions are irreversible-adjacent — treat them with the confirm-before-destructive-action rule.

## Standing invariants

Deferred collect-later runners are a three-state delivery contract: edit-time
pending, turn-end clean, or turn-end failed. The pending state must reach the
runner latency and widget surfaces, failures must carry their failure kind into
turn-end delivery, and stale completed findings must re-arm a refreshed
freshness baseline. Turn-end drains use a zero wait budget and requeue unsettled
promises, so deferred work never adds a repeated per-turn stall (#2122).

Post-agent test-runner delivery is activation/session-owned: the staged record
retains its owning host, cache, runtime, and event context, while the quiet
window receives the settled event's stable session identity and activation
owner. A process-global latest activation must never select the pi/cache/runtime
for another session's result. Persisted test-runner generations still gate
delivery before append (#2366).

Live contracts, grouped by subsystem. Consult the group for the seam you
touch; each paragraph carries its evidence issue. New entries join their
group (see the placement rules in "Maintaining this file").

### LSP: acquisition, touches, waits, and diagnostics

Alternate language servers declare their preferred server through
`LSPServerInfo.fallbackFor`. Primary acquisition and aggregate
`clientScope: "all"` diagnostics preserve that order: an alternate starts only
when its preferred server is unavailable. Complementary servers remain
concurrent, and cross-cutting scanners use `role: "auxiliary"`. (#2400)

The live LSP service, generation handoff, workspace-sweep hold state, and
classic TypeScript repair latch use separate versioned families in
`getProcessSingleton`. The service's incompatible-cell teardown uses
`shutdown({ fast: true, reason: "process_singleton_reset" })`; the sweep hold
and repair latch reset through their shared process state, not module copies.
Pipeline-crash teardown is destructive only for the registered primary session;
when no primary registration exists, the legacy reset remains the fail-safe.
(#2157, #2174)

Per-path `didChange` sends serialize their read/build/send/record transaction
through `LSPClientState.notifyChangeQueues`; different paths remain parallel.
`recordSentContent` rejects a lower-version mirror update and records an
`lsp-document-send-order` degradation with the server and normalized path.
(#2113)

Document `didOpen` and `didChange` notifications share those per-client,
per-path queues. A same-turn newer entry replaces only an unwritten pending
entry; a transport write that has started always settles before the newer entry
runs. Replacements retain the latest content and report their bounded count in
the succeeding `lsp_document_send` metadata. (#2357)

Auxiliary diagnostic waits preserve a warm-turn fast path: on a cold
acquisition, the budget is `max(declared wait, observed spawn + 500ms)` clamped
to an 8s ceiling; on a warm acquisition, it remains `min(declared wait, 2000ms)`. An
explicit `PI_LENS_AUX_GRACE_MS` value caps the budget on both paths;
it never raises it. On a cold auxiliary it also caps the request's own
wait, so a low value cancels the request earlier than the pre-#2152 behavior. (#2152)

Pull-diagnostics request deadlines send `$/cancelRequest`, but cancellation is
advisory. While a cancelled request remains unsettled, admission blocks another
pull for the same path/source. The slot frees only on settlement. Apply this to
both `textDocument/diagnostic` and `workspace/diagnostic`, including new pull
entry points, so a server that ignores cancellation cannot accumulate a backlog.
(#1889)

No-filePath workspace-scope LSP queries use a request-local attribution
collector. `lsp_navigation_result` records the serving server id for each
single-client answer and a fixed-key per-capability contributor map for
aggregated operation support. Capability snapshot client ids are capped, with
the full count preserved. Never replace this with shared last-client state;
concurrent navigation requests must not overwrite each other's attribution.
(#1854)

File-scoped LSP navigation is capability-gated twice: the tool layer rejects
unsupported requests before opening a file, and every `LSPService` navigation
chokepoint re-checks the resolved client's `getOperationSupport()` snapshot.
An unsupported client-layer request throws the `__UNSUPPORTED__` discriminator;
do not collapse it into the clean empty result returned by a supporting server.
(#1826)

Workspace-diagnostics per-file sweep verdicts preserve per-server evidence. A
primary answer remains deliverable when an auxiliary is silent or cut off; the
result carries that lane in `unconfirmedServerIds` and stays ineligible for the
fully-covered workspace cache and footer replacement. Never reconstruct the gap
from a touch-wide timeout: consume `touchFile`'s frozen coverage set. (#1549)

MCP `ensureReady` treats its cwd memo as a fast path, not authoritative root
state. It must consult `shouldInitializeSessionRoot` so the session-root cap can
evict and later re-register a root used by a real MCP tool call. The shared
`isSameOrWithin` comparator probes existing POSIX-shaped roots before applying
case-insensitive containment, because macOS filesystems can ignore case. It treats a
case-variant path as insensitive only when both spellings reach the same directory, and
the root memo resets at session boundaries. (#2052)

Bounded LSP warm touches preserve the spawn coordinator's lifecycle evidence:
an empty ready-client set reports `spawn_in_flight_budget_elapsed` while a
matching primary single-flight spawn remains pending, and
`no_clients_none_spawning` only when none does. Read the existing `inFlight`
state at the touch verdict; correlate the full `serverId:root` key using the
root resolved by acquisition, and do not add a second pending-warm latch.
Successful LSP spawn-plus-initialize durations also
feed a bounded process-lifetime history. A bounded client wait skips only after
the matching spawn enters `inFlight` and that server's recorded duration exceeds
twice the wait budget; missing history keeps the full wait. The skip retains the
in-flight verdict and records `budget_skipped_known_slow`, while the background
single-flight spawn continues for the next touch. (#1875, #1875 fix round,
#1884 item 2)

Per-edit LSP dispatch preserves the touch's correlated `unconfirmedServerIds`
through `RunnerResult` and runner latency assembly. The agent coverage notice
renders the bounded scanner set before considering a successful primary result,
so partial diagnostics, including an empty result, never look clean. Reuse the
existing normalized kind+file coverage-notice dedupe; do not re-derive scanner
silence after the LSP touch has classified it. (#1867)

LSP client root selection has a hard session-cwd ceiling: marker/config lookup
may consult parents, but the root used for client identity and spawn never may.
`NearestRoot` clamps an above-cwd marker to cwd and logs that clamp once. After
fixture/gitignore filtering, `LSPService` coalesces a config-only nested root to
an already-hosted same-server ancestor; a nested manifest/lockfile boundary
keeps its independent client. Keep both policies deterministic and free of
wall-clock expiry. TypeScript resolves governing `tsconfig.json`/`jsconfig.json`
separately from package/tooling markers and prefers the config directory for
identity; the same coalescer still folds a config-only nested root when the
ancestor was hosted first (the accepted #1373 open-order sensitivity). Classic
TypeScript clients sample `projectInfo` once per normalized file after the first
successful `didOpen`; this bounded best-effort telemetry never runs for native
TS7 or blocks diagnostics. (#1328, #1373, #1412)

The MCP `lspReadyCwds` set is only a readiness fast path. The authoritative
session-root registry may evict old roots, so readiness must re-register a
memoized root when `isSessionRootRegistered` no longer confirms it. (#2052)

TypeScript diagnostic wait policy is launch-variant-aware: classic
typescript-language-server may accept its complete first push, while native
TS7's versionless publications are provisional until a bounded quiet window
stabilizes the burst (or an advertised authoritative pull settles it). Pass the
live `launchVariant` through every `getStrategy` consumer; never infer a fixed
publication count or manufacture version freshness. (#1412)

Native TS7 cascade neighbor checks use a cascade-only collect-later tier. The
lane sends a no-wait primary touch and quiet-window reconciliation consumes a
newer per-file push or pull publication. The shared server wait policy stays
`waits`, so main-lane behavior is unchanged. Cascade results carry an explicit
`inconclusive` marker through formatting, and only confirmed touches enter the
neighbor cache. (#1444)

Auxiliary LSP waits use each server's declared aggregate wait, capped by a
2-second global post-primary ceiling — in both the touchFile push wait and the
`getDiagnostics` `raceToCompletion` aggregation lane (`aggregation.ts`'s
`PromiseDescriptor.budgetMs`). This admits measured warm scanner runs without
charging every edit for a scanner's longer cold-start budget. An explicit
`PI_LENS_AUX_GRACE_MS` overrides the global ceiling. (#1458)

Late auxiliary LSP publications are captured before the next resync clears the
client cache. Carry them into that read only when their stored SHA-256 content
binding matches the touch content exactly. Unknown or changed-content bindings
never replay. (#1458)

Turn-end late-auxiliary cache probes return per-file diagnostics with the
publication timestamp. A newer timestamp with zero diagnostics is a confirmed
clean result; an absent or older entry is still unavailable. Keep re-arms
bounded by both the TTL and a hard count carried across each drain, and expose
bounded stuck-pair identity in the phase record. Pair-level retirements and
finding-level counts use separate fields and reconcile each drained pair to
one retirement or a pending-after count. (#2151)

Notify-stall teardown is a temporary client-generation absence, not proof that
an auxiliary scanner is gone. `LSPService` carries that reason through the
read-only late-coverage probe with the demotion timestamp until a replacement
generation is published; turn-end correlates each pair's mark to that timestamp
before re-arming under the same TTL and count ceiling. Pairs marked after
teardown follow ordinary `clientGone` handling. If no replacement appears
before that bounded window closes, the pre-demotion pair is retired and
re-raises `lsp_scanner_coverage_gap` with its server/file identity instead of
being counted as an ordinary `clientGone` absence. (#2356)

Every auxiliary touch emits one bounded `lsp_aux_wait_outcome` latency row, on
both producers: the `with-auxiliary` grace wait (`waitShape: "aux_grace"`) and,
since #1533, the `clientScope: "all"` aggregate wait (`waitShape: "aggregate"`),
which derives the same evidence from post-wait state without arming a grace of
its own. Read `waitShape` before comparing rows — `cut_off` cannot arise on the
aggregate path, and its `durationMs` covers the WHOLE diagnostics wait rather
than just the post-primary aux phase, so the same auxiliary reports a
systematically larger number there.
Its per-server outcomes record answered, silent, cut-off, or (#1459) deferred —
a deferred scanner was never sent the content, so it must never occupy the
`silent` row, which is reserved for one that had the content and published
nothing. Outcomes are decided from
EVIDENCE (whether the client's `diagnosticsVersion` advanced past the
pre-notify baseline), never from whether the raced wait promise settled,
because `waitForDiagnostics` resolves on its own timeout and never rejects, so
a silent scanner's promise settling looks identical to an answer unless the
outcome is corroborated against the diagnostics cache. This phase's
`durationMs` is a REAL bounded wait (unlike its zero-duration `LAST_PHASE_EXCLUDED`
siblings), but it stays excluded from last-phase stall attribution because it
is a post-hoc record of a wait that already ran inside the touch's own phase,
not the stall itself. (#1458)

An auxiliary scanner gets at most ONE outstanding `didOpen` resync at a time.
A `clientScope: "all"` sweep fans a full re-scan at every neighbour inside a few
milliseconds, so an unbounded fan-out stalls the scanner's stdin and walks the
#743 notify-write breaker open. The gate is a QUEUE, not a drop: a healthy
scanner accepts each write in milliseconds, so every file still gets scanned,
and only a scanner that cannot accept a write inside the budget makes a waiter
give up. A write that lands after its deadline but inside the wedge window
retracts the timeout it was charged for (slow is not broken); one nothing
accepts for the whole wedge window keeps its strike and demotes the server (see
the #2358 paragraph below for the CPU-liveness guard on that teardown), so
the gate cannot defer a dead input path forever. Its queue wait uses the
effective `primaryServerWaitFloorMs`, which includes the caller's
`maxClientWaitMs` and any primary server `clientWaitTimeoutMs` override, so a
cold primary's configured wait does not make the remaining queue budget appear
to be already exhausted. A DEFERRED server is neither
waited on nor read from — its version cannot advance, so waiting only burns its
budget and would flip the touch to `inconclusive`, and its diagnostics cache
still holds the previous content's findings because the resync that would have
cleared it never ran. The screen when you add an auxiliary: if its per-file scan
can exceed the notify-write budget, a whole-tree sweep will break it — and its
silence reads as CLEAN unless the touch names it. A scanner that never attached
(breaker open) or never received the content (deferred resync) belongs in
`unconfirmedServerIds`, exactly like a cut-off or silent auxiliary, and the gap
must reach the AGENT-facing surface too
(`CascadeNeighborResult.unconfirmedServerIds` and the cascade formatter), not
only the result wrapper. One aggregate `lsp_scanner_coverage_gap` count per
touch records every pair; detailed re-raised rows use the bounded telemetry
cap for the current turn, while the degradation ledger retains a bounded
latest server/file identity window and its dropped count. The aggregate row
reports dropped detail, so identities beyond those bounds are not implied.
#1493's content-hash exemption outranks a deferral: a scanner whose STORED
publication is bound to exactly these bytes has reported on this file, so the
skipped resync withholds nothing — it stays covered, and its stored findings
must still reach `.diags` through the carried-auxiliary path. Both breaker-skip
and deferral open BEFORE any wait, so `auxiliaryCoverageGap` (which reads wait
outcomes) cannot see them on the `clientScope: "all"` sweep path, which emits no
outcome rows at all — they are unioned into `unconfirmedServerIds` separately.
(#1459)

**The notify-stall teardown tells dead from busy before it kills (#2358).** The
wedge timer armed by `claimAuxNotifySlot` and the #743 streak ladder both call
the same `demoteForNotifyStall`, and both now decide through the CPU-liveness
discriminator. The wedged-write window is ADAPTIVE: max(fixed floor, k x EWMA
per-write drain latency x unacked depth), capped at `notifyWedgedCapMs()`
(default 60s). The EWMA (`auxNotifyDrainLatencyEwma`, `noteAuxNotifyDrainLatency`)
is folded only from DRAINED notify barriers — a round-trip that proves the
server processed its backlog — so a scanner that historically answers slowly
earns patience instead of dying by construction. Past the window, the server's
live process tree is sampled twice across `notifyStallCpuSampleMs()`
(`notifyStallCpuVerdict` -> `sampleProcessTreeCpuPercent`, `clients/
resource-sampler.ts`); a BUSY server is left alone and the timer re-arms, and
only a flat or unmeasured one is torn down. The hard cap still kills a server
whose CPU burns past its deadline: the replacement is the self-heal. The record
`lsp_notify_backpressure_broken` names which discriminator fired
(`budget-exceeded-cpu-flat`, `budget-exceeded`, or `cap-exceeded`) and carries
the measured `budgetMs`, the `ewmaInputMs` input, the `unackedDepth`, and the
`cpuVerdict`, so a production kill is classifiable from its own log line. A
write that lands inside the adaptive window retracts the strike it was charged
(the retraction ceiling matches the wedge window). The unacked ceiling stays
pure backpressure; only the teardown decision gained discrimination. A busy
defer emits the bounded `lsp_notify_stall_cpu_busy` record, one per re-arm
cycle. Clients expose their live pid through the optional `getProcessPid`
capability; a client without it (a test double, a legacy client) keeps the
pre-#2358 demote-at-budget behavior. #2358's prerequisite is its own Windows
fix: `clients/resource-sampler.ts` resolves `powershell.exe` through the shared
`windowsExe` seam (System32) — the old path omitted `System32`, so every
Windows CPU sample read as null and the discriminator was blind there.

The notify-stall token is generation-owned: replacement, idle eviction, capacity
eviction, and reset release its timer before state changes. Async decisions check
the exact client object before sampling, after sampling, and before demotion or
re-arm. Windows CPU history includes CIM `CreationDate`, so PID reuse starts a
fresh rate window. A target missing from either sample or a failed query is
`unmeasured`; missing descendants remain partial but valid evidence. Busy detail
telemetry is rising-edge bounded per client/file identity, with repeat counts and
dropped detail retained by the degradation ledger. The unmeasured verdict maps to
the supported `budget-exceeded` discriminator, never to a fabricated flat result.
Windows and POSIX samples validate finite, nonnegative RSS and CPU counters before
they enter measured evidence; counter resets retire the baseline. Busy decision rows
are excluded from `lastPhase` attribution because they describe an outcome, not host
work. CPU identity history is capped at 4096 entries with oldest-entry eviction.

**A touch's `inconclusive` verdict is PRIMARY-scoped; an auxiliary can only
narrow it.** `resolveTouchVerdict` (`clients/lsp/diagnostic-binding.ts`) owns the
one rule, and both its inputs name primary-role servers only. An auxiliary that
missed any deadline — notify write, aux grace, or its own diagnostics budget — is
a COVERAGE GAP (`confirmation: "partial"` plus `unconfirmedServerIds`), never a
verdict, because the diagnostics deadline is the MAX over the servers waited on:
a touch-wide flag let opengrep's 3500 ms budget discard a TypeScript answer that
landed in 100 ms (97.6% of 6,079 cascade sweeps read inconclusive, against 15%
for edit-time touches). The screen when you touch this merge: decide "did it
answer" from EVIDENCE — a per-path publication stamp advancing past the
pre-notify baseline (#1531), or a fresh per-file cache entry — never from how a
promise settled, and fail CLOSED on a client that exposes neither, so the rule
can only narrow a verdict and never invent a confirmation. The capability-aware
silent-clean gates are primary-scoped for the same reason. Two obligations ride
with the change: an auxiliary whose write never landed must have its stale
findings dropped from `.diags` (they describe the previous revision, and the
blanket verdict used to hide them) — and that drop is judged on a MERGE-TIME
content-binding read unioned with the pre-notify snapshot, because #1493's
snapshot is captured before the write and cannot see a write that lands late and
then publishes for these bytes (#1459's own signature); one predicate decides both
the drop and the coverage naming, so a scanner can never be named uncovered while
its findings ride along. And an inconclusive touch must name its cause
— `inconclusiveServerIds` plus `inconclusiveReason` (`notify-write` /
`diagnostics-wait` / `mixed`) on the result, in `lsp_touch_file`, and in the
cascade's `neighbor_touch` row. (#1549)

**Content-bound coverage is ONE rule, evaluated ONCE, at the merge.**
`auxCoversThisContent` (`clients/lsp/index.ts`, inside `touchFile`) is that rule
— the pre-notify `auxPublishedThisContent` snapshot unioned with a live
`getDiagnosticBinding` read, both asking `bindingMatchesTouchContent`, the only
place `touchContentHash` is compared. `auxCoveredAtMerge` freezes it as the last
statement before the merge, and every door that shares the merge's consequences
reads that SET, never the function: the merge drop, the deferred door, the
merged BINDING (a dropped contributor loses its findings and its fingerprint
together), and the result's `unconfirmedServerIds`. The two aux wait-outcome
producers still call the function, because their rows describe their own instant;
their verdict is reconciled against the freeze before anything is claimed.

Both timing errors are live defects, and they point opposite ways. Asking
EARLIER than the decision underclaims: #1549 put the notify-write door on the
merge-time read but left the DEFERRED door on the pre-notify snapshot, which
cannot see a write that lands after it, so a scanner that had published for
exactly these bytes while its resync sat queued was dropped and named (#1586).
Asking LATER overclaims, and that is the worse one: `touchFile` awaits after the
merge (`brokenSkippedAuxiliaryServerIds` on every collecting touch, the tsserver
sync and liveness gates on theirs), so re-asking when the gap is named let a
publication landing in that window un-name a scanner whose findings the merge had
ALREADY dropped — `confirmed` over a `.diags` that is missing the scanner's
answer, which unblocks the `lastKnownDiagnostics` prime and the
`demonstratedReady` mark that `coverageGap` exists to hold shut. A drop is an
action; a later answer cannot undo it. The screen when you add a door: ask the
rule where the decision is made, never earlier and never later, and if your door
acts on the answer, read the freeze. The `lsp_notify_resync_deferred` row keeps
recording the gate's action either way; the coverage fields report only what the
touch is actually uncovered for. (#1586)

A deferred cascade result that arrives LATE — past the turn-end settle cap, or
in the quiet window after the turn already consumed its runs — must still reach
the agent. `turnSeq` is not a staleness signal for such a run (a late run is by
definition from an earlier turn); `projectSeq` is, because it advances on every
pi-observed write. When you add a `consume*` drain guarded by a monotonic
counter, ask whether the producer's contract is carry-over, and make every drop
emit a record: a carried value that a freshness filter rejects unconditionally
is dead code that silently loses findings. (#1443)

**LSP idle eviction is lease-guarded across acquisition/use.** `isBusy()` only
becomes true after a client request enters the transport, so it cannot protect
the yield between manager selection and the first notify/request. Operations
must acquire the manager-owned client lease under the spawn gate, validate that
the selected client is still the published instance, and release in `finally`;
idle and ceiling eviction skip leased keys. Deterministic race tests suspend the
first client operation with `tests/clients/interleaving-kit.ts`, never sleeps.
The TypeScript idle default is 20 minutes to preserve warm LSPs across subagent
bursts; every non-idle removal path must also clear timer ownership. (#1332)

**Known-slow LSP shortcuts yield to completed acquisition.** The spawn-history
margin is strict and boundary-tested at 2x the effective wait. A known-slow
sentinel is deferred long enough for queued completion publication, and its
decision point re-reads live clients because `inFlight` cleanup is asynchronous.

**Session-start availability resets include direct LSP and installer path positives.**
Direct-LSP negative cooldowns and installer bare-command path positives are
session facts: the former can recover when a command appears, and the latter
returns without a spawnability check. `handleSessionStart` clears both behind
the primary-only session-start guard; the session-state registry records the
two reset seams. (#1897)

**Workspace refresh walks the bounded ancestor cache chain.** A language server
root can be a nested monorepo member while workspace diagnostics persist under
the enclosing sweep root. `workspace/diagnostic/refresh` clears the client
root and each ancestor through the session cwd, so a never-swept member cannot
leave its prior workspace cache alive; it never walks above that ceiling.
(#1707)

The LSP status surface includes a bounded per-client history of operational
diagnostic-pull failures; unsupported `-32601` responses are intentionally
excluded. Strategy-gated `didSave` remains separate and out of scope here.

LSP file-operation registrations retain their validated filter arrays through
client state. Both rename send boundaries match the old and new file URIs by
scheme, glob, explicit file/folder kind, and `ignoreCase`; entity kind comes
from a live old/new path lstat probe (the renamed entity, not its target), never the host OS. Malformed registrations
and unsupported URI schemes fail closed. Capability-skip evidence uses the
fixed reasons `no-registration`, `malformed-registration`, and `filter-mismatch`. (#2049)

LSP workspace-edit merge buckets are keyed by `pathIndexKey`, not raw URI
spelling; each canonical bucket retains its first URI as the display key.
Call-graph `allSymbols`/`allRefs` file keys are `normalizeMapKey`-canonical,
and lookup, cross-file filtering, and same-file classification must use that
same canonical form.

TypeScript LSP clients are evicted after `PI_LENS_TS_IDLE_EVICT_MS` of inactivity
(default five minutes). Eviction removes the client from service state before
graceful shutdown, releasing the server-owned language-service programs and
document registry; the next request rebuilds transparently. The per-root timers
must stay unref'd, reset on reuse, busy-client guarded, and cleared on shutdown.

The live native-TS7/Vitest fixture suite is opt-in with
`PI_LENS_INTEGRATION=1`; it copies the excluded fixture to a temporary
non-fixture project INSIDE the repo before launching the real server — the
in-repo location is load-bearing (the copied project has no node_modules, so
native-TS7 detection and vitest type resolution walk up into the repo's own).
Root-walk misses remain uncached, and bounding the walk at cwd is a PROVEN
regression (found-above-cwd and not-found are different answers: bare
detectors and the Deno exclusion gate depend on the distinction) — do not
reattempt without solving that. (#1412)

LSP root exclusion recognizes fixture conventions by exact path segment; Go's
`testdata` convention applies ancestor-wide, but names such as `testdata-tools`
remain ordinary project directories. The positive `.gitignore` glob precheck is
cached per resolved project root and `size:mtimeMs`, including the absent-file
empty result, while the project ignore matcher remains authoritative.

LSP acquisition records name the caller that STARTED a language-server process
apart from the callers that joined its in-flight spawn. `lsp_client_selected`
carries `cold-spawn`/`spawn-failure` for the starter and
`cold-spawn-joined`/`spawn-failure-joined` for every joiner, and the
starter/joiner bit is captured before `await spawnPromise` — after that await
the two are indistinguishable, which is how one 29.3 s TypeScript spawn read as
39 spawns in 2 ms. The AUTHORITATIVE spawn count is `lsp_server_spawned`, the
process-start record emitted once at `spawnClient`'s success path for every
server. It does not depend on a per-server launcher record such as
`lsp_launch_candidate_success`, which the TypeScript path never reaches. The
two records relate as `count(lsp_server_spawned) >=
count(outcome="cold-spawn")`, never as equality: `getClientsForFile` and
`getAuxiliaryClientsForFile` call `ensureClientForServer` without `onOutcome`,
so a multi-client or auxiliary spawn writes a spawn record and no selection
record. The starter-outcome count therefore under-counts real process starts,
and only `lsp_server_spawned` answers "how many servers did we start".
(#1934, #2064)

### Dispatch, runners, formatters, and installer

`FactStore` bounds file facts on two axes: 1,024 LRU records and 64 MiB of
retained UTF-8 `file.content` bytes. It maintains the byte total at each
mutation; never replace that total with a hot-path map scan. Pinned dispatch
records count toward the byte budget but remain exempt from eviction until
`endDispatchFor`, because dispatch reads content after its runners settle.
Capacity telemetry keeps the per-store subject and names the triggering
`count` or `bytes` axis in the existing bounded degradation record. (#2247)

Managed verification uses the registry's optional `verificationTimeoutMs` at
every installer-owned probe seam, including local discovery, npm install, and
periodic refresh. The refresh candidate projection carries that policy instead
of reintroducing a shared literal. (#2176, #2194)

The dispatch lsp-runner's `touchFile` call has its OWN 5-second cold-spawn
wait floor (`RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs`,
`clients/dispatch/runners/lsp.ts`), separate from installer verification —
`getClientForFile` only raises it when the matching `LSPServerInfo` declares
`clientWaitTimeoutMs` (the seam RubyServer already used). Bounding a tool's
installer verification alone does not stop a cold spawn from losing this
separate 5-second race, so `clientWaitTimeoutMs` must mirror the tool's
`verificationTimeoutMs` on the LSP registry side too: Bash and JSON at 20s,
Vue at 30s, Svelte at 20s, and Prisma at 40s. (#2169, #2176)

The project ignore matcher keeps its per-path verdict memo hot between edits.
The write-result seam calls `invalidateProjectIgnoreMatcherForPath` for a
`.gitignore` mutation: it scans every cached root containing the edited path,
rebuilds a root matcher, and evicts only the changed subtree for nested files.
This handles non-git trees and nested git roots, preserves compiled-glob reuse,
and avoids a nested-file stat on every `isIgnored` verdict. IDE edits, checkout
or merge restoration, and writes under already-ignored directories remain
outside the tool-result producer and are tracked by the freshness-probe issue.
(#2071)

Consumed nested `.gitignore` sources carry their build-time `mtimeMs` and size
in the project matcher cache. `getProjectIgnoreMatcher` sweeps those sources
at most once per root per two-second cadence and routes drift, including
deletion, through `invalidateProjectIgnoreMatcherForPath`; newly discovered
sources append to the baseline without replacing existing signatures, and it
never stats on `isIgnored` verdicts. (#2159)

Knip's dispatch memo is instance-owned and keyed by canonical project root plus
the runtime's monotonic project sequence. Only callers that supply that content
generation may reuse a successful result; explicit fresh-analysis callers omit
it. Cache hits and executions are separately labeled, and session start clears
the memo before the startup scan can prime it. (#1868)

Bash write attribution recognizes common in-place formatter and fixer commands
only when their source-file targets are explicit. Bare project-scoped `cargo
fmt` and `dotnet format` remain unresolvable without a workspace walk. At the
read guard's FileTime gate, uniquely resolved live `oldText` is stronger content
evidence and softens staleness; ambiguous or missing `oldText` never does.
(#1903)

Coverage markers are deduped per session by normalized kind, file, and the
normalized silent-scanner set. A changed set admits a new marker, and a marker
is appended after primary diagnostics so both remain visible.

Availability probes for package managers, dispatch, Go and Cargo toolchains,
security scans, checkers, and cwd probes use owner-local keyed flights created
by `createAvailabilityProbeFlight`. An owner with a reset seam clears only its
own registry (dispatch clears checker and cwd flights; package-manager clears
its own); the toolchain and security registries have no reset and rely on
flight-settle semantics plus stable keys. Dispatch-owned flights also use the
dispatch generation guard, and
joined records retain `classifiedBy: "joined"`. Release-managed binaries under
`~/.pi-lens/bin` resolve before PATH probing, and the resolved path reaches
security scans. Overrun records use the cache key as their second subject
component, not a root. (#2131, #2140)

Formatter PATH availability is session-scoped and must be re-armed in the
primary `handleSessionStart` reset block beside dispatch availability. Its
module-local state is not covered by the dispatch generation, and secondary
session guards must continue to skip both resets. Re-arm through
`clearFormatterCache`, never the which-latch clear alone: `getFormattersForFile`
answers a same-cwd lookup from `detectionCache` before it reaches a probe, so
dropping the latches without the selection cache leaves the previous session's
verdict standing in the working directory. Formatter selection emits
`formatter_selected` with `outcome: "hit" | "miss"` on both cache hits and
re-detections so hit rate is computable from `latency.log`. The first lookup for
a cwd computes one session-generation config signature; warm extension lookups
do no config polling. The write-result seam calls
`invalidateFormatterCacheForPath` for config create, change, and remove events,
which clears the signature and selection state together. External editor
changes remain outside that seam and are rechecked at session reset. (#1895,
#1940, #1603)

Helm chart linting uses the shared workspace-topology `Chart.yaml` marker. YAML
and `.tpl` edits inside a chart dispatch one canonical-root-deduplicated,
bounded `helm lint` pass through the ordinary typed availability/install seam.
It is smart-default and read-only. Rendered-manifest validation (#1283 slice B)
ships beside it as the separately-gated, OFF-by-default `helm-render` runner —
see the IaC-misconfig note in the pipeline section.

The javac standalone-file fallback walks for Maven/Gradle descriptors from the
edited file's directory through `DispatchContext.projectRoot` inclusive. Never
let a descriptor above the session project suppress the fallback; nested module
descriptors inside the project still gate it. (#1877)

Context-free compiler runners preserve compiler severity but never claim a
blocking semantic when the invocation lacks the project inputs needed to prove
that verdict. This applies to standalone javac, C/C++ syntax checks without a
compile database, `zig build-exe` without build.zig module context, and direct
elixirc without Mix; project-backed Mix and dotnet builds may still block.
(#1885)

**Spawn repair decisions use the typed safe-spawn taxonomy.** A raw OS
`ENOENT` can mean either a missing executable or an invalid child cwd. Consume
`SpawnResult.spawnFailure.kind` / `SpawnFailureError.kind`, never errno or
message text, and trigger install/reinstall only for `tool-not-found`.
`cwd-unresolvable`, `permission-denied`, `spawn-failed`, `timeout`, and `killed`
must remain non-repairable at that seam; the original errno-bearing Error is
preserved as `cause`. (#1214)

**Managed verification uses each tool's declared command and closes stdin.**
`verifyToolBinary` defaults to `--version`, but all registry-driven callers pass
`ToolDefinition.checkArgs` through local/global/user/install/refresh paths and
opt into `safeSpawnAsync`'s `input: ""` so every verification receives EOF.
The registry may declare a larger bounded timeout for a tool whose cold
launcher startup exceeds the installer default; Vue uses 30 seconds while the
installer default remains 10 seconds (#2176). bash-language-server and
vscode-json-language-server measured 9,667ms and 11,047ms cold with closed
stdin — both close enough to the 10s default that host contention alone can
trip a false verification degradation — and use a 20-second bound (#2194).
svelte-language-server and @prisma/language-server measured 12,410ms and up
to 27,265ms cold with closed stdin and use 20- and 40-second bounds (#2169).
Delivery is proven per strategy, not just for npm: `probeManagedToolVersion`
(pip/gem) and `verifyRefreshedArtifact` (github/maven/archive) both resolve
the timeout through `getToolVerificationTimeout` on every call, and each of
the six strategies has a test that raises a tool's `verificationTimeoutMs`
and asserts the exact value reaches the post-refresh `--version` spawn (#2194).
This matters for markdownlint-cli2: `--version` scanned 45 files and returned
in about 370ms when stdin was closed, while `--no-globs -` linted one stdin
file and returned in about 370ms; with production-shaped open stdin the latter
waited for the full 10s budget. The bound is therefore supplied by the spawner,
not by the CLI. Verification failure logs include the effective check arguments
and prefer `spawnFailure.kind` over generic `error` text. Markdownlint's
availability checker and install fallback use the registry's bounded
`["--no-globs", "-"]` command through the managed-shim path as well (#2045).

**One-shot process-table collection distinguishes exit failure from empty.**
`spawnCollectStdoutResult` reports `exit-error` with code/signal and discards
stdout from non-zero exits; process-table callers record that outcome instead
of parsing partial output as a clean empty result. Sampler timeouts inject the
reaper's tree-kill-and-verify hook and settle only after its fate is known.
(#1863, #1864)

The `agent_end` deferred-format drain runs at most three formatter subprocesses
concurrently, then processes claimed results in admission order with a
`setImmediate` yield between bookkeeping steps. Keep formatter invocation and
per-file bookkeeping isolated so multi-file batches cannot recreate one
CPU-bound event-loop burst. (#1387)

Source-filter tests pin the ordering agreement between the forward precedence map, reverse source-twin candidates, and filesystem sibling resolution; the intentionally broad `.jsx` fallback remains part of that contract.

Extension policy tests bind JS/TS fact applicability and bash source-like file
access to `KIND_EXTENSIONS`; the only intentional exceptions are the documented
Vue/Svelte fact exclusion and the small legacy text/config allowlist in
`clients/file-kinds.ts`. Keep new language extensions there rather than adding
provider-local regexes or sets.

Startup lazy-loading (#1394 Phase 2): the dispatch runner graph is loaded through
`clients/dispatch/lazy.ts`. Session-start callers may warm its shared promise
without awaiting it; the per-edit pipeline must await that same promise before
dispatch or cascade work. Keep host registrations eager and never create a
second warm promise for concurrent/subagent session starts.
The formatter catalog follows the same rule through `clients/formatters-lazy.ts`;
`format-service.ts` must await that shared promise before catalog lookup or
formatter execution.
The LSP service follows it through `clients/lsp-lazy.ts` for async pipeline,
session, and warm-attach consumers. The `index.ts` status/reset adapter remains
eager because its synchronous shutdown/status contracts are host-visible; do
not make those callbacks async without updating their ordering contract/tests.

**Multi-formatter extension policies resolve to one formatter (#1306):** explicit project configuration wins, and every policy with multiple candidates must name one unique `defaultFormatter` as its deterministic overlap tie-break. Kotlin Spotless selection is parsed from `build.gradle{.kts}` and `settings.gradle{.kts}` `spotless { kotlin { ... } }` blocks through `getSpotlessKotlinFormatter`; never add independent ktlint/ktfmt detection at a caller. Its small lexical pre-pass blanks comments and quoted strings before brace scanning (disabled `if (false)` blocks remain an explicit non-goal), and Gradle reads are memoized by path plus `mtimeMs` so repeated per-file selection does not repeat config I/O while mid-session edits invalidate naturally.

**Truncation guards read the output-cap predicate before status handling (#2100).** `safeSpawnAsync` only sets `outputTruncated` when a call site passes `maxOutputBytes`. `truncatedByOutputCap` (`clients/spawn-output-cap.ts`) is the only guard for those incomplete bytes. It runs before failure or status handling and excludes timeout and abort, which own their classifications even when the output was capped. `stopForOutputLimit` separately records `killedForOutputCap` when it starts ending the child. POSIX commonly returns null status plus `SIGTERM`; Windows returns status 1 with no signal or failure. Callers that need to know whether pi-lens ended the process use `killedForOutputCap`, never either platform exit shape. This distinction matters to helm render: a cap-killed render leaves an unchecked prefix, while a completed render with truncated progress output still validates its output tree. A `maxOutputBytes` needs a rationale comment and a spawn-options cap test. Test POSIX and Windows cap-kill builders plus timeout and abort variants (`tests/support/spawn-shapes.ts`), anchored to a live cross-platform invariant in `safe-spawn-ambient-signal.test.ts`. The predicate stays dependency-free because shared runner tests mock `safe-spawn.js` directly. `classifyRunOutcome` uses output-cap evidence only to improve ledger wording, never to change outcome kind.

**Markdownlint default-config invariant (#833):** the Markdown dispatch runner invokes `markdownlint-cli2` with the package-owned `config/markdownlint/core.json` when no project markdownlint config is found; that config disables MD013 and sets MD024 to `siblings_only` so intentional repeated category headings in changelogs are allowed while duplicate sibling headings remain violations. A project config is left to markdownlint-cli2 unchanged (no runner-level rule overrides). `hasMarkdownlintConfig` must recognize every config filename supported by the installed markdownlint-cli2, including the `.markdownlint-cli2.*` and `.markdownlint.{jsonc,json,yaml,yml,cjs,mjs}` families.

**Biome bundled-config decorator-metadata invariant (#2385):** the bundled fallback `config/biome/core.jsonc` disables `style/useImportType`. The rule's safe fix rewrites a value import used only in type positions into `import type`, which erases the runtime binding that `experimentalDecorators` + `emitDecoratorMetadata` still need: verified against real Biome 2.5.9 plus tsc, the emitted `design:type` metadata changes from the imported class to `Function`, breaking decorator-based dependency injection. Biome's own rule docs recommend disabling the rule for such repos. An explicit project `biome.json(c)` remains authoritative: `biomeConfigArgs` passes no flag there, so a user-enabled `useImportType` still applies. Do not re-enable the rule in the bundled config without solving the metadata hazard; the lint and autofix surfaces both lose this one advisory, and no `skipReason` is added because nothing is skipped — the rule simply never fires. `tests/clients/biome-config-decorator-metadata.test.ts` drives the real pinned binary through `BiomeClient.fixFileAsync` and pins the preservation, the intact recommended ruleset, and the user-config authority; removing the override or the fallback flag turns it red. The sibling bundled fallbacks are not members of the hazard class: the ruff fallback selects no flake8-type-checking rules and `ruff-client.ts` never passes `--unsafe-fixes` (verified with real ruff on an annotation-only import), and the markdownlint fallback touches no runtime semantics.

**Template-bearing extensions select no unconfigured formatter (#2384):** `FORMATTER_POLICY_BY_EXTENSION` sets `defaultWhenUnconfigured: false` for `.html`, `.htm`, `.yaml`, and `.yml` (the `.md`/#89 precedent). Real Prettier reinterprets template markers as code — an HTML `<script>{{JS}}</script>` embed became nested JavaScript blocks, and a Helm `{{ .Values.x }}` became `{ { .Values.x } }` (verified against prettier 3.3.3). A project `.prettierrc` or `package.json` `prettier` field opts in through the ordinary explicit-config branch; oxfmt's explicit-config path is unchanged. Do not restore a smart default for these extensions without solving marker preservation; a one-line fixture cannot prove safety because it hits `indentationArgs`/SKIP_FORMATTING before the tool runs.

### Rules and analyzers

Mechanical ast-grep rules may expose a `fix:` only when one syntax rewrite is
unambiguous. Reflect.apply remains diagnostic-only because an own shadowed
`.apply` changes the obvious rewrite's semantics. Two-argument Reflect.get uses
a scoped rewriter; receiver forms remain diagnostic-only. Snapshot fixtures
under `rules/ast-grep-rules/rule-tests/__snapshots__/` prove generated output.
Keep branch metavariables distinct from the outer Proxy-carve-out metavariables;
fixtures deliberately name the constructor target and trap parameter differently.
The generated ast-grep catalog derives its Fixable yes/no column from each
rule's top-level `fix:` key. (#1850)

The `require-safety-comment-for-as-unknown-as` valve accepts adjacent comments
on object-literal `pair` members; array elements, call arguments, JSX
attributes, class static blocks, and switch cases use the enclosing statement.

Rule-id normalization derives its language suffixes from the bundled CodeRabbit rule tree at startup; tests must keep that derived set covered so new vendored language rules cannot silently evade project policy matching.

The shipped ast-grep catalog includes `no-bare-host-path-in-win32-branch`
(#1158 shape 2). It deliberately matches only the consequence of an `if`
guarded by `isWindowsPath` or `isFullyQualifiedWin32`; host-default path calls
elsewhere, including the valid fallback arm of a ternary, remain allowed.

The YAML ast-grep rules cache snapshots every discovered rule file with
`mtimeMs` and size, metadata only — no content hashing. `getCachedRules`
serves the bundled tier, which is immutable per install, so it inherits
`clients/cache/rule-cache.ts`'s documented content-confirm exemption; adding
a content hash here cost a measured 8000x on a per-file hot path (#2292).
A 2 s freshness cadence bounds re-stat work; rule-edit pickup lag is bounded
by one cadence. It must detect edits to existing files and additions below
nested rule directories; directory mtime alone is insufficient on supported
filesystems. A same-size, same-mtime edit is invisible by design on this
tier. (#2262)

### Caches, durable stores, and path keys

The project-snapshot authoritative-write cache stamps both `mtimeMs` and size
at save and after promotion. Both `loadProjectSnapshot` and
`loadProjectSnapshotExportsAndRules` serve the in-process object only while
disk mtime is `<=` the stamp and size still matches. Keep `<=` for the
in-flight-write case; size detects different-length writes in a coarse mtime
bucket. Same-size, same-mtime external rewrites remain invisible by design,
and this hot read path does not content-hash. Only `loadProjectSnapshot`
re-arms the idle-eviction timer on a cache hit (`touchAuthoritativeSnapshot`),
so a bucket the narrow loader alone keeps hitting rides an indefinite mask,
not one bounded by the 20-minute idle window. (#2285)

Advisory caches must carry immutable capture provenance and validate it again
at every delivery surface. A finding is current only when session/turn state
matches and every affected file is SHA-256-confirmed (size+mtime is only the
cheap tier); legacy, malformed, truncated, unreadable, or superseded records
are historical and non-blocking, while deleted per-file findings are omitted.
Async test batches publish only when their persisted monotonic generation is
still current. Keep peek/consume classification identical and preserve
one-shot delivery, MCP acknowledgement, and git-guard structured state. (#1413)

Bounded async metadata walks must separate admission order from completion
order: use a fixed-size indexed cursor pool, store each result at its original
walk index, and publish only by iterating that array from index zero. Check
supersession before every claim and after all in-flight work settles; per-item
metadata failures retain the prior synchronous skip semantics. Never let
parallel filesystem completion order drive a behavior-gating Map or preflight
list. The word-index resume stat walk defaults to 8 workers (libuv's threadpool
caps real fs parallelism at 4; the surplus is queue depth) and follows this
pattern. (#1409)

**Behavior-gating durable stores serialize read-modify-write.** Atomic rename
prevents torn JSON but not lost sibling-process deltas. Use
`clients/durable-store.ts`; short synchronous commits acquire the bounded PID
file lock, while awaited commits acquire its shared quarantine-directory
variant. Both perform the authoritative disk re-read internally (callers
receive only its serialized contents through `deserialize`, never supply a
read callback), merges only the caller's delta, and publishes through a
throwing atomic write. `afterWriteLocked` cache refreshes run after publication
but before lock release so another writer cannot pair its stat with stale
committed state; telemetry or other post-success work must preserve that
ordering when it is state-coupled. The
PID liveness check has a documented bounded PID-reuse exposure. Both lock
forms use unique ownership tokens; the awaited form renames stale locks and
releases aside before token inspection, so a late owner cannot delete a
replacement lock. Callers must
choose contention policy explicitly: correctness-critical stores use
`onContention: "throw"`; dispatch-adjacent best-effort stores use `"skip-log"`
with a drop telemetry callback and skip the whole commit when acquisition
returns `null`. (#1202)

Generic atomic-write staging names are owned only by
`clients/atomic-write-staging.ts`: mint, strict classification, owner-pid
extraction, and the bounded session-start sweep must stay on that seam so a
format change cannot drift from garbage collection. The installer probe cache
uses the awaited durable-store seam: its delta/version snapshot maps to
`merge`, pending-update retirement and mirror refresh run in
`afterWriteLocked`; TTL ageing is also applied inside the authoritative merge,
while existence/mtime validation remains read-side policy. Turn-state remains
separate pending a future ownership decision.
(#1209, #1212)

**Path-keyed Tier-3 caches normalize at both boundaries.** Widget LSP server
roots, startup-scan context keys, and Ruby drive-root memo keys use
`normalizeMapKey`; equivalent separator/case spellings must share one entry.
Test-runner project-root caches additionally canonicalize through guarded
`realpathSync.native` on every platform. Canonical aliases share availability
verdicts, so cached positive verdicts retain their config evidence path and
must be discarded when that file disappears; canonicalize once per public
hot-path call, not once per runner lookup.
Widget file-record cardinality eviction is render-aware: only idle records with
no live diagnostic may be evicted. Formatter detection signatures include
formatter config metadata, and tsconfig-path signatures include recursive
`extends`/project-reference configs. (#1389)

`isFullyQualified` follows host path semantics. Use `isFullyQualifiedWin32` or `isFullyQualifiedPosix` when the consuming path grammar is fixed independently of the host (for example, safe-spawn's Windows resolver).

Every per-file session-fact key in `FactStore`'s bounded map
(`setBoundedSessionFact`/`getBoundedSessionFact`) writes and reads under one
normalization per member, applied to both members of the pair. Delta baselines
(`session.baseline.*`, `dispatcher.ts`) share one per-dispatch constant; the
cascade baseline (`integration.ts`) and the review-graph
`changedSymbols`/`entitySnapshot` keys (`clients/review-graph/service.ts` +
`builder.ts`) fold through `normalizeMapKey` at write and read. A raw-path key
in this family forks a second empty entity snapshot when one file arrives under
two case/separator spellings and inverts every symbol to `added` — the #2282 F1
whole-file-change false positive, re-entered through a re-spelled write (#2355).
`recordEntitySnapshotDiff` computes that folded path once per call and reuses it
for both fact keys; do not reintroduce a second realpath probe on this runner
hot path.

Small process-lifetime memo tables use `clients/bounded-cache.ts` when an
insertion-ordered LRU cap is sufficient; path-root caches still normalize keys
at the seam. Widget-state's file map remains a plain map because active
diagnostic records must not be evicted; it opportunistically removes only
records idle beyond the active window at one lifecycle size boundary (never
from every `getOrCreate` call on a full scan) and can therefore temporarily
exceed its cap when all records are active. #1389's bounded-by-nature tables (finite
package-manager/profile/package-root/session domains) require no cache layer.

Tier-2 cache bounds (#1389) use the Tier-1 idle-timer/LRU shape where entries are rebuildable: reverse-dependency and topology entries clear their timers through one deletion helper, tree-sitter query caches use insertion-order LRU with query disposal. ReadGuard is the exception: its reads are behavior-gating state, so unconsumed reads are retained until edit or session end, subject to a high sanity cap that evicts oldest→needs-re-read; reads are never silently allowed post-eviction. Only consumed reads may be evicted at the compact file cap. Widget-state and Tier-3 cache bounds remain deferred.

### Session lifecycle, telemetry, and observability

The machine-global instance registry serializes every whole-file writer with
an adjacent O_EXCL lock. Contenders use jittered backoff for 500ms, and locks
older than 5s or owned by dead pids are displaced and reclaimed; a crash can
still leave a stale lock during that window. Child-first synthesis receives
the session cwd and start time from the LSP client, preserves subagent
identity, and records `instance-registry-registration-missing` once when the
host registration is absent. (#2173)

Tool metadata is normalized at the final `pi.registerTool` boundary in
`clients/tool-definition.ts`. Keep this seam around the complete active/lazy/
activation-tool registration list: child sessions and wrapped/lazy factories
must never expose a tool with a missing, empty, or whitespace-only description.
Regression coverage exercises the real host registration seam across compact
rendering and dynamic-tool support both on and off; helper-only tests do not
prove that every registration group reaches the normalizer.

Post-fix decision observability is durable and bounded: advisory delivery logs
one `advisory_provenance_decision` per consume, classic TypeScript project
identity logs every success/failure outcome, deferred mutation drains summarize
coalescing and requeues, and authoritative-content branches log attachment
decisions, and a delivery seam that drops findings naming deleted files logs one
bounded `finding_dead_path_drop` per store. Bus stale/failure rows carry the
resolver's ctx source. Automatic
smell warnings count only the current session, or a 24-hour fallback window
when no session boundary is available; explicit health remains separately
labeled. (#1432)

The PR body checks normalize only clearly flattened bodies in memory: two or
more inline template headings, at most two physical newlines, and a minimum
body length. Detection refuses bodies with escape-loss markers, while the
post-split structural guard compares normalized heading count with distinct
template-section count and refuses inconsistent structures. Normalization only
splits inline headings whose preceding text ends at body start or
sentence-ending punctuation. `normalizePrBodyForChecking` returns the body and
the normalization verdict together, so callers never reclassify a stale event
payload after checking the live body. The workflow grants the advisory lint
read-only pull-request access and never edits contributor text. (#2145)

Message-end attribution uses a bounded two-slot session anchor. A primary
`session_start` rotates `lastStableSessionId` into `previousSessionId` because
queued stale events from the replaced session can drain after the boundary;
stale attribution reads the live slot, then the previous slot, then `unknown`.
The exported full reset clears both slots, while the session-start seam only
rotates them. (#1956 R3)

A new context-injection surface delivers append-only. It appends after the
transcript, or splices immediately before a plain trailing user prompt, and it
never rewrites `messages[0]`. It batches to one injection per settle or turn
boundary, never one per finding. It never holds the turn boundary open near the
provider cache TTL. It emits a `cache_context` record naming its own per-source
share of the payload, so a mixed injection stays attributable. The evidence
comes from a 2026-08-21 audit of 63 sessions and 2,288 turns. It measured a
94.2% prompt-cache hit rate and a byte-stable prefix. Even so, 34
zero-`cacheRead` turns carried 35.1% of all fresh input. Those turns had a
median inter-turn gap of 166s against 9s everywhere else, so idle time at the
boundary, not injection volume, is the dominant cost. `cache_usage` carries
`interTurnGapMs`, an evidence-backed `cacheMissCause`, and for every unknown a
bounded `cacheMissUnknownReason`; `cache_usage_summary` rolls both fixed-key
dimensions up once per role-specific session shutdown. Direct prefix and
model/provider-change evidence outrank timing. TTL and partial-eviction are
heuristics: require a request-side `context` observation, a complete bounded
sequence hash, collision-resistant full provider/model identity on both
adjacent usage records, and well-formed provider numeric evidence before
claiming either. Human-readable identities stay capped in logs; compare their
full normalized SHA-256 evidence, never the display prefix. Cycles, throwing
getters, and unreadable request structures mark evidence incomplete. Malformed
numeric fields are logged as `null` with a fixed bounded field-name list, never
as raw non-finite values. Measure the gap to REQUEST time, never to the response
that follows it: `message-end-fallback` includes generation and must stay
unknown. Missing stable session identity uses separate primary and secondary
buckets but still fails correlation closed. Never infer provider behavior from
stable local bytes, and never serialize transcript evidence.
(#1016, #1071, #1996)

Automatic test-runner failures use a separate non-context custom-entry surface.
Completion stages an owner-qualified session/generation record, and
`agent_settled` delivers only the newest provenance-validated result after an
immediate `ctx.isIdle()` recheck. The durable `test-runner-findings` cache stays
available to pull diagnostics and the commit guard; unavailable or failed host
entry capabilities never fall back to `sendMessage`. (#2366)

Pytest aggregate counts come only from pytest's final outcome summary line
(#2408), never from a whole-output search. Tracebacks, service errors, assertion
messages, and captured logs can contain unrelated phrases such as `port 55432
failed`; summary detection and count extraction must remain bound to the same
line.

Host-ready delay is a process-lifetime measurement from load-complete to the
first real `session_start`. The extension consumes that anchor once at the
entry point; later sessions emit no host-ready phase because no clean
per-session anchor exists. The session handler receives an explicit first-start
bit, so session-state resets must not re-arm or reuse this measurement.

Session-start lifecycle hooks must tolerate capability-shaped injected clients.
Optional reset methods may be absent from test doubles or embedders and must not
turn session initialization into a failure; concrete clients still reset state.

The widget projection after `lens_diagnostics mode=full` uses the final
post-policy, post-suppression summaries, not the confirmed-LSP reconciliation
loop. That final seam has correlated the LSP, project-scan, delta, and retained
widget lanes; committing only the earlier confirmed-LSP rows makes a broken
auxiliary lane hide independent `ast-grep-napi` findings from the widget count.
Preserve existing per-entry observation times and stamp only newly correlated
rows with the project scan time. Projected rows must also use the shared
`widgetDiagnosticUri` normalization seam so their OSC-8 line links match
`recordDiagnostics` output. (#1888)

Session degradation telemetry owns its dedupe and tally state in
`clients/degradation-ledger.ts`: use `recordDegradationOnce` for a repeated
site/subject that represents one user-visible degradation, and
`incrementDegradationCount` when every event contributes to the exact group
count but health should retain only one updated entry per subject. Both reset
with the ledger at the session boundary; do not add caller-local duplicate
sets or count one blocked action at both policy gates. Every accepted once
record and admitted tally milestones also emit a `degradation_ledger` row through
`latency.log`; the row carries the bounded kind, subject, and current count, so
the session remains auditable when no health render reaches the transcript.
Scanner coverage gaps and stalled notify-inflight barriers use the ledger;
successful notify drains remain latency-only because they are not degradations.
The `message_end` handler uses `cache-usage-attribution-stale` (subject
`message_end`) when a confirmed-stale ctx strips the stable id from a
`cache_usage` row — the row still writes, so the degraded ATTRIBUTION is the
degradation, never the row itself (#1956). Its durable ledger row carries the
active primary session id (or `unknown`), and the row write must precede the
best-effort ledger increment so a ledger failure cannot drop provider usage.
Workspace-root path-attribution rollups are separate, memory-only session
telemetry. They reset on the primary `session_start`, emit once on primary
shutdown, and secondary shutdown returns before consuming the primary tally.
Durable rows use the same 20-entry per-kind admission as the summary and emit
count increments only at powers of two, so the sink remains bounded. Each row
also carries the ledger generation for session grouping. (#1366, #1292, #1866)

Behavioral degradation is recorded through `clients/degradation-ledger.ts`, a
per-session in-memory store retaining the latest 20 entries per kind while
counting overflow. New quiet refusal/degradation paths must call
`recordDegradation`; `pilens_health` exposes the detached structured summary and
human-readable section, and `/lens-perf` includes the same current-session view.

Degradation-ledger recording is best-effort observability: its public record,
once-record, and increment entry points normalize unknown values to bounded
strings and swallow internal failures so telemetry never throws into a host
path.

The session-start smells rollup still uses bounded tail reads, but its session-start path must pass the current `sessionStartMs` into `countRecentSmells`; scoped scans admit only rows with a parseable `ts` at or after that boundary, dropping un-timestamped rows rather than surfacing ambiguous history. Unscoped calls remain available for non-session diagnostic/test consumers.

### Project intelligence: review graph, snapshots, word index

**Word-index postings intern their document identity (#2067).** The in-memory
posting entry keeps the index-owned shared file string, while `fileTable` maps
the canonical `wordIndexKey` to that string. Removal and async refresh compare
posting identities; they must never call `wordIndexKey(hit.file)`. Snapshot wire
format v2 remains `[fileIdx, line]`; load rebuilds the table and shared refs.
The cascade per-edit seam uses the cooperative replacement variant
(`updateWordIndexDocumentForEdit`), which is the async primitive plus the
arena-recompaction gate the synchronous one carried. Unawaited concurrent
cascades are ordered, not interleaved, because every async operation on one
index chains through that index's operation queue in call order. Bulk refresh
must not use the per-edit primitive: one refreshed document raises the store
count by its distinct-token count, so a per-document recompaction schedule
would fire between nearly every pair of documents.
When touching this seam, keep posting-entry counts and replacement-cost scalars
in word-index telemetry. #2069 intentionally builds on this prerequisite.
Incremental replacement churn recompacts the arena once churn passes 64 backing
stores. The per-edit gate is O(1): the index carries a `postingStoreCount`
over-estimate bumped on each private-store allocation and reset to the exact
count at every compaction, so the hot path never rebuilds a `Set` over the
vocabulary. The recompaction is serialized through the per-index async
operation queue (`enqueueAsyncWordIndexOperation`) behind a per-index
`createSingleFlight` registry (#1753, the repo's at-most-one-in-flight
primitive), and the cooperative copy is corruption-safe against a synchronous edit
that lands during one of its 8 ms yields: it sizes the arena from a snapshot and
publishes a list only when that list is still the map's current entry, still the
snapshot's size, and still fits. A list that grew or was replaced mid-copy stays
on its own store, so `adoptArena` can never write past the arena and drop tail
postings (#2117 review F2). Both the queued schedule and the refresh-path
recompaction go through the same latch, so an edit and a refresh cannot both
drive one. The `word-index-arena-recompact` ledger entry gates one detailed
`incremental_refresh` record per root with `reason: arena_recompact`,
before/after bytes, and store counts.
`estimateWordIndexStoreBytes` charges each distinct backing store once, so its
resident-byte value includes abandoned arena slack and remains a floor for
unrepresented object overhead. (#2117)
The reproducible synchronous replacement profile is
`npm run build && npm run bench:word-index-replacement`; it reports latency
percentiles and inspector samples attributed to `normalizeEphemeralMapKey`.
The relative smoke check's restored run reports 0.226% attribution (3,092
samples); the pre-interning comparison reports 32.303% (5,727 samples).

Word-index persistence keeps the v2 wire contract and caches its flat serialized
view per index. Every replacement or addition marks its document dirty; the next
persist keeps wire slots and untouched token lanes, resolving dirty files through
one slot map and flattening each affected token lane once. File removal falls
back to a full serialization because it changes slot identity; replacements
retain their previous wire order. `serializeWordIndex` clears dirty markers only
after it has produced the view, so deleting the dirty mark makes the stale-
persist test fail. A reload seeds the flat wire cache only when files, numeric
metadata, postings, and the optional forward lanes are canonical and mutually
consistent; sanitized or partial snapshots leave it unseeded so the first
persist publishes `serializeWordIndexFull` output. The reload check keeps the
valid wire path structural and uses the duplicate and per-file consistency
accumulators to reserve deep sanitization for suspicious snapshots. Snapshot
stringify and gzip remain in the existing project-snapshot worker; do not send a
structured-clone object graph to a new worker.

Memory-sample subsystem records report the axis that grows and at least one
byte-denominated estimate. `reviewGraph.residentBytes` uses bounded node/edge
counts plus the two edge-index reference charges; `dispatchCaches.estimatedBytes`
uses its bounded entry count. Keep these estimates O(cache entries) and treat
them as attribution floors, not V8 heap measurements. The corresponding
real-tree census belongs in the issue or PR record, not in the hot sampler.

MCP warm word indexes are bounded per root in `clients/mcp/analyze.ts`: callers
must acquire/release a lease around every use, because idle and LRU eviction
must never retire an index mid-query. Idle timers are generation-owned,
unref'd, and cleared on every removal/reset path; lifecycle eviction belongs in
the word-index NDJSON log, never the degradation ledger. Snapshot persistence
may retain serialized postings only until publication: afterward authoritative
and parse caches must not pin them, because that duplicates the mutable warm
index's expanded postings graph. The parse cache instead keeps a shallow
postings-stripped snapshot for metadata/report consumers; a cold analyze reloads
the full body once and immediately rewarms the leased per-root index. (#1370)

Review-graph workspace cache invalidation uses a process-wide epoch component
that survives all-workspace clears; per-workspace eviction/reset increments the
workspace component. Any new in-flight cache publication must capture and pass
the combined epoch. Authoritative project-snapshot deletion goes through the
single timer-clearing helper so idle timers cannot retain deleted generations.

The review-graph size gate uses the shared cooperative source walker with a
`maxFileCount + 1` sentinel: it stops at the first over-cap source entry, so
skip telemetry and user-facing messages must describe the count as “more than
N files,” not as an exact total. Counts within 5% above the cap also emit the
separate `review_graph_size_near_miss` phase for boundary-flap observability;
this is telemetry only and does not add hysteresis. (#1372)

Review-graph workspace caches and authoritative project snapshots are bounded to
8 roots and use 20-minute per-root idle eviction by default. Their windows are
env-tunable with `PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS` and
`PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS`; graph eviction also drops completed
build-dedup promises so the next access is a true cold rebuild. Async graph
writes carry a per-workspace epoch, preventing an in-flight build from
resurrecting an evicted entry. (#1389)

Incremental review-graph updates resolve deferred symbol edges after restoring
preserved incoming edges. The live indexes must remain synchronized, and
`dedupeResolvedEdges` removes only post-resolution duplicates from affected
target buckets. Do not add a second whole-graph dedupe pass to the hot path;
the next single-file rebuild must also remain duplicate-free. Multi-file removal
collects removed edges first, then filters each touched adjacency bucket once;
per-edge `indexOf`/`splice` in a high-fan-in bucket is quadratic. (#2127, #2074)

### Git guard

Git-guard command classification canonicalizes IFS parameter-expansion
separators in one quote-aware pass before tokenization, including nested
command strings. Any non-leading guarded `git` token is treated as indirect;
unknown wrappers and arbitrary run flags therefore fail closed, while literal
text consumers (`echo`, `printf`, `grep`) do not turn quoted prose into a
blocked operation. Keep the canonicalizer scoped to command classification so
quoted arguments remain intact.
Unsupported pull responses are also recognized by the standard message-only
variants (`method not found`, `unknown method`, and `unsupported method`).
Status consumers receive detached, 200-character-bounded failure entries.

The git guard classifies wrapper launchers only after basename/PATHEXT
normalization, and strips shell escapes only from command-verb tokens; path
arguments retain the shared lexer’s Windows-backslash behavior. Failed bash
results never register grep/read coverage.

Git-guard reconciliation must clear persisted `blockerContent` only when an
explicit `blockingFiles` record exactly matches the parsed blocker-content
paths and the current per-file dispatch reconciles the last blocker clean.
Malformed or incomplete provenance remains unknown/blocking; otherwise a clean
per-file result can remove `affectedFiles` while leaving stale content that
blocks every later commit lookup (#1084).

Git guard text-consumer allowances apply only to literal arguments: command,
backtick, and process substitutions are execution contexts and must recurse
through the canonicalizer before `echo`/`printf`/`grep` can allow text.

The git guard's command-position classifier expands `$IFS`, `${IFS}`, and
`$IFS$<positional>` forms before re-tokenizing guarded verbs. Known command-string
launchers include shell families plus busybox, toybox, and nix-shell; an
unrecognized leading launcher with `-c`/`--run`/`/c`/`-Command` is inspected
recursively and fails closed only when its command string contains an actual
guarded git verb (literal mentions such as `echo git push` remain allowed).

Real-Git tests route child processes through `tests/support/git-fixture-env.ts`.
That helper removes the Git directory environment family, isolates global config,
and disables system config. It deletes inherited values even when the test harness
itself starts with a contaminated environment; never trust the parent process
environment for a spawned Git fixture. `git-fixture-governance.test.ts` sweeps test
sources and requires the direct Git callee to be imported from that helper, while
the script-side fixture probes use `scripts/lib/git-fixture-env.mjs`. The global-
setup teardown guard rejects known fixture identity entries or `core.bare=true`
in the repository config after the suite. The governance sweep anchors its
implementation and justified-exemption lists to repo-relative paths, and its
identity sweep keeps every literal `user.name`/`user.email` write in the guard's
known sets.

Git command classification has ONE implementation. `detectGuardedGitVerb`
takes a `GitVerbMatcher` and owns the wrapper, `$IFS`, substitution, PATHEXT,
and text-consumer analysis; a guard that needs "is this really a git
invocation of verb V" supplies only the verb question. Do not add a second
lexer. The two matchers differ on exactly one axis, `indirectAlwaysMatches`:
the commit gate is a policy an agent may want to evade, so any non-leading
`git` fails closed there, while the shared-checkout guard protects an agent
from its own accident and arms the indirect path only when the argv also
carries a governed verb.

The shared-checkout guard (`clients/shared-checkout-guard.ts`,
`--lens-checkout-guard`) declines a worktree-mutating git command when three
facts all hold, checked cheapest first: the command really mutates the
working tree, `selectLivePeerInstances` reports another live session on this
root, and `git status` reports uncommitted work. Refusal is the whole design
— never auto-stash, because `git stash` is repo-global across worktrees and
would reproduce the defect it is rescuing from. An unanswerable `git status`
declines on its own UNKNOWN reason and records a counted degradation; it is
never read as clean. A registry that cannot be read allows, so an
observability outage cannot start refusing branch switches machine-wide.
`selectLivePeerInstances` (`clients/instance-registry.ts`) is the single
source of truth for "another session is here"; `selectWarmAttachIncumbent`
picks the oldest entry it returns, so the two cannot drift.

### Host integration and repo automation

The CI classifier's automatic PR comment path (`scripts/lib/ci-failure-classifier.mjs`, #2316/#2318) treats failed-job detail as untrusted log text: `buildCommentBody` escapes HTML comment delimiters and neutralizes mentions before interpolation. `parseClassifierMarker` accepts only the final anchored marker, so comment payload cannot forge rerun suppression while the legitimate trailing marker remains round-trippable.

The weekly stale-open-issue detector is detection-only: `.github/workflows/stale-open-issues.yml`
calls `scripts/detect-stale-open-issues.mjs`, which uses the bounded GitHub REST
fetcher seam in `scripts/lib/stale-open-issues.mjs` to inspect open issues and
bounded `master` commit details. It paginates each response until an empty page
proves exhaustion and fails loudly at the safety bound instead of interpreting a
partial response. It comments one candidate summary on #1323 and writes the
workflow summary; it must never close or edit detected issues.
The shared `paged` helper demands exhaustion by default; the intentionally
bounded commit-detail population opts out explicitly.

The merge-train warden's GraphQL PR reader follows the same bounded-read contract:
`fetchOpenPullRequests` preserves collected pages but records a fatal list error
when `hasNextPage` remains true at `MAX_PAGES` or the cursor does not advance.
It deduplicates PR numbers before `runWarden` decides or applies actions. Its
consumer prints that error and sets a nonzero exit code, while deliberately
bounded sibling reads remain scoped.

A repeated PR number is recorded, but it is NOT automatically fatal (#2192).
The query orders by `UPDATED_AT` descending, so a PR updated mid-pagination
shifts the window and lands on the next page too. That is a routine boundary
repeat, and the same rule that keeps benign HTTP races out of the fatal channel
applies to it. The reader classifies by CURSOR: a duplicate on a page whose
cursor advanced (or on the last page) is `benign: true`; a duplicate on a page
whose cursor did not advance is real truncation and stays fatal. The record is
one per page, naming the count and the first `DUPLICATE_REPORT_CAP` numbers,
not one per repeated node. `fetchOpenPullRequests` returns
`{ message, benign }` records, so both consumers read one classification rather
than each deciding for itself.

The warden also classifies what Actions did with each open PR head
(`scripts/lib/warden-run-health.mjs`, #2184). A run that concluded
`failure`/`startup_failure` with ZERO executed steps across every job is
`starved-run`, not a red build — verified against the real incident run
32986328966, where six jobs sat `queued` and one matrix job read
`completed`/`skipped`, so "every job is queued" is the wrong predicate. A head
with no `ci.yml`/`lint.yml` run past `ABSENT_RUN_GRACE_MINUTES` is `absent-run`.
Recovery is bounded: one `POST /actions/runs/{id}/rerun` per starved run, keyed
on GitHub's own `run_attempt` so the warden never re-runs the same run twice,
and one per-head comment for an absent dispatch, keyed on an HTML marker
carrying the head SHA. An unreadable runs or jobs list classifies
`run-health-unknown`, never `absent-run`. Every swept PR gets a classification
line in the run summary, including quiet ones.

The label-gated merge lane (`scripts/lib/merge-train-lane.mjs`, #2185) is the
only automation in this repository that merges, and it lives outside the warden
on purpose. It merges a PR carrying `train:approved` only on POSITIVE evidence
about the exact current head: both required checks present, `COMPLETED`, and
`SUCCESS`, run health `runs-concluded-normally`, zero failing non-advisory
checks, and a `CLEAN`/`UNSTABLE` merge state. Absent, unconcluded, starved, and
DIRTY-skipped checks are all not-green. Gating on the current head is what
re-gates a fix round, so the lane stores no "approved at SHA" state that could
drift; the merge call passes `sha` so a head that moves mid-cycle 409s instead
of merging on a stale verdict. Only the maintainer applies the label, so the
adversarial-review-first policy is unchanged; removing the label aborts.

After a successful merge, `runMergeLane` reads a strict 40-hex merge SHA and
sends a `merge-train-post-merge` `repository_dispatch` payload containing
`{repository, sha, pr_number}`. The lane uses this event because its
`GITHUB_TOKEN` merge suppresses the ordinary `push` event. Transient HTTP
failures and ambiguous timeouts receive one bounded retry with the same SHA;
the scheduled lane also reconciles recent bot-merged PRs from a dedicated
GraphQL connection ordered by `UPDATED_AT` descending. That reader follows
cursors only until the last `updatedAt` is strictly older than its merge window,
preserves equality at the cutoff, and fails closed on ordering, cursor, shape,
or page-cap violations. It reads `mergedAt`, `mergedBy`, and the exact merge
OID in the same record, rather than relying on the REST pull-list's incomplete
merge identity. It waits through a
bounded grace period, retries missing validation across process restarts, and
opens a later six-hour retry generation after two attempts exhaust one
generation, without a hot loop. It accepts completion only from bot-authored
exact-SHA terminal markers. A final
failure leaves the merge landed but records a fatal post-merge-validation
error. The master-push validation workflows (`ci.yml`, `lint.yml`,
`install-smoke.yml`, and `labels.yml`) gate all repository actions behind a
dispatch prerequisite that validates repository identity, strict SHA and PR
number shape, trusted workflow-revision checkout, authenticated commit
resolution, and ancestry to `master`; downstream jobs then check out the exact
payload SHA. They use per-workflow SHA concurrency with cancellation so duplicate
dispatches cannot validate one commit concurrently. A missing or invalid merge
SHA means no dispatch, and the lane must never report that verification ran.

Four facts about THIS repository the lane must keep matching, each probed live
rather than assumed (review round 1 on PR #2191, all four were wrong first):
master protection is `strict: true`, so a BEHIND head cannot be merged at all
and instead gets `update-branch` with `expected_head_sha`; a check is advisory
by its `(advisory)` NAME SUFFIX (`oxfmt format check (advisory)`,
`PR body (advisory)`, `Vale prose lint (advisory)`, `OSV scan (advisory)`), not
by a vendor allowlist; one head's rollup really does carry DUPLICATE check
names, so `resolveCheckRuns` picks the newest by `startedAt` and fails closed on
an unorderable disagreement, because `new Map(list.map(...))` is last-wins on
array order and called an in-flight re-run green; and `direction=desc` is
ignored by `issues/{n}/comments`, so every marker-dedupe read paginates to the
last page through `scripts/lib/github-paging.mjs`. Label provenance comes from
the last `labeled` timeline event and must name an approver, so "anyone who can
label" is not "anyone who can merge".

CI validates GitHub close-keyword syntax through `scripts/check-close-keywords.mjs`:
PR bodies may not use a comma-separated close list because GitHub applies only
the first issue per keyword; use one keyword per issue (`Closes #A. Closes #B.`).
The syntax check fetches the live PR body with `GITHUB_TOKEN`, so reruns do not
replay an edited event snapshot. The merged-PR workflow uses the same live-body
contract and fails closed when the fetch fails.
The merged-PR workflow rechecks each same-repository close target and comments on
the PR when a referenced issue is missing or remains open. Keep the parser pure
and unit-tested; workflow YAML supplies the token required by the live fetch.

## Key source layout

```
index.ts                  Extension entry point (async factory) — the pi host adapter
mcp/                      Second host adapter: MCP server + hook bin (see "MCP mirror")
  server.ts               Hand-rolled stdio JSON-RPC MCP server (16 tools) + warm IPC listener
  worker.ts               fresh-mode child (loads freshly-built code from disk)
  analyze-cli.ts          pi-lens-analyze bin — PostToolUse hook + CLI (warm channel → cold fallback), plus the Stop-hook turn-end mode (warm-only)
clients/
  lens-engine.ts          THE internal seam — host adapters import only this for pi-lens functionality
  mcp/                     host-neutral facades: analyze, session, review, ipc, host-shim
  runtime-session.ts      session_start handler — snapshot hydrate, tool preinstall, background scans, LSP warm
  project-snapshot.ts     Versioned seq-stamped project snapshot cache

One-shot cascades release workspace-topology cache eviction timers through
`releaseWorkspaceTopologyIdleTimers()` while retaining reusable entries; cache
access re-arms eviction. Keep cascade-discovered tier-2 cache timers on this
release path so print-mode operations do not leave a liveness tail.

The diagnostics widget records the exact `ctx.ui` identity only after a
successful `setWidget` mount. A visible widget re-asserts that mount on
`turn_start` when the host replaces its UI object; this remains gated by the
live run mode and `lensWidgetVisible`, so a user toggle-off or headless mode is
never undone. Missing `ui.setWidget` is a log-once-per-extension-session
diagnostic rather than a silent mount failure. (#1381)
  project-changes.ts      Append-only project/file sequence change log
  reverse-deps.ts         Snapshot-backed reverse dependency index/query helpers
  word-index.ts           Identifier inverted index + BM25 ranking (#162) — built in the session scan, persisted with per-file mtimes in the snapshot; consumed by BOTH the pi symbol_search tool and the MCP pilens_symbol_search mirror (#348 phase 1); session warmup preflights the bounded current file set and incrementally refreshes only sparse stale/new/deleted documents. A stale set whose ESTIMATED WORK exceeds one full rebuild (posting-scan + re-read cost vs totalTokens + corpus re-read cost), a dense stale set (≥32 documents AND >30% of the corpus), >30% file-set churn, or legacy metadata selects a separately-built full replacement BEFORE mutating the old index (#1197): repeated per-document posting-array filters become effectively quadratic (2,061 all-stale docs took 216.8s vs a 7.5s full build), and because per-document cost GROWS with the corpus no density ratio or absolute count is a bound — 800 docs / 239 stale at 29.875% measured 90.6s with a 39.6s loop block. Every bulk path (async build + both refresh loops) yields on an ~8ms monotonic budget OR'd with its item checkpoint — never count-only, which bounds nothing when per-item cost is unbounded — including within large documents and after any line ≥4,096 chars. Synchronous `buildWordIndex` is the small/test/reference primitive only. Superseded builds never publish a partial index and never escape as an exception into a caller's warmup pass.
  review-graph/query.ts   Graph queries incl computeImpactCascade (one-hop, used by the cascade) + computeTransitiveImpact (depth-bounded BFS, used by module_report's blastRadius section #304)
  review-graph/persist-worker.ts  Lazy shared worker for debounced review-graph JSON serialization + streamed gzip persistence; main thread generation-gates canonical promotion
  installer/index.ts      Auto-install + ensureTool; probe-cache.json for fast restarts. Strategies: npm/pip/gem/github + maven (fat JAR → java -jar launcher) + archive (tree). github API is token-authed (api.github.com only, Authorization dropped on cross-host redirect — unauth=60/hr silently fails CI installs); tar extract is recursive-find (handles FLAT tarballs like gleam, not --strip-components). GITHUB_TOOLS kept in sync with the registry by tool-registry-consistency.test.ts
  lsp/                    40+ LSP server IDs (incl. CMake via cmake-language-server and Fish via fish-lsp; opengrep + ast-grep + zizmor + typos are cross-cutting AUXILIARY diagnostic LSPs — role:"auxiliary", #111/#239/#272/#283), config, lifecycle. clojure-lsp + gleam now auto-install via github (native binary / flat tarball). zizmor (GitHub Actions security, `zizmor --lsp`) attaches to YAML; advisory unless the repo ships zizmor.yml; online audits need a token (env or `gh auth token`) via clients/zizmor-config.ts. typos (source-code spell checker, `typos-lsp`, native win-arm64 build) attaches to the code-aux set PLUS markdown (#283 option B); allow-list dictionary (only KNOWN misspellings) so low-FP; advisory (default WARNING) unless the repo ships typos.toml via clients/typos-config.ts
  dispatch/               Pipeline dispatcher + 46 registered runners (incl. spotbugs — flag-gated via withSpotbugsGroup, #133). Auxiliary LSPs (opengrep, ast-grep, zizmor, typos, …) are NOT runners — they attach via the lsp runner's with-auxiliary path; see clients/dispatch/auxiliary-lsp.ts
  runner-helpers.ts       Shared availability seam supports optional probe timeouts and synchronous managed-command fast paths; clients using it retain install suppression, session reset, typed missing outcomes, and whole probe+install in-flight dedupe per (cwd, toolId). Dispatch-owned checker and cwd probe flights are generation-guarded and reset with dispatch state; other owners keep separate registries. Managed release binaries resolve before PATH, and overrun subjects use cache keys rather than roots. Cached-positive bare commands revalidate through installer's `(name, PATH-hash)` session memo so dispatch pays one PATH walk per command/session; session reset clears all verdicts and typed spawn ENOENT feedback evicts the affected command immediately. Absolute paths still receive a single per-hit stat.
  widget-state.ts         Footer widget rendering (@earendil-works/pi-tui)
tools/                    ast-grep-search, lsp-navigation tool handlers
tests/                    Vitest test suite (mirrors clients/ structure)
```

Managed-installable standalone clients resolve availability through
`clients/dispatch/runners/utils/runner-helpers.ts`: use
`createAvailabilityChecker` + `resolveAvailableOrInstall` for a single command,
or `resolveManagedToolClient` when an ordered candidate chain must be preserved.
Thread `getManagedToolEnvironment(tool, cwd)` into probes/spawns. Direct
`ensureTool()` calls and bare managed-tool spawns outside the sanctioned wrapper
surfaces are guarded by `tests/clients/managed-tool-seam-coverage.test.ts`.

Managed language-server verification arguments are registry-owned and must
finish within the installer budget against the real binary. Choose a faster
argument such as `--help` only when a real-binary A/B reproduces a benefit;
otherwise retain the tool's established probe and leave the cold-path question
explicitly open.
`verifyToolBinary` retains at most 64 KiB of child output; output-cap episodes
use the `installer-verification-output-truncated` degradation kind and
`recordDegradationOnce` so noisy probes remain bounded and identifiable.

Installer package-manager and archive-extraction subprocesses must use
`safeSpawnAsync` with `lifetimeCoupled: true` and `ignoreAmbientSignal: true`.
This gives timeouts an awaited Windows tree-kill and prevents interrupted parent
processes from orphaning package-manager descendants; do not reintroduce raw
`spawn(..., { shell: true })` for install mutations. On POSIX (#2026), every
safe-spawn child runs detached in its own process group and timeout/abort kills
signal the GROUP (`process.kill(-pid)`), so grandchildren (npm→node, sh→sleep)
die with their tool instead of surviving as orphans; detached children no longer
receive terminal signals directly, which is why every POSIX pid registers for
lifetime cleanup — pi's signal/exit handlers forward the kill.
All mutations of the shared managed `tools/` tree are also serialized by its
atomic `.install.lock`; after waiting, re-run discovery before installing because
the preceding process may already have satisfied the request. A lock is stale
once its recorded PID is confirmed dead — OR, independently, once it is older
than the owner's install bound + slack (`PI_LENS_INSTALL_TIMEOUT_MS` +60s, #946 F1: PID liveness alone can't detect a hard-killed owner whose PID
Windows recycled for an unrelated live process, which would otherwise poison
every future install with a full-timeout wait). The age-based path is a
deliberate PID-recycle defense specific to installs, which have a known
bounded duration; it does NOT generalize to the test-suite lock below, whose
runs have no such bound.
Probe-cache persistence uses a separate directory lock and read-modify-write
merge. Stale-lock recovery first renames the lock aside, and release does the
same token check before deletion, so a late release can never recursively remove
a replacement owner's lock. Managed npm installs retain the Windows `.cmd`
shim path; tests use `PI_LENS_TEST_PLATFORM` to exercise that layout on Linux.
Clients that auto-install command-line tools must retain and spawn the absolute
path returned by `ensureTool`; a managed install is intentionally not assumed to
be on PATH. Madge is the exception in shape only: its `resolveMadge` discovery
already consults the managed tree after local/global node binaries and before
npx, while `ensureAvailable` owns installation.
Vitest sets `PI_LENS_DISABLE_TOOL_INSTALL=1` before global setup and workers;
ordinary tests must remain network/install-free. Real installer integration
tests must explicitly opt in and use an isolated `PI_LENS_HOME`.
Installer lifecycle integration tests use a fake package manager and isolated
home; `PI_LENS_INSTALL_TIMEOUT_MS` exists to keep timeout coverage fast and
must not become a production policy default.

**Full-suite runs are machine-wide-locked (#1101).** `npm test` /
`npm run test:unit` / `npm run test:integration` all route through
`scripts/with-test-lock.mjs`, which acquires `~/.pi-lens/test-suite.lock`
before running vitest and releases it after — automatically, no action
needed. This exists because concurrent full-suite runs on one dev machine
(several agents on parallel worktrees, plus an interactive run) each spawn a
fork pool sized for a dedicated machine and fight over CPU/RAM, producing
vitest worker-crash cascades and timing-budget flakes that look like real
bugs but aren't. The lock is machine-wide, not per-repo/per-worktree, on
purpose (worktrees of the SAME repo still contend for the SAME physical
CPU/RAM). A `waiting for test-suite lock held by PID <pid> since <iso>`
heartbeat line (at least every 15s) means your run is queued, not hung — it
resumes automatically once the holder finishes. Takeover rule differs from
`.install.lock` above ON PURPOSE: a lock whose recorded PID is confirmed
dead is taken over immediately (same as the installer); an UNREADABLE/corrupt
lock file (no readable PID at all) is taken over once it ages past a 5-minute
mtime bound (`scripts/lib/suite-lock.mjs`'s `staleMaxAgeMs`) — but unlike
`.install.lock`, a lock with a live, readable PID is NEVER aged out, because a
test-suite run has no bounded duration for a timeout to be sized against (an
install does). See that file's header for the PID-reuse tradeoff this
implies. Opt out with `PI_LENS_TEST_NO_LOCK=1` (CI sets this — runners are
isolated, one job per box, nothing to serialize against). Only `npm test` /
`test:unit` / `test:integration` acquire the lock; a targeted single-file run
via `npx vitest run <file>` directly stays unlocked (cheap, and serializing
it would hurt iteration) — `npm test -- <file>` still goes through the
wrapper and queues, since it's the same npm script.
Companion policy for agents running tests concurrently: run touched-file
tests freely (unlocked, cheap, iterate fast); at most ONE full-suite run per
agent at the end, with `PI_LENS_TEST_MAX_WORKERS=4` (not the default 50%) to
keep that one run's own footprint bounded; GitHub CI is the authoritative
full-suite green, not a local run under load; and under load, crash-cascade
failures (the classic pattern: edits.test occupancy dragging down
unrelated siblings) must be re-run in isolation before being treated as
real regressions.

Whole-project loops that reuse one `FactStore` must delete `file.content` after
that file's consumers finish (in a `finally` so abort/error exits release it).
Keep derived file facts and session facts: later cross-file consumers may still
need those, but no scan may retain every processed file's full source string.
The folded project-diagnostics scanner publishes graph-facing structural facts
through `clients/review-graph/shared-extraction-ir.ts` only after a file fully
completes. Entries are compact extracted values (never content or WASM trees),
content-hash checked by every graph consumer, and extraction failures are
incomplete/rejected; cold graph callers remain independent and parse normally.

## MCP mirror (second host adapter — `mcp/` + `clients/lens-engine.ts`)

pi-lens is also exposed as an **MCP server** so it can be used / live-tested /
debugged directly in Claude Code (or any MCP client) without running pi. This is
a *second host adapter* alongside `index.ts`. Design rationale + progress: `mcp.md`.

- **The seam discipline (the maintainability invariant).** Host adapters talk to
  **`clients/lens-engine.ts` only** — never reach into pi-lens internals from
  `mcp/server.ts`. A new mirrored capability = **one engine method + one tool
  route**; the engine is the single place coupled to internals, so a refactor
  breaks there (TypeScript-loud), not across the adapter. `clients/mcp/*` are the
  host-neutral facades the engine composes (they're misnamed "mcp" — they're not
  MCP-specific). The whole host coupling of the dispatch core is **one method**,
  `PiAgentAPI.getFlag` (`clients/mcp/host-shim.ts` → `createMcpHost`).
- **Transport is hand-rolled, zero-dep** (newline-delimited JSON-RPC). NO MCP SDK:
  `npm install --omit=dev` does **not** omit `optionalDependencies` (only
  `--omit=optional` does, which pi doesn't pass), so even an "optional" SDK would
  weigh every pi-lens install. ~200 LOC beats a dep for a tools-only server.
- **16 tools in a source checkout (15 in an installed package):** `pilens_analyze`
  (per-edit; `mode: warm|fresh`), `pilens_diagnostics`,
  `pilens_project_scan`, `pilens_latency`, `pilens_health`, `pilens_rebuild`
  (source checkouts only: `clients/mcp/review.ts`'s shared
  `canRebuildPiLens` requires `tsconfig.dist.json` and rejects `node_modules`;
  the server omits the tool when unsafe and `runRebuild` repeats the preflight
  before resolving a package manager or spawning, because published packages
  omit the tsconfig while `build:dist` destructively deletes `dist/` first),
  `pilens_session_start` / `pilens_turn_end` (drive the REAL lifecycle handlers —
  not re-implementations — via `clients/mcp/session.ts`), `pilens_ast_grep_search`
  / `pilens_ast_grep_replace`, `pilens_lsp_navigation` / `pilens_lsp_diagnostics`,
  `pilens_symbol_search` (ranked identifier search over the persisted word index —
  BM25 + priors + reverse-dep centrality; the funnel's entry point: symbol_search
  finds candidates, module_report explains one, read_symbol reads the body. #348
  phase 1 gave the word index a load→rebuild-if-stale→persist lifecycle in ALL
  startup modes — quick-mode's cold-start warmup pass now also refreshes it, not
  just the full-mode session task — and a cold query (no index yet) triggers one
  bounded background build per cwd instead of blocking. Its `available: false`
  result distinguishes `building`, a safety `refused` outcome, and
  `last-build-failed`; the per-cwd guard remembers the last outcome and
  `clients/word-index-logger.ts` persists cold-build/debounced-persist failures
  through `createNdjsonLogger` instead of swallowing them. Serialized indexes
  also carry `indexedFileCount`/`truncated` (missing fields on legacy snapshots
  mean not truncated); both symbol-search surfaces return `coverage` and warn
  when the file cap makes results partial. Hits carry
  `startLine`/`endLine` (best-matching line;
  `offset=startLine, limit=endLine-startLine+1`) instead of a raw `lines[]` array or
  a per-hit `read` block — #517 conformity, same as module_report below), `pilens_module_report` (navigable outline + signatures
  the outline is module-level declarations + class members only — function-locals
  are dropped (#259). Class/interface members nest under their container by
  line-range containment (`members[]`, #301); the `api`/`internal` split is over
  TOP-LEVEL entries only, and a `private`/`protected` member is tagged with a
  `visibility` field inside its container's members, not promoted to the public
  `api` (#258). Each entry also carries `decorators[]` — the declaration's
  decorators/attributes/annotations in source order (`@app.get("/x")`,
  `#[tokio::main]`, `@Override`), so an agent reads a symbol's ROLE (route/test/
  fixture/entrypoint) without reading its body. Extracted structurally from the
  declaration node in `tree-sitter-symbol-extractor.ts` (preceding-sibling /
  own-child / `modifiers`-nested shapes), so it spans Python/Rust/TS/Java/Kotlin/
  C# and covers nested method members; languages without those node kinds yield
  none. `imports` populate language-uniformly even on a cold cache —
  resolved to in-project files via the warm graph's resolver, else bucketed
  internal/external by shape (#301). `callbacks[]` surfaces high-signal inline
  executable nodes — callbacks/closures/lambdas/function literals (event
  handlers, timers, promise callbacks, object/dict function deps, assigned
  closures, especially lifecycle-sensitive `ctx` captures) — with stable
  synthetic handles and `read` args; `pilens_read_symbol` accepts those handles
  too. The inline-executable *node kinds* are language-uniform over the tree-sitter
  WASMs, but the *callback semantics* (role/kind, risk flags, include-or-drop) are
  per-language: `CALLBACK_RULES` in `clients/module-report.ts` is keyed by language
  (like `SYMBOL_QUERIES`), with JS/TS-tuned rules as the default plus `go`
  (goroutine/defer), `python` (scheduler/future lambdas), `rust` (spawn/`move`
  closures), `swift` (strong-vs-`weak self` capture), `cpp` (`[&]` by-reference
  capture + thread launches), `kotlin` (coroutine builders), `java`
  (`new Thread`/executor submit/listeners), and `csharp` (`Task.Run` + event
  `+=`) slices; other languages fall back to the generic JS/TS-shaped heuristics.
  Tests for the HEAVY grammars (swift/cpp/kotlin/csharp) live in dedicated small
  test files — co-loading several heavy tree-sitter grammars in one vitest worker
  exhausts V8 zone memory (the #255 wall, a hard `Fatal process out of memory:
  Zone`), so each heavy group is isolated (java rides the main file, its grammar
  already loaded). The report's `callbackSupport: "tuned" | "generic"` says which path
  ran so callers don't over-trust the list for untuned languages. Add a language
  by adding a `CALLBACK_RULES` entry + a guarded fixture test (the SYMBOL_QUERIES
  per-grammar precedent — extraction breaks silently against real grammars).
  Symbol entries carry a first-line `doc` summary (whitespace-collapsed,
  ~120 chars) extracted from an attached doc comment via structural
  preceding-sibling `comment`-node traversal — the same tree-sitter pass, no
  second parse (#512); JS/TS is the primary target, Python/other languages
  sharing that node shape get it for free. No per-symbol `read` block (#512) —
  `offset`/`limit` are pure derivations of `startLine`/`endLine` on the
  report's own `path`; cross-file entries (`blastRadius.files[].read`,
  `usedBy[].file`) keep their own path. `exported` is a boolean only — not
  also repeated in `flags`, which carries non-derivable signals only.
  `view:"summary"` is the payload-reducing orientation mode: top-level API/
  internal entries + `recommendedReads`, with heavy callbacks/usedBy/
  blast-radius payloads omitted; `view:"compact"` (#512) renders the full
  report as line-oriented TEXT (one line per symbol/callback) instead of
  JSON — same data, roughly a quarter of the token cost, opt-in (default
  stays JSON). Reports also carry section-level `provenance`
  (`syntax`, `cached-review-graph`, `heuristic-tree-sitter`, `none`, plus
  `unavailable:file-cap` for graph-backed sections when the capped source walk
  disabled the graph) so agents can tell facts from cache/heuristic sections
  without per-flag JSON bloat. A capped `module_report` also uses
  `semantic.source: "unavailable:file-cap"` and warns with the cap plus both
  configuration knobs; `project_report` says “more than N files (cap N)” because
  the walk stops at cap+1 and never knows the exact project count (#921). Pass
  `blastRadius: true` for the cross-file **blast radius** (#304):
  transitive dependents aggregated to ranked file `read` args — read-only over
  the *cached* graph (omitted when cold), the single successor to the removed
  `pilens_impact` tool) /
  `pilens_read_symbol` (one symbol/callback handle's verbatim body; its MCP
  response no longer restates name/kind/startLine/endLine in a trailing JSON
  block after the header line already carries them — #512). #523
  (self-healing misses, both surfaces): the returned range (and the
  read-guard coverage recorded for it) extends to an attached doc comment,
  not just the declaration line, reusing #517's `extractDocCommentInfo`
  attachment computation; a dotted `Class.method` name resolves a specific
  member (line-range containment within the named parent, falling back to a
  plain lookup when the qualifier doesn't resolve); a miss embeds the ~3
  nearest symbol/callback names by Levenshtein similarity (threshold 0.45)
  instead of just pointing back at `module_report` — a dedicated small
  edit-distance function, NOT the read-guard's `findSimilarLines` (that's
  Jaccard over tokenized line content, wrong shape for a single identifier
  typo); an optional `kind` param disambiguates same-file name collisions
  (overloads, a type+value pair), surfaced via `ambiguous: { count, kinds }`
  when omitted rather than silently returning the first match unlabeled.
  `read_enclosing`
  is the pi agent search/diagnostic → exact-body bridge: given a file+line it
  returns the smallest enclosing symbol/callback body and records read-guard
  coverage; if `maxLines` would reject an oversized range, `onOversize:"slice"`
  returns bounded partial read coverage around the target line while
  `onOversize:"outline"` returns nested symbol/callback read handles without
  claiming coverage. `pilens_read_enclosing` (#536, closes #522 item 1) mirrors
  this shape on MCP — same params, no read-guard tie-in (MCP has no read-guard
  at all, same caveat as `pilens_read_symbol`).
  Wrapped pi tools emit their
  typebox `parameters` as the MCP `inputSchema` (via `schemaWithCwd`) — no
  hand-restated schema to drift.
  `pilens_module_report` / `pilens_read_symbol` / `pilens_read_enclosing` are
  **dual-surface** — also registered as pi agent tools (`tools/module-report.ts`,
  wired in `index.ts`, backed by `clients/module-report.ts` via the lens-engine
  seam) — and unlike the MCP-only queries below, `read_symbol` and
  `read_enclosing` already feed a pi-lens-internal consumer: in pi their returned
  bodies are recorded into the read-guard (`recordSymbolRead`) as genuine
  edit-coverage for that symbol/callback range (a `module_report` outline is NOT
  — shape, not body). The MCP mirrors have no read-guard to tie into at all, so
  `pilens_read_symbol`/`pilens_read_enclosing` return the body with no coverage
  recording — an intentional MCP-side gap, not a bug.
  `pilens_symbol_search` is ALSO dual-surface as of #348 phase 1 — `symbol_search`
  (`tools/symbol-search.ts`, wired in `index.ts`) wraps the same `symbolSearch()`
  engine seam and returns the identical #517-slimmed payload; unlike read_symbol/
  read_enclosing it does not feed the read-guard (a ranked file list is discovery,
  not a body read).
- **MCP-only vs pi-lens-internal (a real gap to close, not a finished story).**
  Likewise `module_report`'s blast-radius (#304) uses
  *transitive* BFS (`computeTransitiveImpact`) while
  the in-pi **cascade still derives neighbors one-hop** (`computeImpactCascade` in
  `dispatch/integration.ts`). The higher-value move is to feed the transitive impact
  (bounded depth/budget) into cascade neighbor derivation — ideally paired with the
  #202 structural-hash short-circuit so the expansion is *pruned* when a changed
  file's exported interface is unchanged. When adding a capability via the engine,
  ask whether pi-lens itself should use it, not just the mirror.
- **warm vs fresh review loop.** The server is long-lived (warm LSP, cached code);
  `fresh` forks a worker that loads freshly-built code from disk → reflects the
  latest commit. `pilens_rebuild` closes it: commit → rebuild → `mode=fresh`.
  **`fresh` always cold-spawns the LSP, so it under-reports LSP on large projects
  within any per-call budget** — surfaced honestly via the `lsp` signal, never a
  silent "clean" 0. warm + an indexed server is the LSP-complete path.
- **LSP reset teardown is concurrent but fully awaited (#851).**
 `LSPService.shutdown()` starts every retiring client shutdown before awaiting
 `Promise.allSettled`, so the process-kill grace tail is bounded by the slowest
 client while per-client failures remain best-effort. The #850/#852 generation
 handoff still waits for that service teardown before replacement spawn.
  Its existing `lsp_service_reset` latency phase is emitted after teardown and
  reports the real end-to-end reset duration (plus reason/alive-client metadata),
  not a zero-duration initiation marker (#948).
  Client shutdown's fire-and-forget instance-registry removal is serialized at
  its read-modify-write seam so concurrent removals cannot lose siblings;
 process-tree kills remain concurrent.
- **Session-start timing is end-to-end attributable (#948, #1374).** `index.ts`
  imports `clients/console-guard-install.ts` first; that module captures the
  evaluation marker as its first statement before installing the guard. The
  extension then logs `host_boot`, `extension_eval`, and
  the continuity `extension_loaded` record. Primary session starts pass the host
  hook/bootstrap timestamps into `handleSessionStart`, which records the
  monotonic `host_ready_delay` beside `session_start_total` and marks delays
  over 30s with `hostStallSuspected`; it also records pre-handler,
  runtime-reset, sequence/snapshot (with bytes/freshness/seq), total, and
  delayed warmup child phases in `latency.log`; concurrent secondaries emit only
  `concurrent_session_bind`. Keep logging fire-and-forget and preserve contiguous
  top-level timing so quick-start child durations remain within ~10 ms of total.
  `session_start_total.metadata.classification` carries the accepted start's
  `primary` or `sequential-replacement` decision, and `sameRoot` carries
  `true`, `false`, or the explicit bounded value `"unknown"`; never omit the
  field when root identity was unavailable because NDJSON serialization drops
  `undefined`. The quick and full writers share this durable shape, and strict
  readers must accept only those three root values. (#2129)
  #1019: `session_start_log_cleanup` is now emitted from a deferred `setImmediate`
  (its `metadata.deferred:true`), NOT synchronously in the awaited chain, so it is
  no longer a top-level critical-path phase — do not re-add it to the contiguous
  top-level sum. **`session_start_sequence_read` is bounded** by a snapshot-embedded
  sequence index (`SnapshotSequenceIndex`, mirrored in the meta sidecar): the quick
  and full paths pass `snapshotSequenceBase(root)` to `readLatestProjectSequence`,
  which folds only change-log entries with `seq > snapshot.seq` on top of the
  hydrated base (O(changes-since-snapshot)) instead of replaying the whole log,
  with a full-replay fallback for legacy/version-mismatch/ahead-of-log bases. The
  embedded index is written by `buildProjectSnapshotFromRuntime` from the runtime's
  live `{projectSeq, getFileSeqEntries()}` (always consistent with `snapshot.seq`);
  side-writes (word-index/reverse-deps) carry it forward via their `existing` spread.
- **Incremental review-graph snapshots are immutable by replacement (#939).**
  `updateGraphFiles` performs all node/edge edits on a clone, rebuilds derived
  indexes once at the end, then stores that finished graph directly in
  `_workspaceGraphCache`; do not mutate a cached/returned graph outside the
  builder. Graph edges are immutable values (updates replace/filter entries),
  which makes an array-only edge clone safe. Debounced persistence retains the
  finished graph/maps and materializes serialization arrays only at flush time,
  so callers must likewise replace rather than mutate those snapshots.
- **Auxiliary LSP publication readiness is a read-only dispatch seam, per file
  (#868/#2324).** `clients/lsp/index.ts` exposes
  `hasAuxiliaryLspPublishedForRoot(serverId, filePath)` for Gate-B fallback
  decisions. It resolves the matching root and requires that live client's
  FIRST diagnostic publication FOR THAT FILE — `getDiagnosticsVersionForPath`,
  never the client-global `diagnosticsVersion`. The global counter advances on
  any path's publication, so it answered "did the server publish?" for a
  sibling file too, satisfying the gate for a file the server never touched
  and leaving fallback findings undelivered (the #2324 headline warm-silence
  case). Process liveness or a resolvable binary is not proof that the server
  can supersede a fallback runner either. It inspects only the existing
  client map and must never spawn or warm a client. Dispatch-side
  code imports this seam from `lsp/index.ts`, while `dispatch/auxiliary-lsp.ts`
  remains free of the reverse import to avoid the LSP/auxiliary cycle.
- **Document-symbol enrichment is warm-and-open only (#158).**
  `clients/lsp-document-symbols.ts` requests `textDocument/documentSymbol`
  through `getWarmClientForFile` only when the exact document is already open
  and the capability is advertised; it never spawns or opens. Read expansion
  gives that request 150 ms and uses it only for name/kind/ancestry â€” the
  tree-sitter range remains authoritative, with silent fallback on every miss.
  The review-graph builder also uses this seam as a strict zero-tree-sitter-
  symbol fallback (#307), never from `module_report`: LSP nodes persist with
  `provenance:"lsp"`, and hierarchical children become symbol containment
  edges. Every attempted fallback is recorded in `review-graph.log`.
- **LSP circuit-breaker health includes absent clients (#927).**
  `LSPService.getBrokenStatus()` is a read-only projection of temporary
  cooldowns and session-permanent disablement; `pilens_health` renders those
  server/root pairs even though `getStatus()` correctly contains live clients
  only. Keep health/status calls spawn-free.
- **Warm-build staleness guard (#535).** The warm server lives for weeks, so it
  can silently keep serving OLD code after a `npm run build:dist`/merge changes
  `dist/mcp/server.js` on disk — dogfooding caught this live (a post-#517
  rebuild still answered with the pre-#517 `module_report` schema). Fix: at
  startup, `mcp/build-staleness.ts`'s `computeBuildStamp` stat's the server's
  OWN entry file (`SERVER_FILE`, resolved via `import.meta.url` — never a
  hardcoded repo path, since the server may run from an installed package) and
  stores its mtime. Every `tools/call` and the IPC side-channel handler
  re-check via `StalenessGate.isStale()` — one `fs.stat`, cached at most once
  per second so a burst of calls costs a single stat (same shape as the #492
  cross-process reader). On mismatch: `pilens_analyze` (stateless per-file,
  no warm-only dependency) force-routes to the EXISTING `mode=fresh` worker
  fork and tags the result `servedBy: "fresh (warm code stale — restart the
  Claude session to re-warm)"`. Every other tool depends on warm-process-only
  state it can't get from a fresh fork (the in-memory review graph —
  `module_report`/`symbol_search`; the warm LSP fleet —
  `lsp_navigation`/`lsp_diagnostics`; the CacheManager/latency log — the rest),
  so those get an honest-degrade `warmCodeStale: true` warning appended
  instead of routing (`WARN_ONLY_STALE_TOOLS`/`withStaleWarning` in
  `mcp/server.ts`) — a stale-but-populated graph beats a fresh fork's EMPTY
  one. The IPC side-channel (PostToolUse hook's warm-first path) replies with
  an error on stale instead of running analysis — the hook bin
  (`mcp/analyze-cli.ts`) already treats any IPC error as "fall back to cold,
  load-fresh-from-disk" analysis, so no separate fresh-fork plumbing was
  needed there. Kill switch: `PI_LENS_WARM_STALENESS_CHECK=0`.
- **Push half = the `pi-lens-analyze` bin** wired as a Claude Code `PostToolUse`
  (Edit|Write) hook. MCP is pull; the hook is the only way to auto-fire on edit.
  It tries the **warm IPC side-channel first** (`clients/mcp/ipc.ts`: Unix socket /
  Windows named pipe, hashed per workspace) → analysis runs in the warm server
  (LSP-complete) and the bin never loads the dispatch graph; falls back to cold
  no-LSP local analysis. `pilens_analyze` (warm) + the hook auto-register edited
  files into turn-state (`addModifiedRange`) so `pilens_turn_end` needs no file list.
  The channel is strictly **one-shot** — clients write exactly one request and
  read one reply, so the server handler consumes the line and dispatches at most
  once per connection (a non-consuming handler re-dispatched on stray bytes,
  #1219); keep any new channel handler one-shot too.
- **Per-turn half = the same bin on a `Stop` hook** (`--turn-end`, or a `Stop`
  payload on stdin; #538). Tagged `{route:"turn-end"}` request on the WORKSPACE
  IPC endpoint (a Stop hook knows its cwd, never the server pid), which also
  inherits the #535 staleness gate. It passes NO files. Each Stop pass has an
  execution/delivery boundary: findings are only consumed after the client has
  received the reply and sends a delivery capability acknowledgement over a
  second one-shot IPC connection. A timeout or close leaves the finding cache
  durable and a later authorized Stop re-delivers it. All workspace IPC requests
  share one server-side queue, so a still-running analyze always finishes before
  the following Stop pass and concurrent turn-ends cannot race. The queue admits
  at most one waiting item; excess callers fail explicitly with `turn_end queue is
  busy` rather than growing an unbounded head-of-line tail. **Warm-only, no cold
  fallback** — only the server process owns the session state and pending turn
  work, so a local pass reports a false clean; unavailable ⇒ one stderr line,
  silent stdout, exit 0. `SubagentStop` is deliberately NOT registered (subagent
  edits already reach turn-state via PostToolUse; the consume bridges are
  one-shot). Stop-hook stdout is user-visible in transcript mode, not model
  context — blockers still gate commits via the retained lens-guard record.

  Turn-state ownership is explicit: pi writers use `{kind:"pi", id: telemetry
  session}` and MCP writers use `{kind:"mcp", id: process-scoped server owner}`.
  `sessionId:null` is a non-claiming update and never clears an existing owner;
  a live foreign owner is retained, while an owner whose process is dead or
  whose bounded heartbeat is stale may be replaced. A different pi owner ID in
  the current process is treated by pi turn_end as an intentional same-process
  session handoff and is evicted, preserving the legacy pi session-mismatch
  contract; generic cache writes still retain live foreign owners, and
  cross-process liveness is PID/heartbeat guarded. Repeated writes from
  the same owner extend its worklist. This covers pi/MCP handoff without letting
  one MCP session consume another's files.
- **Same-workspace warm attach (#822, opt-in soak).** `PI_LENS_WARM_ATTACH=1`
  selects a PID-confirmed, heartbeat-fresh same-root incumbent from
  `instances.json`. The LSP runner sends versioned, content-hash-bound,
  deadline-bounded diagnostic touches to its PID-scoped endpoint
  (`clients/warm-attach.ts` + `clients/mcp/ipc.ts`) and skips local pre-warm.
  `lens_diagnostics mode=full` and `lsp_diagnostics` sweeps use the same seam
  per file and suppress local group warm-up, pre-open, and workspace pull while
  attached; a mid-sweep promotion resumes locally from the failed file onward.
  Any timeout, IPC/schema/freshness failure, or incumbent loss permanently
  promotes that session to the unchanged local path (no flapping). Attached
  dispatch runs request their bounded blocking-diagnostic code actions from the
  incumbent only after it served the same file/content hash. This enrichment
  is deliberately softer than diagnostics: timeout/schema/error skips
  quickfixes and logs `code-actions-skipped` without promoting the session;
  success logs `code-actions-served` under `lsp_warm_attach`.
  Attached
  sessions never own the incumbent's registered children; the #661 reaper
  remains PID-death + child-identity guarded.
- **Auto session on connect:** `PI_LENS_MCP_AUTO_SESSION=1` runs `session_start`
  when the server boots (a Claude `SessionStart` hook can't warm the server's
  in-process LSP — separate process). Register: `claude mcp add --scope user
  pi-lens -e PI_LENS_MCP_AUTO_SESSION=1 -- node <repo>/dist/mcp/server.js`.
  State is tracked (`{ attempted, succeeded, firedAt, error }`, `mcp/server.ts`)
  and surfaced via `pilens_health`'s `autoSession` field (`null` when the env
  var isn't set — distinguishes "off" from "attempted and failed"). Self-heals
  (#544): the first `tools/call` on a connection re-triggers
  `maybeAutoSessionStart()` if it never fired, is still in flight, or
  previously failed, so a stale/reconnected server doesn't stay cold for the
  whole connection.
- **The bin target is `dist/`.** After changing MCP/engine/runner code, run
  `npm run build:dist` so the user-scoped server (`dist/mcp/server.js`) picks it up
  on the next Claude session. (`bin`: `pi-lens-mcp`, `pi-lens-analyze`.)
- **Review-graph persist caps are partial, never absent or silently complete
  (#936).** `GRAPH_PERSIST_MAX_ELEMENTS` counts nodes + edges (default 500,000).
  Above it, `builder.ts` keeps whole-file node groups ranked through the shared
  reverse-dependency-centrality seam, then induced edges up to the cap. The gzip
  snapshot carries exact total/persisted node+edge/file counts; read-only consumers
  may load it and must surface `persistCoverage.partial`, while the incremental
  build tier rejects it as a complete base. A source walk stopped by the visited-entry
  budget also persists `sourceFilesTruncated:true` with a lower-bound file count —
  never clear that marker or describe the graph as complete. Capture the file cap
  before the asynchronous walk and derive terminal success/skip from the returned
  graph, not a shared concurrent-build verdict. Keep this on the existing worker,
  generation-staged promotion, and sync-flush path. Persisted-file counts are
  intersections with the source-file universe, not every resolved import stub;
  lifecycle graph/cascade consumers use graph-local metadata, and project-report
  attempt state is ordered by build ID, so overlapping builds cannot borrow
  another build's mode or reason. Cascade treats any partial coverage as
  indeterminate rather than a clean zero-neighbor result.
- **Review-graph snapshot persistence is worker-offloaded (#939).** The
  canonical cache is `review-graph.json.gz` (legacy uncompressed
  `review-graph.json` is load-only fallback for one release). Debounced writes
  use one lazy unref'd worker that stringifies and streams gzip into an atomic
  generation-specific stage; only the main thread promotes a completion whose
  generation is still current. `flushReviewGraphPersist` remains synchronous
  for the CLI/exit hook and invalidates any in-flight generation before its
  own gzip write, so a late worker can never overwrite the forced snapshot.
- **Project-snapshot dedupe earns identity off-thread (#1997).** Never hash or
  recursively walk the snapshot on the caller thread. Keep one active persist
  and only the latest queued candidate per normalized root. Equal project
  sequences share one gate generation, so a duplicate does not invalidate the
  active publication; a changed sequence does. Refresh the queued candidate's
  tiny durable baseline only when it dispatches. The worker hashes
  its existing serialized JSON with only top-level `generatedAt` excluded, and
  skips gzip and staging when it matches the current durable or last local
  success. Same-sequence semantic changes still publish. Only successful
  publication updates the bounded fingerprint cache; failures remain retryable,
  and missing bodies always force repair. Preserve the current same-sequence
  sidecar until the worker decides, so a stale local replay cannot erase a
  newer sibling-process fingerprint.
- **Out-of-band graph builds** use `npx pi-lens build-graph [--cwd <dir>]`.
  The CLI reuses `buildOrUpdateGraph` plus the builder's queued atomic persist
  payload, force-flushes it before exit, and treats every build/persist skip or
  failure as non-zero; keep it aligned with session graph config and persistence.
- **Dogfooding found two dormant pi features** (fixed/flagged, not the MCP's fault):
  the cold-LSP-returns-0 honesty bug (`runners/lsp.ts` — `touched === undefined`
  now → `skipped`, not a false `succeeded`), and **`runtime.errorDebtBaseline` is
  never set in production** (the green→red/error-debt machinery is dead plumbing).
  Before mirroring a pi capability, check it's actually live.
- Tests: `tests/clients/mcp/*` (units) + `tests/mcp/*` (spawn smokes — real server
  - bin end-to-end). Live behaviors (warm IPC, real session/turn) are unit-covered;
  the spawn smokes don't exercise them. Spawn helpers must use temp workspaces,
  `PILENS_DATA_DIR`, and `PI_LENS_HOME`; never bind the real workspace socket or
  write the developer's project/global state.

## Package scope

LSP server definitions resolve in `clients/lsp/config.ts` as project
`.pi-lens/lsp.json` (including its legacy project filenames) over machine-global
`getGlobalPiLensDir()/lsp.json` over built-in defaults. `servers` and
`serverOverrides` merge by ID; project `disabledServers` and `warmFiles` replace
the global arrays when present.

All pi packages are `@earendil-works/*` (migrated from `@mariozechner/*` in 0.74.0). Peer dep: `@earendil-works/pi-coding-agent`. Runtime dep: `@earendil-works/pi-tui`. The v4-safe dependency baseline resolves both host packages at `0.84.2`; the peer remains broad at runtime and the devDependency pins the SDK for type/compatibility checks. Re-audit host declarations before taking a future major/minor bump.

## Git & PR workflow

- **Docs-only changes may be pushed straight to `master`, no PR** (maintainer standing rule). Applies to pure documentation edits — `*.md` (README, AGENTS.md, CONTRIBUTING, CHANGELOG prose), doc comments, and similar non-code text. **Exception: `.changelog/*.md` entries always go through a PR**, because the bump-time rollup and PR guard rely on reviewed entry files. Anything that touches code, tests, CI/workflows, or `package.json` still goes through a PR. When unsure whether a change is "docs-only," open a PR.
- **Always open PRs with base `master`** (`gh pr create --base master`). **Never stack a PR on another feature branch.** If issue B builds on still-unmerged issue A, you may branch B off A's branch *locally* to develop, but the PR's base must still be `master` (wait for A to merge + rebase B, or accept the noisier diff) — never `--base feat/<A>`.
- **Update the branch onto master before merging.** A PR left `BEHIND` blocks automerge and, worse, makes green CI stale: required checks ran against a merge candidate that no longer exists, so composition with just-merged changes is unverified (the same trap as skipped-CI-on-conflict, one step earlier). When master moves during a PR's life — and in this repo it moves daily — `git fetch origin master && git rebase origin/master`, re-run the touched suites on the rebased head, and push with `--force-with-lease`. Verify `mergeStateStatus` leaves `BEHIND` before merging or enabling automerge.
  - Why: PRs squash-merge. A PR based on a feature branch gets merged *into that branch*, not master; if the base was already squashed to master, those commits land on a dead branch and never reach master. This happened (#321/#302 → reland #322).
  - Verify a merge actually hit master before moving on: `git show origin/master:<file> | grep <new-symbol>` — not just the PR's "merged" badge.
- **When told (or when you observe) that a PR merged, fast-forward local `master` immediately — don't ask first.** `git fetch origin master && git merge --ff-only origin/master` (check `git status --short` beforehand as usual; leave any unrelated stray modified files untouched). This is pre-authorized standing behavior, not a per-instance confirmation.
- Lint gate is `tsc` (`npm run lint`); the repo has **no biome config or CI biome gate**, so biome's default formatting is *not* enforced — don't repo-wide reformat. Run the full suite (`npm test`) before pushing; `npm run build` first if stale JS may shadow source edits.
- **Format gate is `oxfmt` (`npm run fmt:check`) and it must run before EVERY commit and push.** The deferred-format lane drains at `agent_end`, so a violation pushed MID-TURN escapes ahead of the formatter and reds the CI advisory (seen repeatedly 2026-08-23/24: three pushes raced the drain). Files written by scripts (bash/python heredocs) are especially exposed — write tools on Windows emit CRLF that oxfmt rejects as mixed EOL. If you skip hooks on a push (`PI_LENS_SKIP_HOOKS=1`), run `fmt:check` manually anyway.

## Issue triage (standing rule)

- **Always triage new/untriaged issues** when a session touches the repo: `gh issue list --state open`, then for anything unlabeled or stale add `bug`/`enhancement`/`feature` + matching `area:*` labels (use the existing label set — `gh label list` — don't invent new ones), post a short status comment when related work has since merged (cross-link the PRs/issues), and close only with evidence (a merged PR, a log confirming the fix).
- **External-contributor issues get priority** — they must not sit unlabeled (a first-time reporter's issue once sat 10 days untouched; see #673).
- **Label issues you file yourself at creation time**, not in a later sweep.
- **Every issue carries exactly one `priority:*` label, assigned at triage (#1676).** Priority means dispatch order, honestly: `priority:p1` — the next free worker lane takes it, and a p1 bug blocks the next release (wrong verdicts, silent data loss, crash/hang, host impact). `priority:p2` — the normal queue, batched into themed dispatch waves (hot-path perf with measured numbers, observability gaps with field evidence, contained bugs with workarounds). `priority:p3` — opportunistic: it rides along in a PR already touching the seam, or is `help wanted` material (polish, docs, cold-path costs). Rubric: severity times exposure times evidence — a field-log record upgrades one level; an existing workaround downgrades one. External contributors coordinate on `priority:p2`/`priority:p3` plus `help wanted`; p1 items are usually fleet work.

## Commands

```
npm test              # vitest run (all tests)
npx tsc --project tsconfig.json --noEmit   # type-check
npm run lint          # same as type-check
npm run build         # emit JS from TS; run before tests after source changes if stale JS may be present
node scripts/smoke-tools.mjs [--install] [--step2] [--verbose] [lang ...]   # live tool-smoke (#209, opt-in/nightly): installs + runs each tool through the REAL dispatch path against tests/fixtures/tool-smoke/<lang>/; --step2 also asserts a parseable diagnostic. Add --lsp for the LSP-handshake layer, --format for the formatter pipeline, or --autofix for the pipeline safe-autofix phase. Not a per-PR gate, not shipped in the tarball.
#   --lsp fixtures support two optional per-fixture fields (#530): `setup` (string/argv command run in the COPIED temp workspace before touchFile — e.g. `typescript7`/`typescript7-clean` run `npm install typescript@7 --no-save --no-audit --no-fund` there, since typescript-go's per-platform native binary can't be a committed static fixture; setup failure reports a distinct `setup-failed` status, never a false pass, bounded by a 120s timeout) and `expectLaunchVariant` (asserts the live `getCapabilitySnapshots(file)` `launchVariant` — e.g. `"native-ts7"` — so a silent fallback to the classic `typescript-language-server` FAILS even though a diagnostic arrived; the native and classic servers share the same `"typescript"` server id, so the diagnostic alone can't distinguish them). Both fixtures verified live 2026-07: typescript@7.0.2 installs from npm, its `tsc --lsp --stdio` genuinely speaks LSP framing (`\r\n\r\n` Content-Length headers over stdio, confirmed via a hand-rolled initialize), and PR #526's assumed invocation is correct.
#   --format drives getFormattersForFile→formatFile via FormatService (what runFormatPhase uses; the lint path NEVER runs formatters): asserts the expected formatter is selected (config-gated ones ship the config their detect() needs — .prettierrc/gleam.toml/Gemfile/pyproject[tool.black]/stylua.toml/.cljfmt.edn/.php-cs-fixer.php/.editorconfig) and that it actually reformats a mis-formatted fixture (changed===true). Covers 30/33 formatters (tests/fixtures/format-smoke/<lang>/); only nixfmt/ocamlformat/swiftformat remain (no Windows toolchain). Plain-command formatters (stylua/cljfmt/php-cs-fixer/google-java-format/clang-format) need their binary ON PATH or formatFile reports success=false; managed-dir ones (taplo/shfmt/ktlint) don't. EXIT-CODE POSTURE (#1337): formatFile is STRICT BY DEFAULT — a nonzero exit is a formatting failure, never a silent "already formatted". Only lint-autofix formatters (rubocop/standardrb/ktlint/sqlfluff) opt out via `lenientExitCode`, whose string VALUE is the required benign-nonzero evidence. Before adding a formatter, check whether its in-place mode can exit nonzero benignly (usually it cannot — that behavior lives behind `--check`/`--dry-run`/`--set-exit-if-changed`); biome is the exception that needs `--no-errors-on-unmatched`, since it exits 1 on paths its own config ignores. Guarded by tests/clients/dispatch/formatter-exit-code-posture.test.ts.
#   --autofix drives runAutofix (the pipeline phase that applies fixable linters in --fix mode — distinct from lint-only dispatch AND from formatters; it MUTATES files): asserts the policy-selected tool applied a fix (fixedCount>0). Live-validates 11 (ruff/biome/rubocop/sqlfluff/rust-clippy/dart-analyze/stylelint/eslint/golangci-lint/markdownlint/oxlint in tests/fixtures/autofix-smoke/<lang>/); ktlint blocked by #218; detekt wired but CI-deferred (needs detekt CLI+formatting plugin). Workspaces are git-init'd so VCS-gated fixers (cargo fix) run. Autofix gating MIRRORS each tool's lint-policy strategy (config-first: eslint/oxlint/golangci-lint/detekt; smart-default: the rest) — guarded by tests/clients/autofix-policy-consistency.test.ts (autofix policy ↔ AUTOFIX_CAPABILITIES ↔ lint policy gates).
#   Lint covers ts/py/yaml/js/markdown/shell/css/html/toml/sql/dockerfile/terraform + toolchain-gated go/rust/csharp/powershell/zig/java/dart/php/ruby/kotlin/gleam/elixir (toolchain must be installed locally; CI nightly sets them up).
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=apmantza_pi-lens&branch=master&status=TO_REVIEW&ps=100"   # list open SonarCloud security hotspots (public API, no auth). Triage: real fix vs mark-Safe (this project has had S5852 ReDoS false-positives on trusted bounded tool output).
npm run logs:smells   # scripts/analyze-pi-lens-logs.mjs — scans ~/.pi-lens/*.log for operational smells (diagnostic-blockers, slow-hook-path ≥5s, slow-runners ≥2.5s, cascade-slow-graphs ≥1s, lsp-availability-noise, read-guard-friction). Flags: --since 3d (default 2d), --limit, --json. READ CRITICALLY: much volume is user-project diagnostics (not pi-lens bugs) + self-noise from temp:pi-lens-smoke-* (my own --install cold-tool runs). Real pi-lens smells: cascade-slow-graphs + slow-hook-path (cold LSP + cascade hot-path).
#   MCP spawn smokes keep a 20s local per-request default; set
#   PI_LENS_TEST_TIMEOUT_SCALE to a positive finite multiplier (CI uses 3) when
#   loaded runners need a larger deadline. analyze-graph.smoke.test.ts warms
#   the server with a throwaway pilens_health call before its assertions.
```

Because many test imports use `.js` specifiers while the source of truth is `.ts`, recompile after TS changes before running tests when local `.js` artifacts may exist/stale:

```
npm run build && npm test
```

**This is now enforced (#198):** a vitest `globalSetup` (`tests/support/check-build-freshness.ts`) fails fast — for *any* launch (`npm test`, `npx vitest run`, watch start) — if a compiled-source `.ts` under `clients/`/`tools/` (or root `index.ts`/`i18n.ts`) is newer than its in-place `.js` (or has none). If you see `⛔ Stale build …`, run `npm run build` and re-run. (CI's `test` job builds first, so it passes.)
Do not hand-edit generated `.js`; regenerate it from the corresponding `.ts`. This includes `scripts/download-grammars.js`, generated from `scripts/download-grammars.ts` and must stay in sync for published installs.

**Tree-sitter grammar distribution (uniform across package managers).** The 12 **core** grammars (`CORE` in `download-grammars.ts`: ts/tsx/js/python/go/rust/json/yaml/bash/html/css/java) are downloaded at `prepare` time into `grammars/` (gitignored, in `files[]`) and **ship in the tarball** — so common languages parse offline on npm/pnpm/yarn/bun. The **long tail** is **lazy-fetched at runtime on first parse of that language** (`ensureGrammar` → unpkg CDN), on every manager (there is intentionally **no `postinstall`** — it was npm-only and pnpm/bun blocked it). Runtime resolution (`tree-sitter-client.ts` `resolveGrammarFile`) checks the bundled `grammars/` dir first (via `resolvePackagePath`, package-root-relative), then the legacy `web-tree-sitter/grammars` write dir; a failed lazy fetch emits a visible degradation warning (offline). To resize the bundle, edit `CORE` — bigger = larger tarball (wasm gzips ~8× in the `.tgz`, so the download delta is small; on-disk is not).

**BLOCKED grammars — refuse to load a runtime-crasher (#423/#432).** A prebuilt grammar wasm can **fatally crash the host runtime** rather than fail gracefully: `tree-sitter-swift.wasm` @ tree-sitter-wasms 0.1.13 triggers a fatal V8 Turboshaft-WASM crash on **Node 24, every OS** (`Fatal process out of memory: Zone`) the first time it's loaded + parsed. The crash is a process **abort** — uncatchable in-process — and **rebuilding the grammar from source does NOT dodge it** (the from-source wasm crashes on Node 24.18 identically; an earlier `VENDORED` from-source-commit approach, #426, was tried and reverted because it added machinery without fixing the crash). Since the only place graceful degradation can live is **before load**, the fix is a runtime **load-skip**: `BLOCKED_GRAMMARS` + `grammarBlockReason(filename, rt)` (`grammar-source.ts`) — `tree-sitter-client.ts` `loadLanguage` returns `null` (→ "grammar unavailable", no structural symbols) instead of loading the crasher. Swift's predicate is `isV8 && nodeMajor >= 24`, so **bun (JavaScriptCore) and Node ≤ 22 keep full Swift** via the normal CDN download (swift is a normal downloaded grammar again — no committed bytes, no vendoring). Membership is **guard-driven, not hand-maintained**: `scripts/check-grammar-load.mjs` (`npm run check:grammar-load`) loads + heat-parses each grammar in an **isolated child process** (a crash kills the worker, can't be a caught test failure), **skips** blocked grammars, and is a **hard gate** for any *new* crasher; the `.github/workflows/grammar-health.yml` nightly runs it across ubuntu/macOS/windows, plus a `swift-crash-watch` job that **force-loads** the blocked grammar (`PILENS_UNSAFE_FORCE_GRAMMAR_LOAD=1`, `continue-on-error`) to signal when a future Node/V8 makes it safe to **lift** the block. To block another grammar: add one row to `BLOCKED_GRAMMARS` with a runtime predicate — that's it.

**Source overrides — pull a grammar from a better package than the aggregator (#255).** The frozen `tree-sitter-wasms@0.1.13` aggregator ships some **broken** grammars: its `tree-sitter-lua.wasm` parses to `ERROR` trees once a **second** grammar loads into web-tree-sitter's process-global WASM `Module` (lua-specific — bash/ruby/python/go/js are fine), silently emptying lua symbols/imports/`module_report` in every multi-language repo. This is a **different class from a BLOCKED crasher**: it's a bad grammar *build*, not a runtime crash, and it's fixable by swapping the source. `GRAMMAR_SOURCE_OVERRIDES` (`grammar-source.ts`, mirrored as `SOURCE_OVERRIDES` in `download-grammars.ts`/`.js`) maps a wasm filename → `{package, version, url}`; both the runtime lazy-fetch (`grammarSourceUrl`) and the build-time downloader pull the override URL instead of the aggregator, and provenance (`grammars.lock.json` `overrides` section + `expectedVersion`/`expectedPackage`) records the real package/version so `needsDownload` + the provenance guard don't false-trip. Two grammars are overridden: **lua → `@tree-sitter-grammars/tree-sitter-lua@0.4.1`** (#255, queries rewritten for its `function_declaration`/`function_call`/`dot_index_expression` node types) and **yaml → `@tree-sitter-grammars/tree-sitter-yaml@0.7.1`** (#427 — the aggregator's yaml is ABI-incompatible with web-tree-sitter 0.25 and fails `Language.load` outright; no queries, it just needs to load). The maintained `@tree-sitter-grammars/*` org ships prebuilt wasms for **lua, yaml, toml** (not swift — no such package, and `tree-sitter-swift` ships C source only, which crashes when built). Swap another grammar: add one `GRAMMAR_SOURCE_OVERRIDES` row + its lock hash + `overrides` entry, and (if it has SYMBOL/IMPORT queries) revalidate them against the new node types (AST-dump-then-validate).

The instance-registry lock records timeout degradation through a function-scoped lazy ledger load so dependency-cycle checks remain acyclic; its synchronous path uses a memoized `createRequire` load. `pruneDeadInstances` returns `"pruned"`, `"no-match"`, or `"could-not-acquire"`, so lock-expired cleanup cannot be reported as clean.

## Data directory conventions

**All project-scoped persistent data must go through `getProjectDataDir(cwd)`** (`clients/file-utils.ts`).

**Shared durable-store atomicity (#1202).** Atomic tmp+rename is crash/torn-read
safety, not cross-process serialization. The full store classification lives in
`docs/durable-store-audit-1202.md`. Behavior-gating read/modify/write state must
lock, re-read under the lock, and merge only its delta; diagnostic dispositions
are the reference synchronous implementation. Replaceable derived caches may
remain explicitly best-effort only when freshness validation or the next scan
self-heals the loss.

```typescript
import { getProjectDataDir } from "./file-utils.js";
const cacheFile = path.join(getProjectDataDir(cwd), "cache", "my-file.json");
```

`getProjectDataDir` respects `PILENS_DATA_DIR`:

- If `PILENS_DATA_DIR` is set → `$PILENS_DATA_DIR/<project-slug>/`
- Otherwise, if `<cwd>/.pi-lens/` already exists → use it (legacy)
- Default → `~/.pi-lens/projects/<project-slug>/`

**Project-scoped** (must use `getProjectDataDir`): caches, snapshots, indexes, worklogs, change-log, code-quality-warnings, actionable-warning-state, review-graph, install-choices.

**Machine-global** (all routed through `getGlobalPiLensDir()`, `clients/file-utils.ts` — never hand-rolled `os.homedir()` + `.pi-lens`): latency.log, cascade.log, review-graph.log, tree-sitter.log, sessionstart.log, read-guard.log, actionable-warnings.log, dead-code.log, diagnostic-logger's `logs/`, tools/, bin/, intelephense/, probe-cache.json, and the #449 instance registry (`instances.json`). These are shared across all projects. `getGlobalPiLensDir()` respects `PI_LENS_HOME` (#525) — the machine-scoped sibling of `PILENS_DATA_DIR` above; setting it relocates the entire `~/.pi-lens` root for every one of those writers in one shot, since they all route through this single function.

Never write `path.join(cwd, ".pi-lens", ...)` for a project cache — it breaks when `PILENS_DATA_DIR` is set. Likewise never write `path.join(os.homedir(), ".pi-lens", ...)` directly for machine-global state — always call `getGlobalPiLensDir()`, or `PI_LENS_HOME` silently stops covering that writer.

**Test hermeticity for machine-global state (#525, refs #515).** `tests/support/vitest-setup.ts` sets `PI_LENS_HOME` to a per-worker `mkdtemp` directory for every test run — unlike `PI_LENS_CONFIG_PATH` (#515, pointed at a nonexistent path since config-loading is read-only-by-default), this MUST be a real, writable directory because the instance registry and loggers actively `mkdir`+write into it. Dogfooding caught the gap live: a test-fixture instance (`registerInstance` called from a test with no override) survived in the developer's REAL `~/.pi-lens/instances.json` for ~17h. A test that deliberately exercises the real (non-overridden) resolver — e.g. asserting the literal `~/.pi-lens` default, or a `node:os` mock forcing a fake homedir — must construct its OWN explicit override (`delete process.env.PI_LENS_HOME` / restore afterward) rather than relying on unsetting the global vitest-setup value; see `tests/clients/file-utils.test.ts`'s `getGlobalPiLensDir` suite and `tests/clients/installer/tool-discovery.test.ts` (which clears `PI_LENS_HOME` via `vi.hoisted`, before its module-level `const GITHUB_BIN_DIR = path.join(getGlobalPiLensDir(), ...)` import ever runs) for the pattern. `tests/clients/pi-lens-home-hermeticity.test.ts` is the regression guard proving `registerInstance` never touches the real homedir when the override is set.

## Debug logs

**All debug loggers write through one buffered async writer** — `clients/ndjson-logger.ts` `createNdjsonLogger` (#454/#935): `log()` is sync-call/async-write (serialized drain, no `appendFileSync` on the per-edit hot path); contiguous queued lines coalesce into one O_APPEND write up to a truncate boundary, while peek-then-remove plus identity-checked completion preserves exit-flush safety. Rotation + truncate are in-band queue ops; normal drains use promise-based mkdir/append/truncate, but rotation's stat/remove/rename remains one synchronous section inside the already-deferred drain (and exit flush), so `flushSync` cannot race a late async rename. A late in-flight write crossing a truncate gets a post-truncate replay, and a single shared `process.on("exit")` handler sync-flushes every logger. The Symbol.for process-global state also owns one canonical queue/flusher per normalized absolute path, so module re-evaluation/hot reload cannot create competing writers or retain one flush closure per facade; the state is explicitly versioned. The 7e4b9120 shared-writer shape is upgraded in place, replacing each stale exit flusher with the current `flushStateSync` closure while preserving queues; a pre-7e4b9120 graph with private queues is fenced and fails closed because those queues are not migratable. A second facade for that path must use the same `maxBytes`/`backupPath` options; incompatible options fail at construction rather than silently inheriting first-writer settings. Static paths are canonicalized once at logger creation, and lazy paths cache canonicalization by resolved raw path; log-cleanup directory comparisons use the shared `pathsEqual` seam. `sessionstart.log`'s ordinary writers all route through the single module-level instance in `clients/sessionstart-logger.ts`; the sole exception is `clients/lsp/launch.ts`'s intentionally synchronous crash-adjacent final diagnostic. Latency/cascade/tree-sitter/bus-event loggers rotate in process at `getMaxLogSizeMB()` (PI_LENS_MAX_LOG_SIZE_MB, default 10 MB) — the SAME source cleanup and `/lens-perf`'s tail bound read, so raising the env var moves all three together. Exit-flush contract: flushSync drains the whole queue INCLUDING an in-flight async batch — duplicate lines at exit are accepted over dropped lines (#935 review); rotation is complete before an async append is allowed to become in-flight, and the in-flight append/truncate replay preserves post-truncate ordering. One deliberate durability trade: `dbg()` lines are buffered, so a hard kill (SIGKILL/native crash) can lose the tail that the old per-call appendFileSync would have kept; launch.ts's sync exception covers the spawn-crash case. **A test (or any in-process reader) that reads a log file right after logging MUST `await` that module's exported `flush<X>Log()` first** — the line may still be in the write queue. New logger = one `createNdjsonLogger` call in a thin module keeping its own schema/API; don't hand-roll append/rotate again.

**Secret redaction is part of the write boundary (#327).** `log()` redacts the serialized line, including string values and property names; `append()` redacts raw lines before enqueue; and the synchronous LSP launch writer calls the same pure helper. Keep token detection deterministic and linear because hostile logger text is untrusted. The external PSES process owns its nested `pses.log`, so this JavaScript boundary cannot filter it.

- `~/.pi-lens/sessionstart.log` — timestamped lines for every session_start event and tool lifecycle; includes project snapshot probe/miss/load summaries, seeded project/file sequence counts, scan-context/profile cache source, and deferred task queued/run timings
- `~/.pi-lens/cascade.log` — NDJSON cascade graph/neighbor diagnostics, including reverse-dependency cache refresh/load/merge events (`phase: "reverse_deps_cache"`)
- `~/.pi-lens/review-graph.log` — NDJSON review-graph build and persistence outcomes; lifecycle entries carry bounded build/persist generations, per-build captured sequence/mode, counts/timestamps, explicit partial-persistence coverage, process identity, and coalescing/supersession/fallback status without source contents. `latency.log` keeps only the separate persistence timing phase; do not duplicate this lifecycle metadata there.
- `~/.pi-lens/latency.log` — NDJSON per-runner timings. Every new entry includes a logger-owned writer `pid`; `/lens-perf` (#767, `clients/performance-report.ts`) uses `pid` plus `RuntimeCoordinator.sessionStartedAt` to isolate the current process session from the machine-global log, and separately shows independent top-five p50/p99 rankings for the machine-wide active window's positive-duration `type:"phase"` records (`toolName/phase` when a tool name exists, linear-interpolated percentiles). `handleSessionStart` logs `session_start_total` on quick and full paths plus `session_start_scan_context_compute` around the actual sync/background scan-context walk, so the startup regression that motivated #767 is visible. The command flushes this process's buffered writer first, streams at most the newest `PI_LENS_MAX_LOG_SIZE_MB` (default 10MB, the same threshold that rotates the log), chunk-yields every 500 parsed lines, keeps at most the newest 20,000 phase samples, discards a partial first line after a tail seek, reports both caps, and skips malformed NDJSON lines rather than turning one partial append into an empty report. Ast-grep unsupported-language telemetry is deduped by language for the session and reports only a bounded rule-ID sample; `npm run logs:smells` excludes temp/scratchpad/heap-corpus paths by default and reports excluded-row counts, with repeatable `--exclude <glob>` overrides.
- `~/.pi-lens/latency.log` `cache_context` records are the privacy-preserving request-side context audit: the `pi-lens-context-handler` observed stage, injection sources/placement, bounded counts/sizes, and hashes only. Content/structural hash truncation is explicit and yields `unknown`, never an exact unchanged claim. `cache_prefix_break` remains a local first-message stability signal, not proof of a provider cache miss; `cache_usage` is provider-reported, has no request-id correlation, and its `RuntimeCoordinator` turn is process-global (concurrent secondary sessions omit it). Since #1071, `cache_context` also carries `injectionSourceBreakdown` (per-source message count, chars, bytes, and an estimated token count), and `cache_usage` carries `interTurnGapMs` plus a `cacheMissCause` verdict of `ttl-expired`, `prefix-broke`, `partial-eviction`, `model-provider-changed`, or `unknown`. #1996 adds `cacheMissUnknownReason` so every unreadable, first-sample, uncorrelated, truncated, identity-poor, stable-prefix provider miss, or otherwise unexplained observation names the evidence gap; a fixed-key `cache_usage_summary` emits once per role-specific session shutdown. The token figures use a documented four-chars-per-token estimate, flagged as `injectedTokenBasis`, and are never provider-measured. A `cacheMissCause` of `null` means no comparable shortfall exists; `unknown` means a shortfall exists but local evidence cannot prove its cause. The TTL threshold defaults to 60s and is overridable via `PI_LENS_PROVIDER_CACHE_TTL_MS`. Only a REQUEST-time `context` stamp can establish TTL or partial eviction; `message-end-fallback` includes generation and therefore stays unknown. Missing stable session ids use separate primary/secondary state buckets but still report unavailable correlation. A provider with no prompt cache at all reads `unknown` forever: every comparable turn is a zero read against a zero baseline. Distinguish that case by `cacheWrite`, which also stays zero when the provider never caches, unlike a genuine expiry where the turn rewrites the cache.
- `cache_usage` heuristic causes have a four-part evidence gate: request-time correlation, a complete non-truncated bounded sequence observation, full provider/model identity on both adjacent usage records, and well-formed provider usage numbers. Missing any part yields its specific unknown reason before TTL or partial-eviction is considered; direct observed prefix or identity changes still outrank the gate. (#1996 review)
- Concurrent-session role is owned by each `activateExtension` closure after its `session_start` decision. Later context, message-end, agent-end, and shutdown handlers consume that immutable-per-start role even when `getSessionId()` becomes unavailable; the process-global classifier is only a pre-start fallback. Never replace this with shared mutable “last session” state: a missing-id secondary must remain secondary and must never enter primary teardown. Cache summaries emit before role-local cache cleanup. (#1996 review)
- `~/.pi-lens/tree-sitter.log` — NDJSON tree-sitter runner activity plus aggregate `cache_stats` entries for project-diagnostics and full review-graph phases; scope-isolated measurements include lookup/miss reasons, capacity misses, evictions, parser invocations/time, and resident source bytes/lines
- `~/.pi-lens/extension.log` — NDJSON extension-wide diagnostics, including project-trust refusal/transition telemetry and the #1338 console-guard net for migrated or transitively emitted console writes
- `~/.pi-lens/read-guard.log` — NDJSON for every read-guard verdict, autopatch, and preflight block (rotates at 1 MiB); key events: `edit_blocked`, `edit_warned`, `edit_preflight_blocked`, `oldtext_not_found`, `oldtext_trailing_ws_autopatched`, `oldtext_indent_autopatched`, `oldtext_escape_autopatched`
- `~/.pi-lens/actionable-warnings.log` — NDJSON for the actionable-warnings advisory pipeline (rotates at 1 MiB); events: `report_started`, `lsp_file_checked`, `lsp_file_skipped`, `report_complete`, `advisory_injected`, `advisory_skipped`
- `~/.pi-lens/probe-cache.json` — tool binary path cache (TTL 24h)
- `.pi-lens/cache/` — knip, jscpd, madge, gitleaks/govulncheck/trivy/opengrep, dead-code-`<lang>` (#127), todo-baseline, turn-end-findings, actionable-warnings, code-quality-warnings, and project-snapshot caches

**Knip memo freshness (#1873).** `clients/knip-client.ts` keys successful in-memory reuse by canonical project root and `projectSeq`, then validates a bounded metadata signal for `package.json` and the resolved Knip config on every hit. The signal records mtime and size, so external changes to those files invalidate without a tree walk; two `statSync` calls replace a 10–23 second scan. Source-only external edits remain advisory stale until pi observes a write or the session resets.
- `~/.pi-lens/dead-code.log` — NDJSON, one event per cross-file dead-code scan (#127): language, per-bucket counts, durationMs
- `.pi-lens/cache/project-snapshot.json` / `.pi-lens/cache/project-snapshot.meta.json` — versioned seq-stamped project snapshot; preserves cached exports, project rules, startup scan/profile metadata, and reverse dependency data
- `<project-data-dir>/change-log.jsonl` — append-only observed mutation log with project/file sequence numbers
- `<project-data-dir>/code-quality-warnings.jsonl` — append-only code-quality advisory history

## Lifecycle and pipeline flow

Four hooks in `index.ts` drive everything:

**`session_start`** → `handleSessionStart` (`clients/runtime-session.ts`)
Resets `RuntimeCoordinator` and fast-resets any old LSP service with `resetLSPService({ fast: true })`. A replacement service may still be allocated immediately, but #850's generation handoff blocks its first spawn until every older generation's teardown settles. Seeds project/file sequence state from `project-changes.ts`, probes `.pi-lens/cache/project-snapshot.json`, and hydrates cached exports/project rules/startup scan/profile metadata when the snapshot seq matches the current project seq. Fires tool preinstall (typescript-language-server, biome, etc.) and background scans (knip, jscpd, madge circular deps, ast-grep exports, project index) as deferred fire-and-forget tasks via `setImmediate`; task logs split queued vs run time. The same deferred pass runs the **config-gated security session-scan clients** — `gitleaks` (committed secrets, #130), `govulncheck` (Go CVEs reachable from code, #132), and `trivy` (dependency CVEs across npm/PyPI/Maven/Gradle/Go/Cargo/Composer/RubyGems/NuGet, #131) — each of which gates on a project signal (gitleaks config / `go.mod` / — for trivy — an **explicit `trivy.enabled: true` in `.pi-lens.json`** *plus* a dependency manifest, since its first run pulls a heavy vuln DB), caches its result keyed by project, and auto-installs its own binary from GitHub releases on demand. Because they run in the background `setImmediate` task, a slow first scan (e.g. Trivy's one-time ~30-200 MB vuln-DB download) never blocks an edit. LSP config walk is also deferred via `setImmediate`. Returns in ~150ms on warm runs; background tasks finish asynchronously. Knip/jscpd startup scans are async and guarded against duplicate in-flight scans. The **cross-file dead-code harness** (#127) runs in the same deferred pass: each registered `DeadCodeClient` (`clients/dead-code-client.ts`) self-gates via a cheap `detect()` marker probe and, when its language is present, runs a project-wide unused-symbol scan (Phase 1: Python via `vulture`), cached per-language and surfaced as a turn-end advisory — the non-JS/TS analogue of Knip. vulture is **presence-gated, never auto-installed** (probed as `vulture` or `python -m vulture`) — it's a pure-Python package, so auto-install would mutate the user's Python env (uv/poetry/conda/pipx); like `govulncheck`, it's skipped silently when absent. **opengrep** (`clients/opengrep-client.ts`, #584) runs in the same deferred pass as a full-project CLI scan (`opengrep scan --config <local rule file|auto> --json`), structurally always-on (mirrors the LSP auxiliary's own enablement — `resolveOpengrepConfig` only picks which rules) — this is in addition to opengrep's separate always-on LSP auxiliary role for real-time per-edit feedback; the CLI scan exists solely so a full-workspace `lens_diagnostics mode=full` sweep gets opengrep's findings from one cached project-wide scan instead of one LSP touch per file (`runWorkspaceDiagnostics` excludes opengrep from its per-file sweep — `clients/lsp/index.ts`'s `WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`).

**`tool_call`** (write/edit events) → `handleToolCall` (`clients/runtime-tool-call.ts`, extracted from `index.ts` in #678/#681 — the last of the four hooks to make this move, matching `runtime-session`/`runtime-tool-result`/`runtime-turn`)
Warms the LSP for the file and records read-guard lines. For write/edit tools, runs the read-guard autopatch pipeline (Passes 0–2) before the edit lands, then records preflight data for the later `tool_result` dispatch. `index.ts`'s own `pi.on("tool_call", ...)` is now a thin DI call site.

**Read-recording bridge** (`clients/read-bridge.ts`, #1265) — a process-global extension point for co-process extensions.
Bridge records are content-bound at record time through `hashDiagnosticContent`: full-file bytes when the file is within ReadGuard's 3,000-line cap, otherwise the requested range capped to 3,000 lines. ReadGuard verifies that binding against current disk before edit authorization, so even timestamp-preserving mutations are rejected through the existing file-modified path.
Mounted at `globalThis[Symbol.for("pi-lens:read-bridge")]` after `RuntimeCoordinator` is initialised. Any extension running in the same Node.js process can call `bridge.recordRead({ filePath, requestedOffset, requestedLimit, consumer? })` to register a file read against the live read-guard. Check `bridge.version` (currently `1`) before calling — treat an unrecognised version as unsupported. The timestamp is stamped by the bridge itself (`Date.now()`), matching exactly how the internal read path works. The optional `consumer` string is surfaced as `source: "bridge:<consumer>"` in `read-guard.log` so the worklog shows which extension satisfied the guard. The bridge is an **advisory, trust-based protocol** — same-process extensions are already fully trusted; basic payload validation (non-empty string path, finite positive integer offsets/limits) exists to catch integration bugs early, not to enforce a security boundary. Entries that fail validation are silently dropped. The global slot is permanently locked after first registration: `Object.defineProperty` with `writable: false, configurable: false` plus `Object.freeze` on the bridge object means any attempt to overwrite or mutate throws `TypeError` in strict mode (first-wins is the contract). This lets custom Pi tools that perform file reads outside pi-lens’s normal tool tracking satisfy the read-before-edit guard without pi-lens coupling to any specific tool. The bridge respects `no-read-guard`, gitignored files, and external/vendor paths via the `isRecordable` predicate evaluated at call-time. Registration is a singleton (`_readBridgeRegistered` module-level guard) and happens inside the extension factory so `getLensFlag` is available; `_readBridgeGetFlag` is refreshed on every factory activation so flag changes take effect immediately.

**`tool_result`** → `handleToolResult` (`clients/runtime-tool-result.ts`)
Tracks modified file ranges per turn for turn_end targeting, bumps project/file sequence state for observed writes/edits, and appends project changes to `change-log.jsonl`. For write/edit events, runs the dispatch pipeline: format → autofix → LSP diagnostics sync → parallel async runner dispatch → dedup/merge → findings stored on `RuntimeCoordinator`. The **cascade** phase (neighbor diagnostics in OTHER files) is kicked off **unawaited** here (#450) — its graph rebuild + neighbor LSP pulls run concurrently after the edit returns rather than blocking it — and its promise is parked on `RuntimeCoordinator` via `appendCascadePromise` for `turn_end` to drain. Pipeline crash recovery fast-resets LSP with `resetLSPService({ fast: true })`. **IaC misconfig** (#131 Mode 2) is a per-edit dispatch runner here, not a session scan: `clients/dispatch/runners/trivy-config.ts` runs `trivy config` over Dockerfiles + Kubernetes manifests (YAML gated by an `apiVersion:`+`kind:` heuristic), `trivy.enabled`-gated, wired into the `docker`/`yaml`/`json` dispatch groups (json is content-gated to CloudFormation shapes, #2323); `suppressTrivyConfigDockerOverlap` (dispatcher) drops trivy-config findings hadolint already reports at the same Dockerfile line so it only adds the security checks hadolint lacks (k8s has no hadolint overlap). Compose remains deferred. **Helm rendered-manifest validation** (#1283 Slice B) is a second, separately-gated runner: `clients/dispatch/runners/helm-render.ts` renders the nearest chart with `helm template --output-dir <scratch>` under `os.tmpdir()` (never the chart dir; `--dependency-update` deliberately never passed) and validates the output — a failed render is a blocking finding on the template, every rendered document must declare `apiVersion`+`kind`, and `trivy config` runs over the rendered tree when `trivy.enabled` is also set. It is OFF unless `helm.renderValidation.enabled` is true in `.pi-lens.json` (rendering executes chart-authored template code — a trust boundary, not a lint), and it never spawns when unconfigured. **Two gates, not one:** that switch is a TRACKED file, so a cloned hostile chart repo could ship its own consent — the render therefore ALSO requires `getProjectTrustState() !== "untrusted"` (the same gate as LSP spawns and tool installs), and the refusal is reported as a `render-untrusted` diagnostic rather than a silent skip. The consent lookup is keyed off the WORKSPACE ROOT whose chart runs, never `ctx.cwd`: keying on the cwd let an opt-in in one directory authorize a different project root's chart. Findings map to source templates via helm's `# Source:` annotation, falling back to the `--output-dir` layout and then `Chart.yaml`; rendered line numbers go in the MESSAGE because they do not correspond to template lines. A spawn that never started reports `failureKind: "unavailable"` with no diagnostics; a render that exited non-zero always yields at least one finding, so an errored run can never read as clean.

IaC per-edit scheduling covers Docker, Kubernetes YAML, Terraform, and content-gated CloudFormation JSON. Compose remains deferred. Keep every `RunnerDefinition.appliesTo` kind represented by a static plan group or an explicit dynamic scheduling declaration. (#1757, #2323)

**`turn_end`** → `handleTurnEnd` (`clients/runtime-turn.ts`)
First **settles** the turn's deferred cascade computes with a bounded wait (`settleCascadeRuns`, cap via `PI_LENS_CASCADE_SETTLE_WAIT_MS`, default 5000ms; a late compute is carried over to the next turn_end rather than lost), then merges unresolved inline blockers and cascade findings, writes latest-turn actionable/code-quality warning reports with sequence metadata, runs Knip delta analysis when the startup scan is not in flight, runs Madge circular-dependency checks for files whose imports changed, and fires related/failed tests asynchronously for pull diagnostics and post-agent custom delivery. Reads the session-scan caches and surfaces them. **Secrets** (`gitleaks` + `trivy secret` + the ast-grep `*-hardcoded-secret-*` rules) are collapsed **by location** via `clients/secret-findings.ts` (`dedupeSecretFindings`) into a single 🔴 blocker with combined provenance (`[gitleaks + trivy + ast-grep]`) — the rule-keyed diagnostic dedup can't merge them since each source uses a different rule id; the duplicate ast-grep advisory copy is suppressed from the actionable-warnings report at the blocked locations (#131 Mode 3). Trivy **CRITICAL** CVEs are 🔴 blockers ("upgrade before shipping"); `govulncheck`/Trivy non-critical CVEs are advisories (FixedVersion as an upgrade hint — never auto-edits lockfiles). Trivy **license risk** (copyleft/restricted licenses, #131 Mode 4) is a 📜 advisory from the same `trivy fs --scanners vuln,secret,license` pass. Deduplicates findings against previous turn state and injects blockers (🔴) and advisories into the agent's context.
**Cached-blocker freshness gate (#1631).** A cached inline blocker is a verdict about its file *and everything that file imports*, yet every prior invalidation path keyed on the file alone — so when the cause was fixed in a dependency (especially out-of-band, where the dependency is never dispatched) the stale verdict re-served for the rest of the session (#1561's dependency-axis remainder, live instance). Before a cached blocking finding is re-served at turn end, `clients/blocker-freshness.ts` (`sweepInlineBlockerFreshness`) stats the file and its forward imports (resolved via the parse layer — no reverse-dependency index, so #1561's tests-free-index blocker does not apply) against the verdict's `recordedAtMs`; a drifted entry is DEMOTED, not dropped (#1419 demote-not-drop): `stale = true`, served out of the authoritative blocker channel as a `[stale — re-run to confirm]` advisory, and the gate never re-pulls the LSP itself (re-querying an LSP whose in-memory dependency document is itself stale would regenerate the stale verdict). The SAME gate lives at the widget-store cache layer (`reconcileStaleWidgetDependencyBlockers`, paired with `reconcileStaleWidgetFiles` at the `mode=all` read site) so `lens_diagnostics mode=all` cannot serve a blocking entry a same-minute `mode=full` sweep contradicts. One bounded `blocker_freshness_sweep` latency phase (plus `blocker_freshness_widget_gate` for `mode=all`) names the revalidated/kept/truncatedImports counts (`retired` was removed — the gate is architecturally demote-not-drop, so it never deletes an entry and the count would always read 0). `isBlocking` answers false for a stale finding, which is the single predicate both the footer tally and the mode=all blocking count consult. The full dependency-axis INVALIDATION (actively re-verifying consumers when a dependency dispatches clean) remains deferred to #1561. **Population gap (#1790).** The turn-end sweep's population was built solely from `RuntimeCoordinator`'s inline-blocker map — a live-dispatch-only store — so a blocking row a workspace-diagnostics CACHE HIT wrote straight into `widget-state.ts`'s `files` map (never touching the inline-blocker map) rendered in the widget while the sweep logged `total:1 kept:1` and never saw it. `sweepInlineBlockerFreshness` now accepts `options.additionalEntries`, populated by `runtime-turn.ts` from `widget-state.ts`'s `getWidgetBlockingFilesForSweep`, deduped by file path (`normalizeEphemeralMapKey` — cheap and consistent with the widget store's own key, not `normalizeMapKey`'s realpath/walk-up) against the inline-blocker map so a file present in both is drift-checked once. Review round 1 (#1790 F1) found the dedup DROPPING the widget row on a duplicate path: a live dispatch writes BOTH stores for one verdict, and `markInlineBlockerStale` only ever touches `RuntimeCoordinator`'s map, so the widget's own `isBlocking` for the file stayed true even after the inline entry demoted — the same ghost, one store over. A duplicated path now CHAINS the widget demote onto the inline entry's demote instead of discarding it: one drift check, both stores written. Review round 2 (#1790 F5) found the chain itself still ghost-prone: it fired even when the inline entry it chained onto was INELIGIBLE for the drift check (already latched `stale`, unstamped, or non-LSP/mixed sources) — the sweep's own gates short-circuit before ever calling `demote()` on those, so the chained widget demote silently never fired, either as a permanent forever-ghost (the stale latch never re-arms) or reappearing the instant an unrelated inline blocker shared the file. A duplicate now only chains when the inline entry is itself eligible (`isEligibleForDriftCheck`, the same three gates factored out so this can't drift from the real ones); an ineligible duplicate gives the widget row its own separate population entry, so a file can legitimately count twice when the two stores disagree on eligibility. The widget-origin write path is `markWidgetFileBlockersStale`, not `reconcileStaleWidgetDependencyBlockers` (that one stays mode=all-only) — same store, same demotion, different trigger, so this reuses the write rather than re-implementing it; a comment there pins the single-file-baseline assumption it depends on for a future writer. The two stores are injected rather than cross-imported because `widget-state.ts` already imports FROM `blocker-freshness.ts` (`collectForwardImportMtimes`); importing back would cycle.
**Finding-delivery gate — single doc home (#1634).** Every store above (secrets, govulncheck, the cached-blocker gate) plus `lens_diagnostics` mode=full/all, the widget footer, agent nudges, and the persisted project-diagnostics snapshot are enumerated in `clients/finding-delivery-gate.ts`'s `DELIVERY_SURFACES` registry — the single place the freshness/dispositions/demotion-rendering contract is spelled out; every other file that gates or labels a finding points there instead of re-explaining it. Each surface is either `gated` (routes through `gateFindingsByPathFreshness`/`applyDispositions`/the blocker-freshness family above) or `labeled` (a package-pinned finding like a trivy CRITICAL CVE has no cited path to gate, so `formatCacheAgeLabel` states the session_start cache's age instead) — `assertNoDeliveryBypass()` rejects any registration that is neither, and `tests/clients/finding-delivery-gate.test.ts` ground-truths every entry's named gate/label call against its declared source file.

**Agent-facing delivery surface inventory (authoritative, #2028).** Every surface that delivers findings/blockers/advisories to the MODEL must appear in `DELIVERY_SURFACES`. Current map — REGISTERED: turn-end blockers and advisories (secrets gitleaks/trivy, trivy CVE/license/critical, govulncheck, knip blocker+advisory, dead-code, unresolved-inline-blocker, cascade blocker+coverage, call-graph, actionable-warnings, code-quality, disposition-suppressed-notice, stale-secrets-tier), `lens_diagnostics` mode=full/all/delta outputs, persisted project-diagnostics snapshot, widget footer, agent-nudge context message. UNREGISTERED as of #2028 (registration pending): the per-edit 🔴 STOP blocker block (`pipeline.ts`, gated) + its demoted-render transform; `lsp_diagnostics` tool output (gated); synchronous preflight rejections — git-guard COMMIT BLOCKED reasons (`git-guard.ts`), read-guard hashline/RE-READ errors (`read-guard-tool-lines.ts`) — LABELED (no stored state to go stale); agent-behavior THRASHING notice (LABELED, ephemeral). When adding any new emitter of model-directed diagnostic text: register it here first, then wire the gate/label call — `assertNoDeliveryBypass` cannot see unregistered emitters.

Deferred cascades must not charge write-to-`turn_end` time against the `turn_end` settle budget. `runtime-coordinator` exposes the active `turn_end` settle start; `runtime-turn` enables it, and quiet-window carry-over does not. Transitive-impact `truncated` means partial coverage even when the final file slice fits, so `cascade_result.transitiveTruncated` and `CascadeBudgetCoverage.transitiveTruncated` are lower-bound evidence, not an exact omitted count; `truncated` is true only when an additional eligible edge is found beyond the hit cap, so an exact-cap traversal is complete; mixed cascades replay passive findings only for selected no-LSP candidates, while all-no-data runs retain broad fallback.

## Key abstractions

**`RuntimeCoordinator`** (`clients/runtime-coordinator.ts`) — session-scoped singleton passed through most of the stack.
Key fields: `projectRoot`, `sessionGeneration` (incremented on each `session_start`), `projectSeq`, `turnStartProjectSeq`, file sequence map (`bumpFileSeq()`, `getFileSeq()`), `cachedExports` (symbol→file map from ast-grep startup scan), `cachedProjectIndex` (structural similarity index), `complexityBaselines` (per-file complexity for regression detection), `projectRulesScan` (custom ast-grep rules found in the project), per-turn actionable warnings, and per-turn code-quality warnings.

**ONE mutation seam (#2000 phase 1).** Every producer of an in-project file mutation — native write/edit, recognized bash writes, deferred format/autofix, LSP workspace edits, and future opaque-script recovery — records through `RuntimeCoordinator.recordProjectMutation({filePath, source, cwd?, changedRange?, onAppendError?})`, ONCE: it bumps the seq store, appends a bounded attributed receipt (`MutationReceipt`, ring cap 512 with a surfaced dropped-count), and appends the durable change-log entry. Consumers derive from `getFilesChangedSince(seq)` / `getMutationsSince(seq)`; never hand-roll a parallel `bumpFileSeq` + `appendProjectChange` pairing (the triplicated copies this seam replaced lived in `runtime-tool-result.ts`, `runtime-agent-end.ts`, and `lsp-mutation.ts` — exactly where a new mutation class gets dropped).

**Consolidated stores are the priority — but a store is DONE only when every relevant lane is wired through it.** Building one staleness comparator (#1739) or one changed-files seam (#2000 phase 1) beats six reimplementations, and each new mutation class must feed the store rather than hand-roll its own pairing. The failure mode to guard against is the half-wired store: receipts recorded correctly while a downstream lane (deferred format, blocker-freshness population, recent-touches, cascade seq-fastpath) still derives its input from the old tool-event path, silently excluding the new producer class. When adding or extending a consolidated store: (1) enumerate every PRODUCER that must record into it and sweep for stragglers (grep the pre-consolidation pairing); (2) enumerate every LANE that consumes changed-file answers and re-point them at the store's query surface; (3) prove lane coverage with a test that drives a mutation through each producer class and asserts the consumer sees it (the #2021 mixed-command and live dogfood checks are the pattern); (4) state any deliberately unwired lane in the store's doc block, with the reason. Receipts carry per-producer sources: `agent-write`, `agent-edit`, `format`, `autofix`, `partial-apply`, `lsp-edit`, `opaque-script`, `external`.

**Opaque-write recovery (#2000 phase 2) — supported/unsupported matrix.** Every bash command gets a pre-baseline at `tool_call`: inside a git worktree just a timestamp (git-first, no file cap); outside git a bounded stat snapshot (2000-file cap, beyond it coverage-unknown). At `tool_result`, `git status --porcelain -z` paths whose mtime falls in `[startedAt−150ms, …]` are recovered, filtered through the same external/vendor/ignore checks as recognized writes, and dispatched as synthetic writes with source `opaque-script`. **Supported**: any child-process write (python/node/perl/ruby/PowerShell internals), restores (`git checkout -- f` is attributed — restore semantics divergence from the isError filter is deliberate), mixed redirect+internal-write commands (recovery runs for EVERY bash command with a baseline; already-recognized paths are subtracted). **Unsupported/excluded**: ignored/vendor/out-of-project paths (invariant 4 — an all-gitignored write set reads as empty recovery BY SPEC); deletions; content-identical rewrites under git (correctly unreported); non-git trees above the stat cap (coverage-unknown); same-ms same-size rewrites on the stat path are detected by the budgeted content-hash confirm (8MB per capture; past it, mtime+size fallback applies; pre/post captures may hash different subsets when the walk-order budget shifts between them, in which case those files degrade to mtime+size silently). Failure-atomicity source flip: under `isError=true`, a recognized redirect target dispatches as `opaque-script` rather than `agent-write` — recovery subtracts only the SURVIVING written set. **Failed integration exception** (#2060): for a failed `git merge`, `rebase`, `cherry-pick`, `pull`, `revert`, or `am` with unmerged index entries, recovery excludes clean index-only incoming paths and retains unmerged and worktree-side paths. `stash pop`/`apply`, `checkout -m`, and `apply -3` are deliberately OUT of that family: their "incoming" content is the agent's own work, so excluding it would destroy what recovery exists to capture. Agent work staged before an integration is safe by construction — merge, rebase, cherry-pick, and revert all refuse to start against a dirty index, so they leave no unmerged entry and the filter stays inert. Porcelain parsing fails closed (coverage-unknown) on truncated stdout, unterminated output, a missing rename token, or a status field outside `[ MTADRCU?!]`. An in-alphabet XY pair outside the documented matrix is a gap in OUR table, so its path is KEPT and counted rather than voiding the whole command. The ordinary matrix: clean-index M/T/D, intent-to-add ` A`, worktree rename/copy ` R`/` C`; M/T/A/R/C with blank/M/T/D; staged deletion `D `, `DR`, `DC`. **Failure atomicity**: partial writes landing before nonzero exit ARE attributed. Telemetry: `opaque_mutation_prescan`, `_recovered changed:N`, `_coverage_unknown <reason>`, `_incoming_excluded excluded:N`, `_status_pair_unknown kept:N` in latency.log.

**`DispatchContext`** — built per dispatch by `createDispatchContext()` in `clients/dispatch/dispatcher.ts`.
Holds: `filePath`, language-root `cwd`, `kind` (`FileKind` — `jsts`, `python`, `go`, `rust`, `css`, etc.), `pi` flags, `facts` (FactStore), `blockingOnly`, `modifiedRanges`, and `hasTool(cmd)` / `log()` helpers.

**`FactStore`** — session+turn-scoped key-value store. Runners use it to cache tool availability checks (e.g., "is biome installed?") so subsequent dispatches within the same session skip the spawn. Set/get via `facts.setSessionFact` / `facts.getSessionFact`.

**`FileKind`** — union type (`"jsts"` | `"python"` | `"go"` | `"rust"` | …) detected from the file path. Controls which runners are eligible for a given dispatch. Runners declare `appliesTo: FileKind[]`; an empty array means "all kinds".

## Project intelligence and snapshots

- **`clients/lens-flag-registry.ts` is THE source of truth for every runtime toggle (#166) — add a flag there, nowhere else.** One `LensFlagSpec` per toggle (`name`, `description`, `configKey`, `negated`, `default`, `scope`, optional `env`/`readGlobal`) drives ALL FOUR consumers that used to keep their own list: `index.ts`'s `registerFlag` loop, `lens-config.ts`'s config parsing AND `resolvePiLensFlagWithSource` precedence chain, `project-lens-config.ts`'s nested closest-wins walk, and `tests/index-wiring.test.ts`'s registration contract. The module imports NOTHING, which is what lets both config loaders share `assignFlagConfigSection`/`readFlagConfigValue` without the import cycle that `config-enabled-shape.ts` was extracted to dodge (now deleted — the registry replaced it). How to apply: a new toggle is one array entry plus docs; do NOT add a `registerFlag` call, an if/else branch in the resolver, or a hand-parsed key in a loader. The invariant this enforces is that CLI and `config.json` coverage cannot diverge — the gap #166 reported was seven flags registered on the CLI that the resolver's if/else chain never matched, so `config.json` could never set them, and the wiring test that existed to catch exactly that had itself drifted (it was missing `lens-turn-summary`). `configKey` is a dotted path to a **boolean**, always in POSITIVE polarity (`lsp.enabled`, not `noLsp`); `negated: true` is how a `no-*` flag reads it. `scope: "project"` opts a flag into the `.pi-lens.json` tiers; `"global"` flags resolve env → cli → global → default. NON-boolean config keys (`dispatch.runnerTimeoutFloorMs`, `widget.visible`, `format.mode`, `actionableWarnings.autoFix.maxFixes`) are not flags and stay hand-parsed in `loadPiLensGlobalConfig` with a `getGlobal*` accessor beside the others — but they carry the same obligation: a key documented in `globalconfig.md` that no loader reads is the exact bug #166 fixed twice over (`maxFixes` was documented from #792 and silently unread until #166 wired it into `runtime-agent-end.ts`). When adding a documented key, grep for its reader before closing out.
- **Project mutation controls are independent from diagnostics (#789/#792).** `.pi-lens.json` `format.enabled`, `autofix.enabled`, and `actionableWarnings.autoFix.enabled` (the three `scope: "project"` registry entries) resolve per edited file with closest-wins, per-flag inheritance from the file directory through the project root; explicit disabling CLI flags win, then the nearest defining project config, then global defaults. The shared upward walk is HOME-guarded and per-directory lookups are mtime-cached. Disabling any mutation path MUST NOT skip LSP synchronization, dispatch lint, actionable-warning reporting, or diagnostic publication.
- **Scan exclusion + walk confinement are shared invariants — don't reinvent them per walker (#243/#250/#252/#253).** Any new filesystem walker MUST (1) route dir excludes through `isExcludedDirName` (`EXCLUDED_DIRS` in `file-utils.ts`) and path excludes through `getProjectIgnoreMatcher(root).isIgnored(...)` — NOT a private skip-list (a hardcoded set in the LSP workspace walk silently dropped users' `.pi-lens.json` `ignore` for months, #243); (2) **cap the walk-DOWN** with a `maxFiles` early-stop (source-filter `collectSourceFiles{,Async}`, warmup `collectSourceFilesForWarmup`=2000, review-graph `getGraphSourceFiles`=`maxGraphFiles+1` scoped to `MAIN_KIND_EXTENSIONS`, LSP workspace walk=5000); (3) for walk-**UP** project-root resolution, reject a marker at/above `$HOME` via `isAtOrAboveHomeDir(dir, homeDir?)` (`path-utils.ts`) — an exact `=== os.homedir()` check misses a marker found *above* `$HOME` (/home, C:\Users, fs root) and re-opens the #250 home-tree runaway. `resolveLanguageRootForFile` keeps its stricter workspace-relative check.
- **`clients/workspace-topology.ts` — the preferred seam for per-directory MARKER discovery (#806), not just another walker.** Before hand-rolling "does this directory (or its nearest ancestor) contain file X" for a new marker, check whether `getWorkspaceTopology`'s shared index already covers it (`.pi-lens.json`/`pi-lens.json`, `tsconfig.json`, and the `workspace-modules.ts` manifest set — `package.json`, `pnpm-workspace.yaml`, `Cargo.toml`, `go.work`) or extend `getDirectoryMarkers` with a new marker rather than adding a private probe. `getDirectoryMarkers(dir)` collects ALL markers for a directory in ONE `readdir` pass, cached and mtime-invalidated per directory; `findNearestDirWithMarker` layers the shared `walkUpDirs` + `isAtOrAboveHomeDir` walk-UP discipline on top, capped at 64 climbs with a `workspace-topology-walk-cap` latency-phase log on trip (never a silent truncation, per the invariant above). `project-lens-config.ts`'s `findPiLensConfigInDir`, `tsconfig-paths.ts`'s governing-tsconfig lookup, and `workspace-modules.ts`'s `detectWorkspaceType` manifest-presence checks are migrated onto this index; each subsystem's OWN downstream cache (parsed config, matcher list, module graph) stays where it is — this module only indexes marker PRESENCE, not parsed content. `resetWorkspaceTopology()` is wired into `handleSessionStart` (`runtime-session.ts`) alongside `clearTsconfigPathsCache()`. **`registerWorkspaceTopologyReset` is PUSH-ONLY — a compensating registered-or-fail sweep closes the gap (#2294, `tests/clients/workspace-topology-conformance.test.ts`):** the sweep is structural and IMPORT-scoped, not call-shaped: it parses actual import declarations through the existing ast-grep seam, resolves each specifier to the exact canonical source path, and enumerates every `clients/` module that BINDS a topology probe seam (`workspace-topology.js` for its probe exports — `getDirectoryMarkers`, `findNearestDirWithMarker`, `findNearestDirWithAnyBasename`, `findPiLensConfigMarkerInDir`, `findGoverningTsconfigDir`, `getWorkspaceManifestMarkers` — and `startup-scan.js` for `findNearestProjectRoot`) through a NAMED, ALIASED, multiline, or NAMESPACE import, and asserts each either calls `registerWorkspaceTopologyReset(` (registration DERIVED from source, never a copied list) or carries a documented freshness-key exemption. A named import counts even if the binding is never invoked (importing a seam is the act that can feed a memo); type-only and side-effect-only imports do not count; an unrelated same-name LOCAL function never does (a call-shaped detector both missed aliased imports and false-flagged those locals). When you add a module that memoizes a topology-derived result, register a downstream reset here; if it is stateless/per-call or self-invalidates (own retained reset or a file/path+mtime+size key), exempt it with the reason in that test's map instead. **Root/language-root resolution (#807, second wave):** `language-profile.ts`'s `resolveLanguageRootForFile` now calls `findNearestDirWithAnyBasename(startDir, markers)` — the generalized, home-guarded/depth-capped/walk-cached counterpart of `findNearestDirWithMarker` for a per-call marker list rather than one of `DirectoryMarkers`' typed fields (each `DirectoryMarkers` entry also exposes a raw `entryNames` set from its single `readdir`, for exactly this kind of type-agnostic, non-typed-field presence check); `resolveLanguageRootForFile` itself is UNCHANGED policy-wise — it still clamps any found root back to `workspaceRoot` via its own stricter workspace-relative check, the topology service only supplies discovery. `startup-scan.ts`'s `findNearestProjectRoot` reads its per-directory marker presence through `getDirectoryMarkers(dir).entryNames` too, but keeps its OWN hand-written, NOT-home-guarded walk-UP loop — its callers need the actual marker location even when it resolves at/above `$HOME`, to tell the `"home-dir"` verdict apart from `"no-project-root"` (see its docstring and `startup-scan-home-ceiling.test.ts`); routing it through a home-guarded walker would silently turn `"home-dir"` into `"no-project-root"`.
- **`lens_diagnostics`/`pilens_diagnostics` `paths` scope restrictor (#461).** An optional `paths?: string[]` (max 200 entries, error not truncate) uniformly narrows all three modes to an explicit file/directory list — no new mode, no rejected combinations. delta/all: pure post-filter composed with the existing ignore predicate (`resolvePathsScope` in `tools/lens-diagnostics.ts`); an empty result under `paths` gets the honest "cached-only, use mode=full" note (mirroring the #190 carried-over note). full: an ACTIVE scan restricted to the list — `LSPService.runWorkspaceDiagnostics` grew a `files?: string[]` option that skips the whole-project walk (`clients/lsp/index.ts`), and `scanProjectDiagnostics` grew the same on `ProjectDiagnosticsScanOptions` (skips `collectSourceFilesAsync`); the cached heavyweight extractors (jscpd/madge/gitleaks/knip) and project snapshot stay cache-only post-filtered reads — never relaunched. A `files`-scoped `scanProjectDiagnostics` call deliberately does NOT persist its snapshot (would poison the cross-session cache with a partial view). Directory entries match as path-prefixes via the same predicate (no eager directory listing). Explicitly-listed files are NOT re-filtered through the project ignore matcher — matches `lsp_diagnostics`' `paths` param, which also takes explicit entries as-is (only its directory-walk mode applies the ignore matcher). Nonexistent entries (the git-staged-deleted-file case) are skipped silently for delta/all and noted in mode=full's output, never thrown.
- **Diagnostic SURFACES — not just walkers — must filter `ignore` AND reconcile on-disk staleness (#279/#297/#298).** Excluding a file from the *walk* is necessary but not sufficient: anything that *displays* a recorded diagnostic re-checks both. (1) **Ignore on display:** `lens_diagnostics` delta/all/full filter through `createCurrentIgnoreFilter`→`getProjectIgnoreMatcher` (#279); **cascade** neighbor selection (`computeCascadeForFile`, `clients/dispatch/integration.ts`) filtered only by `isExternalOrVendorFile` and leaked a user-ignored neighbor's phantom diagnostics (#297 — editing `reader.ts` surfaced its ignored `reader.test.ts` importer's stale-view TS error), so BOTH the `sortedNeighbors` walk and `appendFallbackNeighbors` now also route through `isIgnoredCascadeNeighbor`→`getProjectIgnoreMatcher` (fail-open on a config-probe error). **The ignore matcher is only the ignored-file HALF of the cascade display policy; the test-ROLE half is #1080:** the review graph is tests-free, but collateral surfaces that re-derive neighbors from OTHER sources (LSP reference expansion, module-level downstream files, reverse-deps, the passive fallback) never saw that filter, so an UNIGNORED `*.test.*`/`tests/` neighbor could still leak. `clients/collateral-test-role.ts:isTestRoleCollateral` (composes `detectFileRole`, NOT a second matcher/private list; fail-open = RETAIN on a classifier throw) is applied at every collateral producer boundary: `computeCascadeForFile` filters `impact.directImporters`/`directCallers`/`neighborFiles` AFTER all appends (so the touch set, the returned `impact`, AND the `formatImpactCascade` header/counts are all clean — module-downstream files are caught HERE at consumption, deliberately NOT inside `computeImpactCascade`, so other query consumers stay unfiltered); `appendFallbackNeighbors`; the `runtime-turn.ts` call-graph advisory (filters `impact()` results before both the advisory text and the persisted delta); and `callGraphImpactToProjectDiagnostics`. It does NOT touch per-runner/auxiliary `skipTestFiles`, primary LSP diagnostics, or the generic snapshot/delta display (no blanket test-drop there). (2) **Staleness on display:** the in-memory widget has `reconcileStaleWidgetFiles` (per-ENTRY since #1186: drop each diagnostic whose own `observedAt` predates `mtimeMs`, keep the record while any survive, drop it only when empty — a merged record can hold a fresh preserved entry beside an aging cascade-snapshot entry, so a whole-record `mtimeMs > touchedAt` gate over-cleared; a finding-less clean record still gates on `touchedAt`), but the PERSISTED `project-diagnostics.json` snapshot (served by `lens_diagnostics mode=full refreshRunners=cached`) had NO equivalent — `loadProjectDiagnosticsSnapshot` validated only the cache `version`, replaying diagnostics for files the agent had since edited/deleted (#298 "cache needs cleaning"). `reconcileProjectDiagnosticsSnapshot` (`clients/project-diagnostics/cache.ts`) now drops a diagnostic when its file's `mtimeMs > scannedAt` (+1ms) or is gone, applied at the cached-full-mode consumer so `load…Snapshot` stays a pure reader (fail-safe: unparseable `scannedAt` → keep all). **Rule of thumb: a new diagnostic surface ⇒ ask "does it filter ignore?" AND "does it reconcile against current disk state?"**
- **Tree-sitter symbol/import extractor (`tree-sitter-symbol-extractor.ts`, feeds the review graph) — two hard-won gotchas.** (1) web-tree-sitter 0.25 `Query.matches()` **does** apply `#match?`/`#eq?` predicates on the shipped grammars, so call/builtin-based import langs (ruby/zig/elixir/bash) use predicate-filtered queries directly. (2) All grammars load into ONE process-global WASM Module via the shared `treeSitterClient`; **lua parses to ERROR trees once a 2nd grammar loads** (external-scanner corruption — #255), silently breaking lua symbols+imports in multi-language repos. **When adding/validating a grammar query, exercise it under the fully-warmed shared client (the smoke tests do), not just a fresh client — a fresh-client probe passed while production was broken.**
- **Shared tree-sitter parse-cache telemetry (#675).** Every production consumer, including tool-call read expansion, MUST obtain the process-wide client through `getSharedTreeSitterClient`; a second client owns a separate cache, can race the module-global WASM runtime, and bypasses abort poisoning. `TreeCache` stays a 50-entry cache (true LRU since #890 — `get()` re-inserts hits, and a hash match is authoritative even when mtime moved, so a save-without-change is a hit, not a false miss) and **the scan is file-major instead** — measured, not assumed. Phase-major, a `mode=full` scan of pi-lens itself (500 files) had the tree-sitter phase at 11,249 lookups / 96.8% hits / **0 capacity misses** (50 entries is ample WITHIN a phase, since every rule re-enters through `parseFile`) and the fact-rules phase behind it at **357 capacity misses out of 357 first touches** — every file it wanted had been parsed by the previous phase and evicted. `scanTreeSitterAndFactRules` now runs both runners per file: 722 parses → 367, 892ms → 437ms of parse time, capacity misses → 0, with the diagnostic order unchanged (separate result lists, concatenated tree-sitter-then-fact-rules). Raising capacity would have been the WRONG lever: for a phase-major sweep any capacity below the working set buys exactly nothing (250 entries over 839 files = zero reuse, same 2,517 parses as 50), and a capacity that does cover it costs ~150-300MB RSS for ~37× source size in resident WASM trees. **Any new project-wide runner that tree-sitter-parses the same files belongs in that file-major pass, not in another sweep.** Parsing is now ~437ms of a ~23.5s scan, so query execution, not parsing, is what remains. It tracks lookup outcomes, mutation counts, and exact same-content capacity misses through a 4,096-key bounded eviction history (`ghostHistoryDrops` makes undercounting visible). `TreeSitterClient.getParseCacheStats()` adds actual parser invocations/time/failures. `AsyncLocalStorage` isolates each measured phase from overlapping shared-client work (do not restore process-wide before/after snapshots) and is released once the last overlapping measurement ends — on Node 22 a live ALS keeps an async_hooks init hook enabled for every promise in the process. Every production consumer extracts inside `withParsedTree()`/`withTreeSitterRoot()`, which return `{parsed: true, value}` / `{parsed: false}` so a consumer that legitimately returns null is never read as a parse failure; `parseFile()` is the raw escape hatch for tests/scripts only and its tree is valid only until the caller's next `await` (evicted/replaced trees retire after a bounded microtask grace). `TreeSitterSymbolExtractor.init()` self-loads its grammar so callers can initialize the extractor first. Actual Emscripten `Aborted`/`abort()` errors invoke the shared client's poison callback; do not swallow them without reporting through `reportWasmAbort`. The merged project-diagnostics pass and full review-graph extraction emit one aggregate `cache_stats` record each (`project_diagnostics_scan`, `review_graph_full`). Raw hit rate alone is misleading because each rule calls through `parseFile`; use parser invocations/time plus capacity misses when tuning.
- **Which rules run, and how they run (#675 follow-through) — four ways this went wrong, all measured on a 500-file scan.** (1) **A compiled `Query` is bound to the grammar it compiled against.** Run it on a tree from another grammar and tree-sitter returns zero matches, forever, silently. `runQueryOnFile`/`runQueriesOnFile` therefore compile against the language the FILE is parsed as, never the rule's own `language:` key — that key selects which rules apply, it is not a compile target. The javascript→typescript rule merge had been compiling typescript rules against typescript and running them on javascript trees since it was written: 31 rules per JS file, structurally unable to fire. (2) **`queriesForLanguage` (`tree-sitter-query-loader.ts`) is the ONLY way to pick a rule set** — it excludes `<language>-disabled/` rules, which the per-edit runner had always done but the project scanner bypassed by reading the raw loader map, so **1,936 of a scan's 2,590 tree-sitter findings came from rules somebody had explicitly switched off**. Only `tsx` inherits the typescript rule set (verified rule-for-rule identical on the same source under both grammars — tsx IS typescript plus JSX); `javascript` deliberately does NOT, because those rules are written against typescript node types (JS params are bare `(identifier)` where typescript has `required_parameter`, so `duplicate-function-arg` alone reports 59 phantom duplicates over 60 files). Re-enabling it means validating the typescript rules against the javascript grammar first. (3) **An unimplemented `post_filter` fails CLOSED** (`applyPostFilter`'s default drops the match and warns once). It used to return `true`, which turned "this rule's condition was never implemented" into "report every raw structural match" — 40 of the 84 filters rules ask for have no implementation, and the two that fired here produced ~2,000 unfiltered findings. Adding a rule with a new `post_filter` means implementing it or the rule stays silent, by design. (4) The loader's hand-rolled `parseYaml` now strips trailing `# comments` from unquoted scalars as it already did for array items — `post_filter: not_in_test_block  # skip test blocks` had been carrying the comment as part of the filter NAME. **Rule sets are executed in ONE tree walk**: `runQueriesOnFile` concatenates the set into a multi-pattern query and maps `match.patternIndex` back to the owning rule (3.3× faster than a walk per rule, byte-identical matches), keeping per-rule metavars, predicates, post-filters, caps and result order; a rule that can't compile against this grammar is dropped individually and a failed batch compile falls back to per-rule execution.
- `RuntimeCoordinator` owns monotonic `projectSeq` and per-file sequence numbers. Every pi-observed disk mutation should call `bumpFileSeq()` and append a `ProjectChangeEntry` via `appendProjectChange()` with source `agent-write`, `agent-edit`, `partial-apply`, `format`, `autofix`, `lsp-edit`, or `external`.
- `clients/project-changes.ts` persists `<project-data-dir>/change-log.jsonl` and seeds session-start sequence state with `readLatestProjectSequence()`.
- `clients/project-snapshot.ts` saves `.pi-lens/cache/project-snapshot.json` with `version`, `seq`, `cachedExports`, `projectRulesScan`, startup scan/profile metadata, and reverse dependency data. Freshness is seq-based: `snapshot.seq === runtime.projectSeq`.
- `clients/reverse-deps.ts` builds `file -> imports` and `file -> importedBy` from the review graph, persists them into the project snapshot, reloads fresh snapshot-backed indexes, and provides bounded affected-file queries. Cascade graph builds refresh this section and merge fresh cached reverse-dependency neighbors into cascade selection; debug via `~/.pi-lens/cascade.log` phase `reverse_deps_cache`.
- **JS/TS review-graph import resolution honors tsconfig path aliases and project references (#775 R2/#819).** `clients/review-graph/tsconfig-paths.ts` finds the nearest `tsconfig.json` through the shared workspace-topology climb, rejects configs at/above `$HOME`, parses JSONC plus relative `extends` chains (package-name extends deliberately fall through), and session-caches resolution per importer directory. Both the cold resolver and warm builder use the same precedence: `paths` aliases, then exact package-name mappings collected transitively from relative-only `references` (cycle-guarded; source entries derived from the referenced config's `rootDir`/`include`, then conventional index fallbacks), then workspace-package matching. Keep these resolutions additive, workspace-confined, on the shared JS/TS file-candidate seam, and clear new tsconfig-derived caches through `clearTsconfigPathsCache()`.
- **`/lens-map` (#679) — human-facing HTML project map, a review-graph consumer.** `clients/lens-map.ts`'s `generateLensMap(cwd)` aggregates the (symbol-level) review graph up to FILE-level nodes and deduped/weighted file→file edges (`aggregateGraphToFiles`), computes a deterministic force-directed layout in Node (`computeLayout` — path-hash-seeded, so re-running on an unchanged project reproduces the same map), and renders a zero-dependency self-contained HTML page (`renderMapHtml` — embedded JSON payload + vanilla JS/SVG, no CDN, no npm deps) with pan/zoom/hover/click. Written to `<project data dir>/reports/lens-map.html` via `getProjectDataDir` (never a hardcoded `.pi-lens`); the command notifies the absolute path via `ctx.ui.notify`, no browser auto-open. Unlike `module_report`'s read-only #256 contract, this path DOES build the graph on a cold cache (`buildOrUpdateGraph(cwd, [], new FactStore())`) — the user explicitly asked for a map, so a few seconds' build cost is acceptable. "external" kind nodes are excluded from the map (counted in the header instead); test files (per `detectFileRole`, `clients/file-role.ts`) are ALSO excluded — along with their edges, and before degree/dependents/truncation ranking is computed, so they can't inflate rank or eat into the node cap — counted in the header as `testFileCount`; compiled twins are merged, not double-rendered — when both `X.js` and its `X.ts`/`X.tsx` source exist as file identities (compile-in-place projects), the compiled node's symbols and ALL edges remap onto the source (`.mjs`→`.mts`, `.cjs`→`.cts` too; post-merge self-edges collapse; twin-less `.js` files are untouched), counted as `compiledTwinCount`; untracked-gitignored files are excluded via git's own verdict (`git ls-files --others --ignored --exclude-standard` — a TRACKED file is never ignored, so committed vendored files matching an ignore pattern stay; no-op outside a git repo; twin-merge takes precedence so an ignored compiled file with a surviving source twin merges instead of dropping its edges), counted as `ignoredFileCount`; the viewer has four pure client-side interactions — search-to-highlight, min-edge-weight slider (isolated nodes fade in place, never move), label culling (zoom > 1.5× or top-25 by dependents), and undirected-BFS path tracing (shift+click or "trace path" toggle) — composed through ONE `recomputeVisibility` pass (precedence: trace > search > weight; culling affects labels only); a graph over `PI_LENS_MAP_MAX_NODES` (default 500) files keeps only the highest-degree ones with a visible truncation note. Node fill is a neutral brand-blue intensity scale by transitive dependents ONLY (light `#2563eb` / dark `#60a5fa`) — calibrated complexity-aware coloring is deferred to #306, not invented here. Security: every graph-derived string (file paths) reaches the page only via a `<script type="application/json">` block (escaped so no substring can break out of the tag) read back through DOM `textContent`/`createElementNS` client-side — never string-concatenated into HTML (the #504-spike XSS-from-repo-content mitigation). Human-only: no agent tool, no MCP mirror.
- **Review-graph freshness — seq fast path (#451).** `buildOrUpdateGraph` normally re-derives freshness with an O(project) walk+stat sweep to signature-compare the cached workspace graph. When the deferred cascade threads a `seqHint` (RuntimeCoordinator's `projectSeq` + `getFilesChangedSince`), the builder instead asks the coordinator exactly which files pi observed changing since the last build and incrementally re-extracts just those (reusing the same `updateGraphFiles` machinery), skipping the sweep entirely; `_lastGraphBuildInfo.mode === "seq-fastpath"` (visible in `cascade.log`'s `graph_build` phase). A **periodic full re-verify** (every 20 fast-path builds or 5 min per workspace) still runs the sweep to catch external edits (IDE, `git checkout`) that never bump `projectSeq`, and any doubt (deletion, >32 changed files, no recorded build seq) falls back to the sweep. Callers without a hint (MCP fresh mode, `module_report`, tests) get today's behavior byte-for-byte; `PI_LENS_GRAPH_SEQ_FASTPATH=0` disables.
- **Warm call-graph cache source identity (#1070).** `runtime-session` derives the persisted call-graph cache key from the canonical review-graph version/signature; it does not run an independent call-graph source walk or mtime policy. `module_report` is read-only and rejects missing/mismatched/legacy/partial review-graph identity as unavailable or stale, never a clean zero. Warm call facts use the shared Tree-Sitter/function-facts provider for all supported JavaScript-family extensions (`.js`, `.jsx`, `.mjs`, `.cjs`, plus TS/TSX variants); unsupported or partial extraction must remain explicit in coverage rather than becoming a clean empty graph. Same-file resolved calls are intentionally omitted from this cross-file projection but counted as `sameFileEvidence`, so they do not make otherwise-complete coverage partial or suppress valid cross-file impact. Legacy ambiguous name-only evidence may fan out to weighted edges, but coverage counts raw evidence once and persisted validation weights those edges back to raw records.
- `actionable-warnings.json`, `code-quality-warnings.json`, code-quality history, and turn-end findings include project/file sequence metadata. Agent-end actionable-warning autofix must reject stale reports before applying cached LSP quickfixes.
- **LSP last-known cache is content-hash guarded (anti-staleness).** `LensLSPService.touchFile` primes `lastKnownDiagnostics` together with a sha256 of the synced content; `getLastKnownDiagnostics(path, expectedContentHash)` returns the entry *only* if that hash matches the current bytes. The actionable-warnings turn_end read passes the hash of the on-disk file, so a previous turn's diagnostics are never reused as current — on mismatch (or an entry written without content, e.g. the service-level merge, which clears the hash) it falls through to a fresh open+wait. Any NEW hot-path consumer that reuses last-known diagnostics as authoritative MUST pass the content hash; omit it only for display (the widget). `lspSource:"cache"` in `actionable-warnings.log` now means *verified-current reuse*, not "maybe stale".
- **Same-file diagnostic reconciliation is admission-ordered (#1198).** The shared widget write guard orders per-edit dispatch, `lsp_diagnostics`, and `lens_diagnostics mode=full` by a token reserved when each per-file operation is admitted, never when its async LSP promise settles. `recordRunner` and final diagnostic replacement advance the same per-file order so a late older runner cannot restore `(pending)` after a newer confirmed-clean result. Confirmed results with a demonstrable content-binding mismatch are excluded; unavailable/inconclusive/error results never count as clean. The full-scan fallback verifies legacy hash-only results with sequential `fs.promises.readFile` plus periodic event-loop yields, while trusting the LSP/cache seam's existing `true`/`false` verdicts; unreadable files remain unknown. Direct `lsp_diagnostics` intentionally remains a shared-state reconciliation path for affirmative results, using the content read and binding verdict from its collecting touch without a second reconciliation read; mode=all stays cache-only/display-only.
- **LSP-owned mutation observability (#1066 × #1062).** `clients/lsp-mutation.ts` is the single bookkeeping/terminal-summary seam for solicited `workspace/applyEdit`, `lsp_navigation apply:true`, and actionable-warning LSP quickfixes. It reuses `read-guard.log` correlation IDs and bounded `editBatchSummary` samples, records only actually-applied files into read-guard/project sequence/change-log/turn-state, and leaves agent-owned navigation edits off the autonomous bus. `applyWorkspaceEdit` supplies already-computed ranges/content facts; do not add synchronous whole-file re-reads or a second mutation pipeline. Concurrent solicited commands intentionally avoid cross-correlating when the parent request cannot be identified.
- **Diagnostic-wait model — affirmative-clean, never silence (#240, closed).** `clientWaitForDiagnostics` branches on `workspaceDiagnosticsSupport.mode` (cached at initialize). **Pull** (json/css/html/rust/svelte/ruby/csharp): `clientRequestPullDiagnostics` returns a discriminated `PullDiagnosticsOutcome` (`found|clean|unavailable`) and early-returns ONLY on found/clean — an `unavailable` pull (dead/null/threw) is never read as clean (closed the `minVersion===undefined` hole). **Push**: the `publishDiagnostics` handler bumps version + emits even for EMPTY publishes — versioned or NOT — so ANY publish on a clean scan early-returns the wait: a Tier-2 server (versioned empty re-publish: ast-grep) early-returns affirmatively + currency-proven, a Tier-2\* server (version-less re-publish: opengrep — accepted as fresh because it can't be proven stale, currency only temporally correlated) early-returns too; only a Tier-3 SILENT server (classic typescript-language-server or Marksman) is budget-bound by necessity. Per-edit caps: `maxDiagnosticsWaitMs=2500` (`LSP_DIAGNOSTICS_WAIT_MS`), spawn `5000` — NOT the 10s/15s figures (those are nav-request / fallback / handshake ceilings). **with-auxiliary gotcha:** the collection deadline is `max(callerCap, maxStrategyWait)` (a FLOOR over a single Promise.all), unlike primary scope's `min` (a ceiling) — so a silent primary holds the whole touch, and a slow aux's `aggregateWaitMs` can override the per-edit cap (opengrep was 6000 → capped to 3500; ast-grep's true latency is ~915ms, the bench's 20s was this confound). Per-server deadlines shipped (**#242**); remaining silent-server cost tracked in **#458** (target set = tier-3 rows only). **Confirmation-carriage invariant:** when `touchFile` turns a completed tier-3 wait into affirmative clean (Marksman's successful-notify `silentOnClean` gate, or TypeScript's sync fallback), it sets `TouchFileResult.confirmation: "confirmed"`; `lsp_diagnostics` must actively use `touchFile` for every local scope so that field is not bypassed by the legacy `openFile`/`getDiagnostics` path. A primary-scope confirmation is authoritative because `touchFile` ran that primary's own fallback; non-TypeScript all-scope confirmation is likewise consumable, but all-scope classic TypeScript MUST still run `resolveEmptyResult`'s synchronous tsserver fallback before declaring clean because the aggregate silent gate does not run the primary-only sync request. Absence stays unconfirmed for tier-3 servers, and `inconclusive`/binding mismatch always wins. Never infer confirmation from `diags.length === 0` alone. **Two carriage rules the gates depend on (#1253):** the recent-touches debounce entry (`markTouched`) is recorded ONLY when every spawned server's notify write landed — recording a timed-out/rejected write lets the next touch skip the notify, clear `notifyWriteTimedOut`, and hand a `silentOnClean` server that never saw the file a confirmed-clean verdict; and the warm-attach IPC response carries `confirmation` as an explicit enumerable DTO field, since `fresh && !inconclusive` is not the same evidence and an incumbent-served empty result would otherwise be indistinguishable from "never answered". The incumbent always touches `with-auxiliary`, so its confirmation is AGGREGATE — classic TypeScript still needs the primary-only sync check.
- **`runWorkspaceDiagnostics`/`lsp_diagnostics` result caching (#671/#672).** Both the `lens_diagnostics mode=full` engine (`LSPService.runWorkspaceDiagnostics`) and `tools/lsp-diagnostics.ts`'s batch/directory sweep used to re-touch EVERY file on EVERY call, even with zero edits since the prior identical sweep — measured at 128s wall-clock on a real 156-file project. `clients/lsp/workspace-diagnostics-cache.ts` now persists per-file results shared across both call sites (`scopeKey`-gated so the two tools' different server coverage — e.g. the workspace sweep excludes opengrep, `lsp_diagnostics` doesn't — never cross-serves a wrong result). Invalidation is TWO-layer, not just mtime: (1) the file's own mtime, and (2) when a persisted reverse-dependency index exists (`clients/reverse-deps.ts`, reused from the review graph, never rebuilt for this purpose), every import's mtime too — closing the cross-file blind spot where a dependency's signature change alters a file's diagnostics with zero edits to that file itself (a blind spot the OLDER `project-diagnostics/cache.ts` cheap-tier cache still has, judged tolerable there since those runners are single-file-syntactic, not cross-file). Falls back to mtime-only when no reverse-deps index is available. Never persists an `inconclusive`/timed-out touch as cacheable — same false-clean discipline as #240.
- **Explicit `lsp_diagnostics` batches (#837) preserve input order and never walk the project.** Runtime validation rejects more than 100 entries rather than truncating them; normalized entries are processed with one in-flight file per primary server group, a bounded per-file deadline, and abort-aware completion. Results expose per-file `clean`/`findings`/`unsupported`/`unavailable`/`failed`/`inconclusive` outcomes and aggregate counts; incomplete batches are rendered as unconfirmed. Primary-language diagnostics and auxiliary findings remain separate. The shared workspace cache is reused only when its scope key and freshness checks match, including own-file and available reverse-dependency mtimes.
- **`ensureWarmForSweep`'s warm-up budget is a FLOOR for the warm-up call only, never a ceiling (#667/#669/#670/#832).** `touchFile`'s `perServerTimeout` normally treats a caller's cap as a CEILING on the server's own steady-state `aggregateWaitMs` (`Math.min` — correct for per-edit dispatch, #242, so a slow strategy can't blow the pipeline's budget). `ensureWarmForSweep`'s cold-server warm-up needs the OPPOSITE: more time than the steady-state budget, precisely because the server hasn't finished its cold launch yet. Reusing the ceiling-only cap silently collapsed the warm-up's requested 20s down to e.g. typescript's 1000ms `aggregateWaitMs`, defeating the feature — confirmed live (`lsp_sweep_warmup_start timeoutMs:20000` immediately followed by a `1000`ms timeout). Fix: `LSPTouchFileOptions.warmupOverride`, set ONLY by `ensureWarmForSweep`'s own `touchFile` call, flips `perServerTimeout` to `Math.max(callerCap, strategyWait)` (a floor) for that one call — except for a workspace-indexing server whose live capability classification is push-only/silent-on-clean; that server uses its configured strategy wait. Every other caller is unaffected.
- **JSON cache-file reading is consolidated (#676/#677).** `readJsonCache`/`readJsonCacheAsync` (`clients/json-cache-read.ts`) extract the "parse JSON, try/catch, return `undefined` on any failure" boilerplate that 7 sites (`project-diagnostics/cache.ts`, `workspace-diagnostics-cache.ts`, `cache-manager.ts` ×3, `cache/rule-cache.ts`, `project-snapshot.ts`, `session-state-store.ts`) each hand-duplicated. Each site's own validation logic (version checks, `rule-cache.ts`'s extra `ruleHash` field, etc.) stays as its `validate` callback — this is boilerplate dedup only, never a behavior unification. New JSON-cache readers should use this rather than hand-rolling the try/catch again.
- **Config-file discovery is consolidated (#680/#683).** `findLocalToolConfig(startDir, names)` (`clients/path-utils.ts`, alongside `walkUpDirs`/`findNearestContaining`/`findNearestMarkerRoot`) is the single "walk up looking for one of these filenames" loop for `opengrep-config.ts`/`typos-config.ts`/`zizmor-config.ts`/`sgconfig.ts`, previously hand-duplicated identically in all four. Deliberately does NOT cover `tool-policy.ts`'s `has*Config` family (boolean return, tool-specific content-sniffing) or `project-lens-config.ts`'s `discoverPiLensProjectConfig` (adds mtime caching) — different shapes, out of scope.
- **LSP capability inventory.** `lspService.getCapabilitySnapshots(filePath?)` returns per-client `operationSupport` (12 nav/edit ops) + `workspaceDiagnosticsSupport` + `advertisedCommands` (executeCommand allowlist) + `rawCapabilityKeys` (sorted top-level ServerCapabilities keys, captured once at initialize — the full advertised surface). Nested request capabilities extend this same snapshot: `codeActionResolve` is true only for an object `codeActionProvider` with `resolveProvider === true`, and `willRenameFiles` requires object-valued `workspace.fileOperations.willRename` registration options with a `filters` array. Absent, boolean, and malformed values fail closed. `CLIENT_CAPABILITIES` advertises `workspace.fileOperations.willRename`/`didRename` plus code-action `dataSupport` and resolve support for `edit`/`command`; the real protocol fixture withholds server support if those client declarations disappear. The LSPService and LSPClient chokepoints both gate these requests, and the parsed registration FILTERS are matched at the client send boundary for both `willRenameFiles` requests and `didRenameFiles` notifications: scheme, glob pattern, and ignore-case must express interest in the renamed paths or the send is skipped like an unadvertised capability (`matches: "folder"` filters stay deferred to #2049, since folder-rename matching needs a directory probe). Unsupported rename contributors are skipped while supporting clients still contribute edits. Skips use the bounded `lsp-capability-skip` degradation record, not repeated raw errors. Three scripts (need `build:dist`, reuse `smoke-tools.mjs` fixtures): `server-capabilities.mjs`→`docs/servercapabilities.md` (mode+ws-pull+ops+raw caps), `characterize-lsp.mjs`→`docs/lsp-capability-matrix.md` `mode` column (content-independent, so fixtures reuse the dirty `bad.*` files), `probe-clean-signal.mjs`→same matrix `clean-behavior` column (#460, phase-aware 4-way). The probe attributes publishes per phase (dirty touch = liveness proof; clean transitions = discriminator) and classifies: `publishes-versioned` → tier 2 (ast-grep — affirmative + currency-proven); `publishes-unversioned` → tier 2\* (opengrep, yaml — a version-less publish STILL early-returns the wait at runtime since the client accepts it as fresh; currency only temporally correlated — staleness-risk note, not latency); `silent` → tier 3 (alive on dirty, silent on clean — the budget-wait case, #458's target set); no publish at all → `unknown` (conservative). Clean fixtures are authoritative: typescript re-publishes while DIRTY (2\* on the dirty fixture) but goes silent on a genuinely CLEAN file (`typescript-clean` → tier 3, the production case) — the probe prefers `clean: true` fixtures for a lang's row, and dirty-fixture 2\* rows carry an overstatement caveat. Nightly tool-smoke runs **all three** (`--install`), each **merging** into its doc keyed by lang/server (a server the ubuntu host can't spawn keeps its prior dev-box row — never regresses), then opens/updates one auto-PR `bot/lsp-docs-refresh` via `peter-evans/create-pull-request` with the regenerated docs (#390 — the old "characterize self-populates the matrix" was false: CI generated then discarded). `probe-clean-signal.mjs` also runs a **`silentOnClean` drift check (#529)**: it compares each probed server's observed `clean-behavior` against the hand-set `silentOnClean` marker in `clients/lsp/wait-policy/strategies.ts` (today set only for classic `typescript`) and logs/writes any mismatch (`marked-not-silent` = marker too pessimistic; `silent-not-marked` = an unmarked server is actually silent, burning the full in-lane wait) to a `## silentOnClean drift` footnote in the matrix doc — telemetry only, **never a CI gate** (a timing-based negative observation can't safely gate a build); `unknown` observations are never treated as drift evidence in either direction. The native TS7 launch variant (`typescript7`/`typescript7-clean`, #524/#526) is excluded from the comparison — it shares the "typescript" server id with classic but the marker is documented classic-only. Pure helpers `scripts/lib/clean-signal.mjs` (classifier + `checkCleanSignalDrift`/`findCleanSignalDrift`) + `scripts/lib/md-matrix.mjs` (table merge) are unit-tested (`tests/scripts/clean-signal.test.ts`). Docs are gitignored-with-negation (tracked). **A real drift finding is also actionable, not just logged (#594):** `probe-clean-signal.mjs` writes `driftWarnings` as a small JSON summary (`scripts/lib/clean-signal.mjs`'s `DRIFT_SUMMARY_PATH`, a fixed same-job runner-tmpdir path, never committed), and a follow-on nightly step, `scripts/notify-clean-signal-drift.mjs`, reads it and files-or-updates a SINGLE persistent GitHub issue (fixed `nightly-drift` label + fixed title, found by title match — never a new issue per night) when `count > 0`, or closes a prior open one when the drift has resolved. Still telemetry only — the step is `continue-on-error: true` and the script itself never exits nonzero (mirrors the probe's own contract); it reuses the job's existing `GITHUB_TOKEN` via `gh`, no new auth plumbing. Pure body/lookup helpers live in `scripts/lib/drift-issue.mjs` (unit-tested, `tests/scripts/drift-issue.test.ts`) — the `gh` shell-outs themselves are untested, same pattern as `scripts/backfill-github-releases.mjs`.

## Session-start critical path

`lsp-config` is deferred via `setImmediate` (not awaited). Startup background task bodies are deferred via `setImmediate` so sync scans cannot inflate the interactive path; logs report both queued and run time. The first-session quick-mode warmup uses the **async** startup-scan path, which must enforce the same home-ceiling guard as the sync path (`isAtOrAboveHomeDir` for cwd/projectRoot) before language-profile warming — otherwise an empty folder under a home/ancestor marker can kick off a background home-tree walk and cause typing lag (#296). The LSP dominant-language auto-warm has the same invariant: only run it when `startupScan.canWarmCaches` is true and use the guarded `analysisRoot`, not raw `cwd`. Tool availability probes use the probe cache before spawning binaries. Interactive path target: ~150ms on warm runs.

### Project trust is CONSUMED, never answered (#1334 S5)

pi's trust surface is two-sided and the sides are not interchangeable. An
extension may *answer* the question by registering `pi.on("project_trust", …)`
(returning `{ trusted: "yes" | "no" | "undecided" }`); every other extension
*consumes* the outcome via `ExtensionContext.isProjectTrusted(): boolean`.
**pi-lens is a consumer — never register the handler.** Answering on the user's
behalf would defeat the host's own prompt.

`clients/project-trust.ts` is the single latched process-wide state
(`trusted` / `untrusted` / `unknown`), refreshed from `ctx` on every
`session_start` and `turn_start` (fork/reload/resume can change cwd, and a
mid-session grant/deny converges by the next turn). Note the asymmetry: the
*event* decision is three-valued but the
*ctx* accessor is a boolean, so the only distinctions available are "host said
yes", "host said no", and "host has no trust surface at all".

The centralized `assertInstallAllowed(context)` gate covers every operation
that can install or materialize executable content: managed installs,
formatter gem/rustup installs and npx fallbacks, runner lazy installers,
govulncheck's `go install`, and tree-sitter's pinned-CDN lazy grammar fetch.
Grammar WASM is executed content, so under denial an absent grammar follows the
existing unavailable + user-notification path instead of being fetched. The
separate LSP predicate gates child execution.

`ensureTool()` (`clients/installer/index.ts` — degrades to the existing
`allowInstall:false` discovery-only path, so an already-present binary keeps
working while nothing is downloaded or executed) and `LSPService.spawnClient`
(`clients/lsp/index.ts` — refuses the child spawn, without marking the key
broken: trust is policy, not server failure). Everything in-process
(tree-sitter, caches, diagnostics replay) is untouched. **Fail-open is
deliberate for `unknown` only** — a host that never exposed the accessor never
had a decision to honor, and gating it would break every older pi. When adding
a new outbound capability (a new spawn seam, a new downloader), gate it on
`isLspSpawnAllowedByTrust()` / `isToolInstallAllowedByTrust()` too.

Accessor failure is deliberately fail-closed: if `isProjectTrusted` exists but
throws, the host attempted to provide a decision and pi-lens cannot prove the
project trusted. Only an absent API is the older-host `unknown`/fail-open case.
New installation/materialization sites call `assertInstallAllowed(context)`;
do not add more direct consumers of the raw install predicate.

## Subagent-extension compatibility (#476)

pi-lens degrades gracefully — by construction — when it runs alongside
subagent-spawning extensions: subagent light mode (#475) skips heavyweight
scans in a spawned child, the instance registry + orphan reaper (#474)
cleans up LSP processes left behind by a dead parent, and the
concurrent-session guard (#473, `clients/session-lifecycle.ts`) stops an
in-process subagent bind from tearing down the parent's live LSP fleet.
**Reaping is split by CONSEQUENCE — staleness cleans records, never kills
(#525).** `decideOrphanReaping` (`clients/instance-reaper.ts`) uses two named
predicates whose asymmetry is load-bearing: `isInstanceKillEligible`
(pid-confirmed-dead ONLY — the only path to `childrenToKill`/
`markerSearches`) and `isInstanceEntryStale` (`heartbeatAt` older than
`STALE_HEARTBEAT_MS`, 6h — drops the ENTRY from `instances.json` via
`staleInstances`, kills nothing, and the instance's children stay
marker-protected). Why staleness must never kill: heartbeats fire only at
turn end (`runtime-turn.ts`) and run settle (`quiet-window.ts`) — no timer
exists — so a pi session left open but unused overnight legitimately goes
>6h stale while genuinely ALIVE with a warm LSP fleet; `matchProcess`
identity verification would not save that fleet (the children really are
that instance's servers — the matcher guards against pid reuse, not against
misclassifying a live parent). Why staleness must still drop entries:
pid-liveness alone is unsound once a long-dead parent's pid gets recycled
onto an unrelated live process (Windows recycles far more aggressively than
POSIX; a real dogfooded fixture entry survived 13h stale because of exactly
this), and the parent pid has no identity to verify against —
`InstanceEntry` never recorded the parent's own command line. Marker
protection (`collectLiveMarkers`) is keyed on pid-liveness alone —
conservative on the destructive side, matching the kill predicate. The same
`clients/instance-reaper.ts` seam owns `sweepAtomicWriteStages()` (#1228),
invoked fire-and-forget from `session_start` for project-data and global state
roots. It inspects a bounded number of regular files whose names match only
atomic-write `.tmp-<pid>`, `.tmp-<pid>-<seq>`, or
`.tmp-<pid>-<thread>-<seq>` shapes; `process.pid` and every liveness-positive
foreign pid are preserved. It uses no watcher or keep-alive handle.
`isSubagentSession()` (`clients/subagent-mode.ts`) detects TWO env
vocabularies: nicobailon/pi-subagents' `PI_SUBAGENT_CHILD=1`, and
avtc-pi-subagent's `PI_SUBAGENT_CHILD_AGENT` + `PI_SUBAGENT_PARENT_PID` pair
(both non-empty — requiring the pair, not either var alone, guards against a
false positive from an unrelated tool; #507). `getSubagentIdentity()` reports
which vocabulary matched (`marker: "pi-subagents" | "avtc-pi-subagent"`),
plus the best-effort run ID, agent name, and validated positive parent PID.
`registerInstance()` persists that identity under optional `InstanceEntry.subagent`
(`agentName` becomes the registry-facing `agentType`) for concurrency-profile
analysis (#822); primary sessions omit the field entirely, and loose registry
reads preserve compatibility with entries written before it existed. The
identity is also surfaced in the `subagent_light_mode` latency phase. All of this was built on
reverse-engineered facts about those extensions and the pi SDK — nobody has
promised us these stay true across releases. `docs/subagent-compat.md`
records the exact pinned contracts (file + version last verified) and is
checked nightly by `.github/workflows/compat-smoke.yml`
(`scripts/compat-contracts.mjs` — pattern-match the installed third-party
source; `scripts/compat-smoke-behavioral.mjs` — drive a real `pi --mode rpc`
and assert through the latency log, no LLM turn needed; avtc-pi-subagent
Layer A/B coverage is a deferred follow-up, not yet wired). A nightly failure
opens/refreshes a single tracking issue — never reds the workflow itself.
Three env levers govern the behavior: `PI_LENS_SUBAGENT_FULL=1` (force full,
non-light behavior in a detected subagent child, either vocabulary),
`PI_LENS_CONCURRENT_SESSION_GUARD=0`
(disable the #473 guard — every session_start classifies sequential), and
`PI_LENS_INSTANCE_REGISTRY=0` (disable the #474 registry/reaper).

## Runner process model

Test-runner failed-first state is path-canonical at both the project-root and target boundaries while retaining the caller's path spelling for execution. It retains the globally newest 32 targets per runner and validates at most 8 candidates per selection. A probe retires state only on `ENOENT`/`ENOTDIR`; permission and transient errors retain the target. Remaining unchecked candidates carry into the next turn. Missing, indeterminate, and capacity-eviction outcomes use the bounded `test_runner_failed_target_state` telemetry phase, with exact ledger counts and at most eight detailed rows per originating turn. Per-turn telemetry counters retain 64 interleavable turn buckets; a result older than that bounded window fails closed rather than reopening its budget. (#2044)

Expected runner skips must stay distinct from clean success and runner failure.
Return a bounded machine-readable `skipReason` on `RunnerResult` and carry it
through the existing runner latency record. Do not emit an extension error for
an expected policy skip; reserve failure classification and degradation records
for a tool that did not run or did not produce a usable result. Extend the
closed `RUNNER_SKIP_REASONS` taxonomy when adding a new expected-skip reason;
the dispatcher rejects unknown runtime values from latency metadata. Oxlint's
no-files classification is one fail-closed state machine: process-control
evidence wins first (spawn/timeout/killed/signal use #1994's runner-empty lane;
truncation is unconfirmed), and only a normal exit 1 with empty stderr, the
exact captured banner, and exactly the captured JSON fields may produce
`no-files-matched`. Every field is schema-checked (`diagnostics` array;
nonnegative integer file/rule counts; positive integer threads; finite
nonnegative start time), diagnostics must be empty, and the file count must be
zero. A no-files lookalike on any other status/banner/stderr/JSON/schema/count
combination is never clean: nonzero runs retain shared parsed-nothing telemetry,
while status 0 becomes an explicit `unconfirmed_output` failure. Reports with no
no-files evidence continue through the ordinary parser.

Observed-slow CLI runners use the shared `clients/dispatch/collect-later-tier.ts`
classification seam. A timeout or latency above its threshold moves that
runner and project off the post-write path on the next edit; the runner still
executes and its findings drain through `clients/runtime-turn.ts` at turn end.
Only a fast completed run re-arms the inline tier, and
`resetObservedRunnerLatency` plus `resetPendingRunnerFindings` clear this
session-scoped state at `session_start`. Keep tier flips and repeated slow
observations bounded through the latency logger and degradation ledger.

- **Use `safeSpawnAsync()` for all subprocess work** in hook/dispatch/install paths. The sync `safeSpawn()` is deprecated, blocks the Node event loop, and is now reachable only from the cached `TestRunnerClient.detectRunner` `which pytest` probe. Don't add new sync `safeSpawn` callers.
- **Streaming output matches in `safeSpawnAsync()`** use `matchWhileStreaming` for bounded rescue detection before and after output-cap retention. While the matcher is armed and unmatched, the cap discards output beyond the retention budget but defers the cap kill; the caller's own timeout is the time bound. Once the matcher matches, or when no matcher is armed, the existing kill-on-cap behavior applies. This keeps memory bounded but makes the wait time-unbounded within the spawn seam, so every such caller must provide its own timeout. Carry the last `pattern.length - 1` bytes across chunks so a split match remains detectable, and preserve `streamingMatch` on error results.
- **The hot per-edit path is the dispatch runners** (`clients/dispatch/runners/*`), not the legacy per-tool client classes (`biome-client`, `ruff-client`, `rust-client`, `ast-grep-client`, …). Those classes historically carried a *parallel sync surface* (`checkFile`/`fixFile`/`isAvailable`/`findCargoPath`/…) that the async runners superseded; #197 found almost all of it **dead** and deleted ~1600 lines. **Lesson: when you find a sync client method, grep its real callers before "converting" it — the answer is usually "delete," and the live path already has an `*Async` twin** (`fixFileAsync`, `ensureAvailable`, `runTestFileAsync`, `tempScanAsync`, `findGoPathAsync`).
- **Ambient turn abort signal (#197):** `safeSpawnAsync` defaults its `AbortSignal` to a module-level ambient signal (`setAmbientAbortSignal` in `clients/safe-spawn.ts`). The lifecycle handlers (`tool_result`, `agent_end`, `turn_end`) publish pi's `ctx.signal` at entry and clear it in `finally`, so an Esc/interrupt kills in-flight linter/format/type-check children (process-tree kill on Windows) without threading a signal through every call site. The signal is captured at spawn time, so clearing it only affects future spawns. Pass `ignoreAmbientSignal: true` for **installs** (gem/go/dotnet/rustup) so they run to completion even if the turn is interrupted — matching the old uncancellable sync behaviour; an explicit `options.signal` always wins.
- Expensive project scans have in-flight guards: Knip by project root, jscpd by project root + scan params, Madge by project root/file or project root scan.
- Check cheap filesystem/root preconditions before availability probes or auto-install. Example: Knip/jscpd/Madge skip non-project or empty roots before probing/installing tools.
- `createAvailabilityChecker()` is **async-only** — returns `{ isAvailableAsync, getCommand }` (cached per-cwd, in-flight-deduped). Its positives revalidate command reachability on reuse, and its negatives, `createCwdCachedProbe`, and the shared ast-grep memo are session-scoped through `resetDispatchAvailabilityState`; do not add parallel per-client discovery caches (#1203/#1290). The sync `isAvailable()` and its `?? x.isAvailable(cwd)` runner fallbacks were removed (#197); runners call `await x.isAvailableAsync(cwd)`. Per-client availability/path probes follow the same `*Async` convention (`RustClient.findCargoPathAsync`/`isAvailableAsync`, `GoClient.findGoPathAsync`/`isGoAvailableAsync`, `TypeCoverageClient.isAvailableAsync`/`scanAsync`, `SgRunner.tempScanAsync`/`exec`, ast-grep `ensureAvailable`).
- Formatter execution and lazy installs (`clients/formatters.ts`) and the LSP runtime installs (`clients/lsp/server.ts` `tryGoInstallGopls`/`tryDotnetToolInstall`/`tryGemInstall`) all use `safeSpawnAsync`. **Windows note:** prefer `safeSpawnAsync` over raw `spawnSync(…, {shell:false})` for tool launches — `gem`/`dotnet`/`biome` are often `.cmd` shims that only run under shell mode (which `safeSpawnAsync` uses), and it also gives UTF-8 (`chcp 65001`) + `taskkill /F /T` tree-kill. Bare command resolution uses the exact case-insensitive child `PATH`/`PATHEXT` environment (including caller-managed bins such as Knip's), with canonical effective child cwd, relative PATH interpretation, PATHEXT presence, and `=X:` per-drive provenance included in the bounded resolver cache identity; explicit/relative paths use `path.win32`. Drive-relative commands/PATH/cwd forms use same-drive semantics or a validated absolute `=X:` entry and otherwise fail closed rather than guess a drive root or search unrelated PATH entries; the canonical absolute cwd used for resolution is also passed to the child. Positive cache hits re-stat the executable, negative hits expire after 1s, and successful managed installs reset the cache immediately. The host SDK's `pi.exec` is **not** a substitute (no Windows UTF-8/tree-kill/batch/`which`).
- **Node package manager: never hardcode `npm`/`npx`** — `clients/package-manager.ts` (#374) is the single source of truth. `resolveNodePackageManager(cwd)` picks npm/pnpm/yarn/bun (lockfile / corepack field if installed, else first installed by preference, else npm); the builders spell each command: `pmBinary` (`.cmd`/`.exe` on Windows), `runScriptArgs`, `installArgs`, `globalInstallArgs`, `execArgs`, `allAvailableGlobalBinDirs`. **Caveat (see #375):** `execArgs` maps non-npm managers to `pnpm dlx`/`yarn dlx`/`bun x`, which *fetch-if-missing* — unlike npm's cache-only `npx --no`. The `npx --no` sites that still exist (dispatch runners, formatters — `resolveLocalFirstAsync`, `sg-runner`, etc.) must NOT be blindly converted to `dlx`: pi-lens's invariant is no silent tool downloads. Resolve that policy before routing them through `execArgs`.
- **LSP singleton generations hand off teardown before spawn (#850).** `resetLSPService()` remains synchronous/void and clears the published singleton immediately, but a replacement `LSPService` receives a one-shot promise for ALL still-retiring generations and `ensureClientForServer` waits it before root/spawn. Repeated reset must mark an intermediate waiting service destroyed synchronously; after every async pre-spawn gap (`server.root()`, dead-client shutdown), re-check `isDestroyed` before registering `state.inFlight`. Clear the per-service handoff after its first completed wait so direct `new LSPService()` callers and ordinary within-generation warm reuse never pay a permanent promise/microtask tax. Do not replace this with dead-parent reaping (#472/#474) or cross-process warm attach (#822): #850 is specifically same-process, live-parent generation ownership.
- Session replacement, session shutdown, and pipeline crash recovery use fast LSP teardown (`resetLSPService({ fast: true })` / `client.shutdown({ fast: true })`) to skip protocol handshakes and unref process/timer handles. On POSIX, LSP servers are spawned detached into their own process group and teardown signals the group (`process.kill(-pid, ...)`) before falling back to the direct child; this is intentional so shell/node wrapper descendants (notably HTML LSP launches from long-lived zellij sessions) do not survive as orphan process trees. On Windows, keep using `taskkill /T` for mid-session shutdown and handle-only kill for `processExiting`.
- **Late-auxiliary re-arm TTL is env-tunable with decoupled clocks (#2001).** `clients/lsp/pending-aux-coverage.ts`'s collect-later store keeps each (filePath, serverId) pair until `readLateAuxRearmTtlMs()` after its LAST successful turn-end probe — overridable via `PI_LENS_LATE_AUX_REARM_TTL_MS` (read at call time like `PI_LENS_AUX_GRACE_MS`; absent/non-numeric/negative falls back to the 5-minute default), so a demonstrably alive-but-slow scanner extends its own window instead of being retired by a TTL measured from the original mark. The clocks are deliberately SEPARATE: `lastRearmedAtMs` anchors the TTL, while `markedAtMs` stays the immutable freshness baseline the delivery gate stats against — advancing the baseline on re-arm would let an unobserved external edit's stale cached findings read as live. A producer re-mark (a newer touch) resets BOTH: new baseline, TTL restarts from the mark.
- Long-lived debounce timers should call `.unref()` where safe (probe-cache flush, metrics-history save, LSP idle reset) so teardown/short-lived runs are not held open just for best-effort background writes.

## Read-guard autopatch pipeline

Runs in the `tool_call` handler (`handleToolCall`, `clients/runtime-tool-call.ts`) before the edit tool executes. Mutates `e.oldText` in-place and logs a structured event for each correction applied.

| Pass | What it fixes | Event logged |
| ------ | -------------- | -------------- |
| 0 | Literal `\n`/`\t` escape sequences vs actual newline/tab in `oldText` | `oldtext_escape_autopatched` |
| 1 | Trailing whitespace per line **and** trailing empty lines (e.g. model appends `\n\t\t\t\t` from the next line's indent) | `oldtext_trailing_ws_autopatched` |
| 2a | Fixed tab↔space conversions (tabs→2sp, tabs→4sp, 2sp→tabs, 4sp→tabs) | `oldtext_indent_autopatched` |
| 2b | `findIndentationInsensitiveCandidate` — strips all leading whitespace, matches on content only, returns actual file lines; handles arbitrary indentation depth mismatches | `oldtext_indent_autopatched` |

**Safety gates (all must hold for a patch to apply):**

- Stripped/corrected form differs from the original
- `countOldTextMatches === 1` on the corrected form (no ambiguity)
- Pass 2: `isIndentationOnlyChange === true` (every line's `.trim()` content is identical) and `currentMatchCount === 0` (original doesn't already match)

**Known gaps (fix when seen in logs):** internal whitespace differences (e.g. `foo  =  bar` vs `foo = bar`) and missing/extra blank lines within a block are not handled. Add a new pass if either pattern appears as repeated `oldtext_not_found` events.

**`out_of_range` downgrade:** when all `oldText` strings in an edit were resolved (content-match proof, flagged as `oldTextResolved`), an out-of-range verdict is downgraded from `block` to `warn`. Line drift from earlier inserts is the common cause; the model demonstrably knew the content.

**Repeat-failure escalation:** `REPEAT_FAILURE_TTL_MS` is 300 s (inter-turn delays routinely exceed 30 s). At ≥ 2 failures within that window the preflight error header escalates from `🔄 RETRYABLE` to `🛑 RE-READ REQUIRED`.

## Read-guard: non-Read sources of "the agent saw / authored this"

The guard tracks more than the Read/Write/Edit tools. All of these register so a follow-up edit isn't falsely blocked:

- **bash file VIEWS** (`clients/bash-file-access.ts` → `extractReadPathsFromCommand`): `cat`/`less`/`more`/`bat`/`nl` (full file), `head -N`/`tail -N` (the shown N lines), `sed -n 'A,Bp'` (lines A–B). Registered at tool_call via `recordRead` with the **exact line range** (the guard enforces ranges). `ls`/`find` are NOT views (name-only, reveal no editable content) — never registered, and registering them would falsely mark a file "read". `grep` is not a contiguous view but IS registered via the search path below.
- **bash WRITES** (`extractWrittenPathsFromCommand`): `>`/`>>`/`N>`, `tee`, `sed -i`, `cp`/`mv` dest, `touch`. The agent authored the file, so — exactly like the Write tool — `noteCreatedFile` at tool_call + `recordWritten` at tool_result.
- **search tools** (`clients/search-read-registration.ts` → `registerSearchReads`, ±2-line context margin): a tool exposes the lines it revealed via `details.searchReads: {file, startLine(1-based), endLine}[]`; `handleToolResult` consumes that for **any** tool and registers reads of only those lines (never the whole file). Populated by `ast_grep_search` (#169, done) and bash `grep -n`/`egrep`/`fgrep` (output parsed via `extractGrepSearchReadsFromOutput`). `ast_grep_search` also returns `details.matchLocations[]` with ready `readSlice` handles; keep those handles in sync with any formatter changes. `lsp_navigation` already populates `searchReads` for the location-revealing operations (definition/typeDefinition/declaration/references/implementation/workspaceSymbol/incoming+outgoingCalls via `collectSearchReadsForOperation`); `documentSymbol` deliberately does NOT (shape, not body — same rule as `module_report`). **Still remaining:** the pi built-in `grep`/`glob` tool (reveals an editable span — wire it for parity; `ls`/`glob`/`find` stay excluded as name-only). New producers only need to populate `details.searchReads` — no hook change.

**PATH-KEY INVARIANT (hard-won — #210):** `ReadGuard` keys its `reads`/`edits`/`exemptions`/`pendingCreations`/`writtenThisSession` maps through `normalizeFilePath` (private `key()`), never the raw path. Read sources arrive with mixed separators/casing — the Read tool gives OS-native backslashes on Windows; search/LSP reads arrive slash-normalized from URIs — and `resolveToolCallFilePath` returns absolute paths verbatim. Keying on the raw string made a read recorded under one form invisible to an edit checked under another → false `zero_read` block despite the file having been read. **Any new map access MUST key through `key()`, and any new read-guard test MUST exercise cross-separator paths** (record one form, check the other) — same-form-on-both-sides is exactly what let #210 ship. Guarded by `tests/clients/read-guard-path-normalization.test.ts`.

## Dependencies & install constraints (hard-won — see #167-area fixes)

pi installs git extensions with **`npm install --omit=dev`** (and omits peers). Consequences that MUST be respected:

- **Runtime imports must live in `dependencies`, never `devDependencies`.** A runtime import of a dev-only package fails to load at user sites (`Cannot find package …`). Example bug: `js-yaml` was dev-only but imported at runtime.
- **The host SDK `@earendil-works/pi-coding-agent` must be imported TYPE-ONLY.** It is not present at runtime under `--omit=dev`, and pulling it in (as a runtime import or non-optional dep) drags a huge tree (`@mistralai/…`) with paths exceeding Windows `MAX_PATH`, which breaks `git clean -fdx` on `pi update`. Runtime helper needed from it → inline it (see `clients/tool-event.ts` for `isToolCallEventType`). It stays as an **optional peer + devDep** for types only.
- **The type-only rule is now ENFORCED, not just documented (#1334 S6).** `tests/host-sdk-type-only.test.ts` scans every shipped source file and fails on any value import (static, dynamic, or `require`) of `@earendil-works/pi-coding-agent`, and asserts the package stays out of `dependencies`. This is what makes the SDK's runtime helpers off-limits: `isToolCallEventType` and the seven `is*ToolResult` discriminators are *runtime functions*, so they can only ever be **inlined** (`clients/tool-event.ts`), never imported. Their `details`/input **types** are a different story — those are type-only exports and SHOULD be adopted rather than re-declared ad hoc (`EditToolInput`, `EditToolDetails`). Before reaching for a host discriminator, read the S6 audit block at the top of `clients/tool-event.ts`: the seven cover strictly fewer tools than pi-lens intercepts (no `lsp_navigation`, no pi-lens-registered tools), and narrowing to the host's `ToolResultEvent` union would drop the `provider`/`model`/`sessionId` fields pi-lens's telemetry-identity path reads off the live event.
- **`package-lock.json` IS committed and must stay in sync** with `package.json`. `npm run check:lockfile` (CI and the Husky pre-commit hook) fails on identity, package-descriptor metadata (`license`, normalized `bin`, `engines`, `os`, `cpu`, `libc`, `funding`, and bundled dependencies), dependency specs, and peer optionality. Regenerate with npm >=11.11: older npm omits `libc`, causing both glibc and musl optional binaries to install (npm/cli#9025). The production-install job pins npm 11.17.0 and fails when `npm install --omit=dev` changes any tracked source file. The changelog release preflight reuses the same validator before mutating release state. CI/release use `npm install` (not `npm ci`) so a desync self-heals instead of wiping `node_modules`.
- The CI **install-test** (production tarball install + `tsx` load on 3 OSes) is the guard that catches misplaced runtime deps — keep it green.

## Release notes: per-entry files roll up into CHANGELOG.md

The GitHub release body is derived from the curated `CHANGELOG.md` section for that version — **not** an auto-generated PR-title list. The version-bump PR runs `npm run changelog:release`, so the rolled CHANGELOG and deleted entry files pass normal CI and required checks before merge. At tag time, `release.yml` only verifies that the version heading exists and `.changelog/` has no pending entries, then runs `scripts/changelog-extract.mjs "$VERSION" --summary` and posts it via `gh release create --notes-file`; it never mutates or pushes changelog state. Contributor credits are appended immediately afterward.

- **Add one `.changelog/<branch-or-slug>-<short-desc>.md` entry IN the PR, not after merge.** Use YAML front matter with any Keep a Changelog category (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) and exactly one top-level `-` or `*` entry; bold/plain, em-dash/period/no-separator styles and multiline continuation content are accepted. See [.changelog/README.md](.changelog/README.md). Entry files are the PR-time authoring seam; `CHANGELOG.md` remains the release source of truth after bump-time rollup.
- **Author PR notes only as `.changelog/*.md` entries, never by adding bullets directly under `[Unreleased]` in `CHANGELOG.md`; in fragments and any legacy `[Unreleased]` content, keep each complete bold title on one physical line, including refs inside the bold span when present.** `tests/scripts/changelog.test.ts` and `npm run changelog:check` reject wrapping because release-note summarization can truncate or mangle it.
- **At version-bump time, run `npm run changelog:release`** (`scripts/changelog-release.mjs`): this is the rollup entry point. It folds both the populated `## [Unreleased]` content and all validated `.changelog/*.md` entries into `## [X.Y.Z] - <date>` directly below a fresh empty `[Unreleased]`, in Keep a Changelog order, and deletes consumed entry files. Re-running for the same version is idempotent. Version defaults to `package.json`, date to today. This command does not run in `release.yml`.
- **Parsing/summary logic** lives once in `scripts/lib/changelog.mjs` (`extractSection` matches the bracket label, ignores the `- <date>` suffix, takes the FIRST of a duplicated label; `summarizeSection` condenses to grouped titles). Guarded by `tests/scripts/changelog.test.ts`, which also asserts every `v3.*` tag has a non-empty section.
- **Retroactive fix:** `npm run release:backfill-notes` (`scripts/backfill-github-releases.mjs`) sets every existing GitHub release body from its CHANGELOG section (summary by default; `--full` for the whole prose). Dry-run by default; `--apply` to write; skips (never blanks) releases with no section. All 35 v3.8.x releases were backfilled this way.
- **Contributor credit:** `release.yml` appends the "🙏 Thanks" block for each new release after `gh release create`. For retroactive repairs, `npm run release:backfill-thanks` (`scripts/backfill-release-thanks.mjs`) appends the same block to each release body crediting that release's external merged-PR authors (PRs between the previous tag and this one; owner + bots excluded). Dry-run by default; `--apply` to write; idempotent (skips releases that already have a Thanks block). Credits PR authors only — issue-reporter attribution per historical release isn't cleanly derivable, so add those by hand on the current release when you have the context.
- **Contributor table generation:** `.all-contributorsrc` must not define `wrapperTemplate`. `all-contributors-cli` hardcodes invalid `</tr><br />` row separators whenever a custom wrapper is present; omit that property and let the CLI's default wrapper generate the table. After generation, verify the contributor block contains no `</tr><br />` separators.

**Rule catalogs.** `docs/ast-grep_rules_catalog.md` + `docs/tree-sitter_rules_catalog.md` list every bundled rule **per language** and are **generated** — edit the rule files, not the docs, then `npm run docs:rule-catalogs` (`scripts/gen-rule-catalogs.mjs`). A `--check` run (in `tests/scripts/rule-catalogs.test.ts`) fails if they drift. ast-grep covers pi-lens-authored (`rules/ast-grep-rules/rules/`) + vendored CodeRabbit (`coderabbit/rules/`); tree-sitter covers `rules/tree-sitter-queries/<language>/`.

**Tree-sitter post-filters.** Query rules may use the TypeScript-side
`applyPostFilter` seam for bounded same-file AST checks that predicates cannot
express; batched and single-rule execution both pass the parsed root. Every
YAML `post_filter` must have a switch implementation — the invariant test in
`tests/clients/tree-sitter-879-post-filters.test.ts` enforces this against the
real rule files and real switch source (do not hand-maintain counts here).
Unknown names fail
closed: every raw match is dropped and one error is logged per process. A new
filter therefore ships with a bounded traversal, a `try/catch` that returns
`true` (keep the diagnostic if filtering fails), and real hit+miss tests; if
that cannot be done honestly with captures plus same-file AST context, remove
or make the rule advisory instead of adding a placeholder name.

## Build & packaging: precompiled dist + resource resolution (hard-won — #182)

pi-lens ships **precompiled JS**, not TypeScript source, so pi doesn't jiti-transpile ~200 files on every cold start (~3.5s → ~1.5s; the load cost is logged as `pi-lens loaded: <ms>ms … (from dist|source)` in `sessionstart.log` + `extension_loaded` in `latency.log`).

- `main` and `pi.extensions` → **`./dist/index.js`**. The published package ships `dist/` (compiled) + non-TS assets; it does **not** ship `.ts` source.
- **`dist/` is gitignored — never committed.** It exists only in the npm tarball, regenerated by `prepare` at install/pack time (and listed in `package.json` `files`). So `npm run build:dist` output never appears in `git status`, and you must never `git add` it. Run `build:dist` locally only to refresh what a warm MCP server / local pi loads — not to commit. (Reconciles "#182 precompiled dist" — shipped, not versioned.)
- **`prepare` (NOT `prepack`) builds `dist/`** via `build:dist` (`tsc -p tsconfig.dist.json --noCheck`). `prepare` runs on **every `npm install`, including `git:` installs (pi's install method)**, and before publish; `prepack` only fires on pack/publish, so a git install would get `main → ./dist/index.js` pointing at a file that was never built. `tsconfig.dist.json` overrides the inherited Node type library with `"types": []`, and `--noCheck` keeps the install-time build robust when dev-only `@types/node` is absent under `npm install --omit=dev`.
- **Two builds, don't confuse them:** `npm run build` (`tsconfig.build.json`) compiles **in place** next to the `.ts` — this is what the dev/test loop loads (vitest resolves `./x.js` to the in-place output, so stale in-place `.js` can shadow edits — rebuild). `build:dist` produces the shipped/loaded `dist/`.
- **`build:dist` bundles the entry after `tsc` (#335).** pi ships as a `bun build --compile` single-file executable whose embedded module resolver does not traverse an extension's on-disk `node_modules` for a **bare specifier**, so a static `import { minimatch } from "minimatch"` in a compiled `dist/clients/*.js` fails with `Cannot find package` and degrades the analyzers that reach it (jscpd/todo/complexity via `file-utils.js`). After the `tsc` emit, `scripts/bundle-dist.mjs` (esbuild, run through `node <npm-cli> exec` like tsc's toolchain resolution — installs into npm's cache, not the project tree, so no dependency is added, it works on a from-source `--omit=dev` install, and stays out of the `npm audit` tree; spawned shell-free via node with an argument array, so no `npx.cmd` issue and no shell arg re-parsing) collapses `dist/index.js` into one self-contained ESM file that inlines the pure-JS deps (minimatch, js-yaml, vscode-jsonrpc + transitives) so nothing loads by bare specifier. **Kept external:** host-provided packages pi resolves from its own embedded runtime (typebox, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) and the native/wasm packages loaded lazily (`@ast-grep/napi`, web-tree-sitter). A `createRequire` banner is prepended after esbuild runs because esbuild's ESM output wraps the bundled CJS deps (vscode-jsonrpc) in a shim that throws on `require()` under pure-ESM Node. The two lazy accessors (`clients/deps/{ast-grep-napi,web-tree-sitter}.ts`) resolve to an **absolute `file://` URL** via `createRequire` + `pathToFileURL` before dynamic-importing (the `createRequire` resolution mirrors how `tree-sitter-client.ts` locates its wasm/package assets, though that file only reads the resolved path from disk — it does not `import()` it) — because an absolute-path dynamic import works under the compiled host while a bare one does not, and a raw Windows path is not a valid import specifier. web-tree-sitter's `exports` map exposes only the `.` entry, so the bare package name is resolved (not a custom subpath). The `deps/{typebox,pi-tui}.ts` accessors re-export **named** bindings (not `export *`): a wildcard re-export against an external side-effect-only import leaves the namespace binding undefined at runtime. `dist/` stays gitignored — the bundle is a build artifact, never committed.
- pi-lens's **own** assets are depth-robust: `rules/`, `config/`, grammars resolve via `getPackageRoot()` (`clients/package-root.ts`, walks up to `package.json`), so moving the entry into `dist/` doesn't break them.
- **GOTCHA — pi resolves each `pi.skills` entry relative to the extension entry's FILE PATH, not its directory and not the package root.** pi does `path.resolve(entryFile, skillEntry)` (verified in `@earendil-works/pi-coding-agent` `core/skills.js` + `package-manager.js`). With the entry at `./dist/index.js`, a leading `../` only cancels `index.js` and stays inside `dist/`, so `pi.skills` must climb **two** levels: **`["../../skills"]`** → `dist/index.js` → `../` (=`dist/`) → `../` (=root) → `skills/`. `"../skills"` resolves to `dist/skills` (missing) → skills silently don't load + `[Skill conflicts] skill path does not exist` (this regressed when the entry moved to `dist/` in #182 — the value was left at `../skills`, off by one; fixed in #199). `"./skills"` → `dist/index.js/skills` (missing); copying skills into `dist/skills` → same skill at root and dist → collision. Keep ONE skills dir (root `skills/`) and point `pi.skills` up two levels. **The tarball `skills/` ship-check does NOT validate this** — `tests/packaging.test.ts` now statically replicates `resolve(entryFile, skillEntry)` and asserts it lands on root `skills/`.
- Guarded by `tests/packaging.test.ts` + the CI install-test (tarball ships `dist/index.js` + root `skills/`, no `.ts`, compiled entry loads "from dist").

## Performance: the hot-path / event-loop discipline (hard-won — #188)

pi-lens's lifecycle hooks (`session_start`, `tool_call`, `tool_result`, `context`, `turn_end`, `agent_end`) run on the **same event loop as pi's TUI**. Any synchronous burst on a hook **blocks the user's keystrokes**. Slop accumulates because it's invisible on small repos and catastrophic on large (2k-file) ones. Invariants:

- **No hook's synchronous burst should block > ~50ms.** Heavy work is async + time-budgeted through `clients/cooperative-budget.ts` (`createDeadline` / `yieldIfOverBudget` / `forEachCooperatively`) or **deferred past the typing window** (a few-second `setTimeout`, not `setImmediate`). Count/modulus yielding does not bound occupancy when per-item cost grows; call the cheap monotonic deadline check at every work unit.
- **Bounding a promise by a timer? Use `clients/deadline-utils.ts`** (`withTimeout` reject-on-timeout · `withBudget` resolve-`undefined`-on-timeout · `withinRemaining` deadline-based swallow · `withDeadline` core). Do **not** hand-roll another `Promise.race` + `setTimeout` — it drifted into three near-identical copies (#366), two with latent bugs (a missing late-rejection guard → unhandled rejection when the timer wins; an uncleared timer). The core suppresses the loser promise's late rejection and clears its timer in one place.
- **Every new async step added to a bulk/sweep/per-file loop needs BOTH bounds, not just one (#615).** `runWorkspaceDiagnostics`'s per-file `processFile` was already `withDeadline`-wrapped, but the #608 fix (`preOpenGroupFiles`, a batch pre-open pass inserted ahead of it) shipped with **no bound at all** — a hung `getClientsForFile`/`notify.open` call (stuck server spawn, stuck notification write) froze the entire sweep with no heartbeat and, worse, pressing Escape didn't help either: the loop's `signal?.aborted` check only runs *between* files, never while one is mid-await. A real dogfooding incident hit this (`lsp_workspace_diagnostics_start` logged, then total silence, un-abortable). The fix needed two independent bounds: a `withDeadline` timer (catches a hang even with no user action) **and** a `Promise.race` against the abort signal (so an explicit Escape/turn-abort unblocks immediately instead of waiting out the rest of the per-item budget) — see `tests/clients/lsp/workspace-diagnostics-sweep-batch-open.test.ts`'s `#615` block for the pattern, including the "confirm the regression test actually hangs against the unbounded code" verification step. When adding a new async unit of work to an existing bounded loop, ask both questions: *what stops this if it hangs on its own?* and *what stops this if the user aborts?* — a "yes" to only one is not done.
- **Per-file / per-event work must be O(1) amortized** — memoize expensive derivations keyed by an invalidation signal (`.gitignore` mtime, `fileSeq`, content hash); never recompute-from-scratch on repeat (e.g. `ignoreMatcher.isIgnored` was recomputed per file per scan — now memoized). Project config discovery uses `walkUpDirs` with a start-dir cache validated by ancestor directory mtimes plus the actual inherited `.pi-lens.json`/`pi-lens.json` path + mtime (not just a file directly under the git root), so editing project `ignore` patterns drops the cached matcher without a session restart while hot dispatch paths avoid repeated candidate probes. The matcher cache key also includes the **global** `~/.pi-lens/config.json` mtime: `ignore` patterns there apply across all projects at **lowest precedence** (global → project `.gitignore` → project `.pi-lens.json`, so a project `!negation` re-includes a globally-ignored path — #252). Directory-mtime memos such as `getModuleSourceFiles` also re-walk stamps younger than the filesystem's coarse-granularity guard window, because an equal mtime cannot prove that a same-tick write was absent.
- **Expensive scans run once, cache (process memo + disk), reuse across sessions/turns.** Cold start does the minimum (forced "quick" mode), then a deferred background warmup fills caches.
- **Register every `Worker` listener before calling `worker.unref()` (#1148).** Adding the first `"message"` listener references the Worker's public `MessagePort` again, so `unref()`-then-listen leaves an idle persistence worker able to keep a completed one-shot process alive. Real child-process exit tests guard this lifecycle behavior; fake timers and in-process assertions cannot see referenced worker handles.
- **Detached timers must not capture pi `ctx` getters.** After `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` / `ctx.reload()`, pi invalidates the old extension context; a later timer that reads `ctx.ui`/`ctx.cwd` crashes with a stale-context error (#338). Capture any needed primitive/function while the event is active, guard delayed work with `RuntimeCoordinator.sessionGeneration`, cancel on `session_shutdown`, and make timer callbacks best-effort/no-throw.
- **No `readdirSync`/`statSync`/`readFileSync` or regex-over-all-files on a hook path** unless bounded and yielding.
- **Measure, don't guess:** `~/.pi-lens/latency.log` logs per-phase/`tool_result` durations + `session_start total`; `npm run logs:smells`. PR #188 is the worked template.
- **Guard occupancy, not duration, at scale (#192):** use `tests/support/perf-harness.ts` — `measureMaxSyncBlockMs(work)` measures the longest synchronous stretch the work held the event loop (an independent loop-lag sampler, so it catches a *fully non-yielding* regression, which a duration timer or wrapping the code's own `setImmediate` would miss), and `generateSourceTree(dir, n)` builds a scaled fixture (the burst is O(files) and hides at pi-lens's ~300). New hot-path budget guards (see `tests/clients/source-walk-occupancy.test.ts` for the async walkers, `tests/clients/pipeline-snapshot-occupancy.test.ts` for the `tool_result` autofix snapshot walk) assert `measureMaxSyncBlockMs(...) < ~300ms` on a ~1k+ fixture, with `{ retry: 2 }` to soak ambient parallel-suite load. Keep the fixture light enough not to starve the parallel suite. `snapshotProjectFiles` (`clients/pipeline.ts`, autofix side-effect detection) is bounded by `AUTOFIX_CHANGED_FILE_SCAN_LIMIT` and **chunk-yields** every `SNAPSHOT_YIELD_EVERY` files (#368) — was a ~130ms sync block at the 5,000-file cap; its guard runs at cap scale (~5k files) with a tighter 100ms budget to assert the yielding walk holds the loop briefly, tripping on a revert-to-sync, an exclusion break, or a removed cap.
- **Runtime occupancy monitor:** `clients/event-loop-monitor.ts` wraps Node's native `monitorEventLoopDelay` (enabled at extension load, zero per-event overhead). `getEventLoopStats()` (worst block / p99 / mean / per-window CPU+wall / `suspectSystemStall`) is surfaced in `/lens-health` and the `loop_block` latency phase. Caveat: the native histogram's *capture* is unreliable inside vitest's worker, so test the wrapper contract (lifecycle/finite conversion), not block magnitude — block magnitude is what `measureMaxSyncBlockMs` (test-side, setImmediate sampler) is for. **The histogram is windowed per turn** (`resetEventLoopMonitor()` at `turn_end`), not lifetime-cumulative, so a block is attributable to its turn AND its CPU budget is bounded. `monitorEventLoopDelay` measures monotonic timer-lag, which on Windows *includes* whole-process freezes (Modern Standby, commit-charge paging) — those are NOT pi-lens synchronous work but masquerade as huge blocks (#1122: a 290 s Modern-Standby gap, multi-hour overnight sleeps). Comparing wall-vs-monotonic does NOT detect this (both advance across standby); the discriminator is **CPU accounting** — a real block of D ms burns ≈ D ms of main-thread CPU, so a max above a 20 s floor that the window's `process.cpuUsage()` delta can't account for is tagged `suspectSystemStall` and kept out of the genuine-block high-waters. When adding a synthetic "block" telemetry path, ask whether an OS freeze could inflate it before trusting the magnitude.
- **Memory attribution (#1123 item 2):** `clients/memory-sampler.ts` emits one `memory_sample` `latency.log` line every 10 turns (`shouldEmitMemorySample`) plus a compact `/lens-health` line (`formatMemoryHealthLine`) — `process.memoryUsage()` breakdown + O(1)/O(bounded-cache-size) per-subsystem counters (review-graph workspace-cache entries+nodes+edges, word-index docs/postings/forward entries, tree-sitter grammar/parser/query-cache counts + tree-cache bytes, dispatch cascade cache sizes). Hard rule for ANY subsystem added here: every read must be a `Map`/array `.size`/`.length`, never an iteration over a large structure's contents, and never a heap snapshot (`PI_LENS_DEBUG_HEAP` is the separate, explicitly opt-in mechanism for that). **web-tree-sitter's WASM linear-memory byte length is deliberately NOT read**: the installed 0.25.10 package's `Module`/`wasmMemory` (owns `HEAPU8.buffer`) is a private closure in the package's `bindings.ts`, not exported through `Parser`/`Language`/`Query` or any public surface — reaching it needs either internal reflection (breaks across web-tree-sitter versions/bundling silently) or overriding Emscripten's `wasmMemory` init option with a hand-built `WebAssembly.Memory` matching the library's own default page-count math (a mismatch there breaks ALL structural analysis — too high a stability cost for an observability-only field). `process.memoryUsage().arrayBuffers` is the accepted process-wide proxy. The vanished-instance marker (`clients/vanished-instance-marker.ts`) piggybacks on the same registry fields: an `instances.json` entry surviving with a pid-confirmed-dead owner is BY CONSTRUCTION proof `deregisterInstance()` never ran (it synchronously removes the entry on clean shutdown) — no separate "clean shutdown" flag was needed. It reads the registry and logs before `sweepOrphans()` prunes those same entries (sequenced via `.finally()`, not two independent fire-and-forget calls) — reversing that order silently empties the vanished set.
- **Handle-origin tracer (#1123 item 4, institutionalizing the #1097 investigation):** `clients/debug-handles.ts` reads `PI_LENS_DEBUG_HANDLES` ONCE at module load; unset (the default), every export is a pure no-op past that one boolean check — no writer, no `async_hooks` hook installed, zero cost on the `agent_settled`/`session_shutdown` hot paths that call `dumpActiveHandles(label)`. Set at startup, it dumps `process.getActiveResourcesInfo()` counts-by-type (plus per-type creation-site stack attribution from a bounded `async_hooks` tracker) to `~/.pi-lens/debug-handles.log`. The `async_hooks` tracker is real per-resource-creation overhead — hooks fire on every init/destroy in the process — so it is installed ONLY when the flag was already on before this module first loads, never toggled on live. Its creation-site map is capped at `TRACKER_MAX_ENTRIES` (the one-axis-rule: bounded along the resource-count axis, same class as the WASM tree-cache leak in the paragraph above this section) — but eviction is NOT plain drop-oldest: a #1097-style leak is typically among the EARLIEST-created handles in a session, so the first `TRACKER_PROTECTED_COUNT` insertion-order entries are pinned and eviction targets the oldest entry OUTSIDE that protected zone instead, with a running `evictedCount` surfaced on every dump so any attribution gap from a burst past the cap is an explicit, visible fact rather than a silent drop.

## Internal edit substrate direction

**LSP workspace-edit ordering is transactional only at validation time.** `clients/lsp/edits.ts` plans `documentChanges` in declared order, flushing queued text edits before resource operations on the same URI/subtree, and validates every text-edit batch before the first filesystem mutation. Preserve original-array order for equal-position inserts and collapse only byte-identical non-empty duplicate edits; later filesystem failures remain no-rollback and must keep the existing partial-application error.

Phase 6 in `implementation.md` is intentionally **not** a public `lens_edit` tool. It should be an internal mutation substrate to reduce failed edits in pi-lens-owned paths while preserving the native agent edit lifecycle:

```text
Native agent edit/write path:
read expansion → read guard → oldText autopatch → native edit → tool_result pipeline

pi-lens-owned mutation path:
seq/hash/range validation → atomic apply → read-guard stamp → seq/change-log → normal post-edit pipeline
```

Use it first for partial apply, then LSP workspace edits/actionable autofix. It must not bypass read guard for normal agent edits, replace oldText autopatch, guess stale ranges, or apply project-wide edits by default.

Workspace edits (`clients/lsp/edits.ts`) are strict and confined: shape/URI/resource preconditions, document versions, text bounds, and all text reads are preflighted before mutation; only an unexpected filesystem failure after that preflight retains the documented no-rollback boundary. Incoming server positions are normalized from the negotiated encoding against the same virtual post-resource content/path model used by application, so ordered rename/create/delete followed by descendant text edits works before destinations exist on disk; a failed range remains fail-closed. Rename notification state preserves the original opened URI plus its authority/encoding spelling for the destination; a failed `didClose` aborts/resynchronizes instead of sending `didRenameFiles`. `rename_file` validates both resource paths and preconditions through a read-only call to this same apply/confinement seam before soliciting any `willRenameFiles` edits (including previews), then routes its disk resource operation back through the seam (never a direct mkdir/rename). Preflight lazily maps renamed directory descendants and tracks subtree tombstones so ordered edits after rename/delete chains cannot resurrect deleted children without walking the whole tree. Mutation telemetry describes normalized edits; each solicited request gets one bounded, sequence-tagged summary under its outer correlation ID, with an explicit aggregate overflow marker after the 100-summary cap.

The preflight's virtual model has a THIRD layer beyond `virtual` (physical-path-keyed) and the tombstone/move lists: `virtualOverrides` (#1085 P3-3), keyed on the raw, unresolved query path, for a `create` whose target is a path currently shadowed by an earlier rename's vacated "from" address in the SAME ordered edit — `resolveVirtualPath` correctly returns `undefined` there (no physical address to key `virtual` on), so a later op at that exact path (e.g. a trailing text edit) would otherwise see it as still-nonexistent. A case-only (or otherwise-aliased) rename's alias decision also has TWO tiers now (#1085 P3-8): a fast, disk-free check that the destination's and source's cached `VirtualFile` object are referentially identical (proof they share a case-folded map key — i.e. a virtual-only entry, e.g. one `create`d earlier in the same edit and not yet written to disk), falling back to the physical `isSameFsEntry` `lstat`-identity probe untouched for genuinely-physical paths. `mergeWorkspaceTextEditsByPriority`'s exact-duplicate dedup (used on the `renameFile` merge path) only applies to non-empty ranges — zero-width inserts keep their multiplicity even when duplicated within one server's own edit, matching `validateTextEdits`'s invariant on the normal apply path. A queued text document `version: null` (LSP 3.17: "don't check") never conflicts with a numeric version for the same URI; the numeric one is adopted and still checked against the live document version. `fileDetails[].importsChanged` on a text edit means "this edit changed an import/re-export-from line" (pre/post signature comparison), not "the file contains any import" — `create`/`rename`/`delete` keep their existing conservative (trivially-correct or structural) flags.

## SDK-reuse boundaries (deliberate — don't naively "simplify")

A 2026 audit against `@earendil-works/pi-coding-agent` confirmed a few places where pi-lens intentionally does *not* reuse an SDK facility:

- **Per-session diagnostic persistence** uses our own sidecar store (`clients/session-state-store.ts` → `getProjectDataDir/sessions/<id>.json`, atomic overwrite) rather than the SDK's `pi.appendEntry`/`getEntries`. `appendEntry` is append-only, so writing a fresh widget snapshot every `turn_end` would bloat the session JSONL with superseded copies; overwrite-in-place is the right fit. (The one genuine upside of `appendEntry` — fork/branch inheriting state for free — would let us drop the `session_before_fork` in-memory hand-off; revisit only if that hand-off becomes painful.)
- **Context injection** prepends a raw `{role:"user"}` message on the `context` hook **on purpose** (keeps the user's prompt as the trailing message). The documented `before_agent_start`/`appendCustomMessageEntry` paths can't satisfy the trailing-message constraint — don't migrate to them.
- **`safeSpawnAsync` over `pi.exec`** — see Runner process model (Windows UTF-8/tree-kill/`.cmd`/batch that `pi.exec` lacks).

## TypeScript LSP version split

`TypeScriptServer.spawn()` must resolve the compiler from the workspace before probing/installing the classic wrapper. Resolve the **nearest** `node_modules/typescript` from the selected LSP root upward (normal Node ancestor semantics, stopping before `$HOME`) so a nested monorepo package can use its hoisted compiler without skipping a nearer package; a nearest major version 7+ launches the matching ancestor's `node_modules/.bin/tsc --lsp --stdio` (Windows: prefer `tsc.cmd`, then `.exe`/extensionless). Never substitute a PATH/global `tsc`, because that can bind the workspace to an unrelated compiler. TypeScript <=6 keeps `typescript-language-server --stdio` plus `TSSERVER_PATH`/`initialization.tsserver`. The installer registry pins the managed classic fallback to `typescript@5.9.3`. `typescript-language-server@5.3.0` declares no dependencies and no peer dependencies, so it never pulled a compiler in. The cause was pi-lens's own `typescript` tools entry: it was unpinned, so the managed install resolved `latest` and landed TypeScript 7.0.2, which ships no `lib/tsserver.js`. The wrapper then started and failed initialization. 5.9.3 is the conservative choice — the last 5.x — not the only version other managed consumers accept. If a managed `tsc` resolves to TypeScript 7+ and installation is allowed, `findTsserverPath` force-reinstalls the pinned compiler. The repair runs at most once per process, and only when the compiler version is readable; a bare PATH `tsc` is left alone. Discovery-only callers never mutate the tools tree. If the nearest project TS 7 package has no local `tsc` binary or invalid metadata, fail open to the classic discovery path rather than reporting the server available without a process. Regression coverage: `tests/clients/lsp/typescript-native-lsp.test.ts` and `tests/clients/lsp/server-policy.test.ts`.

## Open design TODOs

- **Project-diagnostics extractor registry (#179)** — the heavyweight project analyzers are normalized into `ProjectDiagnostic` records and surfaced via `lens_diagnostics` full mode. `clients/project-diagnostics/extractors.ts` is the single registry: each row maps an analyzer's **cached** result (by cache key) to per-file diagnostics via a pure `runner-adapters/*` function. **Cache-only — `mode=full` reads the caches and folds them in, it NEVER launches a scan** (so it can't relaunch or contend with the background session-start/turn-end runs, which share a global abort signal). **Done:** knip, jscpd (clone → both ends), madge (cycle → each file), gitleaks (secrets → blocking), govulncheck (reachable Go CVE → first traced source frame), trivy (dep CVE → manifest), dead-code (vulture/Python; unlisted → blocking), opengrep (CLI scan, #584; `ERROR` severity → blocking). **Not (cleanly) adaptable — left out on purpose:** type-coverage (wired but currently never run/cached — no cache to read), test-runner (caches a formatted string, not structured findings), call-graph (structural intelligence, not diagnostics). Adding an adaptable one is one adapter + one registry row — no `formatFullMode` surgery.

- **LSP server `initializationOptions` overrides via project config** — `clients/lsp/config.ts` now also parses a `serverOverrides` key in `.pi-lens/lsp.json` (or `.pi-lens.json` / `pi-lsp.json`). Each entry is keyed by the built-in server `id` (e.g. `"rust"`, `"nix"`) and carries an `initializationOptions` object. In `clients/lsp/index.ts` `spawnClient()`, the override is fetched via `getServerInitOverride(server.id, filePath)` and deep-merged (user wins on conflicts) onto the server's built-in defaults via `mergeInitializationOptions`. Arrays are replaced, not merged (consistent with standard LSP settings merge semantics). Tests live in `tests/clients/lsp/server-init-overrides.test.ts`. Test files that mock `clients/lsp/config.js` must include `getServerInitOverride: vi.fn().mockReturnValue(undefined)` in the mock factory — existing service tests (`service-touch-collect`, `service-race`, `service-early-unblock`, `service-mode-grace`, `workspace-diagnostics-per-server`, `runtime-session-warm`) were updated accordingly.

- **LSP server preference via project config** — `clients/lsp/config.ts` supports `.pi-lens/lsp.json` with `disabledServers` and custom server entries, but there is no way to express a *preference* between built-in candidates (e.g. prefer `basedpyright` over `pyright` when both are installed). `PythonServer.spawn()` uses first-found-wins ordering: project-environment and Node-local `pyright-langserver`, then `basedpyright-langserver`, then project-environment or PATH `ty server` (#717), then pyright's managed-install tier. A future `preferredServer` key in `LSPConfig` should let projects override this ordering; the server policy layer (`clients/lsp/server-policy.ts`) is the right place to apply the preference before candidate resolution.

- **Python project environments apply without shell activation (#717, closes #2407, refs #1513)** — `clients/python-environment.ts` resolves `VIRTUAL_ENV`, `CONDA_PREFIX`, `.venv`, or `venv` without invoking a package manager. It supplies a child-only `PATH` and `VIRTUAL_ENV` to Python LSP, standalone Pyright, and pytest processes; never mutate `process.env`, because different roots can select different environments. `PythonServer.spawn()` prefers project-environment pyright/basedpyright/ty binaries before broader candidates. `TestRunnerClient` runs pytest through the detected project interpreter itself and uses generic `python -m pytest` only when no project environment exists. ty stays opt-in: it is not in the installer registry, and its `resolveAndLaunch` call keeps `allowInstall:false`, so managed pyright remains the default when the project and PATH provide no Python LSP. No `initializationOptions` are sent to ty because it has no stable `pythonPath` equivalent (astral-sh/ty#2032); its child environment and cwd drive interpreter discovery.

- **Toolchain-gated LSP auto-install (#241, partially shipped)** — `ensureTool` only covers servers in the installer registry (npm/pip/gem + single-binary github/maven/archive). `allowInstall:false` / `PI_LENS_DISABLE_LSP_INSTALL=1` means **discovery-only, not no-discovery**: `ensureTool(id, { allowInstall:false })` must still probe PATH/npm-global/managed-bin and skip only the install step; `forceReinstall` must not bypass that gate, and in-flight ensures are keyed by install policy so discovery-only callers never inherit a concurrent install. LSP spawn `undefined` while installs are disabled is an expected unavailable state, not a broken server signal — cool it down briefly, but don't count it toward permanent session disablement. Root-detector glob markers are supported (`*.csproj`, `*.sln`, `*.cabal`, etc.); use globs for real project-file names rather than pseudo-extension markers like `.csproj`. Heavy workspace servers must not use `FileDirRoot` fallback just to keep spawning: C# (`csharp-ls`/OmniSharp) now resolves `*.sln`/`*.csproj` and skips standalone `.cs` files, matching Rust's no-manifest skip (#201); F# (`fsautocomplete`) does the same for `*.sln`/`*.fsproj`. The verifiable slice is DONE (`clients/lsp/server.ts`): **fsautocomplete** now installs via `dotnet tool install` (`runtimeInstall` hook + `dotnetToolCandidates` discovery, mirroring csharp-ls), and **gopls / rust-analyzer** gained canonical-bin discovery — `goBinCandidates`/`cargoBinCandidates` add `$GOPATH/bin` (or `~/go/bin`) and `$CARGO_HOME/bin` (or `~/.cargo/bin`) as candidates so a runtime-managed binary resolves (and gopls's post-`go install` retry lands) even when those dirs aren't on PATH. Because `shouldAllowInstall` defaults on, the smoke spawn drives `runtimeInstall` directly — these are live-smoke-able (`scripts/smoke-tools.mjs --lsp fsharp go rust`) and unit-smoked deterministically (`tests/clients/lsp/runtime-install-discovery.test.ts` — reject-all candidate capture, `allowInstall:false` so no real installs fire). STILL on the PATH-only `createInteractiveServer` path (deferred, unverifiable on the Win dev box): ocamllsp (opam), nixd (nix), haskell-language-server (ghcup version-matching), sourcekit-lsp (Swift toolchain, discovery-only). Archive-tree servers (jdtls, kotlin-language-server, clangd, lua-language-server, elixir-ls) needed a platform-matched archive strategy — the GENERIC archive-TREE-bundle shape EXISTS (#278): `ArchiveSpec` supports `stripComponents`/optional `launcher`/`treeMarker`, `installArchiveTool` keeps the whole extracted tree and resolves to the extract dir. **Two launch shapes now ride on it:** (A) *runtime + bootstrap script* via `resolveAndLaunchBundle` (a runtime on PATH drives a script inside the tree, graceful-skip when runtime/bundle absent) — first consumer **PowerShellServer** (PSES = `pwsh Start-EditorServices.ps1 -Stdio`); (B) *self-contained bin-in-tree* via `resolveAndLaunchTreeBinary` (PATH candidates first, else the managed bundle, then launch `<bundle>/bin/<exe>[.exe]` directly — no external runtime) — first consumer **clangd** (#241, `CppServer`, id "cpp"; `stripComponents:1` drops the `clangd_<ver>/` wrapper, `treeMarker:"bin"`). clangd also added the **platform-matched archive URL**: `ArchiveSpec.url` accepts a `(platform, arch) => url | undefined` resolver (`resolveArchiveUrl` drives `installArchiveTool`, degrading to "unavailable" where no build exists; plain string still works) — the reusable bit lua-language-server (next; also exercises per-*arch*) / kotlin / elixir-ls consume. Shape (C) *launcher-script-in-tree needing an ambient JVM/BEAM toolchain* (kotlin/elixir-ls) is still TODO. (clojure-lsp + gleam ARE registered too — single native binaries.)

- **Per-server diagnostic deadlines on with-auxiliary (#242)** — the collection applies one `max(callerCap, maxStrategyWait)` deadline to every server in a single Promise.all, so a silent primary holds the touch and a slow aux's `aggregateWaitMs` overrides the caller's per-edit cap. Fix: per-server deadline `min(strategyWait, callerCap)` (ceiling), + bump ast-grep `aggregateWaitMs` 1000→1800 (scan ~1.3s, under-budgeted, masked by the global floor today).

## Async-spawn migration — DONE (#197, closed)

The sync→async spawn migration is complete; the patterns above (`safeSpawnAsync`, ambient abort signal, async-only `createAvailabilityChecker`, per-client `*Async` probes) are the steady state. What's intentionally left sync, by design — do **not** "fix" this without a real reason:

- `TestRunnerClient.detectRunner`'s `which pytest` probe — cached per `(cwd, runner)`, fires once for a Python project with no config-file runner; converting it would ripple async through five methods (`findTestFile`/`getTestRunTarget`/`suggestTestFiles`/…) into the per-edit turn path for a one-time stutter.
- The deprecated `safeSpawn`/`isCommandAvailable`/`findCommand` exports in `clients/safe-spawn.ts` stay only for the two cases above.

For new runner tests, mock `safeSpawnAsync` (async); only mock the sync `safeSpawn` when testing one of the two legacy callers above.

## Actionable warnings routing

Every dispatch warning passes through one of two recorders in `clients/pipeline.ts`:

| Recorder | Required diagnostic fields | Destination |
| --- | --- | --- |
| `recordFromDispatchDiagnostic` | `semantic === "warning"` AND `severity !== "error"` AND (`fixable` OR `fixSuggestion`) | `actionable-warnings.json` — surfaces an advisory and can drive autofix |
| `recordFromCodeQualityDiagnostic` | `semantic === "warning"` or `"none"` AND `severity !== "error"` AND (no fixable, no fixSuggestion, no autoFixAvailable) | `code-quality-warnings.json` — informational history only |

A runner that wraps a tool with an auto-fix capability **must** propagate `fixable: true` or `fixSuggestion: "<rule-specific guidance>"` per diagnostic — otherwise everything it produces silently goes to code-quality and never reaches the actionable advisory. Severity-`error` diagnostics route to blockers instead, regardless of fixability.

Patterns by tool capability:

- **Tool exposes per-diagnostic fix metadata** (biome, eslint, ruff, rubocop, shellcheck, oxlint via `--format json` + `help`, ast-grep, tree-sitter via `has_fix`): read it directly, set `fixable: !!fix` or `fixSuggestion: help`.
- **Tool has `--fix` but no per-warning fix flag** (stylelint, markdownlint): static allowlist of rule IDs documented as deterministically fixable. False positives are worse than false negatives — keep the list conservative.
- **Tool has no auto-fix** (cpp-check, phpstan, javac, pyright, mypy, go-vet, actionlint, yamllint, etc.): hard-code `fixable: false`. The diagnostic correctly lands in code-quality.

### Severity policy (#1777)

Four tiers, and the dispatch path preserves all four end to end. `clients/dispatch/runners/ast-grep-napi.ts` maps a rule's declared YAML severity straight onto `Diagnostic.severity`; a rule that declares nothing, or declares a value pi-lens does not model, reports at `warning`.

Pick a tier by the evidence behind the rule:

- **`error`** requires a documented zero-false-positive audit in the rule's `note`. Only `error` maps to semantic `blocking` and stops a turn.
- **`warning`** is a real finding with a known, bounded false-positive rate.
- **`hint`** and **`info`** are style opinions. They render as advisory text, never block, and lose the report budget to warnings when a report is capped.

Tier governs how loudly a finding renders, not whether its fix is offered: a hint-tier rule with a fix still routes to actionable warnings. Do not re-tier a rule without recording the false-positive census that justifies the move.

**Promoting a rule to `error` (the 2026-08-20 procedure, refs #1727).** Three
things must all be true, and the rule's `note` must record them:

1. **A multi-corpus false-positive census**, not a single-tree count. Run the
   rule over pi-lens's `clients/` and `tests/` plus at least one real external
   codebase of the kind the rule targets, classify the hits, and put the table
   in the note. A rule that is clean here and noisy everywhere else is still a
   turn-blocker for the catalog's users.
2. **Structural narrowing before exemption.** Suppress a legitimate idiom with
   a relational constraint on the rule (`inside`/`has`/`follows`, scoped path
   globs), not with prose in the note telling readers to ignore the hit.
   Record the false-negative bias the narrowing buys, because a path glob or a
   name regex approximates intent, it does not read it.
3. **Self-scan wiring.** Tag the rule `metadata.category: pi-lens-self-scan`
   so `npm run astgrep:self-scan` holds this tree at zero in CI. An `error`
   rule that never runs against pi-lens's own source is an unaudited claim.
   Fix or replace the residual hits; do not baseline them.

If the post-narrowing residual is still tens of legitimate hits, STOP and
report the numbers. Six of the eight #1727 anti-slop rules stopped there on
2026-08-20; each one's note carries its census and the reason. Volume alone is
the verdict: at `error` an agent editing a file with a pre-existing hit is
blocked on code it did not write.

When changing a serialized cache that feeds this pipeline (e.g. `clients/cache/rule-cache.ts`), bump `CACHE_VERSION` so old entries invalidate. The tree-sitter rule cache previously stripped `has_fix` on roundtrip, silently demoting every tree-sitter rule with auto-fix to non-fixable on any cache hit (commit `24af518`).

## Bus events — `pilens:files:touched` (#482)

pi-lens's first `pi.events` broadcast surface: `clients/bus-publish.ts` exports `publishFilesTouched({ reason: "autofix" | "format", paths, cwd, origin? })`, fire-and-forget over `pi.events.emit` (wired once at extension factory time in `index.ts` via `wireBusEmitter`; null-safe when unwired, e.g. unit tests and the MCP server path with no pi host). Payload is frozen-additive (`{ v: 1, source: "pi-lens", reason, paths, cwd }`; bump `v` on a breaking change), one event per logical write batch. Wired at every seam where pi-lens writes project source autonomously: `runPipeline`'s immediate-format and autofix phases, `handleAgentEnd`'s deferred-format loop, and the actionable-warnings conservative LSP autofix — NOT at seams where pi-lens replays the agent's own edit content (partial-edit-apply preflight, ast-grep/lsp-navigation agent tool calls with `apply:true`) since the host already knows about agent-authored writes. `origin: "bus"` is a structural loop guard for a future bus-consuming feature (pi-lens consumes nothing today). Kill switch `PI_LENS_BUS_PUBLISH=0`. Full contract: `docs/features.md` ("Bus Events"); env var: `docs/environment-variables.md`. Refs `#478` (planned `pilens:rpc:*` query surface, same versioning discipline).

**First-class seam census (pinned by `tests/config/files-touched-bus-conformance.test.ts`).** The two publisher modules are `clients/pipeline.ts` (immediate format and synchronous autofix) and `clients/runtime-agent-end.ts` (deferred autofix, deferred format, and actionable-warning LSP autofix). The one subscriber is `clients/agent-nudge.ts`, which listens through `pi.events.on` and filters paths against read-guard history before batching a context nudge. `clients/lsp-mutation.ts` has an unwired optional `publishFilesTouched?: (paths: string[]) => void` injection point; it is not a publisher unless someone wires that callback. A new publisher or subscriber MUST update that declared list and state why `pilens:files:touched` applies at the new seam; the conformance test fails otherwise. The publisher list names modules, not individual call sites: each listed module may have multiple logically distinct write completions, but every publication remains one event per logical write batch.

**Observability.** A publish does leave an outcome record today: `clients/bus-publish.ts` writes bounded `emitted`/failure or structural-skip outcomes to `bus-events.log`, and emitted activity rolls up once per session in `latency.log`. It deliberately does not persist a second copy of every path-bearing payload: writes are high-frequency, `recent-touches` is the separate bounded cross-process aggregate, and the subscriber receives the in-process payload directly. Keep outcome-level records and the session aggregate; adding one durable record per file or per payload would duplicate data and add hot-path noise.

**`pilens:format:queued` / `pilens:format:start` (#674) / `pilens:autofix:start` (#684).** `pilens:files:touched` only ever fires AFTER a write/autofix/format completes — it can't tell a same-process listener (e.g. a review/snapshot tool) that pi-lens is *about to* mutate a file it queued earlier (raised via #673: an external content-binding tool derived an immutable candidate tree mid-turn, then deferred formatting silently invalidated it ~66s later). `clients/format-events-publish.ts` (its own sibling module, same DI/versioning conventions as `bus-publish.ts`/`diagnostics-publish.ts`) closes that gap for both deferred batch operations: `pilens:format:queued` fires once per file on first entry into `RuntimeCoordinator`'s deferred-format pending queue (`deferFormat()`, suppressed on re-touch before `agent_end` drains it); `pilens:format:start` and `pilens:autofix:start` fire at `agent_end`, right before the deferred-format loop and the actionable-warnings autofix batch respectively actually begin — both gated on genuine non-empty work, not just the feature flag being on. The per-edit SYNCHRONOUS autofix path (`pipeline.ts`'s `runAutofix`, awaited inside `tool_result` before the tool result returns) deliberately has no `start` event — it isn't deferred, so there's no "queued, will run later" gap to signal.

## Three channels, three audiences (#482/#484/#485)

One feed of pi-lens's out-of-band activity (autofix/format writes, diagnostic digests, etc.) fans out to three separate deliveries — pick the channel by AUDIENCE, not by convenience:

- **Bus events → EXTENSIONS.** `pilens:files:touched` on `pi.events` (#482, `clients/bus-publish.ts`), `pilens:diagnostics` (#502, `clients/diagnostics-publish.ts`), and `pilens:format:queued`/`pilens:format:start` (#674, `clients/format-events-publish.ts`). Broadcast-only; other extensions in the session observe pi-lens's autonomous writes and findings without reverse-engineering it.
- **Display-only session entries → the HUMAN** (#484, pi 0.80.6). Persisted in the session record, rendered in interactive mode, **never sent to the model** — zero context cost. The right home for anything a user might scroll back to (session-start notices, per-turn digests) that the agent doesn't need to act on.
- **Context nudges → the MODEL** (#485, `clients/agent-nudge.ts`). The one channel that costs agent context, so it is the most tightly gated: batched per delivery (never per-event), capped file list, and filtered to files the session actually read/edited via the read-guard — the agent doesn't care that an untouched file got formatted.

`clients/agent-nudge.ts` is the reference consumer of the #482 bus feed: it subscribes read-only to `pilens:files:touched` (`pi.events.on`, never emits back — the #482 loop guard's write side has nothing to trip here), accumulates touched paths, and injects at most one message via the `context` extension event (the same channel `clients/runtime-context.ts` already uses for turn-end findings) — e.g. `pi-lens: 2 file(s) were autofixed after your last turn: a.ts, b.ts — working-tree changes to these are expected; re-read before editing.` The accumulator is cleared **only** on actual injection, never on `turn_start`/`agent_end`/`agent_settled` — `context` fires before every provider call including the first call of a brand-new run, so a file autoformatted at a previous run's `turn_end` still nudges at the next run's first turn (the `git status` at the top of a fresh session shouldn't cost the agent an investigation). Kill switch `PI_LENS_AGENT_NUDGE=0`.

### `pilens:diagnostics` — the second bus surface (#502)

`clients/diagnostics-publish.ts` is a sibling module to `bus-publish.ts` (not folded into it — it owns its own module state: a `reportedDirtyPaths` set for clean-transition tracking and a `seq` counter), sharing only the `PI_LENS_BUS_PUBLISH` kill switch and the `pi.events.emit` binding wired at the same `index.ts` call site. It extends the #482 family from "which files changed" to "what pi-lens knows about them" — feeding terminal-native diff/review extensions (e.g. an interactive diff-review surface, split/unified diff rendering) rich enough data to render pi-lens's findings as inline annotations in THEIR views, rather than pi-lens owning a review UI. `tests/config/diagnostics-bus-conformance.test.ts` pins its publisher census and the intentional broadcast-only empty subscriber census.

**Emission seam:** `publishDiagnostics` fires in `clients/pipeline.ts` immediately after `recordDiagnostics` (`clients/widget-state.ts`) commits a write batch's final per-file diagnostic set — i.e. after format, autofix, and dispatch have all run for that batch. This is deliberate: it guarantees the event reflects post-batch LATEST state, never an intermediate runner result, because `recordDiagnostics` is itself the single point where the batch's diagnostic outcome becomes final.

**Staleness contract (LSP `publishDiagnostics` semantics, load-bearing — not cosmetic):** full-replace per file (never a delta — an event mentioning path P replaces everything previously held for P), explicit-clean (`diagnostics: []` fired exactly once on a dirty→clean transition, tracked via the module-level `reportedDirtyPaths` set so `wasPreviouslyReportedDirty` tells a caller whether a now-clean file needs an explicit `[]`), monotonic `seq`+`ts` (higher `seq` always wins on out-of-order receipt), and `pilens:files:touched` (#482) as an INVALIDATION HINT — a consumer should treat a touched path's held diagnostics as provisional until the next `pilens:diagnostics` event mentions it. Full contract: `docs/features.md`.

**Caps:** 12 diagnostics per file per event (`MAX_DIAGNOSTICS_PER_FILE_EVENT`, aligned with the widget's own `MAX_STORED_DIAGNOSTICS_PER_FILE`), errors prioritized when capping, `truncated: true` on a capped entry. Before/after file content is intentionally OMITTED from v1.

**Shared schema with #478 (bound, not merged):** `PilensDiagnosticsPayload` is defined once in `clients/diagnostics-publish.ts` and MUST be reused verbatim by #478's future `pilens:rpc:diagnostics` pull response — push (this event) and pull (#478) are two deliveries of the same shape over the same lens-engine seam. #478 stays separately gated on #449 registry dogfooding; when it unblocks it is pure plumbing over an already-defined type.

**Per-edit autofix mutation boundary (#1414).** Successful `write` tool results retain immediate pipeline autofix and append the authoritative full post-fix target content to the returned content array. Every `edit` defers pipeline autofix until its owning `agent_end`; a write followed by an edit demotes later writes to deferred autofix for that path until `beginTurn`, and receipt ordering is recorded before debounce admission. The owner-scoped deferred record coalesces `kinds: Set<"autofix" | "format">`; drain order is always autofix then format, with no diagnostics between phases, and independently failed or aborted phases merge their kinds when requeued. Cargo/Dart project-wide fixers dedupe by tool plus language-project root. Concurrent-secondary `agent_end` remains excluded, so the existing session-keyed `getFormatService(sessionId, true)` seam is sufficient; no additional process singleton is introduced. The v1 queued/start bus events expose `kinds` additively.

**Fix provenance (#502):** rather than a new event, fix provenance is an ADDITIVE optional `fixes?: FixProvenanceEntry[]` field on the existing `FilesTouchedPayload` (#482) — old consumers unaffected, satisfies the frozen-additive discipline, and the data (autofix tool names, format tool names) was already being collected at every `publishFilesTouched` call site for the #484 turn-summary. Attribution is best-effort where the underlying tool runner can't report a per-changed-file breakdown (a multi-tool autofix batch attributes every tool that fired to every file the batch changed); precise where it can (deferred-format's per-file `formattersUsed`, the actionable-warnings autofix's single `lsp-quickfix` tool).

### Cross-process extension (#492)

The #482 bus and the #485 accumulator are both in-process — nothing crosses a real process boundary, but subagents spawn actual child `pi` processes (the nicobailon/pi-subagents model). `clients/recent-touches.ts` is the shared substrate: a project-scoped `recent-touches.json` (`getProjectDataDir(cwd)`, ~50-entry ring buffer, atomic tmp+rename — same pattern as the #474 instance registry) that every instance both appends to and reads from. The producer is wired into the *existing* `publishFilesTouched` call (not a new seam) so every current and future bus-publish call site gets cross-process propagation for free, independent of whether a `pi.events` bus is even wired. Two consumers feed entries into the SAME `_touched` accumulator via a new `recordCrossProcessTouches` export (never a second accumulator, never a second injected message): a **child at `session_start`** (`readCrossProcessTouchesForSessionStart`) and a **parent at `turn_start`** (`readCrossProcessTouchesForTurnStart` — mtime-gated, one `fs.stat` per turn when nothing changed, plus a consumed-ts cursor so an entry never re-surfaces). BOTH readers apply the same shared baseline filter (foreign pid + 15-minute freshness window + file still exists — `passesForeignEntryFilter`, one private helper so the two can never drift); the ring buffer caps count, not age, so without the freshness filter a fresh process's first read would nudge about days-old touches of since-deleted files. Beyond that baseline, the parent deliberately has NO read-guard drop path (a parent about to commit needs attribution even for files it hasn't read this session). `AccumulatedFile.origin` (`"local" | "cross-process"`) tracks provenance; **local is sticky** — a file reported by both channels reads as local, never cross-process, because the session's own bus having seen it makes the "another instance did this" framing stale. `consumeAgentNudge` attribution is three-way and never assigns a local file to another instance: all-local keeps the #485 wording ("after your last turn"), all-cross-process reads "by an automatic run outside your turn", and a mixed batch reads "after your last turn (N of them by an automatic run outside it)" — always exactly one message. Kill switches — note BOTH gates affect the cross-process feed: `PI_LENS_AGENT_NUDGE=0` disables the record producer and both consumers (the #485 switch, no new env var), and `PI_LENS_BUS_PUBLISH=0` also silences the record append because the producer lives inside `publishFilesTouched` (both deliveries of a touch — bus and record — die together behind that gate). NOT gated on subagent light mode (#449) since this is a cheap file read. No IPC/daemon/`fs.watch` — passive file only, per the #449 no-daemon doctrine.

**`ast_grep_search` agent UX contract.** The tool accepts expert `pattern`/raw `rule` syntax plus `nodeKind` (an exact, language-specific grammar-kind escape hatch) and `hasDescendantKind` (explicit recursive matching); `hasKind` intentionally keeps ast-grep's immediate-child semantics. `details.matchLocations` and `details.searchReads` must stay aligned with the displayed, bounded `maxMatches` page. Searches carry the combined abort signal and a shared deadline through `SgRunner`; subprocess output is capped, generated-rule/validation CLI failures surface as errors, and status-one with no diagnostic output remains a genuine no-match. The lazy tool is activated through `pi_lens_activate_tools` and becomes visible on the next turn. A future canonical language-neutral `query` facade must compile through this existing rule path with per-language adapters; do not pretend raw grammar kinds are universal.

## TUI rendering: the width contract (#513 — hard-won)

pi-tui **hard-crashes the whole host process** (`uncaughtException: Rendered line N exceeds terminal width`) if ANY line returned by a `Component.render(width): string[]` implementation is visibly wider than the terminal — a single over-width line took down a live session in #500's first real dogfooding run. Rules:

- Every raw `Component` pi-lens hands to the host (currently the footer widget in `clients/widget-state.ts` and the turn-summary renderer in `clients/turn-summary-render.ts`) MUST fit every line via `fitLine`/`fitLines` from `clients/tui-fit.ts` — the shared shim that also handles the two incompatible `truncateToWidth` signatures (pure-JS pi-tui string-ellipsis vs native `@oh-my-pi` enum). Never call `truncateToWidth` directly.
- Surfaces the HOST wraps for us are safe without fitting: `ctx.ui.notify` and the tool-summary compact renderers (`tools/render-compact.ts`) build on pi-tui's own `Text`/`Markdown` components, which word-wrap internally. A 2026-07-11 audit bucketed every render surface; only raw `render(width)` implementations carry the hazard.
- Tests for renderers must measure with the REAL `visibleWidth` (ANSI/OSC8-aware) against a narrow width — mock-based render tests are exactly what let #513 ship.

## Host run mode owns terminal behavior (#1334 S2)

`ExtensionContext.mode` is `"tui" | "rpc" | "json" | "print"` (pinned host
types, line 208). **Never guess terminal ownership — read it.**
`clients/extension-mode.ts` is deliberately STATELESS: `mode` rides on the ctx
handed to every event and command handler, so each call site reads the ctx it
already has rather than consulting a latched global that a session replacement
would leave stale.

Two predicates, deliberately NOT the same one:

- `supportsTuiWidget(mode)` — terminal-only custom components (the diagnostics
  widget). `tui` only. **`rpc` is excluded despite `hasUI: true`** — dialogs
  travel over the protocol there, a `belowEditor` component does not.
- `suppressesUserNotify(mode)` — proactive chatter. Suppressed (logged, not
  rendered) in `print`/`json`, which are one-shot runs whose stdout belongs to
  the run's actual output.

All user-facing notifies in `index.ts` go through the local `notifyUi(ctx, …)`
helper — add new ones there, never a bare `ctx.ui.notify`. The
`wireUserNotifier` getter applies the same predicate, so `clients/`-level
degradation notices (#1333) become log-only in those modes too, via
user-notify.ts's existing fail-soft "no host wired" path.

`"unknown"` (older host with no `mode`, or a mode a future pi adds) keeps
current behavior in BOTH predicates — never guess a suppression that could hide
output. This is complementary to and independent of the #1338/#1333 console
guard, which enforces "never write raw to the terminal"; mode decides whether
the host's own render path should be used at all.

## ast-grep rules

Rules live in `rules/ast-grep-rules/rules/*.yml` (plus the multi-rule `rules/ast-grep-rules/slop-patterns.yml`); disabled rules sit in `rules/ast-grep-rules/rules-disabled/` (sibling dir — not loaded). Run by `clients/dispatch/runners/ast-grep-napi.ts`. Discovery is RECURSIVE (#516) — language subdirectories load too; this is what activates the vendored CodeRabbit CWE catalog (`rules/ast-grep-rules/coderabbit/rules/**`, ~184 rules, ~13 of them TS/JS-live), pinned by a regression test asserting a nested CodeRabbit rule fires via NAPI.

**TS/JS rule twins have two execution surfaces.** The ast-grep CLI/LSP language-gates by `language:`, so a `language: TypeScript` rule does **not** cover standalone `.js` files in the shipped ast-grep LSP baseline; user-facing TS/JS rules that should fire in JS usually need a `-js` twin with `language: JavaScript` and its own fixture. The in-process `ast-grep-napi.ts` fallback is different: it skips only rules whose `language:` is *neither* TypeScript nor JavaScript, parses each target file with its OWN grammar (`.ts`→ts, `.js`→js), and runs every remaining TS/JS rule. A grammar-agnostic twin can therefore duplicate in fallback mode, while a grammar-divergent twin is still required (canonical example: `no-flag-argument`, where a default parameter is `required_parameter` in TS and `assignment_pattern` in JS). When changing this policy, fix fallback dedup/normalization explicitly rather than relying on CLI behavior. Full authoring guidance: the `pi-lens-write-ast-grep-rule` skill.

**HTML embedded-`<script>` coverage (#2347) is part of the napi fallback's contract.** The ast-grep CLI/LSP (verified against 0.45.1) resolves every HTML `<script>` body as JavaScript and runs `language: JavaScript` rules inside it; the napi fallback must match, because under Gate B it substitutes for that LSP. `evaluateAstGrepRules` (the shared seam the per-edit runner and the project scanner both call) reparses each `script_element` body with the addon's `js` grammar and runs JS rules there, translating findings back to file coordinates. The translation stays in ONE unit: `@ast-grep/napi`'s `Pos.index`/`column` are UTF-16 code-unit offsets, so the line-start table is built from the JS string, never from UTF-8 bytes — a byte table shifts every coordinate after a multibyte character. Injection is UNCONDITIONAL — `type` and `src` do not suppress it (the CLI behaves that way); `type="text/template"` and `type="application/json"` bodies are scanned all the same. Only `language: JavaScript` rules enter scripts: TS/TSX and CSS rules keep the file-mismatch filter, matching the CLI (a `.ts` twin never fires on script content). `<style>` bodies are NOT injected (0.45.1 does not, verified) — that is an accepted divergence, recorded in `clients/lsp/server.ts`'s ast-grep comment. Callers of `evaluateAstGrepRules` that want HTML embedded coverage must pass the file `content` and the loaded `sgModule`; without them an HTML file's JS rules stay mismatch-skipped, and the `astgrep_napi_unsupported_rules_skipped` record carries `htmlInlineScriptCount` on HTML entries so "no injection target" stays countable. The evaluation is budget-bounded (`MAX_SCRIPT_BODIES_EVALUATED` + `MAX_SCRIPT_BODY_BYTES_EVALUATED`, applied before any grammar parse to EVERY body, first one included) because the work is `rules * bodies * body-size`; a generated page with thousands of `<script>` tags — or one ~1 MiB dense inline body — otherwise stalls the per-edit hook for seconds (a single oversized first body measured 19.5 s before the caps bound it too). Every silent failure mode and the budget cut emits a bounded, discriminating degradation record (kinds `ast-grep-napi-html-*` in the ledger; subjects are the file path) so "no embedded findings" stays distinguishable from "coverage was dropped". Adding an ast-grep embedded content axis to one route means adding it to both.

**Cross-validation against the upstream playground:** `scripts/playground-verify-rule.mjs` is a headless-CDP tool that loads a rule and a `--code` fixture into the official [ast-grep playground](https://ast-grep.github.io/playground.html) and reports the match count the playground's own engine produces against that fixture. This is a *second opinion* against the local CLI test — useful for catching both pattern-level drift between the version of `ast-grep` pinned in `package.json` and the version the upstream binary ships, and rule-vs-source disagreements. (#2208: earlier versions wrote `--code` into the playground's Pattern-mode-only `query` field instead of `source`, so every run silently graded the playground's own hardcoded sample instead of the fixture — every "ok:true" was a smoke test that the rule loaded, not evidence the fixture matched. Fixed; see `docs/astplayground.md` for the field split and the scrape sentinel that now catches a recurrence.) See `docs/astplayground.md` for the architecture, limitations, and CLI surface.

- **Native napi engine (#206).** The runner matches every rule through napi's own engine — `root.findAll({rule, constraints})` — fed by a faithful `js-yaml` parse (`parseSimpleYaml` is a thin `js-yaml` wrapper). The old hand-rolled YAML parser + ~240-line interpreter and the `ast-grep-native-rules` flag are **gone**. The full grammar works: nested `any`/`all`/`has`, `inside`/`follows`/`precedes`, `field`, `nthChild`, and metavariable `constraints`. A rule napi rejects is skipped (never partially evaluated).
- **`has`/`inside` default to the immediate child/parent** (`stopBy: neighbor`). Add `stopBy: end` for a recursive descendant/ancestor search — required when the target isn't a direct child (e.g. `switch-without-default` needs it: `switch_default` lives under `switch_body`). Conversely, leave direct-child `has` at the default or it over-reports (`throw has string` + `end` flags `throw new Error("x")`).
- **Quote YAML-special scalars** — `js-yaml` throws on `message: !!x` or a bare `:` in a value and the rule is silently dropped.
- **Use tree-sitter-typescript kind names**, not TS-compiler/Roslyn: `subscript_expression` (not element_access_expression), `member_expression` (not property_access_expression), `statement_block` (not block), `for_in_statement` (covers for...of). A wrong kind → napi rejects the whole rule.
- **Prefer patterns over regex.** Patterns (`$F($A, $B)`) are AST-aware — whitespace/formatting-insensitive, capture semantic structure, and don't false-positive on comments or strings containing similar text. Regex is appropriate for: (a) literal-string shape detection on `kind: string` (e.g. `^AKIA[A-Z0-9]{16}$`), (b) keyword-arg presence checks on `kind: keyword_argument` (e.g. `^timeout\s*=`), (c) case-insensitive name lists (`(?i)^(secret|password|...)$`). For everything else — call shape, method chains, two-token forms — use patterns. Mixed approach (pattern + has: keyword_argument regex) is the idiomatic way to detect "call has kwarg X". String-literal regexes match SOURCE text, not runtime values: inspect with `ast-grep run --kind string --json=compact`; matching a source `\\` requires four regex backslashes (see `incomplete-string-escaping`, #332, which also excludes control/generic `\\n`/`\\$&`-style replacements to avoid noisy sanitizer false positives).

The playground verifier's source sentinel is structurally scoped to the first `.monaco-editor` in the source pane. It must not match the config pane's rule note when fixture text collides (#2253).

### ast-grep catalog porting (detector-only, no rewrite)

Java and Kotlin ast-grep rules run through the ast-grep CLI/LSP lane because `@ast-grep/napi` bundles no Java or Kotlin grammar exports (#2215). The Java VTCode batch uses warning severity by default, and `prefer-string-is-empty` is detection-only because its suggested rewrite is not valid for every Java receiver. Keep Java rule coverage in the real CLI fixture harness; keep the NAPI resolver test limited to bundled grammars.

The upstream [ast-grep catalog](https://ast-grep.github.io/catalog) is a list of ~50 rule examples. **Ship a rule when its `rule:` block is a clean detector** (we report, we don't rewrite — the LSP is what fires). Skip rules whose value is the `fix:`/`transform:`/`rewriters:` payload rather than the detection, and skip project-specific examples (Yoda-condition debate, Ant Design Vue migration, XState v4→v5, …). Detector-only ports that filled real gaps:

- **Go:** `unmarshal-tag-is-dash` (CWE-639 — `json:"-,…"` doesn't actually omit, attacker can pass `{"-": …}`)
- **Rust:** `redundant-unsafe-function` (`unsafe fn` with no `unsafe {}` block), `avoid-duplicate-export` (`pub mod foo; pub use foo::Foo;` exposes the same item twice), `rust-2024-let-chain-candidate` (RFC 2497 hint, uses `utils:` + `matches:` cross-rule refs)
- **TS/JS:** `no-console-except-error` (debug leftover lint, allow `console.error` only inside `catch`), `missing-component-decorator` (Angular `ngOnInit` on a class without `@Component()`), `unnecessary-react-hook` (`use*` function that doesn't call another hook), `find-import-file-without-extension` (ESM `import "./local"` will fail at runtime), `redundant-usestate-type` (useState<primitive> is inferable)

The C/C++ security detector from the same catalog (`fix-format-security-error-cpp`, CWE-134 format-string vuln) is intentionally **not** ported here — it lives in the vendored CodeRabbit tier under `rules/ast-grep-rules/coderabbit/rules/cpp/security/` and would dedup-collide if also in the top-level dir. The general rule: anything CodeRabbit already ships stays in the vendor dir; the catalog port is for **style/correctness/hygiene** that CodeRabbit doesn't cover (CodeRabbit is CWE-mapped security only).

Validation: every shipped catalog rule has a positive/negative fixture pair tested through the real `ast-grep` CLI in `tests/clients/dispatch/runners/ast-grep-catalog-rules.test.ts` (the napi-based `ast-grep-rule-validity.test.ts` only covers TS/JS — the catalog test fills the Go/Rust gap). Skip-when-CLI-missing is opt-in: `ast-grep` is a dev-time tool, not a runtime dep.

**Every shipped rule has a behavioural fixture test** in `rules/ast-grep-rules/rule-tests/<id>-test.yml` (the YAML form documented at <https://ast-grep.github.io/guide/test-rule.html> — `valid:`/`invalid:` cases). The vitest wrapper `tests/clients/dispatch/runners/ast-grep-rule-tests.test.ts` shells out to `ast-grep test -c .sgconfig.yml --skip-snapshot-tests` and asserts (1) every test file's `id:` matches a real rule in `rules/`, (2) every shipped rule has a fixture (TS/TSX/JS/Python/Rust/Go), (3) all fixtures pass behavioural coverage. The wrapper is opt-in when `ast-grep` CLI is on PATH (same pattern as the catalog test). The `--skip-snapshot-tests` flag is intentional — we want does-fire/doesnt-fire coverage, not byte-exact message/span output (snapshot drift is a per-rule maintenance burden that adds nothing for behavioural coverage). Why this file exists alongside the other two: `ast-grep-rule-validity` catches malformed rules (PARSE), `ast-grep-catalog-rules` covers ~10 hand-picked rules (BEHAVIOURAL), this file covers ALL shipped rules across ALL language families (BEHAVIOURAL, comprehensive). The two behaviour tests use different mechanisms on purpose: catalog writes `.ts` snippets via the test runner and shells out to `ast-grep scan`; this file uses the dedicated `ast-grep test` framework which is what the ast-grep maintainers recommend for the `<id>-test.yml` form. The config name is `.sgconfig.yml` (with the dot) because pi-lens's internal `runner-helpers.ts` looks for that name; `ast-grep test` defaults to `sgconfig.yml` (no dot), so the wrapper passes `-c .sgconfig.yml` explicitly. **Known JSX gap (closed by 0.44.0):** ast-grep 0.42.0's CLI pattern matcher didn't emit `jsx_element`/`jsx_attribute`/etc. kinds AT ALL — so any rule with JSX patterns (TSX or JS-with-JSX, e.g. `inline-styles`, `jsx-boolean-short-circuit`, `no-nested-links`, `no-string-ref`, `unnecessary-react-hook`, `no-blank-target-js`) reported "Missing" in the wrapper even when its test cases were correct — a test-framework limitation, not a rule bug. Pinning the dev-time `ast-grep` CLI to **0.44.0** (matching the `@ast-grep/cli` + `@ast-grep/napi` `^0.44.0` runtime pin in `package.json`) closed the gap: the wrapper now reports 246/0 instead of 242/2. Two rules needed structural rewrites to use the working matcher surface: `no-blank-target-js` switched from inline JSX patterns (which the CLI can't tokenize) to `kind: jsx_element` + text-regex; `jsx-boolean-short-circuit` switched from `has: pattern: $COND && $JSX` (JSX-in-pattern is opaque) to a root `pattern: $COND && $JSX` (metavars bind at the binary_expression level) + `all:` constraints. The wrapper still has the `cliFrameworkGap` filter as a regression guard for any future ast-grep release that re-introduces the gap (e.g. for a new language family). The wrapper's `readdirSync(RULES_DIR)` was also made recursive (a `walk()` helper) so per-language subdirs (e.g. `rules/python/`) are supported without breaking the rule-id-vs-fixture match check. **15 originally-broken rules surfaced by the TS fixtures, fixed:** (1) `no-any-type` — wrong kind chain (`has: predefined_type` was no-op through the type_annotation parent); switched to direct `kind: predefined_type + regex: ^any(\[\])?$` and added `as any` patterns; (2) `no-extra-boolean-cast` — `has: { field: operator, regex }` is a no-op because `!` is a token, not a node child; switched to `pattern: !!$X + inside stopBy: end` against the boolean contexts; (3) `no-implied-eval` — patterns only matched 1-arg setTimeout/setInterval; added `, $$$REST`; (4) `no-javascript-url` — `regex: ^javascript:` didn't match because the literal text includes the opening quote; switched to `regex: '^"javascript:'`; (5) `no-sql-in-code` — needed `has stopBy: end` (the SQL string is 2 levels below the call_expression) and `, $$$REST` for parameterized queries; (6) `hardcoded-url` — `$X = $URL` pattern didn't match; switched to `kind: variable_declarator/assignment_expression + regex: '"https?://'`; (7) `jwt-no-verify` — patterns only matched 1-key object literals; added `, $$$REST` and `$$$BEFORE, $KEY, $$$AFTER` shape; (8) `ts-json-stringify-parse` — added no-options form alongside the `, $$$REST` form; (9) `ts-manual-array-contains` — added `=== -1` / `== -1` / `> -1` variants; dropped `>= 0` / `< 0` as false positives (those are legitimate positional queries); (10) `ts-nullish-coalescing-opportunity` / `ts-optional-chaining-default` — added `!= null` and `!== null && !== undefined` variants next to the original; (11) `ts-parseint-no-radix` — added `Number.parseInt` form; (12) `weak-rsa-key` — patterns required trailing `, $$$`; added no-options form; (13) `array-callback-return` — `Array.from($, $FUNC)` with anonymous `$` metavar didn't bind in `inside any:`; renamed to `$SET`; (14) `no-relative-cross-package-import` — `from "..."` quote boundary was opaque to the pattern; switched to `kind: import_statement + regex` (two regexes — one for the `from` form, one for the side-effect import form `import '../../../x.css'`); (15) `no-inline-styles` / `no-string-ref` — `has: { field: <name> }` is a no-op for the field name (the field constraint doesn't narrow the child search); switched to direct regex on the jsx_attribute text + `has: kind: ...` for the value subtree. **5 more rule fixes from non-TS fixtures:** (a) `no-bare-except` — original `not: has: kind: identifier, stopBy: end` walked all descendants, so the rule only fired when the except body had no identifiers (the OPPOSITE of correct); fixed to check direct children for any of `identifier` / `tuple` / `as_pattern` to cover `except E` / `except (E, F)` / `except E as e` shapes; (b) `no-comparison-to-none` — added reversed forms `None == $X` / `None != $X`; (c) `no-mutable-default` — `kind: list` only caught `[]`; expanded to `any: [list, dictionary, set]`; (d) `no-blank-target-js` — JSX pattern with two named multi-metavars (`$$$PROPS`, `$$$CHILD`) didn't bind; switched children to anonymous `$$$`; (e) `no-global-eval-js` — added `new Function($$$ARGS)` variant (modern usage). `no-nested-links` must constrain the matched `jsx_element` to the **outermost** opening tag named `a`; testing only for an anchor descendant flags every non-anchor wrapper and sibling-link container, while omitting the recursive ancestor guard reports every anchor in a deep chain. Its fixtures pin wrappers, siblings, and nested anchors through intermediate JSX (#1076). The TSX Tree-Sitter sibling uses the `no_nested_anchor_chain` post-filter because its query language cannot express arbitrary-depth descendants plus ancestor exclusion in one structural query; keep both production paths at one outermost blocking diagnostic.
The subset of catalog rules with a non-trivial `fix:` field (`no-console-except-error(-js)`, `redundant-usestate-type`, `jsx-boolean-short-circuit`) gets an extra end-to-end test that runs the rule through `ast-grep scan --json=compact` and asserts the emitted `replacement` field matches the expected post-fix text. This guards the `fix:` wiring through the same engine the LSP exposes as a codeAction — the napi runner only reads `rule.fix` as a string, so a typo in a metavar name wouldn't be caught by the runner alone.

The rich pattern form (`{context, selector}`) — needed for `missing-component-decorator` — used to crash the napi runner via `isOverlyBroadPattern` calling `.trim()` on what is actually an object. Two guards fix it: `isOverlyBroadPattern` treats non-strings as "not broadly-bare" and `isStructuredRule` recognises the rich form as structure (so a rule whose only top-level structure is the rich pattern isn't dropped by the runner's safety net). Both guards have unit tests in `tests/clients/dispatch/runners/yaml-rule-parser.test.ts`.

**Dogfood rule slices for #1158:** `no-raw-json-store-write.yml` and `no-win32-isabsolute-for-qualification.yml` use explicit `ignores:` for deliberate implementation/build boundaries. Their behavioral contracts are the matching `rule-tests/<id>-test.yml` fixtures, and their production false-positive scans cover `clients/`, `tools/`, and `mcp/` separately from test/build fixtures. The qualification rule delegates to `clients/path-utils.ts`'s `isFullyQualified()` seam; the JSON rule delegates to the atomic-write seam, while installer lock writes and build scripts remain out of scope.

### SonarCloud Python rule ports (BLOCKER severity)

The TS catalog port above targets ~50 ast-grep-catalog examples. For **Python**, the more productive target is the SonarCloud rule set (95 BLOCKER rules for Python as of 2026-06). The port priority is **purely-syntactic BUG/CODE_SMELL/VULNERABILITY rules** that don't need type info — the ones we can express cleanly as ast-grep patterns. Skip anything requiring control-flow analysis (e.g. `S935` function return-type verification), type inference (`S5607` operator-type compatibility), or framework-specific deep knowledge (`S8490` enum + dataclass interaction).

**Shipped so far (37 rules):**

**Batch 1 (commit `560ccce`, 11 rules):** `no-init-return` (S2734), `no-return-value-in-generator` (S2712), `no-yield-return-outside-function` (S2711), `no-raise-stopiteration-in-generator` (S8493), `no-assert-tuple` (S5905), `no-notimplemented-in-bool` (S7931), `no-numpy-nan-equality` (S6725), `only-strings-in-dunder-all` (S2823), `no-html-autoescape-off` (S5439), `no-jwt-hardcoded-secret` (S6781, **removed in batch 3**), `no-hardcoded-password` (S6437).

**Batch 2 (commit `88590a3`, 15 rules):** `no-comparison-to-true-false` (S2159), `no-flask-secret-key-literal` (S6779), `no-duplicate-kwarg` (S5549), `no-aws-access-key-literal` (S7625), `no-boolean-in-except` (S5714), `no-except-non-exception` (S5708), `no-xxe-vulnerable-xml-parser` (S2755), `no-http-headers-bracket-access` (S8371), `no-flask-sendfile-without-mimetype` (S8385), `no-requests-without-timeout` (S3500), `no-uvicorn-non-import-string` (S8397), `no-secret-in-env-var-name` (S6418), `no-jinja2-autoescape-off` (S5247), `no-singledispatch-on-method` (S8505), `no-testclient-text-without-content` (S8405), `no-fastapi-router-prefix-outside-init` (S8413, **removed as too noisy**), `no-flask-preprocess-request-ignored` (S8375), `no-method-field-name-collision` (S1845).

**Batch 3 (uncommitted, 10 rules):** `no-server-bind-wildcard` (S8392), `no-db-string-literal-password` (S2115), `no-identity-operator-on-literals` (S3403), `no-template-string-concat` (S7943), `no-mutable-contextvar-default` (S8508), `no-dunder-exit-wrong-arity` (S2733), `no-aws-apigateway-no-auth` (S6333), `no-aws-s3-public-access` (S6265), `no-only-defined-names-in-dunder-all` (S5807), `no-yield-from-non-iterable` (S3862).

**Net shipped: 37 SonarCloud Python BLOCKER ports (out of 70 BLOCKER + 2 syntax-only rules).**

Two key gotchas hit during porting:

- `inside: { kind: function_definition, has: { ... }, stopBy: end }` is the canonical pattern for matching a function body — the `block` intermediate node means `inside` needs `stopBy: end` to reach the function_definition parent.
- `has: { kind: identifier, stopBy: end }` matches identifiers ANYWHERE in the descendant tree, not just direct children. For inside-a-list scans, wrap the list check (`has: kind: list, has: kind: identifier`) so the identifier check scopes to list items only.

**Removed rules (replaced by CodeRabbit coverage or too noisy):**

- `no-jwt-hardcoded-secret` (S6781) — removed in batch 3 because CodeRabbit's `jwt-python-hardcoded-secret-python.yml` covers it more comprehensively (handles variable-first patterns).
- `no-fastapi-router-prefix-outside-init` (S8413) — flagged every `.include_router()` call as too noisy.
- `no-router-include-before-parent` (S8401) — same noise issue.
- `no-flask-204-with-body` (S8400) — couldn't pattern-match multi-line decorated functions in ast-grep.
- `no-fastapi-file-body-in-upload` (S8389) — same multi-line pattern issue.
- `no-static-method-without-decorator` (S5719) — Python decorator AST is sibling-of-function, hard to scope.
- `no-invalid-open-mode` (S5828) — open mode character set is hard to express without proper mode validation.

**Skipped (require type info or framework-specific deep knowledge):**

- S3494 (slots cross-reference), S935/S930 (return-type/arity), S5607 (operator-type compatibility), S8490 (enum + dataclass interaction)
- S5632 (raise derives-from-BaseException), S5756 (calls to non-callable), S5642 (`in`/`not in` operand types)
- S5953/S3827 (forward-reference detection), S2275 (format-string mismatch), S1845 (covered but limited)
- S2190 (infinite recursion), S1451 (license headers), S3516 (return invariance)
- S2876 (`__iter__` returns iterator), S8414 (CORSMiddleware ordering), S8401 (router ordering)
- S6333/S6265/S6270/S6302 (other AWS-specific), S5722/S5724 (special-method arity)
- S8494 (slots attribute cross-ref), S2275 (format-string runtime errors)

Two key gotchas hit during porting:

- `inside: { kind: function_definition, has: { ... }, stopBy: end }` is the canonical pattern for matching a function body — the `block` intermediate node means `inside` needs `stopBy: end` to reach the function_definition parent.
- `has: { kind: identifier, stopBy: end }` matches identifiers ANYWHERE in the descendant tree, not just direct children. For inside-a-list scans, wrap the list check (`has: kind: list, has: kind: identifier`) so the identifier check scopes to list items only.

### Two-tier rule baseline (native + vendored)

The shipped ast-grep baseline that runs on every file dispatch is composed from **two recursive rule trees**, merged through the synthesized `sgconfig.yml` produced by `clients/sgconfig.ts`:

1. `rules/ast-grep-rules/rules/` — **native pi-lens rules**: hand-authored style/correctness/hygiene rules (the catalog port above, plus the slop-patterns split, plus existing TS/JS best-practice rules). The bar for adding a rule here is low — the rule has to be a useful permanent lint.
2. `rules/ast-grep-rules/coderabbit/rules/` — **vendored [CodeRabbit ast-grep-essentials](https://github.com/coderabbitai/ast-grep-essentials) at commit `73120109bf45c284d0cd8a37bdd7082e80e92e87`** (Apache-2.0, see `rules/ast-grep-rules/coderabbit/LICENSE`): ~184 CWE-mapped security rules across 12 languages (C/C++/C#/Go/Java/JS/Kotlin/PHP/Python/Ruby/Rust/Scala/Swift/TS). Vendored with the upstream commit pinned — bumping the vendor is a deliberate operation, not a `git pull`. The CodeRabbit README documents the utility-id normalization (ast-grep rejects utility ids with reserved characters — upstream `utils:` names like `gRPC ...(...)` are rewritten to safe names and matching `matches:` refs follow).

**Rule-ID precedence is shared by raw LSP and NAPI (#497):** `clients/sgconfig.ts` is the discovery seam for both paths, ordered project primary → project secondary/CodeRabbit → bundled native → bundled CodeRabbit. Discovery is recursive and deterministic. The synthesized raw config contains one per-process, per-workspace merged rule directory; lower-layer same-ID definitions are filtered so a project rule overrides its bundled twin without making `sg` reject the config. Same-layer duplicates are deliberately retained for raw ast-grep validation, and NAPI emits an equivalent blocking configuration diagnostic instead of silently choosing. Project-rule caches fingerprint relative paths plus contents, so equal-size/preserved-mtime edits, renames, additions, and removals invalidate correctly. Avoid reintroducing independent rule-dir lists in either path. Even though cross-tier collisions now have defined precedence, a native/CodeRabbit duplicate remains a maintenance hazard; the catalog port still checks CodeRabbit first and skips anything already vendored.

NAPI routing and enabled-rule coverage are bidirectional: every enabled catalog
language has a delivery route, and every NAPI-routed language has at least one
enabled rule. `ast-grep-napi-language-coverage.test.ts` enforces both directions
against the shared `getAstGrepRuleSources` census. Normalize catalog `language:`
values to lowercase before ANY comparison — the corpus mixes case across
nearly every language (111 `TypeScript` vs 31 `typescript`, 47 `Python` vs
52 `python`, ...), so a raw-case comparison is wrong somewhere on every
language, not just HTML. Runtime lowercases (sgconfig.ts, ast-grep-napi.ts);
tooling that compares raw is the recurring gap — #2331's one real member was
the catalog overlap key (fixed with a missing-field guard); the audit script
has normalized at its parse site since #657, a review false positive corrected
in #2339's record. Keep the corpus's mixed-case tags intact and normalize at each tooling
comparison site rather than rewriting source data; regression coverage must
pin that boundary. (#2325, #2331)

A target repository that supplies its own `sgconfig.yml` / `sgconfig.yaml` at the workspace root takes precedence — pi-lens respects the project config instead of injecting its baseline.

## Tree-sitter rules

Rules live in `rules/tree-sitter-queries/<language>/`. Disabled rules are in `rules/tree-sitter-queries/<language>-disabled/` — they load in tests (via `getAllQueries()`) but are excluded from the production dispatch runner (which calls `getQueriesForLanguage("typescript")`).

**`inline_tier` values:**

- `blocking` — finding blocks the agent turn (🔴 injected)
- `warning` — advisory finding
- `review` — low-priority suggestion

**Currently blocking TypeScript rules (security):** `debugger`, `default-not-last`, `duplicate-function-arg`, `empty-switch-case`, `eval`, `infinite-loop`, `self-assignment`, `sql-injection`, `switch-case-termination`, `unsafe-regex`, `ts-command-injection` (S2076), `ts-ssrf` (S5146), `ts-xss-dom-sink` (S5696), `ts-dynamic-require` (S5335), `ts-open-redirect` (S6105), `ts-nosql-injection` (S5147).

**Tree-sitter query authoring — critical constraint:**  
`[...]` alternative groups require ALL alternatives to share the same capture names. If two groups of patterns need different captures (e.g., assignment patterns with `@PROP/@VALUE` vs call patterns with `@OBJ/@FN/@ARG`), split into two separate `[...]` blocks:

```
[ (assignment_expression ...) @PROP @VALUE ... ]
[ (call_expression ...) @OBJ @FN ... ]
```

Mixing different capture names in one `[...]` block causes tree-sitter to silently return zero matches (no compile error). Similarly, field values cannot be alternative groups: `right: [(identifier) (call_expression)]` is invalid — expand into separate alternatives or separate blocks.

**Post-filters** (`post_filter` in YAML, `applyPostFilter` in `clients/tree-sitter-client.ts`): evaluated after query matching to reject false positives. Key ones: `count_params` (long-param-list: excludes optional/defaulted params), `ts_ssrf_sink` (requires URL to look like external input), `check_secret_pattern` (variable name must match secret-sounding pattern).

## Experimental git guard (#1063)

`--lens-guard`/`guard.enabled` is strictly opt-in and defaults false. It analyzes actual git commit/push executable invocations through the shared shell tokenizer, then consults the existing structured `turn-end-findings` record only for those attempts. Only current blocking findings gate (blocking test failures follow the repository's blocker semantics); advisory findings do not. The record is session/project/file-sequence bound, clean turns invalidate it, and malformed/stale/ambiguous blocker state blocks conservatively; advisory records never gate. Runtime per-file blockers aggregate through the normalized `PathKeyedMap`, so a clean later file cannot erase an unresolved earlier file. Decision telemetry uses the existing latency logger and contains no command text or source.

## Test requirements

LSP acquisition-race tests suspend the initialize/create-client seam with
`tests/clients/interleaving-kit.ts`; do not use timing sleeps. Assert the
in-flight owner, lease count, publication cleanup, and shutdown reap so an
aborted waiter cannot pass while pinning or orphaning a client.

A new always-absent dependency stub (a `vi.mock`/fixture that makes a dependency permanently unavailable) must ship with at least one present-path **behavior** test: the dependency's result must reach the caller, never just a bare no-throw assertion. #1251 is the failure case; #1310 is the pattern to follow.

Every commit that adds or changes logic **must** include relevant tests before pushing. No exceptions:

Registered-or-fail sweep floors are calibrated from the live population at the
time of change, normally at half-population with a documented count. The
meta-sweep in `tests/config/sweep-floor-coverage.test.ts` detects the natural
enumeration-plus-empty-assertion shape and requires proof of floor use in the
same file; imports alone do not register a sweep. Static detection remains
evadable by construction, so its exception map records intentional non-sweeps.

- New functions → unit tests covering the happy path, edge cases, and error paths.
- New tool parameters → tool-level routing tests verifying the parameter reaches the right handler.
- Bug fixes → a regression test that would have caught the bug.
- Run `npm test` (or `npm run build && npm test` if `.js` artifacts may be stale) and confirm all tests pass before committing.
- **Also run `npm run lint` before pushing — especially for test-file changes.** `npm run lint` (`tsc -p tsconfig.json`) is the strict CI gate and type-checks the `tests/` tree; `npm run build` (`tsconfig.build.json`) **excludes tests** and `build:dist` uses `--noCheck`, so a type error in a test compiles clean locally but fails CI lint. (This has bitten us — build passing ≠ lint passing.)
- **Assert telemetry against real sinks, not logger mocks (#1742 direction).** When a test must verify that a log/telemetry record was emitted, prefer reading the REAL emitted bytes — `await flushLatencyLog()` then read `path.join(getGlobalPiLensDir(), "latency.log")` from the worker's hermetic `PI_LENS_HOME` — over `vi.mock`-ing the logger module. Module mocks of loggers both re-introduce the instance-binding hazards the shared-writer registry exists to remove and assert against an imaginary surface; the real file is the same bytes a smell analyzer or human reads post-merge. If the logger no-ops under vitest (test-mode guard), the sanctioned opt-out is scoping `PI_LENS_TEST_MODE=0` to the single test that needs real writes.
- **Adding an LSP server → add a smoke fixture, or the drift guard fails.** Registering a server in `LSP_SERVERS` does NOT automatically smoke-test it: the runner-level `smoke-fixture-coverage.test.ts` blanket-exempts the single `lsp` runner. `tests/clients/lsp/lsp-fixture-coverage.test.ts` is the SERVER-level guard — it fails unless every non-auxiliary server routes to an `LSP_FIXTURES` entry in `scripts/smoke-tools.mjs` (a fixture file whose extension resolves to it) and every auxiliary server is attached via a fixture's `auxiliaryServerIds`. Only the share-an-extension ALTERNATES (deno/python-jedi/omnisharp/expert) are exempt. The nightly `tool-smoke.yml` runs `--lsp --install` over the WHOLE list, so a self-contained github/npm server is then covered automatically (toolchain-gated ones — pwsh/.NET/go/rust — need the runner to provision the toolchain). `LspFixture` is typed in `scripts/smoke-tools.d.mts`.

### Test-authoring screens (#1829)

Ten screens. The first six were distilled from nine adversarially reviewed PRs on 2026-08-25 — a reviewer caught every one of them AFTER the test was written and green; screens 7-10 name the classic vacuity shapes (all-mocks, not-throw, implementation mirror, snapshot-as-behavior) added 2026-08-26. Each screen is answerable while you write the test, without a reviewer. Same form as the defect-shape catalog: **SHAPE → *Screen* (when you write X, verify Y) → *e.g.* → *Detect***. These are the authoring-time prevention for catalog shape 7; shape 7 is the review-time catch.

**Meta-rule — the red-first proof must fail for the DEFECT'S reason.** This sharpens the red-first rule stated above; it does not replace it. A red run proves nothing until you read the failure message. A `TypeError` or an "is not a function" red proves the import wiring is wrong and nothing else; PR #2084 quoted exactly that red as its proof. Confirm the ASSERTION failed, not the module load, the fixture setup, or a missing export. Quote the assertion line in the PR body, not just "it failed".

1. **A test that drives a parallel path instead of the production entry point.** *Screen:* enter at the same function production enters, through the same filters. Name the caller chain from the real trigger down to your assertion, then check your first call sits at the top of it. When a helper stands in for a production step, list what production runs at that step and make the helper run it too. *e.g.* PR #2059's round-2 test called `registerPrimarySession()` directly and skipped the real `handleSessionStart`, which wipes the anchor — green test, broken production path; PR #2061 drove a client method that `LSPService.renameFile` filters out before it can fire, so the test guarded an unreachable branch; PR #2062's real-binary helper called `child.stdin?.end()`, which production does not, so the double diverged from production at the exact seam that hung on EPIPE. *Detect:* review question: which production function does this test call first, and what runs BEFORE it in production? Related but distinct: catalog shape 14 is the same green-and-blind outcome caused by a duplicate module instance, and "Real-runner rule/dispatch tests" below states which seams may be doubled at all.
2. **A skip that reports as a pass.** *Screen:* a test that cannot run skips visibly; it never returns early. Use `it.skipIf`/`describe.skipIf` with a stated reason, never a bare `if (!x) return;` in the body. Exercise the gate in both states — precondition present and absent — and name the machine where the present state holds. A resolver inside the gate is itself a fixture: assert the path it computes. *e.g.* PR #2062 twice — `if (!binary) return;` reported "passed" while asserting nothing, then the round-2 resolver missed the `.pi-lens` path segment, so the visible `skipIf` never ran anywhere; PR #2058's Windows alias case bare-returned on Linux. *Detect:* `tests/config/vacuous-skip-coverage.test.ts` sweeps the whole `tests/` tree for this shape and fails on it — a bare `return` at a test callback's own statement level that precedes every assertion, with no `skip` call before it (detector and its declared blind spots: `tests/support/vacuous-skip-scan.ts`). It found thirteen offenders on 2026-08-25, where #2089's hand census named two. Beyond what a syntax walk can see: for every environment gate, name the lane that satisfies it. This is the general form of two existing rules: the OS-agnostic section's "skip correctly, never vacuously pass", and `assertGrammarAvailable()` in the real-runner section below.
3. **A pin at the wrong layer.** *Screen:* pin the seam that broke, not the data that seam reads. If the plumbing was wrong, drive the plumbing and let it fetch its own inputs — handing the correct input in by hand pins the registry instead. Ask whether the test would still pass if every call site hard-coded the value; if yes, it sits one layer too low. Probe a detection mechanism in BOTH directions: a case it must catch, and a case that must not evade it. *e.g.* PR #2062's argv test called `verifyToolBinary` directly WITH `tool.checkArgs`, pinning the registry and not the plumbing, so hard-coding all 15 call sites stayed green; PR #2080's conformance regex counted comments as publishers and missed aliased imports, and only a two-direction probe shows both. *Detect:* name the mutation this test must red on, then apply the mutation and watch it. The mutation-proof rule in "Contributing" is the same instrument aimed at a guard; this screen aims it at the layer you chose.
4. **A double that identifies its caller by ambient inspection.** *Screen:* a fake selects its behavior from the arguments it receives, never from a stack trace, a function name, or a file path. Ambient inspection breaks on the next rename, and it breaks silently: the double returns the wrong branch while the assertion stays green. When behavior must vary per caller, take the discriminator as a parameter or install one double per call site. *e.g.* PR #2078's `fs.statSync` double chose its return value by string-matching a private function name out of `new Error().stack`. *Detect:* grep new doubles for `.stack`, `caller`, or a name comparison; ask what the double returns after a rename.
5. **Environment mutation that outlives its test.** *Screen:* a file that calls `vi.stubEnv` also calls `afterEach(() => vi.unstubAllEnvs())`; the same holds for direct `process.env` writes, fake timers, and cwd changes. Then prove independence — run the new test alone with `-t`, not only in file order. A test that passes in the file and fails alone is reading the previous test's leak, so its truth is order-dependent. *e.g.* three PRs in the corpus stubbed env with no `unstubAllEnvs`; PR #2084's inverse test passed only because the preceding test leaked `GITHUB_*` variables. *Detect:* grep the file for `stubEnv` and confirm a matching `unstubAllEnvs`; run the new test in isolation before you push.
6. **A bound loose enough to pass a partial regression.** *Screen:* measure two numbers — the regression's count and the fixed behavior's count — and set the bound within about 2-3x of the fixed one. Record both numbers in a comment beside the assertion. Never pick a round number by feel: a bound far from the regression value passes a halfway regression and reads as protection. *e.g.* a `lessThan(100)` assertion against a regression that measured 4807; a partial regression to O(n/2) passes it untouched. *Detect:* review question: what is the fixed behavior's actual count, what was the bug's, and where does this bound sit between them?
7. **A test that mocks every collaborator and asserts only that the mocks were called.** *Screen:* at least one assertion must observe REAL behavior — a return value computed by real code, real bytes in a real sink, a real state transition. When every dependency is a double, the test verifies wiring to the doubles, and a production module that does the wrong thing with the right calls stays green. The #1742 real-sinks rule is the telemetry-specific form; this is the general one. Doubles are for the process boundary (spawns, network, clock), not for the module under test's own collaborators by default. *e.g.* no corpus instance yet — added preventively 2026-08-26. *Detect:* count `vi.mock`/`vi.fn` per test file against assertions that read something a mock did not produce; a file where every `expect` is `toHaveBeenCalled*` is the signature.
8. **A "does not throw" test as the sole assertion.** *Screen:* `expect(() => f()).not.toThrow()` passes for a function that silently does nothing — absence of an exception is not behavior. Assert what the call PRODUCED (value, state, record); keep not-throw only as a secondary guard alongside a behavioral assertion, or when the contract under test IS exception policy (and then assert the error path too, both directions). *e.g.* no corpus instance yet — added preventively 2026-08-26. *Detect:* grep for `not.toThrow` / bare `await expect(...).resolves` where the test body carries no other expect.
9. **A test that mirrors the implementation instead of verifying it.** *Screen:* the expected value must come from an independent source — a hand-computed constant, a recorded real output, a differently-derived oracle — never from re-running the same algorithm, constants, or table the production code uses. A mirrored test is wrong exactly when the code is wrong, so it can never red on the defect class it claims to cover. Deriving the expectation FROM the production seam is the same defect one layer up (screen 3's registry pin). *e.g.* no corpus instance yet — added preventively 2026-08-26. *Detect:* the test imports the same helper/constant it asserts against, or the expected-value expression is structurally the production expression; ask what implementation bug this test could even catch.
10. **A snapshot standing in for a behavioral assertion.** *Screen:* a snapshot minted from the code under test locks in whatever the code currently does — including the bug — and every later diff becomes an update-and-move-on. Assert the properties that matter (fields, counts, ordering, invariants) instead. The legitimate exception is a CHARACTERIZATION baseline minted from a different implementation to prove equivalence. *e.g.* the #2069 rank baseline was minted from master's boxed representation and diffed field-by-field against the rewrite; that baseline states its origin in a comment and is never regenerated from the code it checks. *Detect:* `toMatchSnapshot`/inline snapshots on behavior-bearing output; a "characterization" file with no comment naming the independent origin.

### Test assessment and removal (value discipline)

The screens above catch tests that are broken; this section addresses tests
that are merely worthless — redundant sibling pins, characterization tests
that outlived their purpose, load-heavy files pinning one behavior three
ways. That weight is what the suite pays for in runtime, OOM pressure, and
contention flakes.

- **Every PR that touches a test file carries a Test assessment** (the PR
  template's `### Test assessment` clause): per touched test FILE, one line
  on what behavior it uniquely pins, plus any test the PR makes redundant.
  Scope is the touched files only — never the whole suite.
- **Removal requires proof, not judgment.** A test may be removed only when
  a NAMED surviving test reds on the same mutations the removed test would
  have redded on. Run the mutations and quote the surviving red. "Low value"
  is a misjudgment this repo has made before: guards that looked redundant
  (the #2044 alias test) or vacuous (win32 skip shapes) were load-bearing.
- **Removal candidates you identify but do not delete go to the corpus
  value ledger issue** (deferral hygiene: the candidate is recorded with the
  mutation evidence it still owes, and the ledger stays open).

### Testing extension wiring (#171)

For anything that goes through the `index.ts` entry — flag/command/tool/hook registration, the `context` injection toggle, `tool_call`/`tool_result` read-guard wiring, `session_start` registrations — use the shared harness in `tests/support/pi-mock.ts` instead of hand-rolling an `ExtensionAPI`/ctx mock:

- `createPiMock(initialFlags?)` → records `flags`/`commands`/`tools`/`handlers`, backs `getFlag`, and exposes `getTool`/`getCommand`/`getHandlers`, `emit(event, payload, ctx)` to drive a hook, and `runCommand(name, args, ctx)`. Run the entry with `piLens(pi.asExtensionAPI())`.
- `makeCtx({ cwd })` → a minimal command/handler context that captures `ui.notify`/`setStatus`/`setWidget` into `ctx.notifications` / `ctx.statusCalls` / `ctx.widgetCalls`.
`tests/lens-toggle-command.test.ts` is the migration template; migrate other bespoke `createCtx`/`vi.mock` blocks to the harness opportunistically.

### Testing dispatch runners (#187)

Separate from the above — `tests/clients/dispatch/runners/*.test.ts` (and some `dispatch/rules/*`) build a `DispatchContext` (`clients/dispatch/types.ts`), not an `ExtensionAPI` mock. Use the shared `makeRunnerCtx(filePath, cwd, overrides?)` from `tests/support/runner-ctx.ts` instead of a local `createCtx(filePath, cwd)`: it fills in the real `DispatchContext` fields (`kind: "jsts"`, `fileRole: "source"`, `autofix: false`, `deltaMode: true`, a fresh `FactStore`, `hasTool` resolving `true`, no-op `log`) and lets a test override just what it needs (e.g. `{ kind: "python" }`, `{ autofix: true }`, a custom `hasTool`). `ruff.test.ts`, `oxlint.test.ts`, and `biome-check-runner.test.ts` are the migration template; the remaining ~23 `dispatch/runners`/`dispatch/rules` files with a bespoke `createCtx` are tracked in #187 for opportunistic follow-on migration.

### Real-runner rule/dispatch tests (#448)

Mock the **environment** (tool presence, network, abort/error injection) — never the **behavior under test** (parsing, matching, dispatch filtering, suppression). The #439/#440 bugs shipped because the tree-sitter runner's tests mocked the client, query loader, and review graph: a rule false-positive was invisible by construction. Rules of thumb:

- Rule behavior and dispatch filtering (per-rule `skip_test_files`, `blockingOnly`/`inline_tier`, `modifiedRanges`, cache round-trips) get REAL-runner tests: real client + real query loader + fixture on disk, via `tests/support/real-runner-ctx.ts` — `makeRealRunnerEnv()` (multi-fixture, shared cwd) / `makeRealRunnerCtx()` (one-shot), `assertGrammarAvailable()` in `beforeAll` (a missing grammar degrades silently to zero matches — "doesn't fire" assertions are vacuous without the guard), `firedRuleIds()`, `napiFallbackHasTool`. Templates: `tree-sitter-skip-test-files.test.ts`, `tree-sitter-dispatch-behavior.test.ts`, `tree-sitter-rule-cache-warm.test.ts`.
- A rule-bug fix ships a real-runner regression test (fixture in → assert fires/doesn't).
- Prefer one suite-scoped `makeRealRunnerEnv` over a temp cwd per assertion. Batch related positive and negative snippets into one fixture, then assert rule-specific line numbers so a positive elsewhere cannot hide a false positive. One-shot envs remain appropriate when isolation is the behavior under test.
- Cache round-trip coverage needs two runs against the same env (`makeRealRunnerEnv` + two `addFile`s) and an explicit cold-then-warm assertion on `queries_loaded.cacheHit`; behavior assertions alone also pass if the cache always misses. This split is exactly where the #448 `skip_test_files`-dropped-on-cache-hit bug hid.
- Tree-sitter real-runner suites may mock `recordEntitySnapshotDiff` to return no changes. That seam is unrelated post-query enrichment and otherwise launches detached review-graph work past Vitest teardown. Keep the parser, query loader, matching, and dispatch filters real.
- The LSP runner's real-dispatch coverage lives in `lsp-real-runner.test.ts`: it registers the stdio fake server from `tests/fixtures/fake-lsp-server.mjs` as a workspace custom server for a test-only extension, then exercises the production `LSPService` and runner with `makeRealRunnerEnv`. Keep server launch/protocol, diagnostics, conversion, and code-action fetching real; environment setup (custom config and binary-presence skip) is the only test seam.
- Real-wire workspace-pull tests reuse `tests/fixtures/fake-lsp-server.mjs`. Enable `FAKE_LSP_WORKSPACE_DIAGNOSTICS`, then program its response URI, delay, or JSON-RPC error with the matching `FAKE_LSP_WORKSPACE_DIAGNOSTIC_*` variables; do not create a second protocol server.
- Mocked control-flow tests (availability gates, error paths) stay legitimate and complement the above; so do the ~20 CLI runner tests that mock `safeSpawnAsync` — the seam there is an external binary, with real coverage in the nightly `tool-smoke.yml`.

## Commit conventions

- Always include the GitHub issue number in the commit subject line: `(closes #NNN)` or `(refs #NNN)`.
- Use `closes` only when the commit fully resolves the entire issue; use `refs` for any partial work.
- GitHub auto-closes an issue on any commit containing `closes #NNN` regardless of trailing text — "closes #125 Phase 1" still closes #125.

### Commit message style

**Commit messages follow the seven-rules discipline, on top of the repo's conventional-commit prefix.** See [A Note About Git Commit Messages](https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html) and [How to Write a Git Commit Message](https://cbea.ms/git-commit/). Keep the `type(scope): subject` prefix and the `(closes #NNN)`/`(refs #NNN)` issue reference (see above). Then:

1. Use the imperative mood for the subject: `add X`, `fix Y`, never `added`, `adds`, or `fixing`. Test it with: “If applied, this commit will `<subject>`.”
2. Keep the subject concise. Aim for 50 characters or fewer, with a hard cap of about 72 characters including the prefix. Do not add a trailing period. Use lowercase after the colon, matching repo style.
3. Put a blank line between the subject and body.
4. Wrap the body at about 72 columns.
5. Explain what changed and why, not how. The diff shows how. Include motivation, the problem fixed, side effects, and rejected alternatives when relevant.
6. Keep the `Co-Authored-By:` trailer.

Short, obvious changes may use a subject only. Non-trivial changes get a body.

### Documentation and prose style

**Prose in docs, changelog, and PR descriptions follows the [Google developer documentation style guide](https://developers.google.com/style) and [Simplified Technical English (ASD-STE100) principles](https://asd-ste100.org/), framed by Zinsser's four principles from *On Writing Well*: simplicity, brevity, clarity, and humanity.** Zinsser is the spirit; the two guides below are the mechanics. This is a principles-only adoption of ASD-STE100, a proprietary aerospace controlled-language specification; it does not adopt its licensed word list. Apply this standard to `README`, `docs/`, `AGENTS.md`, changelog entries, PR bodies, issue bodies, and issue and PR comments:

- Use active voice and present tense.
- Use second person (`you`) for instructions. Use the imperative for procedure steps.
- Use short sentences. Keep one idea or instruction per sentence. Aim for about 20–25 words or fewer.
- Use consistent terminology. Use the same word for the same thing every time. Do not swap synonyms.
- Use sentence case for headings.
- Define an acronym on first use. Prefer a plain word over jargon when one exists.
- Avoid gerund or noun pile-ups and ambiguous constructions. Avoid `please`. Use the Oxford comma.
- Limit em-dashes to one per paragraph, and prefer zero in anything posted to GitHub. Use periods, colons, and commas instead. Do not nest parentheticals. A sentence that wants two dashes wants to be two sentences.
- These rules are machine-checkable. Pi-lens ships a config-gated Vale runner (`clients/dispatch/runners/vale.js`). A `.vale.ini` with the Google style package would enforce this section automatically; tracked as the Vale lane of #1844's mechanical wave.

**The standard also governs how agents talk to the maintainer.** Chat replies, status updates, and reports follow the same Zinsser frame. Lead with the outcome. Strip words that do no work. Prefer short sentences over dense em-dash chains. Clarity beats brevity when they conflict. Write like a person, not a system emitting a report.

### Issue bodies

**Every agent- or maintainer-authored issue follows one shape, in this order.** Each part is one short section or a few sentences, not a form to pad. Contributor issues filed through the GitHub UI follow the forms in `.github/ISSUE_TEMPLATE/` instead; triage maps them onto this shape when an agent picks them up.

1. Evidence first. Measured numbers, quoted output, exact paths, and file:line references. The reader must see the defect before any interpretation of it.
2. Root cause, or a hypothesis labeled as one. Never present a guess as a finding.
3. Acceptance criteria that a test can decide. "Each handler tolerates a stale ctx, with one probe test per handler, red on pre-fix code" decides; "improve robustness" does not.
4. The observability record. Name the log record that proves the behavior after the fix ships, or name the gap (see the observability assessment section).
5. Cross-links. Name class siblings, the defect shape when it matches the catalog, and any PR or review that produced the evidence.

Label at creation with type and area. Keep the language rules above: short sentences, and no em-dashes except as the label separator in a bullet list.

## Observability assessment

**Every issue and every PR carries an observability assessment.** Answer one question in the body: after this ships, can someone confirm the behavior from logs alone?

- For an issue, name the record that would prove the defect is real and the record that would prove it fixed. If neither exists, that gap is part of the issue.
- For a PR, state which existing record proves the change works, or add one. A fix whose decision is invisible ships blind.
- If a change deliberately adds no telemetry, say so and say why. Silence is a choice, not an oversight.

Three failures in one day forced this rule. knip died and reported "not available" for weeks, because a timing-out probe logged nothing a reader could distinguish from a missing tool. The opengrep LSP lane starved on every edit while its CLI kept finding real issues, and no record showed the lane losing the race. Five merged fixes could not be verified from telemetry at all, which is why #1432 exists. Each was found by reading code, not logs, long after it started costing us.

Keep the records bounded, use the existing log conventions, and exclude zero-duration decision phases from `lastPhase` attribution.

Verified workspace-root guesses for a missing tool-call attribution are benign host behavior: count them in `clients/path-attribution-telemetry.ts` and emit one `path_attribution_verified_rollup` row at session shutdown. Keep non-existent or otherwise unverified guesses as full `path_attribution_missing` records with `rawFilePath` and `guessedPath`; this uses the session-rollup shape from `clients/bus-events-logger.ts`, not the degradation ledger.

The session-state registry uses `sessionStartClosureReset` when a reset must
run in `index.ts`'s `session_start` closure instead of the
`handleSessionStart` call graph. `sessionStartClosureResetNames()` derives
direct reset calls at that site and excludes nested or deferred callback bodies;
the registry checks this derived set rather than a copied list. Keep resets for
process-singleton session state behind the concurrent-secondary decision. The
primary activation owns the tally, and a secondary must never clear it.

## Issue triage & labels

Every issue should carry **one TYPE label + at least one `area:` label**.

- **TYPE (pick one):**
  - `bug` — something is broken / behaves wrong.
  - `feature` — a **net-new capability**: a command, agent tool, runner/formatter/LSP, integration, or config surface that **didn't exist**.
  - `enhancement` — **improve/harden/refactor/perf/test an existing** capability (no net-new surface).
  - `documentation` — docs only.
  - Litmus, feature vs enhancement: *does it add something a user/agent can invoke or configure that wasn't there before?* Yes → `feature`; "make the existing thing better/faster/cleaner" → `enhancement`. (GitHub's stock `enhancement` description conflates both — we deliberately split them; `feature` is green `#0e8a16`.)
- **AREA (one or more, color `#0052cc`):** `area:lsp`, `area:dispatch` (runners/linters/formatters), `area:installer` (tool auto-install / binary fetch), `area:diagnostics` (model/surfacing/suppression/project-diagnostics), `area:read-guard` (read-guard + edit substrate), `area:project-intelligence` (codebase model/scan/debt/ranking), `area:perf`, `area:observability` (telemetry/health/status), `area:session`, `area:config`, `area:security`, `area:tests`.
- Reuse GitHub defaults as needed (`good first issue`, `help wanted`, `question`, `duplicate`, `wontfix`).
- New issues (incl. agent-filed) get labelled at creation: `gh issue create … --label "feature,area:dispatch"`.

## Conventions

Dependency-boundary CI installs with `npm ci --ignore-scripts`, builds compiled
clients, then cruises the built `clients/*.js` graph; see the Dependency
boundaries CI job for current module and dependency counts. Dependency-cruiser
18 warns about TypeScript 7. Static client cycles and index eager imports use a
dynamic-import exclusion that filters the first hop, so the baseline has 29
cycles, seven of which traverse a dynamic-import edge; all-dynamic cycles are
excluded. The deliberate `clients/installer/index.ts:4870` cycle break remains
baselined, not excluded. The 29-cycle reduction is tracked in issue #2125.
`index.ts` is parsed as TypeScript without a transpiler, so its type-only
`PersistedReadGuardState` import inflates the eager set; `./clients/read-guard.js`
is annotated inline in `config/dependency-cruiser-eager-allowlist.json`. The
compiled-JavaScript claim does not apply to that entry parsing. The governance
test pins the exact three rule names, the 29-entry baseline count, and the
derived eager-import set.

- TypeScript ESM throughout (`"type": "module"`)
- Edit the `.ts` sources only. Do **not** hand-edit sibling/generated `.js` files in this repo; pi loads TS via on-the-fly jiti transpilation and JS files are generated artifacts. If tests/runtime could see stale `.js`, run `npm run build` to regenerate from TS before testing.
- Tests use vitest; mocks via `vi.mock` / `vi.hoisted`
- Fire-and-forget background work uses `void expr` or `setImmediate`
- `logSessionStart()` is a no-op in test mode (`VITEST` env var)
- LSP tool: use `goToDefinition` / `findReferences` before grepping for symbols
- ast-grep debug tool is named `ast_grep_dump` (the former `ast_dump` compatibility-alias registration was dropped — same underlying implementation, redundant tool-list weight).
- **Dynamic tooling (pi's registered-but-inactive tool loading, `index.ts` tool-registration block).** 6 tools stay always-active: `lens_diagnostics`, `lsp_diagnostics`, `module_report`, `read_symbol`, `read_enclosing`, `symbol_search`. 6 situational tools — `ast_grep_search`, `ast_grep_replace`, `ast_grep_outline`, `ast_grep_dump`, `lsp_navigation`, `lens_diagnostic_mark` — are registered inactive and activated on demand via the always-active loader tool `pi_lens_activate_tools` (`tools/activate-tools.ts`). Activation is additive and skips `setActiveTools` when the requested set is already active. pi-lens RESTORES the set on EVERY `session_start` reason, it never skips: the host builds a fresh `AgentSession` with `includeAllExtensionTools: true` on fork/reload/resume exactly as on startup and never persists an active-tool set per session, so every registered tool is active again by the time the handler runs. `startup`/`new` clear the remembered-activation set (`rememberedLazyTools` in `index.ts`) and the restore is therefore the plain baseline shrink; fork/reload/resume keep it, so the restore reproduces the parent's posture character-for-character — which both preserves the model's activations and keeps the advertised tool list equal to the one the cached prompt prefix was built from. The mutation block sits BELOW the #473 concurrent-secondary guard: the active tool set is process-shared runtime state and a secondary must not rewrite the live primary's. `--no-lazy-tools` or `tools.lazy=false` keeps every tool statically active when stable prompt caching matters more than tool-list weight. `clients/tool-set-policy.ts` owns the restore plan (`planToolSet`), reads the host’s own deferred-tool flag (`ctx.model.compat.supportsToolReferences`) rather than re-deriving it, and logs each real mutation to `latency.log` as `tool_set_mutation`. Feature detection remains fail-open: if `pi.getActiveTools`/`pi.setActiveTools` are absent, all situational tools remain statically active. `LAZY_TOOL_CATALOG` (right below the `lazyTools` array) is the enum source `pi_lens_activate_tools` advertises — a tool added to `lazyTools` but NOT to this catalog is permanently unreachable on a dynamic-tooling host (caught in #690: `lens_diagnostic_mark` was added to `lazyTools` but initially missing from the catalog). (#1453)
- `lens_diagnostic_mark` (#690, `tools/lens-diagnostic-mark.ts` + `clients/diagnostic-dispositions.ts` + `clients/dispatch/suppress-writer.ts`) is an agent-facing disposition layer over dispatch diagnostics: `false-positive` / `suppress` (writes an inline `pi-lens-ignore` comment) / `defer` (session-only, in-memory) / `flagged` (persists, tagged `📌 flagged-to-fix` in `lens_diagnostics mode=full`). Content-anchored with per-disposition binding strength — `false-positive` uses a STRICT anchor (rule+message+the flagged line's own content hash, so a rewritten line gets a fresh chance to re-fire); `suppress`/`defer`/`flagged` use a WEAK anchor (rule+message only, no line hash) so the mark survives incidental edits elsewhere on that line. Wired into both the per-edit dispatch path (`dispatcher.ts`) and the `mode=full` sweep (`lens-diagnostics.ts`). Every mark is NDJSON-logged (`clients/disposition-logger.ts` → `~/.pi-lens/dispositions.log`, incl. `previousDisposition` on re-marks and in-memory-only `defer` marks — the #181 rule-tuning signal, especially `false-positive` rates per rule) and published on the bus as `pilens:diagnostic:disposition` (`clients/disposition-publish.ts`, sibling producer per the format-events-publish "owns nothing in common" rule; emitter wired in index.ts alongside the other three), both from the single `markDisposition` choke point. pi-lens-internal only — situational, NOT mirrored into the MCP server (MCP has no equivalent tool; would need its own engine seam + tool route if that gap gets closed).
- `ast_grep_outline` (#311, `tools/ast-grep-outline.ts` → `AstGrepClient.outline` → `ast-grep outline --json=compact`) is a SYNTAX-ONLY structure tool (no index/LSP); `module_report` stays the pi-lens-aware default. pi tool only — not mirrored to MCP (parity deferred, like `read_enclosing`).
- `clients/runtime-config.ts` is "pure constants" by intent. Resolutions that read disk or env (e.g. `getRunnerTimeoutFloorMs`) must be **lazy memoized getters** with a `_resetForTests` hook, not module-level reads, so importing the file has no I/O side effect and tests can override inputs deterministically.
- **Project-wide extension enumeration derives from `KIND_EXTENSIONS`** (#894). `ALL_SCANNABLE_EXTENSIONS`, `WARMUP_SOURCE_EXTS`, and `SUPPORTED_FILE_KINDS` must never regain hand-maintained per-language lists; adding a file kind in `clients/file-kinds.ts` automatically makes source scans and language-profile warmup see it. Preserve consumer-specific narrowing with an explicit `extensions` override at that call site, not by narrowing the shared defaults.
- **Skill docs (`skills/*/SKILL.md`, `reference.md`) are prose, not type-checked source, so they drift silently** (#1423/#1424: a stale `filePath` param name, a missing `php` tree-sitter language dir). `tests/skills/skill-doc-drift.test.ts` pins them against the real sources of truth instead of relying on manual review: tool-call param names/tables against each tool's real TypeBox schema (imported live from `tools/*.ts`), path references against the filesystem and `package.json`'s published `files` (unpublished dirs — `clients`, `tests`, `tools`, `scripts` — require a nearby "source checkout only" qualifier), and both rule-writing skills' language lists against their `rule-schema.json` enums. A load-bearing behavioral claim in a skill doc should carry a `<!-- verified: <ref>, <shortSHA> -->` comment (format pinned by the same test) so a future edit can tell a checked claim from an assumed one.
- Codebase-model file selection uses `detectFileRole`, `isBuildArtifact`, and `isExternalOrVendorFile`; generated-artifact directory names (including `dist`) are maintained in `clients/generated-artifacts.ts`, not reimplemented as model-local substring tests. Persisted models carry the canonical review-graph identity and `CODEBASE_MODEL_VERSION`; load rejects either mismatch.
- Numeric inputs from env vars or JSON config that flow into `Math.max` / `Math.min` must be coerced through a `Number.isFinite(n) && n > 0` guard. `Number(undefined) === NaN`, and a single NaN argument makes `Math.max` return NaN, which `setTimeout` silently treats as 0.
- **Cross-process LSP pressure is one session-boundary snapshot** (`clients/lsp-budget.ts`, #821): count pressure and the optional complete/fresh aggregate-RSS ceiling (`PI_LENS_LSP_BUDGET_RSS_MB`) feed one cached decision used for auxiliary shedding, the current session's short idle reset, and pull-only diagnostics. Missing/stale RSS samples fail open to count-only; capability decisions reuse `classifyServerWaitTier` (`"pull-capable"`), and the `PI_LENS_CROSS_PROCESS_BUDGET=0` kill switch disables every policy.
- **Per-session LSP clients have one conservative root/cap policy** (#1325): root candidates under `tests/fixtures`, `__fixtures__`, `testdata`, project ignore rules, or the shared atomic-write staging namespace are declined and resolution continues to an eligible ancestor. Client identity remains `serverId:normalizeMapKey(root)` with in-flight same-key dedupe. `PI_LENS_LSP_CLIENT_CEILING` defaults to 24; the serialized spawn gate counts live/in-flight keys once, gracefully evicts the LRU client with no active LSP request, and declines a new spawn when every capacity candidate is busy.
- **Detached LSP footer repaints use event-captured UI methods** (#338/#798).
  `lens_diagnostics mode=full` passes an `onServerReady` callback into the
  workspace sweep so each successful cold group warm-up refreshes the footer.
  Capture `ctx.ui.setStatus` and `ctx.ui.theme` while the host event is active;
  async sweep/timer callbacks must never dereference `ctx.ui`, which can become
  stale after session replacement.
- Guard command analysis uses `tokenizeShellCommand` for quoted/separated argv;
  bash read/ownership grants are committed only from successful `tool_result`
  events. Tool-call inspection must not mutate read-guard state, and wrapper,
  launcher, and continuation forms must remain conservative for git commits and
  pushes.
- **The console guard captures only inside a pi-lens execution window** (#1434).
  The host shares this process and prints its own CLI output through
  `console.log`, so a permanent global reroute silences commands like
  `pi list`. `installConsoleGuard` installs a dispatcher: inside a window the
  write goes to the extension log, outside one it goes to the original console
  method. Windows come from three places only — the module-evaluation flag
  opened in `clients/console-guard-install.ts`, the activation window in
  `index.ts`'s default export, and the per-entry-point windows that
  `withConsoleCaptureWindows` adds around every `on`/`register*` call — a
  DENY-LIST keyed on the property name (`isCaptureSeam`), not a hand-maintained
  list of the specific methods pi-lens happens to call today, so a new
  `register*` seam the host adds later is covered without an edit here. Every
  function argument gets wrapped, including one ONE LEVEL inside an
  options/tool object (`options.handler`, `tool.execute`) — deliberately not
  recursive past that level, since walking a tool's full nested schema on
  every registration measurably slowed activation; a coverage test
  (`tests/clients/console-capture-window-coverage.test.ts`) derives the
  member list from the host's own `ExtensionAPI` type and asserts none of them
  bypass the window. Register a new host entry point through the wrapped API,
  never the raw one, or its console writes escape to the terminal.
  `closeModuleLoadConsoleWindow()` must stay the last statement in `index.ts`.
  Known gap, accepted not fixed: `pi.events` (a separate bus, not an
  `ExtensionAPI` member) is unwrapped — fine today because every subscriber on
  it is subscribe-only.

Process-table resource samples preserve query outcome. `clients/child-unref.ts`
`spawnCollectStdoutResult` distinguishes successful empty stdout from
`spawn-error` and `timeout`. `clients/resource-sampler.ts` returns `null` for
those failures, so consumers leave usage unknown rather than fabricating zero
samples, and records one bounded `resource-sampler-query-failed` degradation
per query subject. (#1863)

File-operation rename filters match only the decoded URI path, never a basename
fallback. Unsupported wire URI schemes fail closed; entity-kind probes are
conditional on a filter declaring `matches` and use `lstat` so symlinks are
classified as the renamed entity. Parsed filters and operation capability stay
an invariant: filters undefined means the capability is absent; malformed
initialize options are separately labeled in capability-skip telemetry.

Test-runner availability and Vitest-glob caches canonicalize each public cwd
once, then use `normalizeEphemeralMapKey` because their keys are already
canonical and process-local. `detectRunner` hoists the outer availability-map
lookup before the runner loop and uses the nested plain `Map`; glob-cache
lookups use one `get`, not `has` plus `get`. (#2048) The spelling-to-canonical
memo stores RESOLVED spellings only: a `realpathSync` failure returns the
fallback key without memoizing it, so an alias probed before its symlink
existed re-resolves on the next probe instead of pinning that call's verdict
for the client's life. Any bounded memo whose key derivation can fail owes the
same freshness story on the failure branch, not just on the success branch —
otherwise key derivation silently changes when the path comes into existence
and the memo never re-runs it (defect shape 1's temporal edge). (#2077)
