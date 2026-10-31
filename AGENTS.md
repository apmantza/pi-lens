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
  review-graph, Git-guard, or rule work: read the matching row of the
  **Standing invariants** table and the file it names, plus the relevant
  source tests.
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

- Issues lead with the outcome, then evidence, root cause (or a labeled
  hypothesis), acceptance criteria, non-goals, failure semantics, test matrix,
  observability, and class-sweep coverage. A PR body leads with a short summary
  and stays short: proof is transcripts and mutation rows, not narrative. The
  issue reference goes in the PR title; the closing keyword goes in the body,
  because GitHub ignores it in a title.
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
- Human decision, never an agent verdict alone: workflow permission grants,
  release/version changes, dependency majors or lockfile regeneration, deletion
  of user data or durable records, external-contributor PRs, and changes to
  these rules.

The orchestrator-only procedure (brief authoring, review intake, the fold
check, the per-PR loop, and the CI read) lives in
[docs/pi-lens-orchestration.md](docs/pi-lens-orchestration.md).

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
ADR: docs/adr/0010-trace-validation-session-lifecycle.md

## Recurring defect shapes

Screen against these before writing code. Shapes are numbered once, grouped by
the surface they bite; each block loads only when its trigger applies. A shape
whose open population is countable names its census in its entry. The census
is one command, run at the repo root, printing one line per member or naming
one baseline key. A PR that fixes members of the shape quotes that census
before and after. A shape with no census in its entry is uncounted: a PR that
fixes its members says so instead of quoting a before and after.

The full entries live in [docs/defect-shapes.md](docs/defect-shapes.md): read
the entry for any shape a brief or a review names. Each line here is its
entry's screen, or its first sentence when it has none.

<!-- markdownlint-disable MD029 -->

<important if="touching a path key or path spelling">

### touching a path key or path spelling

