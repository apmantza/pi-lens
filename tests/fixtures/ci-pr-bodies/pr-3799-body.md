## Why

A warm `pilens_analyze` pull of a file pi-lens cannot analyse must not read as a
clean result just because the coverage notice was already shown once.

## Notes for the reviewer

- The pi push surface keeps the once-per-session latch; only the `pilens_analyze`
  facade opts out. The pull runs never write the latch, so a later push still
  gets its own notice.
- The notice message is listed in `diagnostics` by #3788 (#3752), which is open
  and "merging soon". On `origin/master` without #3788 the fixed pull still
  reports `counts.warnings: 1` every call (the notice text is in the dispatch
  output and the warning bucket), but the serialized `diagnostics` list only
  gains the entry once #3788 lands. Nothing in this PR duplicates that change.
- Rebased onto `origin/master` (`1f41157ca`); #3788 has not landed.

## Change outline

```text
clients/mcp/analyze.ts:469        analyzeFile                    [pull: dedupeCoverageNotice:false]
  + clients/dispatch/integration.ts:2947  dispatchLintWithResult
    + clients/dispatch/dispatcher.ts:1445 buildCoverageNotice(..., options?.dedupeCoverageNotice ?? true)
      + clients/dispatch/dispatcher.ts:681,750  coverageNoticeSeen latch  [skipped when dedupe=false]
  clients/pipeline.ts:1935         (pi push)             [default dedupe=true, unchanged]
  clients/dispatch/integration.ts:3014 dispatchLintDetailed [default dedupe=true, unchanged]
```

## Summary

`Fixes #3791.` The dispatcher deduped its synthetic coverage notice once per
session through `coverageNoticeSeen`, which suits the pi push surface (a
per-edit notice should not repeat) but not the MCP pull surface: a second warm
`pilens_analyze` call for an unanalysable file returned counts all zero and
`diagnostics: []`. This adds a `dedupe` parameter to `buildCoverageNotice`
(`clients/dispatch/dispatcher.ts:625`) and a `dedupeCoverageNotice` option on
the dispatch seam (`clients/dispatch/dispatcher.ts:1205`,
`clients/dispatch/integration.ts:2882`). The default keeps the push latch; the
`pilens_analyze` facade passes `false` (`clients/mcp/analyze.ts:469`), so every
pull returns the notice and the latch is left untouched. `AGENTS.md:685`
records the push/pull rule.

Independent reproduction through the warm stdio MCP server: a Go file with
`no-lsp` and `PATH=""` (no `go`/`gopls`/`golangci-lint`), three pulls. Before
the fix the first pull reported the warning and the second and third returned
zero. After the fix all three report `counts.warnings: 1`.

Red (pre-fix, `origin/master` production, smoke test):

```text
 Test Files  1 failed (1)
      Tests  1 failed (1)
AssertionError: second pull must carry the coverage warning: expected 0 to be greater than or equal to 1
 ❯ tests/mcp/analyze-coverage-repeat.smoke.test.ts:110:6
```

## Type of change

- [x] Bug fix
- [ ] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [x] area:dispatch
- [x] area:tests

## Checklist

