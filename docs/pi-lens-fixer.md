# Fixer contract

Read first: the engineering principles (`docs/engineering-principles.md`), then
`AGENTS.md`, then `docs/pi-lens-subagent.md`, then this contract. Then read the
issue with its comments (`gh issue view <N> --comments`): its acceptance
criteria are the contract. Rules the principles or `AGENTS.md` already state
are not repeated here. Lane mechanics (checkout, `TMPDIR`, push forms, Git
grants, summary shape) are `docs/pi-lens-subagent.md` "Orchestrator lane
mechanics"; a brief supplies only `lane=<name>`, scope, and the grant.

## Before code

Before mocking a `clients/` module, look for its test seam (`set*`, `adopt*`, or
`reset*`). The pre-flight must list the mock dependents of any module whose
exports change.

A new test starts from `tests/support/`: a registration question (flags,
tools, commands, declarations) goes through tier 1
(`tests/support/pi-runner.ts`, a real `ExtensionRunner`), a session-flow case
through tier 2 (`tests/support/pi-session.ts`), and a JSON-lines sink through
`readNdjsonRows` (`tests/support/ndjson-rows.ts`), asserting `skipped === 0`
when the claim needs the complete output. No fake of an in-process store or
registry; other doubles only as `AGENTS.md` admits them.

- Trace the production entry point and reproduce the defect through it
  (principles §1, "Premise first"). Name no seam before the reproduction; the
  red reproduction is your feedback loop, built before any theory of the fix.
  Reproduce on the reporter's pi host and pi-lens version, taken from the
  report or its session log. When that version cannot be installed, name the
  one you used instead; never substitute the latest silently. Report
  `confirmed`, `partially confirmed` (name what differed), `not reproduced`
  (name what you tried), or `blocked` (name the missing access or state).
- Climb the minimalism ladder before screening against the `AGENTS.md`
  catalog: the catalog says what must not break, never what to add.
- Mechanism for a race, security edge case or failure nobody has reproduced is
  not built in the round (principles §1, speculative robustness). Name its
  trigger path, evidence and cost under scope at the top of the hand-back, and
  leave the decision to the maintainer. Validation, error handling and security
  at a real trust boundary are still required.
- Check which open PRs touch your files (`gh pr list`, `gh pr diff`), design to
  compose, and flag merge order in the PR body. Branch `fix/<N>-<slug>` from
  `origin/master` unless the brief names a branch. Preserve contributor
  authorship on a contributor's branch.
