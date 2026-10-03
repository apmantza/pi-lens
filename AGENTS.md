# pi-lens — agent context

## How to use this file

Read order: the engineering principles (every harness here carries a verbatim
copy in its global instructions; vendored at
[`docs/engineering-principles.md`](docs/engineering-principles.md), never
hand-edited), then this file, then the role contract for the task. This file
holds only what is specific to pi-lens and wins on conflict. Dated incidents and
closed decisions live in `HISTORY.md`.

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
- Every `Mutation diff` survivor on an added line is killed or shown
  equivalent.
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
  for one of them. `unmodelled` rows and rows of 4+ families stay advisory. A
  TLA lane that adds a family adds its map row (#3802).

<important if="delegating work or coordinating a lane">

## Orchestration and delegated work

The principles' delegation contract applies. pi-lens adds:

- A worker without Git authority hands off through `PR_BODY.md` and
  `COMMIT_MSG.txt`. Prove a worker has its own registered worktree before it
  touches Git. The warden is read-only.
- Route to the strongest available fixer, whatever the priority label: a brief
  that adds or edits a `tests/support/sweep-kit.ts` registered-or-fail sweep,
  and a path-key or normalizer change on a shared map (#3178).
- After every completion, push, verdict, merge, or status request, trigger the
  next named owner in the same pass, and keep the handoff (exact head, verdict,
  dispositions, next owner) on the PR or the ledger.
- Plegma reads are token-budgeted (#417): settlements via `watch --next --mine`,
  `result` only when the transcript or handoff artifact is needed.
- Human decision, never an agent verdict alone: workflow permission grants,
  release/version changes, dependency majors or lockfile regeneration, deletion
  of user data or durable records, external-contributor PRs, and changes to
  these rules.
- Every regroup, merged bug fix, second round on one shape, and incident runs
  the retrospective in `docs/pi-lens-retro.md`.
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
- **path key** — A normalized process-local map key; owned by `clients/path-utils.ts` (`normalizeEphemeralMapKey`); retires `path identity` and `canonical path` for ephemeral maps.
- **canonical path** — A filesystem-aware normalized path used for long-lived map state; owned by `clients/path-utils.ts` (`normalizeFilePath`); retires `resolved path` when canonical casing and realpath semantics are meant.
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
the surface they bite; each block loads only when its trigger applies.

<!-- markdownlint-disable MD029 -->

<important if="touching a path key or path spelling">

### touching a path key or path spelling

1. **Divergent path keys:** path-keyed maps use `PathKeyedMap` and normalize on
   write, read, delete, and rehydrate. Tests use mixed separators and casing.
   A normalizer change tables every writer and reader of the map with the
   normalizer each uses; a claim that one normalizer subsumes another is
   measured per transformation (separators, dot segments, case, symlinks,
   existence), never asserted (#3178: four rounds, two inverted arms, one
   unmeasured swap).

2. **Host path functions in a shape branch:** once a path is classified as
   Windows-shaped, use `path.win32`; do not use host-default `path` functions.
   Prefer `toPosix`, `splitPathSegments`, and the canonical path helpers.

32. **Mixed path comparison:** use one platform-aware containment expression;
    do not combine case-sensitive equality with case-folded relative paths. A
    tool-reported path is attributed with `pathsEqual` against the tool's cwd,
    capturing only the path the tool's renderer emits. Enforced by
    `tests/config/reported-path-attribution-sweep.test.ts` (shrink-only census).
    ADR: docs/adr/0009-reported-path-attribution.md

39. **Walk-up result used as eligibility:** return ownership and start-directory
    identity separately; enumerate root-position by ambient-input cells.

</important>

<important if="adding or reading a cache, durable record, or project-intelligence state">

### adding or reading a cache / durable record

4. **Unsettled resource:** every timer, worker, child, watcher, and loser path
   is unref'd or cleared on every settle path. Tracked entries are removed on
   failure as well as success. Teardown does not await a dead resource forever.

6. **Incomplete freshness:** use the right content, size, mtime, dependency,
   and existence axes. Missing finding paths are not current findings.

9. **One-axis bound:** bound the resource axis that grows, including bytes,
   timers, WASM objects, and retained evidence.

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

5. **Dropped side channel:** trace flags, bindings, and provenance through
   spreads, maps, filters, and JSON serialization.

10. **Silencing as fixing:** distinguish clean, filtered, unavailable, errored,
    suppressed, deferred, and partial results. Any bound on an agent-facing
    path discloses its truncation on the rendered surface; a count recorded
    only in `latency.log` is not disclosure (#3166 r2: an 80-finding input
    bound zeroed a neighbour's genuine errors, counted only in the log).

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

43. **Prose mistaken for executable structure:** define lexical states and
    reachability before scanning shell, workflow, or source text.

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

</important>

<important if="a runner outcome or tool execution">

### a runner or tool outcome

3. **Wrong argv transform:** verify a command is the wrapper shape before
   dropping an argv element or launcher name.

13. **Wrong failure classification:** derive availability and verdicts from raw
    evidence; preserve the classifier and evidence when a caller asserts a fact.

16. **Unverified external-tool claim:** probe the real binary before encoding
    exit codes, output shapes, severity names, or fixtures. For a third-party
    extension, server, or file format, read its source or schema at a pinned
    SHA and pin a test vector generated from it, citing the SHA; a double
    built from an issue's description encodes the same guess (#2432).

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
    listeners by `tests/clients/socket-error-listener-sweep.test.ts`; screen
    `close` and timer callbacks by hand.

</important>

<important if="a test double, ratchet or sweep">

### a test double, ratchet or sweep

7. **Vacuous test:** prove the real entry point and real fixture arm. A skip is
   visible, a mock has the required fields, and the test fails pre-fix.

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

</important>

<important if="session, turn or generation lifecycle">

### session, turn or generation lifecycle

17. **Process latch for session state:** every once-latch has a session reset;
    session dedupe belongs in the degradation ledger where possible.

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

25. **Module-scope uniqueness assumption:** process evaluation can create
    multiple copies; process-wide registries and latches use `getProcessSingleton`.

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
- Project trust is consumed through `isProjectTrusted`; pi-lens never registers
  the host's trust-answer handler. Missing trust APIs are unknown/fail-open for
  compatibility; a throwing accessor is fail-closed.
- LSP service generations, workspace-sweep holds, and repair latches use
  versioned process singletons. Reset tears down the old generation before a
  replacement can spawn. Idle eviction is lease-guarded and clears ownership
  timers on every removal path.
- Idle-eviction policy is the registry's `idleEviction` field, declared per
  server. The nightly (`scripts/measure-lsp-idle-eviction.mjs`) measures every
  registry server's eviction cost and respawn safety into
  `docs/lsp-idle-eviction.md` and changes no policy; a declaration change is a
  follow-up that cites its row. `tests/config/lsp-idle-eviction-measurement.test.ts`
  fails when a registry server can go unmeasured without an admission or when
  the committed measurement vetoes a server declared `transparent`.
- LSP roots never exceed the session-cwd ceiling. Root/config discovery uses
  shared marker seams. Child cwd resolution uses `resolveToolCwd` and its
  caller-specific markers.
- Per-path LSP notifications serialize read/build/send/record work. Pull
  cancellation blocks a same-path replacement until settlement. Waits are
  deadline- and abort-bounded, and silence is never clean.
- A capability the client advertises has a sender, or the advertisement states
  why it has none. `textDocument/didSave` follows a landed didOpen/didChange
  only when the server declared `textDocumentSync.save` and the caller declared
  the touch a save — the post-write sync and the explicit `lsp_diagnostics`
  query, never a warm-up, cascade or sweep touch.
- `touchFile` freezes content-bound auxiliary coverage at merge time. A later
  publication cannot undo a finding drop. Auxiliary gaps narrow coverage and
  never turn a primary answer inconclusive.
- The explicit `lsp_diagnostics` read checks `exceedsLspSyncLimits` once before
  warm attachment or `touchFile`; an over-bound file returns a `too_large`
  result with its byte/line measurement and records
  `lsp-diagnostics-file-too-large` once per file per session.
- Every new LSP server has a smoke fixture or a documented alternate/toolchain
  exemption. Real LSP-spawn tests belong in the serialized `lsp-spawn-heavy`
  lane.

</important>
<important if="touching dispatch, runners, formatters, and installers rules">

### Dispatch, runners, formatters, and installers

- The analysed-state latch records a pipeline-owned target hash captured after
  pi-lens writes and before LSP or dispatch awaits. `fileModified` also covers
  side-effect files, so `postWriteStateHash` is the ownership discriminator;
  an absent hash must not stamp the target with later disk bytes (#2499).
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
- The one exception to that boundary is a linked worktree of the session's own repository (same git commondir, different top level, `resolveLinkedWorktreeOwner` in `clients/review-graph/git-identity.ts`, #3871): turn_end selects and runs its tests with that worktree's root as the project root (`clients/test-target-roots.ts`), so config, `node_modules` and the failed-first state are the worktree's own. A worktree root without its own runner install (no `node_modules/.bin`, venv or `vendor/bin`) is skipped with a counted `turn-end-test-root-skipped` row rather than run through `npx` or a bare interpreter; a failure there is located relative to the session checkout; a sibling worktree's file is still foreign to every other root.
- Managed tools resolve through the registry and sanctioned availability seams.
  Do not hand-roll install, PATH, or package-manager discovery. Use typed
  `SpawnFailure.kind`; repair only `tool-not-found`.
- Expected skips remain distinct from clean success and failure. Extend the
  closed `RUNNER_SKIP_REASONS` taxonomy when policy intentionally defers work.
  Preserve the skip reason through runner latency and model-facing delivery.
- `scripts/ci-verdict.mjs` ends every CLI path with `ci-verdict: exit <N> (<kind>)`;
  read that final stdout line instead of `$?` after a pipe. `guard-bash` denies
  the piped-status recurrence while allowing output-only pipes.
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
- `clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` is the population
  guard for child cwd derivation. Add a reasoned migration row instead of a
  pin-only update.
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

</important>
<important if="touching session, telemetry, and delivery rules">

### Session, telemetry, and delivery

- Session state is owned by the stable session identity and activation owner.
  Detached callbacks resolve live emitters at delivery time and pair them with
  their own activation context. Never use a process-global latest session.
- Session degradation uses the ledger's bounded once/count APIs and resets at
  the correct primary session boundary. `SessionStartClassification`
  (`clients/session-lifecycle.ts`): `primary` and `sequential-replacement`
  (resume and reload) both run the full start and reset; only
  `concurrent-secondary` skips the reset, since a subagent reset tears down the
  primary's warm state. `secondary` belongs to the shutdown classification. A process-lifetime latch cannot store a
  session fact without an explicit reset.
- Logger writes use `createNdjsonLogger`; flush before reading a log. Redact at
  the sink. New failure records preserve the discriminating file/tool/record
  identity and retain dropped counts.
- Delivery surfaces are registered in `clients/finding-delivery-gate.ts`.
  Every model-facing diagnostic, blocker, advisory, widget, nudge, and snapshot
  either passes the shared freshness/disposition gate or carries an explicit
  bounded age label.
- The dispatcher coverage notice (`buildCoverageNotice`) latches once per
  session (`coverageNoticeSeen`) for the pi push surface; pull surfaces
  (`pilens_analyze`, including its warm PostToolUse hook route) pass
  `dedupeCoverageNotice: false` so every call carries the notice and the push
  latch stays untouched (#3791). The warm hook deliberately repeats the notice
  on every edit, matching its cold hook route.
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
  allowances recurse through command substitutions and execution contexts.
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
  flight clears the record until that answer settles (#3814).
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
- `tool_call`: classify mutations, apply read-guard preflight, and register
  reads or pending writes before the host tool runs.
- `tool_result`: record observed mutations through
  `RuntimeCoordinator.recordProjectMutation`, then run format, autofix, LSP,
  dispatch, and bounded deferred work.
- `turn_end`: settle deferred work, deliver findings, persist bounded state, and
  run the test/actionable-warning drains. One-shot state a producer consumes
  for a part of the message (a retirement, a delivery count, a drained run)
  commits only when that part reaches the capped message; a cut part stays
  pending for the next turn (`clients/turn-end/delivery-holds.ts`, #3813).
- Only the write/edit `tool_result` path may block the host; `session_start`, `turn_end`, `agent_end`, `agent_settled`, and read-only `tool_result` are bounded by the outer wall; new hook awaits register in `tests/config/hook-await-bounds.test.ts`.

`RuntimeCoordinator.recordProjectMutation` is the one mutation bookkeeping seam.
Do not pair `bumpFileSeq` and change-log writes at a new call site. The mutation
bridge and opaque-write recovery feed this seam for non-native producers.

The read guard keys all path state through its normalizer. It accepts Read,
search, LSP, bridge, bash-view, and authored-write evidence, but name-only
`ls`/`find` output is not file content. Partial edits consume preflight-approved
spans and never re-search stale bytes.

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
npm run test:unit                     serialized unit suite
npm run test:integration              serialized integration suite
npm run preflight                     local merge/preflight gates
npm run check:lockfile                lockfile consistency
npm run changelog:check               rollup check; fragments use check-changelog-fragments.mjs
npm run docs:rule-catalogs            regenerate rule catalogs
npm run hygiene -- --dry-run          inspect worktree/process hygiene
node scripts/ci-verdict.mjs <pr|sha>  exact-head CI verdict
node scripts/gen-test-shard-weights.mjs --run <dir>...  regenerate the Unit tests shard weights
```

CI cost gates (#3801). The heavy advisory jobs (`mutation (advisory)`, `Unit
tests Windows (advisory)`) start only after every required check passed on the
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
The Unit shards are packed by the per-file seconds in
`scripts/test-shard-weights.json`; regenerate it from the shards' uploaded
`vitest-results.json` when `tests/config/test-shard-assignment.test.ts` reds.

A workflow job no pull request can run needs a registered reason in
`tests/config/workflow-pull-request-reachability.test.ts`, and the branch run
(`gh workflow run <file> --ref <branch>`) quoted with its run id (#3043).

The stale-build guard rejects a missing or older compiled twin. Pre-push fails
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

<important if="relocating project data, machine state, or telemetry">

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

</important>
## Test requirements

Every logic change has relevant tests. New tests use fake clocks and
`tests/clients/interleaving-kit.ts` before real time, raw sleeps, or real child
processes. Real elapsed-time assertions belong in the serialized
`wallClockBudgetInclude` lane. Real LSP child tests belong in
`lsp-spawn-heavy`. Any admitted real spawn or timer carries the flake-shape
header, baseline row, and lane membership.

When the defect is an ordering of awaits on one seam (a coalescing queue, a
per-key serializer), or the seam has regressed before, write a scheduler
property with `fc.scheduler()` instead of one more replay:
`tests/support/scheduler-properties.md`, worked example
`tests/clients/lsp/notify-queue-properties.test.ts`.

Use `tests/support/fault-injection.ts` for wedged children, seam delays,
starved budgets, and gates; `makeRunnerCtx`, `makeLspServiceDouble`, and
`makeRealRunnerEnv` for dispatch, LSP, and rule behavior. Mock only external
binaries, network, host SDK seams, clocks, or fault injection.

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

<important if="adding or changing a rule or analyzer">

## Rule and analyzer contracts

Ast-grep rules live under `rules/ast-grep-rules/` and tree-sitter rules under
`rules/tree-sitter-queries/`. Use AST patterns over regex where possible. A
rule with an unknown post-filter fails closed. Every shipped rule has a real
behavioral fixture; Java/Kotlin rules use the real CLI path because NAPI lacks
their grammars. The bundled ast-grep source census is recursive and respects
project-over-bundled precedence.

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
`Tests`, `Blast radius`, `Class sweep`, and `Observability`; test changes also
include `Test assessment`.

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
or any remove over a symlinked `node_modules`; an unpinned `node` probe loading
`clients/` or `dist/`; `TMPDIR`/`TMP`/`TEMP` aimed at the harness home; bare
`pkill`/`killall` patterns (#3556); worktrees, clones, or `mktemp -d` under
`/tmp` (#3526); a commit or push chained after a check with `;` or a pipe
instead of `&&` (#3471); and every hook bypass (`--no-verify`, commit `-n`,
`core.hooksPath`, `HUSKY=0`, `PI_LENS_SKIP_HOOKS=`; #3778). `kill $(pgrep -f …)`
is a known blind spot; kill your own recorded PID. For a red that looks
unrelated, prove it with `node scripts/red-on-base.mjs` and stop. Human-facing
version: `CONTRIBUTING.md` "Local git hooks".
