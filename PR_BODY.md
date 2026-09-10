## Summary

Make pi-lens `session_start` idempotent for the host's repeated `(reason, session file)` event (#2890). The first event performs the session mutations; an identical second event is a no-op; a later event for a different session file runs the normal reset path. The telemetry opener remains unchanged from #2866.

Closes #2890.

## Type of change

- [x] Bug fix
- [ ] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [x] area:session
- [x] area:tests

## State-space acceptance matrix

Each cell names a grep-able test title that exists after this round.

| State-mutating handler or state | First start | Second identical start, same reason + file | Later start, different file |
| --- | --- | --- | --- |
| `index.ts` dynamic tool restore (`planToolSet`, `setActiveTools`, mutation record) | must mutate when the desired posture differs — `session_start restores tools once per session-file identity` | must be a no-op — `session_start restores tools once per session-file identity` | must reset or restore the new session posture — `session_start restores tools once per session-file identity` |
| Situational telemetry opener (`startSituationalToolTelemetrySession`) | must open the observation set — `session_start restores tools once per session-file identity` | must be a no-op — `session_start restores tools once per session-file identity` | must open the replacement set — `session_start restores tools once per session-file identity` |
| `clients/` session-state registry entries: `ast-grep-napi:loadState`, `availability-policy:installRetryLatches`, `biome-check:fixKindCache`, `bootstrap:failure-latch`, `bootstrap:shutdown-gate`, `bounded-telemetry:turnCounts`, `cascade-tier:outstandingTouches`, `collect-later-tier:observedRunners`, `deferred-lsp-work:handle`, `degradation-ledger:onceKeys`, `diagnostic-dispositions:deferredThisSession`, `dispatch-integration:reverseDepsIndexCache`, `dispatch-integration:sessionCaches`, `dispatcher:coverageNoticeSeen`, `formatters:runtimeState`, `formatters:whichLatches`, `go-client:goClientAvailability`, `installer:pathWalkMemo`, `installer:resolvedPathCache`, `language-profile:topology-derived-cache`, `latency-logger:liveBrackets`, `latency-logger:oncePerSessionPhases`, `lazy-installer:attempts`, `lsp-index:globalLSPService`, `lsp-mutation:noBridgeDbgLogged`, `lsp-server:classicTsRepairGuard`, `lsp-server:directCommandUnavailable`, `lsp-server:launchAvailabilityGeneration`, `lsp-server:posixCaseSensitivityProbe`, `lsp-session-roots:sessionRoots`, `lsp-workspace-diagnostics-cache:sessionClock`, `lsp:pending-aux-coverage`, `managed-tool-refresh-session:refreshesThisSession`, `memory-sampler:cadence`, `message-end-attribution:two-slot-anchor`, `mutation-attribution:session+fromDisk`, `observed-mutation:pending+ledger+handled`, `opaque-mutation-scan:baselineStore+gitMemo`, `package-manager:availabilityLatches`, `path-attribution-telemetry:verifiedGuessCount`, `pending-runner-findings:pending`, `psscriptanalyzer:latches`, `review-graph-builder:workspaceGraphCache`, `runner-helpers:availabilityGeneration`, `runner-helpers:correctedAvailabilityByCwd`, `rust-client:rustClientAvailability`, `safe-spawn:windowsCommandCache`, `session-start-observability:bindRollupCounters`, `situational-tool-telemetry:sessionObservation`, `smells-rollup:notifiedThisSession`, `spawn-timeout-cooldown:latches`, `startup-scan:topology-derived-cache`, `startup-timing:hostReadyDelayAnchor`, `test-runner-delivery:pending`, `tree-sitter-shared:webTreeSitterLoadFailed`, `tsconfig-paths:topology-derived-caches`, `turn-context:perSessionCounters`, `workspace-modules:moduleSourceFilesMemo`, `workspace-sweep-hold:holds`, `workspace-topology:caches`, `zizmor-config:tokenAvailability` | must reset or initialize — `session_start restores tools once per session-file identity` | must be a no-op — `session_start restores tools once per session-file identity` | must reset for the replacement — `session_start restores tools once per session-file identity` |
| Closure counters/latches: verified-path attribution, current-phase brackets, once-per-session phases, concurrent-bind rollup, memory-sampler cadence, turn-context counters | must reset — `session_start restores tools once per session-file identity` | must be a no-op — `session_start restores tools once per session-file identity` | must reset for the replacement — `session_start restores tools once per session-file identity` |