- Write the failure list under `### Tests` in the PR body before the first edit
  (principles §2): inputs, states, orderings, and platforms; a space with two
  axes is a table.
  The tests cover that list, not only the happy path. For a change to N of M
  members, the list also names M, the excluded default, and the planned
  generalization verdict: *widen in this PR*, *follow-up issue* with its seam
  group, or *stay specific* with the reason (#3622).
- When a gate becomes fail-closed, sweep every construction site that reaches
  it, test doubles included, and prove the sweep with the behaviour suites
  (#3622).
- A new module, or a new use of a detection or caching primitive (stat,
  mtime, inode, content or line hash, directory walk, install stamp, sequence
  counter), lists the existing modules that use the same primitive for the
  same purpose. Find them by searching for the primitive, such as
  `rg -l 'statSync|mtimeMs|createHash|readdir|projectSeq' clients`, never by
  your own seam's call names. The consolidation verdict cites that list
  (#4536).
- A change on a lifecycle, timing, or identity seam extends or adds a TLA+
  model in this step (#3802; the rule itself is in `AGENTS.md`). Find the
  family in `formal/coverage-map.json`, write the invariant the change
  preserves or tightens, and show the violating config red on the pre-fix model
  and green after, or carry `TLA+ unaffected: <family> — <reason>` in the PR
  body. The unaffected line is wrong when the change alters a behaviour an
  as-built config constant encodes: flip that constant, its configs and its
  `formal/switch-pins.json` value instead, and keep its pin test red on the old
  behaviour (#4387, #4393). A row is any-of (one listed family's model move or declaration
  satisfies it); a row of 4+ families only prints a note, except `index.ts`,
  whose row gates on the lifecycle hook handler a hunk lands in (#3878). The
  map owner is the lane that adds a `formal/<family>/`: it adds the family and
  its map row in the same PR, and `validateCoverageMap` reds the Unit tests lane
  otherwise.
- Seams are named in the brief before the round. A fixer that needs an
  unconfirmed seam stops and reports it as a finding, not as a test.

## Scope

- A fix round does not deepen: no refactor, helper extraction, or rename
  beyond the fix's own lines; deepening is its own slice under the owning
  umbrella (#3178). Every hunk serves a finding or an acceptance box. Orphans
  your change created come out; dead code you only noticed goes to the
  follow-up section.
- A behaviour-preserving move is its own commit: callers keep exact results and
  tests stay green; put any behaviour change in a separate commit (#3817).
- Delete vacuous tests in the files you touch (a case that reds on no
  mutation, asserts a constant, or duplicates a sibling), with the sweep
  transcript quoted in `### Tests`. A redundant test that still guards
  goes only with the named survivor that covers it.
- Apply folded review follow-ups per `docs/pi-lens-subagent.md`
  "Follow-ups", and list every gap left open in one **Accepted residuals** section of
  the PR body, each named `p3` with its severity and live population (merge bar:
  `docs/pi-lens-merge-policy.md` "Filing issues").

## Evidence

- Use `scripts/mutate.mjs` for bounded hand mutations; it restores the target automatically, but only while the file still holds the mutated bytes. A leftover journal (`<file>.mutate-backup`) blocks the next run on that file; recover with `--restore`, which refuses and prints the three hashes when the file was edited since. If a crash left the file already at its original bytes, `--restore` also refuses; check the printed hashes and delete the journal by hand. `--restore` is crash recovery only: run against a live `mutate.mjs` run on the same file, it pulls that run's mutation, and that run then reports ERROR (exit 4). The transcript's status line is `SURVIVED` (tests passed), `RED` (a test run failed), `REFUSED` (the edit was not applied), `BROKEN` (the build failed) or `ERROR` (no verdict); only `RED` proves a test catches the mutation (#4510).

- Witness rule (ADR 0007): #1605 owns the witness lanes, and their fixtures
  live under `tests/fixtures/witness/<slice>/`.
- A PR claiming it "reduces failures" runs `node scripts/ci-test-diff.mjs <jobA> <jobB>`, quotes its summary, and explains any NEW failures before claiming a reduction.
- Red-first has one stated exception: when the only red-first path needs broad
  harness setup, brittle mocks, or a test you would delete right after it
  proves the fix (shape 7: #1114, #1759), state the exception in `Tests`, name
  the closest executable check you used, and expect the reviewer to dispute it.
  A silent omission is a defect.
- With Git authority, commit the code once the targeted suite is green and
  after every proven step, before any checkout-based proof; add evidence in a
  later commit (#3268). Produce a red by restoring only the mutated source path
  from the pre-fix SHA (`git checkout <sha> -- clients/…`), never `tests`
  (#3166) and never uncommitted work, and run `git status` after any bulk
  restore. Without Git authority, use a saved patch.
- Hand-mutate only the NEW guard, branch, filter, or cap the PR is about, and
  the behaviour behind each relaxed assertion (next bullet), both directions,
  one row per direction, and quote the compile-valid red. The new test is the
  only red under at least one mutation. These rows are the whole PR mutation
  layer (AGENTS.md, #4005): there is no per-PR Stryker job, comment, or
  `MUTATION` line, and no survivor triage. The nightly Stryker report on master
  is exploratory and is not read here. Use bounded hand probes locally; never
  run a full Stryker campaign in a worktree.
- A PR that relaxes or rewrites an existing assertion (a changed meaning makes
  the old expectation wrong) mutates the behaviour that test is named for. Quote
  the red on the new assertion. A rewrite that stays green with that
  behaviour broken is a deleted test (#4390: the eviction smoke's rewrite
  passed with root re-registration broken).
- A PR that adds or changes a detector (a ratchet, census or source scan)
  writes STATE_TABLE.md before the first edit: each form the detector
  admits, and the statement that every other form refuses. It then plants
  three spellings its author did not design for: an alias, an indirect
  call and a value reached through another binding. Quote each result. A
  plant that stays green is fixed. A stated residual names an admitted
  form that is too broad, never an unread spelling (AGENTS.md shape 69).
- The manual per-test campaign (`stryker-pertest.yml`, #4365) lists tests that
  cover mutated code but kill no mutant. It is a triage input, not a verdict:
  a candidate that guards another seam or a named recurrence stays, and a
  deletion it proposes lands only with the covering test named and the
  reviewer's agreement test by test.
- Every record the `Observability` section names is asserted by a test under
  `tests/` (any collected test, not only a file this PR touches) and quoted in
  the body (#2642, #2647, #2649, #2654). The body lint refuses a named record
  literal no collected test reads back (`scripts/check-pr-body.mjs`, #4597), so
  a record the section names without a read-back cannot merge; `none: <reason>`
  still answers a diff with no record. A mention counts whatever its spelling:
  a backticked span, a bare word and a link label are all read against the
  record values the runtime emits, so prose that reuses a record's own name is
  a mention too.
- The read-back is the record's full name in an assertion, a comparison, a
  `case` label or a record-keyed row inside a declaration vitest collects and
  runs, or inside a module-scope helper that one of them calls. A title, a
  `console.log`, a skipped test and an excluded tree do not count, and a record
  named only through a table imported from another file does not either, so
  inline the name in the assertion. The declaration may be spelled with a
  computed modifier or bracket link (`it["only"]`) and through an alias
  (`const t = it`); a form the lint cannot classify (`it[modifier]`, a
  destructured alias) makes its whole file contribute nothing, so write the
  declaration the plain way. Naming a record that predates the PR owes the same
  test.
- Every behavioural sentence (a docstring invariant, a memo, a registry
  justification) maps to a test or a probe, or is deleted (#2643, #2654).
- Name where new state sits in its ladder and what happens to it at
  `session_start` (#2649, #2654).
- A change on a hot path (dispatch, `session_start`, LSP diagnostics, a cache
  lookup, turn-end) quotes a before/after timing from the real path in the
  body, with the command, at a small and a large input; per-input work on a
  tool path also needs a size or time bound. Name and justify any regression
  (#4344 r1; #4368 r1). The `Hot-path latency (advisory)` lane (#4363) times
  `session_start`, `dispatchLint` and the diagnostics-cache replay on the head
  and its first parent (`HEAD^1`); read its job summary, and time by hand any
  hot path it does not cover (a language server's time, a dependency bump).
  Green means no regression of 1.25x and 5 ms; a "slower, below threshold" row
  is still a number to read.
- A measured constant names its measuring command and keeps raw output as a
  tracked artifact pinned by a test (#3648). Run `git check-ignore -v` on every
  new artifact path before citing it (#3648).
- A CI-lane or workflow fix is accepted only when that lane's own run on the
  exact head completes inside its `timeout-minutes`, with the acceptance
  surface quoted from its log; any self-bound sits below the job cap by a
  stated margin.

## Required checks

- Run every test that mocks or deep-equals a changed module or record, and the
  spawn-heavy lanes for real child or LSP tests.
- Before pushing, run `npm run astgrep:self-scan`; the pre-push hook runs the
  same scan over tracked files, after its build.
- Reproduce CI-only failures in the CI command shape.
- Run `npx oxfmt --check` on every touched file with the symlinked pinned
  devDependency. Never `npm install oxfmt --no-save`: it replaces the linked
  `node_modules`.
- Run release-QA end to end when a release-QA row changes.
- Run the reviewer's standing probes (`docs/pi-lens-reviewer.md`) that the diff
  can trip, and quote their output in the PR body. The `verify-pi-lens` skill
  (`.claude/skills/verify-pi-lens/SKILL.md`) holds the real-path recipes.

## Fix rounds

- When bot threads or code-scanning alerts exist, read and dispose of each
  one. A missing bot review is never evidence of anything: it never blocks the
  round and never becomes something to wait for. The threads, every page:
  `gh api graphql --paginate -f query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:1){nodes{author{login} body}}}}}}}' -F owner="$(gh repo view --json owner --jq .owner.login)" -F name="$(gh repo view --json name --jq .name)" -F number=<N> --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | "\(.id) \(.path):\(.line) \(.comments.nodes[0].author.login): \(.comments.nodes[0].body)"'`,
  and the alerts:
  `gh api --paginate "repos/{owner}/{repo}/code-scanning/alerts?ref=refs/heads/<branch>&state=open" --jq '.[] | "\(.number) \(.rule.id) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'`.
  Both commands follow their cursor to the last page, so the list is clear
  only after that page prints: one page is never read as the whole list.
  An alert on another branch is not this round's; read the head you pushed.
  Before the hand-back, reply to and resolve every thread this round fixes, and
  name every other open thread and alert in the PR body with its disposition.
  A round that finds none says so in one line and moves on. Where the brief
  withholds GitHub writes
  (`docs/pi-lens-subagent.md`),
  put the same list in the body and the hand-back for the orchestrator to post
  and resolve. The disposition words and the merge condition are
  `docs/pi-lens-merge-policy.md` "The loop, per PR" step 1 and step 4
  (`:34`, `:81`); this contract does not restate them. Recurrence: #4566 and
  #4575 (2026-10-17), where the threads outlived the rounds that should have
  read them.
- On `FIX ROUND` findings, reproduce each finding before fixing it, add a
  red-first test for every behavioural fix, rebuild, re-run the targeted suites
  plus anything the findings touched, and push the same branch. If the PR reads
  DIRTY, merge `origin/master` with additive resolutions and screen the merged
  result semantically: master may have moved the seam you built on.
- A reviewer's prescribed remedy is a hypothesis. Test it against your own
  table of the seam; if it is insufficient, ship the correct shape and quote
  the red the prescription alone leaves (#2642).
- When a verify finds a NEW defect on your fix, the next round carries a table
  enumerated from grep: every writer and reader of the key with the exact
  expression that derives it, and every call into an external sink or timer
  with "if it throws" and "if it never returns" columns (#2642, #2649). Fix
  everything the table exposes; a table that finds nothing is quoted too.
- Name every governance exemption a round adds, with the reason and whether it
  is a registration or silencing; it is a finding until the reviewer clears it
  (#2654).
- Spot-check one prior round's mutation on the new head (#2583).
- Re-read the changelog fragment for any claim the round retracts (#3155), then
  update the PR body in place so it describes the current head. Do not append a
  round section; commits and review threads hold the history.
- Lint the PR body (`--lint-local`) before the first push of a round, not only
  at hand-back: `PR body (advisory)` re-reads the same body on every push, so
  an unfixed finding reds each one.

## Before the report

Re-climb the minimalism ladder on what you built. Challenge anything
unnecessary or unverified with a probe, delete what can go, and simplify what
remains: prefer deleting over simplifying, simplifying over optimizing, and
optimizing over automating. If the diff survives, leave it alone; churn is not
rigor (#2599).

## Handoff

- The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`, which a reader must
  be able to scan (#5003): `## Summary` (at most three sentences, with the
  closing keyword, which GitHub ignores in a title), `## Notes for the reviewer`
  (at most five bullets, no tables or fences), `## Change outline`, and
  `## Proof and checks` with `### Tests`, `### Class sweep` (ending in one
  `Alignment:` line that names the families of `docs/alignment-families.md` the
  change touches, or `none: <reason>` of 12+ characters),
  `### Observability` (a record literal from the runtime diff, `none: <reason>`,
  or exactly `No new failure path; no record added.`, which a new decision
  branch on a session, lifecycle or delivery seam refuses, #3875), and
  `### Fold check` (one line per candidate, `#N folded`, `#N not folded` or
  `#N sequenced`, then its reason, or `none: <reason>`; the body lint owns the
  form and the local script owns the candidate list, #4711). Add `### Blast
  radius` only when the change reaches outside the touched module or hits a hot
  path. The lint caps visible text at 5000 characters and each code fence at 20
  lines: quote failing lines, not whole runs, and give each mutation one table
  row, not a paragraph. A brief that names only some headings does not shorten
  this list.
- Run `node scripts/check-pr-body.mjs --lint-local PR_BODY.md` and
  `node scripts/check-changelog-fragments.mjs` before the hand-back; both
  must pass, and the hand-back quotes them. The body lint reads the closed
  issue's labels through `gh api`; a `::warning::` that the Detection check
  was skipped means gh failed, so the section was not required, not that it
  passed (#4288). A body that only references an issue (`Refs #N`, or any
  close keyword the closing read does not own), or whose title names one
  (`(refs #N)`), owes the same section when that issue is labelled `bug` or
  `nightly-drift`; so does a body that closes a `nightly-drift` issue. A
  reference written as `owner/repo#N` or a URL is refused unless the body
  already closes a bug, which owes the section whatever else it cites. CI refuses a label
  it cannot read; the local preflight, with no working gh, warns and skips it
  as for a closed issue (#4968). A non-bug PR either deletes the `### Detection` section or
  fills the three lines, and a `Shape:` or `Enforcer:` line it does write is
  validated too; free text in between reds the local preflight. A bug-closing
  PR that answers a layer, the `Gap: none:` reason, the `Shape: new:` name or
  the `Enforcer: none:` reason with `unknown`, `n/a`, `tbd` or `?` is refused
  (#4519); the layer words are `DETECTION_LAYERS`, `nightly:<workflow>`
  included. A red `PR body (advisory)` check is a fix-before-review item.
  A changelog fragment is `---` /
  `section: <Added|Changed|Deprecated|Removed|Fixed|Security>` /
  `audience: <user|internal>` / `---` / blank / one `- ` bullet. New
  `audience: user` fragments must begin with a bold lead of at most 100
  characters, excluding issue references; internal fragments are exempt.
  `audience` is
  required: `user` is anything a pi-lens user or agent can observe (tools,
  diagnostics, messages, config, install, performance, a fixed bug they could
  hit); `internal` is CI, tests, `formal/`, contributor docs, orchestration, and
  refactors with no observable change. `npm run changelog:check` checks the
  rollup, not fragments (#2456).
- A bug fix's detection lesson names the defect SHAPE and its tree-wide
  enforcer, not only a test for the instance: the `Shape:` line names the
  `AGENTS.md` "Recurring defect shapes" number (or `new: <name>`), and the
  `Enforcer:` line a test on base that scans the whole population, an issue to
  build one, or `none: judgment-only, <reason>`. With `Shape: #N` a path
  enforcer must be one catalog entry N names. The fix's own one-bug test is its
  regression test, not the closed gap. The body lint enforces both lines
  (#4439).
- A `Shape: new: <name>` is a proposal, not a catalog entry: write the
  proposed shape text in the PR body under "Proposed contract change
  (maintainer decision)" and never edit `docs/defect-shapes.md`. Catalog shapes
  and rule
  changes are the maintainer's decision; the orchestrator lands an approved
  one in its own change (#4577's fixer added shape 74 unasked, and the
  governance suites redded).
- Every code fact in the PR body is a `` `path:line` `` citation the check
  verifies: the file must be in the committed tree (never an untracked or
  git-ignored path, which CI cannot read), and a fenced quote after it must
  match within ±20 lines. Every test, probe, or fixture id in a body table is a
  grep-able `it(` title or file name in the tree (#2868, #2877).
- With Git authority, the hand-back carries the commit SHA; a dirty tree is an
  incomplete round.
- Report outcome first: branch, PR URL, the root cause in two sentences,
  red-run evidence, test totals, every mutation result, skipped check, and
  environment block, and what the orchestrator must decide (merge order,
  deferred scope, follow-up issues).