- [x] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)
- [x] The change has tests (happy path, edge cases, regression test for bugs)
- [x] Targeted test files for the touched seams pass locally after `npm run build`; the full suite is CI's job.
- [x] Every NEW regression test is proven RED on pre-fix code; the red output is quoted in this PR
- [x] Every new guard/branch/filter is mutation-proof: deleting or neutering it reds at least one test
- [x] PR title carries the conventional prefix and the issue ref
- [x] `npm run lint` passes
- [ ] `npm run build:dist` succeeds if I changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [x] `package-lock.json` is in sync with `package.json` (regenerate with the exact npm pin in `package.json`'s `packageManager` field)
- [x] `AGENTS.md` is updated if this PR changes behavior, commands, conventions, or invariants documented there
- [x] `.changelog/<branch-or-slug>-<short-desc>.md` has one valid entry **in this PR** for any user-facing change (Added/Changed/Deprecated/Removed/Fixed/Security) — see [.changelog/README.md](../.changelog/README.md); internal-only test/refactor PRs may skip it
- [x] Commit subject includes the issue number in the body (`closes #3791`)

## Tests

New tests:

- `tests/mcp/analyze-coverage-repeat.smoke.test.ts:87` — carries a coverage
  warning on the first, second, and third pull. Drives the real stdio MCP server
  (existing `tests/mcp/harness.ts`) and makes three warm `pilens_analyze` calls
  on a Go file, asserting `counts.warnings >= 1` on each. This is the acceptance
  test the issue names.
- `tests/clients/dispatch/dispatcher-flow.test.ts:272` — repeats the coverage
  notice for a pull dispatch and leaves the push latch untouched. Pins the
  unavailable class: push latches, pull repeats on both calls, and the pulls do
  not consume the push latch.
- `tests/clients/dispatch/runners/runner-status-semantics.test.ts:611` — repeats
  a scanner coverage notice on every pull without consuming the push latch.
  Pins the scanner-partial class (the other branch of `buildCoverageNotice`)
  with the real lsp runner and a mocked `touchFile`.
- `tests/clients/dispatch/integration.test.ts` — three cases pin the
  `dedupeCoverageNotice` pass-through this seam owns: the pull option reaches
  `dispatchForFile`, the push path omits the key, and the real `analyzeFile`
  facade routes through the pull opt-out. `dispatchForFile` is the file's own
  established process boundary (it would spawn real runners), so the argument
  it receives is the observable contract, exactly as this file already checks
  the telemetry-identity hop.

Test-authoring screens satisfied: real production entry point (smoke test through the MCP server; both guard tests through `dispatchForFile`), no mock-only assertion, independent expected value (`warnings` count, not a table copy), no ambient inspection, env pinned (harness `PI_LENS_HOME`/`PILENS_DATA_DIR`, `PATH` handed to the subprocess).

Red (pre-fix, production reverted to `origin/master`):

```text
 Test Files  1 failed (1)
      Tests  1 failed | 28 skipped (29)
AssertionError: expected '' to contain 'Pi-lens go analysis unavailable'
 ❯ tests/clients/dispatch/dispatcher-flow.test.ts:328:29
```

Mutation rows (compile-valid, applied to the built `clients/dispatch/dispatcher.js`
and run against the tests):

| Mutation | Neuters | Red test |
| --- | --- | --- |
| scanner-partial `if (dedupe)` (`clients/dispatch/dispatcher.ts:681`) → `if (true)` | scanner-partial pull branch | `runner-status-semantics` new test |
| unavailable `if (dedupe)` (`clients/dispatch/dispatcher.ts:751`) → `if (true)` | unavailable pull branch | `dispatcher-flow` new test; smoke test |
| `options?.dedupeCoverageNotice ?? true` (`clients/dispatch/dispatcher.ts:1445`) → `?? false` | push latch default | existing `dispatcher-flow` push-latch test |

Mutation A red:

```text
 Test Files  1 failed (1)
      Tests  1 failed | 27 skipped (28)
AssertionError: expected '' to contain 'coverage: opengrep silent'
 ❯ tests/clients/dispatch/runners/runner-status-semantics.test.ts:659:34
```

Mutation B red (smoke):

```text
 Test Files  1 failed (1)
      Tests  1 failed (1)
AssertionError: second pull must carry the coverage warning: expected 0 to be greater than or equal to 1
 ❯ tests/mcp/analyze-coverage-repeat.smoke.test.ts:110:6
```

Mutation C red:

```text
 Test Files  1 failed (1)
      Tests  1 failed | 28 skipped (29)
AssertionError: expected '' to contain 'Pi-lens go analysis unavailable'
 ❯ tests/clients/dispatch/dispatcher-flow.test.ts:267:36
```

Edited tests: the two touched files only gained cases; every previously
shipped case still passes.

### Test assessment

- `tests/mcp/analyze-coverage-repeat.smoke.test.ts` uniquely pins the pull
  surface end to end over the real MCP transport. No removal candidate.
- `tests/clients/dispatch/dispatcher-flow.test.ts` pins dispatch-group
  execution, delta, and coverage semantics without real tools. The new case
  extends the coverage semantics; the earlier push-latch case stays (it is the
  mutation-C witness).
- `tests/clients/dispatch/runners/runner-status-semantics.test.ts` pins
  runner status→semantic mapping and the scanner coverage classes. The new case
  is the only pull-side witness for the scanner branch; the earlier `#1867`
  case stays (it is the push-side witness). No removal candidates.

## Blast radius

- `clients/dispatch/dispatcher.ts`: `buildCoverageNotice` + `dispatchForFile`
  gain an optional `dedupe`/`options` parameter, defaulting to today's
  behavior. Callers: `clients/dispatch/integration.ts` (`dispatchLint`,
  `dispatchLintWithResult`, `dispatchLintDetailed`), `clients/pipeline.ts`
  (push, unchanged default), and tests that call `dispatchForFile` directly.
  Callees unchanged.
- `clients/dispatch/integration.ts`: one new optional option, threaded to
  `dispatchForFile`. `dispatchLintDetailed` and `dispatchLint` are untouched.
- `clients/mcp/analyze.ts`: passes `dedupeCoverageNotice: false`. Consumers of
  `analyzeFile`: `mcp/server.ts` (warm + IPC warm), `mcp/worker.ts`
  (fresh), `mcp/analyze-cli.ts`, and `clients/lens-engine.ts`'s re-export. All
  are pull surfaces, so all must repeat the notice.
- No durable record shape changes; `DispatchResult` is unchanged.

`module_report`/`blastRadius` was unavailable in this worktree (cold cache), so
the dependents above come from ripgrep over `clients/`, `tools/`, `mcp/`,
`index.ts`, and `tests/`. Hot path cost: one boolean check per dispatch, no
extra I/O; the notice computation itself is unchanged.

## Observability

No new failure path; no record added.

## Class sweep

Defect shape: AGENTS.md "Session, telemetry, and delivery" — a session-scoped
latch suppressing a model-facing result on a pull surface (the #3750/#3749
false-clean class). Pattern sweep for `coverageNoticeSeen` across `clients/`,
`tools/`, `mcp/`, `scripts/`, and `index.ts`: only
`clients/dispatch/dispatcher.ts` owns the latch, and the only model-facing
emission is `buildCoverageNotice`. The one other latch in that module,
`generatedSkipRecorded`, gates a `logLatency` phase record, not model output, so
it is out of scope.

Population sweep: every `buildCoverageNotice` branch (the scanner-partial branch
at `clients/dispatch/dispatcher.ts:681` and the unavailable branch at
`clients/dispatch/dispatcher.ts:751`) was exercised on the pull path; each has
its own red mutation row above. Every `analyzeFile` caller is a pull surface
(warm MCP, IPC warm analyze, fresh worker, CLI), so all ride the same
`dedupeCoverageNotice: false`.

Consolidation verdict: fold. One seam (`buildCoverageNotice` via
`dispatchForFile`'s option) carries the push/pull axis; no second latch or
notice builder was added.

## Round 2 — mutation survivors answered

The first mutation run (head `8bc9f386c`) reported 7 survivors. Each is answered
below; the follow-up run on head `190094e3c` reports **24 killed, 0 survived
(100%)**.

- `clients/dispatch/dispatcher.ts:625` `true → false` — **fixed.** The
  `dedupe = true` default was dead: `dispatchForFile` always supplies the
  argument, so the default never fired. It is now a required parameter
  (`clients/dispatch/dispatcher.ts:625`); the mutant no longer exists.
- `clients/dispatch/dispatcher.ts:1445` `?? true` → `&& true` — **killed.** With
  the default gone, the push path passes `undefined` and the mutant makes the
  notice repeat; `tests/clients/dispatch/dispatcher-flow.test.ts` "shows
  non-blocking analysis-unavailable notice when semantic tools are missing"
  reds on its second call.
- `clients/dispatch/integration.ts:2946` ObjectLiteral → `{}` — **killed** by the
  new `tests/clients/dispatch/integration.test.ts` "forwards the pull
  coverage-dedupe opt-out to dispatchForFile (#3791)".
- `clients/dispatch/integration.ts:2947` ConditionalExpression → `true` —
  **killed** by "omits the coverage-dedupe key on the push path (#3791)".
- `clients/dispatch/integration.ts:2947` ConditionalExpression → `false` —
  **killed** by "forwards the pull coverage-dedupe opt-out to dispatchForFile
  (#3791)".
- `clients/dispatch/integration.ts:2947` ObjectLiteral → `{}` — **killed** by the
  same pull pass-through case.
- `clients/mcp/analyze.ts:469` `false → true` — **killed** by "routes the MCP
  analyze facade through the pull opt-out (#3791)".

The four `integration.ts`/`analyze.ts` survivors on the first head were a
test-selection gap, not equivalent mutants: the mutation lane's 47-file cap
dropped `tests/clients/mcp/analyze.test.ts`, and the warm-server smoke test is
excluded from the lane by design because it starts a real stdio child. The new
cases live in `tests/clients/dispatch/integration.test.ts`, which the lane
selects, and exercise the real `analyzeFile` facade over the mocked
`dispatchForFile` boundary this file already treats as observable.


## Round 2 ruling and evidence

F1 is intentionally option (a): the warm PostToolUse hook route is a pull consumer and repeats the coverage notice on every edit, matching the existing cold hook route. This is documented in `AGENTS.md` and `.changelog/3791-analyze-coverage-per-pull.md` and pinned by `tests/mcp/analyze-cli.test.ts` (`repeats the warm coverage notice on every PostToolUse hook (#3791 F1)`).

F2 adds fresh-latch ordering pins in `tests/clients/dispatch/dispatcher-flow.test.ts` and `tests/clients/dispatch/runners/runner-status-semantics.test.ts`: pull, pull, then the first push must carry the notice. Under the compile-valid built `clients/dispatch/dispatcher.js` mutation that moves `coverageNoticeSeen.add(onceKey)` outside the `if (dedupe)` guard, both new tests red:

```text
FAIL tests/clients/dispatch/dispatcher-flow.test.ts > Dispatch Flow > Dispatch Execution > does not let pull dispatches consume a fresh push notice (#3791 F2)
AssertionError: expected '' to contain 'Pi-lens go analysis unavailable'
❯ tests/clients/dispatch/dispatcher-flow.test.ts:397:29

FAIL tests/clients/dispatch/runners/runner-status-semantics.test.ts > runner status/semantic edge cases > keeps a fresh scanner push notice after two pulls (#3791 F2)
AssertionError: expected '' to contain 'coverage: opengrep silent'
❯ tests/clients/dispatch/runners/runner-status-semantics.test.ts:710:29

Test Files 2 failed (2)
Tests 2 failed | 57 passed (59)
```

The restored build passes 81 targeted tests across the three touched suites. Non-goals remain #3867 (failed runner = coverage) and #3800's `failureKind`.