Operating rule: one real session-start mutation pass per `(reason, session file)` identity.

Kept: remembered lazy-tool survival (#2889), handler crash swallowing (#2884), and the #2866 telemetry implementation are unchanged.

## Tests

- `tests/index-integration.test.ts`: `session_start restores tools once per session-file identity` drives the built extension handler twice with the same reason and file, then with a different file, and asserts independent host mutations.
- `tests/index-integration.test.ts`: the same scenario pins the real dispatch path's registry and closure reset boundary because the admission guard encloses both populations.
- `tests/support/pi-mock.ts`: adds the host-faithful `sessionManager.getSessionFile()` fixture needed by the real dispatch tests.
- Red-first and mutation proof: with the admission guard replaced by `false &&`, the whole `tests/index-integration.test.ts` regression failed: `AssertionError: expected ... to have a length of 1 but got 2` at `session_start restores tools once per session-file identity`.
- Real pi RPC-mode witness uses a probe extension and scripted provider with `PI_LENS_HOME` and `HOME` in a scratch directory outside this worktree.

## Test assessment

- `tests/index-integration.test.ts`: uniquely pins the real built-index session lifecycle and the new duplicate-event boundary; existing lifecycle tests remain complementary.
- `tests/support/pi-mock.ts`: remains shared host-fixture infrastructure; no test becomes redundant.

## Blast radius

The changed production seam is the `pi.on("session_start", ...)` callback in `index.ts`; it gates warmups, session-state resets, tool restoration, `handleSessionStart`, and lifecycle hydration. `clients/` reset implementations and telemetry are consumers, not changed logic. The only callback entry point is pi's session-start dispatch. The guard adds one closure-local string comparison per event; the duplicate event avoids the existing reset and warmup work.

## Observability

The existing `tool_set_mutation` phase in `clients/tool-set-policy.ts` proves that the tool-set mutation occurs once. The existing session-start phase rows and situational dead-weight row prove the first and replacement passes. No new failure path; no record added.

## Class sweep

Defect shape: repeated lifecycle event against process/session state, AGENTS.md session lifecycle and defect shapes 17 and 21. Pattern sweep covers `clients/`, `tools/`, `mcp/`, `scripts/`, and `index.ts` for `session_start` state mutation sites. Population sweep covers every `session_start` entry in `tests/support/session-state-registry.ts`; the matrix above records each member and its verdict. The family stays behind the single `index.ts` dispatch admission seam because every listed reset is ordered relative to the primary-session guard.

## Upstream

The pinned pi changelog records the session-shutdown metadata change but no known fix for duplicate RPC `session_start` events. The observed report is: pi 0.85.1 `--mode rpc` emits two starts about 57 ms apart for each new, resume, or fork replacement. pi-lens now tolerates that sequence at its dispatch seam.

## Verification

Verified after the fix: `npm run build`; the targeted integration, wiring, and telemetry suites; `npm run fmt:check`; `npx tsc --noEmit`; all `tests/config/`; and `node scripts/check-pr-body.mjs --lint-local PR_BODY.md`. The real-pi RPC probe was attempted outside the worktree with the scripted provider but timed out before a replacement event was returned; the issue's measured pi 0.85.1 sequence remains the external witness.

Final `npm run preflight` table:

| gate | mirrored CI job | pass/fail | first red line |
| --- | --- | --- | --- |
| build | Lint & type-check | pass | |
| lint | Lint & type-check | pass | |
| fmt:check | oxfmt format check | pass | |
| changelog:check | Unit tests | pass | |
| check-changelog-fragments | Changelog fragment (fast-fail) | pass | |
| check:lockfile | Lint & type-check | pass | |
| lockfile:complete | Lint & type-check | pass | |
| tests/config | Unit tests | pass | |
| generation-guard | Unit tests | pass | |
| flake-shape-ratchet | Unit tests | pass | |
| lsp-spawn-heavy-coverage | Unit tests | pass | |
| ci-verdict | Unit tests | pass | |
| knip | knip (advisory) | pass | |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
