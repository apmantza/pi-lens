# pi-lens — agent context

## How to use this file

Read `/home/akis/.pi/agent/AGENTS.md`, then this file, then the role contract
for the task. This file is the live repository contract. Dated incident reports,
closed decisions, and detailed review archaeology belong in `HISTORY.md`.

Task routing:

- Any code change: read **Issue and PR design contract**, **Recurring defect
  shapes**, and **Test requirements**.
- LSP, dispatch, runner, formatter, installer, cache, session, telemetry,
  review-graph, Git-guard, or rule work: read the matching **Standing
  invariants** subsection and the relevant source tests.
- Delegated work: read `docs/pi-lens-subagent.md` and exactly one role contract
  from `docs/pi-lens-{fixer,reviewer,investigator,monitor,warden}.md`.
- Pi documentation work: read the installed pi documentation named by the
  global instructions. Do not infer SDK behavior from memory.

## What it is

pi-lens is a pi coding-agent extension. It runs bounded analyzers on file
writes, dispatches LSP and CLI runners, stores diagnostics, and exposes pi and
MCP tools. The host adapters are `index.ts` and `mcp/server.ts`; internal work
flows through `clients/lens-engine.ts` or the appropriate client seam.

The repository ships compiled JavaScript. TypeScript sources are authoritative;
compiled twins are generated and must not be edited by hand.

## Maintaining this file

Update this file in the same change as the behavior, structure, command, or
invariant it documents. Keep live rules short and load-bearing. Put dated
narratives and completed arcs in `HISTORY.md`; do not delete their decision
record. Place new invariants in the matching subsystem section, not at the file
end. Cite symbols and section headings, not line numbers.

Keep project instructions consistent with `CLAUDE.md`, role contracts, skills,
and tests. The repository wins when a runner-side copy differs.

## Issue and PR design contract

Every issue and PR states the outcome first, then evidence, root cause or a
labeled hypothesis, acceptance criteria, non-goals, failure semantics, test
matrix, observability, and class-sweep coverage. Use `refs #N` unless every
acceptance criterion is complete; use `closes #N` only for a complete fix.
Issue references belong in PR titles.

Before coding, trace the production entry point and write the invariants and
state-space table for stateful, ordered, resource-mutating, or security work.
Prefer the smallest existing seam. A new shared helper must remove at least
one same-shape sibling in the same change, or the brief must name every sibling,
explain why folding is unsafe, and link the follow-up.

Every bug fix has a regression test that fails on the pre-fix production path.
Read the failure and preserve its transcript. Every new guard, branch, filter,
cap, or fallback gets a compile-valid mutation that turns at least one test
red. A test that passes before the fix, or remains green after the guard is
neutered, is not evidence.

Tests use real in-process stores, sinks, coordinators, and dispatchers. Mock
only true process or host boundaries. Test telemetry by flushing and reading
the real sink. A test names the recurrence it prevents and observes an
independent effect rather than restating the implementation.

Every new failure path emits one bounded, discriminating record. Repeated
occurrences use `recordDegradationOnce` or `incrementDegradationCount`; never
emit unbounded per-occurrence logs. State the record that proves the fix in the
PR body.

Map blast radius before and after editing production modules. Name changed
symbols, callers, callees, callbacks, entry points, and affected tests. For a
shared seam, show a small call-tree or flow diff. Re-run the map after conflict
resolution or architectural change.

Sweep the whole defect shape, not only the reported instance. End every sweep
with a verdict: fold consumers onto a named seam, or stay distributed with the
reason. Deletion requests sweep callers and test doubles first. A second writer
of shared state requires an identity, generation, reason, or kind discriminator
before it lands.

## Orchestration and delegated work

Workers receive a role, absolute worktree, branch, base, acceptance criteria,
non-goals, sibling files to avoid, and Git authority. A worker without Git
authority leaves changes uncommitted and hands off through `PR_BODY.md` and
`COMMIT_MSG.txt`. Never switch branches or stash in a shared checkout. Prove
that a worker has a distinct registered worktree before it touches Git.

Do not mix investigation, implementation, and review in one delegation. Reuse
the same fixer and reviewer across correction rounds. Reviews and verification
run against the merged tree and the exact final head. The warden is read-only;
Git and GitHub authority stays with the orchestrator.

After every worker completion, push, review verdict, CI verdict, merge, or
status request, run the warden and trigger the next named owner in the same
orchestration pass. Keep a durable handoff on the PR or shared ledger with the
exact head, verdict, dispositions, and next owner.