1. **Divergent path keys:** Screen: does any spelling reach `normalizeMapKey` or `realpathOrResolve` through a `path.resolve` first?
2. **Host path functions in a shape branch:** once a path is classified as Windows-shaped, use `path.win32`; do not use host-default `path` functions.
32. **Mixed path comparison:** use one platform-aware containment expression; do not combine case-sensitive equality with case-folded relative paths.
39. **Walk-up result used as eligibility:** return ownership and start-directory identity separately; enumerate root-position by ambient-input cells.
74. **Split host-path resolution:** a path is resolved by its provenance, at one seam per provenance.
64. **Named path vs written set:** a guard keyed on the path a tool NAMES must hold for every path the tool WRITES; enumerate the written set (a rename's importers, an `ast_grep_replace` folder or its project default, a server-initiated `workspace/applyEdit` with no call at all) and key the permission per call, never per path.
65. **Unknown authorship range:** a producer that cannot recover a truthful range must carry UNKNOWN to `ReadGuard.creditAuthorship`; UNKNOWN creates no authorship.

</important>

<important if="adding or reading a cache, durable record, or project-intelligence state">

### adding or reading a cache / durable record

4. **Unsettled resource:** every timer, worker, child, watcher, and loser path is unref'd or cleared on every settle path.
6. **Incomplete freshness:** use the right content, size, mtime, dependency, and existence axes.
9. **One-axis bound:** bound the resource axis that grows, including bytes, timers, WASM objects, and retained evidence.
12. **Out-of-guard mirror refresh:** refresh behavior-gating mirrors before the guard releases, or validate the committed generation/object identity.
15. **Timer versus long operation:** an operation holds a counted gate for its lifetime; a background timer checks it at fire time and re-arms a fresh, bounded delay.
18. **Cooldown beyond caller cadence:** verify both recovery suppression and promotion of values served during cooldown.
24. **Second writer without discriminator:** enumerate all writers and add a reason/kind field before composing branches.
28. **Cold-path work on warm path:** compute expensive record fields only inside the failure or timeout branch, and measure any hot-path cost.
29. **Reset cap counter:** a retire or skip records its decision where the selector reads it, so the same item cannot re-enter with a fresh count.
41. **Hot bound reached at p50:** record hit rate and prefer adaptive or demotion behavior over a constant that has become the work.
46. **Long-lived container without a bound:** module-level `Map`/`Set` state is bounded, evicted, or content-keyed; a reset or TTL read is not a bound.
47. **Retry or drain loop consumes its own work list:** a bounded retry or drain loop must not remove its tracked item from the collection it iterates on the first successful pass.
51. **Cross-request derived-state cache where a request-local pass is affordable:** for a derived value on a hot path, measure a request-local bounded recompute first; persist it only when the fresh-process benchmark shows the recompute is the cost, and then the entry carries the generation it was derived from.

</important>

<important if="a delivery surface or lane">

### a delivery surface or lane

5. **Dropped side channel:** trace flags, bindings, and provenance through spreads, maps, filters, and JSON serialization.
10. **Silencing as fixing:** distinguish clean, filtered, unavailable, errored, suppressed, deferred, and partial results.
26. **Old-role filter on a substitute:** compare fallback output with the substituted surface's contract, including non-blocking findings.
27. **Unredacted user content:** parser messages and hand-authored strings may contain file input; normalize and redact at the shared diagnostic seam.
31. **Pull-only observability:** new behavior emits a success or decision record in the streams that monitors and analyzers read.
75. **Swallowed failure recorded as a different event:** Screen: force the failure through the real entry point and read the record it wrote.
43. **Prose mistaken for executable structure:** define lexical states and reachability before scanning shell, workflow, or source text.
61. **Stand-in for unknown text stripped per consumer:** when a lexer leaves a placeholder for text it cannot know (a command substitution's output), read the input under each bounding assumption rather than teaching each consumer to ignore the placeholder: empty (the text the rules matched before it existed) and opaque (no rule word matches it, no path resolves through it), denying if either reading denies.
49. **Whitespace counted as structure when it is alignment:** a leading run can be alignment, not one nesting unit (call continuations, block-comment and template-literal interiors; #3038, #3039, #3052, #3059, #3116).
54. **One-direction filter proof:** a filter that drops stale input is proven in both directions: it never passes stale input and never drops the only fresh answer.
79. **Prefix churn from a non-append write:** Screen: drive two real-session requests that differ only in the writer, and compare the head and pi-ai's collapsed head.
84. **Tool-state prose blind to a posture:** Screen: render the prose under each posture combination and each host, and assert every clause is true (#4293, #4294 enabled axis; #4682 lazy axis and the hand list that dropped two tools).

</important>

<important if="a runner outcome or tool execution">

### a runner or tool outcome

3. **Wrong argv transform:** verify a command is the wrapper shape before dropping an argv element or launcher name.
13. **Wrong failure classification:** derive availability and verdicts from raw evidence; preserve the classifier and evidence when a caller asserts a fact.
16. **Unverified external-tool claim:** probe the real binary before encoding exit codes, output shapes, severity names, or fixtures.
40. **Tool root drift:** all runner, formatter, and LSP child spawns use `resolveToolCwd`; mutation of the seam, log, or fallback must turn a test red.
42. **Language-specific rule:** use `LANGUAGES` and registry facts; add a non-TypeScript row whenever the rule is language-neutral.
48. **Fallback direction chosen without naming the user-facing obstruction:** "fail closed" is not a universal justification.
53. **Unhandled stream or process event is a host-fatal throw:** every callback on a child process, socket, or stream is total (catch, bound, record); a throw there bypasses the caller's `try/catch` and kills the pi host (#3375, #3383, #3389).
60. **Wasm failure outside the #3605 containment:** every failure thrown out of web-tree-sitter classifies through `classifyTreeSitterWasmError`, and a `catch` inside a `withParsedTree` consumer calls `reportWasmAbort` before it swallows the error.
62. **Delete or rewrite through a dependency link:** a lane's `node_modules` is a symlink to the main checkout's install, so any verb that removes or rewrites under it reaches every lane (#3173: `git worktree remove` followed the link twice; #4044: a worker's `npm ci --dry-run` emptied it under ~7 lanes, because npm 9.2.0 ignores `--dry-run` for the clean-install family).
63. **Tool console output parsed unstripped:** parsing Vitest or any tool's console output: strip ANSI first, and test with `FORCE_COLOR=1`.
80. **Single scan root:** Screen: for each detector, list the roots its subject can write in.
83. **Rule re-derived beside its owner:** Screen: before writing a marker, pattern, bound or normaliser, grep the tree for its literal and for the matcher that applies it; does a module already own it, and does this caller route through that module?

</important>

<important if="a test double, ratchet or sweep">

### a test double, ratchet or sweep

7. **Vacuous test:** prove the real entry point and real fixture arm.
8. **Name heuristic:** a filename skip has an observable count and a content escape hatch; never silently drop a real file.
11. **Skipped CI as green:** absent required checks are not passing checks.
14. **Duplicate module instance:** tests import the same `.js` artifact as the runtime and never reset a private `.ts` twin.
33. **Source assertion for runtime behavior:** prefer a runtime probe; source scans need proof that runtime observation is impossible.
34. **Spelling enumerator:** detect semantic structure, not a finite list of syntactic spellings, and test an unlisted spelling.
35. **Platform-only red:** platform-dependent tests run under injectable `path.posix` and `path.win32` semantics on every authoritative lane.
36. **Count-based baseline laundering:** maintenance tools match content identity, not occurrence counts, and refuse replacement identities.
37. **Raw control byte:** source fixtures encode control characters as escapes or buffers; tracked-source sweeps enforce this.
38. **Data-only admission:** a new exemption or baseline row requires a reason in a separate checked file and a fixture that crosses the boundary.
44. **Portable entry-module check:** compare `import.meta.url` with `pathToFileURL(process.argv[1]).href`.
45. **Root wrapper drops metadata:** wrappers preserve the complete marker table and are checked against direct root resolution.
50. **Test double's fabricated identifier reaching code that acts on it:** a pid, fd, port, lock path or handle invented by a mock reaches production code that registers, signals, writes or deletes by it (#2042, #3091).
59. **Generated edit with unlisted consumers:** Screen: apply the generator's real output to the real tree (all-eligible case included), build, and run every test that mentions the field or the registry; this sweep is manual (#3994 F1, r3).
66. **In-process module double with a real seam:** when a `clients/` module has a test setter, adopter, or reset, drive that seam; keep a double only at a process or host boundary.
67. **Sink read before drain:** a log sink's `log`/`append` only enqueue, so a test that reads the sink's byte offset, line count, or rows while one of its own writes is queued counts late bytes on the wrong side of its window, or misses them.
68. **Model switch drift:** Screen: for a mapped file's diff, list the CONSTANTS in the family's as-built `formal/<family>/*.cfg` and check each against the changed branch.
69. **Enumerated detector:** Screen: plant an alias, an indirect call and a value reached through another binding, and quote each result; every green plant is fixed or named as a residual.
73. **Fixture adopts an ancestor root:** a fixture created with no project marker inherits whatever root sits above it, so one stray `.git` at the tmp root became the project root and #4559's quick-mode cell failed three pre-push runs.
76. **Instrument attributes by id and order, not by the emitting subject:** a probe that brackets each phase with an offset into a buffered async sink, and drains rows by subject id alone, folds a sibling's late row into its own phase.
77. **Cancellation read as failure:** an aggregate that compares each shard's result against `success` reds a required check when the shard finished every step and lost its race with `timeout-minutes`, and no rerun recovers it, because the infra-kill classifier reads only `failure` runs.
78. **A dependency's cache directory attributed to the fixture that triggered it:** a loader that materialises `os.tmpdir()/<tool>` on the caller's own stack looks like a fixture sibling, so the creator recorded for it is accurate per process and wrong per cause, and the sweep reds a file that never created it.
81. **Synchronous native-tree walk holds every tree:** Screen: does the loop's body parse, and does it reach a `setImmediate` or a real I/O await per iteration?
82. **One home variable pinned, the rest left at the real home:** Screen: which directory does the process I run resolve from, and is every variable that names it pinned?
85. **Default-budget tree census:** Screen: does this case call a walker or read a binding one produced, and is its third argument one of those two forms?
86. **Turn-count wait for real I/O:** Screen: does the wait end on the event it waits for or on a real-clock deadline, never on a count?

</important>

<important if="session, turn or generation lifecycle">

### session, turn or generation lifecycle

17. **Process latch for session state:** every once-latch has a session reset; session dedupe belongs in the degradation ledger where possible.
19. **Re-derived identity:** carry resolved identity or correlation across asynchronous stages; do not reconstruct it from ambiguous later inputs.
20. **Staleness-only fallback:** stale work is not proof of ownership; require origin provenance before claiming it.
21. **Late loser overwrite:** concurrent writers carry a monotonic generation; mutation of the generation guard must turn a test red.
22. **Session-straddling write:** capture the session generation before an await and check it before publishing.
23. **Advanced cursor predicate:** predicates about the starting leaf receive the starting path, not the loop cursor.
25. **Module-scope uniqueness assumption:** process evaluation can create multiple copies; process-wide registries and latches use `getProcessSingleton`.
30. **Load-time platform constant:** use a live platform read or an isolated fresh import for every platform branch test.
55. **Field inherited across entry kinds:** when a coalescing queue carries a field from a replaced entry into its replacement (a read stamp, a save flag), check every kind the replacement can be, not only the kind the fix was written for (#3491: a queued close inherited a stale touch's read stamp and the stale-read drop discarded the close).
56. **Subset without a population verdict:** when a mechanism, policy, guard, or optimisation targets N of M members, name the excluded default and a generalization verdict; see `docs/pi-lens-reviewer.md` (recurrence: #3622).
57. **Released-writer input shapes:** property-test generators include the input shapes produced by older released writers (#3594 R2-F1).
58. **Known identity carried forward:** when a producer knows an identity, carry it through asynchronous stages instead of re-deriving it downstream (#3643 F3).
70. **Joined single flight answers for edits after it started:** Screen: for a join, list the writers that can store the row between the join and the next scan, and show the finding survives each.
71. **One signal wired consumer by consumer:** Screen: for a new detector, notifier or staleness marker, list every consumer that holds state derived from the same content, and show each one receives the change or record why not.
72. **Process-global last-write-wins session field:** a field that holds one session's value for the whole process answers for whichever session wrote last, so a second live session overwrites what another one read.
87. **Factory-time read of a host value set later:** pi applies an extension flag's command-line value after every factory has run, so a flag read while the factory runs answers the registered default. Screen: does any flag read run while the factory runs, and does the host test apply the value after the factory, as pi does?

</important>

<important if="availability policy or installer">

### availability or installer

52. **A second store answering the same availability question:** a new latch, map or cache answering "can `<tool>` run, at what path" beside the shared policy (`availability-policy.ts`, `createAvailabilityLatch`).

</important>

<!-- markdownlint-enable MD029 -->

## Standing invariants

The invariants hold across the tree. Each file below holds one seam's full
text, opened by the condition that loads it; the third column names the paths
it governs. Read the file for the seam a brief or a diff names.

| seam | file | source paths it covers |
| --- | --- | --- |
| Language and configuration | [docs/invariants/language-config.md](docs/invariants/language-config.md) | `clients/language-registry.ts`, `clients/config-core/`, `clients/tool-config.ts`, `rules/`, `tools/` |
| Paths, data, and operating systems | [docs/invariants/paths-os.md](docs/invariants/paths-os.md) | `clients/path-utils.ts`, `clients/file-utils.ts`, `clients/installer/index.ts`, `tests/support/` |
| LSP, trust, and process execution | [docs/invariants/lsp-trust-exec.md](docs/invariants/lsp-trust-exec.md) | `clients/lsp/`, `clients/safe-spawn.ts`, `clients/session-repository.ts`, `scripts/`, `formal/` |
| Dispatch, runners, formatters, and installers | [docs/invariants/dispatch-runners.md](docs/invariants/dispatch-runners.md) | `clients/dispatch/`, `clients/formatters.ts`, `clients/installer/`, `clients/test-runner-client.ts`, `tests/fixtures/runner-output/` |
| Caches, stores, and project intelligence | [docs/invariants/caches-stores.md](docs/invariants/caches-stores.md) | `clients/durable-store.ts`, `clients/content-stamp.ts`, `clients/review-graph/`, `clients/word-index.ts`, `tools/` |
| Session, telemetry, and delivery | [docs/invariants/session-telemetry.md](docs/invariants/session-telemetry.md) | `clients/runtime-*.ts`, `clients/session-lifecycle.ts`, `clients/degradation-ledger.ts`, `clients/finding-delivery-gate.ts` |
| Git guard and host adapters | [docs/invariants/git-guard-host.md](docs/invariants/git-guard-host.md) | `clients/git-guard.ts`, `clients/inline-blocker-fields.ts`, `clients/deferred-runner-blockers.ts`, `clients/lens-engine.ts`, `index.ts`, `mcp/` |

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
  A turn end reads only the inline blockers its own session's writes
  recorded; the commit gate reads every one
  ([git-guard invariants](docs/invariants/git-guard-host.md), #4921).
- Only the write/edit `tool_result` path may block the host; `session_start`, `turn_end`, `agent_end`, `agent_settled`, and read-only `tool_result` are bounded by the outer wall; new hook awaits register in `tests/config/hook-await-bounds.test.ts`.

`RuntimeCoordinator.recordProjectMutation` is the one mutation bookkeeping seam.
Do not pair `bumpFileSeq` and change-log writes at a new call site. The mutation
bridge and opaque-write recovery feed this seam for non-native producers. A
write is stamped with its turn's session (`deps.sessionId`, else the
coordinator's), in the change log, the pipeline's log rows and the collect-later
answer it defers; `telemetrySessionId` is for coordinator-owned records.

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
## Build, packaging, and release

The build, packaging, and release rules live in
[docs/pi-lens-release.md](docs/pi-lens-release.md).

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
ids, and the request the model sees. By default it loads the built entry by
path, so a `vi.mock` or a test-side singleton never reaches the extension; its
opt-in inline-factory mode (`startPiSession({ inlineFactory })`) hands pi the
factory the test imported, so the extension runs on the test graph's modules
and a `vi.mock`, a prototype spy or a module-scope registry the test reads is
the one it uses. Their header comments state the APIs and limits. A new tier
capability adds a case to `pi-runner.test.ts` or `pi-session.test.ts` first. `pi-mock.ts` stays only for a test file on
`PI_MOCK_IMPORTERS` (`tests/support/pi-mock-importers.ts`), whose row states the
class: `process-boundary` (2 rows), `internal-seam` (35: the case interposes on
a pi-lens `clients/` module either through `vi.mock`, which cannot reach the
copy pi's loader builds, or through a test-side copy of a process-global
service the loaded copy does not share, such as `clients/lsp`'s service),
`unproducible-payload` (4: a payload a scripted provider cannot
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
instead of naming work no slice owns. The five classes cover the list's 43
rows (52 at the slice 7 recording; the pi-mock L1, L2 and L3 moves took three more out, the L2 move also relabelled one `process-boundary` row `internal-seam`, and slice 7 moved the
`index-smells-rollup-wiring` row out with its file, and the inline-factory mode
moved six `internal-seam` files to tier 2), and this command reproduces them:
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
`<PI_LENS_HOME>/rules/`. The repo-only governance rules, which never ship,
live under `scripts/governance-rules/rules/`. Precedence is project > user >
bundled, and a shadowed rule is excluded from execution. Use AST patterns over regex where
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
`area:` label, plus exactly one `priority:` label. A PR body follows
`.github/PULL_REQUEST_TEMPLATE.md`: `Summary`, `Notes for the reviewer`,
`Change outline`, and `Proof and checks`, within the caps
`scripts/check-pr-body.mjs` enforces.

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
