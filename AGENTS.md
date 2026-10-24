# pi-lens — agent context

## How to use this file

Read order: the engineering principles (every harness here carries a verbatim
copy in its global instructions; vendored at
[`docs/engineering-principles.md`](docs/engineering-principles.md), never
hand-edited), then this file, then the role contract for the task. This file
holds only what is specific to pi-lens and wins on conflict. Dated incidents and
closed decisions live in `HISTORY.md`.

The principles, one line each, linked to their section of the vendored file.
The vendored file wins on any difference from this digest.

- Premise first: reproduce the defect through the production call path before
  the fix ([§1 Building](docs/engineering-principles.md#1-building)).
- Speculative robustness needs buy-in: no new mechanism for an unreproduced
  race or edge case without the trigger path, evidence, cost and a maintainer
  decision ([§1 Building](docs/engineering-principles.md#1-building)).
- Climb the minimalism ladder: reuse an existing seam before adding a line
  ([§1 Building](docs/engineering-principles.md#1-building)).
- Net-count rule: a new shared helper deletes a same-shape sibling in the same
  change ([§1 Building](docs/engineering-principles.md#1-building)).
- Sweep the pattern, not the instance, and record the consolidation verdict
  ([§1 Building](docs/engineering-principles.md#1-building)).
- Design shared state once, before a second writer joins
  ([§1 Building](docs/engineering-principles.md#1-building)).
- Give every new failure path one bounded, observable record
  ([§1 Building](docs/engineering-principles.md#1-building)).
- Diff the blast radius as a call tree, with `+`/`-` on moved lines
  ([§1 Building](docs/engineering-principles.md#1-building)).
- Red first, and paste the failing transcript
  ([§2 Testing](docs/engineering-principles.md#2-testing)).
- Ship the tests in the same commit as the code
  ([§2 Testing](docs/engineering-principles.md#2-testing)).
- Quote each mutation's red; a ticked box with no transcript is false
  ([§2 Testing](docs/engineering-principles.md#2-testing)).
- No tautological test: assert an independent effect through the real seam
  ([§2 Testing](docs/engineering-principles.md#2-testing)).
- Close only when every criterion is met; otherwise `Refs` and post the
  remainder ([§4 Honesty and records](docs/engineering-principles.md#4-honesty-and-records)).

<important if="a code change, subsystem-specific change, delegated work, or pi documentation work">

Task routing:

- Any code change: read **Issue and PR design contract**, **Recurring defect
  shapes**, and **Test requirements**.
- LSP, dispatch, runner, formatter, installer, cache, session, telemetry,
  review-graph, Git-guard, or rule work: read the matching **Standing
  invariants** subsection and the relevant source tests.
- Delegated work: read `docs/pi-lens-subagent.md` and exactly one role contract
  from `docs/pi-lens-{fixer,reviewer,investigator,monitor,warden,retro}.md`.
- Pi documentation work: read the installed pi documentation named by the
  global instructions. Do not infer SDK behavior from memory.

</important>

## What it is

pi-lens is a pi coding-agent extension. It runs bounded analyzers on file
writes, dispatches LSP and CLI runners, stores diagnostics, and exposes pi and
MCP tools. The host adapters are `index.ts` and `mcp/server.ts`; internal work
flows through `clients/lens-engine.ts` or the appropriate client seam.

Analysis-root invariant: `clients/analysis-root.ts` is the sole classifier for
out-of-session edits. A marked project may be adopted for LSP and per-file
linters, but adopted roots are separate from session roots, capped at two with
early idle eviction, and never receive session bookkeeping, whole-project
scanners, turn-end tests, or project-local executables under unknown pi trust.
Registration follows the class, not a directory, through
`resolveSessionConfigRoot`: a `session` file registers the nearest directory
holding any file the config loader layers (`PROJECT_CONFIG_LOCATIONS`, else
the session root), a `linked-worktree` file the
same below the worktree root, spelled as the file spells it (the session-root
registry contains lexically; the class compares identities, #4689), and an
`adopted` or `none` file registers nothing —
an adopted root reaches LSP only through `resolveServerRoot`'s adopted branch
and `ClientRegistry.admitAdoptedRoot`. A linked worktree is its own workspace,
so its edits take the same dispatch, formatting, autofix and LSP treatment as a
session edit, and `tool_result` records `tool-result-linked-worktree` for that
root and states a run a language server answered that recorded no finding
(`tool-result-linked-worktree-clean`, keyed off the required
`PipelineResult.checkedClean`, never off `output` or the all-clear line), so
the path is never silent.

The repository ships compiled JavaScript. TypeScript sources are authoritative;
compiled twins are generated and must not be edited by hand.

## Maintaining this file

Update this file in the same change as the behavior, structure, command, or
invariant it documents. Keep live rules short and load-bearing. Put dated
narratives and completed arcs in `HISTORY.md`; do not delete their decision
record. Place new invariants in the matching subsystem section, not at the file
end. Cite symbols and section headings, not line numbers. A defect shape that
claims enforcement names its guard by path; a guard that is only planned is
named by its open issue, never described as if it runs.

Keep project instructions consistent with `CLAUDE.md`, role contracts, skills,
and tests. The repository wins when a runner-side copy differs. Role rules live
only in `docs/pi-lens-*.md`; `.claude/agents/*.md` are thin Claude Code
wrappers that point there and hold only harness-specific lines.

## Issue and PR design contract

The principles govern building, testing, and closes-versus-refs. pi-lens adds:

- Issues and PRs lead with the outcome, then evidence, root cause (or a labeled
  hypothesis), acceptance criteria, non-goals, failure semantics, test matrix,
  observability, and class-sweep coverage. The issue reference goes in the PR
  title; the closing keyword goes in the body, because GitHub ignores it in a
  title.
- Mutation acceptance has one PR layer (#4005): every
  new guard, branch, filter, cap, or fallback, and the behaviour behind every
  relaxed or rewritten assertion, has bounded compile-valid hand-mutation
  proof under the engineering principles, and a missing proof or a
  demonstrated correctness gap blocks merge. There is no per-PR Stryker job,
  comment, or `MUTATION` line to read. Stryker runs nightly on master as an
  exploratory test-adequacy report (`.github/workflows/stryker-nightly.yml`,
  one rolling tracking issue); its survivors are candidates for a missing
  test, read through real callers by whoever picks them up, and never a merge
  input or a duty of a fixer or reviewer.
- A declared behaviour-preserving refactor proves itself with an old-versus-new
  probe table through the built seam plus a shared-seam mutation that reds a
  caller-side witness; a passing pre-fix run is expected there.
- Test telemetry by flushing and reading the real sink. State the record that
  proves the fix in the PR body.
- Blast radius uses `module_report` with `blastRadius: true` before and after
  the edit, and is re-run after conflict resolution.
- A fold verdict tables the ordered stages each site passes through and the
  count each stage sees, not only the participants: moving a filter one stage
  late can starve it of its population (#3166 r1).
- A core-domain rule lives in its owning module; every other caller asks that
  owner. A fix that re-derives an owned rule at a consumer is wrong: extend the
  owner, or create a new one only with a stated reason (#3781, #3794, #3796).
- A change on a lifecycle, timing, or identity seam extends or adds a TLA+
  model in step with the code. `formal/coverage-map.json` maps source globs to
  model families; the PR-body lint requires a `.tla`/`.cfg` change under any one
  of a mapped row's families, or a `TLA+ unaffected: <family> — <reason>` line
  for one of them. `unmodelled` rows and rows of 4+ families stay advisory,
  except the `index.ts` row, which gates per lifecycle hook handler a changed
  hunk lands in (an edit outside every handler prints a note). A TLA lane that
  adds a family adds its map row (#3802, #3878).
  The unaffected line never covers a change to behaviour an as-built config
  constant encodes: flip the constant and its configs in the same PR.

<important if="delegating work or coordinating a lane">

## Orchestration and delegated work

The principles' delegation contract applies. pi-lens adds:

- Plegma fix lanes publish themselves: `publishRefs` covers a new lane's own
  branch, `fixFor` covers its rounds, and `gh` passthrough comes with either.
  A worker still proves its own registered worktree before it touches Git. A
  worker without that authority hands off through `PR_BODY.md` and
  `COMMIT_MSG.txt`; the warden is read-only. Anyone who moves a hand-back tree
  ports the diff onto the lane base and never copies whole files over a newer
  base (#4504's copy reverted 5 AGENTS.md lines).
- Route to the strongest available fixer, whatever the priority label: a brief
  that adds or edits a `tests/support/sweep-kit.ts` registered-or-fail sweep,
  and a path-key or normalizer change on a shared map (#3178). A cheap model
  (Haiku) takes a fix lane only when its brief prescribes the change; a lane
  that must find its own failure space or make a design call goes to Sonnet or
  Opus.
- A brief never asks a worker to wait for an answer ("report the size first"):
  a worker cannot wait for a reply. It either authorizes the conditional
  branch with its bound, or tells the worker to stop and hand back there.
- A brief names every file by its repo path (`clients/lsp/index.ts`, never
  `index.ts`): a bare basename resolves to another file in a read-only pass.
- After every completion, push, verdict, merge, or status request, trigger the
  next named owner in the same pass, and keep the handoff (exact head, verdict,
  dispositions, next owner) on the PR or the ledger.
- Review intake generalizes before it routes. For every HIGH, MEDIUM or
  CRITICAL finding, name the defect shape, grep the tree for other members, and
  record a verdict before the fix round dispatches: contained in this PR (with
  the sweep), sibling issue filed with the member list, or none (with the
  grep). The fix brief carries it as a `Shape:` line. History: `HISTORY.md`,
  2026-10-10.
- Plegma reads are token-budgeted (#417): settlements via `watch --next --mine`,
  `result` only when the transcript or handoff artifact is needed.
- Human decision, never an agent verdict alone: workflow permission grants,
  release/version changes, dependency majors or lockfile regeneration, deletion
  of user data or durable records, external-contributor PRs, and changes to
  these rules.
- Every regroup, merged bug fix, second round on one shape, and incident runs
  the retrospective in `docs/pi-lens-retro.md`.
- Three open issues on one mechanism, in any seam groups, open a consolidation
  audit across every consumer of that mechanism before the next one is filed
  (history: `HISTORY.md`, 2026-10-16).
- Run the **fold check** as soon as a lane's mechanism is known, which is when
  the brief is written: read every open issue against that mechanism and decide
  each candidate as folded into this PR (one `Closes #…` per folded issue) or
  not folded, with the reason (two hazards in one review, a maintainer decision,
  a blocked dependency, a different seam). The brief carries the candidate list
  and its decisions, and the PR body records them under `## Fold check`.
  Planning precedes filing: a new issue is the answer for p2+ work no lane can
  carry, never for a p3 the lane could fold (history: `HISTORY.md`, 2026-10-20).
- The per-PR loop (review, verify, auto-merge on green), round routing, the
  merge gate and the Common mistakes table live in `docs/pi-lens-merge-policy.md`.
- Read CI with `node scripts/ci-verdict.mjs <pr|sha>` (exact head, all pages).
  Never merge on absent, stale, or advisory-only checks.

</important>
## Glossary

- **finding** — Umbrella term for an agent-visible result; owned by `clients/finding-delivery-gate.ts`; retires `diagnostic`, `blocker`, `advisory`, and `record` (except a durable cache row).
- **diagnostic** — A structured finding carrying dispatch identity such as `tool`, `rule`, and location; owned by `clients/dispatch/types.ts`; retires unqualified `finding` when a structured dispatch value is meant.
- **blocker** — A semantic `blocking` finding that can stop progress; owned by `clients/dispatch/types.ts` (`OutputSemantic` and `Diagnostic`); retires `stop issue` and `error` when the delivery tier is meant.
- **advisory** — A non-blocking finding delivery tier; owned by `clients/finding-delivery-gate.ts`; retires `warning` when the model-facing tier is meant.
- **disposition** — A mark and its policy result (`false-positive`, `suppress`, `defer`, or `flagged`); owned by `clients/diagnostic-dispositions.ts`; retires `mark` and `status` for the stored policy concept.
- **strict anchor** — A content-bound `dd:` disposition identity; owned by `clients/diagnostic-dispositions.ts`; retires `content key` and `false-positive id`.
- **weak anchor** — A non-content-bound `ddw:` disposition identity; owned by `clients/diagnostic-dispositions.ts`; retires `soft anchor` and `persistent mark id`.
- **freshness** — The verdict that evidence still matches its reference (`fresh`, `stale`, or `indeterminate`); owned by `clients/freshness.ts`; retires `validity` and `age` when reference drift is meant.
- **delivery surface** — A concrete model-facing place that renders or returns findings; owned by `clients/finding-delivery-gate.ts`; retires `consumer` and `output path`.
- **delivery gate** — The freshness, disposition, and policy admission applied before a delivery surface emits findings; owned by `clients/finding-delivery-gate.ts`; retires `filter` and `render check`.
- **lane** — One producer-and-delivery contract within the delivery-surface registry; owned by `clients/finding-delivery-gate.ts`; retires `path` and `channel` for a registered surface.
- **seam** — A shared call through which sibling surfaces enforce one rule; owned by `clients/dispatch/finding-policy.ts`; retires `helper` when the call is an architectural enforcement boundary.
- **store** — The owner of durable or session rows, including their read/modify/write lifecycle; owned by `clients/durable-store.ts`; retires `cache` when state ownership, not derived reuse, is meant.
- **mirror** — A derived copy refreshed inside the writer's guard; owned by `clients/diagnostic-dispositions.ts`; retires `replica` and `shadow`.
- **path spelling** — The input string form of a path, before key or canonical normalization; owned by `clients/path-utils.ts`; retires `path name` and `raw path` when form is meant.
- **path key** — A normalized process-local map key; owned by `clients/path-utils.ts` (`normalizeEphemeralMapKey`); retires `canonical path` for ephemeral maps.
- **path identity** — The kernel-real path of a file: the realpath of its nearest existing ancestor plus the missing tail, what `normalizeMapKey` answers for an absolute spelling and `realpathOrResolve` for any spelling, on every platform; owned by `clients/path-utils.ts`; retires `canonical path` and `resolved path` where identity is meant.
- **rendezvous id** — A pure, cross-process string derivation shared by independent writers/readers; owned by `clients/mcp/ipc.ts`; retires `workspace key` and `IPC path key`.
- **generation** — A monotonic/session/content/scan/disposition-store identity that rejects late work; owned by `clients/generation-guard.ts` (`GenerationSource`, `GenerationHandle`, and `createGenerationSource`); retires `epoch` and `version` when the identity's lifecycle is meant.
- **degradation record** — A bounded once-only or counted ledger event for a partial, unavailable, or deferred result; owned by `clients/degradation-ledger.ts`; retires `log`, `warning`, and `telemetry`.
- **ratchet** — A governance assertion whose admitted population may shrink but not silently grow; owned by `tests/support/sweep-kit.ts`; retires `allowlist` and `baseline` when shrink-only enforcement is meant.
- **sweep** — A governance scan that enumerates a whole defect population and asserts its floor or emptiness; owned by `tests/support/sweep-kit.ts`; retires `grep check` and `spot check`.
- **pin** — A test assertion that keeps a known site, count, or identity from moving silently; owned by `tests/support/sweep-kit.ts`; retires `snapshot` when a semantic location is meant.
- **admission** — A recorded reason that permits a known exception into a governed population; owned by `tests/support/sweep-kit.ts`; retires `exemption` when the entry is accepted as a positive capability.
- **exemption** — A recorded reason that excludes a known non-member from a governance population; owned by `tests/support/sweep-kit.ts`; retires `ignore` and `exception`.
- **runner outcome** — The classified result of a tool run: clean/findings, skipped, failed, or rejected; owned by `clients/dispatch/runners/utils/spawn-outcome.ts`; retires `exit code` and `tool failure` as the user-facing classification. The classifier is `RunOutcome`; the older wording survives as `ToolFailureInput` (`tool-failure.ts`).

Where two spellings are still live, use the more specific canonical term above in new text: `diagnostic` for a structured dispatch value and `finding` for the umbrella delivery concept; `normalizeEphemeralMapKey` for a process-local path key and `workspaceHash` (`clients/mcp/ipc.ts`) for a cross-process rendezvous derivation.

ADR: docs/adr/0001-stale-advisory-live-arm.md
ADR: docs/adr/0002-workspace-hash-rendezvous.md
ADR: docs/adr/0003-git-guard-latch-writer.md
ADR: docs/adr/0004-disposition-policy-seam.md
ADR: docs/adr/0005-tool-availability-enforcement-seam.md
ADR: docs/adr/0006-derived-state-benchmark-first.md
ADR: docs/adr/0007-end-to-end-witness-per-seam-slice.md
ADR: docs/adr/0008-turn-end-lane-interface.md
ADR: docs/adr/0009-reported-path-attribution.md

## Recurring defect shapes

Screen against these before writing code. Shapes are numbered once, grouped by
the surface they bite; each block loads only when its trigger applies. A shape
whose open population is countable names its census in its entry. The census
is one command, run at the repo root, printing one line per member or naming
one baseline key. A PR that fixes members of the shape quotes that census
before and after. A shape with no census in its entry is uncounted: a PR that
fixes its members says so instead of quoting a before and after.

<!-- markdownlint-disable MD029 -->

<important if="touching a path key or path spelling">

### touching a path key or path spelling

1. **Divergent path keys:** path-keyed maps use `PathKeyedMap` and normalize on
   write, read, delete, and rehydrate. Tests use mixed separators and casing.
   A normalizer change tables every writer and reader of the map with the
   normalizer each uses; a claim that one normalizer subsumes another is
   measured per transformation (separators, dot segments, case, symlinks,
   existence), never asserted (#3178: four rounds, two inverted arms, one
   unmeasured swap). Enforced by `tests/config/path-identity-sweep.test.ts`
   (partial: a raw realpath or a raw `path.resolve` key outside
   `clients/path-utils.ts`).

2. **Host path functions in a shape branch:** once a path is classified as
   Windows-shaped, use `path.win32`; do not use host-default `path` functions.
   Prefer `toPosix`, `splitPathSegments`, and the path identity helpers.

32. **Mixed path comparison:** use one platform-aware containment expression;
    do not combine case-sensitive equality with case-folded relative paths. A
    tool-reported path is attributed with `pathsEqual` against the tool's cwd,
    capturing only the path the tool's renderer emits. Enforced by
    `tests/config/reported-path-attribution-sweep.test.ts` (shrink-only census).
    ADR: docs/adr/0009-reported-path-attribution.md

39. **Walk-up result used as eligibility:** return ownership and start-directory
    identity separately; enumerate root-position by ambient-input cells.

74. **Split host-path resolution:** a path is resolved by its provenance, at one
    seam per provenance. A path a host tool was given as an argument goes
    through `resolveHostToolPath` / `resolveToolCallFilePath`, never a bare
    `path.resolve(base, raw)`, which turns `~` into `<base>/~/…`, a path that
    cannot exist, and dispatch then reports ghost findings for it. A shell
    operand follows shell rules (a quoted tilde stays literal; no `@` strip or
    unicode fold), bound to the token it came from. A path recovered from disk
    or generated by pi-lens is an identity and is never re-resolved.

64. **Named path vs written set:** a guard keyed on the path a tool NAMES must
    hold for every path the tool WRITES; enumerate the written set (a rename's
    importers, an `ast_grep_replace` folder or its project default, a
    server-initiated `workspace/applyEdit` with no call at all) and key the
    permission per call, never per path. Three rounds on the read guard's
    authorship seam (#4187 R2-3, R4-1, R5): the pre-write retire covered the
    named path while the post-write advance covered every recorded one, so a
    file nothing checked was re-baselined over another writer's bytes. The
    screen: for each writer, table named-at-call against actually-written, and
    ask which rule answers for a path in the second column only.
    A first credit from a bridge is range-scoped to the bytes it reports, and
    settled-sweep drift never creates authorship (#4210); screen the next
    positional edit both inside and outside the reported range. This is the
    bridge/LSP/native-edit rule only: recognized bash (#4131 R2), pipeline
    sibling files, and agent_end are pinned whole-file exceptions.

65. **Unknown authorship range:** a producer that cannot recover a truthful
    range must carry UNKNOWN to `ReadGuard.creditAuthorship`; UNKNOWN
    creates no authorship. A scope after a credit is what the credit holds
    plus what it may keep, so no credit widens an empty or range scope past
    the lines it produced: not a drain, a bash write or a pipeline credit.
    A native write's creation read vouches for the whole file instead.
    UNKNOWN keeps a scope only under the writer rule
    (`mayAdvanceAuthorship`) and while a read that names a tool call bounds
    it after a move; otherwise it leaves an empty scope, which vouches for
    no line. An own oldText edit must not retire its write's authorship. A
    producer with no pre-write check says so with `advanceAuthorship:
    false`, never by leaning on UNKNOWN. Enforced at
    `clients/mutation-bridge.ts` and `clients/read-guard.ts`, with the
    F-4210-2 production bridge witness.

</important>

<important if="adding or reading a cache, durable record, or project-intelligence state">

### adding or reading a cache / durable record

4. **Unsettled resource:** every timer, worker, child, watcher, and loser path
   is unref'd or cleared on every settle path. Tracked entries are removed on
   failure as well as success. Teardown does not await a dead resource forever.
   Enforced by `tests/config/hook-await-bounds.test.ts` (partial: hook awaits
   and timeout races only; timer handles have no detector).

6. **Incomplete freshness:** use the right content, size, mtime, dependency,
   and existence axes. Missing finding paths are not current findings.
   Enforced by `tests/clients/freshness-sweep.test.ts` (partial: mtime
   comparisons must go through the kernel comparator; an mtime cache-key
   equality without a size or hash sibling is not scanned).

9. **One-axis bound:** bound the resource axis that grows, including bytes,
   timers, WASM objects, and retained evidence.
   Enforced by `tests/config/bounded-container-guard.test.ts`,
   `tests/config/bounded-eviction-idiom-sweep.test.ts` and
   `tests/clients/bounded-telemetry-sweep.test.ts` (partial: container count
   and telemetry only; bytes, WASM objects and timers have no detector).

12. **Out-of-guard mirror refresh:** refresh behavior-gating mirrors before the
    guard releases, or validate the committed generation/object identity.

15. **Timer versus long operation:** an operation holds a counted gate for its
    lifetime; a background timer checks it at fire time and re-arms a fresh,
    bounded delay.

18. **Cooldown beyond caller cadence:** verify both recovery suppression and
    promotion of values served during cooldown.

24. **Second writer without discriminator:** enumerate all writers and add a
    reason/kind field before composing branches.

28. **Cold-path work on warm path:** compute expensive record fields only inside
    the failure or timeout branch, and measure any hot-path cost.

29. **Reset cap counter:** a retire or skip records its decision where the
    selector reads it, so the same item cannot re-enter with a fresh count.

41. **Hot bound reached at p50:** record hit rate and prefer adaptive or
    demotion behavior over a constant that has become the work.

46. **Long-lived container without a bound:** module-level `Map`/`Set` state
    is bounded, evicted, or content-keyed; a reset or TTL read is not a bound.
    Enforced by `tests/config/bounded-container-guard.test.ts` (shrink-only).

47. **Retry or drain loop consumes its own work list:** a bounded retry or
    drain loop must not remove its tracked item from the collection it iterates
    on the first successful pass. Later attempts must observe the resource's
    actual absence before untracking it; tests cover a resource recreated
    between attempts.

51. **Cross-request derived-state cache where a request-local pass is
    affordable:** for a derived value on a hot path, measure a request-local
    bounded recompute first; persist it only when the fresh-process benchmark
    shows the recompute is the cost, and then the entry carries the generation
    it was derived from. Tool-run caches are governed by the delivery gate
    instead. ADR: docs/adr/0006-derived-state-benchmark-first.md

</important>

<important if="a delivery surface or lane">

### a delivery surface or lane

Project-wide scanner delivery has one owner per live worklist. The primary
session owns turn-end delivery; a concurrent secondary owns only its own
file-scoped worklist and receives no project-wide scanner output.

| Producer population | Primary turn_end | Secondary turn_end |
|---|---|---|
| Project-wide scanners (gitleaks, knip, jscpd, and equivalent shared stores) | admit and deliver | suppress at the delivery gate |
| Session-owned file or runner findings | admit its own session | admit its own session |

5. **Dropped side channel:** trace flags, bindings, and provenance through
   spreads, maps, filters, and JSON serialization.

10. **Silencing as fixing:** distinguish clean, filtered, unavailable, errored,
    suppressed, deferred, and partial results. Any bound on an agent-facing
    path discloses its truncation on the rendered surface; a count recorded
    only in `latency.log` is not disclosure (#3166 r2: an 80-finding input
    bound zeroed a neighbour's genuine errors, counted only in the log).
    An out-of-session-root project edit records one bounded degradation and
    uses the existing advisory notice seam; intended vendor skips and pi-owned
    OS-temp artifacts stay silent (`clients/runtime-tool-result.ts`,
    `clients/ephemeral-root.ts`).
    A delta decides only what is new: a blocker stays pending, recorded and
    gating, until an observation no longer holds it. An edit-range gate
    decides only delivery, and a run with no verdict (failed, unanswered, in
    flight) observes nothing, so neither retires a recorded blocker. A skip
    has a verdict only with a stated not-applicable reason
    (`RUNNER_SKIP_REASONS`). A recorded blocker is still observed only at its
    own line, aligned to the current bytes: another occurrence of the same
    rule is not it. A fallback for missing evidence narrows what retires:
    with no alignment, its identity anywhere keeps it. It stays a per-write
    hold and never widens what counts as the same finding: the match still
    needs the entry's own line text, and owed lines are matched by content,
    never widened to the file. A skip that defers to another source's
    evidence answers only for what that evidence sees, and only when that
    source answered: an edit-gated primary sees the edit, so a recorded
    finding outside it stays, and a silent primary sees nothing. A recorded
    finding is judged only by a run of its own runner: one that would defer
    to a source whose copy has another identity runs while it holds a
    recorded finding there, or nothing could retire one it cannot place. A
    kept entry with no place in a write's bytes is recorded as such
    (`positionStale`), never inferred later from one line's hash, and a line
    with no word character owes nothing by its text.
    Enforced by `tests/clients/dispatch/runners/run-outcome-ratchet.test.ts`,
    `tests/clients/dispatch/runners/parsed-nothing-sweep.test.ts` and
    `tests/clients/delivery-surface-ratchet.test.ts` (partial: no detector
    for an agent-facing bound that omits its truncation line).

26. **Old-role filter on a substitute:** compare fallback output with the
    substituted surface's contract, including non-blocking findings.

27. **Unredacted user content:** parser messages and hand-authored strings may
    contain file input; normalize and redact at the shared diagnostic seam.

31. **Pull-only observability:** new behavior emits a success or decision record
    in the streams that monitors and analyzers read. A new decision branch on a
    session, lifecycle or delivery seam names its record, cites an existing one,
    or says `none: <reason>` naming each file (`check-pr-body` prompts for it);
    a test reads a record back, and a reason is judged by the reviewer
    (#3875; recurrence #3873: the S2/S3 fixes could not be shown to fire live).
    A new or changed `catch` handler in `clients/`, `mcp/`, `tools/` or
    `index.ts` is judged by `tests/config/silent-catch-sweep.test.ts`: a record
    seam on every path, an unconditional `throw`, or a `none: <reason>` marker,
    and the file's pinned set re-pinned in the same change (`PI_LENS_PRINT_PINS=1`
    prints the rows). `scripts/` and `tests/` stay outside its scope.

75. **Swallowed failure recorded as a different event:** a `catch` that drops a
    failure and lets the normal path continue makes the log report success or
    an event that never happened (an unreadable subtree counted as deleted, a
    rejected save counted as sent). A catch on a runtime path records the
    failure under its own kind, or says `none: <reason>`. Screen: force the
    failure through the real entry point and read the record it wrote.

43. **Prose mistaken for executable structure:** define lexical states and
    reachability before scanning shell, workflow, or source text.

61. **Stand-in for unknown text stripped per consumer:** when a lexer leaves a
    placeholder for text it cannot know (a command substitution's output),
    read the input under each bounding assumption rather than teaching each
    consumer to ignore the placeholder: empty (the text the rules matched
    before it existed) and opaque (no rule word matches it, no path resolves
    through it), denying if either reading denies. Enforced by `findDeny` in
    `scripts/hooks/guard-bash.mjs`, pinned by the "substitution next to a rule
    word (#3997)" rows in `tests/scripts/guard-bash-hook.test.ts`. Recurrence:
    #3997 round 3 stripped the mark at three call sites and left
    `checkUngated`, `mktemp` flags, and `git $(:) stash` open.

49. **Whitespace counted as structure when it is alignment:** a leading run can
    be alignment, not one nesting unit (call continuations, block-comment and
    template-literal interiors; #3038, #3039, #3052, #3059, #3116). Name which
    lines carry structure and exclude the rest before counting; decline rather
    than pin a style when only ambiguous runs remain.

54. **One-direction filter proof:** a filter that drops stale input is proven
    in both directions: it never passes stale input and never drops the only
    fresh answer. The model carries a no-drop invariant beside the safety one,
    and the test double emits in the real server's measured order, not the
    order the fix assumes (#3484 r1: the fence dropped docker-langserver's only
    publish; the model checked `FreshResult` alone and the fake published after
    the fence reply).

79. **Prefix churn from a non-append write:** a provider caches the request in
    order (tools, then system, then messages), so a write that changes bytes
    before the newest message re-bills the whole conversation: a returned
    `context` list that makes pi rebuild the system head, or a tool-set change
    on a model that folds system messages into the head. Write at the tail
    only, and count each tool-set change as one full rewrite on such models. A
    host-generation gate takes a recorded fixture per certified minor, never
    two. Screen: drive two real-session requests that differ only in the
    writer, and compare the head and pi-ai's collapsed head. Enforced by
    `tests/clients/prompt-cache-prefix-writers.test.ts` (one tier-2 cell per
    writer: registration, session-start plan, activation, injection).

</important>

<important if="a runner outcome or tool execution">

### a runner or tool outcome

3. **Wrong argv transform:** verify a command is the wrapper shape before
   dropping an argv element or launcher name.

13. **Wrong failure classification:** derive availability and verdicts from raw
    evidence; preserve the classifier and evidence when a caller asserts a fact.
    Runner log parsers tolerate ANSI control sequences, padding, and CRLF before
    extracting a count; the exact Windows bytes are pinned by
    `tests/config/windows-vitest-failure-count.test.ts`, and the parser is
    `parseVitestSummary` (shape 63).
    Enforced by `tests/clients/dispatch/runners/run-outcome-ratchet.test.ts`
    and `tests/clients/dispatch/runners/parsed-nothing-sweep.test.ts`
    (partial: the classification choice itself is review-enforced; a
    latch-literal rule fires on every correct write).

16. **Unverified external-tool claim:** probe the real binary before encoding
    exit codes, output shapes, severity names, or fixtures. For a third-party
    extension, server, or file format, read its source or schema at a pinned
    SHA and pin a test vector generated from it, citing the SHA; a double
    built from an issue's description encodes the same guess (#2432).
    Enforced by `tests/clients/dispatch/smoke-fixture-coverage.test.ts`
    (partial: every registered dispatch runner needs captured real-binary bytes
    replayed by `tests/clients/dispatch/runners/captured-real-output.test.ts`,
    or an exemption naming a fact about the tool; presence only, not fidelity).

40. **Tool root drift:** all runner, formatter, and LSP child spawns use
    `resolveToolCwd`; mutation of the seam, log, or fallback must turn a test red.
    Enforced by `tests/support/spawn-cwd-scan.ts` and its runner sweep.

42. **Language-specific rule:** use `LANGUAGES` and registry facts; add a
    non-TypeScript row whenever the rule is language-neutral.

48. **Fallback direction chosen without naming the user-facing obstruction:**
    "fail closed" is not a universal justification. For each fallback, catch,
    or default, name the concrete failure that reaches the user and choose the
    direction from that harm; test unreadable, absent, and thrown lookup states
    where the seam supports both directions.

53. **Unhandled stream or process event is a host-fatal throw:** every callback
    on a child process, socket, or stream is total (catch, bound, record); a
    throw there bypasses the caller's `try/catch` and kills the pi host (#3375,
    #3383, #3389). `data` handlers are enforced by
    `tests/clients/data-handler-bounds-sweep.test.ts` and socket `error`
    listeners by `tests/clients/socket-error-listener-sweep.test.ts`, and
    worker or IPC `message` listeners (typed `unknown`, one non-rethrowing
    try) by `tests/clients/worker-message-boundary-ratchet.test.ts`; screen
    `close` and timer callbacks by hand.

60. **Wasm failure outside the #3605 containment:** every failure thrown out
    of web-tree-sitter classifies through `classifyTreeSitterWasmError`, and a
    `catch` inside a `withParsedTree` consumer calls `reportWasmAbort` before it
    swallows the error. An unclassified or swallowed trap is never counted,
    charged or recycled, and the runtime later fails elsewhere (#3996: the
    bash wasm's unresolved `isalpha` import threw an unclassified `TypeError`
    on every `[ a == b ]`, and a callback-traversal trap surfaced raw).
    `tests/clients/grammar-runtime-imports.test.ts` reds on a shipped grammar
    that imports a function the runtime does not export.

62. **Delete or rewrite through a dependency link:** a lane's `node_modules` is
    a symlink to the main checkout's install, so any verb that removes or
    rewrites under it reaches every lane (#3173: `git worktree remove` followed
    the link twice; #4044: a worker's `npm ci --dry-run` emptied it under ~7
    lanes, because npm 9.2.0 ignores `--dry-run` for the clean-install family).
    Such a verb runs only where `node_modules` is a real directory, or in a
    scratch copy. The hook's verb list (`NPM_NODE_MODULES_WRITERS` in
    `scripts/hooks/guard-bash.mjs`) is the catalog: a new verb alias or
    package manager (pnpm, yarn, bun) needs its own entry, and the hook binds
    Claude lanes only, so a codex worker's half is the plegma shim
    (apmantza/plegma#693). Sweep 2026-10-07, clean in the repo's own scripts
    (`grep -rnE "rmSync\(.*node_modules|rm -rf .*node_modules|npm ci"
    scripts clients tools`): no script runs a writer in a lane tree.
    Deletes are the second member, measured with GNU coreutils on 2026-10-07:
    `rm -rf node_modules/`, `rm -rf node_modules/*`, `find node_modules/
    -delete`, `find -L|-H node_modules -delete`, `find node_modules/ -exec rm`
    and `cd node_modules && rm -rf ./*` empty the link target, while `rm -rf
    node_modules` (no slash) removes only the link. `classifyNodeModulesDelete`
    denies the first set through the same `hasNodeModulesSymlinkOutside` seam;
    that seam follows the complete symlink chain with a fail-closed fallback
    when the target cannot be resolved (#4080).
    a lane unlinks without a slash or glob. Consolidation verdict: two rules on
    one classifier seam, kept apart because the npm rule judges a verb and the
    delete rule a path operand (deleting the delete rule relocates nothing the
    npm rule could absorb). Both share one path test,
    `operandThroughNodeModulesLink` (npm's is `<prefix>/node_modules/`, or its
    cwd plus the project its walk-up finds), and one rule for every value form
    (#4054 round 4, after round 3 regressed `--prefix "$(pwd)"`): a directory
    is tested where the program lands (the holder of each `node_modules`
    component physically, as the kernel follows a link before `..`; npm's
    `--prefix` lexically; npm's walk-up from the physical cwd), and a part
    the resolver cannot read (an unknown cwd, `$( … )`, backticks, an unknown
    variable) is the project the command runs in, failing closed in a linked
    lane only. `find -L|-follow` also counts an operand that holds the link.
    Unguarded, listed in the header's not-handled list: a glob that expands to
    the link (`rm -rf */`), `xargs rm`, `rsync --delete`, `mv`, `npx rimraf`.

63. **Tool console output parsed unstripped:** parsing Vitest or any tool's
    console output: strip ANSI first, and test with `FORCE_COLOR=1`. CI runs
    Vitest with colour, and escape codes split `Tests` from its counts and
    `FAIL` from its file, so a parser reads "no tests", "no red" or the wrong
    class (#4074, #4075, #4079, #4087: the pre-push hook recorded `failed: 0`
    for a red run). Read a Vitest transcript only through `parseVitestSummary`
    in `scripts/lib/vitest-summary.mjs` (pure, so importing it does not make a
    script a workflow writer); its consumers are guarded over a real coloured
    run by `tests/scripts/vitest-summary-consumers.test.ts`.
    Consolidation verdict: folded onto that seam (deleting it would send seven
    scripts back to private regexes). Sweep 2026-10-07 over `scripts/`,
    `scripts/lib/`, `tests/support/` and `.github/`
    (`grep -rnE "Tests\s|Test Files|stripVTControl|u001b|x1b"`): the other
    hits are the classifier's own already-normalized patterns, `ci-verdict`'s
    line classifier (strips before it matches), `check-pr-body`'s lint of pasted
    body text, and readers of Vitest's JSON report.
80. **Single scan root:** a detector takes its population from one root while
    its subject can write in several, so a clean answer from the wrong root
    reads as a complete negative. Screen: for each detector, list the roots its
    subject can write in. Then show that each root gets its own verdict, or that
    one root provably covers them. Census: not countable yet. Instance and
    dates: `HISTORY.md`.

83. **Rule re-derived beside its owner:** a consumer rebuilds a rule that a
    shared seam already owns (a marker list, a glob-to-RegExp matcher, a case
    fold) instead of calling the owner, so the copy drifts from it on
    spelling, anchoring, case and file-versus-directory. The copy is always
    plausible beside the owner, and a fix of one consumer leaves its siblings.
    Screen: before writing a marker, pattern, bound or normaliser, grep the
    tree for its literal and for the matcher that applies it; does a module
    already own it, and does this caller route through that module? Then list
    the other callers that hold their own copy and fold them or say why not.
    Census: not countable yet. Enforcer: none: judgment-only. A scan cannot
    tell a copied rule from a coincidental literal without reading what the
    value feeds. Instances and dates: `HISTORY.md`.

</important>

<important if="a test double, ratchet or sweep">

### a test double, ratchet or sweep

7. **Vacuous test:** prove the real entry point and real fixture arm. A skip is
   visible, a mock has the required fields, and the test fails pre-fix. A hook
   handler that swallows its own throw (`handleToolCall` returns `undefined`
   and records `tool-call-handler-throw`) reads a crash as the verdict under
   test: call it through `runHandlerExpectingNoThrow`
   (`tests/support/handler-verdict.ts`; the pi mock does it for `tool_call`
   hooks), enforced by `tests/config/handler-verdict-sweep.test.ts` (#4182).
   Enforced by `tests/config/vacuous-skip-coverage.test.ts` (partial: skips
   and conditional tests; "fails pre-fix" is the PR body's red transcript,
   not scannable).

8. **Name heuristic:** a filename skip has an observable count and a content
   escape hatch; never silently drop a real file.

11. **Skipped CI as green:** absent required checks are not passing checks.

14. **Duplicate module instance:** tests import the same `.js` artifact as the
    runtime and never reset a private `.ts` twin. Enforced by
    `tests/config/module-instance-coverage.test.ts`.

33. **Source assertion for runtime behavior:** prefer a runtime probe; source
    scans need proof that runtime observation is impossible.

34. **Spelling enumerator:** detect semantic structure, not a finite list of
    syntactic spellings, and test an unlisted spelling.

35. **Platform-only red:** platform-dependent tests run under injectable
    `path.posix` and `path.win32` semantics on every authoritative lane.

36. **Count-based baseline laundering:** maintenance tools match content
    identity, not occurrence counts, and refuse replacement identities.

37. **Raw control byte:** source fixtures encode control characters as escapes or
    buffers; tracked-source sweeps enforce this.

38. **Data-only admission:** a new exemption or baseline row requires a reason
    in a separate checked file and a fixture that crosses the boundary.

44. **Portable entry-module check:** compare `import.meta.url` with
    `pathToFileURL(process.argv[1]).href`.

45. **Root wrapper drops metadata:** wrappers preserve the complete marker table
    and are checked against direct root resolution.

50. **Test double's fabricated identifier reaching code that acts on it:** a
    pid, fd, port, lock path or handle invented by a mock reaches production
    code that registers, signals, writes or deletes by it (#2042, #3091).
    Verify ownership against the OS when the identifier is admitted, not its
    range. Pids are enforced by `tests/support/kill-guard.ts`; screen the
    other identifier kinds by hand.

59. **Generated edit with unlisted consumers:** a bot edit to a value that tests
    pin must leave green every test that names the edited ids. Screen: apply
    the generator's real output to the real tree (all-eligible case included),
    build, and run every test that mentions the field or the registry; this
    sweep is manual (#3994 F1, r3). Tests take "an unmeasured server" from a
    class the generator never touches, never a hard-coded id.
    A removed or demoted CI job is the same shape: before deleting it, list
    every consumer of its check name, comment marker and ci-verdict line (job
    and gate pins, advisory and deferred allowlists, contracts, PR template) and
    give each a disposition in the PR body (#4005).

66. **In-process module double with a real seam:** when a `clients/` module has
    a test setter, adopter, or reset, drive that seam; keep a double only at a
    process or host boundary. New in-process `vi.mock` targets and hand-rolled
    LSP client or service doubles are ratcheted by
    `tests/clients/flake-shape-ratchet.test.ts` (`in-process-mock`,
    `service-double`). Its census is the `in-process-mock` key of
    `tests/support/flake-shape-baseline.json`: one line per `<file>::<module>`
    row, 1009 of them on master 33eac2aa1. #4709 drives that count down.

67. **Sink read before drain:** a log sink's `log`/`append` only enqueue, so a
    test that reads the sink's byte offset, line count, or rows while one of
    its own writes is queued counts late bytes on the wrong side of its window,
    or misses them. Await that sink's flush (or `flushAllNdjsonWriters`) right
    before the read with no other await in between, or inside the reading
    helper. Enforced by `tests/config/sink-read-drain-sweep.test.ts`.

68. **Model switch drift:** a TLA+ config constant that mirrors a code choice
    (inject a read, retire on an unknown range) goes stale when the code
    changes and the constant does not, and TLC then proves the old design
    green. A PR that changes such a behaviour flips the constant in the same
    change; a `TLA+ unaffected` line never covers it. Screen: for a mapped
    file's diff, list the CONSTANTS in the family's as-built
    `formal/<family>/*.cfg` and check each against the changed branch.
    Enforced by `tests/config/tla-switch-pins.test.ts` over
    `formal/switch-pins.json`: every constant a config assigns is
    pinned, `notCodeChoice` or `deferred` with a reason; a pin names the test
    that drives the real code, and every `expect: pass` config must resolve
    the constant to the pinned value. Flipping the code reds the pin's test;
    flipping the model without the registry reds the gate. read-guard is
    fully pinned; the other families' code choices are deferred, and the
    deferred and notCodeChoice counts are pinned exactly.

69. **Enumerated detector:** a scanner that lists the spellings it knows
    passes every spelling it does not, so the guard is green while the
    defect ships. Derive the rule from the seam (the specifier, the store,
    the sink) and fail closed on an unrecognised form. Screen: plant an
    alias, an indirect call and a value reached through another binding,
    and quote each result; every green plant is fixed or named as a residual.
    On 2026-10-18 five detector PRs took two to six rounds each because
    every verify found one more spelling. A detector's first round therefore lists its admitted forms
    and refuses everything else; a residual names an admitted form that is
    too broad, never a spelling the detector does not read.

73. **Fixture adopts an ancestor root:** a fixture created with no project
    marker inherits whatever root sits above it, so one stray `.git` at the tmp
    root became the project root and #4559's quick-mode cell failed three
    pre-push runs. Plant the fixture's own marker, or assert the root it
    resolved before the case runs. Guard: planned in #4560, not yet running.

76. **Instrument attributes by id and order, not by the emitting subject:** a
    probe that brackets each phase with an offset into a buffered async sink,
    and drains rows by subject id alone, folds a sibling's late row into its own
    phase. The verdict then depends on write order, so the same measurement
    flips between two answers and a data refresh commits the artifact as a
    finding. Stamp each row with the subject that emitted it, or scope the drain
    to that subject, and require the last writer of a verdict to be the subject's
    own emitter. Enforced by `tests/clients/lsp/lsp-publish-trace-attribution.test.ts`.
    Instance and dates: `HISTORY.md`.

77. **Cancellation read as failure:** an aggregate that compares each shard's
    result against `success` reds a required check when the shard finished every
    step and lost its race with `timeout-minutes`, and no rerun recovers it,
    because the infra-kill classifier reads only `failure` runs. A shard's own
    step conclusions tell a teardown cancellation from a mid-check one, and every
    required job's measured runtime belongs beside its cap, because a cap set at
    the measured maximum fails the first time a runner is slow. That runtime is
    also a per-shard SUM, so it can never be the stale-cost verdict: only the
    table's rank agreement with the run's own ordering is scale-free enough to
    survive one shard's machine. Guard: `tests/scripts/check-shard-verdict.test.ts`
    (the seam, both fail-closed directions), the gating-step list in
    `tests/config/unit-tests-shard-workflow.test.ts`, and
    `tests/scripts/ci-verdict-runtime-cap.test.ts` (a measured runtime beside its
    cap). Instance and dates: `HISTORY.md`.

78. **A dependency's cache directory attributed to the fixture that triggered
    it:** a loader that materialises `os.tmpdir()/<tool>` on the caller's own
    stack looks like a fixture sibling, so the creator recorded for it is
    accurate per process and wrong per cause, and the sweep reds a file that
    never created it. Pin the loader's cache off for the test process rather
    than admitting the directory's name, and keep a planted sibling red to prove
    it. Enforced by the by-path-cache case in
    `tests/config/tmp-fixture-hygiene.test.ts`, plus the `JITI_FS_CACHE=0` pin
    that `tests/support/vitest-setup.ts` and `vitest.config.ts` force on the
    test process. Instance and dates: `HISTORY.md`.

81. **Synchronous native-tree walk holds every tree:** a sweep that parses many
    files with `@ast-grep/napi` in a loop that never reaches a macrotask keeps
    every native tree until the case ends, because the finalizer that frees a
    tree runs only when the event loop turns (V8 heap stays near 40 MB while RSS
    reaches 1.7 to 1.9 GB). An `await` on a settled promise does not turn it.
    Turn the loop once per file with `setImmediate`. Screen: does the loop's
    body parse, and does it reach a `setImmediate` or a real I/O await per
    iteration? Enforcer: none: judgment-only. The per-file RSS budget and its
    200 MB headroom warning observe the symptom, but a source scan cannot tell
    which loops parse without data-flow reading, so it could not fail closed.
    Instances and dates: `HISTORY.md`.

82. **One home variable pinned, the rest left at the real home:** a test or
    probe environment that pins `PI_LENS_HOME` but leaves `HOME`,
    `USERPROFILE` and the XDG directories alone lets every child that resolves
    its own config from them write into the maintainer's home
    (`~/.config/.opengrep`, `~/.config/.semgrep`), and a symlinked managed `bin`
    lets an installer write through to the real `~/.pi-lens/bin`. The pin is
    the whole set, assigned once in the worker so every child inherits it.
    Screen: which directory does the process I run resolve from, and is every
    variable that names it pinned? Enforcer:
    `tests/clients/worker-home-pin-hermeticity.test.ts` (a real child reports
    its HOME and XDG directories),
    `tests/config/real-home-reader-registry.test.ts` (a file that reads the
    real home through `REAL_HOME` or `userInfo` needs a row in
    `tests/support/real-home-readers.ts`)
    and `tests/clients/installer/managed-bin-symlink-escape-4789.test.ts`
    (a pinned `PI_LENS_HOME` whose `bin` links out is refused). Instances and
    dates: `HISTORY.md`.

</important>

<important if="session, turn or generation lifecycle">

### session, turn or generation lifecycle

17. **Process latch for session state:** every once-latch has a session reset;
    session dedupe belongs in the degradation ledger where possible.
    Host `session_start` admission survives extension factory re-runs through
    the process-lifetime `WeakSet<object>` in `clients/session-scope.ts`:
    pi's RPC re-delivery reuses one event object, while each genuine start
    allocates another, and weak identity needs no `session_shutdown` release.
    Enforced by `tests/config/session-scope-sweep.test.ts` (partial: session
    state outside the store; "every once-latch has a reset" is not scanned).

19. **Re-derived identity:** carry resolved identity or correlation across
    asynchronous stages; do not reconstruct it from ambiguous later inputs.

20. **Staleness-only fallback:** stale work is not proof of ownership; require
    origin provenance before claiming it.

21. **Late loser overwrite:** concurrent writers carry a monotonic generation;
    mutation of the generation guard must turn a test red.
    Enforced by `tests/clients/generation-guard-sweep.test.ts` (partial: no
    new hand-rolled guard; an unguarded concurrent writer is not scanned).

22. **Session-straddling write:** capture the session generation before an
    await and check it before publishing.
    Enforced by `tests/config/session-scope-sweep.test.ts` and
    `tests/clients/session-event-guard-sweep.test.ts` (partial: stale-context
    wrappers only; a write after an await with no captured scope is not
    scanned).

23. **Advanced cursor predicate:** predicates about the starting leaf receive
    the starting path, not the loop cursor.

25. **Module-scope uniqueness assumption:** process evaluation can create
    multiple copies; process-wide registries and latches use `getProcessSingleton`.
    Enforced by `tests/config/module-instance-coverage.test.ts` (partial: the
    test-side duplicate-instance half; module-level registries without
    `getProcessSingleton` are not censused).

30. **Load-time platform constant:** use a live platform read or an isolated
    fresh import for every platform branch test.

55. **Field inherited across entry kinds:** when a coalescing queue carries a
    field from a replaced entry into its replacement (a read stamp, a save
    flag), check every kind the replacement can be, not only the kind the fix
    was written for (#3491: a queued close inherited a stale touch's read stamp
    and the stale-read drop discarded the close). No model composes the two
    fixes yet; that is #3495.

56. **Subset without a population verdict:** when a mechanism, policy, guard,
    or optimisation targets N of M members, name the excluded default and a
    generalization verdict; see `docs/pi-lens-reviewer.md` (recurrence: #3622).

57. **Released-writer input shapes:** property-test generators include the
    input shapes produced by older released writers (#3594 R2-F1).

58. **Known identity carried forward:** when a producer knows an identity,
    carry it through asynchronous stages instead of re-deriving it downstream
    (#3643 F3).

70. **Joined single flight answers for edits after it started:** a caller
    that joins an in-flight scan gets an answer computed before its own
    edits. Withholding that answer and re-reading the baseline later loses
    findings when another writer stores the row in between. Deliver the
    joined answer and carry the edited files into the next scan. Screen:
    for a join, list the writers that can store the row between the join and
    the next scan, and show the finding survives each.

71. **One signal wired consumer by consumer:** a detector or notifier added on
    one consumer's seam, while other consumers derive state from the same
    files. Each detector then picks its own subset, and two tools disagree
    about one file. Screen: for a new detector, notifier or staleness marker,
    list every consumer that holds state derived from the same content, and
    show each one receives the change or record why not.

72. **Process-global last-write-wins session field:** a field that holds one
    session's value for the whole process answers for whichever session wrote
    last, so a second live session overwrites what another one read. Key the
    state by session identity, or decide from live membership. Instances:
    #4554 (fixed by #4563, still open) and #4564. No guard yet: not scanned.

**Expired successor hand-off:** an expired successor marker may authorize
    its named interrupted successor only for the fixed retention window in
    `clients/session-lifecycle.ts`; the shared slot retires at that boundary
    and records its dropped activation count before releasing the payload.
    Its test-only pending-window override is accepted only in a Vitest process;
    production keeps the fixed 60-second pending window.
    The window and supersession paths are pinned by the session lifecycle and
    session-scope tests.

</important>

<important if="availability policy or installer">

### availability or installer

52. **A second store answering the same availability question:** a new latch,
    map or cache answering "can `<tool>` run, at what path" beside the shared
    policy (`availability-policy.ts`, `createAvailabilityLatch`). A consumer the
    gate can see is enforced by `tests/clients/availability-policy-coverage.test.ts`
    (shrink-only `KNOWN_GAPS`); the named-store registry ratchet is still open
    in #1894, so a change touching another store moves it onto the shared
    policy by hand. ADR: docs/adr/0005-tool-availability-enforcement-seam.md

</important>

## Standing invariants

<!-- markdownlint-enable MD029 -->

<important if="touching language and configuration rules">

### Language and configuration

- `clients/language-registry.ts` is the identity source for language ids,
  extensions, filenames, file kinds, LSP ids, and grammars. Consumers project
  from it; they do not maintain parallel language tables.
- Agent-facing advisory text resolves names through `resolveLensToolName` with
  the delivery host: pi uses `piName`, and MCP uses `mcpName` from
  `TOOL_REGISTRY`. Known tools without a host mapping resolve to `undefined`,
  so callers omit or rephrase them; pi-only rows require
  `PI_ONLY_TOOL_REASONS`. Do not add a second name map or hard-code a pi tool
  name in advisory output (#2535).
- `clients/config-core/` owns schema validation, normalization, merging,
  provenance, deny precedence, merge strategies, trust-gated process specs,
  and bounded migration records. Existing LSP, global, and project loaders
  adopt it without adding another merge implementation.
- Canonical config is `.pi-lens.json` plus `~/.pi-lens/config.json`; locations,
  legacy migrations, and namespaces live in the config-location/schema modules.
  A new config key or environment flag needs a forcing function, stability tier,
  diagnostic code, tests, and docs.
- `rules.<id>.ignorePaths` is an experimental, project-relative path denial
  resolved by config-core with array-union semantics: global entries cannot be
  cleared by project config. Ast-grep and tree-sitter apply it before scanning;
  other runner output uses the shared rule-policy filter.
- `lens_diagnostics` has one model-facing diagnostic surface. `source` is
  `session` or `lsp`; `scope` is `paths` or `workspace`; explicit paths always
  win. Severity is a threshold. Retired compatibility names must not widen a
  request into a workspace sweep.

</important>
<important if="touching paths, data, and operating systems rules">

### Paths, data, and operating systems

- Use `PathKeyedMap` for path-keyed memory. Choose
  `normalizeEphemeralMapKey` for process-local hot indexes and `normalizeMapKey`
  for long-lived shared state. Preserve original display paths separately.
- A path a host tool was given resolves through `resolveHostToolPath` (the
  base expansion) or `resolveToolCallFilePath` (base plus pi's variant
  ladder), never a bare `path.resolve(base, raw)`; see shape 74.
- Windows-shaped paths use `path.win32` functions. Use `toPosix`,
  `splitPathSegments`, `isUnderDir`, `isSameOrWithin`, and
  `isAtOrAboveHomeDir` instead of inline separator or containment logic.
- Data and log locations follow **Data directories and logs**; never hardcode
  `.pi-lens` paths in writes or user-facing text.
- Probes and child processes pin `PI_LENS_HOME`, `PILENS_DATA_DIR`, `HOME`, and
  install/log/cache directories to `.probe-home` under the worktree; never the
  maintainer's real home, and never via `TMPDIR`/`TMP`/`TEMP`, which moves the
  vitest harness home into the checkout (#3026).
- Scratch checkouts and `mktemp -d` never land under `/tmp` (tmpfs; #3526). Use
  `~/.local/share/pi-lens-orchestrator/tmp/<lane>` for orchestrator and
  reviewer scratch, `<worktree>/../probes-<pr>` for probes, and
  `.claude/worktrees/` for a fixer's own worktree.
- Vitest also pins `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`
  and `XDG_DATA_HOME` per worker, to a scratch directory under
  `pi-lens-scratch`, so `os.homedir()` and every child a test spawns
  resolve inside it. A test that sets `HOME` itself (`pinFixtureHome`) wins. The
  real home stays reachable only as `REAL_HOME` from `tests/support/vitest-setup.ts`
  (or `os.userInfo()`), and a file that spells either is a named row in
  `tests/support/real-home-readers.ts` with a `// real-home: <reason>` header.
  The managed bin directory refuses to resolve outside a pinned `PI_LENS_HOME`
  (`assertManagedBinDirInsidePinnedHome`, `clients/installer/index.ts`).
- Vitest gives every worker its own `PI_LENS_HOME`, `<run-shared home>/worker-home-<run>-<pid>`
  (#3721); log sinks bind their path at module load, so a `PI_LENS_HOME` assigned
  in `beforeEach`/an `it` body moves nothing. A test process never truncates a log
  under the real `~/.pi-lens` (`isTestProcessTargetingRealHome`); the first refusal
  emits one `process.emitWarning` (visible on stderr) and folds a
  `log-sink-truncate-refused` row into `pilens_health`. `vitest-setup.ts` also pins the orphan-backstop
  directory through `resolveBackstopStateDir` (#3083) when the home IS the
  run-shared one. Explicit per-case homes remain authoritative. Never bypass this
  seam for its lock or stamp.
- Test tmp roots are swept by the worker that made them (#2912):
  `tests/support/vitest-setup.ts` removes every `setupTestEnvironment` root at
  `afterAll` and on SIGTERM; any other straggler reds its owner, so do not widen
  the sweep. Registry: `tests/support/tmp-root-registry.ts`.
- Two vitest invocations may share one `TMPDIR`. An invocation judges and
  sweeps only tmp entries owned by files its own workers loaded (#3314), so a
  tmp fixture names its family in the prefix at its own `mkdtempSync` or
  `setupTestEnvironment` call (#3306).
- New filesystem walkers use shared exclusions and ignore matching, cap
  walk-down work, and use the correct home-ceiling policy for walk-up discovery.

</important>
<important if="touching lsp, trust, and process execution rules">

### LSP, trust, and process execution

- `safeSpawnAsync` is the subprocess seam. It carries ambient abort behavior,
  process-tree cleanup, output caps, typed failure kinds, and bounded timeouts.
  Installs pass `ignoreAmbientSignal: true` and remain trust-gated.
  It is also the lookup chokepoint. Under pi trust other than
  `trusted`, every child's search path loses the session repository's own
  directories, and a bare command that still resolves into them is refused
  with a typed `trust-refused` result. "Session repository" is one rule in
  `clients/session-repository.ts`, never a caller-threaded root: the kernel-real
  path lies under `process.cwd()`, under a project-local bin dir of its
  ancestors below HOME, or in a checkout sharing its git commondir; the data
  dir never counts and a session at or above HOME owns nothing. Lookups that
  start a path rather than a name (`which` answers, global bin dirs, the
  installer's PATH walk, the LSP launcher) ask `isUntrustedProjectPath` or
  `admittedLookupAnswer` for the same judgment, and every refusal writes one
  `trust-refusal` row per target. A raw `node:child_process` start in the
  runtime trees is a hole by construction:
  `tests/config/spawn-chokepoint-sweep.test.ts` derives them from the module
  binding and requires each to be routed, or admitted with a reason, evidence
  and a pinned site count. Extend the seam; never add a per-caller guard. A
  non-pi maintenance host that starts the checkout's own tools adopts trust at
  its entry, as the MCP entry points do.
- Under pi, project trust is consumed through `isProjectTrusted`; pi-lens never
  registers the host's trust-answer handler. `compileLspRegistry` is the one admission
  seam for LSP executable fields: global config and built-ins remain allowed,
  while project `command`, command overrides, `env`, and
  `initializationOptions` require pi's `trusted` answer. Missing trust APIs are
  fail-closed for those project fields with one bounded notice; installs keep
  their existing compatibility policy. `tests/clients/lsp/lsp-registry-trust.test.ts`
  and the LSP config/service suites pin the boundary.
  Non-pi process entry points (`mcp/server.ts`, `mcp/worker.ts`,
  `mcp/analyze-cli.ts`, and `mcp/cli.ts`) declare trusted execution once at
  startup through `setProjectTrustState`: workspace trust belongs to their
  calling client, and pi trust is not consulted.
  `tests/mcp/server.smoke.test.ts` and `tests/mcp/analyze-cli.test.ts` pin it.
  The standalone harness scripts that drive the built `dist/clients/lsp/`
  service (`scripts/characterize-lsp.mjs`, `probe-clean-signal.mjs`,
  `server-capabilities.mjs`, `measure-lsp-idle-eviction.mjs`, `bench-lsp.mjs`,
  `smoke-tools.mjs`) are the same kind of entry point: each adopts trust once
  through `adoptFixtureProjectTrust` (`scripts/lib/lsp-fixture-workspace.mjs`),
  because a script that leaves trust `unknown` measures every refused server as
  absent. `tests/config/lsp-script-trust-census.test.ts` fails a
  `scripts/*.mjs` that reaches `dist/clients/lsp/` without it. The four nightly
  producers that run under `continue-on-error` also report what they evaluated
  to `scripts/lib/assert-evaluated.mjs` (one pure count function per producer,
  called by the script and by its test); the nightly's floor step fails below
  each measured floor and when a matrix cell classified at HEAD turned
  `unknown` without a HEAD `firstMissed` stamp at least
  `FIRST_PUBLISH_EXPIRY_DAYS` old (`tests/config/nightly-evaluated-floors.test.ts`).
  Every other
  `continue-on-error` producer either calls the same helper (`--count
  <producer>=<n> --floor <m>` from a workflow step; `--min-pass`, the
  complexity file count and the shuffle census's missing starts already do) or
  needs none, and one census decides that: every `continue-on-error` site in a
  `.github/workflows/*.yml` or `*.yaml` file and in a composite
  `.github/actions/**/action.yml` or `action.yaml` is registered in
  `tests/fixtures/nightly-floors/continue-on-error-sites.json` as `floored`
  (naming the gating step and the floor text, which must sit in the argument
  list of a named measuring invocation — `scripts/assert-evaluated.mjs`,
  `scripts/smoke-tools.mjs`, `scripts/complexity-report.mjs` — on a top-level
  line the shell executes, of a step whose `if:` is absent or a conjunction of
  `always()`, `success()`, `!cancelled()` and one `github.event_name` or
  `matrix.<name>` comparison the parsed document settles (the workflow's `on:`
  keys, that job's `strategy.matrix` list), so
  `!cancelled() && matrix.os == 'macos-latest'` counts only where the matrix
  declares that leg; every other `if:` expression, including a trivially true
  literal and a comparison no declared value satisfies, leaves the floor
  unproven, and so does a job whose own `if:` the document proves never true).
  A `\`-continued line and a line the previous one left unfinished with `&&`,
  `||` or `|` are one command, so the measuring invocation must start the
  joined command; an `exit` ends the script only in command position. A
  `no-floor` row states the reader that makes an empty result visible, or
  `governed-by` (naming the issue and the live tests that own the site, in
  files vitest collects). The reader derives the population from the parsed
  files, so it fails closed on a site the registry
  does not name, on a producer file or a non-file entry it does not classify,
  on a `continue-on-error` key in a location that is not a job or a step, and
  on a floor whose evidence is not in the argument list of such an invocation
  on a top-level command (a comment, a quoted command, a heredoc body, a
  printed command, a function or block body, a subshell, a chained command, or
  a line after an `exit`), or that names a step whose `if:` is outside that
  allowlist; a floor comes from a run recorded in
  `tests/fixtures/nightly-floors/measurements.json`. A
  `# No floor (<issue>): <reason>` header above a job is human-facing copy
  where one exists, not the record: six sites keep one (the five `lint.yml`
  jobs and `install-smoke.yml`'s `mise-repro`), and the registry row the
  census requires is the record.
  The helper must stay importable without `dist/` (the refresh-PR job runs it
  on a fresh checkout).
- LSP service generations, workspace-sweep holds, and repair latches use
  versioned process singletons. Reset tears down the old generation before a
  replacement can spawn. Idle eviction is lease-guarded and clears ownership
  timers on every removal path.
- Production callers use the grouped experimental `LspCapabilities` adapter in
  `clients/lsp/capabilities.ts`; direct `LSPService` module imports are limited
  to that adapter and are enforced by
  `tests/config/lsp-capabilities-import-sweep.test.ts` (#2372/#277).
- Idle-eviction policy is the registry's `idleEviction` field, declared per
  server. The nightly (`scripts/measure-lsp-idle-eviction.mjs`) measures every
  registry server's eviction cost and respawn safety into
  `docs/lsp-idle-eviction.md` and changes no policy; a declaration change is a
  follow-up that cites its row, or the nightly's draft promotion PR
  (`bot/lsp-idle-evict-promote`, #3989: two consecutive eligible nights, idle
  RSS floor, cold-start cap, hold list in
  `scripts/lib/lsp-idle-eviction-promote.mjs`, derived from the registry test's
  `HOLD_INDEXER_IDS` class; the PR also moves the id into
  the registry test's `TRANSPARENT_IDS`; night memory in the matrix doc's
  refresh-state block; never auto-merged, never demotes). `tests/config/lsp-idle-eviction-measurement.test.ts`
  fails when a registry server can go unmeasured without an admission or when
  the committed measurement vetoes a server declared `transparent`.
- The compiled registry holds the CATALOG ENTRY for every built-in with no
  command override (`compileLspRegistry`), so the object the client registry
  keeps (`SpawnedServer.info`) is the object `LSP_SERVERS`/`getServerById`
  exposes; an overridden server keeps its own copy so its `spawn` and trust
  admission never reach the catalog. A copy here is not a safe container: it is
  a second registry whose entries swallow every arm a caller applies to the
  first (history: `HISTORY.md`, 2026-10-19).
  `tests/clients/lsp/lsp-registry-trust.test.ts` pins both directions;
  `scheduleIdleEviction` records `lsp-idle-eviction-declined` once per server
  per session when it arms no timer.
- The server-role vocabulary and the declared trait table have one owner,
  `clients/lsp/server-traits.ts` (#1488, #1756 stage 1). Ask `isAuxiliary`,
  never a comparison against the role literal, and read `notifyInflightLimit`
  or `replyOrdering` through `serverTraits`, never by re-deriving a default;
  `LspServerRole` is declared there and nowhere else, so a second
  `"primary" | "auxiliary"` is a re-fork. `LSPServerInfo.role` is
  non-optional: a row declares it, or the factory and custom-server builders
  apply `DEFAULT_LSP_SERVER_ROLE`. Measured-behaviour markers (`silentOnClean`
  and the census siblings named by `STRATEGY_TABLE_TRAITS`) stay on
  `wait-policy/strategies.ts`, which their probes and expiry tests own; the two
  tables stay disjoint. The auxiliary lifecycle and wait policy lives in
  `clients/lsp/auxiliary-lifecycle.ts`, the diagnostic policy in
  `clients/dispatch/auxiliary-lsp.ts`. Enforced by
  `tests/config/lsp-role-predicate-sweep.test.ts` (production and `scripts/`
  trees at zero inlined predicates) and
  `tests/config/lsp-server-trait-table.test.ts` (registered-or-fail).
- Which auxiliaries the operator's configuration switches off (a kill switch
  such as `--no-opengrep` / `opengrep.enabled=false`) has one owner,
  `configDisabledAuxiliaryLspServerIds` in `clients/dispatch/auxiliary-lsp.ts`.
  The explicit `lsp_diagnostics` probe and `lsp_navigation workspaceDiagnostics`
  pass that set as `excludeServerIds` to both the touch and `getDiagnostics`,
  through the flag resolver each host injects; the session's resource degrade
  is not part of it. The probe's batch cache key comes from
  `buildProbeScopeKey`, never equal to the workspace sweep's key, because the
  sweep records before `pi-lens-ignore` and the probe after it.
- Every diagnostics entry route starts the same server set and gives the same
  confirmation verdict under each server-selecting switch (`--no-opengrep`,
  `opengrep.enabled=false`, a disabled or missing primary). Enforced by
  `tests/tools/diagnostics-route-switch-matrix.test.ts`, which derives the
  routes from every production access to an `LSPService` diagnostics member
  and fails closed on an access it cannot classify, so a new read joins the
  matrix or carries a reasoned exemption keyed by its `clientScope` and
  `diagnostics` options. Each cell asserts the exact lines the route shows.
- A file no primary answered for is unconfirmed, never clean, whether the
  primary could not start, was still starting, or is in `lsp.disabledServers`.
  The one rule is `unansweredPrimaries` (clients/lsp/index.ts), which names
  the disabled ones through `disabledPrimaries`
  (clients/lsp/session-roots.ts, not `config.js`, whose import surface the
  test mocks mirror). A `fallbackFor` alternate standing in for a disabled
  owner keeps the denial as the cause when it cannot answer either; the
  cascade names such a server once per session, not per neighbour.
  Every route words the cause through `primaryUnavailableCause` and
  `PRIMARY_UNAVAILABLE_CAUSE` (clients/lsp/diagnostic-binding.ts), never its
  own sentence. A later write of such a file prints a one-line unconfirmed
  status naming the cause, never the clean line.
- LSP roots never exceed the session-cwd ceiling. Root/config discovery uses
  shared marker seams. Child cwd resolution uses `resolveToolCwd` and its
  caller-specific markers.
- Temporary roots (#1129) are classified once per process by
  `clients/ephemeral-root.ts`, on real paths on both sides. A directory inside
  a real git checkout below `os.tmpdir()` (root or subdirectory) is a normal
  LSP root with the ephemeral idle window, and `getProjectDataDir` gives it
  its usual slug under `<base>/.ephemeral/<pid>-<8 hex>/`: normal within the
  process, never read by another one, removed by the exit hook and, for a
  dead pid, by the session-start sweep. A `pi-agent-*` path below the tmpdir
  that no checkout owns is declined at `resolveLspServerCwd` with one
  `lsp-root-declined` record per staging root per session.
- Per-path LSP notifications serialize read/build/send/record work. Pull
  cancellation blocks a same-path replacement until settlement. Waits are
  deadline- and abort-bounded, and silence is never clean.
- Document line addressing has one owner, `clients/lsp/content-scan.ts`: the
  `\n` count behind the `lsp_document_send` record's `contentLineCount` and the
  LSP sync bound (`countLfNewlines`), the last LSP-addressable line an
  Incremental change spans, and one line's text (`lineTextAt`, which the
  diagnostic-conversion call sites read) all come from it. The rule it owns is
  the count and the one-line read: no other module may `split("\n")` document
  content to obtain a line count or a single line — a send, a bound check, and
  a line read ask this owner. A module that needs the whole line array (a
  multi-line table, a per-line scan of its own document) keeps its `split`; the
  array is the value it consumes, never a way to count or to reach one line.
- `touchFile` fires a type-2 watched-file announcement at entry for the first
  seen content hash of a path, before the owner's didChange; it reaches every
  other live client of the same server across package roots through the client
  watch queue. Content hashes are session-scoped and bounded (#4156).
- A capability the client advertises has a sender, or the advertisement states
  why it has none. `textDocument/didSave` follows a landed didOpen/didChange
  only when the server declared `textDocumentSync.save` and the caller declared
  the touch a save — the post-write sync, the explicit `lsp_diagnostics` query
  and the MCP analysis's first touch (`analyzeFile`, the MCP hosts' post-write
  route), never a sweep warm-up, cascade or sweep touch. The touch debounce
  reads one rule: skip only when the bytes the server will hold once the path's
  notify queue drains are this touch's content. The evidence is the client's
  own sent-content record (`getSentContent`) AND `hasNotifyInFlight`, because
  that record reports what landed and a send still running lands after a skip.
  `hasNotifyInFlight` counts a content send only: a save-only send
  (`sendDidSaveForHeldDocument`) cannot change the bytes or remove the document,
  so it leaves the record final, while a didClose always counts. A client that
  cannot answer either question is pushed, never skipped: the elapsed window
  that used to decide there is gone (`formal/lsp-server-content`
  `GateWindowReopen` is why). Its key is (path, server): the client scope never
  re-pushes bytes a server holds. The debounce never drops a save: a saved touch
  whose push it skipped sends the save alone (`notify.save`), and the save mark
  names the content a `didSave` LANDED for, owned by the client's document
  record and written only by the send continuation. Every rebuild of that
  record carries the mark with the rest of the binding: Incremental's
  text-budget eviction strips the payload, never the save evidence. A failed
  carried save leaves the save owed; a failed standalone save gets one bounded
  retry (`GateSaveRetry`, `MutGateSaveNoRetry`) and a retry that lands for
  other bytes cannot suppress the save the next saved touch owes.

- Every server-produced `WorkspaceEdit` a path applies is bound to the bytes the
  server computed it from. Both rename flows take the request instant before
  they ask (`rename` right before `lspService.rename`, `renameFile` right before
  `workspace/willRenameFiles`) and pass `captureRenameExpectedContent`'s map as
  `expectedContent`; `clients/lsp/edits.ts` compares every bound file inside
  pi's mutation queue before its first write, refuses the whole edit, and
  records one `lsp-edit-stale-content` row naming the file. `renameFile` has no
  target (nothing read the old path), so an unopened file there is best effort
  by mtime, the same remainder the `rename` path carries. The evidence a file
  is compared against the sent-content records of every client that
  contributed a kept edit for that file, keyed by the registry client key; a
  merged edit never falls back to a different client's priority record. The
  records bind the file only when every contributor holds one; a contributor
  with none leaves the file on the mtime rule, and the refusal names it. One
  client's failed `willRenameFiles` never discards another client's answer,
  of the same server id or not. `documentVersions` is
  the other binding axis, for a server-initiated `workspace/applyEdit`. A new
  apply site binds the content or states why it cannot.
- `touchFile` freezes content-bound auxiliary coverage at merge time. A later
  publication cannot undo a finding drop. Auxiliary gaps narrow coverage and
  never turn a primary answer inconclusive. When a primary touch is
  inconclusive but the merged result contains answered diagnostics, dispatch
  preserves only diagnostics from content-confirmed contributors and carries
  the named primary gap as unconfirmed; only an empty inconclusive result is
  skipped (#4219, #4231). Auxiliaries never confirm a file alone: a touch that
  acquired auxiliaries but no primary that rooted for the file is inconclusive
  with `primary-unavailable`, naming those primaries, and `getDiagnostics`
  records the same ids as `unavailablePrimaryServerIds` (one rule,
  `unansweredPrimaries`; an auxiliary-only language is unaffected).
- A server's `window/showMessage` is observed once per distinct text per
  session (`lsp_server_message`), and an error-level message reporting that the
  server's own config or rules failed to load records
  `lsp-server-config-load-failed`. An AUXILIARY in that state never evaluated
  the bytes it reports on, so its empty publications are refused as evidence
  (`lsp_publish_dropped_server_config_failed`) and empty answers already stored
  are retracted; a non-empty answer still flows, and a language-role server is
  recorded but never gated. A refused publication still answers its send,
  the server's own `semgrep/rulesRefreshed` clears the failure, and the
  touch's `lsp-scanner-coverage-gap` reason carries the failure text. It
  composes with the hold of the empty publish before the rules load (table:
  `tests/clients/lsp/opengrep-pre-rules-publish-4763.test.ts`). Proven by
  `tests/clients/lsp/opengrep-offline-config-failure.test.ts`. The same gate
  (`auxiliaryEmptyIsNotEvidence`) refuses an auxiliary's UNVERSIONED empty
  publication that lands in the phase of the path's stored or pending finding:
  one rules generation (`semgrep/rulesRefreshed` count) and one client send.
  Opengrep's open-documents scan publishes `[]` for files it did not target, so
  that empty is no scan; a new send or a rules refresh clears as before, and a
  versioned or language-server publication keeps last write wins
  (`lsp-auxiliary-empty-after-finding`).
- The explicit `lsp_diagnostics` read checks `exceedsLspSyncLimits` once before
  warm attachment or `touchFile`; an over-bound file returns a `too_large`
  result with its byte/line measurement and records
  `lsp-diagnostics-file-too-large` once per file per session.
- Every new LSP server has a smoke fixture or a documented alternate/toolchain
  exemption. Real LSP-spawn tests belong in the serialized `lsp-spawn-heavy`
  lane.
- A `fallbackFor` family is one primary for workspace grouping: a selected
  preferred server and its sequential alternate do not disable the workspace-
  pull fast path merely because both registry members match the file. Measure
  the alternate independently; do not attribute the preferred server's
  capabilities or diagnostics to it (#3939).

</important>
<important if="touching dispatch, runners, formatters, and installers rules">

### Dispatch, runners, formatters, and installers

- The analysed-state latch records a pipeline-owned target hash captured after
  pi-lens writes and before LSP or dispatch awaits. `fileModified` also covers
  side-effect files, so `postWriteStateHash` is the ownership discriminator;
  an absent hash must not stamp the target with later disk bytes (#2499).
- The opaque prescan resolves its root once, through `opaquePrescanRoot`
  (`clients/opaque-mutation-scan.ts`), and every consumer of that session root
  asks the same owner: the baseline record and take, the head-move record and
  take, and the root each held-primary send is scoped by. A
  session whose cwd is not the coordinator's `projectRoot` — a concurrent
  secondary session, which the host's session-start guard declines before any
  `session_start` body runs — otherwise records its baseline and its HEAD under
  one root and takes them under another, reporting `no-pending-snapshot` for a
  command that did write. Scan evidence is scoped to the checkout it ran in: a
  recognized write outside that root is kept (never cleared by a scan that
  could not see it) and earns no authorship the scan cannot confirm.
- A bash command's writes are recovered from that session root AND from every
  checkout the command ITSELF names — its `cd`/`pushd` target or a recognised
  write operand — when that checkout is a linked worktree of the session's own
  repository (`resolveOpaqueRecoveryRoots`, `sameCheckoutOtherRoot`). Both hooks
  derive bounded root lists (`OPAQUE_RECOVERY_ROOT_CAP`) from the command text,
  the session root, and the checkout each hook sees at its own instant, so a
  worktree the command itself creates is admitted only at `tool_result` and its
  missing baseline is reported as `partial-recognition-no-baseline`, while a
  root both hooks admit still names one key for its record and its take; a
  checkout of another repository, a checkout named past the cap, and a
  git target under a non-checkout session root each leave one bounded
  `opaque-recovery-root-refused` record per session. This is why a `cd` into a
  sibling worktree no longer reads a clean `git status` in the wrong checkout as
  "nothing changed". Relative operands resolve against the directory in effect
  for their own segment (`scanShellWriteScopes`). That directory moves only for
  an admitted form: `cd DIR` or `pushd DIR` whose one operand is a plain
  path: bash's own word after quote removal, made only of admitted characters
  (any quoted one, an escape bash also removes, an unquoted letter, digit or
  `_./@%:,=+-`, and a leading `~` only as `~` or `~/`), starting with a
  letter, digit, `_`, `.`, `/` or `~`; or a bare `popd` of a push the scan
  admitted, entered at list start or after `&&`, `;`, a newline
  or a backgrounded list, ended by `&&`, `;`, a newline or the end, and in no
  pipeline or backgrounded list. A move entered after `&&` holds only to the end
  of that `&&` chain, because it happened only if the left side succeeded. A
  directory builtin in a pipeline or a backgrounded list leaves the directory
  unchanged. Any other directory change, construct or shell-text builtin
  returns the scan to the session root for the rest of the command.
- A recovered write is judged by the checkout that OWNS it, in both directions:
  the ignore gate a synthetic bash-write dispatch passes asks the `.gitignore`
  of the root that admitted the write (`_ownerRoot`), not the session root's, so
  a linked worktree nested under a directory the session checkout ignores is
  analysed instead of dropped silently (`.claude/worktrees/` in this
  repository); and admission asks `analysis-root.ts`
  (`canWriteAnalysisRoot(resolveAnalysisRoot(...))`) rather than re-deriving the
  rule. Ownership is compared by REAL path, so a `cd` into a symlinked spelling
  of a worktree keeps its authorship and its observed identity.
- `RUNNERS` declarations include file kinds. Runner selection is gated by file
  kind and anchored at the file's language root, not by dispatch-root config or
  declaration order. Runner children use `resolveToolCwd` with launcher markers.
- Automatic tests do not cross a Git checkout boundary, including through
  filesystem aliases: `foreignGitRoot` (`clients/test-runner-client.ts`) gates
  failed-first cache admission, retirement, every discovery path, and the
  turn-end gate. Indeterminate ownership is not a foreign verdict, a deleted
  target retires as `retired-missing`, and final rejections emit
  `test-target-foreign-checkout`. Proven by
  `tests/clients/test-runner-worktree-isolation.test.ts`.
- By design, a session whose cwd is a plain folder with no `.git` that holds several repositories, a submodule, or a nested linked worktree gets no automatic tests for the files inside them: any nested `.git` is a foreign checkout, and there is no per-project opt-in (maintainer decision, #3649/#3691). Run them explicitly.
- The one exception to that boundary is a linked worktree of the session's own repository (same git commondir, different top level, `resolveLinkedWorktreeOwner` in `clients/review-graph/git-identity.ts`, #3871): turn_end selects and runs its tests with that worktree's root as the project root (`clients/test-target-roots.ts`), so config, `node_modules` and the failed-first state are the worktree's own. A worktree root without its own runner install (no `node_modules/.bin`, venv or `vendor/bin`) is skipped with a counted `turn-end-test-root-skipped` row rather than run through `npx` or a bare interpreter; a reported location is rebased through `displayRoot` using the runner cwd first, then the dispatch root, only when that file exists, and otherwise remains as printed. A sibling worktree's file is still foreign to every other root. Python's ambient `VIRTUAL_ENV`, `CONDA_PREFIX`, or absolute `UV_PROJECT_ENVIRONMENT` is accepted for the session checkout, and for a linked worktree only when the environment root is inside that checkout; a skipped pytest row says that ambient environments were not borrowed when one is set. The edit worklist is the session's project worklist (#2504), so a session whose cwd is itself a linked worktree never sees an edit in the main checkout or a sibling and runs only its own tests. Each turn that edited files writes one `turn_end_test_selection` record to `latency.log` (candidates, selected, why not, and selected/candidates per owning root; first 8 roots, the rest in `rootsOmitted`; `selected` includes carried deferred targets, which no candidate bucket counts, so per-root `selected` can sum below it; one row of about 570 B per edit turn with candidates, bounded by log rotation only), so a turn with 0 tests is explained without the dbg lines the MCP route drops.
- Managed tools resolve through the registry and sanctioned availability seams.
  Do not hand-roll install, PATH, or package-manager discovery. Use typed
  `SpawnFailure.kind`; repair only `tool-not-found`.
- Windows LSP startup exit-code-1 failures are repairable only when the shared
  command resolver finds no command or an npm shim target is absent; present
  binaries that exit 1 remain runtime failures (#4263, #1199). The launch and
  repair gate are pinned by `tests/clients/lsp/windows-startup-repair.test.ts`.
- Expected skips remain distinct from clean success and failure. Extend the
  closed `RUNNER_SKIP_REASONS` taxonomy when policy intentionally defers work.
  Preserve the skip reason through runner latency and model-facing delivery.
- `scripts/ci-verdict.mjs` ends every CLI path with `ci-verdict: exit <N> (<kind>)`;
  read that final stdout line instead of `$?` after a pipe. `guard-bash` denies
  the piped-status recurrence while allowing output-only pipes.
- A formatter is handed the file's identity, never the link that named it:
  `realpathOrResolve` (`clients/path-utils.ts`) is the real path
  of the nearest existing ancestor plus the missing tail, with no lexical `..`
  collapse first. `formatFile` and `FormatService.formatFile` use it, so
  `AGENTS.md -> CLAUDE.md` formats `CLAUDE.md` and Prettier's "is a symbolic
  link" rejection never occurs. `FormatService.formatFile` also requires
  `sessionRoot` and classifies the identity through `resolveAnalysisRoot`: an
  `adopted` or `none` identity is refused, writes nothing, and records one
  `adopted-root-writer-skipped` row (`writer: "format"`). The refusal is on
  identity, not spelling, so a plain file outside every writable root (a
  sibling package of a monorepo session cwd, say) is refused as well; a caller
  that must format it passes that root as `sessionRoot`. Proven by
  `tests/clients/format-service-symlink-identity.test.ts`.
- Formatter and autofix policy is config-first where the registry says so.
  Formatting is strict by default. Autofix must carry per-diagnostic fixability
  or a conservative capability allowlist.
- Analyzer and runner fallback filters must match the substituted surface's
  contract. Empty output distinguishes clean, skipped, unavailable, errored,
  inconclusive, and partial states.
- Every autonomous writer (pipeline autofix, immediate/deferred formatter, and
  actionable-warning quickfix) resolves through `clients/tool-agreement.ts`.
  Its declarative population assigns one evidence bucket and declines absent,
  unreadable, unparseable, unsupported, or unregistered evidence; callers emit
  bounded degradation records. Ktlint's standalone-CLI exception still
  declines Gradle-owned projects without guessing a CLI version.
- Node tool agreement in `nodeAgreement` is established from the project's lockfile evidence in the deterministic order npm (`package-lock.json`) → pnpm (`pnpm-lock.yaml`, v9 `importers` and v6 top-level maps) → yarn (`yarn.lock`, v1 blocks and Berry `npm:` descriptors); the decision names the supplying lockfile, and missing, unreadable, unparseable, or shape-unsupported evidence declines.
- A whole-package fixer (`cargo clippy --fix`, `dart fix --apply`) rewrites
  files pi's mutation queue does not hold, so it runs through
  `runWithFixRestore` (`clients/fix-run-restore.ts`, #3598): hash the tool's
  source files, capture agent mutations pi-lens observes during the run (the
  tool_result seam and the mutation bridge), write them back after, one
  degradation per run, and name any edit that cannot be restored. The restore
  takes pi's queue entry for each sibling, one at a time (#3830). It starts
  after the caller's scan of the tool's changes and is awaited only after the
  target's hold is released, never inside it. The tool_result pipeline does not
  await it (F's result must not wait on a sibling's holder; the loss notice is
  queued as an advisory), the `agent_end` drain does, after the release: a queue entry is requested by something that holds no other
  entry, except the multi-path LSP edit, which requests in ascending key order,
  and nothing that holds an entry awaits the restore. Do not add a second
  whole-package fixer without it, and do not await a queue entry while holding
  another.
- A file's first write in a session blocks on the linter delta, not on every
  linter error. The `tool_call` of the first classified write or edit
  runs the file's inline linters (`PRE_EDIT_SEED_RUNNER_IDS`, tied to the
  edit-scope census's LINTER lanes) over the bytes still on disk, under
  `bounded()` with `PRE_EDIT_CAPTURE_BUDGET_MS` (500 ms), and installs their blocking
  findings as `session.preEdit.<file>` beside the delta baseline. The capture
  admits at most four active captures, aborts their process groups on abandonment
  or session reset, and retains slots until teardown settles. It
  only creates that record, and only while no baseline, tombstone or seed
  exists, the bytes are the ones it read, and its session is current; each
  dispatch only shrinks it (`classifyPreExisting`, identity plus line text,
  one current finding per entry). A matched finding is reported as
  pre-existing, never as a blocker, unless the inline record already holds
  it. Language servers, type checkers, gated runners and scanners are never
  seeded (maintainer scope, 2026-10-15). Collect-later linters and the MCP
  route have no seed. Proven by
  `tests/index-4483-first-write-seed-witness.test.ts`.
- `clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` is the population
  guard for child cwd derivation. Add a reasoned migration row instead of a
  pin-only update.
- Each real-bytes fixture under `tests/fixtures/runner-output/` records the
  availability probe its runner sends (`availability`: the argv, the binary
  that answered from its own banner, and the real exit status) and a real clean
  run (`clean`; there is no prose alternative). The clean record is the
  fixture's own invocation run in `tests/fixtures/runner-output-clean/<runner>`,
  whose inputs are un-ignored by `.gitignore` on purpose. One gate,
  `recordProblems` in `scripts/capture-runner-output.mjs`, refuses a record whose
  version its own answer never printed, and a clean run whose argv is not this
  fixture's; the capture and the census both call it.
  `captured-real-output.test.ts` runs the REAL checker against that record
  instead of mocking it, so a tool that rejects its own probe — helm 4 rejects
  `--version` — reaches the replay; the clean bytes are what the matrix's clean
  cell replays, in the clean workspace. `scripts/capture-runner-fixtures.mjs
  --records-only` retrofits those records onto an existing fixture without
  touching its work bytes, keyed on the fixture's own case.
  Enforced by `tests/clients/dispatch/smoke-fixture-coverage.test.ts` and
  `tests/clients/dispatch/tool-state-matrix.test.ts`.
- Every `parseToolRun` runner documents its nonzero-exit table; the documented
  `ran` codes are pinned exactly so adding or removing one does not pass
  silently, and each documented code needs an executable status fixture in the
  runner's own test matrix (#3292).

</important>
<important if="touching caches, stores, and project intelligence rules">

### Caches, stores, and project intelligence

- Behavior-gating durable stores use `clients/durable-store.ts`: lock, re-read,
  merge the caller delta, atomically publish, refresh coupled mirrors before
  releasing the lock. Best-effort derived caches declare their loss policy.
- Every cache states its freshness axes, bound, eviction axis, and invalidation
  source. A bounded entry count does not excuse unbounded bytes, timers, WASM
  objects, or persisted evidence.
- Workspace diagnostics cache mtime-drift hashing is limited by
  `CONTENT_HASH_MAX_BYTES` in `clients/content-stamp.ts`; larger entries retain
  strict mtime invalidation. Persistent reverify keeps zero mtime tolerance;
  session-state restore keeps its 1 ms tolerance.
- Tree-sitter's `queryBatchCache` is invalidated by `clearWasmInput` when a
  trapped query heals, because an in-flight batch may have cached a result that
  omitted the healed rule (#3834).
- Async publication carries a generation or epoch and checks it before and
  after awaited work. Graph snapshots are immutable by replacement.
- Review-graph, snapshot, reverse-dependency, word-index, and call-graph data
  use path identities and explicit partial-coverage markers. A capped walk is
  lower-bound evidence, never a clean zero.
- Tree-sitter uses the shared client and file-major project passes. Grammar
  crashes are blocked before load; source overrides record package/version
  provenance. Real grammar and rule tests use the warmed shared client.
- `module_report` and `symbol_search` are read-only orientation surfaces.
  `read_symbol` and `read_enclosing` return bodies and record pi read coverage;
  outlines do not claim body coverage. MCP adapters call `lens-engine.ts` only.

</important>
<important if="touching session, telemetry, and delivery rules">

### Session, telemetry, and delivery

- Registry root ownership (#3849): each holder's record in a pid entry's
  `projectRootHolders` lists exactly the roots THAT holder registered (`host`
  for `registerInstance`, a per-activation id for a declined secondary). Only
  its own `deregisterInstanceRoot`, whole-entry removal, or cap eviction ends
  a record; a root stays while any record lists it. No anonymous counts; one
  settle (`settleRootHolders`) for every writer; `getInstanceRoots` reads.
- Session state is owned by the stable session identity and activation owner.
  Detached callbacks resolve live emitters at delivery time and pair them with
  their own activation context. Never use a process-global latest session.
- Process-global bridge dependencies and the quiet-window turn-summary holder
  bind only from a live primary `SessionScope`; `clients/process-bridge.ts`
  accepts only a strictly newer scope ticket, so a concurrent secondary or
  stale activation cannot rebind a held bridge/task to its runtime (#4258).
- Session degradation uses the ledger's bounded once/count APIs and resets at
  the correct primary session boundary. `SessionStartClassification`
  (`clients/session-lifecycle.ts`): `primary` and `sequential-replacement`
  (resume and reload) both run the full start and reset; only
  `concurrent-secondary` skips the reset, since a subagent reset tears down the
  primary's warm state. `secondary` belongs to the shutdown classification. A process-lifetime latch cannot store a
  session fact without an explicit reset.
- Turn state is the turn's session's (#3613): `RuntimeCoordinator.beginTurn`
  takes the ctx's stable session id and moves the coordinator's counters,
  write-order turn and change window only for its own session, and per-turn
  warnings are partitioned by the session that recorded them. Every
  producer and reader passes that id (`tool_result`, a partial apply's
  pipeline, `turn_end`). A concurrent secondary still shares the read guard
  and the turn-end worklist (the open half of #3613). State `turn_end` parks
  in a scope cell for a later turn lives on the activation's own scope
  (`TurnEndDeps.sessionScope`, passed by `index.ts`), never on
  `runtime.sessionScope`, which is the primary's during a secondary's turn
  (#4154: the late dead-code scan). A turn-end drain or write-back is fenced
  by the scope that owns the store, taken at entry (#4161, #4168 round 3):
  the coordinator's for the coordinator and module stores a secondary
  shares, the activation's for its own scope cell. One store never answers
  to two scopes, and a secondary's end fences only its cell.
- Every session-scope hand-off decision leaves one `latency.log` row per
  lifecycle event, never one per occurrence in a loop (#3873):
  `session_handoff_slot`, `session_handoff_adopt`, `session_store_action`
  (a store's `restore` returns its `StoreCarry`, items in and kept),
  `session_scope_transition` (`end`, `demote`) and `session_end_fence_rollup`.
  `docs/pi-lens-monitor.md` lists the fields; a new session store or hand-off
  branch adds its row there in the same change.
- Logger writes use `createNdjsonLogger`; flush before reading a log. Redact at
  the sink. New failure records preserve the discriminating file/tool/record
  identity and retain dropped counts.
- `memory_sample` remains one bounded latency record. Its heap, external,
  worker-isolate, tree-sitter, and word-index fields are latest-value or O(1)
  reads; sampler assembly time is recorded in `samplerDurationMs`.
- Delivery surfaces are registered in `clients/finding-delivery-gate.ts`.
  Every model-facing diagnostic, blocker, advisory, widget, nudge, and snapshot
  either passes the shared freshness/disposition gate or carries an explicit
  bounded age label.
- The dispatcher coverage notice (`buildCoverageNotice`) latches once per
  session (`coverageNoticeSeen`) for the pi push surface; pull surfaces
  (`pilens_analyze`, including its warm PostToolUse hook route) pass
  `dedupeCoverageNotice: false` so every call carries the notice and the push
  latch stays untouched (#3791). The warm hook deliberately repeats the notice
  on every edit, matching its cold hook route. A primary off in
  `lsp.disabledServers` gets one "disabled in config" note per server per
  session instead of the per-file notice.
- `pilens:files:touched` publishers are `clients/pipeline.ts` and
  `clients/runtime-agent-end.ts`; `clients/agent-nudge.ts` is the subscriber.
  `clients/lsp-mutation.ts` has an optional callback but is not a publisher until
  it is wired. Update `tests/config/files-touched-bus-conformance.test.ts` for
  any publisher or subscriber change.
- Deferred work has a bounded queue, wall budget, abort path, carry-forward
  identity, and honest partial/deferred delivery. It never publishes a false
  clean result after cutting work.

</important>
<important if="touching git guard and host adapters rules">

### Git guard and host adapters

- Git command classification has one lexer and one guarded-verb matcher seam.
  Unknown wrappers and indirect guarded verbs fail closed. Text-consumer
  allowances recurse through command substitutions and execution contexts. A
  substitution's output is read both empty and opaque (shape 61).
- The commit gate reads two states: the inline-blocker map's latch
  (`RuntimeCoordinator`), then the persisted `turn-end-findings` record. A
  collect-later runner's blocking findings join the map through
  `clients/deferred-runner-blockers.ts`, never a second store: the turn-end
  late-runner lane records them before the blocker replay (so the replay is
  their one delivery and the composer persists them), and the gate judges
  answers that settled but no turn end has drained, then refreshes the
  persisted record (`syncGitGuardRecord`) as the inline path does at
  `tool_result`. Both sites call one verdict, `judgeDeferredRunnerFindings`
  (freshness, then policy), and the record's `sources` and `lines` come from
  `clients/inline-blocker-fields.ts`, shared with the pipeline's writer. A run
  still in flight does not gate, and an edit to the file while its re-check is in
  flight clears the record until that answer settles (#3814). The gate and the
  record's writers in `clients/git-guard.ts` and the turn-end composer read it
  at any age. Each blocker section keeps the session that wrote it (top-level
  `sessionId`, other owners in `carriedBlockers`; a record without that field
  is one owner's), and a writer replaces only its own session's sections.
  Another session's section leaves only for a file a dispatch checked
  whole and found clean (`checkedWholeFile`), or whose file is gone. Its text
  no file owns (a project lane's report: CVEs, secrets, cascade) leaves only
  when its owner rewrites it, or at a turn end once `DEFAULT_MAX_AGE_MS` has
  passed since its owner's own write (`blockerWrittenAt`, per partition; the
  record's own timestamp moves with every writer). A record written before
  this version has no stamp: the first turn end of another session that
  carries it (a composer write or a settled turn end) writes one, and its
  window starts there. Only a write logs what it drops. The gate judges a
  record alone only when this session is its sole owner. A settled turn end
  drops this session's sections and another session's expired text no file
  owns, and retires a record that is this session's own, claims no blocker, or
  holds no structured claim (the `--lens-guard`-off writer's), with one
  `record_retired` row (#4725). A dispatch that never answered
  (`pipeline_crash`, `pipeline_error`) is latched per file, apart from the
  record's latch, and only that file's own returning dispatch clears it.
- The shared-checkout guard refuses unsafe worktree mutation when another live
  session and uncommitted work are both proven. It never auto-stashes.
- `mcp/server.ts` talks to pi-lens through `clients/lens-engine.ts`. A mirrored
  capability is one engine method plus one route. MCP transport remains
  hand-rolled and dependency-free.
- Host SDK imports are type-only, except the one lazy, caught lookup of pi's
  `withFileMutationQueue` in `index.ts` (#3506), admitted by count in
  `tests/host-sdk-type-only.test.ts`; `clients/file-mutation-queue.ts` detects
  and records a second SDK copy. Runtime dependencies belong in
  `dependencies`.

</important>
## Key source layout

```text
index.ts                         pi host adapter and lifecycle wiring
mcp/                             MCP adapter and IPC hook bin
clients/lens-engine.ts           engine seam shared by host adapters
clients/runtime-session.ts       session_start lifecycle
clients/runtime-tool-call.ts     tool_call and read guard
clients/runtime-tool-result.ts  tool_result and dispatch
clients/runtime-turn.ts          turn_end and deferred delivery
clients/runtime-coordinator.ts   session, sequence, and mutation state
clients/language-registry.ts     language identity
clients/tool-config.ts           tool registry and activation policy
clients/config-core/             config validation and resolution
clients/path-utils.ts            path and walk seams
clients/file-utils.ts            data directories and project files
clients/safe-spawn.ts            subprocess seam
clients/degradation-ledger.ts   bounded degradation state
clients/lsp/                      LSP service, roots, waits, and coverage
clients/dispatch/                dispatch plans, runners, and policies
clients/durable-store.ts         locked durable read/modify/write
clients/review-graph/             graph build, query, and persistence
clients/word-index.ts             symbol index and persistence
clients/finding-delivery-gate.ts delivery inventory and freshness policy
tools/                            model-facing pi tool handlers
tests/support/                    shared fixtures, fault injection, and seams
```

Use `module_report` with `blastRadius: true` before and after production edits.
Use `read_symbol` or `read_enclosing` for bodies. Use LSP navigation as the
primary code-intelligence path; use AST search for semantic population sweeps.

<important if="tracing a host lifecycle hook or mutation seam">

## Lifecycle and mutation seams

The four primary host hooks are:

- `session_start`: reset session state, rehydrate snapshots, start bounded
  background work, and defer config/LSP discovery.
- `tool_call`: classify mutations, apply read-guard preflight, register
  reads or pending writes, and capture a file's pre-edit linter seed (below)
  before the host tool runs.
- `tool_result`: record observed mutations through
  `RuntimeCoordinator.recordProjectMutation`, then run format, autofix, LSP,
  dispatch, and bounded deferred work.
- `turn_end`: settle deferred work, deliver findings, persist bounded state, and
  run the test/actionable-warning drains. One-shot state a producer consumes
  for a part of the message (a retirement, a delivery count, a drained run)
  commits only when that part reaches the capped message; a cut part stays
  pending for the next turn (`clients/turn-end/delivery-holds.ts`, #3813). An
  item-bearing advisory with no queue to restore (knip, dead-code, call-graph
  impact) parks the items it showed on the coordinator for ONE re-offer, taken
  by the lane's next successful run and offered only while that run still
  reports them (#3901); count-and-pointer advisories (actionable and
  code-quality warnings) are not held, their report is the pull record.
- Only the write/edit `tool_result` path may block the host; `session_start`, `turn_end`, `agent_end`, `agent_settled`, and read-only `tool_result` are bounded by the outer wall; new hook awaits register in `tests/config/hook-await-bounds.test.ts`.

`RuntimeCoordinator.recordProjectMutation` is the one mutation bookkeeping seam.
Do not pair `bumpFileSeq` and change-log writes at a new call site. The mutation
bridge and opaque-write recovery feed this seam for non-native producers.

Tier-4 mutation attribution is only for third-party tool names. Names in
`clients/tool-config.ts`'s `PI_LENS_TOOL_NAMES` projection are never learned or
observed as generic edits, because one pi-lens tool may mix write and read-only
operations (for example `lsp_navigation`). MCP-only registry names remain
third-party names on pi and retain the bounded observation path.

The read guard keys all path state through its normalizer. It accepts Read,
search, LSP, bridge, bash-view, and authored-write evidence, but name-only
`ls`/`find` output is not file content. Partial edits consume preflight-approved
spans and never re-search stale bytes. Normalized oldText matches map back to
one raw span only when the normalized span has no length-expanding fold (for
example `ﬁ`→`fi`); the existing end validation remains the final guard. When
oldText is absent, the preflight wording distinguishes an unchanged full-file
read binding from actual content drift (#4265). Authorship (`writtenThisSession`)
follows content identity (#4131): it holds the bytes the conversation last
wrote, `stat` only pre-filters the hash, and another writer's byte change ends
it at the next zero-read edit, bash write or drain on the file
(`retireChangedAuthorship`); no later write resumes it. A zero-read allow
over a whole-file authorship injects a whole-file read that names the
authorship's call, so the own edit's one-line read cannot shadow the rest
and a move keeps that read exactly when it keeps the authorship; a range
scope gets none. A mutation-bridge
write (no pre-write check) may create a first authorship but ends an
existing one; the observed replay alone advances it, its tool_call having
retired every file it may replay. The store holds at most 4096 files. A branch move keeps it
iff its write's tool result is on the branch (#3603). FileTime moves only over
bytes the conversation holds whole: process bridges, observed replays and
range bridge reads leave it (#3865).

</important>
## Commands and gates

Use a pinned home/data environment for probes and child processes.

```text
npm run build                         compile in-place runtime twins
npm run build:dist                    build the published dist bundle
npm run lint                          tsc plus oxlint
npm run lint:js:tests                 required type-aware oxlint rules over tests
npm run fmt:check                     oxfmt gate
npm run knip                          unused-code gate (CI job `knip`, gating)
npm test                              serialized full suite
npm run test:targeted -- <paths>      shared-slot targeted suite

For `tests/config/heavy-advisory-gate-workflow.test.ts`, set
`PI_LENS_PRINT_PINS=1` to print the current parsed census pins as pasteable
assertion lines after workflow edits; the assertions remain shrink-only pins.
npm run test:unit                     serialized unit suite
npm run test:integration              serialized integration suite
npm run preflight                     local merge/preflight gates
npm run check:lockfile                lockfile consistency
npm run check:allow-scripts           allowScripts policy vs the resolved lockfile (#1185)
npm run changelog:check               rollup check; fragments use check-changelog-fragments.mjs
npm run docs:rule-catalogs            regenerate rule catalogs
npm run hygiene -- --dry-run          inspect worktree/process hygiene
node scripts/ci-verdict.mjs <pr|sha>  exact-head CI verdict
node scripts/gen-test-shard-weights.mjs --run <dir>...  regenerate the Unit tests shard weights
node scripts/guard-bash-probe.mjs <matrix.jsonl> [--head <ref|file>] [--base <ref|file>]
                                  [--lane linked|real|both]
                                        real-hook corpus probe (#4071): per-row verdicts
                                        against tests/fixtures/guard-bash-probes; --base
                                        prints only the rows that changed head vs base
```

CI cost gates (#3801). The heavy advisory jobs (`CodeQL (<language>) (advisory)`)
start only after every required check passed on the
head (`heavy-gate` in ci.yml; it is red when a lint.yml required check was red
or unfinished at its deadline). ci-verdict lists them with their real state
(PENDING, or NOT RUN with the gate's reason) before and after the verdict turns
success. A docs-only pull request (root `*.md`, `docs/**`, `.changelog/**` and
nothing else, classified by `scripts/ci-changed-files.mjs`; every doubt runs the
full suite) skips only those heavy advisory jobs: the Unit shards and every
other test job always run, because a docs edit can red tests outside tests/config
(`docs/public-api-stability.md`, `docs/*_rules_catalog.md`). `TLA+ models`
model-checks only when `formal/` (or its checker or ci.yml) changed. A REQUIRED
job never skips at job level: ci-verdict and the merge train demand a literal
`success`, so `TLA+ models` starts and skips its steps.

The Windows unit leg (`Unit tests Windows`, job key `unit-tests-windows`) GATES
by maintainer decision on 2026-10-17: it runs the real `win32` gates, and
advisory reds were waved through (the incidents are in `HISTORY.md`). It
therefore starts on every event like the Unit shards and is never behind
`heavy-gate`, whose docs-only skip would leave a required row absent. Its name
carries no `(advisory)` suffix, so a row it reports with a failing conclusion
gates. A row it does not report, or reports `skipped`, does not: until the
maintainer adds `Unit tests Windows` to master's required status checks,
ci-verdict is the only enforcement, and it judges only the rows that are
posted, so an absent or job-skipped Windows row reads green (shape 11). Its
population is every
`tests/config/*` file, every `process.platform` Windows gate, and the
shrink-only `WINDOWS_LANE_ADMISSIONS` rows
(`scripts/lib/win32-gate-population.mjs`); a failed or under-executed subset
reds the job, and no step of it is `continue-on-error`. A declined verdict
still leaves a record: the tmp-fixture hygiene census is quarantined on
`win32`, and its teardown prints `verdict=declined` where every other lane
prints `verdict=asserted` (the issue that retires it is in `HISTORY.md`).

The same script's `smoke` output (`PR_SMOKE_PATHS`: RPC, install, LSP launch,
trust) makes `install-smoke.yml` run all four pi-load cells and an advisory LSP
handshake job on a pull request; any other PR that reaches that workflow keeps
the one pnpm-global cell (`tests/config/pr-smoke-paths.test.ts`).
The Unit shards are packed by the per-file seconds in
`scripts/test-shard-weights.json`; regenerate it from the shards' uploaded
`vitest-results.json` when `tests/config/test-shard-assignment.test.ts` reds.

Actions cache. The repository cache is capped at 10 GB. The nightly
smoke workflows restore the managed tool tree through
`.github/actions/tool-tree-cache`, keyed on the hash of
`clients/installer/index.ts` (every pin) plus the ISO week; a pin that moves out
of that file moves the action's `hashFiles` target in the same change
(`tests/config/tool-tree-cache-workflow.test.ts`). A smoke saves its tree once
its last install step ran, red or green, because the key is first-wins per week.
`cache-prune.yml` runs `scripts/prune-actions-cache.mjs` nightly and on a push
to master that edits it, so a closed pull request's caches and superseded
copies never fill the cap; only its `prune` job holds `actions: write` and
passes `--apply` (`tests/config/cache-prune-workflow.test.ts`).
A workflow that `pull_request_target` or `workflow_run` starts never restores
or saves a cache, so a pull request cannot poison what a privileged run
restores (`tests/config/untrusted-trigger-cache.test.ts`).

A workflow job no pull request can run needs a registered reason in
`tests/config/workflow-pull-request-reachability.test.ts`, and the branch run
(`gh workflow run <file> --ref <branch>`) quoted with its run id (#3043). The
same quote is enforced per file for an edit to any workflow whose post-image no
`pull_request` run executes (no trigger, `pull_request_target` only, or a
filter that excludes the file): `scripts/check-pr-body.mjs` reds the body
without it. `Workflow run unaffected: <file> — <reason>` clears the rule only
for a workflow with no `workflow_dispatch` trigger or an edit of comments and
blank lines, verified against the merge base (#3085). The run id is quoted
evidence, not verified provenance.

The stale-build guard rejects a missing or older compiled twin. Pre-push and
`lane:check` also rebuild the bounded `dist/` dependency population before
governance suites when a bundled file is missing or older than its source.
Pre-push diffs each pushed ref against `origin/master`, or `upstream/master`
when that has commits `origin/master` lacks, and
skips a head whose tree-bound record already passed the same selection. When
that base range cannot be resolved it falls back to the remote-tip
range, and to the loud build-only pass only when that cannot resolve either.
Pre-push fails
when its bounded test-lock wait times out (#3717); `PI_LENS_PREPUSH_LOCK_SKIP=1`
is the only lock opt-out and is logged to `pre-push.log`. CI stays the gate.

A red is "unrelated" only when `node scripts/red-on-base.mjs <test files…>
[--base origin/master] [--repeat 3]` reports `RED-ON-BASE` for every failing
test; paste its output. `CAUSED-BY-CHANGE`, `INCONCLUSIVE`, and `ALL-GREEN` are
not evidence of unrelated.

Never hand-edit generated `.js` or `dist/`. Open and close PR worktrees with
`node scripts/pr-worktree.mjs open <PR|branch> [--merge|--head]` and
`close <path>`; close unlinks a symlinked `node_modules` before removal
(#2704) and refuses the main checkout, a dirty tree, or a real `node_modules`.
Open refuses (exit 2, before any fetch or mkdir) a destination that is the main
checkout or inside a registered non-bare checkout, symlinks resolved: a probe
HOME pinned under the source makes the default root a child of it (#3981). An
exact hit on another registered tree is left to git. Set `PI_LENS_WORKTREES_ROOT` to a
directory outside every checkout.

<important if="relocating project data, machine state, or telemetry">

## Data directories and logs

Project caches, snapshots, indexes, reports, and change logs use
`getProjectDataDir(cwd)`. Machine state uses `getGlobalPiLensDir()`; telemetry
uses `getGlobalPiLensLogDir()`. `PILENS_DATA_DIR` relocates project state and
`PI_LENS_HOME` relocates machine state. Display paths through
`displayProjectDataPath`; do not spell a project-data path in agent text.

All loggers use `createNdjsonLogger`. Flush the specific logger before reading
its file (shape 67); graceful `session_shutdown` returns the shared bounded drain before
pi closes stdin or exits. Relevant logs are `latency.log`, `sessionstart.log`, `cascade.log`,
`review-graph.log`, `read-guard.log`, `actionable-warnings.log`,
`extension.log`, `tree-sitter.log`, and `dispositions.log`.

</important>
<important if="building, packaging, or releasing">

## Build, packaging, and release

`main` and `pi.extensions` point to `dist/index.js`; `dist/` is generated and
not committed. `prepare` builds it for git and package installs. `build:dist`
bundles pure-JS dependencies while keeping host-provided and lazy native
packages external. Package-root resource resolution is depth-robust; pi
resolves `pi.skills` entries relative to the package root, so manifests use
`"./skills"` and never an escaping path.

Runtime imports must be production dependencies. The pi SDK is an optional
peer/dev dependency and must be imported type-only. Lockfiles use the pinned
npm version. Release notes use one `.changelog/<slug>.md` fragment per PR
(`audience: user` or `internal`; the release body lists only `user`); never
edit `CHANGELOG.md` for ordinary PR notes.
New user-facing fragments begin with a bold lead of at most 100 characters
(issue references are excluded from the count); internal fragments are exempt.

</important>
## Test requirements

- `setupTestEnvironment` plants the shared `.git` project-root marker on every
  fixture, so a fixture cannot adopt a project marker above the tmp root.
  `{ rootMarker: false }` is the named opt-out for a cell that asserts
  marker-less resolution, and says why. No cell plants a second marker at a
  fixture root: the shared one already supplies it, and a non-recursive
  `mkdirSync` there throws `EEXIST` in `beforeAll`. The hygiene owner also judges
  new non-`pi-lens-` entries at the tmp root (`path.join(fixture, "..")`) that a
  test process created, and prints the observed count beside the judged one; a
  child's own tmp cache is counted, not asserted. The bound is the hygiene
  owner's own `afterAll`: a sibling a file leaves after that boundary is out of
  scope for the census (the next run's baseline absorbs it), so fix the producer
  rather than reading the line as clean.
- A test that pins `HOME`/`USERPROFILE` uses `pinFixtureHome`
  (`tests/clients/test-utils.ts`): the home lives in the worker's scratch root
  beside its worker home, never inside a fixture root the harness deletes and
  never under `PI_LENS_HOME`, which production treats as its own housekeeping. A
  child the test never awaits writes to its inherited HOME after teardown, and a
  home inside the deleted root re-creates it after the file's sweep; no sweep
  can remove that (`tests/clients/fixture-home-teardown.test.ts`). A
  raw `process.env.HOME = …` pin in new test code is that shape. The pin
  registers its undo with the harness, and the setup restores whatever is left
  at the end of the case (`restorePinnedFixtureHomes` in its `afterEach`), so a
  setup step that throws before the call site's `finally` cannot hand the next
  case a fixture directory.

Every logic change has relevant tests. New tests use fake clocks and
`tests/clients/interleaving-kit.ts` before real time, raw sleeps, or real child
processes. Real elapsed-time assertions belong in the serialized
`wallClockBudgetInclude` lane. Real LSP child tests belong in
`lsp-spawn-heavy`. Any admitted real spawn or timer carries the flake-shape
header, baseline row, and lane membership. A new `vi.mock` of a module outside
`PROCESS_BOUNDARY_MODULES` (`tests/support/flake-shape-scan.ts`), or a new
hand-rolled LSP client or service double, carries the flake-shape header for
its detector, a baseline row, and an `ADMITTED_AFTER_BASELINE` entry.

The real-pi harness defaults to `--no-session`; a persisted-session witness
opts into `withRealPi({ persistedSession: true })`, which pins `--session-dir`
under the probe home and uses pi's documented `--continue` flag for a second
process. Read lifecycle order from the real `session_scope_transition` rows
and dead-weight rows, not from the pi mock; the mock does not re-run the
extension factory or reproduce pi lifecycle ordering.

Two in-process pi tiers sit under that child lane. A case whose verdict
depends on what pi does with a handler's return value, what the model
receives, or how pi orders a session goes through one of them, never
`tests/support/pi-mock.ts`. The double kept a `context` list as returned, pi
rebuilt the system head, and every test passed. Tier 1,
`tests/support/pi-runner.ts`, loads the built extension into pi's real
`ExtensionRunner`: flags, tools, commands, declared registrations, and no
`emit`, by design. Tier 2, `tests/support/pi-session.ts`, runs a real
`AgentSession` with pi-ai's `fauxProvider`: turns, tool round trips, session
ids, and the request the model sees. Their header comments state the APIs
and limits. A new tier capability adds a case to `pi-runner.test.ts` or
`pi-session.test.ts` first. `pi-mock.ts` stays only for a test file on
`PI_MOCK_IMPORTERS` (`tests/support/pi-mock-importers.ts`), whose row states the
class: `process-boundary` (4 rows), `internal-seam` (41: the case interposes on
a pi-lens `clients/` module either through `vi.mock`, which cannot reach the
copy pi's loader builds, or through a test-side copy of a process-global
service the loaded copy does not share, such as `clients/lsp`'s service),
`unproducible-payload` (5: a payload a scripted provider cannot
produce), `double-subject` (1: the double is the subject), and
`real-ui-harness` (1: the claim is what the TUI shows or mounts, which no
in-process tier can produce).

A row's class holds for the whole file only while every case in it needs that
class. A slice that edits an admitted file re-checks it case by case, and its
PR body records the split: moved, or stays with the class. A file whose double
replaces a spawned process (a child spawn, a pipeline runner, or a language
server binary) is `process-boundary`, not `internal-seam`. A test-side copy of
the in-process `clients/lsp` service object stays `internal-seam`.

No row carries a `pending slice` marker, and the sweep test refuses that
label: slice 7 classified the last three with the probe that keeps each on the
double, and every roadmap slice is closed, so a reopened placeholder reds
instead of naming work no slice owns. The five classes cover the list's 52
rows at that recording (slice 7 moved the `index-smells-rollup-wiring` row out
with its file), and this command reproduces them:
`grep -oE '^[[:space:]]*"[^"]*": *"[^"]+"' tests/support/pi-mock-importers.ts | sed -E 's/.*": *"([^"]+)"$/\1/' | sort | uniq -c`.
The double throws at load for a test file not on the list, so a new user fails
however it imports it. The list only shrinks:
`tests/config/pi-mock-importer-sweep.test.ts` fails on a row whose file no
longer uses it. A host claim names the host it ran on, and the per-PR tiers run
on the one installed host (`@earendil-works/pi-coding-agent`, the dev pin). The
certified spread is a manual or nightly run, never a per-PR gate:
`node scripts/probe-pi-host-tiers.mjs` runs tier 1 and tier 2 against every
certified host installed on the machine, takes the certified set from the
baseline doc's verified-host table through `scripts/lib/pi-host-spread.mjs` (the
reader the packaging ratchet uses), and prints one line per host naming the host
and the version it ran on. Each tier loads the SELECTED host's own code through
`PI_LENS_PI_HOST_PACKAGE` — tier 1's entry, and tier 2's session API and
scripted provider — so a host directory that cannot supply it fails that tier
instead of being reported as probed. It installs nothing: a host it cannot find
is reported `not installed` and only fails the run under `--require-all`, and an
installed host the certified set does not name is named in a warning and not
probed. Run `npm run build` first, because both tiers load the built extension,
and `tests/scripts/probe-pi-host-tiers.test.ts` holds the script's own logic.

When the defect is an ordering of awaits on one seam (a coalescing queue, a
per-key serializer), or the seam has regressed before, write a scheduler
property with `fc.scheduler()` instead of one more replay:
`tests/support/scheduler-properties.md`, worked example
`tests/clients/lsp/notify-queue-properties.test.ts`.

Use `tests/support/fault-injection.ts` for wedged children, seam delays,
starved budgets, and gates; `makeRunnerCtx`, `makeLspServiceDouble`, and
`makeRealRunnerEnv` for dispatch, LSP, and rule behavior. Check `tests/support/`
before writing a helper: a host case uses a pi tier, and a JSON-lines sink is
read through `readNdjsonRows` (`tests/support/ndjson-rows.ts`), never a local
`JSON.parse` loop; a claim that needs the complete output asserts its
`skipped === 0`, because the reader drops a line it cannot parse and reports
the count instead of throwing. Mock only external binaries, network, host SDK
seams (not pi's own behaviour: see the pi tiers above), clocks, or fault
injection; an in-process store, registry or coordinator is never replaced by a
fake.

Test authoring screens:

- Enter through the production entry point, not a parallel helper path.
- Make unavailable prerequisites visible with `skipIf`, never a bare return.
  Every `skipIf(process.platform …)` names the lane that runs it or reads
  `// lane: dev-box-only`; prefer a cross-platform variant through the test's
  own seam when the divergence is a technique artifact.
- Measure a platform skip for a case-variant fixture: probe the real
  filesystem for the collision first, and create the sibling fixture only
  after the probe confirms it (#3159).
- Pin the seam that broke, not a value supplied by the test.
- Make doubles depend on explicit arguments, never stack or caller inspection,
  and honour every input the production seam honours on the axis under test (a
  timeout, a budget, a generation).
- Restore env, timers, cwd, and module state; run the case in isolation.
- A case never reads state a sibling case or file wrote (a file, a latch, a
  once-per-session claim): `Targeted tests (advisory)` runs a PR's added or
  changed test files alone and under two fixed shuffle seeds
  (`scripts/ci-shuffle-changed-tests.mjs`). The untouched tree is measured by
  `scripts/ci-shuffle-census.mjs` (every file under seeds 202 and 424, and
  alone; it needs `npm run build` and `npm run build:dist` first). It
  runs nightly in `shuffle-census-nightly.yml`, not on a PR. Its known
  members sit in `scripts/shuffle-census-ratchet.json`, keyed by file, which
  only shrinks: a new member reds, and an entry clean two nights running
  must be deleted.
  A file whose subject IS the order its cases run in (a backstop that reaps
  the previous case's process, a drain the next case observes) cannot be
  fixed by restoring state: that `describe` opts out with `{ shuffle: false }`
  and a header saying why order is the behaviour under test, never the whole
  file, and is registered in the ratchet's `byDesign` rows, which
  `tests/scripts/ci-shuffle-census.test.ts` checks both ways. The reader
  (`tests/support/shuffle-opt-out-scan.ts`) admits only the minimal marker:
  an options object is read as a SEQUENCE, so a spread or a computed key it
  cannot name refuses even beside a readable `shuffle` and the last key wins;
  and a callee resolves through any number of aliases, a binding it cannot
  follow refusing when the call passes an options object.
  A `vi.doMock` is undone in the file's top-level `afterEach`, not in the
  case that mocks it: a shuffle runs the next case on the leaked mock.
  `vi.resetModules()` does not clear `globalThis` or pre-reset singletons.
  Per-case session cleanup calls `resetSessionScopedState` from
  `clients/runtime-session.ts`, rather than a hand-picked subset of resets.
  A test that proves a reset owner's own contract keeps the owner call and
  states why.
  After `vi.resetModules()`
  every `await import(...)` is a second module copy; import statically what
  the tool under test also reads.
- Keep performance bounds close to measured fixed and regressed values.
- Assert real behavior, not only mock calls or `not.toThrow`.
- Derive expected values independently; do not mirror production tables.
- Prefer behavioral assertions over snapshots.
- Name tests as declarative behavior, not hopes.
- Assert the guard's reason or sink record, not only its boolean outcome.
- A test that pins user-facing behaviour asserts the user-facing text or
  effect, not only an internal status field. History: `HISTORY.md`, 2026-10-14.
- An admitted timing test states its contention model: it measures how long
  the OS paused the worker, or asserts on CPU time rather than wall time, so a
  descheduled worker cannot red it. History: `HISTORY.md`, 2026-10-14.

Governance sweeps use `tests/support/sweep-kit.ts`, explicit source roots, and
comment/string-blanked source. Every sweep has a real floor and a checked
exemption reason. A population-deriving scanner fails closed: a needle hit
that matches none of its classified forms reds as an unclassified spelling
with its file and line, never a skip, and the scanner ships a case that plants
one. History: `HISTORY.md`, 2026-10-15. A detector that decides a test exists counts only live
declarations (`testDeclarations` in `tests/support/sweep-kit.ts`) in files
vitest collects (`tests/support/vitest-collection.ts`): a skipped, todo,
conditional (`skipIf`/`runIf`, an options key, a body skip) or uncalled test
is absent. A governance question with a data-flow answer is asked structurally,
not by extending a spelling list: `tests/support/eviction-programs.ts` owns the
eviction question over the S0 census seam's AST, admits four tabled forms, and
refuses everything else, with the live sites it still refuses tabled beside
them. New mock
exports, fixture shapes, path rules, spawn lanes, and durable fields must
update their registered-or-fail coverage tests.

<important if="adding or changing a rule or analyzer">

## Rule and analyzer contracts

Ast-grep rules live under `rules/ast-grep-rules/` and tree-sitter rules under
`rules/tree-sitter-queries/`; shared user rules use the same layout under
`<PI_LENS_HOME>/rules/`. Precedence is project > user > bundled, and a
shadowed rule is excluded from execution. Use AST patterns over regex where
possible. A rule with an unknown post-filter fails closed. Every shipped rule
has a real behavioral fixture; Java/Kotlin rules use the real CLI path because
NAPI lacks their grammars. The bundled ast-grep source census is recursive and
respects the same precedence.

The mutable rule corpus (project + user roots; bundled stays immutable per
process) has ONE identity seam, `ruleCorpusFingerprintForCycle` in
`clients/custom-rule-locations.ts`: a content fingerprint computed at most once
per dispatch cycle, keyed on `getTurnId()`, and shared by the tree-sitter
loader memo and the ast-grep source fingerprint, so both families refresh on
the same boundary. A per-call walk of that corpus is a measured regression
(#4212, 1000 warm loader calls over 170 rule files: ~1000x master for a
per-call content hash, ~220x for a per-call stat signature, ~1.1x for the
per-cycle memo), and a per-cycle memo that omits the turn identity never
invalidates. A path that must see an edit inside its own
cycle passes `force`, which recomputes and republishes into the cycle; the
dispatch runner does, and its RuleCache key is the content fingerprint
recomputed per dispatched file. `resolveBaselineSgconfig` forces because #497
point 7 pins mid-session freshness for a spawned ast-grep LSP.

Tree-sitter queries compile against the grammar of the file, not the rule's
language label. Alternative capture groups share capture names. An unsupported or
blocked grammar produces visible bounded degradation, never a clean empty
result.

</important>
## Commit, prose, issue, and observability conventions

Commit subjects use the repository conventional prefix, imperative mood, issue
reference, and no trailing period. Non-trivial commits explain what and why
in a wrapped body. Keep user-facing prose active, present-tense, concise, and
consistent. Use sentence-case headings, Oxford commas, and no em-dash chains.

Issue bodies lead with evidence, then root cause, acceptance criteria,
observability, and cross-links. Every issue has one type label and at least one
`area:` label, plus exactly one `priority:` label. Every PR includes `Summary`,
`Tests`, `Blast radius`, `Class sweep`, `Observability`, and `Fold check`; test
changes also include `Test assessment`.

Observability is part of correctness. Name the record, sink, ledger, or test
that proves a change. If no telemetry is appropriate, state why. Keep records
bounded and preserve the identity that distinguishes one degradation from
another. A phase record's timer wraps only its own call; when two writers
share one phase literal they share one stated semantic, not one writer's
meaning attributed to the other's work (#3166 r1: a walk was reported as the
policy phase).

<important if="triaging or labeling an issue">

## Issue triage & labels

Every issue should carry one TYPE label and at least one `area:` label.

- **TYPE (pick one):**
  - `bug` — broken behavior.
  - `feature` — a net-new user or agent capability.
  - `enhancement` — an improvement to an existing capability.
  - `documentation` — documentation only.
- **AREA (one or more, color `#0052cc`):** `area:lsp`, `area:dispatch`,
  `area:installer`, `area:diagnostics`, `area:read-guard`,
  `area:project-intelligence`, `area:perf`, `area:observability`,
  `area:session`, `area:config`, `area:security`, `area:tests`.
- Reuse GitHub defaults as needed (`good first issue`, `help wanted`, `question`,
  `duplicate`, `wontfix`).
- New issues get labelled at creation with `gh issue create`.

When a session touches the repository, triage open unlabelled issues. Assign one
honest priority: `priority:p1` for release-blocking correctness, data loss,
crash, hang, or host impact; `priority:p2` for normal contained work; and
`priority:p3` for opportunistic polish or help-wanted work. Use the existing
labels from `.github/labels.yml`; never create labels only through GitHub.

</important>
<important if="changing host-mode or rendered UI behavior">

## Host-mode and UI rules

`ExtensionContext.mode` is read from the event context. Only `tui` supports raw
widgets. `print` and `json` suppress proactive user notifications; unknown
modes preserve existing behavior. Raw `Component.render(width)` output goes
through `fitLine` or `fitLines` from `clients/tui-fit.ts`. Never write directly
to the terminal from clients.

</important>
## Historical context

Detailed incident narratives, completed migrations, closed design threads, and
large evidence tables moved to `HISTORY.md` on 2026-09-14. Read that file only
when the task needs historical rationale; do not copy its detail back into this
live contract unless it changes a future decision.

## Contributing

Bare-Node scripts import only `.js`/`.mjs`; type stripping is not assumed.

Every agent `Bash` call under Claude Code runs through
`scripts/hooks/guard-bash.mjs` (`PreToolUse`), which denies with its reason:
`git stash`; `git reset --soft`/`--hard`; double-force `git worktree remove`,
or any remove over a symlinked `node_modules` or over a path it cannot resolve
statically (`$(…)`, `~user`, an unset `$VAR`, a glob; #3988), where `~`, `$HOME`
and relative paths (against a preceding `cd`/`git -C`) are resolved first; a
mutating `npm` verb (`ci`, `install`, `update`, `prune`, …, or `npx npm@… ci`)
where `node_modules` is a symlink out of the project, `--dry-run` or not, and a
delete through such a link (`rm -rf node_modules/`, `node_modules/*`, `find
node_modules/ -delete`; unlinking it with `rm node_modules` stays allowed;
#4044); an unpinned `node` probe loading
`clients/` or `dist/`; `TMPDIR`/`TMP`/`TEMP` aimed at the harness home; bare
`pkill`/`killall` patterns (#3556); worktrees, clones, or `mktemp -d` under
`/tmp` (#3526); a write under `/tmp` through a redirect (`>`, `>>`, `2>`,
`&>`), `tee`, a `cp`/`mv`/`install` target, `mkdir` or `touch` only (the
harness's own `/tmp/claude-<uid>/` stays allowed, as do reads); a commit or push
chained after a check with `;` or a pipe instead of `&&` (#3471); and every
hook bypass (`--no-verify`, commit `-n`, `core.hooksPath`, `HUSKY=0`, `PI_LENS_SKIP_HOOKS=`; #3778). `kill $(pgrep -f …)`
is a known blind spot; kill your own recorded PID. For a red that looks
unrelated, prove it with `node scripts/red-on-base.mjs` and stop. Human-facing
version: `CONTRIBUTING.md` "Local git hooks".