Plegma reads are token-budgeted (#417). Do not call `plegma result` merely to
check lane occupancy. Use `watch --next --mine` for settlement notifications
and the bounded status or summary surface when available; use `result` only
when the transcript or handoff artifact is required. Never use an unbounded
`list` as a status substitute.

The human-decision class is never merged on an agent verdict alone: workflow
permission grants, release/version changes, dependency majors or lockfile
regeneration, deletion of user data or durable records, external-contributor
PRs, and changes to these rules require user decision.

For CI, verify required checks actually ran and passed on the exact head. A
conflicted PR can silently skip required jobs. Use:

```text
node scripts/ci-verdict.mjs <pr-number|sha>
```

Never merge on absent checks, stale checks, or a green advisory row alone.

## Recurring defect shapes

Use these screens before coding. The numbers are stable references for issue
and PR language; detailed historical examples are in `HISTORY.md`.

1. **Divergent path keys:** path-keyed maps use `PathKeyedMap` and normalize on
   write, read, delete, and rehydrate. Tests use mixed separators and casing.
2. **Host path functions in a shape branch:** once a path is classified as
   Windows-shaped, use `path.win32`; do not use host-default `path` functions.
   Prefer `toPosix`, `splitPathSegments`, and the canonical path helpers.
3. **Wrong argv transform:** verify a command is the wrapper shape before
   dropping an argv element or launcher name.
4. **Unsettled resource:** every timer, worker, child, watcher, and loser path
   is unref'd or cleared on every settle path. Tracked entries are removed on
   failure as well as success. Teardown does not await a dead resource forever.
5. **Dropped side channel:** trace flags, bindings, and provenance through
   spreads, maps, filters, and JSON serialization.
6. **Incomplete freshness:** use the right content, size, mtime, dependency,
   and existence axes. Missing finding paths are not current findings.
7. **Vacuous test:** prove the real entry point and real fixture arm. A skip is
   visible, a mock has the required fields, and the test fails pre-fix.
8. **Name heuristic:** a filename skip has an observable count and a content
   escape hatch; never silently drop a real file.
9. **One-axis bound:** bound the resource axis that grows, including bytes,
   timers, WASM objects, and retained evidence.
10. **Silencing as fixing:** distinguish clean, filtered, unavailable, errored,
    suppressed, deferred, and partial results.
11. **Skipped CI as green:** absent required checks are not passing checks.
12. **Out-of-guard mirror refresh:** refresh behavior-gating mirrors before the
    guard releases, or validate the committed generation/object identity.
13. **Wrong failure classification:** derive availability and verdicts from raw
    evidence; preserve the classifier and evidence when a caller asserts a fact.
14. **Duplicate module instance:** tests import the same `.js` artifact as the
    runtime and never reset a private `.ts` twin.
15. **Timer versus long operation:** an operation holds a counted gate for its
    lifetime; a background timer checks it at fire time and re-arms a fresh,
    bounded delay.
16. **Unverified external-tool claim:** probe the real binary before encoding
    exit codes, output shapes, severity names, or fixtures.
17. **Process latch for session state:** every once-latch has a session reset;
    session dedupe belongs in the degradation ledger where possible.
18. **Cooldown beyond caller cadence:** verify both recovery suppression and
    promotion of values served during cooldown.
19. **Re-derived identity:** carry resolved identity or correlation across
    asynchronous stages; do not reconstruct it from ambiguous later inputs.
20. **Staleness-only fallback:** stale work is not proof of ownership; require
    origin provenance before claiming it.
21. **Late loser overwrite:** concurrent writers carry a monotonic generation;
    mutation of the generation guard must turn a test red.
22. **Session-straddling write:** capture the session generation before an
    await and check it before publishing.
23. **Advanced cursor predicate:** predicates about the starting leaf receive
    the starting path, not the loop cursor.
24. **Second writer without discriminator:** enumerate all writers and add a
    reason/kind field before composing branches.
25. **Module-scope uniqueness assumption:** process evaluation can create
    multiple copies; process-wide registries and latches use `getProcessSingleton`.
26. **Old-role filter on a substitute:** compare fallback output with the
    substituted surface's contract, including non-blocking findings.
27. **Unredacted user content:** parser messages and hand-authored strings may
    contain file input; normalize and redact at the shared diagnostic seam.
28. **Cold-path work on warm path:** compute expensive record fields only inside
    the failure or timeout branch, and measure any hot-path cost.
29. **Reset cap counter:** a retire or skip records its decision where the
    selector reads it, so the same item cannot re-enter with a fresh count.
30. **Load-time platform constant:** use a live platform read or an isolated
    fresh import for every platform branch test.
31. **Pull-only observability:** new behavior emits a success or decision record
    in the streams that monitors and analyzers read.
32. **Mixed path comparison:** use one platform-aware containment expression;
    do not combine case-sensitive equality with case-folded relative paths.
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
39. **Walk-up result used as eligibility:** return ownership and start-directory
    identity separately; enumerate root-position by ambient-input cells.
40. **Tool root drift:** all runner, formatter, and LSP child spawns use
    `resolveToolCwd`; mutation of the seam, log, or fallback must turn a test red.
41. **Hot bound reached at p50:** record hit rate and prefer adaptive or
    demotion behavior over a constant that has become the work.
42. **Language-specific rule:** use `LANGUAGES` and registry facts; add a
    non-TypeScript row whenever the rule is language-neutral.
43. **Prose mistaken for executable structure:** define lexical states and
    reachability before scanning shell, workflow, or source text.
44. **Portable entry-module check:** compare `import.meta.url` with
    `pathToFileURL(process.argv[1]).href`.
45. **Root wrapper drops metadata:** wrappers preserve the complete marker table
    and are checked against direct root resolution.
46. **Long-lived container without a bound:** module-level or bootstrap-lived
    `Map`/`Set` state can grow per file, project, or request despite a reset.
    Classify each live occurrence as bounded, evicted, or content-keyed and
    keep the inventory shrink-only; a read-only TTL check or session reset is
    not a bound without a finite key-space argument. The bounded-container
    sweep scans `clients/`, `tools/`, `mcp/`, and `index.ts` with AST evidence
    and retains non-zero population and flagged floors.
47. **Retry or drain loop consumes its own work list:** a bounded retry or
    drain loop must not remove its tracked item from the collection it iterates
    on the first successful pass. Later attempts must observe the resource's
    actual absence before untracking it; tests cover a resource recreated
    between attempts.
48. **Fallback direction chosen without naming the user-facing obstruction:**
    "fail closed" is not a universal justification. For each fallback, catch,
    or default, name the concrete failure that reaches the user and choose the
    direction from that harm; test unreadable, absent, and thrown lookup states
    where the seam supports both directions.

## Standing invariants

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
- `lens_diagnostics` has one model-facing diagnostic surface. `source` is
  `session` or `lsp`; `scope` is `paths` or `workspace`; explicit paths always
  win. Severity is a threshold. Retired compatibility names must not widen a
  request into a workspace sweep.

### Paths, data, and operating systems

- Use `PathKeyedMap` for path-keyed memory. Choose
  `normalizeEphemeralMapKey` for process-local hot indexes and `normalizeMapKey`
  for long-lived shared state. Preserve original display paths separately.
- Windows-shaped paths use `path.win32` functions. Use `toPosix`,
  `splitPathSegments`, `isUnderDir`, `isSameOrWithin`, and
  `isAtOrAboveHomeDir` instead of inline separator or containment logic.
- Project state uses `getProjectDataDir(cwd)`; machine state uses
  `getGlobalPiLensDir()`; logs use `getGlobalPiLensLogDir()`. Never hardcode
  `.pi-lens` paths in writes or user-facing text. Use
  `displayProjectDataPath` for displayed paths.
- Probes and child processes pin `PI_LENS_HOME`, `PILENS_DATA_DIR`, `HOME`, and
  install/log/cache directories beneath the worktree or test temp directory.
  Tests set a writable `PI_LENS_HOME`; never write the maintainer's real home.
- New filesystem walkers use shared exclusions and ignore matching, cap
  walk-down work, and use the correct home-ceiling policy for walk-up discovery.

### LSP, trust, and process execution

- `safeSpawnAsync` is the subprocess seam. It carries ambient abort behavior,
  process-tree cleanup, output caps, typed failure kinds, and bounded timeouts.
  Installs pass `ignoreAmbientSignal: true` and remain trust-gated.
- Project trust is consumed through `isProjectTrusted`; pi-lens never registers
  the host's trust-answer handler. Missing trust APIs are unknown/fail-open for
  compatibility; a throwing accessor is fail-closed.
- LSP service generations, workspace-sweep holds, and repair latches use
  versioned process singletons. Reset tears down the old generation before a
  replacement can spawn. Idle eviction is lease-guarded and clears ownership
  timers on every removal path.
- LSP roots never exceed the session-cwd ceiling. Root/config discovery uses
  shared marker seams. Child cwd resolution uses `resolveToolCwd` and its
  caller-specific markers.
- Per-path LSP notifications serialize read/build/send/record work. Pull
  cancellation blocks a same-path replacement until settlement. Waits are
  deadline- and abort-bounded, and silence is never clean.
- `touchFile` freezes content-bound auxiliary coverage at merge time. A later
  publication cannot undo a finding drop. Auxiliary gaps narrow coverage and
  never turn a primary answer inconclusive.
- Every new LSP server has a smoke fixture or a documented alternate/toolchain
  exemption. Real LSP-spawn tests belong in the serialized `lsp-spawn-heavy`
  lane.

### Dispatch, runners, formatters, and installers

- The analysed-state latch records a pipeline-owned target hash captured after
  pi-lens writes and before LSP or dispatch awaits. `fileModified` also covers
  side-effect files, so `postWriteStateHash` is the ownership discriminator;
  an absent hash must not stamp the target with later disk bytes (#2499).
- `RUNNERS` declarations include file kinds. Runner selection is gated by file
  kind and anchored at the file's language root, not by dispatch-root config or
  declaration order. Runner children use `resolveToolCwd` with launcher markers.
- Managed tools resolve through the registry and sanctioned availability seams.
  Do not hand-roll install, PATH, or package-manager discovery. Use typed
  `SpawnFailure.kind`; repair only `tool-not-found`.
- Expected skips remain distinct from clean success and failure. Extend the
  closed `RUNNER_SKIP_REASONS` taxonomy when policy intentionally defers work.
  Preserve the skip reason through runner latency and model-facing delivery.
- Formatter and autofix policy is config-first where the registry says so.
  Formatting is strict by default. Autofix must carry per-diagnostic fixability
  or a conservative capability allowlist.
- Analyzer and runner fallback filters must match the substituted surface's
  contract. Empty output distinguishes clean, skipped, unavailable, errored,
  inconclusive, and partial states.
- `clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` is the population
  guard for child cwd derivation. Add a reasoned migration row instead of a
  pin-only update.

### Caches, stores, and project intelligence

- Behavior-gating durable stores use `clients/durable-store.ts`: lock, re-read,
  merge the caller delta, atomically publish, refresh coupled mirrors before
  releasing the lock. Best-effort derived caches declare their loss policy.
- Every cache states its freshness axes, bound, eviction axis, and invalidation
  source. A bounded entry count does not excuse unbounded bytes, timers, WASM
  objects, or persisted evidence.
- Async publication carries a generation or epoch and checks it before and
  after awaited work. Graph snapshots are immutable by replacement.
- Review-graph, snapshot, reverse-dependency, word-index, and call-graph data
  use canonical paths and explicit partial-coverage markers. A capped walk is
  lower-bound evidence, never a clean zero.
- Tree-sitter uses the shared client and file-major project passes. Grammar
  crashes are blocked before load; source overrides record package/version
  provenance. Real grammar and rule tests use the warmed shared client.
- `module_report` and `symbol_search` are read-only orientation surfaces.
  `read_symbol` and `read_enclosing` return bodies and record pi read coverage;
  outlines do not claim body coverage. MCP adapters call `lens-engine.ts` only.

### Session, telemetry, and delivery

- Session state is owned by the stable session identity and activation owner.
  Detached callbacks resolve live emitters at delivery time and pair them with
  their own activation context. Never use a process-global latest session.
- Session degradation uses the ledger's bounded once/count APIs and resets at
  the correct primary session boundary. A process-lifetime latch cannot store a
  session fact without an explicit reset.
- Logger writes use `createNdjsonLogger`; flush before reading a log. Redact at
  the sink. New failure records preserve the discriminating file/tool/record
  identity and retain dropped counts.
- Delivery surfaces are registered in `clients/finding-delivery-gate.ts`.
  Every model-facing diagnostic, blocker, advisory, widget, nudge, and snapshot
  either passes the shared freshness/disposition gate or carries an explicit
  bounded age label.
- `pilens:files:touched` publishers are `clients/pipeline.ts` and
  `clients/runtime-agent-end.ts`; `clients/agent-nudge.ts` is the subscriber.
  `clients/lsp-mutation.ts` has an optional callback but is not a publisher until
  it is wired. Update `tests/config/files-touched-bus-conformance.test.ts` for
  any publisher or subscriber change.
- Deferred work has a bounded queue, wall budget, abort path, carry-forward
  identity, and honest partial/deferred delivery. It never publishes a false
  clean result after cutting work.

### Git guard and host adapters

- Git command classification has one lexer and one guarded-verb matcher seam.
  Unknown wrappers and indirect guarded verbs fail closed. Text-consumer
  allowances recurse through command substitutions and execution contexts.
- The shared-checkout guard refuses unsafe worktree mutation when another live
  session and uncommitted work are both proven. It never auto-stashes.
- `mcp/server.ts` talks to pi-lens through `clients/lens-engine.ts`. A mirrored
  capability is one engine method plus one route. MCP transport remains
  hand-rolled and dependency-free.
- Raw components fit every rendered line with `clients/tui-fit.ts`. Read the
  mode from the event context: widgets require `tui`; proactive notifications
  are suppressed only in `print` and `json`.
- Host SDK imports are type-only. Runtime dependencies belong in
  `dependencies`, not `devDependencies`.

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

## Lifecycle and mutation seams

The four primary host hooks are:

- `session_start`: reset session state, rehydrate snapshots, start bounded
  background work, and defer config/LSP discovery.
- `tool_call`: classify mutations, apply read-guard preflight, and register
  reads or pending writes before the host tool runs.
- `tool_result`: record observed mutations through
  `RuntimeCoordinator.recordProjectMutation`, then run format, autofix, LSP,
  dispatch, and bounded deferred work.
- `turn_end`: settle deferred work, deliver findings, persist bounded state, and
  run the test/actionable-warning drains.

`RuntimeCoordinator.recordProjectMutation` is the one mutation bookkeeping seam.
Do not pair `bumpFileSeq` and change-log writes at a new call site. The mutation
bridge and opaque-write recovery feed this seam for non-native producers.

The read guard keys all path state through its normalizer. It accepts Read,
search, LSP, bridge, bash-view, and authored-write evidence, but name-only
`ls`/`find` output is not file content. Partial edits consume preflight-approved
spans and never re-search stale bytes.

## Commands and gates

Use a pinned home/data environment for probes and child processes.

```text
npm run build                         compile in-place runtime twins
npm run build:dist                    build the published dist bundle
npm run lint                          tsc plus oxlint
npm run fmt:check                     oxfmt gate
npm test                              serialized full suite
npm run test:targeted -- <paths>      shared-slot targeted suite
npm run test:unit                     serialized unit suite
npm run test:integration              serialized integration suite
npm run preflight                     local merge/preflight gates
npm run check:lockfile                lockfile consistency
npm run changelog:check               changelog validation
npm run docs:rule-catalogs            regenerate rule catalogs
npm run hygiene -- --dry-run          inspect worktree/process hygiene
node scripts/ci-verdict.mjs <pr|sha>  exact-head CI verdict
```

Build after TypeScript changes before tests. The stale-build guard rejects a
missing or older compiled twin. Run targeted tests while iterating and one
bounded full suite at the end; CI is authoritative under contention.

Never hand-edit generated `.js` or `dist/`. Never use `git stash`, destructive
resets, or ad hoc double-force worktree removal. The Bash hook enforces the
mechanically classifiable subset of these rules.

## Data directories and logs

Project caches, snapshots, indexes, reports, and change logs use
`getProjectDataDir(cwd)`. Machine state uses `getGlobalPiLensDir()`; telemetry
uses `getGlobalPiLensLogDir()`. `PILENS_DATA_DIR` relocates project state and
`PI_LENS_HOME` relocates machine state. Display paths through
`displayProjectDataPath`; do not spell a project-data path in agent text.

All loggers use `createNdjsonLogger`. Flush the specific logger before reading
its file. Relevant logs are `latency.log`, `sessionstart.log`, `cascade.log`,
`review-graph.log`, `read-guard.log`, `actionable-warnings.log`,
`extension.log`, `tree-sitter.log`, and `dispositions.log`.

## Build, packaging, and release

`main` and `pi.extensions` point to `dist/index.js`; `dist/` is generated and
not committed. `prepare` builds it for git and package installs. `build:dist`
bundles pure-JS dependencies while keeping host-provided and lazy native
packages external. Package-root resource resolution is depth-robust; pi
resolves `pi.skills` entries relative to the package root, so manifests use
`"./skills"` and never an escaping path.

Runtime imports must be production dependencies. The pi SDK is an optional
peer/dev dependency and must be imported type-only. Lockfiles use the pinned
npm version. Release notes use one `.changelog/<slug>.md` fragment per PR;
never edit `CHANGELOG.md` for ordinary PR notes.

## Test requirements

Every logic change has relevant tests. New tests use fake clocks and
`tests/clients/interleaving-kit.ts` before real time, raw sleeps, or real child
processes. Real elapsed-time assertions belong in the serialized
`wallClockBudgetInclude` lane. Real LSP child tests belong in
`lsp-spawn-heavy`. Any admitted real spawn or timer carries the flake-shape
header, baseline row, and lane membership.

Use `tests/support/fault-injection.ts` for wedged children, deterministic
seam delays, starved budgets, gates, and reset hooks. Use `makeRunnerCtx` for
dispatch tests, `makeLspServiceDouble` for typed LSP doubles, and
`makeRealRunnerEnv` for rule and dispatch behavior. Mock only external binaries,
network, host SDK seams, clocks, or fault injection. Do not replace a real
coordinator, store, logger, or registry with a fake.

Test authoring screens:

- Enter through the production entry point, not a parallel helper path.
- Make unavailable prerequisites visible with `skipIf`, never a bare return.
- Pin the seam that broke, not a value supplied by the test.
- Make doubles depend on explicit arguments, never stack or caller inspection.
- Restore env, timers, cwd, and module state; run the case in isolation.
- Keep performance bounds close to measured fixed and regressed values.
- Assert real behavior, not only mock calls or `not.toThrow`.
- Derive expected values independently; do not mirror production tables.
- Prefer behavioral assertions over snapshots.
- Name tests as declarative behavior, not hopes.
- Assert the guard's reason or sink record, not only its boolean outcome.

Governance sweeps use `tests/support/sweep-kit.ts`, explicit source roots, and
comment/string-blanked source. Every sweep has a real floor and a checked
exemption reason. New mock exports, fixture shapes, path rules, spawn lanes,
and durable fields must update their registered-or-fail coverage tests.

## Rule and analyzer contracts

Ast-grep rules live under `rules/ast-grep-rules/` and tree-sitter rules under
`rules/tree-sitter-queries/`. Use AST patterns over regex where possible. A
rule with an unknown post-filter fails closed. Every shipped rule has a real
behavioral fixture; Java/Kotlin rules use the real CLI path because NAPI lacks
their grammars. The bundled ast-grep source census is recursive and respects
project-over-bundled precedence.

Tree-sitter queries compile against the grammar of the file, not the rule's
language label. Alternative capture groups share capture names. Project-wide
Tree-sitter work uses the shared client and file-major pass. An unsupported or
blocked grammar produces visible bounded degradation, never a clean empty
result.

## Commit, prose, issue, and observability conventions

Commit subjects use the repository conventional prefix, imperative mood, issue
reference, and no trailing period. Non-trivial commits explain what and why
in a wrapped body. Keep user-facing prose active, present-tense, concise, and
consistent. Use sentence-case headings, Oxford commas, and no em-dash chains.

Issue bodies lead with evidence, then root cause, acceptance criteria,
observability, and cross-links. Every issue has one type label and at least one
`area:` label, plus exactly one `priority:` label. Every PR includes `Summary`,
`Tests`, `Blast radius`, `Class sweep`, and `Observability`; test changes also
include `Test assessment`.

Observability is part of correctness. Name the record, sink, ledger, or test
that proves a change. If no telemetry is appropriate, state why. Keep records
bounded and preserve the identity that distinguishes one degradation from
another.

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

## Host-mode and UI rules

`ExtensionContext.mode` is read from the event context. Only `tui` supports raw
widgets. `print` and `json` suppress proactive user notifications; unknown
modes preserve existing behavior. Raw `Component.render(width)` output goes
through `fitLine` or `fitLines` from `clients/tui-fit.ts`. Never write directly
to the terminal from clients.

## Historical context

Detailed incident narratives, completed migrations, closed design threads, and
large evidence tables moved to `HISTORY.md` on 2026-09-14. Read that file only
when the task needs historical rationale; do not copy its detail back into this
live contract unless it changes a future decision.
